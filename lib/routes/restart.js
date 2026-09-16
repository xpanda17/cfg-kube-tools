'use strict';

const express = require('express');

const kubectl = require('../k8s/kubectl');
const { K8S_NAME, sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

const router = express.Router();

router.post('/restart', sameOrigin, async (req, res) => {
  const deployment = req.body.deployment;

  if (!K8S_NAME.test(String(deployment || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid deployment name: ${deployment}` },
    });
  }

  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  try {
    const result = await kubectl.rolloutRestart(target, deployment);

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
