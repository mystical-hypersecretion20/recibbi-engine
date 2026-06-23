'use strict';

// LIVE TEST — vision extraction across the whole sample corpus.
// Runs the real vision model over every photo in samples/costco/, prints a
// one-line summary per receipt, and asserts the invariants a good extraction
// must satisfy. It's a smoke test against real model output, so it self-skips
// when no vision API key is configured (and never runs under `npm test`).
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run test:live:samples
//   VISION_PROVIDER=openai OPENAI_API_KEY=sk-... npm run test:live:samples

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Configure BEFORE requiring config: force the vision path into a temp data dir.
const provider = (process.env.VISION_PROVIDER || 'anthropic').toLowerCase();
process.env.OCR_PROVIDER = 'vision';
process.env.VISION_PROVIDER = provider;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'samples-live-'));
process.env.DATA_DIR = tmpDir;

require('./_shared'); // loads .env (override) so the API key is picked up

const SAMPLES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'codex-receipt-ocr-human-reviewed-ground-truth',
  'samples',
  'costco'
);
const hasKey =
  (provider === 'anthropic' && !!process.env.ANTHROPIC_API_KEY) ||
  (provider === 'openai' && !!process.env.OPENAI_API_KEY);

// Drop "rotated_" copies — they're upright duplicates of another sample, so
// running them too would just bill a second vision call for the same receipt.
function sampleFiles() {
  try {
    return fs
      .readdirSync(SAMPLES_DIR)
      .filter((f) => /\.jpe?g$/i.test(f) && !/^rotated_/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

const m = (n) => (n == null ? '   n/a' : ('$' + Number(n).toFixed(2)).padStart(8));

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('vision reads every sample receipt in the corpus', { timeout: 300000 }, async (t) => {
  if (!hasKey) {
    t.skip(`no ${provider} API key set — export ANTHROPIC_API_KEY (or VISION_PROVIDER=openai + OPENAI_API_KEY)`);
    return;
  }
  const files = sampleFiles();
  if (files.length === 0) {
    t.skip(`no sample images found in ${SAMPLES_DIR}`);
    return;
  }

  const store = require('../../src/store');
  const ocr = require('../../src/ocr');
  const parser = require('../../src/parse/receiptParser');

  console.log(`\n  ${files.length} samples in ${SAMPLES_DIR}\n  ${'='.repeat(72)}`);

  let withTotals = 0;
  const shortfalls = [];

  for (const f of files) {
    const record = await store.createReceipt({
      buffer: fs.readFileSync(path.join(SAMPLES_DIR, f)),
      mimeType: 'image/jpeg',
      originalName: f,
    });
    const { rawText, structured, provider: used } = await ocr.extract(record);
    const parsed = structured
      ? parser.normalizeStructured(structured, rawText)
      : parser.parseText(rawText);
    const { store: st, items, totals } = parsed;

    const shortfall = totals.subtotal != null && totals.sumOfItems + 0.02 < totals.subtotal;
    if (totals.total != null || totals.subtotal != null) withTotals += 1;
    if (shortfall) shortfalls.push(f);

    console.log(
      `  ${f}\n    store=${(st?.name || '?').padEnd(8)} date=${st?.date || '?'}` +
        `  items=${String(totals.itemCount).padStart(2)}` +
        `  sub=${m(totals.subtotal)} tax=${m(totals.tax)} total=${m(totals.total)}` +
        `  match=${totals.subtotalMatch}` +
        (shortfall ? '  ⚠ shortfall (possible missing line)' : '')
    );

    // Per-receipt invariants a competent vision extraction must satisfy.
    assert.equal(used, 'vision', `${f}: used the vision path`);
    assert.ok(structured, `${f}: vision returned parseable JSON`);
    assert.ok(items.length > 0, `${f}: at least one line item`);
    assert.ok(st?.name, `${f}: a store name was identified`);
    assert.match(st.name, /costco/i, `${f}: recognized as Costco`);
    for (const it of items) {
      assert.equal(typeof it.price, 'number', `${f}: "${it.description}" has a numeric price`);
      assert.ok(Number.isFinite(it.price), `${f}: "${it.description}" price is finite`);
    }
  }

  console.log(`  ${'='.repeat(72)}`);
  console.log(`  totals captured on ${withTotals}/${files.length}; shortfalls: ${shortfalls.join(', ') || 'none'}`);

  // Corpus-level: extraction shouldn't be systemically broken.
  assert.ok(withTotals >= Math.ceil(files.length / 2), 'totals were captured on most receipts');
});
