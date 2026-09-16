'use strict';

const executor = require('../core/executor');
const pods = require('./pods');

const KUBECTL = 'kubectl';

// kubectl is given the deadline; the executor's own kill is a backstop for the
// case where kubectl ignores it and hangs.
const EXECUTOR_GRACE_MS = 5000;

// Quantities end up in an argv array, so a value must never be able to start
// with "-" and be read by kubectl as a flag. These are stricter than the
// Kubernetes parser: no signs, no exponents.
const CPU_QUANTITY = /^([0-9]+(\.[0-9]+)?|[0-9]+m)$/;
const MEMORY_QUANTITY = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|K|M|G|T)?$/;

/**
 * Turns kubectl's stderr into something the UI can act on.
 *
 * @param {string} stderr
 * @returns {{ kind: string, message: string, raw: string }}
 */
function classifyError(stderr) {
  const raw = (stderr || '').trim();
  const text = raw.toLowerCase();

  if (
    text.includes('unauthorized') ||
    text.includes('must be logged in') ||
    text.includes('certificate has expired') ||
    text.includes('error: you must be logged in')
  ) {
    return {
      kind: 'auth',
      message: 'Credentials expired. Run the svctl login for this service again.',
      raw,
    };
  }

  if (
    text.includes('dial tcp') ||
    text.includes('unable to connect to the server') ||
    text.includes('i/o timeout') ||
    text.includes('no such host')
  ) {
    return {
      kind: 'network',
      message: 'Cannot reach the cluster. Check your VPN connection.',
      raw,
    };
  }

  if (
    text.includes('context deadline exceeded') ||
    text.includes('client.timeout') ||
    text.includes('timeout exceeded while awaiting headers') ||
    text.includes('request-timeout')
  ) {
    return {
      kind: 'timeout',
      message:
        'kubectl timed out. Raise timeoutSeconds in services.yaml, or check your VPN.',
      raw,
    };
  }

  if (text.includes('forbidden')) {
    return {
      kind: 'rbac',
      message: 'Your account does not have access to this namespace.',
      raw,
    };
  }

  if (text.includes('context') && text.includes('does not exist')) {
    return {
      kind: 'no-context',
      message:
        'This context is missing from your kubeconfig. Log in with svctl once, then retry.',
      raw,
    };
  }

  return { kind: 'unknown', message: 'kubectl failed.', raw };
}

/**
 * Lists pods for a resolved cluster target.
 *
 * @param {Object} target
 * @param {string} target.context
 * @param {string} target.namespace
 * @param {number} [target.timeoutSeconds]
 * @returns {Promise<{ pods: Array<Object> } | { error: Object }>}
 */
async function getPods(target) {
  const timeoutSeconds = target.timeoutSeconds || 60;
  const args = [
    'get',
    'pods',
    '--context',
    target.context,
    '--namespace',
    target.namespace,
    `--request-timeout=${timeoutSeconds}s`,
    '-o',
    'json',
  ];

  const result = await executor.run(KUBECTL, args, {
    timeout: timeoutSeconds * 1000 + EXECUTOR_GRACE_MS,
  });

  if (result.code !== 0) {
    return { error: classifyError(result.stderr) };
  }

  return { pods: pods.toRows(JSON.parse(result.stdout)) };
}

/**
 * Restarts a deployment by rolling its pods. This is a mutating call: every pod
 * of the deployment is replaced, not just the one the button was clicked from.
 *
 * @param {Object} target
 * @param {string} deployment
 * @returns {Promise<{ message: string } | { error: Object }>}
 */
async function rolloutRestart(target, deployment) {
  const timeoutSeconds = target.timeoutSeconds || 60;
  const args = [
    'rollout',
    'restart',
    `deployment/${deployment}`,
    '--context',
    target.context,
    '--namespace',
    target.namespace,
    `--request-timeout=${timeoutSeconds}s`,
  ];

  const result = await executor.run(KUBECTL, args, {
    timeout: timeoutSeconds * 1000 + EXECUTOR_GRACE_MS,
  });

  if (result.code !== 0) {
    return { error: classifyError(result.stderr) };
  }

  return { message: result.stdout.trim() || `${deployment} restarted` };
}

/**
 * Lists KEDA ScaledObjects, keyed by the Deployment they scale.
 *
 * A cluster without KEDA has no such resource, and a user may lack access to
 * it; neither is fatal, so failure yields an empty map and every deployment is
 * treated as unmanaged.
 *
 * @param {Object} target
 * @returns {Promise<Object>}
 */
