'use strict';

// Generic REST OCR client (src/ocr/rest.js): it resolves the backend URL from
// config.ocr.rest[provider], POSTs the receipt image as base64 JSON to
// `<url>/ocr` via the built-in http client, and maps the reply onto
// { rawText, structured }. We stub http.request so this stays hermetic (no
// network, no running sidecar). NB: rest.js deliberately uses http.request, not
// global fetch, to avoid undici's hidden 300s headersTimeout on slow OCR calls.

const { test, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');

const { useTempDataDir } = require('./helpers/harness');

const tmp = useTempDataDir('ocr-rest-test');
const config = require('../src/config');
const store = require('../src/store');
const rest = require('../src/ocr/rest');
const { SAMPLE_IMAGE_PATH } = require('./fixtures/costco-sample');

// Replace http.request with a fake that captures the outgoing request and feeds
// a canned response. handler(captured) -> { status, body }; throwing inside it
// (e.g. a failed assertion) surfaces as a request error → extract() rejection.
function stubHttp(handler) {
  const orig = http.request;
  http.request = (options, cb) => {
    const captured = { options, chunks: [] };
    const req = new EventEmitter();
    req.write = (data) => { captured.chunks.push(Buffer.from(data)); return true; };
    req.setTimeout = () => req;
    req.destroy = (err) => { req.emit('error', err); return req; };
    req.end = () => {
      let result;
      try {
        captured.body = Buffer.concat(captured.chunks).toString('utf8');
        result = handler(captured);
      } catch (err) {
        process.nextTick(() => req.emit('error', err));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = result.status;
      process.nextTick(() => {
        cb(res);
        res.emit('data', Buffer.from(result.body));
        res.emit('end');
      });
    };
    return req;
  };
  return () => { http.request = orig; };
}

const urlOf = (c) => `http://${c.options.hostname}:${c.options.port}${c.options.path}`;
const jsonRes = (obj, status = 200) => ({ status, body: JSON.stringify(obj) });

let record;
before(async () => {
  record = await store.createReceipt({
    buffer: fs.readFileSync(SAMPLE_IMAGE_PATH),
    mimeType: 'image/jpeg',
    originalName: 'costco.jpg',
  });
});
after(() => tmp.cleanup());

let restoreHttp;
let savedProvider;
beforeEach(() => {
  savedProvider = config.ocrProvider;
  config.ocrProvider = 'paddle';
  config.ocr.rest.paddle.url = 'http://ocr-paddle:8090';
});
afterEach(() => {
  config.ocrProvider = savedProvider;
  if (restoreHttp) restoreHttp();
  restoreHttp = null;
});

test('POSTs the base64 image to <backend>/ocr and returns its text', async () => {
  restoreHttp = stubHttp((c) => {
    assert.equal(urlOf(c), 'http://ocr-paddle:8090/ocr');
    assert.equal(c.options.method, 'POST');
    assert.equal(c.options.headers['content-type'], 'application/json');
    const body = JSON.parse(c.body);
    assert.equal(body.id, record.id);
    assert.equal(body.mimeType, 'image/jpeg');
    assert.ok(body.imageBase64.length > 100, 'real base64 image payload attached');
    return jsonRes({ text: 'KS SPARK WAT\n5DZ EGGS', lineCount: 2, profile: 'paddleocr-v6-small' });
  });

  const out = await rest.extract(record);
  assert.equal(out.rawText, 'KS SPARK WAT\n5DZ EGGS');
  assert.equal(out.structured, null, 'plain-text engines leave structured null for the heuristic parser');
});

test('passes through structured JSON when the backend supplies it', async () => {
  restoreHttp = stubHttp(() =>
    jsonRes({ text: 'raw', structured: { store: { name: 'Costco' }, items: [] } })
  );
  const out = await rest.extract(record);
  assert.equal(out.rawText, 'raw');
  assert.deepEqual(out.structured, { store: { name: 'Costco' }, items: [] });
});

test('uses the paddle-vl backend URL when that provider is selected', async () => {
  config.ocrProvider = 'paddle-vl';
  config.ocr.rest['paddle-vl'].url = 'http://ocr-paddle-vl:8090';
  restoreHttp = stubHttp((c) => {
    assert.equal(urlOf(c), 'http://ocr-paddle-vl:8090/ocr');
    return jsonRes({ text: 'vl text' });
  });
  const out = await rest.extract(record);
  assert.equal(out.rawText, 'vl text');
});

test('throws a clear error for an unconfigured provider', async () => {
  config.ocrProvider = 'nope';
  await assert.rejects(() => rest.extract(record), /not a known REST backend/);
});

test('surfaces a non-2xx backend response as a rejection', async () => {
  restoreHttp = stubHttp(() => ({ status: 502, body: '{"error":"boom"}' }));
  await assert.rejects(() => rest.extract(record), /paddle OCR backend 502/);
});

test('surfaces a structured {error} body as a rejection', async () => {
  restoreHttp = stubHttp(() => jsonRes({ error: 'model failed to load' }));
  await assert.rejects(() => rest.extract(record), /model failed to load/);
});

module.exports = {};
