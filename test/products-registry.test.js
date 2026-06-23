'use strict';

// The resolver registry discovers code modules under src/products/resolvers/
// and selects the active one from config.products.resolver. No network/Redis.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { useTempDataDir } = require('./helpers/harness');

useTempDataDir('products-registry-test');

const config = require('../src/config');
const registry = require('../src/products/registry');

test('list() includes the shipped anthropic resolver (id + meta, no fns)', () => {
  const list = registry.list();
  const anth = list.find((r) => r.id === 'anthropic');
  assert.ok(anth, 'anthropic resolver is listed');
  assert.equal(typeof anth.name, 'string');
  assert.equal(anth.resolve, undefined, 'no function references leak into the listing');
});

test('get() returns the module with a resolve() fn; unknown -> null', () => {
  const anth = registry.get('anthropic');
  assert.equal(typeof anth.resolve, 'function');
  assert.equal(typeof anth.ready, 'function');
  assert.equal(registry.get('nope'), null);
});

test('active() resolves config.products.resolver', () => {
  assert.equal(config.products.resolver, 'anthropic');
  assert.equal(registry.active().id, 'anthropic');
});

test('the type-only module is not registered as a resolver', () => {
  assert.equal(registry.has('types'), false);
});
