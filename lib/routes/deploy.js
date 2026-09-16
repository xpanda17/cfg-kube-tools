'use strict';

const express = require('express');

const jobs = require('../jobs');
const { sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

const router = express.Router();

/**
 * Starts a containerize → fan-out kube-deploy run and returns immediately; the
 * output is read back from GET /api/jobs/:id/stream.
 *
 * Body: { service, env, build?, deployments: [...], skipContainerize?, version? }
 * `version` is only accepted together with `skipContainerize`, because that is
 * the one case where no containerize step will produce one.
 */
router.post('/deploy', sameOrigin, (req, res) => {
  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  try {
    const job = jobs.start({
      target,
      build: req.body.build,
      deployments: req.body.deployments,
      skipContainerize: req.body.skipContainerize,
      version: req.body.version,
    });

    return res.status(202).json({ id: job.id, job });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: {
        kind: err.kind || 'unknown',
        message: err.message,
        runningId: err.runningId || null,
      },
    });
  }
});

module.exports = router;
