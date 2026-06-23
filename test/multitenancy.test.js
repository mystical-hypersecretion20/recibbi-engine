'use strict';

// HTTP-surface tests for multi-tenancy: identity on upload, composite ids,
// cross-tenant isolation, unknown-tenant rejection, and the tenant-account
// endpoints. Hermetic like routes.test.js: temp DATA_DIR, fake Redis, stubbed
// queue so no BullMQ/Redis connection is opened.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

const tmp = useTempDataDir('multitenancy-test');
installFakeRedis();

const enqueued = [];
const queuePath = require.resolve('../src/queue');
require.cache[queuePath] = {
  id: queuePath,
  filename: queuePath,
  loaded: true,
  exports: {
    enqueueReceipt: async (id) => { enqueued.push(id); return { id: `receipt-${id}` }; },
    enqueueProcessAndApply: async () => ({}),
    enqueueProcessApplyAndResolve: async () => ({}),
    enqueueApplyProfile: async () => ({}),
    enqueueResolveProducts: async () => ({}),
    receiptsQueue: {},
    connection: {},
  },
};

const config = require('../src/config');
config.publicBaseUrl = 'http://localhost:8080';

const { createApp } = require('../src/app');

let server;
let base;
const img = Buffer.alloc(64, 7);

function uploadForm() {
  const fd = new FormData();
  fd.append('receipt', new Blob([img], { type: 'image/png' }), 'r.png');
  return fd;
}

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  tmp.cleanup();
});

test('upload with no identity uses the default tenant (main:main) and a composite id', async () => {
  const res = await fetch(`${base}/api/receipts`, { method: 'POST', body: uploadForm() });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.match(body.id, /^main:main:[0-9a-f]{16}$/);
  assert.ok(enqueued.includes(body.id), 'enqueued under its composite id');
});

test('upload for an UNKNOWN tenant is rejected (400) until the tenant is created', async () => {
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': 'acme', 'X-User-Id': 'u1' },
    body: uploadForm(),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /unknown tenant "acme"/);
});

test('POST /api/tenants provisions a tenant; then its uploads succeed and self-scope', async () => {
  const create = await fetch(`${base}/api/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId: 'acme' }),
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.tenantId, 'acme');
  assert.equal(created.created, true);

  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': 'acme', 'X-User-Id': 'u1' },
    body: uploadForm(),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.match(body.id, /^acme:u1:[0-9a-f]{16}$/, 'id carries the upload identity');

  // Re-creating is idempotent (200, created:false).
  const again = await fetch(`${base}/api/tenants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: 'acme' }),
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).created, false);
});

test('a receipt is readable by its composite id but isolated from other identities', async () => {
  const res = await fetch(`${base}/api/receipts`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': 'acme', 'X-User-Id': 'alice' },
    body: uploadForm(),
  });
  const { id } = await res.json(); // acme:alice:<cacheId>
  const cacheId = id.split(':')[2];

  // The full composite id resolves.
  assert.equal((await fetch(`${base}/api/receipts/${id}`)).status, 200);

  // The same cacheId under a DIFFERENT identity does not exist (isolation).
  assert.equal((await fetch(`${base}/api/receipts/acme:bob:${cacheId}`)).status, 404);
  assert.equal((await fetch(`${base}/api/receipts/other:alice:${cacheId}`)).status, 404);
});

test('GET /api/receipts lists only the requesting identity', async () => {
  // Seed one receipt for tenant "beta" (must provision first).
  await fetch(`${base}/api/tenants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenantId: 'beta' }),
  });
  await fetch(`${base}/api/receipts`, {
    method: 'POST', headers: { 'X-Tenant-Id': 'beta', 'X-User-Id': 'b1' }, body: uploadForm(),
  });

  const betaList = await (await fetch(`${base}/api/receipts`, { headers: { 'X-Tenant-Id': 'beta', 'X-User-Id': 'b1' } })).json();
  assert.ok(betaList.length >= 1);
  assert.ok(betaList.every((r) => r.id.startsWith('beta:b1:')), 'only beta:b1 receipts');

  // A different user in the same tenant sees none of b1's receipts.
  const otherUser = await (await fetch(`${base}/api/receipts`, { headers: { 'X-Tenant-Id': 'beta', 'X-User-Id': 'b2' } })).json();
  assert.equal(otherUser.length, 0, 'per-user isolation within a tenant');
});

test('GET /api/tenants lists provisioned tenants including the default', async () => {
  const body = await (await fetch(`${base}/api/tenants`)).json();
  assert.equal(body.default, 'main');
  for (const t of ['main', 'acme', 'beta']) assert.ok(body.tenants.includes(t), `lists ${t}`);
});
