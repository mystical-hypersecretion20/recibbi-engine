'use strict';

// Caching + bounded-parallel resolution in resolveService. We stub the products
// registry's active resolver (counting calls / tracking concurrency) and inject
// an in-memory Redis, then drive resolveProductsForProfileResult. No network.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

useTempDataDir('products-cache-test');
const fakeRedis = installFakeRedis(); // must precede requiring the service (pulls in ../redis)

// --- stub the resolver registry BEFORE requiring the service ---------------
let calls = 0; // how many times the backend resolver was actually invoked
let inFlight = 0;
let peakInFlight = 0;
let resolveImpl = async (item) => ({
  productTitle: `P:${item.description}`,
  productDescription: 'd',
  productUrl: 'https://example.com/x',
  brand: null,
  category: null,
  confidence: 0.5,
});

const fakeResolver = {
  id: 'fake',
  ready: () => true,
  resolve: async (item, ctx) => {
    calls += 1;
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    try {
      return await resolveImpl(item, ctx);
    } finally {
      inFlight -= 1;
    }
  },
};

const registryPath = require.resolve('../src/products/registry');
require.cache[registryPath] = {
  id: registryPath,
  filename: registryPath,
  loaded: true,
  exports: { active: () => fakeResolver, get: () => fakeResolver, list: () => [], has: () => true, reload: () => {} },
};

const config = require('../src/config');
const store = require('../src/store');
const profileStore = require('../src/receiptProfiles/profileStore');
const profileResultStore = require('../src/receiptProfiles/resultStore');
const productCache = require('../src/products/productCache');
const { resolveProductsForProfileResult } = require('../src/products/resolveService');

let profile;

async function seedProfileResult(items, storeName = 'Costco') {
  const rec = await store.createReceipt({ buffer: Buffer.alloc(8, 1), mimeType: 'image/png', originalName: 'r.png', source: 'test' });
  await profileResultStore.save({
    receiptId: rec.id,
    profileId: profile.id,
    profileName: profile.name,
    store: { name: storeName, date: '2026-05-26' },
    items,
  });
  return rec.id;
}

before(async () => {
  profile = await profileStore.create({ name: 'cacheTest1', transformer: 'usGrocery' });
});

test('a repeat SKU across receipts is served from the shared cache (no second backend call)', async () => {
  calls = 0;
  fakeRedis.store.clear();
  const item = { description: 'KS PURIFIED WATER', sku: '1390089', qty: 1, unitPrice: 3.99, price: 3.99 };

  const first = await resolveProductsForProfileResult(await seedProfileResult([item]), profile.id);
  assert.equal(first.stats.resolved, 1);
  assert.equal(first.stats.cached, 0, 'first lookup is a cache miss');
  assert.equal(calls, 1, 'backend called once');
  assert.ok(fakeRedis.calls.set >= 1, 'result written to cache');

  // A different receipt with the SAME store + sku + description: cache hit.
  const second = await resolveProductsForProfileResult(await seedProfileResult([item]), profile.id);
  assert.equal(second.stats.resolved, 1, 'still resolved (from cache)');
  assert.equal(second.stats.cached, 1, 'served from cache');
  assert.equal(calls, 1, 'backend NOT called a second time');
  assert.equal(second.products[0].productTitle, 'P:KS PURIFIED WATER', 'cached fields returned');
});

test('price/qty differences do not bust the cache; store/sku/description do', async () => {
  calls = 0;
  fakeRedis.store.clear();
  const base = { description: 'ORGANIC EGGS', sku: '55', qty: 1, unitPrice: 6.49, price: 6.49 };

  await resolveProductsForProfileResult(await seedProfileResult([base]), profile.id);
  assert.equal(calls, 1);

  // Same identity, different price/qty -> cache hit (no new call).
  await resolveProductsForProfileResult(
    await seedProfileResult([{ ...base, qty: 2, price: 12.98, unitPrice: 6.49 }]),
    profile.id
  );
  assert.equal(calls, 1, 'price/qty are not part of the cache key');

  // Different store -> miss; different sku -> miss.
  await resolveProductsForProfileResult(await seedProfileResult([base], 'Sams Club'), profile.id);
  assert.equal(calls, 2, 'different store is a different key');
  await resolveProductsForProfileResult(await seedProfileResult([{ ...base, sku: '99' }]), profile.id);
  assert.equal(calls, 3, 'different sku is a different key');
});

test('lookups run in a bounded parallel pool (not one-at-a-time)', async () => {
  calls = 0;
  inFlight = 0;
  peakInFlight = 0;
  fakeRedis.store.clear();
  const prev = config.products.concurrency;
  config.products.concurrency = 3;
  // Each lookup parks briefly so overlap is observable; unique descriptions so
  // every item is a cache miss that reaches the (counted) backend.
  resolveImpl = async (item) => {
    await new Promise((r) => setTimeout(r, 20));
    return { productTitle: `P:${item.description}`, productDescription: 'd', productUrl: 'https://x', confidence: 0.5 };
  };
  try {
    const items = Array.from({ length: 6 }, (_, i) => ({ description: `ITEM ${i}`, sku: String(i), price: i }));
    const out = await resolveProductsForProfileResult(await seedProfileResult(items), profile.id);
    assert.equal(out.stats.resolved, 6);
    assert.ok(peakInFlight > 1, `expected concurrent lookups, peak was ${peakInFlight}`);
    assert.ok(peakInFlight <= 3, `must not exceed the concurrency cap, peak was ${peakInFlight}`);
  } finally {
    config.products.concurrency = prev;
    resolveImpl = async (item) => ({ productTitle: `P:${item.description}`, productDescription: 'd', productUrl: 'https://x', confidence: 0.5 });
  }
});

test('cacheEnabled=false bypasses Redis entirely', async () => {
  calls = 0;
  fakeRedis.store.clear();
  fakeRedis.calls.get = fakeRedis.calls.set = 0;
  const prev = config.products.cacheEnabled;
  config.products.cacheEnabled = false;
  try {
    const item = { description: 'CACHELESS', sku: '7', price: 1 };
    await resolveProductsForProfileResult(await seedProfileResult([item]), profile.id);
    await resolveProductsForProfileResult(await seedProfileResult([item]), profile.id);
    assert.equal(calls, 2, 'both resolves hit the backend with caching off');
    assert.equal(fakeRedis.calls.get, 0, 'cache never read');
    assert.equal(fakeRedis.calls.set, 0, 'cache never written');
  } finally {
    config.products.cacheEnabled = prev;
  }
});
