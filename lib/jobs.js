'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

const config = require('./config');
const { K8S_NAME } = require('./core/http');

// Repo-relative on purpose: svctl has to be run with cwd = the repo root
// (DESIGN.md §5), and spawning it by the same relative path it is documented
// with keeps the argv identical to what a human would type.
const SVCTL = path.join('cli', 'svctl');

const MAX_LINES_PER_STEP = 5000;
const MAX_DEPLOYMENTS = 20;
const MAX_JOBS = 50;
const KILL_GRACE_MS = 5000;

// svctl prints the Jenkins build URL once; the UI renders the first one it sees
// per step as a link.
const JENKINS_URL = /https:\/\/jenkins2\.cermati\.com\/\S+/;

// Free-text values that reach an argv array must never be able to look like a
// flag (DESIGN.md §7.5). The version is produced by us, but it is scraped out
// of a log, so it is treated as untrusted all the same.
const ARGV_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const jobs = new Map();
const order = [];

let running = null;

function invalid(message) {
  return Object.assign(new Error(message), { kind: 'invalid', status: 400 });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ *
 * Version extraction
 * ------------------------------------------------------------------ */

/**
 * The shape of an image version token, e.g. `stg-20260915T141826-cf2118ba`.
 *
 * Deliberately matched by TOKEN SHAPE rather than by the wording around it:
 * the surrounding log text is not a contract, the token is.
 *
 * @param {string} env
 * @param {string} [override] config.versionPattern
 * @returns {string} a regex source
 */
function versionPatternSource(env, override) {
  if (override) {
    return override;
  }

  return `\\b${escapeRegExp(env)}-\\d{8}T\\d{6}-[0-9a-f]{7,40}\\b`;
}

/**
 * Finds the image version in captured containerize output.
 *
 * Takes the LAST match: the token is echoed several times during a build (tag,
 * push, summary) and the final one is the version that actually landed.
 *
 * Pure — give it log text, get a string or null. No spawning, so it can be
 * tested against real log samples.
 *
 * @param {string} text
 * @param {string} env
 * @param {string} [override]
 * @returns {string|null}
 */
function extractVersion(text, env, override) {
  const matches = String(text || '').match(
    new RegExp(versionPatternSource(env, override), 'g')
  );

  return matches && matches.length ? matches[matches.length - 1] : null;
}

/**
 * Re-checks a version we extracted ourselves before it becomes an argv entry.
 *
 * @param {string} version
 * @param {string} env
 * @param {string} [override]
 * @returns {boolean}
 */
function isValidVersion(version, env, override) {
  if (typeof version !== 'string' || !ARGV_SAFE.test(version)) {
    return false;
  }

  return extractVersion(version, env, override) === version;
}

/* ------------------------------------------------------------------ *
 * Argv
 * ------------------------------------------------------------------ */

/**
 * @param {string} build
 * @param {string} env
 * @returns {string[]}
 */
function containerizeCommand(build, env) {
  return [SVCTL, 'jenkins', 'run-pipeline', 'containerize', build, env];
}

/**
 * `default` is the cluster_context argument: svctl resolves it to the service's
 * own default cluster (DESIGN.md §6).
 *
 * @param {string} deployment
 * @param {string} env
 * @param {string} version
 * @returns {string[]}
 */
function kubeDeployCommand(deployment, env, version) {
  return [
    SVCTL,
    'jenkins',
    'run-pipeline',
    'kube-deploy',
    'default',
    deployment,
    env,
    version,
  ];
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

/**
 * Validates a deploy request. Everything here reaches an argv array, so this
 * runs to completion before anything is spawned.
 *
 * @param {Object} request
 * @param {Object} request.target a resolved registry target (supplies env)
 * @param {string} [request.build]
 * @param {string[]} request.deployments
 * @param {boolean} [request.skipContainerize]
 * @param {string} [request.version] required when skipContainerize is set
 * @param {Object} [settings] loaded config, for the version pattern
 * @returns {Object} the normalised request
 */
function validate(request, settings) {
  const target = request.target || {};
  const env = target.env;

  if (!K8S_NAME.test(String(env || ''))) {
    throw invalid(`Invalid env: ${env}`);
  }

  const build = request.build || target.build;

  if (!K8S_NAME.test(String(build || ''))) {
    throw invalid(
      `Invalid build name: ${build === undefined ? '(missing)' : build}`
    );
  }

  const deployments = request.deployments;

  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw invalid('deployments must be a non-empty array.');
  }

  if (deployments.length > MAX_DEPLOYMENTS) {
    throw invalid(`Too many deployments (max ${MAX_DEPLOYMENTS}).`);
  }

  deployments.forEach((deployment) => {
    if (!K8S_NAME.test(String(deployment || ''))) {
      throw invalid(`Invalid deployment name: ${deployment}`);
    }
  });

  const repo = target.repo;

  if (!repo) {
    throw invalid(
      `Service "${target.service}" has no "repo" in services.yaml, so there is ` +
        'no directory to run svctl from.'
    );
  }

  const skipContainerize = Boolean(request.skipContainerize);
  let version = null;

  if (skipContainerize) {
    // Nothing is going to produce a version, so the caller has to supply one
    // and it has to look like a real build. `latest` is not accepted: see the
    // note on the no-version abort below.
    version = request.version;

    if (!isValidVersion(version, env, settings && settings.versionPattern)) {
      throw invalid(
        `Skipping containerize needs an explicit image version that looks ` +
          `like ${env}-YYYYMMDDTHHMMSS-<sha>: ${version || '(missing)'}`
      );
    }
  } else if (request.version) {
    throw invalid('version may only be given together with skipContainerize.');
  }

  return {
    service: target.service,
    repo,
    env,
    build,
    deployments: deployments.slice(),
    skipContainerize,
    version,
  };
}

/* ------------------------------------------------------------------ *
 * Public shapes
 * ------------------------------------------------------------------ */

function publicStep(step) {
  return {
    name: step.name,
    command: step.command ? step.command.slice() : null,
    status: step.status,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    exitCode: step.exitCode,
    jenkinsUrl: step.jenkinsUrl,
    lineCount: step.lines.length,
    droppedLines: step.droppedLines,
  };
}

/** The line buffers never go in a JSON payload — they are the SSE stream. */
function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    service: job.service,
    repo: job.repo,
    build: job.build,
    env: job.env,
    deployments: job.deployments.slice(),
    version: job.version,
    error: job.error,
    cwd: job.cwd,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    steps: job.steps.map(publicStep),
  };
}

