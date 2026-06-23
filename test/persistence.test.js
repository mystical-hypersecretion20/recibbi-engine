'use strict';

// Persistence backend CONTRACT. Both shipped backends (filesystem + sqlite) must
// behave identically through the generic document interface, so the record
// stores are truly backend-agnostic. We point DATA_DIR (filesystem) and
// SQLITE_PATH (sqlite) at temp locations, require BOTH backend modules directly
// (bypassing the config-driven selector so both run in one process), and run the
// same suite against each. Fully offline.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-fs-'));
const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-sqlite-'));
process.env.DATA_DIR = dataDir;
process.env.SQLITE_PATH = path.join(sqliteDir, 'test.db');

const filesystem = require('../src/persistence/backends/filesystem');
const sqlite = require('../src/persistence/backends/sqlite');

after(() => {
  if (typeof sqlite.close === 'function') sqlite.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sqliteDir, { recursive: true, force: true });
});

// Run the identical contract against a backend, namespacing tenants per backend
// so the two backends never share state (the filesystem one is its own tree, the
// sqlite one its own file — this is just belt-and-suspenders).
function contract(name, be) {
  const T = `t_${name}`; // tenant
  const U = `u_${name}`; // user

  test(`[${name}] put/get roundtrip`, async () => {
    await be.put({ kind: 'receipts', tenant: T, user: U, id: 'r1' }, { id: 'r1', v: 1 });
    assert.deepEqual(await be.get({ kind: 'receipts', tenant: T, user: U, id: 'r1' }), { id: 'r1', v: 1 });
  });

  test(`[${name}] get of a missing doc is null`, async () => {
    assert.equal(await be.get({ kind: 'receipts', tenant: T, user: U, id: 'nope' }), null);
  });

  test(`[${name}] put overwrites in place`, async () => {
    await be.put({ kind: 'receipts', tenant: T, user: U, id: 'r1' }, { id: 'r1', v: 2 });
    assert.equal((await be.get({ kind: 'receipts', tenant: T, user: U, id: 'r1' })).v, 2);
  });

  test(`[${name}] delete returns true then false; get is null after`, async () => {
    await be.put({ kind: 'receipts', tenant: T, user: U, id: 'gone' }, { id: 'gone' });
    assert.equal(await be.delete({ kind: 'receipts', tenant: T, user: U, id: 'gone' }), true);
    assert.equal(await be.get({ kind: 'receipts', tenant: T, user: U, id: 'gone' }), null);
    assert.equal(await be.delete({ kind: 'receipts', tenant: T, user: U, id: 'gone' }), false);
  });

  test(`[${name}] list a flat kind by scope`, async () => {
    await be.put({ kind: 'receipts', tenant: T, user: U, id: 'a' }, { id: 'a' });
    await be.put({ kind: 'receipts', tenant: T, user: U, id: 'b' }, { id: 'b' });
    const ids = (await be.list({ kind: 'receipts', tenant: T, user: U })).map((r) => r.id).sort();
    assert.deepEqual(ids, ['a', 'b', 'r1']); // r1 from earlier
  });

  test(`[${name}] scope isolation — another user is not visible`, async () => {
    await be.put({ kind: 'receipts', tenant: T, user: 'other', id: 'x' }, { id: 'x' });
    const mine = (await be.list({ kind: 'receipts', tenant: T, user: U })).map((r) => r.id);
    assert.ok(!mine.includes('x'));
    assert.equal((await be.list({ kind: 'receipts', tenant: T, user: 'other' })).length, 1);
  });

  test(`[${name}] tenant-scoped kind (no user segment)`, async () => {
    await be.put({ kind: 'receiptProfiles', tenant: T, id: 'rp_1' }, { id: 'rp_1', name: 'p1' });
    await be.put({ kind: 'receiptProfiles', tenant: T, id: 'rp_2' }, { id: 'rp_2', name: 'p2' });
    assert.equal((await be.get({ kind: 'receiptProfiles', tenant: T, id: 'rp_1' })).name, 'p1');
    assert.equal((await be.list({ kind: 'receiptProfiles', tenant: T })).length, 2);
  });

  test(`[${name}] sub-keyed kind: list-by-id vs list-all-in-scope`, async () => {
    // two profiles applied to receipt r1, one to r2
    await be.put({ kind: 'profileResults', tenant: T, user: U, id: 'r1', sub: 'rp_1' }, { receiptId: 'r1', profileId: 'rp_1' });
    await be.put({ kind: 'profileResults', tenant: T, user: U, id: 'r1', sub: 'rp_2' }, { receiptId: 'r1', profileId: 'rp_2' });
    await be.put({ kind: 'profileResults', tenant: T, user: U, id: 'r2', sub: 'rp_1' }, { receiptId: 'r2', profileId: 'rp_1' });

    assert.equal((await be.get({ kind: 'profileResults', tenant: T, user: U, id: 'r1', sub: 'rp_2' })).profileId, 'rp_2');
    assert.equal((await be.list({ kind: 'profileResults', tenant: T, user: U, id: 'r1' })).length, 2); // one receipt
    assert.equal((await be.list({ kind: 'profileResults', tenant: T, user: U })).length, 3); // whole scope, flattened
  });

  test(`[${name}] global kind (tenant registry)`, async () => {
    await be.put({ kind: 'tenants', tenant: 'acme', id: 'acme' }, { tenantId: 'acme' });
    await be.put({ kind: 'tenants', tenant: 'globex', id: 'globex' }, { tenantId: 'globex' });
    const all = (await be.list({ kind: 'tenants' })).map((d) => d.tenantId).sort();
    assert.deepEqual(all, ['acme', 'globex']);
    assert.equal((await be.get({ kind: 'tenants', tenant: 'acme', id: 'acme' })).tenantId, 'acme');
  });
}

contract('filesystem', filesystem);
contract('sqlite', sqlite);
