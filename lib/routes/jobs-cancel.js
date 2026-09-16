'use strict';

const express = require('express');

const jobs = require('../jobs');
const { sameOrigin } = require('../core/http');

const router = express.Router();

router.post('/jobs/:id/cancel', sameOrigin, (req, res) => {
  res.json({ cancelled: jobs.cancel(req.params.id), job: jobs.get(req.params.id) });
});

module.exports = router;
