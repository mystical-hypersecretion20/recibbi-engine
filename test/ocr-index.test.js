'use strict';

// Provider dispatch for src/ocr/index.js: it picks vision, tesseract, or a
// generic REST backend from config.ocrProvider, delegates to that module's
// extract(record), and tags the result with the provider name. We stub all
// three provider modules in the require cache so this stays a pure unit test
// (no keys, no network, no Tesseract, no remote OCR service).

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');
useTempDataDir('ocr-index-test');

const config = require('../src/config');

// Install fakes for the two provider modules before requiring ocr/index. Each
// records the record it was handed so we can assert it was the one delegated to.
function fakeProvider(out) {
  return { calls: [], async extract(record) { this.calls.push(record); return out; } };
}
const visionFake = fakeProvider({ rawText: null, structured: { store: { name: 'V' } } });
const tessFake = fakeProvider({ rawText: 'raw', structured: null });
const restFake = fakeProvider({ rawText: 'paddle text', structured: null });

for (const [rel, exp] of [
  ['../src/ocr/vision', visionFake],
  ['../src/ocr/tesseract', tessFake],
  ['../src/ocr/rest', restFake],
]) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
}

const ocr = require('../src/ocr');

beforeEach(() => {
  visionFake.calls.length = 0;
  tessFake.calls.length = 0;
  restFake.calls.length = 0;
});

test("ocrProvider='vision' delegates to the vision module and tags provider", async () => {
  config.ocrProvider = 'vision';
  const record = { id: 'r1' };
  const out = await ocr.extract(record);

  assert.equal(out.provider, 'vision');
  assert.deepEqual(out.structured, { store: { name: 'V' } });
  assert.equal(out.rawText, null);
  assert.equal(visionFake.calls.length, 1);
  assert.equal(visionFake.calls[0], record, 'passes the record straight through');
  assert.equal(tessFake.calls.length, 0, 'tesseract not touched');
});

test("ocrProvider='tesseract' delegates to the tesseract module and tags provider", async () => {
  config.ocrProvider = 'tesseract';
  const record = { id: 'r2' };
  const out = await ocr.extract(record);

  assert.equal(out.provider, 'tesseract');
  assert.equal(out.rawText, 'raw');
  assert.equal(out.structured, null);
  assert.equal(tessFake.calls.length, 1);
  assert.equal(visionFake.calls.length, 0, 'vision not touched');
});

for (const provider of ['paddle', 'paddle-vl']) {
  test(`ocrProvider='${provider}' delegates to the REST module and tags provider`, async () => {
    config.ocrProvider = provider;
    const record = { id: 'r3' };
    const out = await ocr.extract(record);

    assert.equal(out.provider, provider, 'tagged with the configured provider name');
    assert.equal(out.rawText, 'paddle text');
    assert.equal(out.structured, null);
    assert.equal(restFake.calls.length, 1);
    assert.equal(restFake.calls[0], record, 'passes the record straight through');
    assert.equal(visionFake.calls.length, 0, 'vision not touched');
    assert.equal(tessFake.calls.length, 0, 'tesseract not touched');
  });
}
