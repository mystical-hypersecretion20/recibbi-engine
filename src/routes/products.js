'use strict';

const express = require('express');
const config = require('../config');
const store = require('../store');
const profileStore = require('../receiptProfiles/profileStore');
const profileResultStore = require('../receiptProfiles/resultStore');
const productStore = require('../products/productStore');
const productEvents = require('../products/productEvents');
const productCache = require('../products/productCache');
const registry = require('../products/registry');
const { resolveProductsForProfileResult } = require('../products/resolveService');
const { enqueueResolveProducts } = require('../queue');
const identity = require('../identity');
const view = require('../web/view');
const logger = require('../logger');

const router = express.Router();

function productsUrl(receiptId, profileId) {
  return `${config.publicBaseUrl}/api/receipts/${receiptId}/products/${profileId}`;
}

// Summarize a window of lookup events for the monitor header. `hitRate` is over
// cache-eligible outcomes (hits + misses); avg/saved latency uses only misses,
// since a hit's latency is the (negligible) cache read.
function summarize(events) {
  const s = { total: events.length, hits: 0, misses: 0, empty: 0, errors: 0 };
  let missLatSum = 0;
  let missLatN = 0;
  for (const e of events) {
    if (e.outcome === 'hit') s.hits += 1;
    else if (e.outcome === 'miss') s.misses += 1;
    else if (e.outcome === 'empty') s.empty += 1;
    else if (e.outcome === 'error') s.errors += 1;
    if (e.outcome === 'miss' && typeof e.latencyMs === 'number') {
      missLatSum += e.latencyMs;
      missLatN += 1;
    }
  }
  const eligible = s.hits + s.misses;
  s.hitRate = eligible ? s.hits / eligible : 0;
  s.avgMissLatencyMs = missLatN ? Math.round(missLatSum / missLatN) : null;
  // Rough wall-clock saved by the cache: each hit dodged ~one avg backend call.
  s.estSavedMs = s.avgMissLatencyMs ? s.hits * s.avgMissLatencyMs : null;
  return s;
}

// --- Available resolvers (read-only; code shipped with the app) --------------

router.get('/api/productResolvers', (req, res) => {
  res.json({ active: config.products.resolver, resolvers: registry.list() });
});

// --- Live lookup monitor (technical console) ---------------------------------
// NOTE: the product cache and its event log are GLOBAL (shared across tenants) —
// a SKU's product identity is the same for everyone — so these endpoints are not
// tenant-scoped, by design.

