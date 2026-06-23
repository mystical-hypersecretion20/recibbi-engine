'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');

// Fresh empty DATA_DIR so first-boot seeding actually runs.
const tmp = useTempDataDir('profile-seed-test');
const profileStore = require('../src/receiptProfiles/profileStore');

after(() => tmp.cleanup());

test('seedIfEmpty seeds the shipped example on an empty store, then is a no-op', async () => {
  assert.equal((await profileStore.list()).length, 0);
  const seeded = await profileStore.seedIfEmpty();
  assert.ok(seeded >= 1, 'at least one profile seeded');

  const usGrocery = await profileStore.get('usGrocery1');
  assert.ok(usGrocery, 'the shipped usGrocery1 profile exists after seeding');
  assert.equal(usGrocery.version, 1);
  assert.equal(usGrocery.transformer, 'usGrocery', 'seed binds the usGrocery transformer');

  // Second call is a no-op because the store is no longer empty.
  assert.equal(await profileStore.seedIfEmpty(), 0);
});
