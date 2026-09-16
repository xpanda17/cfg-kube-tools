'use strict';

const express = require('express');

const kubectl = require('../k8s/kubectl');
const { K8S_NAME, sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

const router = express.Router();

router.post('/cronjob/suspend', sameOrigin, async (req, res) => {
  const cronjob = req.body.cronjob;
  const suspend = req.body.suspend;
  const includeActiveJobs = req.body.includeActiveJobs;

  if (!K8S_NAME.test(String(cronjob || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid cronjob name: ${cronjob}` },
    });
  }

  // Not coerced: the string "false" is truthy, and getting this one wrong does
  // the exact opposite of what was asked for.
  if (typeof suspend !== 'boolean') {
    return res.status(400).json({
      error: { kind: 'invalid', message: 'suspend must be true or false.' },
    });
  }

  if (includeActiveJobs !== undefined && typeof includeActiveJobs !== 'boolean') {
    return res.status(400).json({
      error: { kind: 'invalid', message: 'includeActiveJobs must be true or false.' },
    });
  }

  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  try {
    const result = await kubectl.setCronJobSuspend(
      target,
      cronjob,
      suspend,
      includeActiveJobs === true
    );

    if (result.error) {
      return res.status(502).json({ error: result.error, steps: result.steps || [] });
    }

    return res.json({ steps: result.steps });
  } catch (err) {
    return res.status(502).json({
      error: { kind: err.kind || 'unknown', message: err.message },
      steps: [],
    });
  }
});

module.exports = router;
