'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateProfile } = require('../src/receiptProfiles/validate');

function expectInvalid(input, needle) {
  const { valid, errors } = validateProfile(input);
  assert.equal(valid, false, `expected invalid for ${JSON.stringify(input)}`);
  if (needle) {
    assert.ok(
      errors.some((e) => e.toLowerCase().includes(needle.toLowerCase())),
      `expected an error mentioning "${needle}", got: ${errors.join(' | ')}`
    );
  }
}

test('accepts a profile referencing a known transformer', () => {
  const { valid, errors } = validateProfile({
    name: 'usGrocery1',
    description: 'ok',
    transformer: 'usGrocery',
    config: { foo: 'bar' },
  });
  assert.equal(valid, true, errors.join(' | '));
});

test('config is optional', () => {
  const { valid } = validateProfile({ name: 'noConfig', transformer: 'usGrocery' });
  assert.equal(valid, true);
});

test('rejects a name with dashes/spaces (camelCase required)', () => {
  expectInvalid({ name: 'us-grocery', transformer: 'usGrocery' }, 'name');
  expectInvalid({ name: 'us grocery', transformer: 'usGrocery' }, 'name');
});

test('rejects a missing transformer', () => {
  expectInvalid({ name: 'p' }, 'transformer is required');
});

test('rejects an unknown transformer with the available list', () => {
  expectInvalid({ name: 'p', transformer: 'noSuchTransformer' }, 'unknown transformer');
});

test('rejects a non-object config', () => {
  expectInvalid({ name: 'p', transformer: 'usGrocery', config: 'nope' }, 'config');
  expectInvalid({ name: 'p', transformer: 'usGrocery', config: [1, 2] }, 'config');
});

test('rejects a non-object body', () => {
  expectInvalid('nope');
});
