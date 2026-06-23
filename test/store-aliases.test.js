'use strict';

// Store-name canonicalization is driven by a JSON alias file (configurable via
// STORE_ALIASES_PATH). This file runs in its own process, so it can point the
// parser at a throwaway alias file BEFORE requiring it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const aliasFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'aliases-')),
  'store-aliases.json'
);
fs.writeFileSync(
  aliasFile,
  JSON.stringify({
    aliases: {
      Costco: ['costco wholesale', 'costco'],
      'Bob the Grocer': ['bob the grocer', "bob's"],
    },
  })
);
process.env.STORE_ALIASES_PATH = aliasFile;

// Required AFTER the env is set so it loads our custom table.
const parser = require('../src/parse/receiptParser');

test('canonicalizes a multi-word vision store name to the configured chain', () => {
  const out = parser.normalizeStructured(
    { store: { name: 'Costco Wholesale #345' }, items: [{ description: 'X', price: 1 }], totals: {} },
    null
  );
  assert.equal(out.store.name, 'Costco');
});

test('a custom alias from the JSON file resolves to its canonical name', () => {
  const out = parser.normalizeStructured(
    { store: { name: "Bob's" }, items: [{ description: 'X', price: 1 }], totals: {} },
    null
  );
  assert.equal(out.store.name, 'Bob the Grocer');
});

test('detects a configured store from raw OCR text too', () => {
  const out = parser.parseText('BOB THE GROCER\nApples 2.00');
  assert.ok(out.store);
  assert.equal(out.store.name, 'Bob the Grocer');
});

test('an unknown store name is preserved verbatim (trimmed)', () => {
  const out = parser.normalizeStructured(
    { store: { name: '  Unlisted Mart  ' }, items: [{ description: 'X', price: 1 }], totals: {} },
    null
  );
  assert.equal(out.store.name, 'Unlisted Mart');
});
