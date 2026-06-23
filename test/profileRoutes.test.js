'use strict';

// HTTP-surface tests for the Receipt Profiles API (code-transformer model).
// Same hermetic setup as routes.test.js: temp DATA_DIR, fake Redis, stubbed
// queue, real Express over loopback. Profiles reference the shipped usGrocery
// transformer (loaded by the registry via the runtime TS loader).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('profile-routes-test');
installFakeRedis();

const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => ({ id: `receipt-${id}` }),
    receiptsQueue: {},
    connection: {},
  },
};

const store = require('../src/store');
const { createApp } = require('../src/app');

let server;
let base;

const validProfile = { name: 'routesTest1', description: 'd', transformer: 'usGrocery' };

async function seedDoneReceipt() {
  const rec = await store.createReceipt({
    buffer: Buffer.alloc(16, 1),
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'test',
  });
  await store.update(rec.id, {
    status: 'done',
    store: { name: 'COSTCO WHOLESALE', date: '2026-05-26' },
    items: [
      { description: 'KS WATER GAL', sku: '931484', qty: 1, unitPrice: 4.99, price: 4.99, enrichment: null },
      { description: 'US WAGYU BEEF', sku: '1455728', qty: 1, unitPrice: 19.99, price: 19.99, enrichment: null },
    ],
    totals: { subtotal: 24.98, tax: 0, total: 24.98, itemCount: 2, sumOfItems: 24.98, subtotalMatch: true },
  });
  return rec.id;
}

const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

test('GET /api/transformers lists the shipped usGrocery transformer', async () => {
  const res = await fetch(`${base}/api/transformers`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(list.some((t) => t.id === 'usGrocery'));
});

test('POST /api/receiptProfiles creates a profile -> 201', async () => {
  const res = await post('/api/receiptProfiles', validProfile);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.id, /^rp_/);
  assert.equal(body.transformer, 'usGrocery');
  assert.equal(body.version, 1);
});

