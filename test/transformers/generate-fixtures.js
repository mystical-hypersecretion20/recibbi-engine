'use strict';

// Regenerate the `expected` block of every transformer fixture by running the
// referenced transformer over its `input`. Run this AFTER an intentional
// transformer change, then review the JSON diff and commit. The regression test
// (transformers.test.js) fails whenever live output drifts from the committed
// `expected`, so the golden files are the contract.
//
//   node test/transformers/generate-fixtures.js
//
// It never invents inputs — each fixture must already carry an `input` (and a
// `transformer` id). To add a case, create the file with those two fields first.

const fs = require('fs');
const { listFixtures, applyToInput } = require('./_helpers');

const fixtures = listFixtures();
if (fixtures.length === 0) {
  console.error('No fixtures found under test/transformers/fixtures/.');
  process.exit(1);
}

let updated = 0;
for (const { file, rel } of fixtures) {
  const fx = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!fx.transformer || !fx.input) {
    console.error(`SKIP ${rel}: missing "transformer" or "input"`);
    continue;
  }
  fx.expected = applyToInput(fx.transformer, fx.input);
  fs.writeFileSync(file, JSON.stringify(fx, null, 2) + '\n');
  console.log('updated', rel);
  updated++;
}
console.log(`\n${updated} fixture(s) regenerated.`);
