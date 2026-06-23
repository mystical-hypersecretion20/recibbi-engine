'use strict';

const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const config = require('../config');
const identity = require('../identity');
const persistence = require('../persistence');
const { validateProfile } = require('./validate');

// Profile DEFINITIONS are scoped per TENANT (shared by all users in a tenant,
// unlike receipts/results which are per user) and persisted through the
// pluggable persistence layer:
//   kind='receiptProfiles', { tenant, id: rp_id }   (no user segment)
// Every function takes a trailing `{ tenantId }` (default: the configured
// tenant), so single-tenant callers can omit it. Each tenant is seeded with the
// shipped example profiles on first touch.

function tenantOf(opts) {
  const t = (opts && opts.tenantId) || config.defaultTenantId;
  if (!identity.isValidSegment(t)) throw new identity.IdentityError(400, `invalid tenant id "${t}"`);
  return t;
}
function keyFor(tenantId, id) {
  return { kind: 'receiptProfiles', tenant: tenantId, id };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function newId() {
  return 'rp_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

class ValidationError extends Error {
  constructor(errors) {
    super('profile validation failed');
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

async function readAll(tenantId) {
  return persistence.list({ kind: 'receiptProfiles', tenant: tenantId });
}

async function list(opts) {
  const tenantId = tenantOf(opts);
  const all = await readAll(tenantId);
  all.sort((a, b) => (a.name < b.name ? -1 : 1));
  return all;
}

/** Resolve a profile by its id (rp_…) or its unique name, within a tenant. */
async function get(idOrName, opts) {
  const tenantId = tenantOf(opts);
  if (idOrName && idOrName.startsWith('rp_')) {
    return persistence.get(keyFor(tenantId, idOrName));
  }
  const all = await readAll(tenantId);
  return all.find((p) => p.name === idOrName) || null;
}

async function writeAtomic(tenantId, profile) {
  await persistence.put(keyFor(tenantId, profile.id), profile);
  return profile;
}

/** Create a new profile from a user-supplied definition (within a tenant). */
async function create(input, opts) {
  const tenantId = tenantOf(opts);
  const { valid, errors } = validateProfile(input);
  if (!valid) throw new ValidationError(errors);
  if (await get(input.name, { tenantId })) {
    throw new ValidationError([`a profile named "${input.name}" already exists`]);
  }
  const now = new Date().toISOString();
  const profile = {
    id: newId(),
    name: input.name,
    description: input.description || null,
    version: 1,
    transformer: input.transformer,
    config: isPlainObject(input.config) ? input.config : {},
    createdAt: now,
    updatedAt: now,
  };
  return writeAtomic(tenantId, profile);
}

/** Replace a profile's definition (keeps id/createdAt, bumps version). */
async function update(idOrName, input, opts) {
  const tenantId = tenantOf(opts);
  const existing = await get(idOrName, { tenantId });
  if (!existing) return null;
  const { valid, errors } = validateProfile(input);
  if (!valid) throw new ValidationError(errors);
  // A rename must not collide with a different profile.
  if (input.name !== existing.name) {
    const other = await get(input.name, { tenantId });
    if (other && other.id !== existing.id) {
      throw new ValidationError([`a profile named "${input.name}" already exists`]);
    }
  }
  const next = {
    ...existing,
    name: input.name,
    description: input.description || null,
    version: existing.version + 1,
    transformer: input.transformer,
    config: isPlainObject(input.config) ? input.config : {},
    updatedAt: new Date().toISOString(),
  };
  return writeAtomic(tenantId, next);
}

async function remove(idOrName, opts) {
  const tenantId = tenantOf(opts);
  const existing = await get(idOrName, { tenantId });
  if (!existing) return false;
  await persistence.delete(keyFor(tenantId, existing.id)).catch(() => {});
  return true;
}

async function count(opts) {
  return (await readAll(tenantOf(opts))).length;
}

/**
 * Seed the shipped example profiles for a tenant when it has none (first touch),
 * the same idea as the bundled store-aliases.json. Invalid or duplicate seeds are
 * skipped so a bad seed file can't crash startup. Called at boot for the default
 * tenant and when a new tenant is provisioned. Seed files ship WITH the app, so
 * they're read from the filesystem here regardless of the persistence backend.
 */
async function seedIfEmpty(opts) {
  const tenantId = tenantOf(opts);
  if ((await readAll(tenantId)).length > 0) return 0;
  const seedDir = path.join(__dirname, 'seedProfiles');
  let files;
  try {
    files = await fsp.readdir(seedDir);
  } catch {
    return 0;
  }
  let seeded = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const def = JSON.parse(await fsp.readFile(path.join(seedDir, f), 'utf8'));
      await create(def, { tenantId });
      seeded += 1;
    } catch {
      /* skip a bad/duplicate seed */
    }
  }
  return seeded;
}

module.exports = { create, get, list, update, remove, count, seedIfEmpty, newId, ValidationError };
