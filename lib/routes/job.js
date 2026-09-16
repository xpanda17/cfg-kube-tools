'use strict';

const express = require('express');

const kubectl = require('../k8s/kubectl');
const { K8S_NAME, sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

// Kubernetes rejects a longer object name, and it does so only after the round
// trip, so the check is worth making here.
const MAX_NAME_LENGTH = 63;

const router = express.Router();

router.post('/job', sameOrigin, async (req, res) => {
  const cronjob = req.body.cronjob;
  const name = req.body.name;

  if (!K8S_NAME.test(String(cronjob || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid cronjob name: ${cronjob}` },
    });
  }

  if (!K8S_NAME.test(String(name || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid job name: ${name}` },
    });
  }

  if (String(name).length > MAX_NAME_LENGTH) {
    return res.status(400).json({
      error: {
        kind: 'invalid',
        message: `Job name must be ${MAX_NAME_LENGTH} characters or fewer.`,
      },
    });
  }

  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  try {
    const result = await kubectl.createJobFromCronJob(target, cronjob, name);

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
