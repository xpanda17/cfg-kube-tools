'use strict';

const express = require('express');

/**
 * One file per endpoint. The router is mounted under `/api` by the server, so
 * the paths declared inside each file are relative to that prefix.
 */
const routes = [
  require('./health'),
  require('./services'),
  require('./pods'),
  require('./restart'),
  require('./scale'),
  require('./spec'),
  require('./job'),
  require('./cronjobs'),
  require('./portforward-list'),
  require('./portforward-start'),
  require('./portforward-stop'),
];

const router = express.Router();

routes.forEach((route) => router.use(route));

module.exports = router;
