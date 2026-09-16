'use strict';

// Ordered because the tests are mutually exclusive: a cron pod is never an LB,
// and an SUT pod always carries the "sut" release channel. Anything that fails
// every positive test falls through to "worker".
const CATEGORIES = [
  'app',
  'canary',
  'sut',
  'lb',
  'worker',
  'cronjob',
];

/**
 * Derives the deployment name from the owning ReplicaSet by stripping the
 * pod-template-hash suffix. Verified against every ReplicaSet-owned pod in the
 * athena stg namespace.
 *
 * @param {Object} pod
 * @returns {string|null}
 */
function deploymentName(pod) {
  const owner = ((pod.metadata && pod.metadata.ownerReferences) || [])[0];

  if (!owner || owner.kind !== 'ReplicaSet') {
    return null;
  }

  const hash = (pod.metadata.labels || {})['pod-template-hash'];

  if (hash && owner.name.endsWith(`-${hash}`)) {
    return owner.name.slice(0, -(hash.length + 1));
  }

  return owner.name;
}

/**
 * Names the thing a pod belongs to: its Deployment, or for a cron pod the
 * CronJob that spawned it. This is the unit people actually act on.
 *
 * @param {Object} pod
 * @returns {string}
 */
function groupName(pod) {
  const deployment = deploymentName(pod);

  if (deployment) {
    return deployment;
  }

  const labels = (pod.metadata && pod.metadata.labels) || {};
  const parent = labels['cfgroot.k8s.service/cronjob_parent_service'];
  const owner = ((pod.metadata && pod.metadata.ownerReferences) || [])[0];
  const jobName = (owner && owner.name) || pod.metadata.name;

  // Six of the cron pods lack the parent label, so fall back to the Job name
  // with its schedule slot suffix removed.
  return parent && jobName.startsWith(parent) ? parent : jobName.replace(/-\d+$/, '');
}

/**
 * Strips the group prefix so a table of sibling pods shows only what differs.
 *
 * @param {Object} pod
 * @param {string} group
 * @returns {string}
 */
function shortName(pod, group) {
  const name = pod.metadata.name;

  return name.startsWith(`${group}-`) ? name.slice(group.length + 1) : name;
}

/**
 * Collects the container ports a pod exposes, in declaration order.
 *
 * @param {Object} pod
 * @returns {Array<number>}
 */
function containerPorts(pod) {
  return ((pod.spec && pod.spec.containers) || []).reduce(
    (all, container) => all.concat((container.ports || []).map((p) => p.containerPort)),
    []
  );
}

/**
 * Reports what each container asks for and is capped at.
 *
 * This is read from the pod's own spec, which is the deployment spec as the
 * cluster actually applied it -- the Update Spec form is prefilled from it, so
 * it has to show what is running rather than what was last submitted.
 *
 * @param {Object} pod
 * @returns {Array<Object>}
 */
function containerResources(pod) {
  return ((pod.spec && pod.spec.containers) || []).map((container) => {
    const resources = container.resources || {};
    const requests = resources.requests || {};
    const limits = resources.limits || {};

    return {
      name: container.name || null,
      requests: { cpu: requests.cpu || null, memory: requests.memory || null },
      limits: { cpu: limits.cpu || null, memory: limits.memory || null },
    };
  });
}

/**
 * Buckets a pod into one of the six categories the UI groups by.
 *
 * @param {Object} pod
 * @returns {string}
 */