async function getScaledObjects(target) {
  const timeoutSeconds = target.timeoutSeconds || 60;
  const result = await executor.run(
    KUBECTL,
    [
      'get',
      'scaledobject',
      '--context',
      target.context,
      '--namespace',
      target.namespace,
      `--request-timeout=${timeoutSeconds}s`,
      '-o',
      'json',
    ],
    { timeout: timeoutSeconds * 1000 + EXECUTOR_GRACE_MS }
  );

  if (result.code !== 0) {
    return {};
  }

  const byDeployment = {};

  (JSON.parse(result.stdout).items || []).forEach((item) => {
    const ref = item.spec.scaleTargetRef || {};

    if (ref.kind && ref.kind !== 'Deployment') {
      return;
    }

    byDeployment[ref.name] = {
      name: item.metadata.name,
      min: item.spec.minReplicaCount,
      max: item.spec.maxReplicaCount,
      triggers: item.spec.triggers || [],
    };
  });

  return byDeployment;
}

/**
 * Builds the ScaledObject patch that pins a replica count.
 *
 * KEDA overrides `kubectl scale`, so the autoscaler must be pinned first or it
 * scales the deployment straight back. Cron triggers carry their own
 * desiredReplicas, which has to move too. The full trigger list is sent because
 * a JSON merge patch replaces arrays wholesale.
 *
 * @param {Object} autoscaler
 * @param {number} replicas
 * @returns {Object}
 */
function buildScalePatch(autoscaler, replicas) {
  return {
    spec: {
      minReplicaCount: replicas,
      maxReplicaCount: replicas,
      triggers: autoscaler.triggers.map((trigger) => {
        if (trigger.type !== 'cron') {
          return trigger;
        }

        return Object.assign({}, trigger, {
          metadata: Object.assign({}, trigger.metadata, {
            // KEDA expects this as a string.
            desiredReplicas: String(replicas),
          }),
        });
      }),
    },
  };
}

/**
 * Scales a deployment, pinning its autoscaler first when it has one.
 *
 * @param {Object} target
 * @param {string} deployment
 * @param {number} replicas
 * @param {Object} [autoscaler]
 * @returns {Promise<{ steps: Array<string> } | { error: Object }>}
 */
async function scaleDeployment(target, deployment, replicas, autoscaler) {
  const timeoutSeconds = target.timeoutSeconds || 60;
  const options = { timeout: timeoutSeconds * 1000 + EXECUTOR_GRACE_MS };
  const steps = [];

  if (autoscaler) {
    const patched = await executor.run(
      KUBECTL,
      [
        'patch',
        'scaledobject',
        autoscaler.name,
        '--type=merge',
        '-p',
        JSON.stringify(buildScalePatch(autoscaler, replicas)),
        '--context',
        target.context,
        '--namespace',
        target.namespace,
        `--request-timeout=${timeoutSeconds}s`,
      ],
      options
    );

    if (patched.code !== 0) {
      return { error: classifyError(patched.stderr) };
    }

    steps.push(`${autoscaler.name} pinned to ${replicas}`);
  }

  const scaled = await executor.run(
    KUBECTL,
    [
      'scale',
      `--replicas=${replicas}`,
      `deployment/${deployment}`,
      '--context',
      target.context,
      '--namespace',
      target.namespace,
      `--request-timeout=${timeoutSeconds}s`,
    ],
    options
  );

  if (scaled.code !== 0) {
    return { error: classifyError(scaled.stderr), steps };
  }

  steps.push(scaled.stdout.trim() || `${deployment} scaled to ${replicas}`);

  return { steps };
}

/**
 * Builds the --requests and --limits flags for `kubectl set resources`.
 *
 * Only the fields the caller supplied are sent: `kubectl set resources`
 * overwrites whatever it is handed, so naming a resource without a value would
 * wipe the value the deployment already carries.
 *
 * @param {Object} [resources]
 * @param {Object} [resources.requests]
 * @param {Object} [resources.limits]
 * @returns {{ flags: Array<string> } | { error: Object }}
 */
