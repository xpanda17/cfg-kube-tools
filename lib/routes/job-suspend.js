'use strict';

const express = require('express');

const kubectl = require('../k8s/kubectl');
const { K8S_NAME, sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

const router = express.Router();

router.post('/job/suspend', sameOrigin, async (req, res) => {
  const job = req.body.job;
  const suspend = req.body.suspend;

  if (!K8S_NAME.test(String(job || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid job name: ${job}` },
    });
  }

  // Not coerced: the string "false" is truthy, and getting this one wrong does
  // the exact opposite of what was asked for.
  if (typeof suspend !== 'boolean') {
    return res.status(400).json({
      error: { kind: 'invalid', message: 'suspend must be true or false.' },
    });
  }

  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  try {
    const result = await kubectl.setJobSuspend(target, job, suspend);

    if (result.error) {
      return res.status(502).json({ error: result.error });
    }

    return res.json({ message: result.message });
  } catch (err) {
    return res.status(502).json({
      error: { kind: err.kind || 'unknown', message: err.message },
    });
  }
});

module.exports = router;
