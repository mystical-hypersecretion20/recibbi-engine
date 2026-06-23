'use strict';

// Load the project's .env so live tests pick up real keys (ANTHROPIC_API_KEY,
// TAVILY_API_KEY, ...). We check the app dir first, then the repo root, and use
// override:true on purpose: an empty `ANTHROPIC_API_KEY=""` exported in the
// shell would otherwise shadow the .env value (dotenv never overwrites an
// already-set variable). This runs before any live test reads process.env.
(() => {
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.resolve(__dirname, '..', '..', '.env'), // receipt-enricher/.env
    path.resolve(__dirname, '..', '..', '..', '.env'), // repo-root .env
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      require('dotenv').config({ path: p, override: true });
      break;
    }
  }
})();

// Helpers shared by the LIVE tests (test/live/*). These tests hit real
// services (the Anthropic/OpenAI API, real Tesseract, or a running stack) and
// PRINT the extracted receipt contents. They self-skip when prerequisites are
// missing, so they never break the default hermetic suite.
//
// Formatting only — no app modules required here, so callers can set
// process.env (DATA_DIR, OCR_PROVIDER, ...) before requiring config/store.

function money(n) {
  return n === null || n === undefined ? '   n/a' : `$${Number(n).toFixed(2)}`.padStart(8);
}

/** Render a parsed receipt ({store, items, totals}) as a readable block. */
function formatReceipt(parsed, { provider, rawText } = {}) {
  const lines = [];
  lines.push('────────────────────────────────────────────');
  lines.push(`  RECEIPT CONTENTS  (extractor: ${provider || '?'})`);
  lines.push('────────────────────────────────────────────');
  lines.push(`  Store: ${parsed.store?.name || 'Unknown'}` + (parsed.store?.date ? `   Date: ${parsed.store.date}` : ''));
  lines.push('  ' + '-'.repeat(42));
  for (const it of parsed.items || []) {
    const sku = it.sku ? ` [${it.sku}]` : '';
    const name = String(it.description || '').slice(0, 26).padEnd(26);
    lines.push(`  ${name}${money(it.price)}${sku}`);
    if (it.enrichment && it.enrichment.imageUrl) {
      lines.push(`      ↳ image: ${it.enrichment.imageUrl}`);
    }
  }
  lines.push('  ' + '-'.repeat(42));
  const t = parsed.totals || {};
  lines.push(`  Subtotal${money(t.subtotal).padStart(34)}`);
  lines.push(`  Tax     ${money(t.tax).padStart(34)}`);
  lines.push(`  TOTAL   ${money(t.total != null ? t.total : t.sumOfItems).padStart(34)}`);
  lines.push(`  (${(parsed.items || []).length} items, sum of items ${money(t.sumOfItems).trim()})`);
  lines.push('────────────────────────────────────────────');
  if (rawText) {
    lines.push('  RAW OCR TEXT:');
    lines.push(rawText.split('\n').map((l) => '    ' + l).join('\n'));
    lines.push('────────────────────────────────────────────');
  }
  return lines.join('\n');
}

// Defaults to the human-reviewed ground-truth Costco sample; override with
// SAMPLE_IMAGE to point the live tests at another photo (e.g. a rotated copy):
//   SAMPLE_IMAGE=../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-rotated.jpg npm run test:live:tesseract
const SAMPLE_IMAGE_PATH = process.env.SAMPLE_IMAGE
  ? require('path').resolve(process.env.SAMPLE_IMAGE)
  : require('path').resolve(
      __dirname,
      '..',
      '..',
      '..',
      'codex-receipt-ocr-human-reviewed-ground-truth',
      'samples',
      'costco',
      'costco-boca-raton-2026-05-26-original.jpg'
    );

module.exports = { formatReceipt, SAMPLE_IMAGE_PATH };
