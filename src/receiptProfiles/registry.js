'use strict';

// Transformer registry. Transformers are on-disk code modules (.ts/.js) shipped
// with the app under src/receiptProfiles/transformers/, each exporting a
// `transform` entrypoint (+ optional `meta`). A profile references one by id
// (the filename without extension). This is intentionally NOT user-uploaded
// code — nothing here evals request input — so there is no RCE surface.

// Enable requiring TypeScript transformers at runtime (CommonJS require hook).
require('tsx/cjs');

const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../logger');

const dir = config.receiptProfiles.transformersDir;

let cache = null;

function load() {
  const map = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (err) {
    logger.warn({ err: err.message, dir }, 'transformers dir unreadable');
    return map;
  }
  for (const file of files) {
    if (!/\.(ts|js)$/.test(file)) continue;
    if (file.endsWith('.d.ts') || file === 'types.ts') continue; // type-only modules
    const id = file.replace(/\.(ts|js)$/, '');
    try {
      const mod = require(path.join(dir, file));
      if (typeof mod.transform !== 'function') {
        logger.warn({ id }, 'transformer has no transform() export; skipping');
        continue;
      }
      map.set(id, { id, transform: mod.transform, meta: mod.meta || { name: id } });
    } catch (err) {
      logger.warn({ id, err: err.message }, 'failed to load transformer; skipping');
    }
  }
  return map;
}

function registry() {
  if (!cache) cache = load();
  return cache;
}

function has(id) {
  return registry().has(id);
}

function get(id) {
  return registry().get(id) || null;
}

/** Public-safe listing (id + meta), no function references. */
function list() {
  return [...registry().values()].map((t) => ({ id: t.id, ...t.meta }));
}

/** Re-scan the directory (used by tests). */
function reload() {
  cache = null;
  return registry();
}

module.exports = { has, get, list, reload };
