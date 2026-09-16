'use strict';

const express = require('express');

const kubectl = require('../k8s/kubectl');
const { K8S_NAME, sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

const router = express.Router();

router.post('/spec', sameOrigin, async (req, res) => {
  const deployment = req.body.deployment;
  const container = req.body.container;
  const resources = { requests: req.body.requests, limits: req.body.limits };

  if (!K8S_NAME.test(String(deployment || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid deployment name: ${deployment}` },
    });
  }

  // A container is optional; without one kubectl applies the change to every
  // container in the pod template.
  if (container && !K8S_NAME.test(String(container))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid container name: ${container}` },
    });
  }

  const flags = kubectl.buildResourceFlags(resources);

  if (flags.error) {
    return res.status(400).json({ error: flags.error });
  }

  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  try {
    const result = await kubectl.setResources(target, deployment, resources, container);

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
