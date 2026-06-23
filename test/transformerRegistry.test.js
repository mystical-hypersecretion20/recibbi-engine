'use strict';

// Verifies the registry loads the shipped on-disk transformers via the runtime
// TS loader and that the usGrocery transformer behaves as intended.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/receiptProfiles/registry');
const { applyProfile } = require('../src/receiptProfiles/engine');

test('discovers the shipped usGrocery transformer', () => {
  assert.equal(registry.has('usGrocery'), true);
  const ids = registry.list().map((t) => t.id);
  assert.ok(ids.includes('usGrocery'));
  const meta = registry.list().find((t) => t.id === 'usGrocery');
  assert.equal(meta.name, 'usGrocery');
});

test('the types-only module is not registered as a transformer', () => {
  assert.equal(registry.has('types'), false);
});

test('unknown transformer id resolves to null', () => {
  assert.equal(registry.get('doesNotExist'), null);
});

test('usGrocery normalizes store, date, and Costco water items', () => {
  const t = registry.get('usGrocery');
  assert.ok(t && typeof t.transform === 'function');
  const record = {
    id: 'r1',
    store: { name: 'costco wholesale', date: '2026-05-26' },
    items: [
      { description: 'KS Water Gal', sku: '1', qty: 1, unitPrice: 4.99, price: 4.99, enrichment: null },
      { description: 'Butter Croissants', sku: '2', qty: 1, unitPrice: 5.99, price: 5.99, enrichment: null },
    ],
    totals: { subtotal: 10.98, tax: 0, total: 10.98 },
  };
  const out = applyProfile(record, t.transform, { receiptId: 'r1', config: {}, log() {} });
  assert.equal(out.store.name, 'Costco');
  assert.equal(out.store.date, '05-26-2026');
  assert.equal(out.items[0].description, 'Water 5 Liter');
  assert.equal(out.items[1].description, 'Butter Croissants');
});

const apply = (record) =>
  applyProfile(record, registry.get('usGrocery').transform, { receiptId: 'r', config: {}, log() {} });

test('Costco: folds an adjacent discount into the item it follows and drops the line', () => {
  // The discount line references the item's SKU in its description ("Discount
  // 975416") while carrying its own line number as `sku`.
  const out = apply({
    id: 'r',
    store: { name: 'Costco Wholesale', date: '2026-05-26' },
    items: [
      { description: 'SAN PELL MIN', sku: '975416', qty: null, unitPrice: null, price: 23.74, enrichment: null },
      { description: 'Discount 975416', sku: '0000372064', qty: null, unitPrice: null, price: -5.75, enrichment: null },
      { description: 'BUTTER CROISS', sku: '1199652', qty: null, unitPrice: null, price: 5.99, enrichment: null },
    ],
    totals: { subtotal: 23.98, tax: 0, total: 23.98 },
  });
  assert.equal(out.items.length, 2, 'discount line removed');
  assert.equal(out.items[0].description, 'SAN PELL MIN');
  assert.equal(out.items[0].price, 17.99, 'discount folded into price');
  assert.equal(out.items[0].discount, -5.75, 'discount recorded for display');
  assert.equal(out.items.some((i) => i.price < 0), false, 'no negative line remains');
  assert.equal(out.totals.sumOfItems, 23.98, 'sum is preserved');
});

test('Costco: matches a discount by SKU even when not adjacent', () => {
  // "Discount / 99006" applies to SWISS (sku 99006) two lines up.
  const out = apply({
    id: 'r',
    store: { name: 'Costco', date: null },
    items: [
      { description: 'SWISS', sku: '99006', qty: null, unitPrice: null, price: 15.73, enrichment: null },
      { description: 'CSR SLD KIT', sku: '9702', qty: null, unitPrice: null, price: 5.99, enrichment: null },
      { description: 'Discount / 99006', sku: '0000377227', qty: null, unitPrice: null, price: -4.25, enrichment: null },
    ],
    totals: { subtotal: 17.47, tax: 0, total: 17.47 },
  });
  const swiss = out.items.find((i) => i.sku === '99006');
  assert.equal(swiss.price, 11.48);
  assert.equal(swiss.discount, -4.25);
  assert.equal(out.items.length, 2);
});

test("Sam's Club: folds the bottom Instant Savings line into the named item", () => {
  const out = apply({
    id: 'r',
    store: { name: "SAM'S CLUB", date: '2026-02-19' },
    items: [
      { description: 'Dog Chow', sku: '0990065861', qty: 1, unitPrice: 26.78, price: 26.78, enrichment: null },
      { description: 'Detergent', sku: '0990411830', qty: 1, unitPrice: 19.98, price: 19.98, enrichment: null },
      { description: 'Dog Chow (Inst Sv)', sku: null, qty: 1, unitPrice: null, price: -1.8, enrichment: null },
    ],
    totals: { subtotal: 44.96, tax: 0, total: 44.96 },
  });
  assert.equal(out.store.name, "Sam's Club");
  assert.equal(out.items.length, 2, 'savings line removed');
  const dog = out.items.find((i) => i.description === 'Dog Chow');
  assert.equal(dog.price, 24.98);
  assert.equal(dog.discount, -1.8);
});

test("Sam's Club: leaves an unmatchable savings line in place rather than misattribute", () => {
  const out = apply({
    id: 'r',
    store: { name: "Sam's Club", date: null },
    items: [
      { description: 'Dog Chow', sku: '0990065861', qty: 1, unitPrice: 26.78, price: 26.78, enrichment: null },
      { description: 'Mystery (Inst Sv)', sku: null, qty: 1, unitPrice: null, price: -1.8, enrichment: null },
    ],
    totals: { subtotal: 24.98, tax: 0, total: 24.98 },
  });
  assert.equal(out.items.length, 2, 'unmatched savings line kept');
  assert.equal(out.items.find((i) => i.description === 'Dog Chow').discount ?? null, null);
  assert.ok(out.items.some((i) => i.price < 0), 'the savings line is still present');
});
