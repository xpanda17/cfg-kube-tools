'use strict';

const { spawn } = require('child_process');

const KUBECTL = 'kubectl';
const READY_TIMEOUT_MS = 10000;

// Long-lived children, keyed by target + pod + port so clicking twice does not
// start a second forward for the same thing.
const sessions = new Map();

function sessionId(target, pod, port) {
  return `${target.context}/${target.namespace}/${pod}/${port}`;
}

function publicView(session) {
  return {
    id: session.id,
    pod: session.pod,
    port: session.port,
    namespace: session.namespace,
    status: session.status,
    error: session.error,
    url: session.status === 'running' ? `http://127.0.0.1:${session.port}` : null,
    startedAt: session.startedAt,
  };
}

/**
 * Starts `kubectl port-forward` and resolves once it reports it is listening,
 * so the UI never links to a port that is not up yet.
 *
 * @param {Object} target
 * @param {string} pod
 * @param {number} port
 * @returns {Promise<Object>}
 */
function start(target, pod, port) {
  const id = sessionId(target, pod, port);
  const existing = sessions.get(id);

  if (existing && existing.status === 'running') {
    return Promise.resolve(publicView(existing));
  }

  const args = [
    'port-forward',
    `pod/${pod}`,
    `${port}:${port}`,
    '--context',
    target.context,
    '--namespace',
    target.namespace,
  ];

  const child = spawn(KUBECTL, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const session = {
    id,
    pod,
    port,
    namespace: target.namespace,
    status: 'starting',
    error: null,
    startedAt: new Date().toISOString(),
    child,
    stderr: '',
  };

  sessions.set(id, session);

  return new Promise((resolve) => {
    let settled = false;

    const settle = () => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(publicView(session));
    };

    const timer = setTimeout(() => {
      session.status = 'failed';
      session.error = 'Timed out waiting for the port forward to start.';
      child.kill('SIGTERM');
      settle();
    }, READY_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (/Forwarding from/.test(String(chunk))) {
        session.status = 'running';
        settle();
      }
    });

    child.stderr.on('data', (chunk) => {
      session.stderr += String(chunk);
    });

    child.on('error', (err) => {
      session.status = 'failed';
      session.error =
        err.code === 'ENOENT' ? 'kubectl not found on PATH' : err.message;
      settle();
    });

    child.on('exit', (code) => {
      // An exit before "Forwarding from" means it never came up; after it, the
      // forward was torn down (pod replaced, or stopped from the UI).
      if (session.status === 'starting') {
        session.status = 'failed';
        session.error = session.stderr.trim() || `kubectl exited with code ${code}`;
      } else if (session.status === 'running') {
        session.status = 'stopped';
      }

      session.child = null;
      settle();
    });
  });
}

/**
 * @param {string} id
 * @returns {boolean} whether a running session was stopped
 */
function stop(id) {
  const session = sessions.get(id);

  if (!session || !session.child) {
    sessions.delete(id);
    return false;
  }

  session.child.kill('SIGTERM');
  session.status = 'stopped';
  sessions.delete(id);

  return true;
}

function list() {
  return [...sessions.values()].map(publicView);
}

function stopAll() {
  [...sessions.keys()].forEach(stop);
}

module.exports = { start, stop, list, stopAll, sessionId };