function categorize(pod) {
  const labels = (pod.metadata && pod.metadata.labels) || {};
  const owner = ((pod.metadata && pod.metadata.ownerReferences) || [])[0];
  const channel = labels['cfgroot.k8s.cicd/release_channel'];
  const deployment = deploymentName(pod) || '';

  // Every Job in this namespace is owned by a CronJob, so Job ownership is
  // enough; the parent name is resolved separately where it is needed.
  if (owner && owner.kind === 'Job') {
    return 'cronjob';
  }

  if (channel === 'canary') {
    return 'canary';
  }

  if (channel === 'sut' || /-sut-/.test(deployment)) {
    return 'sut';
  }

  // Load balancers carry no release channel at all.
  if (/-lb$/.test(deployment)) {
    return 'lb';
  }

  // Apps serve traffic, workers consume queues: an app declares container
  // ports, a worker declares none. This holds across products, where naming
  // does not -- bureau-server and n8n are apps, n8n-worker is not.
  if (containerPorts(pod).length > 0) {
    return 'app';
  }

  return 'worker';
}

/**
 * Formats a duration the way kubectl does: 45s, 5m30s, 32m, 4h32m, 6d1h, 2y13d.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatAge(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const years = Math.floor(days / 365);

  if (seconds < 120) {
    return `${seconds}s`;
  }

  if (minutes < 10) {
    const rest = seconds % 60;
    return rest ? `${minutes}m${rest}s` : `${minutes}m`;
  }

  if (minutes < 180) {
    return `${minutes}m`;
  }

  if (hours < 8) {
    const rest = minutes % 60;
    return rest ? `${hours}h${rest}m` : `${hours}h`;
  }

  if (hours < 48) {
    return `${hours}h`;
  }

  if (days < 8) {
    const rest = hours % 24;
    return rest ? `${days}d${rest}h` : `${days}d`;
  }

  if (days < 365) {
    return `${days}d`;
  }

  const rest = days % 365;
  return rest ? `${years}y${rest}d` : `${years}y`;
}

/**
 * Derives the STATUS column.
 *
 * status.phase alone is misleading: a pod stuck in CrashLoopBackOff still
 * reports phase "Running". This covers the states worth looking at, but is an
 * approximation of kubectl's full printer, which also weighs init containers
 * and restartable sidecars.
 *
 * @param {Object} pod
 * @returns {string}
 */
function deriveStatus(pod) {
  const status = pod.status || {};
  const containers = status.containerStatuses || [];

  if (pod.metadata && pod.metadata.deletionTimestamp) {
    return 'Terminating';
  }

  const waiting = containers.find((c) => c.state && c.state.waiting);

  if (waiting) {
    return waiting.state.waiting.reason || 'Waiting';
  }

  const terminated = containers.find(
    (c) => c.state && c.state.terminated && c.state.terminated.reason
  );

  if (terminated) {
    return terminated.state.terminated.reason;
  }

  return status.reason || status.phase || 'Unknown';
}

/**
 * Flattens `kubectl get pods -o json` into table rows.
 *
 * @param {Object} payload
 * @param {number} [now]
 * @returns {Array<Object>}
 */
function toRows(payload, now) {
  const items = (payload && payload.items) || [];
  const at = now || Date.now();

  return items.map((pod) => {
    const containers = (pod.status && pod.status.containerStatuses) || [];
    const ready = containers.filter((c) => c.ready).length;
    const restarts = containers.reduce((sum, c) => sum + (c.restartCount || 0), 0);
    const created = pod.metadata && pod.metadata.creationTimestamp;
    const status = deriveStatus(pod);
    const labels = pod.metadata.labels || {};
    const group = groupName(pod);

    return {
      name: pod.metadata.name,
      shortName: shortName(pod, group),
      group,
      ready: `${ready}/${containers.length}`,
      healthy: containers.length > 0 && ready === containers.length && status === 'Running',
      status,
      restarts,
      age: created ? formatAge(at - Date.parse(created)) : '-',
      category: categorize(pod),
      deployment: deploymentName(pod),
      ports: containerPorts(pod),
      containers: containerResources(pod),
      version: labels['cfgroot.k8s.cicd/version'] || null,
    };
  });
}

module.exports = {
  toRows,
  deriveStatus,
  formatAge,
  categorize,
  deploymentName,
  containerPorts,
  containerResources,
  groupName,
  shortName,
  CATEGORIES,
};
