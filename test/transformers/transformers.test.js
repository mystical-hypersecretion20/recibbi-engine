'use strict';

// Transformer REGRESSION suite. For every fixture under fixtures/<transformerId>/
// it runs the live transformer over the pinned `input` and asserts the output
// still equals the pinned `expected`. This guards transformers (currently
// tesseractGroceryUs) against accidental behavior changes.
//
// Hermetic: no network/Redis/keys — just the registry, the engine, and JSON.
//
// When you INTENTIONALLY change a transformer, regenerate the goldens and review
// the diff before committing:
//
//   node test/transformers/generate-fixtures.js
//
// To add a case: drop a `{ transformer, name, input }` JSON file in the right
// fixtures/<transformerId>/ folder and run the generator to fill `expected`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const { listFixtures, applyToInput } = require('./_helpers');

const fixtures = listFixtures();

test('transformer regression fixtures are present', () => {
  assert.ok(fixtures.length > 0, 'no fixtures found under test/transformers/fixtures/');
});

for (const { file, rel } of fixtures) {
  test(`fixture: ${rel}`, () => {
    const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(fx.transformer, `${rel}: missing "transformer"`);
    assert.ok(fx.input && typeof fx.input === 'object', `${rel}: missing "input"`);
    assert.ok(
      fx.expected && typeof fx.expected === 'object',
      `${rel}: missing "expected" — run: node test/transformers/generate-fixtures.js`
    );

    const actual = applyToInput(fx.transformer, fx.input);
    assert.deepEqual(
      actual,
      fx.expected,
      `${rel}: transformer output drifted from the golden fixture.\n` +
        'If this change is intentional, regenerate and review:\n' +
        '  node test/transformers/generate-fixtures.js'
    );
  });
}
