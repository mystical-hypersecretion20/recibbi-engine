'use strict';

// HTTP-surface tests for the Products API + web views. Same hermetic setup as
// routes.test.js: temp DATA_DIR, fake Redis, a stubbed queue, real Express over
// loopback. The Anthropic key is forced empty so the sync resolve path degrades
// (all items skipped) instead of hitting the network.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('products-routes-test');
installFakeRedis();

const enqueued = { resolve: [] };
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => ({ id: `receipt-${id}` }),
    enqueueProcessAndApply: async () => ({}),
    enqueueProcessApplyAndResolve: async () => ({}),
    enqueueApplyProfile: async () => ({}),
    enqueueResolveProducts: async (id, profileId) => {
      enqueued.resolve.push({ id, profileId });
      return { id: `resolveProducts-${id}-${profileId}` };
    },
    receiptsQueue: {},
    connection: {},
  },
};

const config = require('../src/config');
config.publicBaseUrl = 'http://localhost:8080';
config.products.anthropic.apiKey = ''; // force degrade -> no network in sync resolve

const store = require('../src/store');
const profileStore = require('../src/receiptProfiles/profileStore');
const profileResultStore = require('../src/receiptProfiles/resultStore');
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
  await store.update(rec.id, { status: 'done', store: { name: 'Costco', date: '2026-05-26' }, items, totals: {} });
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
  profile = await profileStore.create({ name: 'prodRoutes1', transformer: 'usGrocery' });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

test('GET /api/productResolvers lists the active resolver', async () => {
  const res = await fetch(`${base}/api/productResolvers`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.active, 'anthropic');
  assert.ok(body.resolvers.some((r) => r.id === 'anthropic'));
});

test('POST resolveProducts (sync) degrades gracefully and persists a result', async () => {
  const id = await seedAppliedReceipt();
  const res = await fetch(`${base}/api/receipts/${id}/profileResults/${profile.id}/resolveProducts`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.products.length, 2);
  assert.equal(body.stats.skipped, 2, 'skipped (no key) rather than network call');
  assert.equal(body.receiptProfileId, profile.id);

  // persisted -> readable
  const got = await fetch(`${base}/api/receipts/${id}/products/${profile.id}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).products.length, 2);
});

test('POST resolveProducts?dryRun=1 does not persist', async () => {
  const id = await seedAppliedReceipt();
  const res = await fetch(`${base}/api/receipts/${id}/profileResults/${profile.id}/resolveProducts?dryRun=1`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).dryRun, true);
  const got = await fetch(`${base}/api/receipts/${id}/products/${profile.id}`);
  assert.equal(got.status, 404, 'nothing persisted');
});

test('POST resolveProducts?async=1 enqueues and returns 202 + productsUrl', async () => {
  enqueued.resolve.length = 0;
  const id = await seedAppliedReceipt();
  const res = await fetch(`${base}/api/receipts/${id}/profileResults/${profile.id}/resolveProducts?async=1`, { method: 'POST' });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'queued');
  assert.equal(body.productsUrl, `http://localhost:8080/api/receipts/${id}/products/${profile.id}`);
  assert.deepEqual(enqueued.resolve, [{ id, profileId: profile.id }]);
});

test('POST resolveProducts?async=1 -> 409 when the profile was not applied', async () => {
  enqueued.resolve.length = 0;
  const rec = await store.createReceipt({ buffer: Buffer.alloc(8, 1), mimeType: 'image/png', originalName: 'r.png', source: 'test' });
  const res = await fetch(`${base}/api/receipts/${rec.id}/profileResults/${profile.id}/resolveProducts?async=1`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(enqueued.resolve.length, 0);
});

test('POST resolveProducts (sync) -> 404 for an unknown receipt', async () => {
  const res = await fetch(`${base}/api/receipts/nope/profileResults/${profile.id}/resolveProducts`, { method: 'POST' });
  assert.equal(res.status, 404);
});

test('product result is readable by profile name too, and listed', async () => {
  const id = await seedAppliedReceipt();
  await fetch(`${base}/api/receipts/${id}/profileResults/${profile.id}/resolveProducts`, { method: 'POST' });

  const byName = await fetch(`${base}/api/receipts/${id}/products/prodRoutes1`);
  assert.equal(byName.status, 200);

  const perReceipt = await fetch(`${base}/api/receipts/${id}/products`);
  assert.equal((await perReceipt.json()).length, 1);

  const all = await fetch(`${base}/api/products`);
  assert.ok((await all.json()).length >= 1);
});

test('HTML views render', async () => {
  const id = await seedAppliedReceipt();
  await fetch(`${base}/api/receipts/${id}/profileResults/${profile.id}/resolveProducts`, { method: 'POST' });

  const list = await fetch(`${base}/products`);
  assert.equal(list.status, 200);
  assert.match(await list.text(), /Costco/);

  const detail = await fetch(`${base}/receipts/${id}/products/${profile.id}/view`);
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Products resolved/);

  const missing = await fetch(`${base}/receipts/${id}/products/noSuchProfile/view`);
  assert.equal(missing.status, 404);
});
