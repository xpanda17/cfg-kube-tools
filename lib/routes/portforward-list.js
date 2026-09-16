'use strict';

const express = require('express');

const portforward = require('../k8s/portforward');

const router = express.Router();

router.get('/portforward', (req, res) => {
  res.json({ sessions: portforward.list() });
});

module.exports = router;
