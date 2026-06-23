'use strict';

// Product cache export/import: the productCache.exportEntries/importEntries
// functions and the REST endpoints (/api/products/cache/{export,import,stats})
// that the `products` CLI drives. Hermetic: in-memory fake Redis (extended with
// scan/ttl), stubbed queue, real Express over loopback.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('products-cache-io-test');
const fakeRedis = installFakeRedis();

// Stub the queue so requiring the app never opens real Redis for BullMQ.
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

const productCache = require('../src/products/productCache');
const productEvents = require('../src/products/productEvents');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

test('exportEntries dumps cache entries and EXCLUDES the monitor event log', async () => {
  fakeRedis.store.clear();
  await productCache.set('products:anthropic:aaa', { productTitle: 'Water', confidence: 0.9 });
  await productCache.set('products:anthropic:bbb', { productTitle: 'Eggs', confidence: 0.4 });
  // Event-log keys live in the same namespace but must NOT be exported.
  await productEvents.record({ outcome: 'hit', sku: '1', description: 'X' });

  const entries = await productCache.exportEntries();
  assert.equal(entries.length, 2, 'only the 2 cache entries, not the event list/seq');
  const keys = entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ['products:anthropic:aaa', 'products:anthropic:bbb']);
  assert.ok(entries.every((e) => !e.key.startsWith('products:events')));
  const water = entries.find((e) => e.key === 'products:anthropic:aaa');
  assert.equal(water.value.productTitle, 'Water');
});

test('importEntries restores into a flushed cache; malformed/reserved entries skipped', async () => {
  fakeRedis.store.clear();
  await productCache.set('products:anthropic:stale', { productTitle: 'Stale' });

  const payload = [
    { key: 'products:anthropic:new1', value: { productTitle: 'New One' }, ttlSeconds: 600 },
    { key: 'products:anthropic:new2', value: { productTitle: 'New Two' } }, // no ttl -> default
    { key: 'products:events', value: ['nope'] }, // reserved -> skipped
    { key: 'not-a-product-key', value: {} }, // wrong namespace -> skipped
    { key: 'products:anthropic:bad', value: null }, // null value -> skipped
  ];
  const res = await productCache.importEntries(payload, { flush: true });
  assert.equal(res.imported, 2, 'two valid entries imported');
  assert.equal(res.skipped, 3, 'reserved + wrong-namespace + null skipped');
  assert.equal(res.flushed, 1, 'pre-existing entry flushed');

  const after = await productCache.exportEntries();
  assert.deepEqual(after.map((e) => e.key).sort(), ['products:anthropic:new1', 'products:anthropic:new2']);
});

test('round-trip: export -> import into a clean cache reproduces it', async () => {
  fakeRedis.store.clear();
  await productCache.set('products:anthropic:r1', { productTitle: 'RT1', confidence: 0.7 });
  await productCache.set('products:anthropic:r2', { productTitle: 'RT2' });
  const snapshot = await productCache.exportEntries();

  fakeRedis.store.clear();
  assert.equal(await productCache.count(), 0, 'cache empty after wipe');
  const res = await productCache.importEntries(snapshot);
  assert.equal(res.imported, 2);
  assert.equal(await productCache.count(), 2, 'restored');
});

test('GET /api/products/cache/export returns a typed document', async () => {
  fakeRedis.store.clear();
  await productCache.set('products:anthropic:http1', { productTitle: 'HttpOne' });
  const res = await fetch(`${base}/api/products/cache/export`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'receipt-enricher/products-cache');
  assert.equal(body.version, 1);
  assert.equal(body.count, 1);
  assert.equal(body.entries[0].key, 'products:anthropic:http1');
});

test('POST /api/products/cache/import accepts a doc and a bare array; ?flush=1 works', async () => {
  fakeRedis.store.clear();

  // Full export document.
  const doc = {
    type: 'receipt-enricher/products-cache',
    version: 1,
    entries: [{ key: 'products:anthropic:imp1', value: { productTitle: 'Imp1' }, ttlSeconds: 300 }],
  };
  let res = await fetch(`${base}/api/products/cache/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.imported, 1);
  assert.equal(body.flushed, 0);

  // Bare array + flush.
  res = await fetch(`${base}/api/products/cache/import?flush=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ key: 'products:anthropic:imp2', value: { productTitle: 'Imp2' } }]),
  });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.imported, 1);
  assert.equal(body.flushed, 1, 'flushed the previously-imported entry');

  // Stats reflect the final state.
  const stats = await (await fetch(`${base}/api/products/cache/stats`)).json();
  assert.equal(stats.entries, 1);

  // Bad body -> 400.
  res = await fetch(`${base}/api/products/cache/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nope: true }),
  });
  assert.equal(res.status, 400);
});
