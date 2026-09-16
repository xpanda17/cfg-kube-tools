'use strict';

const path = require('path');
const express = require('express');

const routes = require('./routes');
const portforward = require('./k8s/portforward');
const jobs = require('./jobs');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Builds the express app. Kept separate from the listener so tests can mount it
 * without binding a port.
 *
 * @returns {import('express').Express}
 */
function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(PUBLIC_DIR));
  app.use('/api', routes);

  return app;
}

/**
 * Starts the server on the loopback interface only. This app executes commands
 * against live clusters, so it must never be reachable from the network.
 *
 * @param {Object} options
 * @param {number} options.port
 * @param {string} [options.host]
 * @returns {Promise<import('http').Server>}
 */
function start(options) {
  const host = options.host || '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = createApp().listen(options.port, host);

    server.once('listening', () => resolve(server));
    server.once('error', reject);
    server.once('close', () => {
      portforward.stopAll();
      jobs.stopAll();
    });
  });
}

module.exports = { createApp, start };