/* ------------------------------------------------------------------ *
 * Job engine
 * ------------------------------------------------------------------ */

function makeStep(name, command) {
  return {
    name,
    // kube-deploy argv is filled in once containerize has produced a version.
    command: command || null,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    jenkinsUrl: null,
    lines: [],
    droppedLines: 0,
  };
}

function nextId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function remember(job) {
  jobs.set(job.id, job);
  order.unshift(job.id);

  while (order.length > MAX_JOBS) {
    const dropped = order.pop();

    if (dropped !== running) {
      jobs.delete(dropped);
    }
  }
}

function emitJob(job) {
  job.events.emit('job', publicJob(job));
}

function emitStep(job, index) {
  job.events.emit('step', { stepIndex: index, step: publicStep(job.steps[index]) });
}

function pushLine(job, index, text) {
  const step = job.steps[index];

  if (step.lines.length >= MAX_LINES_PER_STEP) {
    // Drop the oldest so a runaway build cannot exhaust memory; the count is
    // surfaced on the step and replayed as a note so nobody reads a truncated
    // log as a complete one.
    step.lines.shift();
    step.droppedLines += 1;
  }

  step.lines.push(text);
  job.events.emit('line', { stepIndex: index, text });

  if (!step.jenkinsUrl) {
    const match = text.match(JENKINS_URL);

    if (match) {
      step.jenkinsUrl = match[0];
      emitStep(job, index);
    }
  }
}

/**
 * Runs one step to completion. Resolves with the exit code; never rejects.
 *
 * @returns {Promise<number>}
 */
