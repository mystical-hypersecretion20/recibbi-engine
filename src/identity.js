'use strict';

// Multi-tenancy identity + key/path scheme — the single place the composite-id
// format lives, so the scheme is one edit away from changing.
//
// Identity is a (tenantId, userId) pair. A resource's public, API-facing id is
// the COMPOSITE id `<tenantId>:<userId>:<cacheId>` (e.g. `main:main:ab12cd34…`):
// self-describing, so after creation no separate header is needed to locate it.
//
// Two id forms are accepted everywhere an id is read:
//   - fully-qualified (3 segments) → carries its own scope.
//   - bare (1 segment, the cacheId) → inherits the fallback scope (the
//     configured default unless a caller passes one). This keeps single-tenant
//     callers and pre-existing ids working: a bare id resolves under the default
//     identity. In strict mode (no default configured) a bare id is rejected.
//
// Segments are a flexible string `[A-Za-z0-9_-]{1,64}` — it covers UUIDs (with
// dashes), `main`, `tenant`/`user`, etc. — and deliberately EXCLUDES `:` (the
// composite separator) and `/`/`.` (path-traversal safety, since segments
// become filesystem directory names and Redis key segments).

const crypto = require('crypto');
const path = require('path');
const config = require('./config');

// One id segment: tenant, user, or cacheId.
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Error carrying an HTTP-ish status so routes can map it (the global error
// handler defaults unknown errors to 400, which is also correct here).
class IdentityError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'IdentityError';
    this.status = status;
  }
}

function isValidSegment(s) {
  return typeof s === 'string' && SEGMENT_RE.test(s);
}

// The configured implicit identity (may be blank segments in strict mode).
function defaultScope() {
  return { tenantId: config.defaultTenantId, userId: config.defaultUserId };
}

// A ':'-free cacheId (today's receipt/short id: 16 hex chars from a uuid).
function newCacheId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/** Build the composite resource id used in URLs, job data, and storage keys. */
function buildId(tenantId, userId, cacheId) {
  if (!isValidSegment(tenantId) || !isValidSegment(userId) || !isValidSegment(cacheId)) {
    throw new IdentityError(400, 'cannot build id from invalid identity/cacheId segments');
  }
  return `${tenantId}:${userId}:${cacheId}`;
}

/**
 * Resolve any resource id to `{ tenantId, userId, cacheId }`. A 3-segment id is
 * fully-qualified; a bare (1-segment) id inherits `fallback` (default scope
 * unless a caller passes one). Throws IdentityError on a malformed id or when a
 * bare id has no usable fallback (strict mode).
 */
function resolveId(id, fallback = defaultScope()) {
  if (typeof id !== 'string' || id.length === 0) throw new IdentityError(400, 'missing resource id');
  const parts = id.split(':');
  if (parts.length === 3) {
    const [tenantId, userId, cacheId] = parts;
    if (isValidSegment(tenantId) && isValidSegment(userId) && isValidSegment(cacheId)) {
      return { tenantId, userId, cacheId };
    }
    throw new IdentityError(400, `malformed resource id "${id}"`);
  }
  if (parts.length === 1 && isValidSegment(parts[0])) {
    const { tenantId, userId } = fallback || {};
    if (!isValidSegment(tenantId) || !isValidSegment(userId)) {
      throw new IdentityError(400, 'tenant/user identity required (no default configured)');
    }
    return { tenantId, userId, cacheId: parts[0] };
  }
  throw new IdentityError(400, `malformed resource id "${id}"`);
}

/** Just the scope of an id (drops cacheId). */
function scopeOf(id, fallback) {
  const { tenantId, userId } = resolveId(id, fallback);
  return { tenantId, userId };
}

/**
 * Resolve the (tenantId, userId) for an Express request from headers
 * (`X-Tenant-Id` / `X-User-Id`) or form/body fields (`tenantId` / `userId`),
 * falling back to the configured default. Throws 400 in strict mode (no default)
 * when the request supplies neither. Used at resource CREATION (upload) and for
 * collection endpoints that have no id to derive scope from.
 */
function resolveIdentity(req) {
  const pick = (field, header) => {
    const h = req && typeof req.get === 'function' ? req.get(header) : req && req.headers && req.headers[header.toLowerCase()];
    const b = req && req.body ? req.body[field] : undefined;
    return (h && String(h)) || (b && String(b)) || '';
  };
  const tenantId = pick('tenantId', 'X-Tenant-Id') || config.defaultTenantId;
  const userId = pick('userId', 'X-User-Id') || config.defaultUserId;
  if (!isValidSegment(tenantId)) {
    throw new IdentityError(400, 'a tenant id is required (send X-Tenant-Id / tenantId, or set DEFAULT_TENANT_ID)');
  }
  if (!isValidSegment(userId)) {
    throw new IdentityError(400, 'a user id is required (send X-User-Id / userId, or set DEFAULT_USER_ID)');
  }
  return { tenantId, userId };
}

// --- BullMQ job ids ----------------------------------------------------------
// BullMQ rejects ':' in custom job ids, but a composite id is full of them, so
// hash the composite (+ any extra parts, e.g. a profileId) into a ':'-free,
// deterministic id. Same inputs → same id, so dedup behavior is preserved.
function jobId(prefix, ...parts) {
  const h = crypto.createHash('sha1').update(parts.map((p) => String(p)).join('|')).digest('hex');
  return `${prefix}-${h}`;
}

// --- Filesystem path scheme --------------------------------------------------
// Private, per-tenant+user data:   <dataDir>/<tenant>/<user>/<sub>
// Shared-in-tenant data (profiles): <dataDir>/<tenant>/<sub>
// Segments are validated (defense-in-depth against path traversal) before use.

function safeSeg(s, what) {
  if (!isValidSegment(s)) throw new IdentityError(400, `invalid ${what} "${s}"`);
  return s;
}

function userDataDir(scope, sub) {
  const { tenantId, userId } = scope || {};
  return path.join(config.dataDir, safeSeg(tenantId, 'tenant'), safeSeg(userId, 'user'), sub);
}

function tenantDataDir(tenantId, sub) {
  return path.join(config.dataDir, safeSeg(tenantId, 'tenant'), sub);
}

module.exports = {
  SEGMENT_RE,
  IdentityError,
  isValidSegment,
  defaultScope,
  newCacheId,
  buildId,
  resolveId,
  scopeOf,
  resolveIdentity,
  jobId,
  userDataDir,
  tenantDataDir,
};
