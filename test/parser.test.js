'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const parser = require('../src/parse/receiptParser');
const { structured, rawOcrText, expected } = require('./fixtures/costco-sample');

// ---------------------------------------------------------------------------
// Heuristic path: raw Tesseract text -> canonical receipt
// ---------------------------------------------------------------------------

test('parseText detects the Costco store from the header', () => {
  const out = parser.parseText(rawOcrText);
  assert.ok(out.store, 'store should be detected');
  assert.equal(out.store.name, expected.storeName);
});

test('parseText extracts the real line items and prices', () => {
  const out = parser.parseText(rawOcrText);
  const descriptions = out.items.map((i) => i.description.toUpperCase());

  for (const fragment of expected.mustContain) {
    assert.ok(
      descriptions.some((d) => d.includes(fragment.toUpperCase())),
      `expected an item matching "${fragment}", got: ${descriptions.join(' | ')}`
    );
  }

  const wagyu = out.items.find((i) => /WAGYUBEEF/i.test(i.description));
  assert.ok(wagyu, 'wagyu beef line should be parsed');
  assert.equal(wagyu.price, 19.99, 'wagyu price should be the trailing amount');
});

test('parseText never treats totals / payment / member lines as items', () => {
  const out = parser.parseText(rawOcrText);
  for (const it of out.items) {
    for (const noise of expected.mustNotContain) {
      assert.ok(
        !new RegExp(`\\b${noise}\\b`, 'i').test(it.description),
        `noise "${noise}" leaked into item description: "${it.description}"`
      );
    }
  }
});

test('parseText pulls SKU numbers off the front of the line', () => {
  const out = parser.parseText(rawOcrText);
  const wagyu = out.items.find((i) => /WAGYUBEEF/i.test(i.description));
  assert.equal(wagyu.sku, '1455728');
});

test('parseText grabs TOTAL, not SUBTOTAL (regression guard)', () => {
  // Real bug fixed during development: the "total" grab matched "SUBTOTAL".
  const out = parser.parseText(rawOcrText);
  assert.equal(out.totals.subtotal, expected.subtotal);
  assert.equal(out.totals.tax, expected.tax);
  assert.equal(out.totals.total, expected.total);
  assert.notEqual(
    out.totals.total,
    out.totals.subtotal,
    'total must not be confused with subtotal'
  );
});

test('parseText reports an item count and a summed total', () => {
  const out = parser.parseText(rawOcrText);
  assert.equal(out.totals.itemCount, out.items.length);
  assert.ok(out.totals.itemCount >= 12, `expected >=12 items, got ${out.totals.itemCount}`);
  assert.equal(typeof out.totals.sumOfItems, 'number');
});

test('parseText drops the SKU-only discount line (no product name)', () => {
  // The "-5.75" line on the real receipt is "0000379335 / 975416" — pure SKU
  // numbers with no product name, so the junk filter correctly omits it.
  const out = parser.parseText(rawOcrText);
  const skuOnly = out.items.find((i) => /379335/.test(i.description));
  assert.equal(skuOnly, undefined, 'a description-less SKU line must not become an item');
});

test('parseText preserves negative prices on lines that have a description', () => {
  const out = parser.parseText('BOTTLE DEPOSIT REFUND   -5.75');
  const credit = out.items.find((i) => /DEPOSIT/i.test(i.description));
  assert.ok(credit, 'a discount line with a description should be parsed');
  assert.equal(credit.price, -5.75, 'negative prices must be preserved');
});

test('parseText returns an empty-but-valid shape for garbage input', () => {
  const out = parser.parseText('!!!! ???? \n ----');
  assert.equal(out.store, null);
  assert.deepEqual(out.items, []);
  assert.equal(out.totals.itemCount, 0);
  assert.equal(out.totals.sumOfItems, 0);
});

// ---------------------------------------------------------------------------
// Structured path: vision-model JSON -> canonical receipt
// ---------------------------------------------------------------------------

