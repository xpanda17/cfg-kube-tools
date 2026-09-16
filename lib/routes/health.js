'use strict';

const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    node: process.version,
    uptime: Math.round(process.uptime()),
  });
});

module.exports = router;
