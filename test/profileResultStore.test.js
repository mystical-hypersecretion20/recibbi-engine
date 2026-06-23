'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');

const tmp = useTempDataDir('profile-result-store-test');
const resultStore = require('../src/receiptProfiles/resultStore');

after(() => tmp.cleanup());

function result(receiptId, profileId, appliedAt) {
  return {
    receiptId,
    profileId,
    profileName: 'p',
    profileVersion: 1,
    appliedAt,
    store: { name: 'Costco', date: '05-26-2026' },
    items: [],
    totals: { itemCount: 0, sumOfItems: 0 },
    changes: [],
  };
}

test('save then get round-trips a result', async () => {
  await resultStore.save(result('r1', 'rp_a', '2026-06-04T10:00:00.000Z'));
  const got = await resultStore.get('r1', 'rp_a');
  assert.equal(got.receiptId, 'r1');
  assert.equal(got.store.name, 'Costco');
});

test('get returns null for a missing result; list returns [] for a missing receipt', async () => {
  assert.equal(await resultStore.get('r1', 'rp_missing'), null);
  assert.deepEqual(await resultStore.list('nobody'), []);
});

test('list returns all results for a receipt, newest first', async () => {
  await resultStore.save(result('r2', 'rp_old', '2026-06-04T09:00:00.000Z'));
  await resultStore.save(result('r2', 'rp_new', '2026-06-04T11:00:00.000Z'));
  const list = await resultStore.list('r2');
  assert.equal(list.length, 2);
  assert.equal(list[0].profileId, 'rp_new', 'sorted by appliedAt desc');
});

test('saving the same receipt+profile overwrites (one result per pair)', async () => {
  await resultStore.save(result('r3', 'rp_x', '2026-06-04T09:00:00.000Z'));
  await resultStore.save(result('r3', 'rp_x', '2026-06-04T12:00:00.000Z'));
  const list = await resultStore.list('r3');
  assert.equal(list.length, 1);
  assert.equal(list[0].appliedAt, '2026-06-04T12:00:00.000Z');
});

test('listAll flattens results across all receipts, newest first', async () => {
  // r1/r2/r3 already seeded above (4 results total); add one more receipt.
  await resultStore.save(result('r4', 'rp_y', '2026-06-04T13:00:00.000Z'));
  const all = await resultStore.listAll();
  assert.equal(all.length, 5, 'r1:1 + r2:2 + r3:1 + r4:1');
  assert.equal(all[0].appliedAt, '2026-06-04T13:00:00.000Z', 'sorted by appliedAt desc');
  // spans more than one receipt
  assert.ok(new Set(all.map((r) => r.receiptId)).size > 1);
});

test('listByProfile returns only one profile id, across all receipts, newest first', async () => {
  // Same profile id applied to two different receipts.
  await resultStore.save(result('r5', 'rp_shared', '2026-06-04T08:00:00.000Z'));
  await resultStore.save(result('r6', 'rp_shared', '2026-06-04T14:00:00.000Z'));
  const list = await resultStore.listByProfile('rp_shared');
  assert.equal(list.length, 2);
  assert.ok(list.every((r) => r.profileId === 'rp_shared'));
  assert.deepEqual(list.map((r) => r.receiptId), ['r6', 'r5'], 'newest first, spans receipts');
  assert.deepEqual(await resultStore.listByProfile('rp_none'), [], 'unknown id -> []');
});
