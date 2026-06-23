'use strict';

// The real record stores + tenant registry, driven through their public APIs
// while the FILESYSTEM backend is explicitly active. Since SQLite is now the
// DEFAULT backend, the rest of the suite (store.test.js / profileStore.test.js /
// profileResultStore.test.js / the product store tests) already runs on SQLite —
// so this file pins `filesystem` to keep store-level coverage of BOTH backends
// in one `npm test`, and also covers the tenant-durability path. Offline: temp
// DATA_DIR, Redis is the in-memory fake.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.PERSISTENCE = 'filesystem'; // pin the non-default backend (set before config loads)
const { useTempDataDir, installFakeRedis } = require('./helpers/harness');
const tmp = useTempDataDir('persist-stores');
const fakeRedis = installFakeRedis();

const persistence = require('../src/persistence');
const store = require('../src/store');
const profileStore = require('../src/receiptProfiles/profileStore');
const resultStore = require('../src/receiptProfiles/resultStore');
const productStore = require('../src/products/productStore');
const tenants = require('../src/tenants');

test.after(() => {
  persistence._reset();
  tmp.cleanup();
});

test('filesystem backend is the active one', () => {
  assert.equal(persistence.backendName(), 'filesystem');
});

test('receipt store: create / get / update / list on filesystem', async () => {
  const r = await store.createReceipt({ buffer: Buffer.from('img'), mimeType: 'image/png', originalName: 'a.png' });
  assert.match(r.id, /^main:main:/);
  await store.update(r.id, { status: 'done', store: { name: 'Costco' } });
  const got = await store.get(r.id);
  assert.equal(got.status, 'done');
  assert.equal(got.store.name, 'Costco');
  const list = await store.list();
  assert.ok(list.some((x) => x.id === r.id));
  // image blob stays on the filesystem regardless of backend
  const fs = require('fs');
  assert.ok(fs.existsSync(store.imagePathFor(got)), 'image written to uploads/ on disk');
});

test('profile store: CRUD + version bump + resolve by id or name on filesystem', async () => {
  const p = await profileStore.create({ name: 'myProf', transformer: 'usGrocery' });
  assert.equal((await profileStore.get('myProf')).id, p.id);
  assert.equal((await profileStore.get(p.id)).name, 'myProf');
  const p2 = await profileStore.update(p.id, { name: 'renamed', transformer: 'usGrocery' });
  assert.equal(p2.version, 2);
  assert.equal(await profileStore.count(), 1);
  assert.equal(await profileStore.remove(p.id), true);
  assert.equal(await profileStore.count(), 0);
});

test('profile + product result stores: save/get/list/listAll on filesystem', async () => {
  const r = await store.createReceipt({ buffer: Buffer.from('x'), mimeType: 'image/png' });
  await resultStore.save({ receiptId: r.id, profileId: 'rp_a', appliedAt: '2026-01-01', items: [1] });
  await resultStore.save({ receiptId: r.id, profileId: 'rp_b', appliedAt: '2026-01-02', items: [1, 2] });
  assert.equal((await resultStore.get(r.id, 'rp_b')).items.length, 2);
  assert.equal((await resultStore.list(r.id)).length, 2);
  assert.equal((await resultStore.listByProfile('rp_a')).length, 1);

  await productStore.save({ receiptId: r.id, receiptProfileId: 'rp_a', resolvedAt: '2026-01-03', items: [{ sku: 's' }] });
  assert.equal((await productStore.get(r.id, 'rp_a')).items.length, 1);
  assert.equal((await productStore.list(r.id)).length, 1);
  assert.ok((await productStore.listAll()).length >= 1);
});

test('tenant registry is durable: survives a Redis recycle via hydrate()', async () => {
  await tenants.register('acme');
  await tenants.register('globex');
  assert.equal(await tenants.isAllowed('acme'), true);

  // It is persisted independently of Redis.
  const persisted = (await persistence.list({ kind: 'tenants' })).map((d) => d.tenantId).sort();
  assert.deepEqual(persisted, ['acme', 'globex']);

  // Simulate Redis being recycled: wipe the working-copy SET.
  fakeRedis.store.delete(tenants.SET_KEY);
  assert.equal(await tenants.isAllowed('acme'), false, 'gone from the empty Redis SET');

  // Boot-time hydrate repopulates the SET from the durable list.
  const restored = await tenants.hydrate();
  assert.equal(restored, 2);
  assert.equal(await tenants.isAllowed('acme'), true);
  assert.equal(await tenants.isAllowed('globex'), true);
});
