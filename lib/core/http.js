'use strict';

// Kubernetes object names, per DNS-1123. Anchored and dash-free at the start so
// a value can never be read by kubectl as a flag.
const K8S_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/**
 * Rejects cross-origin writes. The server listens on loopback, but any page in
 * the browser can still reach it, so a mutating request must prove it came from
 * this app rather than from some other site the user happens to have open.
 */
function sameOrigin(req, res, next) {
  const origin = req.get('origin');

  if (!origin) {
    return next();
  }

  let host;

  try {
    host = new URL(origin).hostname;
  } catch (err) {
    return res.status(403).json({
      error: { kind: 'forbidden', message: 'Malformed Origin header.' },
    });
  }

  if (host !== '127.0.0.1' && host !== 'localhost') {
    return res.status(403).json({
      error: { kind: 'forbidden', message: 'Cross-origin requests are not allowed.' },
    });
  }

  return next();
}

module.exports = { K8S_NAME, sameOrigin };
