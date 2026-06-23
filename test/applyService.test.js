'use strict';

// Unit tests for the shared apply service (src/receiptProfiles/applyService.js)
// — the logic the sync route and the BullMQ worker both call. Hermetic: a temp
// DATA_DIR + fake Redis, no network. Seeds a `done` receipt and a profile bound
// to the shipped usGrocery transformer, then applies it directly (no HTTP).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('apply-service-test');
installFakeRedis();

const store = require('../src/store');
const profileStore = require('../src/receiptProfiles/profileStore');
const resultStore = require('../src/receiptProfiles/resultStore');
const { applyProfileToReceipt, ApplyError } = require('../src/receiptProfiles/applyService');

let receiptId;
let profile;

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

before(async () => {
  receiptId = await seedDoneReceipt();
  profile = await profileStore.create({ name: 'svcTest1', transformer: 'usGrocery' });
});

after(() => {
  tmp.cleanup();
});

test('applies the transformer and persists a result keyed by profile id', async () => {
  const result = await applyProfileToReceipt(receiptId, profile.id);
  assert.equal(result.store.name, 'Costco');
  assert.equal(result.store.date, '05-26-2026');
  assert.equal(result.items[0].description, 'Water 5 Liter');
  assert.equal(result.transformer, 'usGrocery');
  assert.equal(result.profileId, profile.id);
  assert.equal(result.dryRun, false);
  assert.ok(result.changes.length >= 3);

  // Persisted on disk under the profile id.
  const persisted = await resultStore.get(receiptId, profile.id);
  assert.ok(persisted);
  assert.equal(persisted.store.name, 'Costco');
});

test('resolves the profile by name too', async () => {
  const result = await applyProfileToReceipt(receiptId, 'svcTest1');
  assert.equal(result.profileId, profile.id);
  assert.equal(result.store.name, 'Costco');
});

test('dryRun returns the result but does not persist', async () => {
  const rec = await seedDoneReceipt();
  const result = await applyProfileToReceipt(rec, profile.id, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.store.name, 'Costco');
  assert.equal(await resultStore.get(rec, profile.id), null);
});

test('never mutates the source receipt record', async () => {
  const before = await store.get(receiptId);
  await applyProfileToReceipt(receiptId, profile.id);
  const afterRec = await store.get(receiptId);
  assert.equal(afterRec.store.name, 'COSTCO WHOLESALE', 'source store name unchanged');
  assert.equal(afterRec.items[0].description, 'KS WATER GAL', 'source item unchanged');
  assert.deepEqual(afterRec.store, before.store);
});

test('throws ApplyError 404 for an unknown receipt', async () => {
  await assert.rejects(
    () => applyProfileToReceipt('nope', profile.id),
    (err) => err instanceof ApplyError && err.status === 404
  );
});

test('throws ApplyError 404 for an unknown profile', async () => {
  await assert.rejects(
    () => applyProfileToReceipt(receiptId, 'noSuchProfile'),
    (err) => err instanceof ApplyError && err.status === 404
  );
});
