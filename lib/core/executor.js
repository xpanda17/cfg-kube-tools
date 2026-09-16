'use strict';

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Runs a binary and captures its output.
 *
 * This is the only place in the app that spawns a process. Arguments are always
 * passed as an array so no shell is involved and nothing can be interpolated
 * into a command string.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {Object} [options]
 * @param {number} [options.timeout]
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
function run(bin, args, options) {
  const opts = options || {};

  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) {
          return resolve({ stdout, stderr, code: 0 });
        }

        if (err.code === 'ENOENT') {
          return reject(
            Object.assign(new Error(`${bin} not found on PATH`), {
              kind: 'missing-binary',
            })
          );
        }

        if (err.killed) {
          return reject(
            Object.assign(new Error(`${bin} timed out`), { kind: 'timeout' })
          );
        }

        // Non-zero exit is a normal outcome here (no such namespace, expired
        // credentials, ...). Hand it back so the caller can classify stderr.
        resolve({ stdout, stderr, code: typeof err.code === 'number' ? err.code : 1 });
      }
    );
  });
}

module.exports = { run };
