'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');

// Point DATA_DIR at a throwaway dir BEFORE requiring the store (config reads it
// at load time).
const tmp = useTempDataDir('profile-store-test');
const profileStore = require('../src/receiptProfiles/profileStore');

after(() => tmp.cleanup());

const def = {
  name: 'storeTest1',
  description: 'd',
  transformer: 'usGrocery',
  config: { region: 'us' },
};

test('create assigns rp_ id, version 1, transformer + config, timestamps', async () => {
  const p = await profileStore.create(def);
  assert.match(p.id, /^rp_[0-9a-f]{16}$/);
  assert.equal(p.name, 'storeTest1');
  assert.equal(p.version, 1);
  assert.equal(p.transformer, 'usGrocery');
  assert.deepEqual(p.config, { region: 'us' });
  assert.ok(p.createdAt && p.updatedAt);
});

test('get resolves by id and by name', async () => {
  const byName = await profileStore.get('storeTest1');
  assert.ok(byName);
  const byId = await profileStore.get(byName.id);
  assert.equal(byId.id, byName.id);
  assert.equal(await profileStore.get('rp_doesnotexist0000'), null);
  assert.equal(await profileStore.get('nope'), null);
});

test('duplicate name is rejected', async () => {
  await assert.rejects(() => profileStore.create(def), (err) => err.name === 'ValidationError');
});

test('an unknown transformer is rejected at create', async () => {
  await assert.rejects(
    () => profileStore.create({ name: 'bad1', transformer: 'noSuchTransformer' }),
    (err) => err.name === 'ValidationError' && err.errors.some((e) => /unknown transformer/i.test(e))
  );
});

test('update bumps version, keeps id/createdAt, validates', async () => {
  const before = await profileStore.get('storeTest1');
  const updated = await profileStore.update('storeTest1', { ...def, description: 'updated' });
  assert.equal(updated.id, before.id);
  assert.equal(updated.createdAt, before.createdAt);
  assert.equal(updated.version, before.version + 1);
  assert.equal(updated.description, 'updated');
  assert.equal(await profileStore.update('missing', def), null);
});

test('list returns all profiles sorted by name', async () => {
  await profileStore.create({ ...def, name: 'aaaFirst' });
  const names = (await profileStore.list()).map((p) => p.name);
  assert.ok(names.includes('aaaFirst') && names.includes('storeTest1'));
  assert.deepEqual(names, [...names].sort());
});

test('remove deletes and reports hit/miss', async () => {
  assert.equal(await profileStore.remove('aaaFirst'), true);
  assert.equal(await profileStore.get('aaaFirst'), null);
  assert.equal(await profileStore.remove('aaaFirst'), false);
});
