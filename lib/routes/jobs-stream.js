'use strict';

const express = require('express');

const jobs = require('../jobs');

const HEARTBEAT_MS = 15000;

const router = express.Router();

function send(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Server-sent events for one run: replay everything captured so far, then
 * live-tail (DESIGN.md §7.3).
 *
 * Replay-then-tail is what makes a run fire-and-forget — the job lives on the
 * server, so closing the tab or reloading the page loses nothing.
 */
router.get('/jobs/:id/stream', (req, res) => {
  const id = req.params.id;
  const job = jobs.get(id);

  if (!job) {
    return res
      .status(404)
      .json({ error: { kind: 'not-found', message: `No such job: ${id}` } });
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Any reverse proxy in front of this must not sit on the stream.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let closed = false;
  let heartbeat = null;
  let unsubscribe = null;

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;

    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const finish = (payload) => {
    if (closed) {
      return;
    }

    send(res, 'end', payload || jobs.get(id));
    cleanup();
    res.end();
  };

  // Snapshot and subscribe in the same tick: no line can be emitted between the
  // two, so the client sees every line exactly once and in order.
  const replay = jobs.snapshotLines(id);

  unsubscribe = jobs.subscribe(id, {
    line: (payload) => {
      if (!closed) {
        send(res, 'line', payload);
      }
    },
    step: (payload) => {
      if (!closed) {
        send(res, 'step', payload);
      }
    },
    job: (payload) => {
      if (!closed) {
        send(res, 'job', { job: payload });
      }
    },
    end: (payload) => finish({ job: payload }),
  });

  send(res, 'job', { job });
  replay.forEach((line) => send(res, 'line', line));

  // A comment line keeps proxies and idle-socket timeouts from dropping a
  // stream that is quiet while Jenkins thinks.
  heartbeat = setInterval(() => {
    if (!closed) {
      res.write(': ping\n\n');
    }
  }, HEARTBEAT_MS);

  if (heartbeat.unref) {
    heartbeat.unref();
  }

  req.on('close', cleanup);

  // Already over by the time the client connected: replay, then close rather
  // than leaving an EventSource open on a dead job.
  if (job.status !== 'running') {
    finish({ job: jobs.get(id) });
  }

  return undefined;
});

module.exports = router;
