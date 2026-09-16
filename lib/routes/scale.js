'use strict';

const express = require('express');

const kubectl = require('../k8s/kubectl');
const { K8S_NAME, sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

const MAX_REPLICAS = 50;

const router = express.Router();

router.post('/scale', sameOrigin, async (req, res) => {
  const deployment = req.body.deployment;
  const replicas = Number(req.body.replicas);

  if (!K8S_NAME.test(String(deployment || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid deployment name: ${deployment}` },
    });
  }

  // An upper bound keeps a typo from asking the cluster for hundreds of pods.
  if (!Number.isInteger(replicas) || replicas < 0 || replicas > MAX_REPLICAS) {
    return res.status(400).json({
      error: {
        kind: 'invalid',
        message: `Replicas must be a whole number between 0 and ${MAX_REPLICAS}.`,
      },
    });
  }

  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  try {
    const autoscalers = await kubectl.getScaledObjects(target);
    const result = await kubectl.scaleDeployment(
      target,
      deployment,
      replicas,
      autoscalers[deployment]
    );

    if (result.error) {
      return res.status(502).json({ error: result.error, steps: result.steps || [] });
    }

    return res.json({ steps: result.steps });
  } catch (err) {
    return res.status(502).json({
      error: { kind: err.kind || 'unknown', message: err.message },
    });
  }
});

module.exports = router;
