'use strict';

const executor = require('../core/executor');
const pods = require('./pods');

const KUBECTL = 'kubectl';

// kubectl is given the deadline; the executor's own kill is a backstop for the
// case where kubectl ignores it and hangs.
const EXECUTOR_GRACE_MS = 5000;

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

module.exports = {
  getPods,
  getScaledObjects,
  rolloutRestart,
  scaleDeployment,
  buildScalePatch,
  classifyError,
  KUBECTL,
};
