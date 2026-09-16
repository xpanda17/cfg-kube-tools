'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { expect } = require('chai');

const jobs = require('../lib/jobs');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

// Real containerize output, trimmed. The version token is what matters; the
// wording around it is explicitly NOT relied on.
const CONTAINERIZE_LOG = [
  '[INFO] Resolving service athena in environment stg',
  '[INFO] Pipeline queued: https://jenkins2.cermati.com/job/athena/job/containerize/4821/',
  '[INFO] Waiting for the build to finish...',
  '[INFO] docker push registry.cermati.com/athena:stg-20260914T063654-6c270441',
  '[OK] Built image version stg-20260914T063654-6c270441',
].join('\n');

/**
 * A stand-in for child_process.spawn. Never touches svctl: each planned step
 * describes what the fake child prints and how it exits.
 *
 * @param {Array<Object>} plans
 */
function fakeSpawner(plans) {
  const calls = [];
  const children = [];

  function spawn(bin, args, options) {
    const plan = plans[calls.length] || { code: 0 };
    const child = new EventEmitter();

    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];

    let closed = false;

    const close = (code) => {
      if (closed) {
        return;
      }

      closed = true;
      child.emit('close', code);
    };

    child.kill = (signal) => {
      child.signals.push(signal);

      if (signal === 'SIGTERM') {
        setImmediate(() => close(143));
      }
    };

    calls.push({ bin, args, options, command: [bin].concat(args) });
    children.push(child);

    setImmediate(() => {
      if (plan.spawnError) {
        child.emit('error', Object.assign(new Error('spawn failed'), { code: plan.spawnError }));
        return;
      }

      (plan.chunks || (plan.stdout ? [{ stream: 'stdout', text: plan.stdout }] : [])).forEach(
        (chunk) => {
          const target = chunk.stream === 'stderr' ? child.stderr : child.stdout;

          target.emit('data', Buffer.from(chunk.text));
        }
      );

      if (plan.stderr) {
        child.stderr.emit('data', Buffer.from(plan.stderr));
      }

      // `hang: true` keeps the child alive until something kills it.
      if (!plan.hang) {
        close(plan.code || 0);
      }
    });

    return child;
  }

  return { spawn, calls, children };
}

