'use strict';

const express = require('express');

const portforward = require('../k8s/portforward');
const { K8S_NAME, sameOrigin } = require('../core/http');
const { resolveTarget } = require('../registry');

const router = express.Router();

router.post('/portforward', sameOrigin, async (req, res) => {
  const pod = req.body.pod;
  const port = Number(req.body.port);

  if (!K8S_NAME.test(String(pod || ''))) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid pod name: ${pod}` },
    });
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({
      error: { kind: 'invalid', message: `Invalid port: ${req.body.port}` },
    });
  }

  const target = resolveTarget(req, res);

  if (!target) {
    return undefined;
  }

  const session = await portforward.start(target, pod, port);

  if (session.status === 'failed') {
    return res.status(502).json({
      error: { kind: 'portforward', message: session.error || 'Port forward failed.' },
      session,
    });
  }

  return res.json({ session });
});

module.exports = router;
