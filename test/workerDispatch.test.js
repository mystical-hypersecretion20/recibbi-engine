'use strict';

// Unit-test the worker's pure dispatch(job) routing without Redis. We stub the
// two units it delegates to (pipeline.processReceipt and
// applyService.applyProfileToReceipt) via the require cache, then require
// src/worker.js — which only starts a real BullMQ Worker when run directly
// (require.main === module), so importing it here is side-effect free.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir, installFakeRedis } = require('./helpers/harness');

useTempDataDir('worker-dispatch-test');
installFakeRedis();

// --- stub the delegates BEFORE requiring the worker ------------------------
const calls = { process: [], apply: [], resolve: [] };

const pipelinePath = require.resolve('../src/pipeline');
require.cache[pipelinePath] = {
  id: pipelinePath,
  filename: pipelinePath,
  loaded: true,
  exports: {
    processReceipt: async (receiptId) => {
      calls.process.push(receiptId);
      return { receiptId, processed: true };
    },
  },
};

const applyServicePath = require.resolve('../src/receiptProfiles/applyService');
require.cache[applyServicePath] = {
  id: applyServicePath,
  filename: applyServicePath,
  loaded: true,
  exports: {
    applyProfileToReceipt: async (receiptId, profileId) => {
      calls.apply.push({ receiptId, profileId });
      return { receiptId, profileId, applied: true };
    },
  },
};

const resolveServicePath = require.resolve('../src/products/resolveService');
require.cache[resolveServicePath] = {
  id: resolveServicePath,
  filename: resolveServicePath,
  loaded: true,
  exports: {
    resolveProductsForProfileResult: async (receiptId, profileId) => {
      calls.resolve.push({ receiptId, profileId });
      return { receiptId, profileId, resolved: true };
    },
  },
};

const { dispatch } = require('../src/worker');

test("dispatch routes 'process-receipt' to processReceipt only", async () => {
  calls.process.length = 0;
  calls.apply.length = 0;
  const out = await dispatch({ id: 'j1', name: 'process-receipt', data: { receiptId: 'r1' }, attemptsMade: 0 });
  assert.deepEqual(calls.process, ['r1']);
  assert.equal(calls.apply.length, 0);
  assert.equal(out.processed, true);
});

test("dispatch routes 'applyProfile' to applyProfileToReceipt only", async () => {
  calls.process.length = 0;
  calls.apply.length = 0;
  const out = await dispatch({
    id: 'j2',
    name: 'applyProfile',
    data: { receiptId: 'r2', profileId: 'rp_abc' },
    attemptsMade: 0,
  });
  assert.deepEqual(calls.apply, [{ receiptId: 'r2', profileId: 'rp_abc' }]);
  assert.equal(calls.process.length, 0);
  assert.equal(out.applied, true);
});

test("dispatch routes 'resolveProducts' to resolveProductsForProfileResult only", async () => {
  calls.process.length = 0;
  calls.apply.length = 0;
  calls.resolve.length = 0;
  const out = await dispatch({
    id: 'j4',
    name: 'resolveProducts',
    data: { receiptId: 'r4', profileId: 'rp_xyz' },
    attemptsMade: 0,
  });
  assert.deepEqual(calls.resolve, [{ receiptId: 'r4', profileId: 'rp_xyz' }]);
  assert.equal(calls.process.length, 0);
  assert.equal(calls.apply.length, 0);
  assert.equal(out.resolved, true);
});

test('dispatch throws on an unknown job name', async () => {
  await assert.rejects(
    () => dispatch({ id: 'j3', name: 'bogus', data: {}, attemptsMade: 0 }),
    /unknown job name: bogus/
  );
});
