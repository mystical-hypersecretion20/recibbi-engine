'use strict';

// Shared helpers for the transformer regression suite. A fixture is a JSON file
// pinning a transformer's INPUT (a parsed receipt, e.g. from Tesseract) to its
// EXPECTED canonical output ({ store, items, totals }). The test asserts the
// live transformer still produces the expected output; the generator rewrites
// the expected block after an intentional change.

const fs = require('fs');
const path = require('path');
const registry = require('../../src/receiptProfiles/registry');
const { applyProfile } = require('../../src/receiptProfiles/engine');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

/** All fixture JSON files under fixtures/<transformerId>/, sorted. */
function listFixtures() {
  const out = [];
  if (!fs.existsSync(FIXTURES_DIR)) return out;
  for (const tdir of fs.readdirSync(FIXTURES_DIR)) {
    const abs = path.join(FIXTURES_DIR, tdir);
    if (!fs.statSync(abs).isDirectory()) continue;
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.json')) continue;
      out.push({ file: path.join(abs, f), rel: path.posix.join(tdir, f) });
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Run a transformer over a fixture's input and return the canonical
 * { store, items, totals } the engine produces — the part a fixture pins.
 * (The engine's derived `changes` audit trail is intentionally not compared.)
 */
function applyToInput(transformerId, input) {
  const t = registry.get(transformerId);
  if (!t) throw new Error(`unknown transformer: ${transformerId}`);
  const record = {
    id: 'fixture',
    store: input.store || { name: null, date: null },
    items: Array.isArray(input.items) ? input.items : [],
    totals: input.totals || {},
  };
  const out = applyProfile(record, t.transform, { receiptId: 'fixture', config: {}, log() {} });
  return { store: out.store, items: out.items, totals: out.totals };
}

module.exports = { FIXTURES_DIR, listFixtures, applyToInput };
