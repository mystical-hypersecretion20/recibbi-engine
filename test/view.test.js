'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const view = require('../src/web/view');
const { structured } = require('./fixtures/costco-sample');
const parser = require('../src/parse/receiptParser');

function sampleRecord(overrides = {}) {
  const parsed = parser.normalizeStructured(structured, null);
  return {
    id: 'abc123def4567890',
    status: 'done',
    source: 'cli',
    createdAt: new Date('2026-05-26T10:00:00Z').toISOString(),
    image: { file: 'abc.jpg', originalName: 'costco.jpg', mimeType: 'image/jpeg' },
    extraction: { provider: 'vision' },
    store: parsed.store,
    items: parsed.items,
    totals: parsed.totals,
    summary: 'Costco: 12 item(s), total $116.37. 0 item(s) matched with images/metadata.',
    error: null,
    ...overrides,
  };
}

test('renderReceipt produces a full HTML document', () => {
  const html = view.renderReceipt(sampleRecord());
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<\/html>\s*$/);
  assert.ok(html.includes('Costco'), 'store name is rendered');
});

test('renderReceipt lists items, prices and the grand total', () => {
  const html = view.renderReceipt(sampleRecord());
  assert.ok(html.includes('US WAGYUBEEF'), 'item description shown');
  assert.ok(html.includes('$19.99'), 'item price shown');
  assert.ok(html.includes('$116.37'), 'grand total shown');
  assert.ok(html.includes('SKU 1455728'), 'SKU shown in the item sub-line');
});

test('renderReceipt renders an enrichment image when present', () => {
  const record = sampleRecord();
  record.items[0].enrichment = {
    imageUrl: 'https://img.example/water.jpg',
    snippet: 'Kirkland Signature water',
    url: 'https://example.com/water',
  };
  const html = view.renderReceipt(record);
  assert.ok(html.includes('https://img.example/water.jpg'), 'image url rendered');
  assert.ok(html.includes('Kirkland Signature water'), 'snippet rendered');
});

test('renderReceipt escapes HTML to prevent injection from receipt text', () => {
  const record = sampleRecord({
    store: { name: '<script>alert(1)</script>', date: null },
    items: [{ description: '<img src=x onerror=alert(2)>', price: 1.0, enrichment: null }],
    summary: null,
  });
  const html = view.renderReceipt(record);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag must be escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'store name is HTML-escaped');
  assert.ok(html.includes('&lt;img src=x'), 'item description is HTML-escaped');
});

test('renderReceipt flags a subtotal shortfall as a possible missing line', () => {
  const record = sampleRecord({
    items: [{ description: 'A', price: 10, enrichment: null }],
    totals: { subtotal: 30, tax: 0, total: 30, itemCount: 1, sumOfItems: 10, subtotalMatch: false },
    summary: null,
  });
  const html = view.renderReceipt(record);
  assert.match(html, /under subtotal/i, 'shortfall warning shown');
  assert.ok(html.includes('a line may be missing'), 'explains the likely cause');
});

test('renderReceipt notes an overage as excluded discounts, not a warning', () => {
  const record = sampleRecord({
    items: [{ description: 'A', price: 30, enrichment: null }],
    totals: { subtotal: 25, tax: 0, total: 25, itemCount: 1, sumOfItems: 30, subtotalMatch: false },
    summary: null,
  });
  const html = view.renderReceipt(record);
  assert.match(html, /excludes discounts/i, 'overage explained as discounts');
  assert.ok(!/a line may be missing/.test(html), 'an overage is not flagged as missing');
});

test('renderReceipt confirms reconciliation when items match the subtotal', () => {
  const record = sampleRecord({
    items: [{ description: 'A', price: 25, enrichment: null }],
    totals: { subtotal: 25, tax: 0, total: 25, itemCount: 1, sumOfItems: 25, subtotalMatch: true },
    summary: null,
  });
  assert.match(view.renderReceipt(record), /items reconcile/i);
});

test('renderReceipt shows an error banner and status for a failed receipt', () => {
  const html = view.renderReceipt(
    sampleRecord({ status: 'failed', error: 'Anthropic API 401', summary: null, items: [] })
  );
  assert.ok(html.includes('Anthropic API 401'), 'error message surfaced');
  assert.ok(html.includes('failed'), 'status reflected');
  assert.ok(html.includes('No line items yet'), 'empty-state shown when no items');
});

