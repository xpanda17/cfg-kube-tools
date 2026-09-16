'use strict';

const express = require('express');

const jobs = require('../jobs');

const router = express.Router();

// Newest first, and without the line buffers — those are the SSE stream.
router.get('/jobs', (req, res) => {
  res.json({ jobs: jobs.list() });
});

module.exports = router;