test('POST with an unknown transformer -> 400 with details', async () => {
  const res = await post('/api/receiptProfiles', { name: 'bad1', transformer: 'noSuch' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(Array.isArray(body.details) && body.details.some((d) => /unknown transformer/i.test(d)));
});

test('GET /api/receiptProfiles lists summaries with the transformer ref', async () => {
  const list = await (await fetch(`${base}/api/receiptProfiles`)).json();
  const row = list.find((p) => p.name === 'routesTest1');
  assert.ok(row);
  assert.equal(row.transformer, 'usGrocery');
});

test('GET /api/receiptProfiles/:id resolves by name and id; 404 otherwise', async () => {
  const byName = await (await fetch(`${base}/api/receiptProfiles/routesTest1`)).json();
  assert.equal(byName.name, 'routesTest1');
  const byId = await (await fetch(`${base}/api/receiptProfiles/${byName.id}`)).json();
  assert.equal(byId.id, byName.id);
  assert.equal((await fetch(`${base}/api/receiptProfiles/missing`)).status, 404);
});

test('POST applyProfile (by name) -> 200, runs transformer and persists', async () => {
  const id = await seedDoneReceipt();
  const res = await post(`/api/receipts/${id}/applyProfile/routesTest1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.store.name, 'Costco');
  assert.equal(body.store.date, '05-26-2026');
  assert.equal(body.items[0].description, 'Water 5 Liter');
  assert.equal(body.transformer, 'usGrocery');
  assert.ok(body.changes.length >= 3);

  const list = await (await fetch(`${base}/api/receipts/${id}/profileResults`)).json();
  assert.equal(list.length, 1);
  const one = await (await fetch(`${base}/api/receipts/${id}/profileResults/routesTest1`)).json();
  assert.equal(one.store.name, 'Costco');
});

test('GET /api/profileResults lists results across all receipts (newest first)', async () => {
  const a = await seedDoneReceipt();
  const b = await seedDoneReceipt();
  assert.equal((await post(`/api/receipts/${a}/applyProfile/routesTest1`)).status, 200);
  assert.equal((await post(`/api/receipts/${b}/applyProfile/routesTest1`)).status, 200);

  const all = await (await fetch(`${base}/api/profileResults`)).json();
  assert.ok(Array.isArray(all));
  const ids = all.map((r) => r.receiptId);
  assert.ok(ids.includes(a) && ids.includes(b), 'spans both receipts');
});

test('GET /profileResults renders an HTML list linking to each result view', async () => {
  const id = await seedDoneReceipt();
  assert.equal((await post(`/api/receipts/${id}/applyProfile/routesTest1`)).status, 200);

  const res = await fetch(`${base}/profileResults`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
  const html = await res.text();
  assert.ok(html.includes(`/receipts/${id}/profileResults/`), 'links to the per-result view');
  assert.ok(html.includes('routesTest1'), 'shows the profile name');
});

test('GET /api/profileResults/:profileId filters by profile (resolves a name)', async () => {
  const a = await seedDoneReceipt();
  const b = await seedDoneReceipt();
  assert.equal((await post(`/api/receipts/${a}/applyProfile/routesTest1`)).status, 200);
  assert.equal((await post(`/api/receipts/${b}/applyProfile/routesTest1`)).status, 200);

  const byName = await (await fetch(`${base}/api/profileResults/routesTest1`)).json();
  assert.ok(byName.length >= 2);
  assert.ok(byName.every((r) => r.profileName === 'routesTest1'), 'only this profile');
  assert.ok(byName.map((r) => r.receiptId).includes(a), 'spans receipts');

  const unknown = await (await fetch(`${base}/api/profileResults/noSuchProfile`)).json();
  assert.deepEqual(unknown, [], 'unknown profile -> empty list');
});

test('GET /profileResults/:profileId renders the filtered HTML list', async () => {
  const id = await seedDoneReceipt();
  assert.equal((await post(`/api/receipts/${id}/applyProfile/routesTest1`)).status, 200);

  const res = await fetch(`${base}/profileResults/routesTest1`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
  const html = await res.text();
  assert.ok(html.includes('Profile results for'), 'shows the filter heading');
  assert.ok(html.includes(`/receipts/${id}/profileResults/`), 'links to the per-result view');
});

test('POST applyProfile?dryRun=1 -> 200 but does NOT persist', async () => {
  const id = await seedDoneReceipt();
  const res = await post(`/api/receipts/${id}/applyProfile/routesTest1?dryRun=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.store.name, 'Costco');
  const list = await (await fetch(`${base}/api/receipts/${id}/profileResults`)).json();
  assert.equal(list.length, 0, 'dry run leaves nothing on disk');
});

async function seedCostcoWithDiscount() {
  const rec = await store.createReceipt({
    buffer: Buffer.alloc(16, 1),
    mimeType: 'image/png',
    originalName: 'r.png',
    source: 'test',
  });
  await store.update(rec.id, {
    status: 'done',
    store: { name: 'COSTCO WHOLESALE', date: '2026-05-26' },
    items: [
      { description: 'SAN PELL MIN', sku: '975416', qty: null, unitPrice: null, price: 23.74, enrichment: null },
      { description: 'Discount 975416', sku: '0000372064', qty: null, unitPrice: null, price: -5.75, enrichment: null },
    ],
    totals: { subtotal: 17.99, tax: 0, total: 17.99, itemCount: 2, sumOfItems: 17.99, subtotalMatch: true },
  });
  return rec.id;
}

test('GET profileResults/:profileId/view renders HTML with the discount folded in', async () => {
  const id = await seedCostcoWithDiscount();
  // No stored result yet -> the view computes it fresh (dryRun).
  const res = await fetch(`${base}/receipts/${id}/profileResults/routesTest1/view`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
  const html = await res.text();
  assert.ok(html.includes('Profile applied'), 'profile banner rendered');
  assert.ok(html.includes('promo'), 'discount surfaced on the line');
  assert.ok(html.includes('$17.99'), 'net price shown');
  assert.ok(!/Discount 975416/.test(html), 'no separate discount row');
});

test('GET profileResults/:profileId/view -> 404 for unknown receipt', async () => {
  const res = await fetch(`${base}/receipts/nope/profileResults/routesTest1/view`);
  assert.equal(res.status, 404);
});

test('applyProfile -> 404 for unknown receipt or unknown profile', async () => {
  const id = await seedDoneReceipt();
  assert.equal((await post(`/api/receipts/nope/applyProfile/routesTest1`)).status, 404);
  assert.equal((await post(`/api/receipts/${id}/applyProfile/noSuchProfile`)).status, 404);
});

test('DELETE /api/receiptProfiles/:id -> 204 then 404', async () => {
  await post('/api/receiptProfiles', { ...validProfile, name: 'toDelete1' });
  const del = await fetch(`${base}/api/receiptProfiles/toDelete1`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  assert.equal((await fetch(`${base}/api/receiptProfiles/toDelete1`)).status, 404);
});

test('GET /health includes a receiptProfiles count', async () => {
  const body = await (await fetch(`${base}/health`)).json();
  assert.equal(typeof body.receiptProfiles, 'number');
  assert.ok(body.receiptProfiles >= 1);
});
