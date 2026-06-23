'use strict';

// SQLite persistence backend. Stores every record as a JSON document in a single
// generic table, mirroring the filesystem backend's contract (get/put/delete/
// list) so the record stores are backend-agnostic. The generic document model
// keeps this branch small and makes the planned PostgreSQL backend a near-trivial
// follow-on (the same table as `jsonb`).
//
//   docs(kind, tenant, usr, id, sub, json, created_at, updated_at)
//   PRIMARY KEY (kind, tenant, usr, id, sub)
//
// `usr` (not `user`, which is awkward to quote in SQLite) holds the user segment
// or '' for tenant-scoped kinds. better-sqlite3 is synchronous; the async ops
// just wrap the sync calls so callers stay uniform across backends.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../../config');

let db = null;

function conn() {
  if (db) return db;
  const file = config.persistence.sqlite.path;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL'); // server + worker are separate processes
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      kind       TEXT NOT NULL,
      tenant     TEXT NOT NULL,
      usr        TEXT NOT NULL DEFAULT '',
      id         TEXT NOT NULL,
      sub        TEXT NOT NULL DEFAULT '',
      json       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, tenant, usr, id, sub)
    );
    CREATE INDEX IF NOT EXISTS idx_docs_list ON docs(kind, tenant, usr, id);
  `);
  return db;
}

// Normalize a key tuple to the table's columns (user/sub default to '').
function norm(key) {
  return {
    kind: key.kind,
    tenant: key.tenant,
    usr: key.user || '',
    id: key.id,
    sub: key.sub || '',
  };
}

async function get(key) {
  const k = norm(key);
  const row = conn()
    .prepare('SELECT json FROM docs WHERE kind=? AND tenant=? AND usr=? AND id=? AND sub=?')
    .get(k.kind, k.tenant, k.usr, k.id, k.sub);
  return row ? JSON.parse(row.json) : null;
}

async function put(key, value) {
  const k = norm(key);
  const now = new Date().toISOString();
  conn()
    .prepare(
      `INSERT INTO docs (kind, tenant, usr, id, sub, json, created_at, updated_at)
       VALUES (@kind, @tenant, @usr, @id, @sub, @json, @now, @now)
       ON CONFLICT(kind, tenant, usr, id, sub)
       DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`
    )
    .run({ ...k, json: JSON.stringify(value), now });
  return value;
}

async function del(key) {
  const k = norm(key);
  const info = conn()
    .prepare('DELETE FROM docs WHERE kind=? AND tenant=? AND usr=? AND id=? AND sub=?')
    .run(k.kind, k.tenant, k.usr, k.id, k.sub);
  return info.changes > 0;
}

// list(prefix): kind is required; tenant/user/id narrow the match when present.
// Tenant-scoped kinds (receiptProfiles, tenants) store usr='' and callers omit
// `user`, so the usr filter is simply skipped for them.
async function list(prefix) {
  const conds = ['kind=?'];
  const args = [prefix.kind];
  if (prefix.tenant !== undefined && prefix.tenant !== null && prefix.tenant !== '') {
    conds.push('tenant=?');
    args.push(prefix.tenant);
  }
  if (prefix.user) {
    conds.push('usr=?');
    args.push(prefix.user);
  }
  if (prefix.id) {
    conds.push('id=?');
    args.push(prefix.id);
  }
  const rows = conn()
    .prepare(`SELECT json FROM docs WHERE ${conds.join(' AND ')}`)
    .all(...args);
  return rows.map((r) => JSON.parse(r.json));
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { get, put, delete: del, list, close };