test('normalizeStructured keeps the vision items, store and totals', () => {
  const out = parser.normalizeStructured(structured, null);
  assert.equal(out.store.name, 'Costco');
  assert.equal(out.store.date, '2026-05-26');
  assert.equal(out.items.length, structured.items.length);
  assert.equal(out.totals.subtotal, 115.22);
  assert.equal(out.totals.total, 116.37);
  assert.equal(out.totals.itemCount, structured.items.length);
});

test('normalizeStructured coerces string prices to numbers and drops empties', () => {
  const out = parser.normalizeStructured(
    {
      store: { name: 'Sprouts', date: null },
      items: [
        { description: 'Bananas', price: '$1.29', qty: '2' },
        { description: '   ', price: 9.99 }, // empty description -> dropped
      ],
      totals: { subtotal: '10.00', tax: null, total: '$10.70' },
    },
    null
  );
  assert.equal(out.items.length, 1, 'blank-description items are filtered out');
  assert.equal(out.items[0].price, 1.29);
  assert.equal(out.items[0].qty, 2);
  assert.equal(out.totals.subtotal, 10.0);
  assert.equal(out.totals.total, 10.7);
});

test('normalizeStructured falls back to raw text for store/date when absent', () => {
  const out = parser.normalizeStructured(
    { items: [{ description: 'Milk', price: 3.5 }], totals: {} },
    'PUBLIX SUPER MARKET\n2026-01-02\nMilk 3.50'
  );
  assert.equal(out.store.name, 'Publix');
  assert.equal(out.store.date, '2026-01-02');
});

test('normalizeStructured canonicalizes a known store name to the chain', () => {
  // The vision model returns the full printed header; we collapse it to the
  // chain so it groups with the OCR path (which detects the bare name).
  const out = parser.normalizeStructured(
    { store: { name: 'Costco Wholesale', date: null }, items: [{ description: 'X', price: 1 }], totals: {} },
    null
  );
  assert.equal(out.store.name, 'Costco');
});

test('normalizeStructured keeps an unknown store name verbatim', () => {
  const out = parser.normalizeStructured(
    { store: { name: "Maria's Corner Market", date: null }, items: [{ description: 'X', price: 1 }], totals: {} },
    null
  );
  assert.equal(out.store.name, "Maria's Corner Market");
});

test('subtotalMatch is true when items reconcile with the subtotal', () => {
  const out = parser.normalizeStructured(
    {
      items: [{ description: 'A', price: 10 }, { description: 'B', price: 5.5 }],
      totals: { subtotal: 15.5, tax: 1, total: 16.5 },
    },
    null
  );
  assert.equal(out.totals.sumOfItems, 15.5);
  assert.equal(out.totals.subtotalMatch, true);
});

test('subtotalMatch is false on a shortfall (a likely missed line item)', () => {
  // Mirrors sample costco-daytona-2026-03-09: items sum well under the printed subtotal.
  const out = parser.normalizeStructured(
    {
      items: [{ description: 'A', price: 10 }, { description: 'B', price: 5 }],
      totals: { subtotal: 30, tax: 0, total: 30 },
    },
    null
  );
  assert.equal(out.totals.sumOfItems, 15);
  assert.equal(out.totals.subtotalMatch, false);
});

test('subtotalMatch is null when no subtotal was extracted', () => {
  const out = parser.normalizeStructured(
    { items: [{ description: 'A', price: 10 }], totals: { subtotal: null, tax: null, total: null } },
    null
  );
  assert.equal(out.totals.subtotalMatch, null);
});

test('both extraction paths agree on store and total for the sample', () => {
  const viaVision = parser.normalizeStructured(structured, null);
  const viaOcr = parser.parseText(rawOcrText);
  assert.equal(viaVision.store.name, viaOcr.store.name);
  assert.equal(viaVision.totals.total, viaOcr.totals.total);
});
