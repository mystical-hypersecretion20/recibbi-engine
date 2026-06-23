'use strict';

const fsp = require('fs/promises');
const path = require('path');
const identity = require('./identity');
const persistence = require('./persistence');

// Receipt records are durable DOCUMENTS keyed by identity, persisted through the
// pluggable persistence layer (src/persistence — filesystem or sqlite):
//   kind='receipts', { tenant, user, id: cacheId }
// A receipt's public `id` is the COMPOSITE id `<tenant>:<user>:<cacheId>`, which
// the store parses (src/identity.js) to derive the document key.
//
// Uploaded image blobs are NOT records — they always live on the filesystem at
// `<dataDir>/<tenant>/<user>/uploads/<cacheId>.<ext>` regardless of persistence
// backend (a dedicated blob-store abstraction comes later). `imagePathFor` and
// `createReceipt`'s image write therefore stay on fs/promises.

function newId() {
  return identity.newCacheId();
}

function uploadsDir(scope) {
  return identity.userDataDir(scope, 'uploads');
}

// Resolve a composite (or bare) id to its persistence key, or null if the id is
// malformed (so callers surface a clean 404 rather than throwing).
function keyOf(id) {
  try {
    const r = identity.resolveId(id);
    return { kind: 'receipts', tenant: r.tenantId, user: r.userId, id: r.cacheId };
  } catch {
    return null;
  }
}

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
};

function extForMime(mime, fallbackName) {
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime];
  const ext = fallbackName ? path.extname(fallbackName) : '';
  return ext || '.img';
}

/**
 * Persist an uploaded image buffer and create the initial receipt record under
 * the given identity. `tenantId`/`userId` default to the configured identity.
 * @returns {Promise<object>} the created record (its `id` is the composite id)
 */
async function createReceipt({ buffer, mimeType, originalName, source, tenantId, userId }) {
  const def = identity.defaultScope();
  const scope = { tenantId: tenantId || def.tenantId, userId: userId || def.userId };
  const cacheId = newId();
  const id = identity.buildId(scope.tenantId, scope.userId, cacheId); // validates scope
  const ext = extForMime(mimeType, originalName);
  const imageFile = `${cacheId}${ext}`;

  await fsp.mkdir(uploadsDir(scope), { recursive: true });
  await fsp.writeFile(path.join(uploadsDir(scope), imageFile), buffer);

  const now = new Date().toISOString();
  const record = {
    id,
    tenantId: scope.tenantId,
    userId: scope.userId,
    status: 'queued', // queued | processing | done | failed
    source: source || 'api',
    createdAt: now,
    updatedAt: now,
    image: {
      file: imageFile,
      mimeType: mimeType || 'application/octet-stream',
      originalName: originalName || null,
      size: buffer.length,
    },
    extraction: { provider: null, rawText: null },
    store: null, // { name, date }
    items: [], // [{ description, sku, qty, unitPrice, price, enrichment }]
    totals: null, // { subtotal, tax, total, itemCount, sumOfItems }
    summary: null,
    error: null,
    timings: {},
  };
  await save(record);
  return record;
}

async function save(record) {
  const key = keyOf(record.id);
  if (!key) throw new identity.IdentityError(400, `cannot save record with invalid id "${record.id}"`);
  record.updatedAt = new Date().toISOString();
  await persistence.put(key, record);
  return record;
}

async function get(id) {
  const key = keyOf(id);
  if (!key) return null; // malformed id -> treat as not found
  return persistence.get(key);
}

/**
 * Read-modify-write merge. Single-worker concurrency keeps this safe for the
 * scaffold; for multi-worker setups switch to a record-level lock.
 */
async function update(id, patch) {
  const current = await get(id);
  if (!current) throw new Error(`receipt ${id} not found`);
  const next = { ...current, ...patch };
  return save(next);
}

/**
 * List a single identity's receipts, newest first. Scope defaults to the
 * configured identity (so single-tenant callers pass only `{ limit }`).
 */
async function list({ tenantId, userId, limit = 50 } = {}) {
  const def = identity.defaultScope();
  const scope = { tenantId: tenantId || def.tenantId, userId: userId || def.userId };
  let records;
  try {
    records = await persistence.list({ kind: 'receipts', tenant: scope.tenantId, user: scope.userId });
  } catch {
    return []; // invalid scope -> nothing to list
  }
  records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return records.slice(0, limit);
}

function imagePathFor(record) {
  const { tenantId, userId } = identity.resolveId(record.id);
  return path.join(uploadsDir({ tenantId, userId }), record.image.file);
}

module.exports = { createReceipt, save, get, update, list, imagePathFor, newId };
