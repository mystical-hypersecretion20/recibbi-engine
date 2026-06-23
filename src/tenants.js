'use strict';

// Tenant registry. Tenants are real, explicitly-provisioned accounts: the API
// rejects an upload for an unknown tenant (mirroring the "unknown profile" 400).
//
// TWO layers, by design:
//   - DURABLE: the provisioned-tenant list is persisted through the pluggable
//     persistence layer (kind='tenants'), so it SURVIVES a Redis recycle.
//   - RUNTIME: a single Redis SET (`re:tenants`) is the cross-process working
//     copy — the WORKER watches it to spin up one BullMQ Worker per tenant queue
//     (`receipts-<tenant>`) as tenants are onboarded. At startup `hydrate()`
//     loads the durable list back into the Redis SET so a recycled Redis is
//     repopulated from the source of truth.
//
// The configured default tenant is ALWAYS allowed (and registered at boot) even
// if Redis is down, so a single-tenant deployment and the test suite work
// without provisioning anything. Best-effort: a Redis or persistence error
// degrades (the default stays usable) but never throws to a caller.

const config = require('./config');
const logger = require('./logger');
const { cache } = require('./redis');
const { isValidSegment } = require('./identity');
const persistence = require('./persistence');

const SET_KEY = 're:tenants';

function keyFor(tenantId) {
  return { kind: 'tenants', tenant: tenantId, id: tenantId };
}

/** Register (idempotently create) a tenant account: durable + Redis working copy. */
async function register(tenantId) {
  if (!isValidSegment(tenantId)) throw new Error(`invalid tenant id "${tenantId}"`);
  try {
    // Durable record first so a Redis hiccup can't lose a provisioned tenant.
    if (!(await persistence.get(keyFor(tenantId)))) {
      await persistence.put(keyFor(tenantId), { tenantId, createdAt: new Date().toISOString() });
    }
  } catch (err) {
    logger.warn({ err: err.message, tenantId }, 'tenant persist failed');
  }
  try {
    await cache().sadd(SET_KEY, tenantId);
  } catch (err) {
    logger.warn({ err: err.message, tenantId }, 'tenant register failed');
  }
  return tenantId;
}

/** All registered tenants, sorted. The default tenant is always included. */
async function list() {
  let members = [];
  try {
    members = await cache().smembers(SET_KEY);
  } catch (err) {
    logger.warn({ err: err.message }, 'tenant list failed');
  }
  const set = new Set(members || []);
  if (isValidSegment(config.defaultTenantId)) set.add(config.defaultTenantId);
  return [...set].sort();
}

/** Whether a tenant has been provisioned (or is the always-allowed default). */
async function isAllowed(tenantId) {
  if (!isValidSegment(tenantId)) return false;
  if (tenantId === config.defaultTenantId) return true;
  try {
    return (await cache().sismember(SET_KEY, tenantId)) === 1;
  } catch (err) {
    logger.warn({ err: err.message, tenantId }, 'tenant lookup failed');
    return false;
  }
}

/** Remove a tenant from the registry (does not delete its data). */
async function remove(tenantId) {
  try {
    await persistence.delete(keyFor(tenantId));
  } catch (err) {
    logger.warn({ err: err.message, tenantId }, 'tenant persist-remove failed');
  }
  try {
    return (await cache().srem(SET_KEY, tenantId)) === 1;
  } catch (err) {
    logger.warn({ err: err.message, tenantId }, 'tenant remove failed');
    return false;
  }
}

/**
 * Load the durable tenant list into the Redis SET. Called at server/worker
 * startup so a recycled (empty) Redis is repopulated from the persisted source
 * of truth and the worker's queue watch sees every provisioned tenant. Returns
 * the number of tenants hydrated. Best-effort: never throws.
 */
async function hydrate() {
  let restored = 0;
  try {
    const docs = await persistence.list({ kind: 'tenants' });
    for (const d of docs) {
      if (d && isValidSegment(d.tenantId)) {
        try {
          await cache().sadd(SET_KEY, d.tenantId);
          restored += 1;
        } catch {
          /* Redis down — degrade */
        }
      }
    }
    if (restored) logger.info({ restored }, 'hydrated tenant registry from persistence');
  } catch (err) {
    logger.warn({ err: err.message }, 'tenant hydrate failed');
  }
  return restored;
}

/** Register the configured default tenant (called at server/worker startup). */
async function ensureDefault() {
  if (isValidSegment(config.defaultTenantId)) await register(config.defaultTenantId);
}

module.exports = { register, list, isAllowed, remove, hydrate, ensureDefault, SET_KEY };
