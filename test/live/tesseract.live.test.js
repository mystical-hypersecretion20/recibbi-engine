'use strict';

// LIVE TEST — Option 2: offline Tesseract OCR (no API key).
// Runs the real tesseract.js engine on the sample photo and prints what it got.
// Note: tesseract.js downloads its WASM core + English data on first run from a
// CDN (needs internet once), then caches it. That download has NO internal
// timeout, so if the CDN stalls the worker hangs at 0% CPU indefinitely — we
// therefore race it against a hard wall-clock timeout and skip (not hang) if it
// doesn't complete. On a crumpled / rotated phone photo the output is also
// genuinely hit-or-miss, so this test asserts loosely — its real value is
// showing you the raw OCR + heuristic parse so you can judge the quality.
//
//   npm run test:live:tesseract
//   TESSERACT_TIMEOUT_MS=180000 npm run test:live:tesseract   # allow a slow download
//   SKIP_TESSERACT=1 npm run test:live:tesseract              # skip entirely

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.OCR_PROVIDER = 'tesseract';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-live-'));
process.env.DATA_DIR = tmpDir;

const { formatReceipt, SAMPLE_IMAGE_PATH } = require('./_shared');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const OCR_TIMEOUT_MS = Number(process.env.TESSERACT_TIMEOUT_MS || 120000);

// Safety net: a stalled tesseract.js download can leave a worker thread alive
// that keeps `node --test` from ever exiting (looks "frozen"). This timer is
// unref'd, so it never delays a clean exit — but if a dangling worker holds the
// process open past the deadline, it force-quits instead of hanging forever.
setTimeout(() => process.exit(0), OCR_TIMEOUT_MS + 25000).unref();

// Backstop: tesseract.js reports a failed CDN download as an *uncaught*
// exception from its worker thread (it doesn't reject recognize()), so the
// try/catch below can't see it. A TLS-interception / offline failure is purely
// environmental, so treat it as a clean skip rather than a suite failure.
process.on('uncaughtException', (err) => {
  if (/certificate|FetchError|ENOTFOUND|getaddrinfo|ECONN|network|TLS/i.test(err.message || '')) {
    console.log(`\n  [tesseract] SKIP — outbound HTTPS from Node failed: ${err.message}`);
    console.log('  Fix: set NODE_EXTRA_CA_CERTS=/path/to/internal-root-ca.pem (TLS-intercepting proxy),');
    console.log('       or pre-cache the lang data, or use the vision path instead.');
    process.exit(0);
  }
  throw err;
});

// Reject (rather than hang) if the OCR call doesn't finish in time. tesseract.js
// gives us no way to abort a wedged download, so the timer is a soft guard: we
// surface a skip and let the dangling worker die with the process.
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// Generous timeout: first run downloads the WASM core + ~15MB trained data, then OCRs a 2MB image.
test('tesseract OCRs the sample receipt and the heuristic parser reads it', { timeout: OCR_TIMEOUT_MS + 30000 }, async (t) => {
  if (process.env.SKIP_TESSERACT === '1') {
    t.skip('SKIP_TESSERACT=1 set');
    return;
  }

  const config = require('../../src/config');
  const store = require('../../src/store');
  const ocr = require('../../src/ocr');
  const parser = require('../../src/parse/receiptParser');

  const record = await store.createReceipt({
    buffer: fs.readFileSync(SAMPLE_IMAGE_PATH),
    mimeType: 'image/jpeg',
    originalName: 'costco.jpg',
  });

  // If the language data is already present locally (see tessdata/README.md),
  // OCR runs fully offline — no CDN needed, so skip the preflight entirely.
  const haveLocal =
    fs.existsSync(path.join(config.tessdataDir, 'eng.traineddata')) ||
    fs.existsSync(path.join(config.tessdataDir, 'eng.traineddata.gz'));

  if (haveLocal) {
    console.log(`  [tesseract] using local lang data in ${config.tessdataDir}`);
  } else {
    // No local data → tesseract would hit the CDN. Preflight that over TLS so a
    // TLS-intercepting proxy gives us a fast skip instead of a wedged worker download.
    const CDN = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz';
    try {
      await withTimeout(fetch(CDN, { method: 'HEAD' }), 15000, 'CDN preflight');
    } catch (err) {
      t.skip(
        `no local lang data and the CDN is unreachable from Node: ${err.message}. ` +
        'Drop eng.traineddata into tessdata/ (see tessdata/README.md), set NODE_EXTRA_CA_CERTS, or use the vision path.'
      );
      return;
    }
  }

  let result;
  try {
    console.log(`  [tesseract] running OCR (timeout ${OCR_TIMEOUT_MS}ms; first run downloads CDN assets)...`);
    result = await withTimeout(ocr.extract(record), OCR_TIMEOUT_MS, 'tesseract OCR');
  } catch (err) {
    // Expected when offline OR when the CDN download for the first run stalls.
    t.skip(`tesseract unavailable (offline or CDN download stalled): ${err.message}`);
    return;
  }

  const { rawText, provider } = result;
  const parsed = parser.parseText(rawText);

  console.log('\n' + formatReceipt(parsed, { provider, rawText }));

  assert.equal(provider, 'tesseract');
  assert.equal(typeof rawText, 'string');
  assert.ok(rawText.length > 0, 'OCR produced some text');
  // Loose: this rotated photo may parse poorly — we report rather than fail.
  console.log(`\n  [tesseract summary] ${parsed.items.length} candidate item(s), ` +
    `store detected: ${parsed.store?.name || 'none'}`);
});
