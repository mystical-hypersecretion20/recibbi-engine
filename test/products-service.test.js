'use strict';

// resolveService orchestration. We stub the products registry's active resolver
// (so no backend call), seed a receipt + profile + profile RESULT, then resolve.
// No network/Redis.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

useTempDataDir('products-service-test');
// resolveService now fronts each lookup with the shared Redis cache, so give it
// an in-memory Redis (the cache starts empty, so these tests' resolve counts are
// unchanged). Must precede requiring the service.
installFakeRedis();

// --- stub the resolver registry BEFORE requiring the service ---------------
let behavior = (item) => ({
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
  resolve: async (item) => behavior(item),
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
const productStore = require('../src/products/productStore');
const { resolveProductsForProfileResult, ResolveError } = require('../src/products/resolveService');

let receiptId;
let profile;

async function seedProfileResult(items) {
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
  profile = await profileStore.create({ name: 'svcTest1', transformer: 'usGrocery' });
  receiptId = await seedProfileResult([
    { description: 'KS SPARK WAT', sku: '1', qty: 1, unitPrice: 4.99, price: 4.99 },
    { description: 'US WAGYU BEEF', sku: '2', qty: 1, unitPrice: 19.99, price: 19.99 },
  ]);
});

test('happy path: resolves every item, carries store, persists', async () => {
  behavior = (item) => ({ productTitle: `P:${item.description}`, productDescription: 'd', productUrl: 'https://x', brand: null, category: null, confidence: 0.5 });
  const out = await resolveProductsForProfileResult(receiptId, profile.id);
  assert.equal(out.stats.resolved, 2);
  assert.equal(out.stats.skipped, 0);
  assert.equal(out.products.length, 2);
  assert.equal(out.products[0].productTitle, 'P:KS SPARK WAT');
  assert.equal(out.products[0].lineItem.price, 4.99);
  assert.equal(out.store.name, 'Costco');
  assert.equal(out.resolver, 'fake');
  const saved = await productStore.get(receiptId, profile.id);
  assert.ok(saved, 'persisted');
  assert.equal(saved.stats.resolved, 2);
});

test('dryRun returns the result without persisting', async () => {
  const id = await seedProfileResult([{ description: 'EGGS', price: 3 }]);
  const out = await resolveProductsForProfileResult(id, profile.id, { dryRun: true });
  assert.equal(out.dryRun, true);
  assert.equal(out.products.length, 1);
  assert.equal(await productStore.get(id, profile.id), null, 'not persisted');
});

test('null result -> skipped; thrown error -> error note', async () => {
  const id = await seedProfileResult([{ description: 'A', price: 1 }, { description: 'B', price: 2 }]);
  behavior = (item) => {
    if (item.description === 'A') return null;
    throw new Error('boom');
  };
  const out = await resolveProductsForProfileResult(id, profile.id);
  assert.equal(out.stats.resolved, 0);
  assert.equal(out.stats.skipped, 1);
  assert.equal(out.stats.errors, 1);
  assert.equal(out.products[0].productTitle, null);
  assert.equal(out.products[1].error, 'boom');
  behavior = (item) => ({ productTitle: `P:${item.description}`, productDescription: 'd', productUrl: 'https://x', confidence: 0.5 });
});

test('maxItems caps how many items hit the resolver', async () => {
  const id = await seedProfileResult([{ description: 'A', price: 1 }, { description: 'B', price: 2 }]);
  const prev = config.products.maxItems;
  config.products.maxItems = 1;
  try {
    const out = await resolveProductsForProfileResult(id, profile.id);
    assert.equal(out.stats.resolved, 1);
    assert.equal(out.stats.skipped, 1, 'second item skipped by the cap');
  } finally {
    config.products.maxItems = prev;
  }
});

test('disabled: all items skipped with null product fields', async () => {
  const id = await seedProfileResult([{ description: 'A', price: 1 }]);
  const prev = config.products.enabled;
  config.products.enabled = false;
  try {
    const out = await resolveProductsForProfileResult(id, profile.id);
    assert.equal(out.stats.skipped, 1);
    assert.equal(out.stats.resolved, 0);
    assert.equal(out.products[0].productTitle, null);
  } finally {
    config.products.enabled = prev;
  }
});

test('emoji from the resolver carries onto the product and persists', async () => {
  const id = await seedProfileResult([{ description: 'KS EGGS', price: 4.99 }]);
  behavior = (item) => ({ productTitle: `P:${item.description}`, productDescription: 'd', productUrl: 'https://x', emoji: '🥚', confidence: 0.5 });
  try {
    const out = await resolveProductsForProfileResult(id, profile.id);
    assert.equal(out.products[0].emoji, '🥚');
    const saved = await productStore.get(id, profile.id);
    assert.equal(saved.products[0].emoji, '🥚', 'emoji persisted');
  } finally {
    behavior = (item) => ({ productTitle: `P:${item.description}`, productDescription: 'd', productUrl: 'https://x', confidence: 0.5 });
  }
});

test('errors: unknown receipt -> 404, unknown profile -> 404, profile not applied -> 409', async () => {
  await assert.rejects(() => resolveProductsForProfileResult('nope', profile.id), (e) => e instanceof ResolveError && e.status === 404);

  const rec = await store.createReceipt({ buffer: Buffer.alloc(8, 1), mimeType: 'image/png', originalName: 'r.png', source: 'test' });
  await assert.rejects(() => resolveProductsForProfileResult(rec.id, 'noSuchProfile'), (e) => e.status === 404);
  // receipt + profile exist, but no profile result has been saved for this receipt
  await assert.rejects(() => resolveProductsForProfileResult(rec.id, profile.id), (e) => e.status === 409);
});
