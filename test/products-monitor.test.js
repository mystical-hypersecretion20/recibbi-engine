'use strict';

// The live lookup monitor: the per-lookup event log (productEvents) + the
// /api/products/events JSON feed + the /products/monitor HTML console. We stub a
// ready resolver so real events are produced (no network) and inject fake Redis
// (the event log is a Redis list). Same hermetic Express-over-loopback setup as
// products-routes.test.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('products-monitor-test');
installFakeRedis();

// Stub the queue so requiring the app/routes never opens real Redis for BullMQ.
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async () => ({}),
    enqueueProcessAndApply: async () => ({}),
    enqueueProcessApplyAndResolve: async () => ({}),
    enqueueApplyProfile: async () => ({}),
    enqueueResolveProducts: async () => ({}),
    receiptsQueue: {},
    connection: {},
  },
};

// Stub the products registry's active resolver: always ready, returns fields.
const fakeResolver = {
  id: 'fake',
  ready: () => true,
  resolve: async (item) => ({
    productTitle: `P:${item.description}`,
    productDescription: 'd',
    productUrl: 'https://example.com/x',
    brand: null,
    category: null,
    confidence: 0.7,
  }),
};
const registryPath = require.resolve('../src/products/registry');
require.cache[registryPath] = {
  id: registryPath,
  filename: registryPath,
  loaded: true,
  exports: { active: () => fakeResolver, get: () => fakeResolver, list: () => [{ id: 'fake' }], has: () => true, reload: () => {} },
};

const store = require('../src/store');
const profileStore = require('../src/receiptProfiles/profileStore');
const profileResultStore = require('../src/receiptProfiles/resultStore');
const productEvents = require('../src/products/productEvents');
const { createApp } = require('../src/app');

let server;
let base;
let profile;

const items = [
  { description: 'KS SPARK WAT', sku: '1', qty: 1, unitPrice: 4.99, price: 4.99 },
  { description: 'US WAGYU BEEF', sku: '2', qty: 1, unitPrice: 19.99, price: 19.99 },
];

async function seedAppliedReceipt() {
  const rec = await store.createReceipt({ buffer: Buffer.alloc(8, 1), mimeType: 'image/png', originalName: 'r.png', source: 'test' });
  await profileResultStore.save({
    receiptId: rec.id,
    profileId: profile.id,
    profileName: profile.name,
    store: { name: 'Costco', date: '2026-05-26' },
    items,
  });
  return rec.id;
}

before(async () => {
  await productEvents.clear();
  profile = await profileStore.create({ name: 'monitor1', transformer: 'usGrocery' });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

test('resolving emits per-lookup events; a repeat receipt yields cache HITs', async () => {
  // First receipt: cold cache -> two MISS events.
  const id1 = await seedAppliedReceipt();
  await fetch(`${base}/api/receipts/${id1}/profileResults/${profile.id}/resolveProducts`, { method: 'POST' });

  // Second receipt, identical items -> two HIT events from the shared cache.
  const id2 = await seedAppliedReceipt();
  await fetch(`${base}/api/receipts/${id2}/profileResults/${profile.id}/resolveProducts`, { method: 'POST' });

  const events = await productEvents.recent({ limit: 100 });
  const outcomes = events.map((e) => e.outcome);
  assert.ok(outcomes.includes('miss'), 'a cold lookup recorded a miss');
  assert.ok(outcomes.includes('hit'), 'the repeat lookup recorded a cache hit');
  // Pick a specific hit (pool order isn't deterministic) and check its shape.
  const hit = events.find((e) => e.outcome === 'hit' && e.sku === '1');
  assert.ok(hit, 'the repeat of sku 1 is a cache hit');
  assert.equal(hit.store, 'Costco');
  assert.ok(typeof hit.seq === 'number', 'events carry a monotonic seq');
  assert.ok(hit.cacheKey && hit.cacheKey.startsWith('products:fake:'), 'event carries the cache key');
});

test('GET /api/products/events returns the window + summary stats', async () => {
  const res = await fetch(`${base}/api/products/events?limit=50`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.events));
  assert.ok(body.stats.hits >= 2, 'counts hits');
  assert.ok(body.stats.misses >= 2, 'counts misses');
  assert.ok(body.stats.hitRate > 0 && body.stats.hitRate <= 1, 'hit rate is a fraction');
  assert.ok('serverTime' in body);
  // newest-first ordering
  if (body.events.length >= 2 && body.events[0].seq != null) {
    assert.ok(body.events[0].seq >= body.events[1].seq, 'newest first');
  }
});

test('GET /products/monitor serves the technical console shell', async () => {
  const res = await fetch(`${base}/products/monitor?interval=3`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
  const html = await res.text();
  assert.match(html, /product lookup monitor/i, 'has the title');
  assert.match(html, /CACHE HIT/, 'makes cache hits an explicit, visible state');
  assert.match(html, /__MONITOR__/, 'injects the poller config');
  assert.match(html, /"intervalMs":3000/, 'honors the ?interval override');
  assert.match(html, /\/api\/products\/events/, 'points the poller at the JSON feed');
});

test('GET /observe/cache/products is an alias for the monitor (incl. ?interval=3s)', async () => {
  const res = await fetch(`${base}/observe/cache/products?interval=3s`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
  const html = await res.text();
  assert.match(html, /product lookup monitor/i, 'serves the same console');
  assert.match(html, /"intervalMs":3000/, 'parses the "3s" interval (trailing s tolerated)');
});
