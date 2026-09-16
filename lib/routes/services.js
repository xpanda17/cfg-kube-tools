'use strict';

const express = require('express');

const registry = require('../registry');

const router = express.Router();

// Re-read on every request so editing services.yaml takes effect without a
// restart. The file is small enough that this is not worth caching.
router.get('/services', (req, res) => {
  try {
    res.json({ services: registry.toMenu(registry.load()) });
  } catch (err) {
    res.status(500).json({ error: { kind: 'registry', message: err.message } });
  }
});

module.exports = router;
