#!/usr/bin/env node
'use strict';

const { start } = require('../lib/server');
const portforward = require('../lib/k8s/portforward');

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

  // Port forwards are child processes; leaving them behind would hold ports
  // open after the server is gone.
  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.on(signal, () => {
      portforward.stopAll();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
