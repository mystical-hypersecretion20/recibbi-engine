'use strict';

// Verifies the tesseractGroceryUs transformer (v3). It de-noises Tesseract OCR
// *toward the receipt's printed text* (the verbatim vision ground truth): it
// strips leading junk + the embedded SKU, removes stray OCR glyphs, and
// UPPER-cases WITHOUT expanding abbreviations or Title-Casing; recovers the
// store from item shape; drops phantom register/quantity/garbage rows; and
// re-signs discount lines (Tesseract drops their trailing "-"), keeping them as
// their own negative line like the ground truth. The fixtures below are real
// shapes from the sample corpus (see analysis/).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../src/receiptProfiles/registry');
const { applyProfile } = require('../src/receiptProfiles/engine');

const mk = (description, sku = null, price = 1) => ({
  description,
  sku,
  qty: null,
  unitPrice: null,
  price,
  enrichment: null,
});

const run = (record) =>
  applyProfile(record, registry.get('tesseractGroceryUs').transform, {
    receiptId: record.id || 't',
    config: {},
    log() {},
  });

test('registry discovers the tesseractGroceryUs transformer', () => {
  assert.equal(registry.has('tesseractGroceryUs'), true);
  const meta = registry.list().find((t) => t.id === 'tesseractGroceryUs');
  assert.ok(meta);
  assert.equal(meta.name, 'tesseractGroceryUs');
});

test('strips leading junk + SKU and keeps the printed name VERBATIM (uppercase, no expansion)', () => {
  const out = run({
    id: 'r1',
    store: { name: 'Costco', date: null },
    items: [
      mk('EC 1199652 BUTER CROISS', '1199652'),
      mk('| oC 975416 SAN PELL MIN', '975416'),
      mk('BS [1948524 TRIMO YOGURT', '1948524'),
      mk('EE: 7017 3LB ORG ENVY', null), // sku-less: leading junk + misread code still stripped
      mk('I EE 1165284 KS MEX CHEES', '1165284'),
    ],
    totals: {},
  });
  assert.deepEqual(
    out.items.map((i) => i.description),
    ['BUTER CROISS', 'SAN PELL MIN', 'TRIMO YOGURT', '3LB ORG ENVY', 'KS MEX CHEES']
  );
});

test('strips stray OCR-noise glyphs but keeps real separators', () => {
  const out = run({
    id: 'r2',
    store: { name: 'Costco', date: null },
    items: [
      mk('E 9262015 KS SPARK WAT ~~', '9262015'),
      mk('E 331222 SOUR| CREAM', '331222'),
      mk('a 6262016 #¥KS BATH»', '6262016'),
      mk('0990384526 COLD_SMK_SA', '0990384526'), // underscores are real, kept
    ],
    totals: {},
  });
  assert.deepEqual(
    out.items.map((i) => i.description),
    ['KS SPARK WAT', 'SOUR CREAM', 'KS BATH', 'COLD_SMK_SA']
  );
});

test('strips a leading lone digit left where the "E" line-marker was misread', () => {
  const out = run({
    id: 'r3',
    store: { name: 'Costco', date: null },
    items: [mk('8 1948524 TRIMO YOGURT', '1948524'), mk('| 3 7950 AB COSMIC', '7950')],
    totals: {},
  });
  assert.deepEqual(out.items.map((i) => i.description), ['TRIMO YOGURT', 'AB COSMIC']);
});

test('infers Costco from Kirkland items when the header is lost', () => {
  const out = run({
    id: 'c1',
    store: { name: null, date: null },
    items: [mk('E 931484 KS WATER GAL', '931484'), mk('E 9262015 KS SPARK WAT', '9262015')],
    totals: {},
  });
  assert.equal(out.store.name, 'Costco');
});

test("infers Sam's Club from 10-digit zero-padded SKUs (curly-apostrophe header is lost)", () => {
  const out = run({
    id: 's1',
    store: { name: null, date: null },
    items: [mk('0990065861 DOG CHOW', '0990065861', 26.78), mk('0990411830 DETERGENT', '0990411830', 19.98)],
    totals: {},
  });
  assert.equal(out.store.name, "Sam's Club");
});

