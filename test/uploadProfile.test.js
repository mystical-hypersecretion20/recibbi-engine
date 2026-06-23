'use strict';

// HTTP-surface tests for upload-time profile selection (Step 2). Hermetic the
// same way routes.test.js is: temp DATA_DIR, fake Redis, and a stubbed queue
// that records which enqueue function the upload route calls — so no BullMQ /
// Redis connection is ever opened and we can assert the flow vs single-job path.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('upload-profile-test');
installFakeRedis();

const enqueued = { receipt: [], flow: [], apply: [], resolveFlow: [], resolve: [] };
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => {
      enqueued.receipt.push(id);
      return { id: `receipt-${id}` };
    },
    enqueueProcessAndApply: async (id, profileId) => {
      enqueued.flow.push({ id, profileId });
      return { job: { id: `applyProfile-${id}-${profileId}` } };
    },
    enqueueProcessApplyAndResolve: async (id, profileId) => {
      enqueued.resolveFlow.push({ id, profileId });
      return { job: { id: `resolveProducts-${id}-${profileId}` } };
    },
    enqueueApplyProfile: async (id, profileId) => {
      enqueued.apply.push({ id, profileId });
      return { id: `applyProfile-${id}-${profileId}` };
    },
    enqueueResolveProducts: async (id, profileId) => {
      enqueued.resolve.push({ id, profileId });
      return { id: `resolveProducts-${id}-${profileId}` };
    },
    receiptsQueue: {},
    connection: {},
  },
};

function resetEnqueued() {
  for (const k of Object.keys(enqueued)) enqueued[k].length = 0;
}

const config = require('../src/config');
config.publicBaseUrl = 'http://localhost:8080';

const profileStore = require('../src/receiptProfiles/profileStore');
const store = require('../src/store');
const { createApp } = require('../src/app');

let server;
let base;
let profile;

const smallImage = Buffer.alloc(256, 7);

function uploadForm(buffer, fields = {}) {
  const fd = new FormData();
  fd.append('receipt', new Blob([buffer], { type: 'image/png' }), 'r.png');
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

before(async () => {
  profile = await profileStore.create({ name: 'uploadTest1', transformer: 'usGrocery' });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

test('upload WITHOUT a profileId uses the single-job path (no products)', async () => {
  resetEnqueued();
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: uploadForm(smallImage) });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'queued');
  assert.equal(body.profileId, null);
  assert.equal(body.profileResultUrl, null);
  assert.equal(body.productsUrl, null, 'no products without a profile');
  assert.deepEqual(enqueued.receipt, [body.id], 'enqueueReceipt called with the new id');
  assert.equal(enqueued.flow.length, 0, 'no profile flow');
  assert.equal(enqueued.resolveFlow.length, 0, 'no products flow');
});

test('upload WITH a profileId (by name) resolves products by default (3-level flow)', async () => {
  resetEnqueued();
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    body: uploadForm(smallImage, { profileId: 'uploadTest1' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.profileId, profile.id, 'response carries the resolved profile id');
  assert.equal(
    body.profileResultUrl,
    `http://localhost:8080/api/receipts/${body.id}/profileResults/${profile.id}`
  );
  assert.equal(
    body.productsUrl,
    `http://localhost:8080/api/receipts/${body.id}/products/${profile.id}`
  );
  assert.equal(enqueued.receipt.length, 0, 'single-job path not taken');
  assert.equal(enqueued.flow.length, 0, '2-level flow not taken when products are on');
  assert.deepEqual(enqueued.resolveFlow, [{ id: body.id, profileId: profile.id }],
    'enqueueProcessApplyAndResolve called with (receiptId, profileId)');
});

test('upload WITH a profileId and resolveProducts=0 uses the 2-level flow (no products)', async () => {
  resetEnqueued();
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    body: uploadForm(smallImage, { profileId: 'uploadTest1', resolveProducts: '0' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.profileId, profile.id);
  assert.equal(body.productsUrl, null, 'products opted out');
  assert.deepEqual(enqueued.flow, [{ id: body.id, profileId: profile.id }],
    'enqueueProcessAndApply called');
  assert.equal(enqueued.resolveFlow.length, 0, 'no products flow when opted out');
});

test('upload WITH a profileId (by id) also resolves products by default', async () => {
  resetEnqueued();
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    body: uploadForm(smallImage, { profileId: profile.id }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.deepEqual(enqueued.resolveFlow, [{ id: body.id, profileId: profile.id }]);
});

test('upload with an UNKNOWN profileId -> 400 and nothing queued', async () => {
  enqueued.receipt.length = 0;
  enqueued.flow.length = 0;
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    body: uploadForm(smallImage, { profileId: 'doesNotExist' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /unknown profile/i);
  assert.equal(enqueued.receipt.length, 0);
  assert.equal(enqueued.flow.length, 0);
});

test('applyProfile?async=1 enqueues a childless job and returns 202', async () => {
  enqueued.apply.length = 0;
  const rec = await store.createReceipt({
    buffer: smallImage, mimeType: 'image/png', originalName: 'x.png', source: 'test',
  });
  await store.update(rec.id, { status: 'done', store: { name: 'X', date: null }, items: [], totals: {} });

  const res = await fetch(`${base}/api/receipts/${rec.id}/applyProfile/uploadTest1?async=1`, { method: 'POST' });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, 'queued');
  assert.equal(body.profileId, profile.id);
  assert.equal(body.profileResultUrl, `http://localhost:8080/api/receipts/${rec.id}/profileResults/${profile.id}`);
  assert.deepEqual(enqueued.apply, [{ id: rec.id, profileId: profile.id }]);
});

test('applyProfile?async=1 -> 404 for an unknown profile (nothing queued)', async () => {
  enqueued.apply.length = 0;
  const rec = await store.createReceipt({
    buffer: smallImage, mimeType: 'image/png', originalName: 'x.png', source: 'test',
  });
  const res = await fetch(`${base}/api/receipts/${rec.id}/applyProfile/noSuchProfile?async=1`, { method: 'POST' });
  assert.equal(res.status, 404);
  assert.equal(enqueued.apply.length, 0);
});

test('DEFAULT_PROFILE_ID applies the flow (with products) when no profileId is given', async () => {
  resetEnqueued();
  const prev = config.receiptProfiles.defaultProfileId;
  config.receiptProfiles.defaultProfileId = 'uploadTest1';
  try {
    const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: uploadForm(smallImage) });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.profileId, profile.id);
    assert.deepEqual(enqueued.resolveFlow, [{ id: body.id, profileId: profile.id }]);
    assert.equal(enqueued.receipt.length, 0);
  } finally {
    config.receiptProfiles.defaultProfileId = prev;
  }
});
