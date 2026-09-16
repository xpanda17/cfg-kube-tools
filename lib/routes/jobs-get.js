'use strict';

const express = require('express');

const jobs = require('../jobs');

const router = express.Router();

router.get('/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res
      .status(404)
      .json({ error: { kind: 'not-found', message: `No such job: ${req.params.id}` } });
  }

  return res.json({ job });
});

module.exports = router;
