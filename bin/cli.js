#!/usr/bin/env node
'use strict';

const { start } = require('../lib/server');
const portforward = require('../lib/k8s/portforward');
const jobs = require('../lib/jobs');

const DEFAULT_PORT = 14777;

function parsePort(argv) {
  const index = argv.indexOf('--port');

  if (index === -1) {
    return DEFAULT_PORT;
  }

  const port = Number(argv[index + 1]);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${argv[index + 1]}`);
  }

  return port;
}

async function main() {
  const port = parsePort(process.argv.slice(2));
  const server = start({ port });

  await server;

  console.log(`kube-tools listening on http://127.0.0.1:${port}`);
  console.log('Press Ctrl+C to stop.');

  // Port forwards and pipeline runs are child processes; leaving them behind
  // would hold ports open, or keep an svctl build attached to a dead server.
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
      portforward.stopAll();
      jobs.stopAll();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
