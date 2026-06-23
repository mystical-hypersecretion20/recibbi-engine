'use strict';

// Tenant registry (src/tenants.js) over the in-memory fake Redis. The default
// tenant is always allowed even before it's explicitly registered.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');
useTempDataDir('tenants-test');
installFakeRedis();

const tenants = require('../src/tenants');

test('default tenant is allowed before any registration', async () => {
  assert.equal(await tenants.isAllowed('main'), true);
});

test('an unregistered non-default tenant is rejected, then allowed once created', async () => {
  assert.equal(await tenants.isAllowed('acme'), false);
  await tenants.register('acme');
  assert.equal(await tenants.isAllowed('acme'), true);
});

test('list includes the default plus registered tenants, sorted', async () => {
  await tenants.register('zeta');
  await tenants.register('beta');
  const list = await tenants.list();
  assert.ok(list.includes('main'), 'default always present');
  assert.ok(list.includes('zeta') && list.includes('beta'));
  assert.deepEqual([...list].sort(), list, 'sorted');
});

test('register rejects an invalid tenant id', async () => {
  await assert.rejects(() => tenants.register('bad:id'), /invalid tenant id/);
});

test('remove drops a tenant from the registry (default still allowed)', async () => {
  await tenants.register('temp');
  assert.equal(await tenants.isAllowed('temp'), true);
  await tenants.remove('temp');
  assert.equal(await tenants.isAllowed('temp'), false);
  assert.equal(await tenants.isAllowed('main'), true);
});