// JSON feed for /products/monitor: recent per-lookup events (newest first) plus
// a summary over the returned window. Polled by the monitor page every few sec.
router.get('/api/products/events', async (req, res, next) => {
  try {
    const max = config.products.eventsMax;
    const limit = Math.min(parseInt(req.query.limit, 10) || max, max);
    const events = await productEvents.recent({ limit });
    res.json({ events, stats: summarize(events), serverTime: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// HTML monitor console: auto-refreshing (default 5s), autoscrolling tail of
// product lookups that makes cache HITs visually obvious. Built for a technical
// operator (us), not an end user — depth over polish. ?interval=<sec> overrides
// (a trailing 's' is tolerated, e.g. ?interval=3s — parseInt stops at it).
function serveMonitor(req, res) {
  const secs = parseInt(req.query.interval, 10);
  const intervalMs = Math.max(1000, (Number.isFinite(secs) ? secs : 5) * 1000);
  res.type('html').send(
    view.renderProductMonitor({ intervalMs, eventsUrl: '/api/products/events', limit: config.products.eventsMax })
  );
}
router.get('/products/monitor', serveMonitor);
// Alias under a stable, namespaced observability path. Same page, same query
// params — purely an alternate URL for /products/monitor.
router.get('/observe/cache/products', serveMonitor);

// --- Products cache: export / import (admin) ---------------------------------
// The product cache is shared, GLOBAL Redis state. These endpoints snapshot it
// to a portable JSON document and restore it — e.g. seed a known cache before an
// acceptance run so SKU lookups are served from cache instead of live Anthropic
// calls (a parallel, offline path to the resolver). The `products` CLI wraps
// these. The monitor's event log (products:events*) is never included.

router.get('/api/products/cache/stats', async (req, res, next) => {
  try {
    res.json({ resolver: config.products.resolver, entries: await productCache.count() });
  } catch (err) {
    next(err);
  }
});

router.get('/api/products/cache/export', async (req, res, next) => {
  try {
    const entries = await productCache.exportEntries();
    res.json({
      type: 'receipt-enricher/products-cache',
      version: 1,
      exportedAt: new Date().toISOString(),
      resolver: config.products.resolver,
      count: entries.length,
      entries,
    });
  } catch (err) {
    next(err);
  }
});

// Accepts a full export document ({type,version,entries}) or a bare entries
// array. ?flush=1 clears the existing cache first.
router.post('/api/products/cache/import', async (req, res, next) => {
  try {
    const b = req.body;
    const entries = Array.isArray(b) ? b : b && Array.isArray(b.entries) ? b.entries : null;
    if (!entries) {
      return res.status(400).json({ error: 'body must be a products-cache export object or an array of entries' });
    }
    const result = await productCache.importEntries(entries, { flush: !!req.query.flush });
    logger.info({ ...result, total: entries.length }, 'product cache imported');
    res.json({ ...result, total: entries.length });
  } catch (err) {
    next(err);
  }
});

// --- Resolve products from a receipt's profile result ------------------------
// Receipt-scoped: tenant is derived FROM the receipt id (composite).

// Map a profile result's line items to products. Synchronous by default.
// ?dryRun=1 resolves and returns without persisting. ?async=1 enqueues a
// childless `resolveProducts` job and returns 202 instead of running inline.
// Mirrors the applyProfile route in routes/receiptProfiles.js.
router.post('/api/receipts/:id/profileResults/:profileId/resolveProducts', async (req, res, next) => {
  try {
    if (req.query.async && !req.query.dryRun) {
      const record = await store.get(req.params.id);
      if (!record) return res.status(404).json({ error: 'receipt not found' });
      const { tenantId } = identity.scopeOf(record.id);
      const profile = await profileStore.get(req.params.profileId, { tenantId });
      if (!profile) return res.status(404).json({ error: 'profile not found' });
      const profileResult = await profileResultStore.get(record.id, profile.id);
      if (!profileResult) {
        return res.status(409).json({ error: `profile "${profile.name}" has not been applied to this receipt yet` });
      }
      await enqueueResolveProducts(record.id, profile.id);
      logger.info({ receiptId: record.id, profileId: profile.id }, 'product resolution enqueued (async)');
      return res.status(202).json({
        receiptId: record.id,
        receiptProfileId: profile.id,
        status: 'queued',
        productsUrl: productsUrl(record.id, profile.id),
      });
    }

    const result = await resolveProductsForProfileResult(req.params.id, req.params.profileId, {
      dryRun: !!req.query.dryRun,
    });
    res.json(result);
  } catch (err) {
    if (err && err.name === 'ResolveError') return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// --- Read product results ----------------------------------------------------

// Every product result for the requesting identity (newest first).
router.get('/api/products', async (req, res, next) => {
  try {
    const { tenantId, userId } = identity.resolveIdentity(req);
    res.json(await productStore.listAll({ tenantId, userId }));
  } catch (err) {
    next(err);
  }
});

router.get('/api/receipts/:id/products', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'receipt not found' });
    res.json(await productStore.list(record.id));
  } catch (err) {
    next(err);
  }
});

router.get('/api/receipts/:id/products/:profileId', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).json({ error: 'not found' });
    // Accept profile id or name; results are keyed by id, so resolve a name.
    const { tenantId } = identity.scopeOf(record.id);
    const profile = await profileStore.get(req.params.profileId, { tenantId });
    const profileId = profile ? profile.id : req.params.profileId;
    const result = await productStore.get(record.id, profileId);
    if (!result) return res.status(404).json({ error: 'not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// --- Web views ---------------------------------------------------------------

// HTML list of every product result for the requesting identity.
router.get('/products', async (req, res, next) => {
  try {
    const { tenantId, userId } = identity.resolveIdentity(req);
    res.type('html').send(view.renderProductList(await productStore.listAll({ tenantId, userId })));
  } catch (err) {
    next(err);
  }
});

// HTML view of the products resolved from one receipt's profile result. Renders
// the stored result only — unlike the profile view it does NOT compute fresh on
// a miss, since resolution makes live backend calls (a GET shouldn't).
router.get('/receipts/:id/products/:profileId/view', async (req, res, next) => {
  try {
    const record = await store.get(req.params.id);
    if (!record) return res.status(404).send('Receipt not found');
    const { tenantId } = identity.scopeOf(record.id);
    const profile = await profileStore.get(req.params.profileId, { tenantId });
    const profileId = profile ? profile.id : req.params.profileId;
    const result = await productStore.get(record.id, profileId);
    if (!result) {
      return res
        .status(404)
        .send('No products resolved for this receipt/profile yet. POST …/resolveProducts first.');
    }
    res.type('html').send(view.renderProductResult(record, result));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
