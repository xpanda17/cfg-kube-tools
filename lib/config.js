'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_FILE = '.kube-tools.yaml';
const EXAMPLE_FILE = '.kube-tools.example.yaml';
const CONFIG_PATH = path.join(__dirname, '..', CONFIG_FILE);

// This file is machine-specific (everyone checks the repos out somewhere else),
// so it is gitignored and there is deliberately no default: guessing a
// workspace root would mean running svctl from the wrong directory, which
// DESIGN.md §5 records as the cause of the stray binaries under cli/.
const MISSING =
  `Missing ${CONFIG_FILE}. Copy ${EXAMPLE_FILE} to ${CONFIG_FILE} in the ` +
  'repo root and set workspaceRoot to the directory your service repos are ' +
  'checked out in (the parent of the repo that holds cli/svctl).';

/**
 * Expands a leading `~`. Only a leading one: `~` anywhere else is a legal
 * character in a directory name.
 *
 * @param {string} value
 * @returns {string}
 */
function expandHome(value) {
  if (value === '~') {
    return os.homedir();
  }

  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

/**
 * Reads the machine-local config.
 *
 * @param {string} [file] override, for tests
 * @returns {{ workspaceRoot: string, versionPattern: (string|null) }}
 */
function load(file) {
  const target = file || CONFIG_PATH;

  let raw;

  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw Object.assign(new Error(MISSING), { kind: 'config', status: 500 });
    }

    throw err;
  }

  const doc = yaml.load(raw) || {};

  if (typeof doc.workspaceRoot !== 'string' || !doc.workspaceRoot.trim()) {
    throw Object.assign(
      new Error(`${CONFIG_FILE}: workspaceRoot is required. ${MISSING}`),
      { kind: 'config', status: 500 }
    );
  }

  const workspaceRoot = path.normalize(expandHome(doc.workspaceRoot.trim()));

  if (!path.isAbsolute(workspaceRoot)) {
    throw Object.assign(
      new Error(
        `${CONFIG_FILE}: workspaceRoot must be an absolute path (or start ` +
          `with ~): ${doc.workspaceRoot}`
      ),
      { kind: 'config', status: 500 }
    );
  }

  return {
    workspaceRoot,
    versionPattern: readVersionPattern(doc.versionPattern),
  };
}

/**
 * @param {*} value
 * @returns {string|null}
 */
function readVersionPattern(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string') {
    throw Object.assign(
      new Error(`${CONFIG_FILE}: versionPattern must be a string`),
      { kind: 'config', status: 500 }
    );
  }

  try {
    new RegExp(value);
  } catch (err) {
    throw Object.assign(
      new Error(`${CONFIG_FILE}: versionPattern is not a valid regex: ${err.message}`),
      { kind: 'config', status: 500 }
    );
  }

  return value;
}

/**
 * The working directory svctl must be run from.
 *
 * @param {string} workspaceRoot
 * @param {string} repo
 * @returns {string}
 */
function repoDir(workspaceRoot, repo) {
  return path.join(workspaceRoot, repo);
}

module.exports = { load, repoDir, CONFIG_PATH, CONFIG_FILE, EXAMPLE_FILE, MISSING };
