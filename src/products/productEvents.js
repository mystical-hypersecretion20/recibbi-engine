'use strict';

// A shared, Redis-backed ring buffer of per-lookup product-resolution events,
// purpose-built for the /products/monitor technical console. Why Redis (and not
// an in-process array): the WORKER resolves products while the SERVER renders
// the page — different processes. A Redis LIST is the shared channel both see,
// the same reason the cache itself lives in Redis.
//
// Each event records the outcome of ONE line-item lookup — crucially whether it
// was a cache HIT or a backend MISS, plus the latency, so the monitor can make
// cache hits obvious (a hit is ~sub-millisecond; a miss is a real backend call).
//
// Best-effort throughout, like productCache: any Redis error is swallowed so
// instrumentation never affects a resolve. A monotonic `seq` (INCR) lets the
// monitor poll incrementally and de-dupe without relying on timestamp ties.

const config = require('../config');
const logger = require('../logger');
const { cache } = require('../redis');

const LIST_KEY = 'products:events';
const SEQ_KEY = 'products:events:seq';

function enabled() {
  return config.products.eventsMax > 0;
}

/**
 * Append one lookup event. Stamps `seq` (monotonic) and `ts` (ISO) if absent,
 * then LPUSHes (newest at index 0) and trims to the configured cap.
 * @param {object} event  { outcome, latencyMs, store, sku, description, ... }
 */
async function record(event) {
  if (!enabled()) return;
  try {
    const client = cache();
    let seq = null;
    try {
      seq = await client.incr(SEQ_KEY);
    } catch {
      /* seq is a nicety; proceed without it */
    }
    const full = { seq, ts: new Date().toISOString(), ...event };
    await client.lpush(LIST_KEY, JSON.stringify(full));
    await client.ltrim(LIST_KEY, 0, config.products.eventsMax - 1);
  } catch (err) {
    logger.warn({ err: err.message }, 'product event record failed');
  }
}

/**
 * Most-recent events, newest first. Tolerates non-JSON / missing entries.
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
async function recent({ limit } = {}) {
  if (!enabled()) return [];
  const n = Math.min(Math.max(1, limit || config.products.eventsMax), config.products.eventsMax);
  try {
    const raw = await cache().lrange(LIST_KEY, 0, n - 1);
    return (raw || [])
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message }, 'product event read failed');
    return [];
  }
}

/** Drop the buffer (used by tests / a manual reset). Best-effort. */
async function clear() {
  try {
    const client = cache();
    await client.del(LIST_KEY);
    await client.del(SEQ_KEY);
  } catch (err) {
    logger.warn({ err: err.message }, 'product event clear failed');
  }
}

module.exports = { record, recent, clear, LIST_KEY, SEQ_KEY };