/** A workspace with a fake repo that has a cli/svctl file (never executed). */
function makeWorkspace(repo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-tools-ws-'));

  if (repo !== null) {
    fs.mkdirSync(path.join(root, repo || 'athena', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(root, repo || 'athena', 'cli', 'svctl'), '#!/bin/sh\n');
  }

  return root;
}

function targetFor(overrides) {
  return Object.assign(
    {
      context: 'ctx-stg',
      namespace: 'ns-stg',
      service: 'athenaapp',
      env: 'stg',
      repo: 'athena',
      build: 'athena',
    },
    overrides
  );
}

function startJob(request, spawner, settings) {
  return jobs.start(request, {
    spawn: spawner.spawn,
    config: Object.assign({ workspaceRoot: null, versionPattern: null }, settings),
  });
}

describe('jobs', () => {
  afterEach(() => jobs.reset());

  /* ---------------------------------------------------------------- */

  describe('extractVersion', () => {
    it('finds the version in real containerize output', () => {
      expect(jobs.extractVersion(CONTAINERIZE_LOG, 'stg')).to.equal(
        'stg-20260914T063654-6c270441'
      );
    });

    it('finds a second real sample', () => {
      const log = '[OK] pushed athena:stg-20260915T141826-cf2118ba to the registry';

      expect(jobs.extractVersion(log, 'stg')).to.equal('stg-20260915T141826-cf2118ba');
    });

    it('takes the LAST match when the token appears several times', () => {
      const log = [
        'reusing cache from stg-20260914T063654-6c270441',
        'tagging stg-20260915T141826-cf2118ba',
        'pushed stg-20260915T141826-cf2118ba',
      ].join('\n');

      expect(jobs.extractVersion(log, 'stg')).to.equal('stg-20260915T141826-cf2118ba');
    });

    it('returns null when no version is present', () => {
      expect(jobs.extractVersion('[INFO] build queued\n[INFO] done', 'stg')).to.equal(
        null
      );
    });

    it('returns null for empty or missing output', () => {
      expect(jobs.extractVersion('', 'stg')).to.equal(null);
      expect(jobs.extractVersion(undefined, 'stg')).to.equal(null);
    });

    it('ignores a token built for another environment', () => {
      const log = 'built prod-20260915T141826-cf2118ba';

      expect(jobs.extractVersion(log, 'stg')).to.equal(null);
      expect(jobs.extractVersion(log, 'prod')).to.equal(
        'prod-20260915T141826-cf2118ba'
      );
    });

    it('rejects a token whose shape is wrong', () => {
      expect(jobs.extractVersion('stg-2026091-6c270441', 'stg')).to.equal(null);
      expect(jobs.extractVersion('stg-20260915T141826-zzzz', 'stg')).to.equal(null);
    });

    it('uses a configured pattern instead of the default', () => {
      const log = 'image: build_00421 ready';

      expect(jobs.extractVersion(log, 'stg')).to.equal(null);
      expect(jobs.extractVersion(log, 'stg', 'build_[0-9]+')).to.equal('build_00421');
    });

    it('escapes regex characters in the env name', () => {
      expect(jobs.extractVersion('sxg-20260915T141826-cf2118ba', 's.g')).to.equal(null);
    });
  });

  describe('isValidVersion', () => {
    it('accepts a version it produced itself', () => {
      expect(jobs.isValidVersion('stg-20260915T141826-cf2118ba', 'stg')).to.equal(true);
    });

    it('rejects latest', () => {
      expect(jobs.isValidVersion('latest', 'stg')).to.equal(false);
    });

    it('rejects anything that could be read as a flag', () => {
      expect(jobs.isValidVersion('--token=leaked', 'stg')).to.equal(false);
    });

    it('rejects a token with trailing text', () => {
      expect(jobs.isValidVersion('stg-20260915T141826-cf2118ba extra', 'stg')).to.equal(
        false
      );
    });
  });

  /* ---------------------------------------------------------------- */

  describe('argv construction', () => {
    it('builds the containerize command', () => {
      expect(jobs.containerizeCommand('athena', 'stg')).to.deep.equal([
        'cli/svctl',
        'jenkins',
        'run-pipeline',
        'containerize',
        'athena',
        'stg',
      ]);
    });

    it('builds the kube-deploy command with the default cluster context', () => {
      expect(
        jobs.kubeDeployCommand('athenaapp-deployment', 'stg', 'stg-20260915T141826-cf2118ba')
      ).to.deep.equal([
        'cli/svctl',
        'jenkins',
        'run-pipeline',
        'kube-deploy',
        'default',
        'athenaapp-deployment',
        'stg',
        'stg-20260915T141826-cf2118ba',
      ]);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('validate', () => {
    const base = { target: targetFor(), deployments: ['athenaapp-deployment'] };

    it('falls back to the registry build when the body omits one', () => {
      expect(jobs.validate(base, {}).build).to.equal('athena');
    });

    it('rejects a build name that could be read as a flag', () => {
      expect(() =>
        jobs.validate(Object.assign({}, base, { build: '--commit' }), {})
      ).to.throw(/Invalid build name/);
    });

    it('rejects a deployment name that could be read as a flag', () => {
      expect(() =>
        jobs.validate(Object.assign({}, base, { deployments: ['-rf'] }), {})
      ).to.throw(/Invalid deployment name/);
    });

    it('rejects an empty deployment list', () => {
      expect(() =>
        jobs.validate(Object.assign({}, base, { deployments: [] }), {})
      ).to.throw(/non-empty array/);
    });

    it('rejects more than 20 deployments', () => {
      const deployments = Array.from({ length: 21 }, (item, i) => `worker-${i}`);

      expect(() =>
        jobs.validate(Object.assign({}, base, { deployments }), {})
      ).to.throw(/Too many deployments/);
    });

    it('rejects a service with no repo in services.yaml', () => {
      expect(() =>
        jobs.validate({ target: targetFor({ repo: null }), deployments: ['a'] }, {})
      ).to.throw(/has no "repo"/);
    });

    it('rejects a version unless containerize is being skipped', () => {
      expect(() =>
        jobs.validate(
          Object.assign({}, base, { version: 'stg-20260915T141826-cf2118ba' }),
          {}
        )
      ).to.throw(/only be given together with skipContainerize/);
    });

    it('requires a well-shaped version when containerize is skipped', () => {
      expect(() =>
        jobs.validate(
          Object.assign({}, base, { skipContainerize: true, version: 'latest' }),
          {}
        )
      ).to.throw(/explicit image version/);

      expect(
        jobs.validate(
          Object.assign({}, base, {
            skipContainerize: true,
            version: 'stg-20260915T141826-cf2118ba',
          }),
          {}
        ).version
      ).to.equal('stg-20260915T141826-cf2118ba');
    });

    it('marks the request status as 400 so the route can answer with it', () => {
      try {
        jobs.validate(Object.assign({}, base, { deployments: ['BAD'] }), {});
        throw new Error('expected a throw');
      } catch (err) {
        expect(err.status).to.equal(400);
        expect(err.kind).to.equal('invalid');
      }
    });
  });

  /* ---------------------------------------------------------------- */

  describe('preflight', () => {
    it('refuses to spawn when the repo directory is missing', () => {
      const workspaceRoot = makeWorkspace(null);
      const spawner = fakeSpawner([]);

      expect(() =>
        startJob(
          { target: targetFor(), deployments: ['athenaapp-deployment'] },
          spawner,
          { workspaceRoot }
        )
      ).to.throw(new RegExp(path.join(workspaceRoot, 'athena').replace(/\\/g, '\\\\')));

      expect(spawner.calls).to.have.lengthOf(0);
    });

    it('refuses to spawn when the repo has no cli/svctl', () => {
      const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kube-tools-ws-'));

      fs.mkdirSync(path.join(workspaceRoot, 'athena'));

      const spawner = fakeSpawner([]);

      expect(() =>
        startJob(
          { target: targetFor(), deployments: ['athenaapp-deployment'] },
          spawner,
          { workspaceRoot }
        )
      ).to.throw(/cli\/svctl not found/);

      expect(spawner.calls).to.have.lengthOf(0);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('run', () => {
    it('containerizes once, then deploys every deployment with that version', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: `${CONTAINERIZE_LOG}\n` },
        { stdout: '[OK] deployed\n' },
        { stdout: '[OK] deployed\n' },
      ]);

      const started = startJob(
        {
          target: targetFor(),
          deployments: ['athenaapp-deployment', 'atwautodialcollection'],
        },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const job = jobs.get(started.id);

      expect(job.status).to.equal('succeeded');
      expect(job.version).to.equal('stg-20260914T063654-6c270441');
      expect(spawner.calls).to.have.lengthOf(3);

      expect(spawner.calls[0].command).to.deep.equal([
        'cli/svctl',
        'jenkins',
        'run-pipeline',
        'containerize',
        'athena',
        'stg',
      ]);
      expect(spawner.calls[1].command).to.deep.equal([
        'cli/svctl',
        'jenkins',
        'run-pipeline',
        'kube-deploy',
        'default',
        'athenaapp-deployment',
        'stg',
        'stg-20260914T063654-6c270441',
      ]);
      expect(spawner.calls[2].command[5]).to.equal('atwautodialcollection');

      // Every deployment gets the SAME image: that is the whole point of
      // capturing the version instead of chaining with `latest`.
      expect(spawner.calls[1].command[7]).to.equal(spawner.calls[2].command[7]);
      expect(job.steps.map((step) => step.name)).to.deep.equal([
        'containerize',
        'kube-deploy athenaapp-deployment',
        'kube-deploy atwautodialcollection',
      ]);
      expect(job.steps.every((step) => step.status === 'succeeded')).to.equal(true);
    });

    it('runs steps sequentially, never in parallel', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: `${CONTAINERIZE_LOG}\n` },
        { stdout: 'a\n' },
        { stdout: 'b\n' },
      ]);

      const started = startJob(
        { target: targetFor(), deployments: ['one', 'two'] },
        spawner,
        { workspaceRoot }
      );

      expect(spawner.calls).to.have.lengthOf(1);

      await jobs.wait(started.id);

      expect(spawner.calls).to.have.lengthOf(3);
    });

    it('pins cwd to the repo root and unbuffers python', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([{ stdout: `${CONTAINERIZE_LOG}\n` }, { stdout: '' }]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      expect(spawner.calls[0].options.cwd).to.equal(
        path.join(workspaceRoot, 'athena')
      );
      expect(spawner.calls[0].options.env.PYTHONUNBUFFERED).to.equal('1');
    });

    it('skips containerize when asked, and uses the supplied version', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([{ stdout: '[OK] deployed\n' }]);

      const started = startJob(
        {
          target: targetFor(),
          deployments: ['athenaapp-deployment'],
          skipContainerize: true,
          version: 'stg-20260915T141826-cf2118ba',
        },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      expect(spawner.calls).to.have.lengthOf(1);
      expect(spawner.calls[0].command[3]).to.equal('kube-deploy');
      expect(spawner.calls[0].command[7]).to.equal('stg-20260915T141826-cf2118ba');
      expect(jobs.get(started.id).status).to.equal('succeeded');
    });

    it('fails the job and skips the rest when a step exits non-zero', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: `${CONTAINERIZE_LOG}\n` },
        { stdout: '[ERROR] rollout rejected\n', code: 2 },
        { stdout: 'never runs\n' },
      ]);

      const started = startJob(
        { target: targetFor(), deployments: ['first', 'second'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const job = jobs.get(started.id);

      expect(spawner.calls).to.have.lengthOf(2);
      expect(job.status).to.equal('failed');
      expect(job.error).to.match(/kube-deploy first exited with code 2/);
      expect(job.steps[1].status).to.equal('failed');
      expect(job.steps[1].exitCode).to.equal(2);
      expect(job.steps[2].status).to.equal('skipped');
      expect(job.steps[2].command).to.not.equal(null);
    });

    it('aborts before any deploy when containerize prints no version', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: '[INFO] queued\n[OK] pipeline accepted\n' },
        { stdout: 'must not run\n' },
      ]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const job = jobs.get(started.id);

      // Never `latest`: deploying a build nobody asked for is worse than
      // stopping (DESIGN.md §7.4).
      expect(spawner.calls).to.have.lengthOf(1);
      expect(job.status).to.equal('failed');
      expect(job.version).to.equal(null);
      expect(job.error).to.match(/no image version was found/);
      expect(job.error).to.match(/kube-deploy was NOT run/);
      expect(job.steps[1].status).to.equal('skipped');
      expect(job.steps[1].command).to.equal(null);
    });

    it('uses a configured version pattern when one is set', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: '[OK] image build-00421 pushed\n' },
        { stdout: '[OK] deployed\n' },
      ]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot, versionPattern: '\\bbuild-[0-9]{5}\\b' }
      );

      await jobs.wait(started.id);

      expect(jobs.get(started.id).version).to.equal('build-00421');
      expect(spawner.calls[1].command[7]).to.equal('build-00421');
    });

    it('captures the Jenkins URL per step', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: `${CONTAINERIZE_LOG}\n` },
        {
          stdout:
            '[INFO] queued https://jenkins2.cermati.com/job/athena/job/kube-deploy/77/\n',
        },
      ]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const job = jobs.get(started.id);

      expect(job.steps[0].jenkinsUrl).to.equal(
        'https://jenkins2.cermati.com/job/athena/job/containerize/4821/'
      );
      expect(job.steps[1].jenkinsUrl).to.equal(
        'https://jenkins2.cermati.com/job/athena/job/kube-deploy/77/'
      );
    });

    it('merges stdout and stderr into one ordered buffer and joins split lines', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        {
          chunks: [
            { stream: 'stdout', text: 'first line\nsec' },
            { stream: 'stderr', text: '[WARN] from stderr\n' },
            { stream: 'stdout', text: 'ond line\n' },
            { stream: 'stdout', text: 'no trailing newline' },
          ],
        },
      ]);

      const started = startJob(
        {
          target: targetFor(),
          deployments: ['athenaapp-deployment'],
          skipContainerize: true,
          version: 'stg-20260915T141826-cf2118ba',
        },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      expect(jobs.snapshotLines(started.id).map((line) => line.text)).to.deep.equal([
        'first line',
        '[WARN] from stderr',
        'second line',
        'no trailing newline',
      ]);
    });

    it('fails the job when svctl cannot be executed at all', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([{ spawnError: 'ENOENT' }]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const job = jobs.get(started.id);

      expect(job.status).to.equal('failed');
      expect(jobs.snapshotLines(started.id)[0].text).to.match(/not found in/);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('streaming', () => {
    it('emits line, step, job and end events', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: `${CONTAINERIZE_LOG}\n` },
        { stdout: '[OK] deployed\n' },
      ]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      const seen = { line: [], step: [], job: [], end: [] };

      jobs.subscribe(started.id, {
        line: (payload) => seen.line.push(payload),
        step: (payload) => seen.step.push(payload),
        job: (payload) => seen.job.push(payload),
        end: (payload) => seen.end.push(payload),
      });

      await jobs.wait(started.id);

      expect(seen.line[0]).to.have.keys(['stepIndex', 'text']);
      expect(seen.line.map((line) => line.text)).to.include('[OK] deployed');
      expect(seen.line.some((line) => line.stepIndex === 1)).to.equal(true);
      expect(seen.step[0]).to.have.keys(['stepIndex', 'step']);
      expect(seen.end).to.have.lengthOf(1);
      expect(seen.end[0].status).to.equal('succeeded');
      expect(seen.job.length).to.be.greaterThan(0);
    });

    it('replays buffered lines for a client that connects late', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: `${CONTAINERIZE_LOG}\n` },
        { stdout: 'deploy line\n' },
      ]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const replay = jobs.snapshotLines(started.id);

      expect(replay[0]).to.deep.equal({ stepIndex: 0, text: CONTAINERIZE_LOG.split('\n')[0] });
      expect(replay[replay.length - 1]).to.deep.equal({
        stepIndex: 1,
        text: 'deploy line',
      });
    });

    it('caps a step buffer and reports the dropped lines', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const overflow = jobs.MAX_LINES_PER_STEP + 10;
      const spawner = fakeSpawner([
        {
          stdout: `${Array.from({ length: overflow }, (item, i) => `line ${i}`).join('\n')}\n`,
        },
      ]);

      const started = startJob(
        {
          target: targetFor(),
          deployments: ['athenaapp-deployment'],
          skipContainerize: true,
          version: 'stg-20260915T141826-cf2118ba',
        },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const job = jobs.get(started.id);

      expect(job.steps[0].lineCount).to.equal(jobs.MAX_LINES_PER_STEP);
      expect(job.steps[0].droppedLines).to.equal(10);

      const replay = jobs.snapshotLines(started.id);

      expect(replay[0].text).to.match(/10 earlier line\(s\) dropped/);
      expect(replay[1].text).to.equal('line 10');
    });

    it('never exposes the line buffers in a job payload', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([{ stdout: `${CONTAINERIZE_LOG}\n` }, { stdout: '' }]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      const payload = JSON.stringify(jobs.get(started.id));

      expect(payload).to.not.include('docker push');
      expect(jobs.get(started.id).steps[0]).to.not.have.property('lines');
    });
  });

  /* ---------------------------------------------------------------- */

  describe('cancel', () => {
    it('kills the running child and marks the job cancelled', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([{ stdout: '[INFO] building\n', hang: true }, {}]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      expect(jobs.get(started.id).status).to.equal('running');
      expect(jobs.cancel(started.id)).to.equal(true);

      await jobs.wait(started.id);

      const job = jobs.get(started.id);

      expect(spawner.children[0].signals).to.deep.equal(['SIGTERM']);
      expect(job.status).to.equal('cancelled');
      expect(job.steps[0].status).to.equal('cancelled');
      expect(job.steps[1].status).to.equal('cancelled');
      expect(spawner.calls).to.have.lengthOf(1);
    });

    it('returns false for a job that is already over', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([{ stdout: `${CONTAINERIZE_LOG}\n` }, { stdout: '' }]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      await jobs.wait(started.id);

      expect(jobs.cancel(started.id)).to.equal(false);
    });

    it('returns false for an unknown job', () => {
      expect(jobs.cancel('nope')).to.equal(false);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('one job at a time', () => {
    it('rejects a second run with a 409 while one is running', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([{ hang: true }]);

      const started = startJob(
        { target: targetFor(), deployments: ['athenaapp-deployment'] },
        spawner,
        { workspaceRoot }
      );

      try {
        startJob(
          { target: targetFor(), deployments: ['athenaapp-deployment'] },
          spawner,
          { workspaceRoot }
        );
        throw new Error('expected a 409');
      } catch (err) {
        expect(err.status).to.equal(409);
        expect(err.kind).to.equal('busy');
        expect(err.runningId).to.equal(started.id);
      }

      expect(spawner.calls).to.have.lengthOf(1);

      jobs.cancel(started.id);
      await jobs.wait(started.id);
    });

    it('accepts the next run once the first has finished', async () => {
      const workspaceRoot = makeWorkspace('athena');
      const spawner = fakeSpawner([
        { stdout: `${CONTAINERIZE_LOG}\n` },
        { stdout: '' },
        { stdout: `${CONTAINERIZE_LOG}\n` },
        { stdout: '' },
      ]);
      const request = { target: targetFor(), deployments: ['athenaapp-deployment'] };

      const first = startJob(request, spawner, { workspaceRoot });

      await jobs.wait(first.id);

      const second = startJob(request, spawner, { workspaceRoot });

      await jobs.wait(second.id);

      expect(jobs.get(second.id).status).to.equal('succeeded');
      expect(jobs.list().map((job) => job.id)).to.deep.equal([second.id, first.id]);
    });
  });

  /* ---------------------------------------------------------------- */

  describe('list and get', () => {
    it('returns null for an unknown id', () => {
      expect(jobs.get('nope')).to.equal(null);
    });

    it('starts out empty', () => {
      expect(jobs.list()).to.deep.equal([]);
    });
  });
});
