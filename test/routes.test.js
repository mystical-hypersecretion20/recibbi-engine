'use strict';

// HTTP-surface tests for the REST API + web views. These drive the *real*
// Express app (built via createApp) over a loopback socket with the real global
// fetch — no external network. They stay hermetic the same way the rest of the
// suite does: a temp DATA_DIR, an in-memory fake Redis, and a stubbed queue so
// no BullMQ/Redis connection is ever opened.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('routes-test');
installFakeRedis(); // app /health -> ../redis cache().ping()

// Replace src/queue so requiring the routes never instantiates a BullMQ Queue
// (which would try to open a real Redis connection at module load).
const enqueued = [];
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => {
      enqueued.push(id);
      return { id: `receipt-${id}` };
    },
    receiptsQueue: {},
    connection: {},
  },
};

const config = require('../src/config');
// Small upload cap so we can exercise the 413 path with a tiny buffer. Must be
// set before requiring the app, since multer captures it at route-load time.
config.maxUploadBytes = 4096;
config.publicBaseUrl = 'http://localhost:8080';

const store = require('../src/store');
const { createApp } = require('../src/app');

let server;
let base;

// A few hundred bytes of "image" — store.createReceipt just persists the bytes,
// it doesn't decode them, so any buffer with an image/* mimetype is fine.
const smallImage = Buffer.alloc(256, 7);

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

function uploadForm(buffer, { field = 'receipt', type = 'image/png', name = 'r.png' } = {}) {
  const fd = new FormData();
  fd.append(field, new Blob([buffer], { type }), name);
  return fd;
}

test('POST /api/receipts with no file -> 400', async () => {
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: new FormData() });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /receipt/i);
  assert.equal(enqueued.length, 0, 'nothing queued on a rejected upload');
});

test('POST /api/receipts rejects a non-image upload -> 400', async () => {
  const fd = new FormData();
  fd.append('receipt', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'note.txt');
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: fd });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /image/i);
});

test('POST /api/receipts over the size limit -> 413', async () => {
  const tooBig = Buffer.alloc(config.maxUploadBytes + 1, 9);
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: uploadForm(tooBig) });
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.match(body.error, /too large|file size/i);
});

test('POST /api/receipts (field "receipt") -> 202, queues, persists', async () => {
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: uploadForm(smallImage) });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'queued');
  assert.ok(body.id, 'returns an id');
  assert.equal(body.statusUrl, `http://localhost:8080/api/receipts/${body.id}`);
  assert.equal(body.viewUrl, `http://localhost:8080/receipts/${body.id}/view`);

  // The job was enqueued with the new id, and the record is on disk.
  assert.ok(enqueued.includes(body.id), 'receipt id was enqueued');
  const persisted = await store.get(body.id);
  assert.equal(persisted.status, 'queued');
  assert.equal(persisted.source, 'api');
  assert.equal(persisted.image.size, smallImage.length);
});

test('POST /api/receipts accepts the alternate field name "image"', async () => {
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    body: uploadForm(smallImage, { field: 'image' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.ok(body.id);
});

test('GET /api/receipts lists records with the summary shape', async () => {
  const res = await fetch(`${base}/api/receipts`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 2, 'earlier uploads show up');
  const row = list[0];
  for (const key of ['id', 'status', 'itemCount', 'createdAt', 'statusUrl', 'viewUrl']) {
    assert.ok(key in row, `row has ${key}`);
  }
  // Full per-record fields (e.g. image/items) are not leaked into the list.
  assert.ok(!('image' in row), 'list rows are summaries, not full records');
});

test('GET /api/receipts?limit clamps the page size', async () => {
  const res = await fetch(`${base}/api/receipts?limit=1`);
  const list = await res.json();
  assert.equal(list.length, 1, 'limit=1 returns a single row');

  // A bogus limit falls back to the default rather than erroring.
  const res2 = await fetch(`${base}/api/receipts?limit=not-a-number`);
  assert.equal(res2.status, 200);
});

test('GET /api/receipts/:id -> 404 for unknown, record + links when found', async () => {
  const missing = await fetch(`${base}/api/receipts/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not found' });

  const created = await store.createReceipt({
    buffer: smallImage,
    mimeType: 'image/png',
    originalName: 'x.png',
    source: 'cli',
  });
  const res = await fetch(`${base}/api/receipts/${created.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, created.id);
  assert.equal(body.source, 'cli');
  assert.equal(body.statusUrl, `http://localhost:8080/api/receipts/${created.id}`);
});

test('GET /receipts/:id/view -> 404 then HTML', async () => {
  const missing = await fetch(`${base}/receipts/nope/view`);
  assert.equal(missing.status, 404);

  const created = await store.createReceipt({
    buffer: smallImage,
    mimeType: 'image/png',
    originalName: 'x.png',
    source: 'api',
  });
  const res = await fetch(`${base}/receipts/${created.id}/view`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<html|<!DOCTYPE/i);
});

test('GET /receipts/:id/image -> 404 then the original bytes', async () => {
  const missing = await fetch(`${base}/receipts/nope/image`);
  assert.equal(missing.status, 404);

  const created = await store.createReceipt({
    buffer: smallImage,
    mimeType: 'image/png',
    originalName: 'x.png',
    source: 'api',
  });
  const res = await fetch(`${base}/receipts/${created.id}/image`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/png/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.length, smallImage.length, 'serves the stored image byte-for-byte');
});

test('GET / renders the receipts list page', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  assert.match(await res.text(), /<html|<!DOCTYPE/i);
});

test('GET /health reports ok with Redis up', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.redis, 'up');
  assert.ok('ocrProvider' in body);
  assert.ok('enrichment' in body);
});