function runStep(job, index, spawnFn) {
  const step = job.steps[index];

  step.status = 'running';
  step.startedAt = new Date().toISOString();
  emitStep(job, index);

  return new Promise((resolve) => {
    let child;

    try {
      child = spawnFn(step.command[0], step.command.slice(1), {
        cwd: job.cwd,
        // svctl is a PyInstaller Python binary and block-buffers stdout into a
        // pipe; without this the SSE stream shows nothing for a minute and then
        // dumps the whole build at once (DESIGN.md §6).
        env: Object.assign({}, process.env, { PYTHONUNBUFFERED: '1' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      step.status = 'failed';
      step.exitCode = null;
      step.finishedAt = new Date().toISOString();
      pushLine(job, index, `[kube-tools] failed to start: ${err.message}`);
      emitStep(job, index);
      return resolve(1);
    }

    job.child = child;

    // stdout and stderr land in ONE ordered buffer (each with its own remainder,
    // so a chunk split mid-line never splices the two streams together).
    const reader = () => {
      let remainder = '';

      return {
        push: (chunk) => {
          remainder += String(chunk);

          const parts = remainder.split('\n');

          remainder = parts.pop();
          parts.forEach((line) => pushLine(job, index, line.replace(/\r$/, '')));
        },
        flush: () => {
          if (remainder.length) {
            pushLine(job, index, remainder.replace(/\r$/, ''));
            remainder = '';
          }
        },
      };
    };

    const out = reader();
    const err = reader();

    if (child.stdout) {
      child.stdout.on('data', out.push);
    }

    if (child.stderr) {
      child.stderr.on('data', err.push);
    }

    let settled = false;

    const finish = (code) => {
      if (settled) {
        return;
      }

      settled = true;
      out.flush();
      err.flush();

      if (job.killTimer) {
        clearTimeout(job.killTimer);
        job.killTimer = null;
      }

      job.child = null;
      step.exitCode = typeof code === 'number' ? code : null;
      step.finishedAt = new Date().toISOString();
      step.status =
        job.status === 'cancelled' ? 'cancelled' : code === 0 ? 'succeeded' : 'failed';
      emitStep(job, index);
      resolve(typeof code === 'number' ? code : 1);
    };

    child.on('error', (spawnError) => {
      pushLine(
        job,
        index,
        spawnError.code === 'ENOENT'
          ? `[kube-tools] ${step.command[0]} not found in ${job.cwd}`
          : `[kube-tools] ${spawnError.message}`
      );
      finish(1);
    });

    // 'close' rather than 'exit': it fires once the pipes are drained, so no
    // trailing output is lost.
    child.on('close', (code) => finish(code));
  });
}

function fail(job, message) {
  job.status = 'failed';
  job.error = message;
}

async function run(job, spawnFn, settings) {
  for (let index = 0; index < job.steps.length; index += 1) {
    if (job.status === 'cancelled') {
      break;
    }

    const step = job.steps[index];
    const code = await runStep(job, index, spawnFn);

    if (job.status === 'cancelled') {
      break;
    }

    if (code !== 0) {
      fail(job, `${step.name} exited with code ${code}.`);
      break;
    }

    if (step.name === 'containerize') {
      const version = extractVersion(
        step.lines.join('\n'),
        job.env,
        settings.versionPattern
      );

      // NEVER fall back to `latest` here. `latest` means "whatever Jenkins
      // built most recently", which during a fan-out can be a teammate's build,
      // so the workers would ship an image nobody asked for. Shipping the wrong
      // image is worse than stopping: abort instead. DESIGN.md §7.4 tracked
      // this as the open problem.
      if (!version || !isValidVersion(version, job.env, settings.versionPattern)) {
        fail(
          job,
          'containerize finished but no image version was found in its output, ' +
            `so there is nothing to deploy. Expected a token like ` +
            `${job.env}-YYYYMMDDTHHMMSS-<sha>. Read the Jenkins log, then ` +
            'deploy with an explicit version. (kube-deploy was NOT run.)'
        );
        break;
      }

      job.version = version;
      emitJob(job);
    }

    // Now that the version is known, the remaining argv can be built.
    if (job.version) {
      job.steps.forEach((pending) => {
        if (pending.deployment && !pending.command) {
          pending.command = kubeDeployCommand(
            pending.deployment,
            job.env,
            job.version
          );
        }
      });
    }
  }

  if (job.status === 'running') {
    job.status = 'succeeded';
  }

  job.steps.forEach((step, index) => {
    if (step.status === 'pending') {
      step.status = job.status === 'cancelled' ? 'cancelled' : 'skipped';
      emitStep(job, index);
    }
  });

  job.finishedAt = new Date().toISOString();

  if (running === job.id) {
    running = null;
  }

  emitJob(job);
  job.events.emit('end', publicJob(job));
}

/**
 * Starts a deploy run: containerize once, then kube-deploy each deployment with
 * the version that came out of it.
 *
 * Only one job runs at a time, process-wide — these are real Jenkins builds and
 * real cluster deployments, and two overlapping runs of the same service would
 * race each other's rollout.
 *
 * @param {Object} request see validate()
 * @param {Object} [options]
 * @param {Function} [options.spawn] test seam
 * @param {Object} [options.config] test seam: a loaded config
 * @returns {Object} the public job
 */
function start(request, options) {
  const opts = options || {};

  if (running) {
    throw Object.assign(
      new Error(
        'A deploy is already running. Wait for it to finish, or cancel it first.'
      ),
      { kind: 'busy', status: 409, runningId: running }
    );
  }

  const settings = opts.config || config.load();
  const spec = validate(request, settings);
  const cwd = config.repoDir(settings.workspaceRoot, spec.repo);

  // Checked BEFORE anything spawns: svctl run from the wrong directory writes
  // junk into whatever directory it happens to be in (DESIGN.md §5, §10).
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw invalid(
      `Repo directory not found: ${cwd}. Check workspaceRoot in ` +
        `${config.CONFIG_FILE} and "repo" for ${spec.service} in services.yaml.`
    );
  }

  const binary = path.join(cwd, SVCTL);

  if (!fs.existsSync(binary)) {
    throw invalid(
      `${SVCTL} not found in ${cwd} (looked for ${binary}). svctl must be run ` +
        'with the repo root as its working directory.'
    );
  }

  const steps = [];

  if (!spec.skipContainerize) {
    steps.push(makeStep('containerize', containerizeCommand(spec.build, spec.env)));
  }

  spec.deployments.forEach((deployment) => {
    const step = makeStep(
      `kube-deploy ${deployment}`,
      spec.version ? kubeDeployCommand(deployment, spec.env, spec.version) : null
    );

    step.deployment = deployment;
    steps.push(step);
  });

  const job = {
    id: nextId(),
    status: 'running',
    service: spec.service,
    repo: spec.repo,
    build: spec.build,
    env: spec.env,
    deployments: spec.deployments,
    version: spec.version,
    error: null,
    cwd,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    steps,
    child: null,
    killTimer: null,
    events: new EventEmitter(),
  };

  job.events.setMaxListeners(0);
  remember(job);
  running = job.id;

  job.done = run(job, opts.spawn || spawn, settings).catch((err) => {
    fail(job, err.message);
    job.finishedAt = job.finishedAt || new Date().toISOString();

    if (running === job.id) {
      running = null;
    }

    emitJob(job);
    job.events.emit('end', publicJob(job));
  });

  return publicJob(job);
}

/**
 * @param {string} id
 * @returns {Object|null}
 */
function get(id) {
  const job = jobs.get(id);

  return job ? publicJob(job) : null;
}

/** Newest first. */
function list() {
  return order.filter((id) => jobs.has(id)).map((id) => publicJob(jobs.get(id)));
}

/**
 * Everything captured so far, in order, for an SSE client that connected late.
 *
 * @param {string} id
 * @returns {Array<{stepIndex: number, text: string}>}
 */
function snapshotLines(id) {
  const job = jobs.get(id);

  if (!job) {
    return [];
  }

  const lines = [];

  job.steps.forEach((step, stepIndex) => {
    if (step.droppedLines) {
      lines.push({
        stepIndex,
        text: `[kube-tools] ${step.droppedLines} earlier line(s) dropped (buffer capped at ${MAX_LINES_PER_STEP}).`,
      });
    }

    step.lines.forEach((text) => lines.push({ stepIndex, text }));
  });

  return lines;
}

/**
 * Attaches listeners to a job's event stream.
 *
 * @param {string} id
 * @param {Object<string, Function>} handlers
 * @returns {Function|null} unsubscribe
 */
function subscribe(id, handlers) {
  const job = jobs.get(id);

  if (!job) {
    return null;
  }

  const entries = Object.entries(handlers);

  entries.forEach(([event, handler]) => job.events.on(event, handler));

  return () => entries.forEach(([event, handler]) => job.events.off(event, handler));
}

/**
 * Resolves when the job has finished. Exists so a caller (and the specs) can
 * await a run without polling.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
function wait(id) {
  const job = jobs.get(id);

  return job && job.done ? job.done : Promise.resolve();
}

/**
 * SIGTERM the running step, SIGKILL it if it ignores that.
 *
 * @param {string} id
 * @returns {boolean}
 */
function cancel(id) {
  const job = jobs.get(id);

  if (!job || job.status !== 'running') {
    return false;
  }

  job.status = 'cancelled';
  job.error = 'Cancelled.';

  if (job.child) {
    const child = job.child;

    child.kill('SIGTERM');
    job.killTimer = setTimeout(() => {
      if (job.child === child) {
        child.kill('SIGKILL');
      }
    }, KILL_GRACE_MS);

    // Never let the grace timer hold the process open.
    if (job.killTimer.unref) {
      job.killTimer.unref();
    }
  }

  emitJob(job);

  return true;
}

/**
 * Kills whatever is running. Wired into server shutdown the same way
 * portforward.stopAll() is, so a Ctrl+C does not orphan a build.
 */
function stopAll() {
  [...jobs.values()].forEach((job) => {
    if (job.child) {
      job.child.kill('SIGKILL');
      job.child = null;
    }
  });
}

/** Test seam: forget every job. */
function reset() {
  stopAll();
  jobs.clear();
  order.length = 0;
  running = null;
}

module.exports = {
  start,
  get,
  list,
  cancel,
  subscribe,
  snapshotLines,
  wait,
  stopAll,
  reset,
  validate,
  extractVersion,
  isValidVersion,
  versionPatternSource,
  containerizeCommand,
  kubeDeployCommand,
  MAX_LINES_PER_STEP,
  MAX_DEPLOYMENTS,
};
