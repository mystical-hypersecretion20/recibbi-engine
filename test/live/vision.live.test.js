'use strict';

// LIVE TEST — Option 1: real vision-model extraction.
// Sends the actual sample photo to Anthropic (or OpenAI) and prints the items.
// Skips automatically when no vision API key is configured.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run test:live:vision
//   VISION_PROVIDER=openai OPENAI_API_KEY=sk-... npm run test:live:vision

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Configure BEFORE requiring config: force the vision path into a temp data dir.
const provider = (process.env.VISION_PROVIDER || 'anthropic').toLowerCase();
process.env.OCR_PROVIDER = 'vision';
process.env.VISION_PROVIDER = provider;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-live-'));
process.env.DATA_DIR = tmpDir;

const { formatReceipt, SAMPLE_IMAGE_PATH } = require('./_shared');

const hasKey =
  (provider === 'anthropic' && !!process.env.ANTHROPIC_API_KEY) ||
  (provider === 'openai' && !!process.env.OPENAI_API_KEY);

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('vision model reads the sample receipt and returns structured items', { timeout: 120000 }, async (t) => {
  if (!hasKey) {
    t.skip(`no ${provider} API key set — export ANTHROPIC_API_KEY (or VISION_PROVIDER=openai + OPENAI_API_KEY)`);
    return;
  }

  const store = require('../../src/store');
  const ocr = require('../../src/ocr');
  const parser = require('../../src/parse/receiptParser');

  const record = await store.createReceipt({
    buffer: fs.readFileSync(SAMPLE_IMAGE_PATH),
    mimeType: 'image/jpeg',
    originalName: 'costco.jpg',
  });

  const { rawText, structured, provider: used } = await ocr.extract(record);
  const parsed = structured
    ? parser.normalizeStructured(structured, rawText)
    : parser.parseText(rawText);

  console.log('\n' + formatReceipt(parsed, { provider: `vision/${provider}` }));

  assert.equal(used, 'vision');
  assert.ok(structured, 'vision model returned parseable JSON');
  assert.ok(parsed.items.length > 0, 'at least one line item extracted');
  assert.ok(parsed.store?.name, 'a store name was identified');
  // The sample is a Costco receipt — a good vision model should say so.
  assert.match(parsed.store.name, /costco/i, 'recognized the Costco header');
});