test('drops quantity-breakdown rows the parser mistakes for items', () => {
  const out = run({
    id: 's2',
    store: { name: "Sam's Club", date: null },
    items: [mk('0980242818 COSMIC CRIS', '0980242818', 4.92), mk('2 AT 1 FOR 6.57', null, 13.14)],
    totals: {},
  });
  assert.deepEqual(out.items.map((i) => i.description), ['COSMIC CRIS']);
});

test('drops leaked register/summary noise and pure-garbage rows', () => {
  const out = run({
    id: 'n1',
    store: { name: 'Costco', date: null },
    items: [
      mk('E 1068083 ORG FR EGGS', '1068083', 7.69),
      mk('a SUBTOTA', null, 56.66), // mangled SUBTOTAL
      mk('TRAX', null, 0), // mangled TAX
      mk('Eo ™ §', null, 1.36), // pure OCR garbage (no >=3-letter word)
      mk('SHOPPING CARD REDEMPTION', null, 4.39),
    ],
    totals: {},
  });
  assert.deepEqual(out.items.map((i) => i.description), ['ORG FR EGGS']);
});

test('drops a summary line whose price equals the printed subtotal/total', () => {
  const out = run({
    id: 'n2',
    store: { name: 'Costco', date: null },
    items: [mk('E 331222 SOUR CREAM', '331222', 5.49), mk('HOLA:', null, 62.94)],
    totals: { subtotal: 62.94 },
  });
  assert.deepEqual(out.items.map((i) => i.description), ['SOUR CREAM']);
});

test('re-signs a Costco discount line and keeps it as its own negative line (verbatim ref)', () => {
  const out = run({
    id: 'd1',
    store: { name: 'Costco', date: null },
    items: [
      mk('a 99006 SWISS', '99006', 15.73),
      mk('BEE 0000377227 / 99006', '0000377227', 4.25), // discount ref, minus lost
    ],
    totals: {},
  });
  assert.equal(out.items.length, 2, 'discount kept as a separate line (like ground truth)');
  assert.equal(out.items[0].description, 'SWISS');
  assert.equal(out.items[0].price, 15.73, 'product price untouched (not folded)');
  assert.equal(out.items[1].description, '0000377227 / 99006');
  assert.equal(out.items[1].price, -4.25, 'sign recovered');
});

test("re-signs a Sam's instant-savings line to negative", () => {
  const out = run({
    id: 'd2',
    store: { name: "Sam's Club", date: null },
    items: [mk('0990411830 DETERGENT', '0990411830', 19.98), mk('Ins? SY DoG CHOW', null, 1.8)],
    totals: {},
  });
  assert.equal(out.items.length, 2);
  assert.equal(out.items[1].price, -1.8);
});

test('output descriptions satisfy the cleanup invariants', () => {
  const out = run({
    id: 'inv',
    store: { name: 'Costco', date: null },
    items: [
      mk('E 9262015 KS Fo WAT ~~', '9262015'),
      mk('| E 99006 BWISS', '99006'),
      mk('E 47729 /TENDERLOIN', '47729'),
    ],
    totals: {},
  });
  for (const it of out.items) {
    const d = it.description;
    assert.ok(d.length > 0, 'non-empty');
    assert.equal(d, d.trim(), 'no leading/trailing whitespace');
    assert.ok(!/ {2,}/.test(d), `no double spaces: ${JSON.stringify(d)}`);
    assert.equal(d, d.toUpperCase(), `uppercase (printed style): ${JSON.stringify(d)}`);
  }
  // "E 47729 /TENDERLOIN" -> leading SKU + slash stripped.
  assert.equal(out.items[2].description, 'TENDERLOIN');
});

test('already-printed-style descriptions are only uppercased, not mangled', () => {
  const out = run({
    id: 'clean',
    store: { name: 'Costco', date: null },
    items: [mk('Butter Croissants', '2', 5.99)],
    totals: {},
  });
  assert.equal(out.items[0].description, 'BUTTER CROISSANTS');
});
