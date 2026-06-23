'use strict';

const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { cache } = require('../redis');
const tavily = require('./tavily');

// The enrichment cache is scoped PER TENANT: item enrichment is derived from a
// tenant's receipts (private-ish), and users within a tenant tend to shop the
// same stores, so sharing within a tenant keeps the hit rate high without
// leaking across tenants. (The product cache, by contrast, is global — a SKU's
// product identity is the same for everyone.) Tenant defaults to the configured
// identity so single-tenant callers need pass nothing.
function cacheKey(query, tenantId) {
  const t = tenantId || config.defaultTenantId;
  const h = crypto.createHash('sha1').update(query.toLowerCase()).digest('hex');
  return `${t}:enrich:tavily:${h}`;
}

function buildQuery(item, storeName) {
  const parts = [item.description];
  if (storeName) parts.push(storeName);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

async function fromCache(query, tenantId) {
  try {
    const raw = await cache().get(cacheKey(query, tenantId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn({ err: err.message }, 'enrich cache read failed');
    return null;
  }
}

async function toCache(query, value, tenantId) {
  try {
    await cache().set(cacheKey(query, tenantId), JSON.stringify(value), 'EX', config.enrich.cacheTtlSeconds);
  } catch (err) {
    logger.warn({ err: err.message }, 'enrich cache write failed');
  }
}

/**
 * Enrich items in place (mutates each item's `enrichment` field). The cache is
 * scoped to `tenantId` (default: configured tenant).
 * Degrades gracefully: if disabled or a lookup fails, items keep enrichment=null.
 * @returns {Promise<{enriched:number, skipped:number, errors:number}>}
 */
async function enrichItems(items, storeName, { tenantId } = {}) {
  const stats = { enriched: 0, skipped: 0, errors: 0 };
  if (!config.enrich.enabled) {
    logger.info('enrichment disabled (no TAVILY_API_KEY); skipping');
    stats.skipped = items.length;
    return stats;
  }

  let processed = 0;
  for (const item of items) {
    if (processed >= config.enrich.maxItems) {
      stats.skipped += 1;
      continue;
    }
    const query = buildQuery(item, storeName);
    if (!query) {
      stats.skipped += 1;
      continue;
    }
    try {
      let result = await fromCache(query, tenantId);
      if (!result) {
        result = await tavily.searchItem(query);
        if (result) await toCache(query, result, tenantId);
      }
      item.enrichment = result;
      if (result) stats.enriched += 1;
      else stats.skipped += 1;
    } catch (err) {
      logger.warn({ err: err.message, query }, 'enrichment lookup failed');
      item.enrichment = { query, error: err.message };
      stats.errors += 1;
    }
    processed += 1;
  }
  return stats;
}

module.exports = { enrichItems };
