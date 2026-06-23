'use strict';

// Guards the per-tenant queue naming. BullMQ rejects ':' in BOTH queue names and
// custom job ids, so the queue name must use a '-' separator and job ids must be
// hashed. Requiring src/queue opens no connection (queues are created lazily), so
// this stays hermetic with the fake Redis installed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');
useTempDataDir('queue-test');
installFakeRedis();

const { queueNameFor } = require('../src/queue');
const identity = require('../src/identity');

test('queueNameFor is colon-free and tenant-specific', () => {
  assert.equal(queueNameFor('main'), 'receipts-main');
  assert.equal(queueNameFor('acme'), 'receipts-acme');
  assert.ok(!queueNameFor('acme').includes(':'), 'queue name must not contain ":" (BullMQ rejects it)');
  assert.notEqual(queueNameFor('a'), queueNameFor('b'), 'distinct tenants -> distinct queues');
});

test('job ids derived from composite ids are colon-free', () => {
  const id = 'acme:alice:ab12cd34';
  for (const jid of [identity.jobId('receipt', id), identity.jobId('applyProfile', id, 'rp_1'), identity.jobId('resolveProducts', id, 'rp_1')]) {
    assert.ok(!jid.includes(':'), `job id "${jid}" must not contain ":"`);
  }
});