function buildResourceFlags(resources) {
  const source = resources || {};
  const flags = [];
  let invalid = null;

  ['requests', 'limits'].forEach((kind) => {
    const values = source[kind] || {};
    const parts = [];

    [['cpu', CPU_QUANTITY], ['memory', MEMORY_QUANTITY]].forEach(([field, pattern]) => {
      const raw = values[field];

      // A blank form field arrives as an empty string, which means "leave this
      // one alone", not "set it to nothing".
      if (raw === undefined || raw === null || raw === '') {
        return;
      }

      const value = String(raw);

      if (!pattern.test(value)) {
        invalid = invalid || {
          kind: 'invalid',
          message: `Invalid ${kind}.${field} value: ${value}`,
        };

        return;
      }

      parts.push(`${field}=${value}`);
    });

    if (parts.length > 0) {
      flags.push(`--${kind}=${parts.join(',')}`);
    }
  });

  if (invalid) {
    return { error: invalid };
  }

  if (flags.length === 0) {
    return {
      error: {
        kind: 'invalid',
        message: 'Provide at least one CPU or memory request or limit.',
      },
    };
  }

  return { flags };
}

/**
 * Sets CPU and memory requests/limits on a deployment. This is a mutating call:
 * the deployment rolls out fresh pods on the new spec.
 *
 * @param {Object} target
 * @param {string} deployment
 * @param {Object} resources
 * @param {string} [container] limits the change to one container of the pod
 * @returns {Promise<{ message: string } | { error: Object }>}
 */
async function setResources(target, deployment, resources, container) {
  const built = buildResourceFlags(resources);

  // The route checks this first so it can answer 400 before reading the
  // registry; repeating it here keeps the argv safe for any other caller.
  if (built.error) {
    return { error: built.error };
  }

  const timeoutSeconds = target.timeoutSeconds || 60;
  const args = ['set', 'resources', `deployment/${deployment}`].concat(built.flags);

  if (container) {
    args.push('-c', container);
  }

  args.push(
    '--context',
    target.context,
    '--namespace',
    target.namespace,
    `--request-timeout=${timeoutSeconds}s`
  );

  const result = await executor.run(KUBECTL, args, {
    timeout: timeoutSeconds * 1000 + EXECUTOR_GRACE_MS,
  });

  if (result.code !== 0) {
    return { error: classifyError(result.stderr) };
  }

  return { message: result.stdout.trim() || `${deployment} resources updated` };
}

/**
 * Runs a CronJob once, right now, by cloning its template into a Job. This is a
 * mutating call: the job does whatever the cron would have done on schedule.
 *
 * @param {Object} target
 * @param {string} cronjob
 * @param {string} name name for the new Job, which must be free in the namespace
 * @returns {Promise<{ message: string } | { error: Object }>}
 */
async function createJobFromCronJob(target, cronjob, name) {
  const timeoutSeconds = target.timeoutSeconds || 60;
  const args = [
    'create',
    'job',
    name,
    `--from=cronjob/${cronjob}`,
    '--context',
    target.context,
    '--namespace',
    target.namespace,
    `--request-timeout=${timeoutSeconds}s`,
  ];

  const result = await executor.run(KUBECTL, args, {
    timeout: timeoutSeconds * 1000 + EXECUTOR_GRACE_MS,
  });

  if (result.code !== 0) {
    return { error: classifyError(result.stderr) };
  }

  return { message: result.stdout.trim() || `${name} created from ${cronjob}` };
}

/**
 * Lists the CronJobs declared in the namespace.
 *
 * @param {Object} target
 * @returns {Promise<{ cronjobs: Array<Object> } | { error: Object }>}
 */
async function getCronJobs(target) {
  const timeoutSeconds = target.timeoutSeconds || 60;
  const result = await executor.run(
    KUBECTL,
    [
      'get',
      'cronjobs',
      '--context',
      target.context,
      '--namespace',
      target.namespace,
      `--request-timeout=${timeoutSeconds}s`,
      '-o',
      'json',
    ],
    { timeout: timeoutSeconds * 1000 + EXECUTOR_GRACE_MS }
  );

  // Unlike ScaledObjects, this list is the whole answer, so a failure is
  // surfaced rather than swallowed into an empty one.
  if (result.code !== 0) {
    return { error: classifyError(result.stderr) };
  }

  const items = JSON.parse(result.stdout).items || [];

  return {
    cronjobs: items.map((item) => {
      const spec = item.spec || {};
      const status = item.status || {};

      return {
        name: item.metadata.name,
        schedule: spec.schedule || null,
        suspend: Boolean(spec.suspend),
        lastScheduleTime: status.lastScheduleTime || null,
      };
    }),
  };
}

module.exports = {
  getPods,
  getCronJobs,
  getScaledObjects,
  rolloutRestart,
  scaleDeployment,
  setResources,
  createJobFromCronJob,
  buildScalePatch,
  buildResourceFlags,
  classifyError,
  KUBECTL,
};
