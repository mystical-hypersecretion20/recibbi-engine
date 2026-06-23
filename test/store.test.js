'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { useTempDataDir } = require('./helpers/harness');
const { SAMPLE_IMAGE_PATH } = require('./fixtures/costco-sample');

// Redirect DATA_DIR to a temp folder BEFORE config/store load.
const tmp = useTempDataDir('store-test');
const store = require('../src/store');

before(() => {
  assert.ok(fs.existsSync(SAMPLE_IMAGE_PATH), `sample image missing: ${SAMPLE_IMAGE_PATH}`);
});
after(() => tmp.cleanup());

function sampleBuffer() {
  return fs.readFileSync(SAMPLE_IMAGE_PATH);
}

test('createReceipt persists the real sample image and an initial record', async () => {
  const buffer = sampleBuffer();
  const record = await store.createReceipt({
    buffer,
    mimeType: 'image/jpeg',
    originalName: 'costco-boca-raton-2026-05-26-original.jpg',
    source: 'cli',
  });

  // The id is the COMPOSITE id <tenant>:<user>:<cacheId>. With no identity
  // passed, it falls back to the configured default (main:main).
  assert.match(record.id, /^main:main:[0-9a-f]{16}$/, 'id is a composite tenant:user:cacheId token');
  assert.equal(record.tenantId, 'main');
  assert.equal(record.userId, 'main');
  assert.equal(record.status, 'queued', 'new receipts start queued');
  assert.equal(record.source, 'cli');
  assert.equal(record.image.size, buffer.length, 'stored size matches the upload');
  assert.match(record.image.file, /\.jpg$/, 'jpeg maps to a .jpg extension');
  assert.deepEqual(record.items, []);
  assert.equal(record.totals, null);

  // The bytes actually hit disk and round-trip intact.
  const onDisk = fs.readFileSync(store.imagePathFor(record));
  assert.equal(onDisk.length, buffer.length);
  assert.ok(onDisk.equals(buffer), 'persisted image is byte-identical to the sample');
});

test('get returns null for an unknown id (not a throw)', async () => {
  assert.equal(await store.get('deadbeefdeadbeef'), null);
});

test('save/get round-trips the full record', async () => {
  const record = await store.createReceipt({
    buffer: sampleBuffer(),
    mimeType: 'image/jpeg',
    originalName: 'r.jpg',
  });
  const fetched = await store.get(record.id);
  assert.equal(fetched.id, record.id);
  assert.equal(fetched.image.file, record.image.file);
});

test('update merges a patch and bumps updatedAt', async () => {
  const record = await store.createReceipt({
    buffer: sampleBuffer(),
    mimeType: 'image/jpeg',
    originalName: 'r.jpg',
  });
  const before = record.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  const updated = await store.update(record.id, {
    status: 'done',
    items: [{ description: 'KS WATER GAL', price: 4.99 }],
  });
  assert.equal(updated.status, 'done');
  assert.equal(updated.items.length, 1);
  assert.equal(updated.image.file, record.image.file, 'untouched fields are preserved');
  assert.notEqual(updated.updatedAt, before, 'updatedAt advances on write');
});

test('update throws for a missing receipt', async () => {
  await assert.rejects(() => store.update('0000000000000000', { status: 'done' }), /not found/);
});

test('list returns records newest-first and respects the limit', async () => {
  const a = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });
  await new Promise((r) => setTimeout(r, 5));
  const b = await store.createReceipt({ buffer: sampleBuffer(), mimeType: 'image/jpeg' });

  const all = await store.list({ limit: 50 });
  const ids = all.map((r) => r.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id));
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id), 'newer receipt sorts first');

  const limited = await store.list({ limit: 1 });
  assert.equal(limited.length, 1);
});

test('image extension follows the declared mime type', async () => {
  const png = await store.createReceipt({ buffer: Buffer.from('x'), mimeType: 'image/png' });
  assert.match(png.image.file, /\.png$/);
  const webp = await store.createReceipt({ buffer: Buffer.from('x'), mimeType: 'image/webp' });
  assert.match(webp.image.file, /\.webp$/);
});
