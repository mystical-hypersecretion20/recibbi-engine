# Proposed `receipt-enricher-dev` SKILL.md update — persistence layer

> Per the team's skill workflow, this branch does **not** edit the global skill.
> When `feat/persistence-layer` merges, fold the following into
> `.claude/skills/receipt-enricher-dev/SKILL.md`.

## New subsection (suggested placement: after "Multi-tenancy", before "Receipt profiles")

### Persistence layer (pluggable record backend)

Durable records go through a **pluggable persistence layer** (`src/persistence/`)
chosen by `PERSISTENCE` (default `filesystem`), exactly like `OCR_PROVIDER` picks
the OCR engine — NOT per-record. Backends implement a generic document interface
(`get/put/delete/list`) over a key tuple `{ kind, tenant, user, id, sub }`; the
four record stores (`store.js`, `receiptProfiles/{profileStore,resultStore}.js`,
`products/productStore.js`) and the tenant registry call it instead of touching
`fs` directly.

- **`filesystem`** (default) — the original scope-partitioned JSON files under
  `DATA_DIR`; byte-identical layout, so existing data and tests are unchanged.
- **`sqlite`** — one generic `docs` table in a SQLite file (`SQLITE_PATH`,
  default `<DATA_DIR>/receipt-enricher.db`) via `better-sqlite3`.
- **`postgresql`** — TODO; the selector throws a clear "not implemented" error.

**Image blobs always stay on the filesystem** (`uploads/`) regardless of backend
(`store.imagePathFor` unchanged); a blob-store abstraction (e.g. S3) is future work.

**Tenant registry is now durable.** `src/tenants.js` writes the provisioned-tenant
list through the persistence layer *and* the Redis SET (`re:tenants`); at boot
`tenants.hydrate()` (called in `server.js` and `worker.js`) repopulates the Redis
SET from the durable list, so the tenant list survives a Redis recycle. Redis is
still the runtime working copy the worker watches.

`/health` now reports `persistence: "<backend>"`.

### `better-sqlite3` is a native module — TLS-interception gotcha (IMPORTANT)

`better-sqlite3` ships prebuilt binaries on GitHub, downloaded by `prebuild-install`
at `npm install`. Two traps on this network/Node combo:

1. **`better-sqlite3@12` dropped Node 20 prebuilts.** Its `node-` binaries are
   ABI v127+ (Node 22+) only, so on Node 20 (ABI **v115**) it falls back to a
   source compile. **Pin `better-sqlite3@11.10.0`** — the newest release that
   still ships a Node 20 / ABI-115 prebuilt for darwin + linux(musl).
2. **TLS interception blocks the download from Node.** `prebuild-install` (and
   node-gyp's `nodejs.org` headers fetch) fail with
   `unable to get local issuer certificate`. **`curl` reaches GitHub fine**, so
   vendor the prebuilt with curl instead of letting npm fetch it:
   ```bash
   # local dev (Apple Silicon):
   curl -sL -o .vendor/bs3-darwin-arm64.tar.gz \
     https://github.com/WiseLibs/better-sqlite3/releases/download/v11.10.0/better-sqlite3-v11.10.0-node-v115-darwin-arm64.tar.gz
   npm install better-sqlite3@11.10.0 --ignore-scripts
   tar -xzf .vendor/bs3-darwin-arm64.tar.gz -C node_modules/better-sqlite3/   # -> build/Release/better_sqlite3.node
   ```
   The container (`node:20-alpine` = **musl**) needs the `linuxmusl-<arch>`
   prebuilt; the Dockerfile vendors it the same way (see `.vendor/` + Dockerfile).

### Testing notes

- Hermetic: `test/persistence.test.js` runs the backend contract against BOTH
  filesystem + sqlite; `test/persistence-stores.test.js` exercises the real
  stores under sqlite; tenant-durability is covered too. `npm test` stays offline
  (sqlite writes to a temp file).
- Acceptance: `bash test/acceptance/run-all.sh` (filesystem) and `--sqlite` run
  the same black-box flow on each backend; the sqlite step proves the record
  survives an API/worker container restart.
