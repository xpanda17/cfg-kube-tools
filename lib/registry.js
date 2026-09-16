'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REGISTRY_PATH = path.join(__dirname, '..', 'services.yaml');

// kubectl reads anything starting with "-" as a flag, so a malformed registry
// entry must never reach the argument array.
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const DEFAULT_TIMEOUT_SECONDS = 60;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;

/**
 * Reads a timeout override, falling back to the value inherited from the level
 * above it.
 *
 * @param {*} value
 * @param {number} fallback
 * @param {string} where
 * @returns {number}
 */
function readTimeout(value, fallback, where) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < MIN_TIMEOUT_SECONDS ||
    value > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `services.yaml: timeoutSeconds in ${where} must be a number between ` +
        `${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS}: ${value}`
    );
  }

  return value;
}

function assertSafe(value, field, where) {
  if (typeof value !== 'string' || !SAFE_VALUE.test(value)) {
    throw new Error(`services.yaml: invalid ${field} in ${where}: ${value}`);
  }
}

/**
 * Reads and validates services.yaml.
 *
 * @param {string} [file]
 * @returns {{ services: Array<Object> }}
 */
function load(file) {
  const target = file || REGISTRY_PATH;
  const doc = yaml.load(fs.readFileSync(target, 'utf8')) || {};
  const services = doc.services;

  if (!Array.isArray(services) || services.length === 0) {
    throw new Error('services.yaml: expected a non-empty "services" list');
  }

  const rootTimeout = readTimeout(
    doc.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
    'the top level'
  );

  services.forEach((service) => {
    assertSafe(service.name, 'service name', 'services');

    if (!Array.isArray(service.envs) || service.envs.length === 0) {
      throw new Error(`services.yaml: service "${service.name}" has no envs`);
    }

    const serviceTimeout = readTimeout(
      service.timeoutSeconds,
      rootTimeout,
      service.name
    );

    service.envs.forEach((env) => {
      const where = `${service.name}`;

      assertSafe(env.name, 'env name', where);
      assertSafe(env.context, 'context', `${where}/${env.name}`);
      assertSafe(env.namespace, 'namespace', `${where}/${env.name}`);

      env.timeoutSeconds = readTimeout(
        env.timeoutSeconds,
        serviceTimeout,
        `${where}/${env.name}`
      );
    });
  });

  return { services, timeoutSeconds: rootTimeout };
}

/**
 * Resolves a (service, env) pair to its cluster target.
 *
 * @param {Object} registry
 * @param {string} serviceName
 * @param {string} envName
 * @returns {{ context: string, namespace: string }}
 */
function resolve(registry, serviceName, envName) {
  const service = registry.services.find((item) => item.name === serviceName);

  if (!service) {
    throw Object.assign(new Error(`Unknown service: ${serviceName}`), {
      status: 400,
    });
  }

  const env = service.envs.find((item) => item.name === envName);

  if (!env) {
    throw Object.assign(
      new Error(`Unknown env "${envName}" for service "${serviceName}"`),
      { status: 400 }
    );
  }

  return {
    context: env.context,
    namespace: env.namespace,
    timeoutSeconds: env.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
  };
}

/**
 * Shapes the registry for the UI dropdowns, dropping cluster internals.
 *
 * @param {Object} registry
 * @returns {Array<Object>}
 */
function toMenu(registry) {
  return registry.services.map((service) => ({
    name: service.name,
    label: service.label || service.name,
    envs: service.envs.map((env) => ({
      name: env.name,
      label: env.label || env.name,
    })),
  }));
}

/**
 * Resolves the cluster target for a request body, or sends the error itself.
 *
 * @returns {Object|null} the target, or null when a response was already sent
 */
function resolveTarget(req, res) {
  try {
    return resolve(load(), req.body.service, req.body.env);
  } catch (err) {
    res
      .status(err.status || 500)
      .json({ error: { kind: 'registry', message: err.message } });
    return null;
  }
}

module.exports = {
  load,
  resolve,
  resolveTarget,
  toMenu,
  REGISTRY_PATH,
  DEFAULT_TIMEOUT_SECONDS,
};
