'use strict';

const express = require('express');

const kubectl = require('../k8s/kubectl');
const registry = require('../registry');

const router = express.Router();

router.get('/cronjobs', async (req, res) => {
  let target;

  try {
    target = registry.resolve(registry.load(), req.query.service, req.query.env);
  } catch (err) {
    return res
      .status(err.status || 500)
      .json({ error: { kind: 'registry', message: err.message } });
  }

  try {
    const result = await kubectl.getCronJobs(target);

    if (result.error) {
      return res.status(502).json({ error: result.error, target });
    }

    return res.json({ cronjobs: result.cronjobs });
  } catch (err) {
    const message =
      err.kind === 'timeout'
        ? `kubectl did not respond within ${target.timeoutSeconds}s. ` +
          'Raise timeoutSeconds in services.yaml, or check your VPN.'
        : err.message;

    return res.status(502).json({
      error: { kind: err.kind || 'unknown', message, raw: '' },
      target,
    });
  }
});

module.exports = router;
