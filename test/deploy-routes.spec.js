'use strict';

const express = require('express');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

/**
 * Mounts one route file with a stubbed jobs module. Nothing here can reach
 * svctl: the job engine is replaced wholesale.
 */
function mount(file, stub) {
  const app = express();

  app.use(express.json());
  app.use('/api', proxyquire(file, { '../jobs': stub }));

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function urlFor(server, pathname) {
  return `http://127.0.0.1:${server.address().port}${pathname}`;
}

function post(server, pathname, body) {
  return fetch(urlFor(server, pathname), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

/** Parses an SSE body into [{ event, data }]. */
function parseEvents(text) {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => {
      const lines = block.split('\n');

      return {
        event: lines[0].replace('event: ', ''),
        data: JSON.parse(lines[1].replace('data: ', '')),
      };
    });
}

const JOB = {
  id: 'job-1',
  status: 'succeeded',
  build: 'athena',
  env: 'stg',
  deployments: ['athenaapp-deployment'],
  version: 'stg-20260915T141826-cf2118ba',
  createdAt: '2026-09-16T00:00:00.000Z',
  finishedAt: '2026-09-16T00:05:00.000Z',
  steps: [],
};

describe('deploy routes', () => {
  describe('POST /api/deploy', () => {
    let server;

    afterEach(() => server && server.close());

    it('starts a run and answers 202 with the job id', async () => {
      const seen = [];

      server = await mount('../lib/routes/deploy', {
        start: (request) => {
          seen.push(request);
          return JOB;
        },
      });

      const res = await post(server, '/api/deploy', {
        service: 'athenaapp',
        env: 'stg',
        build: 'athena',
        deployments: ['athenaapp-deployment'],
      });

      expect(res.status).to.equal(202);
      expect((await res.json()).id).to.equal('job-1');

      // env and the repo come from the registry, not from the body.
      expect(seen[0].target.namespace).to.equal('cermati-indodana-athena-stg');
      expect(seen[0].target.repo).to.equal('athena');
      expect(seen[0].deployments).to.deep.equal(['athenaapp-deployment']);
    });

    it('answers 409 when a run is already in flight', async () => {
      server = await mount('../lib/routes/deploy', {
        start: () => {
          throw Object.assign(new Error('A deploy is already running.'), {
            kind: 'busy',
            status: 409,
            runningId: 'job-0',
          });
        },
      });

      const res = await post(server, '/api/deploy', {
        service: 'athenaapp',
        env: 'stg',
        deployments: ['athenaapp-deployment'],
      });
      const body = await res.json();

      expect(res.status).to.equal(409);
      expect(body.error.kind).to.equal('busy');
      expect(body.error.runningId).to.equal('job-0');
    });

    it('answers 400 when validation rejects the request', async () => {
      server = await mount('../lib/routes/deploy', {
        start: () => {
          throw Object.assign(new Error('Invalid deployment name: -rf'), {
            kind: 'invalid',
            status: 400,
          });
        },
      });

      const res = await post(server, '/api/deploy', {
        service: 'athenaapp',
        env: 'stg',
        deployments: ['-rf'],
      });

      expect(res.status).to.equal(400);
      expect((await res.json()).error.message).to.match(/Invalid deployment name/);
    });

    it('rejects an unknown env before the job engine is touched', async () => {
      let started = false;

      server = await mount('../lib/routes/deploy', {
        start: () => {
          started = true;
          return JOB;
        },
      });

      const res = await post(server, '/api/deploy', {
        service: 'athenaapp',
        env: 'prod',
        deployments: ['athenaapp-deployment'],
      });

      expect(res.status).to.equal(400);
      expect(started).to.equal(false);
    });

    it('rejects a cross-origin POST', async () => {
      server = await mount('../lib/routes/deploy', { start: () => JOB });

      const res = await fetch(urlFor(server, '/api/deploy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ service: 'athenaapp', env: 'stg', deployments: ['a'] }),
      });

      expect(res.status).to.equal(403);
    });
  });

  describe('GET /api/jobs', () => {
    let server;

    afterEach(() => server && server.close());

    it('lists jobs without their line buffers', async () => {
      server = await mount('../lib/routes/jobs-list', { list: () => [JOB] });

      const body = await (await fetch(urlFor(server, '/api/jobs'))).json();

      expect(body.jobs).to.have.lengthOf(1);
      expect(body.jobs[0].id).to.equal('job-1');
    });
  });

  describe('GET /api/jobs/:id', () => {
    let server;

    afterEach(() => server && server.close());

    it('returns the job', async () => {
      server = await mount('../lib/routes/jobs-get', { get: (id) => (id === 'job-1' ? JOB : null) });

      const body = await (await fetch(urlFor(server, '/api/jobs/job-1'))).json();

      expect(body.job.version).to.equal('stg-20260915T141826-cf2118ba');
    });

    it('404s an unknown job', async () => {
      server = await mount('../lib/routes/jobs-get', { get: () => null });

      expect((await fetch(urlFor(server, '/api/jobs/nope'))).status).to.equal(404);
    });
  });

  describe('POST /api/jobs/:id/cancel', () => {
    let server;

    afterEach(() => server && server.close());

    it('reports whether a running job was cancelled', async () => {
      const cancelled = [];

      server = await mount('../lib/routes/jobs-cancel', {
        cancel: (id) => {
          cancelled.push(id);
          return true;
        },
        get: () => JOB,
      });

      const body = await (await post(server, '/api/jobs/job-1/cancel')).json();

      expect(cancelled).to.deep.equal(['job-1']);
      expect(body.cancelled).to.equal(true);
    });
  });

  describe('GET /api/jobs/:id/stream', () => {
    let server;

    afterEach(() => server && server.close());

    it('replays the buffer then ends when the job is already over', async () => {
      server = await mount('../lib/routes/jobs-stream', {
        get: () => JOB,
        snapshotLines: () => [
          { stepIndex: 0, text: '[INFO] queued' },
          { stepIndex: 1, text: '[OK] deployed' },
        ],
        subscribe: () => () => {},
      });

      const res = await fetch(urlFor(server, '/api/jobs/job-1/stream'));
      const events = parseEvents(await res.text());

      expect(res.headers.get('content-type')).to.match(/^text\/event-stream/);
      expect(res.headers.get('cache-control')).to.equal('no-cache');
      expect(events.map((item) => item.event)).to.deep.equal([
        'job',
        'line',
        'line',
        'end',
      ]);
      expect(events[0].data.job.id).to.equal('job-1');
      expect(events[1].data).to.deep.equal({ stepIndex: 0, text: '[INFO] queued' });
    });

    it('live-tails a running job and closes on end', async () => {
      let handlers = null;
      let unsubscribed = false;

      server = await mount('../lib/routes/jobs-stream', {
        get: () => Object.assign({}, JOB, { status: 'running' }),
        snapshotLines: () => [{ stepIndex: 0, text: 'replayed' }],
        subscribe: (id, given) => {
          handlers = given;
          return () => {
            unsubscribed = true;
          };
        },
      });

      const res = await fetch(urlFor(server, '/api/jobs/job-1/stream'));

      handlers.line({ stepIndex: 0, text: 'live line' });
      handlers.step({ stepIndex: 0, step: { name: 'containerize', status: 'succeeded' } });
      handlers.job(Object.assign({}, JOB, { version: 'stg-20260915T141826-cf2118ba' }));
      handlers.end(JOB);

      const events = parseEvents(await res.text());

      expect(events.map((item) => item.event)).to.deep.equal([
        'job',
        'line',
        'line',
        'step',
        'job',
        'end',
      ]);
      expect(events[1].data.text).to.equal('replayed');
      expect(events[2].data.text).to.equal('live line');
      expect(events[3].data.step.name).to.equal('containerize');
      expect(unsubscribed).to.equal(true);
    });

    it('404s an unknown job', async () => {
      server = await mount('../lib/routes/jobs-stream', { get: () => null });

      expect((await fetch(urlFor(server, '/api/jobs/nope/stream'))).status).to.equal(404);
    });
  });
});
