'use strict';

// Pure-engine tests. The engine runs a transformer's `transform` entrypoint
// against a copy of the record, then auto-derives the change trail and totals.
// No Redis, network, disk, or transformer loading — we pass plain functions.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyProfile } = require('../src/receiptProfiles/engine');

function sampleRecord() {
  return {
    id: 'r1',
    store: { name: 'COSTCO WHOLESALE', date: '2026-05-26' },
    items: [
      { description: 'KS WATER GAL', sku: '931484', qty: 1, unitPrice: 4.99, price: 4.99, enrichment: null },
      { description: 'US WAGYU BEEF', sku: '1455728', qty: 1, unitPrice: 19.99, price: 19.99, enrichment: null },
    ],
    totals: { subtotal: 24.98, tax: 0, total: 24.98, itemCount: 2, sumOfItems: 24.98, subtotalMatch: true },
  };
}

const noCtx = { receiptId: 'r1', config: {}, log() {} };

// A transformer like usGrocery, written inline as a plain function.
const normalize = (receipt) => {
  if (receipt.store.name && /costco/i.test(receipt.store.name)) receipt.store.name = 'Costco';
  if (receipt.store.date) receipt.store.date = receipt.store.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2-$3-$1');
  if (receipt.store.name === 'Costco') {
    for (const it of receipt.items) if (/water/i.test(it.description)) it.description = 'Water 5 Liter';
  }
};

test('runs the transformer and reflects its mutations', () => {
  const out = applyProfile(sampleRecord(), normalize, noCtx);
  assert.equal(out.store.name, 'Costco');
  assert.equal(out.store.date, '05-26-2026');
  assert.equal(out.items[0].description, 'Water 5 Liter');
  assert.equal(out.items[1].description, 'US WAGYU BEEF');
});

test('auto-derives the change/audit trail from the diff', () => {
  const out = applyProfile(sampleRecord(), normalize, noCtx);
  const fields = out.changes.map((c) => c.field);
  assert.ok(fields.includes('store.name'));
  assert.ok(fields.includes('store.date'));
  const itemChange = out.changes.find((c) => c.field === 'item.description');
  assert.equal(itemChange.itemIndex, 0);
  assert.equal(itemChange.from, 'KS WATER GAL');
  assert.equal(itemChange.to, 'Water 5 Liter');
});

test('never mutates the source record', () => {
  const record = sampleRecord();
  applyProfile(record, normalize, noCtx);
  assert.equal(record.store.name, 'COSTCO WHOLESALE');
  assert.equal(record.store.date, '2026-05-26');
  assert.equal(record.items[0].description, 'KS WATER GAL');
});

test('recomputes totals like the parser', () => {
  const out = applyProfile(sampleRecord(), normalize, noCtx);
  assert.equal(out.totals.itemCount, 2);
  assert.equal(out.totals.sumOfItems, 24.98);
  assert.equal(out.totals.subtotalMatch, true);
  assert.equal(out.totals.total, 24.98);
});

test('a no-op transformer yields no changes', () => {
  const out = applyProfile(sampleRecord(), () => {}, noCtx);
  assert.equal(out.changes.length, 0);
  assert.equal(out.store.name, 'COSTCO WHOLESALE');
});

test('a transformer may return a new draft instead of mutating', () => {
  const out = applyProfile(sampleRecord(), (r) => ({
    store: { name: 'NEW', date: r.store.date },
    items: r.items,
    totals: r.totals,
  }), noCtx);
  assert.equal(out.store.name, 'NEW');
});

test('diffs numeric item fields too', () => {
  const out = applyProfile(sampleRecord(), (r) => { r.items[1].price = 21.99; }, noCtx);
  const c = out.changes.find((x) => x.field === 'item.price');
  assert.equal(c.from, 19.99);
  assert.equal(c.to, 21.99);
  assert.equal(c.itemIndex, 1);
  assert.equal(out.totals.sumOfItems, 26.98, 'totals reflect the new price');
});

test('passes config and receiptId through ctx', () => {
  let seen;
  applyProfile(sampleRecord(), (r, ctx) => { seen = ctx; }, { receiptId: 'abc', config: { k: 1 }, log() {} });
  assert.equal(seen.receiptId, 'abc');
  assert.deepEqual(seen.config, { k: 1 });
});

test('a mid-list removal reports a clean remove, not a positional cascade', () => {
  // Remove items[1] (e.g. a discount line folded into the line before it). The
  // alignment keys on SKU, so the surviving items still match by identity.
  const out = applyProfile(sampleRecord(), (r) => {
    r.items[0].price = 4.99 - 1; // net after a folded discount
    r.items.splice(1, 1);
  }, noCtx);
  const removed = out.changes.filter((c) => c.removed);
  assert.equal(removed.length, 1, 'exactly one removal');
  assert.equal(removed[0].from, 'US WAGYU BEEF');
  // The kept item shows only its real change, no bogus rename.
  const renames = out.changes.filter((c) => c.field === 'item.description');
  assert.equal(renames.length, 0, 'no spurious description changes');
  const priceChange = out.changes.find((c) => c.field === 'item.price');
  assert.equal(priceChange.itemIndex, 0);
});

test('aligns by SKU so a rename is a field change, not remove+add', () => {
  const out = applyProfile(sampleRecord(), (r) => { r.items[0].description = 'Renamed'; }, noCtx);
  assert.equal(out.changes.filter((c) => c.added || c.removed).length, 0);
  const c = out.changes.find((x) => x.field === 'item.description');
  assert.equal(c.itemIndex, 0);
  assert.equal(c.to, 'Renamed');
});

test('reports a folded-in discount on the item.discount field', () => {
  const out = applyProfile(sampleRecord(), (r) => {
    r.items[0].price = 3.99;
    r.items[0].discount = -1;
  }, noCtx);
  const d = out.changes.find((c) => c.field === 'item.discount');
  assert.equal(d.from, null);
  assert.equal(d.to, -1);
  assert.equal(d.itemIndex, 0);
});

test('handles a record with no store/items without throwing', () => {
  const out = applyProfile({ id: 'x', store: null, items: [], totals: null }, normalize, noCtx);
  assert.equal(out.items.length, 0);
  assert.equal(out.totals.itemCount, 0);
  assert.equal(out.totals.sumOfItems, 0);
  assert.equal(out.changes.length, 0);
});
