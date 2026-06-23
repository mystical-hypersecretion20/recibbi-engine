'use strict';

// Shared, Redis-backed cache in front of the product-resolver lookups. A single
// product lookup (line item -> product info) is a relatively expensive backend
// call — an Anthropic model turn plus server-side web search. The same product
// recurs constantly across receipts (a house-brand water SKU, a gallon of milk,
// "KS SPARK WAT"), so caching the resolved fields keyed by the inputs that
// determine the answer lets repeat items skip the call entirely.
//
// The cache lives in Redis (src/redis.js `cache()`), so it is shared across ALL
// worker and server processes — not per-process and not per-session. Two
// workers, the API, and a re-run an hour later all hit the same entries.
//
// Key construction is centralized in keyFor()/signature() ON PURPOSE: the scheme
// is globally shared today (no tenant dimension), and keeping it in one function
// means a future change (e.g. adding a tenant segment) is a single-site edit
// rather than a re-keying scattered across call sites.
//
// Mirrors the graceful degradation of enrich/index.js: any Redis error is
// swallowed and treated as a miss, so a cache outage slows resolution down to
// the uncached path but never fails a resolve.

const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { cache } = require('../redis');

// The inputs that actually determine a resolver's product answer for a line
// item. Price and qty are deliberately excluded: they don't change product
// IDENTITY, and folding them in would shred the hit rate (the same SKU at a
// different price would miss). Normalized so trivial formatting differences
// ("Costco " vs "costco") collapse to one entry.
function signature(lineItem, ctx) {
  const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase().replace(/\s+/g, ' '));
  return [norm(ctx && ctx.storeName), norm(lineItem && lineItem.sku), norm(lineItem && lineItem.description)].join('|');
}

/**
 * Build the Redis key for one resolver + line item. The resolver id is part of
 * the key so switching PRODUCT_RESOLVER never serves another backend's answers.
 * Globally shared by current design (no tenant dimension); all key construction
 * stays here so the scheme can be extended in exactly one place.
 * @param {string} resolverId
 * @param {object} lineItem  { description, sku, ... }
 * @param {object} ctx       { storeName, ... }
 * @returns {string}
 */
function keyFor(resolverId, lineItem, ctx) {
  const h = crypto.createHash('sha1').update(signature(lineItem, ctx)).digest('hex');
  return `products:${resolverId}:${h}`;
}

/** Read cached ProductFields for a key, or null on miss / disabled / any error. */
async function get(key) {
  if (!config.products.cacheEnabled) return null;
  try {
    const raw = await cache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn({ err: err.message }, 'product cache read failed');
    return null;
  }
}

/** Write ProductFields under a key with the configured TTL. Best-effort. */
async function set(key, value) {
  if (!config.products.cacheEnabled) return;
  try {
    await cache().set(key, JSON.stringify(value), 'EX', config.products.cacheTtlSeconds);
  } catch (err) {
    logger.warn({ err: err.message }, 'product cache write failed');
  }
}

// --- Export / import (admin: snapshot the shared cache to/from a file) -------
// The product cache is shared Redis state. These let an operator export it to a
// portable JSON document and restore it later — e.g. seed a known cache before
// an acceptance run so lookups are served from cache instead of live backend
// calls. They operate on the raw client (not gated by cacheEnabled) since their
// whole job is managing the store.

// Keys in the products: namespace that are NOT cache entries (the monitor's
// event log) and must never be exported/imported as cache.
const RESERVED_KEYS = new Set(['products:events', 'products:events:seq']);
const SCAN_MATCH = 'products:*';

function isCacheKey(k) {
  return typeof k === 'string' && k.startsWith('products:') && !RESERVED_KEYS.has(k);
}

// SCAN the whole products: namespace, returning only cache-entry keys.
async function scanKeys() {
  const client = cache();
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', SCAN_MATCH, 'COUNT', 250);
    cursor = String(next);
    for (const k of batch || []) if (isCacheKey(k)) keys.push(k);
  } while (cursor !== '0');
  return keys;
}

/** Number of cache entries currently stored. */
async function count() {
  return (await scanKeys()).length;
}

/**
 * Export every cache entry as a portable array: `{ key, value, ttlSeconds }`
 * (ttlSeconds is the remaining TTL, or null if none/unsupported). Order is
 * unspecified.
 * @returns {Promise<Array<{key:string, value:object, ttlSeconds:number|null}>>}
 */
async function exportEntries() {
  const client = cache();
  const keys = await scanKeys();
  const entries = [];
  for (const key of keys) {
    const raw = await client.get(key);
    if (raw == null) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw; // tolerate a non-JSON entry rather than dropping it
    }
    let ttlSeconds = null;
    try {
      const t = await client.ttl(key);
      if (typeof t === 'number' && t > 0) ttlSeconds = t;
    } catch {
      /* ttl unsupported -> leave null (import falls back to default TTL) */
    }
    entries.push({ key, value, ttlSeconds });
  }
  return entries;
}

/**
 * Import cache entries (the shape exportEntries() produces). Each entry's key
 * must be a products: cache key; reserved/event keys and malformed entries are
 * skipped. A missing/non-positive ttlSeconds falls back to the configured cache
 * TTL. With { flush:true } the existing cache is cleared first.
 * @param {Array<{key:string, value:any, ttlSeconds?:number}>} entries
 * @returns {Promise<{imported:number, skipped:number, flushed:number}>}
 */
async function importEntries(entries, { flush = false } = {}) {
  const client = cache();
  let flushed = 0;
  if (flush) {
    for (const k of await scanKeys()) {
      try {
        await client.del(k);
        flushed += 1;
      } catch {
        /* best effort */
      }
    }
  }
  let imported = 0;
  let skipped = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || !isCacheKey(e.key) || e.value === undefined || e.value === null) {
      skipped += 1;
      continue;
    }
    const payload = typeof e.value === 'string' ? e.value : JSON.stringify(e.value);
    const ttl =
      typeof e.ttlSeconds === 'number' && e.ttlSeconds > 0 ? e.ttlSeconds : config.products.cacheTtlSeconds;
    try {
      await client.set(e.key, payload, 'EX', ttl);
      imported += 1;
    } catch (err) {
      logger.warn({ err: err.message, key: e.key }, 'product cache import: failed to set entry');
      skipped += 1;
    }
  }
  return { imported, skipped, flushed };
}

module.exports = { keyFor, get, set, signature, scanKeys, count, exportEntries, importEntries };
