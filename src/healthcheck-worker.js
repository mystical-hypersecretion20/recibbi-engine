'use strict';

// Container healthcheck for the worker service.
//
// The worker serves no HTTP, so we verify the dependency it actually needs: a
// reachable Redis (the BullMQ broker). Exits 0 if Redis answers PING with PONG
// within the timeout, 1 otherwise. Standalone script (no shell metacharacters)
// for the same reason as healthcheck.js.

const { createConnection } = require('./redis');

const conn = createConnection();

let settled = false;
function finish(code) {
  if (settled) return;
  settled = true;
  // Best-effort close; don't let a hung disconnect keep the process alive.
  try { conn.disconnect(); } catch (_) { /* ignore */ }
  process.exit(code);
}

const timer = setTimeout(() => finish(1), 4000);
timer.unref();

conn
  .ping()
  .then((reply) => finish(reply === 'PONG' ? 0 : 1))
  .catch(() => finish(1));
