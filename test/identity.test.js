'use strict';

// Unit tests for the multi-tenancy identity/key scheme (src/identity.js). No
// network, Redis, or filesystem — pure functions. Strict mode (no default
// identity) is exercised by toggling config.defaultTenantId at runtime, since
// identity.js reads it dynamically.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');
useTempDataDir('identity-test');

const config = require('../src/config');
const identity = require('../src/identity');

test('buildId + resolveId round-trip a fully-qualified composite id', () => {
  const id = identity.buildId('acme', 'u1', 'ab12cd34');
  assert.equal(id, 'acme:u1:ab12cd34');
  assert.deepEqual(identity.resolveId(id), { tenantId: 'acme', userId: 'u1', cacheId: 'ab12cd34' });
});

test('resolveId treats a bare id as the default scope + cacheId', () => {
  assert.deepEqual(identity.resolveId('deadbeef'), { tenantId: 'main', userId: 'main', cacheId: 'deadbeef' });
});

test('resolveId honors an explicit fallback scope for a bare id', () => {
  assert.deepEqual(
    identity.resolveId('xyz', { tenantId: 't', userId: 'u' }),
    { tenantId: 't', userId: 'u', cacheId: 'xyz' }
  );
});

test('resolveId rejects malformed ids (wrong segment count or bad chars)', () => {
  for (const bad of ['a:b', 'a:b:c:d', 'a::c', 'has space', 'bad/seg', '', 'tenant:user:has:colon']) {
    assert.throws(() => identity.resolveId(bad), (e) => e.name === 'IdentityError' && e.status === 400, `should reject "${bad}"`);
  }
});

test('UUID-style segments are valid (flexible string, not just hex)', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const id = identity.buildId(uuid, uuid, 'cache_1');
  assert.deepEqual(identity.resolveId(id), { tenantId: uuid, userId: uuid, cacheId: 'cache_1' });
});

test('jobId is deterministic and contains no colon (BullMQ-safe)', () => {
  const a = identity.jobId('applyProfile', 'main:main:abc', 'rp_1');
  const b = identity.jobId('applyProfile', 'main:main:abc', 'rp_1');
  const c = identity.jobId('applyProfile', 'main:main:abc', 'rp_2');
  assert.equal(a, b, 'same inputs -> same id (dedup preserved)');
  assert.notEqual(a, c, 'different inputs -> different id');
  assert.ok(!a.includes(':'), 'job id is colon-free');
  assert.match(a, /^applyProfile-[0-9a-f]{40}$/);
});

test('resolveIdentity: headers win, then body, then the configured default', () => {
  const reqHeader = { get: (h) => (h === 'X-Tenant-Id' ? 'acme' : h === 'X-User-Id' ? 'u9' : undefined), body: {} };
  assert.deepEqual(identity.resolveIdentity(reqHeader), { tenantId: 'acme', userId: 'u9' });

  const reqBody = { get: () => undefined, body: { tenantId: 'b', userId: 'bu' } };
  assert.deepEqual(identity.resolveIdentity(reqBody), { tenantId: 'b', userId: 'bu' });

  const reqNone = { get: () => undefined, body: {} };
  assert.deepEqual(identity.resolveIdentity(reqNone), { tenantId: 'main', userId: 'main' });
});

test('strict mode (blank default) requires explicit identity', () => {
  const prevT = config.defaultTenantId;
  const prevU = config.defaultUserId;
  config.defaultTenantId = '';
  config.defaultUserId = '';
  try {
    const reqNone = { get: () => undefined, body: {} };
    assert.throws(() => identity.resolveIdentity(reqNone), (e) => e.name === 'IdentityError' && e.status === 400);
    // A bare id has no fallback scope in strict mode.
    assert.throws(() => identity.resolveId('abc'), (e) => e.status === 400);
    // A fully-qualified id still resolves (carries its own scope).
    assert.deepEqual(identity.resolveId('t:u:c'), { tenantId: 't', userId: 'u', cacheId: 'c' });
    // Explicit identity satisfies the requirement.
    const req = { get: (h) => (h === 'X-Tenant-Id' ? 't' : h === 'X-User-Id' ? 'u' : undefined), body: {} };
    assert.deepEqual(identity.resolveIdentity(req), { tenantId: 't', userId: 'u' });
  } finally {
    config.defaultTenantId = prevT;
    config.defaultUserId = prevU;
  }
});

test('userDataDir/tenantDataDir reject path-traversal segments', () => {
  assert.throws(() => identity.userDataDir({ tenantId: '..', userId: 'u' }, 'receipts'), (e) => e.status === 400);
  assert.throws(() => identity.tenantDataDir('a/b', 'receiptProfiles'), (e) => e.status === 400);
  const dir = identity.userDataDir({ tenantId: 'main', userId: 'main' }, 'receipts');
  assert.ok(dir.endsWith(require('path').join('main', 'main', 'receipts')));
});
