'use strict';

const express = require('express');

const portforward = require('../k8s/portforward');
const { sameOrigin } = require('../core/http');

const router = express.Router();

router.post('/portforward/stop', sameOrigin, (req, res) => {
  const stopped = portforward.stop(String(req.body.id || ''));

  res.json({ stopped, sessions: portforward.list() });
});

module.exports = router;