test('renderReceipt surfaces a folded-in discount on the line item', () => {
  const record = sampleRecord({
    items: [{ description: 'SAN PELL MIN', sku: '975416', price: 17.99, discount: -5.75, enrichment: null }],
    totals: { subtotal: 17.99, tax: 0, total: 17.99, itemCount: 1, sumOfItems: 17.99, subtotalMatch: true },
    summary: null,
  });
  const html = view.renderReceipt(record);
  assert.match(html, /promo/i, 'discount labelled');
  assert.ok(html.includes('$5.75'), 'discount amount shown');
  assert.ok(html.includes('$23.74'), 'pre-discount price struck through');
  assert.ok(html.includes('$17.99'), 'net price shown');
});

test('renderProfileResult renders the transformed receipt with a profile banner', () => {
  const record = sampleRecord();
  const result = {
    receiptId: record.id,
    profileId: 'rp_abc',
    profileName: 'usGrocery1',
    transformer: 'usGrocery',
    store: { name: 'Costco', date: '05-26-2026' },
    items: [
      { description: 'SAN PELL MIN', sku: '975416', price: 17.99, discount: -5.75, enrichment: null },
      { description: 'BUTTER CROISS', sku: '1199652', price: 5.99, enrichment: null },
    ],
    totals: { subtotal: 23.98, tax: 0, total: 23.98, itemCount: 2, sumOfItems: 23.98, subtotalMatch: true },
    changes: [],
  };
  const html = view.renderProfileResult(record, result);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('Profile applied'), 'banner present');
  assert.ok(html.includes('usGrocery1'), 'profile name shown');
  assert.ok(html.includes('1 discount folded'), 'folded-discount count noted');
  assert.ok(html.includes('promo'), 'discount shown on the line');
  assert.ok(html.includes(`/receipts/${record.id}/view`), 'links back to the raw receipt');
  assert.ok(html.includes(`/api/receipts/${record.id}/profileResults/rp_abc`), 'links to result JSON');
});

test('renderProfileResult escapes profile and store text', () => {
  const record = sampleRecord();
  const html = view.renderProfileResult(record, {
    receiptId: record.id,
    profileId: 'rp_x',
    profileName: '<script>x</script>',
    transformer: 'usGrocery',
    store: { name: '<b>store</b>', date: null },
    items: [],
    totals: {},
    changes: [],
  });
  assert.ok(!html.includes('<script>x</script>'), 'profile name escaped');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderList renders rows for each receipt and an empty state', () => {
  const rows = view.renderList([
    sampleRecord(),
    sampleRecord({ id: 'second0000000000', store: { name: 'Sprouts', date: null } }),
  ]);
  assert.ok(rows.includes('Costco'));
  assert.ok(rows.includes('Sprouts'));
  assert.ok(rows.includes('/receipts/abc123def4567890/view'), 'links to the detail view');

  const empty = view.renderList([]);
  assert.ok(empty.includes('No receipts yet'), 'empty list state');
});

function sampleProductResult(overrides = {}) {
  return {
    receiptId: 'abc123def4567890',
    receiptProfileId: 'rp_1',
    receiptProfileName: 'usGrocery1',
    resolver: 'anthropic',
    model: 'claude-haiku-4-5',
    store: { name: 'Costco', date: '2026-05-26' },
    stats: { resolved: 2, skipped: 0, cached: 0, errors: 0 },
    products: [
      { lineItem: { description: 'KS EGGS', price: 4.99 }, productTitle: 'Kirkland Eggs', productDescription: 'Eggs.', productUrl: 'https://x', emoji: '🥚', confidence: 0.9, error: null },
      { lineItem: { description: 'MYSTERY ITEM', price: 1.0 }, productTitle: null, productDescription: null, productUrl: null, emoji: null, confidence: null, error: null },
    ],
    ...overrides,
  };
}

test('renderProductResult shows the product emoji in the image placeholder', () => {
  const html = view.renderProductResult(sampleRecord(), sampleProductResult());
  assert.match(html, /class="thumb emoji"[^>]*>🥚</, 'emoji rendered in the thumb');
  assert.ok(html.includes('Kirkland Eggs'));
  // The item without an emoji falls back to the same "no image" placeholder.
  assert.match(html, /class="thumb empty">no image</);
});

test('renderProductResult escapes an emoji aria-label drawn from product text', () => {
  const result = sampleProductResult({
    products: [{ lineItem: { description: 'x' }, productTitle: '<script>', emoji: '🥚', error: null }],
  });
  const html = view.renderProductResult(sampleRecord(), result);
  assert.ok(!html.includes('<script>'), 'product title is escaped in the aria-label');
});

test('esc handles null/undefined without throwing', () => {
  assert.equal(view.esc(null), '');
  assert.equal(view.esc(undefined), '');
  assert.equal(view.esc('a & b "c"'), 'a &amp; b &quot;c&quot;');
});
