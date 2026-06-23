---
name: receipt-enricher-dev
description: >-
  Developer/operator guide for THE Receipt Enricher project — the receipt-photo
  → OCR → structured & enriched line-items app under
  ~/Projects/claude-receipt-ocr (Node/Express API,
  BullMQ/Redis worker, Anthropic/OpenAI-vision-or-Tesseract OCR pipeline, Tavily
  enrichment, bash CLI, Telegram bot, server-rendered web views, node:test
  suite). Use this skill whenever working IN THIS repo: editing or debugging the
  API, worker, or pipeline; the receipt parser and store detection (KNOWN_STORES
  in src/parse); the OCR providers in src/ocr; receipt profiles & transformers
  (src/receiptProfiles — applying/seeding usGrocery1 or tesseractGroceryUs1,
  `--profile`/profileId uploads, an "unknown profile" 400, or pinning the OCR
  engine via OCR_PROVIDER); multi-tenancy (tenant/user composite ids
  `<tenant>:<user>:<cacheId>`, per-tenant queues, tenant accounts, identity
  headers/defaults — src/identity.js & src/tenants.js); Tavily enrichment; the
  CLI or web views; running the hermetic, live, or bash/curl acceptance tests (e.g.
  `npm run test:live:vision` skipping, Tesseract producing garbage, or
  `test/acceptance/run-all.sh`); standing up or tearing down the containerized
  stack with podman-compose (or docker compose); processing a receipt or viewing
  its extracted metadata at localhost:8080; uploading via the REST API with curl;
  or hitting the project's known gotchas (TLS interception breaking jsdelivr/Tavily
  but not Anthropic, an empty ANTHROPIC_API_KEY shadowing .env, Tesseract needing
  local tessdata (orientation is auto-corrected via Tesseract OSD),
  `podman compose` vs `podman-compose`, a new seedProfiles file not taking until
  `down -v`, or the vision MODULE_NOT_FOUND import bug).
  Consult it before guessing how this codebase is wired or why an
  extract/parse/enrich/test step behaves as it does. It covers developing and
  running THIS app — not generic OCR/PDF extraction, generic BullMQ/Redis/Docker/
  Express setups in other projects, or one-off "read this receipt photo for me"
  requests; for those, do not use this skill.
---

# Receipt Enricher — developer guide

Turn a phone photo of a grocery receipt into structured, enriched line items.
A receipt image arrives (CLI, Telegram, or raw REST), the API saves it and
enqueues a job, and a worker runs **extract → parse → enrich → summarize**,
producing a durable JSON record viewable as HTML or JSON.

## Where things live

Working-dir root: `~/Projects/claude-receipt-ocr`. The Node project
lives at the **repo root** (flat layout — no `receipt-enricher/` subdirectory);
run `npm`/`node` from the repo root. (An older sibling checkout,
`../claude-ocr-receipt/receipt-enricher`, used a nested layout and still holds
the known-good blobs the fetch scripts copy from — see Getting started.)

```
claude-receipt-ocr/            # repo root = the Node project
├─ src/
│  ├─ server.js            # Express API + web views (port 8080)
│  ├─ worker.js            # BullMQ worker that runs the pipeline
│  ├─ bot.js               # Telegram bot (optional; relays to the REST API)
│  ├─ config.js            # all env-driven config (READ THIS to understand modes)
│  ├─ identity.js          # MULTI-TENANCY: composite-id scheme + scoped path/key + jobId helpers
│  ├─ tenants.js           # tenant registry: durable (persistence) + Redis SET; hydrate() at boot
│  ├─ queue.js  redis.js   # PER-TENANT BullMQ queues (receipts-<tenant>) + ioredis connections
│  ├─ persistence/         # PLUGGABLE record backend (PERSISTENCE): sqlite (default) | filesystem | TODO postgresql
│  ├─ store.js             # durable receipt records via persistence; image blob stays on fs (uploads/)
│  ├─ logger.js            # pino
│  ├─ routes/receipts.js   # REST routes + web view routes
│  ├─ routes/tenants.js    # tenant-account REST (GET/POST /api/tenants)
│  ├─ pipeline/index.js    # processReceipt(): orchestrates the 4 stages
│  ├─ ocr/  index.js vision.js tesseract.js   # extraction providers
│  ├─ parse/receiptParser.js     # normalizeStructured() + parseText() heuristics
│  ├─ enrich/ index.js tavily.js # Tavily lookup + Redis cache
│  ├─ receiptProfiles/     # profile engine, registry, stores + transformers/ (see "Receipt profiles")
│  ├─ products/            # product resolution stage (line item -> product info; see "Products")
│  │  ├─ resolvers/        # backend adapters: anthropic.js (+ types.js); tavily later
│  │  ├─ registry.js       # loads resolvers; active one = config.products.resolver
│  │  ├─ resolveService.js # runs the resolver over a profile result's items (parallel pool + cache)
│  │  ├─ productStore.js   # durable product results (data/<tenant>/<user>/products/<cacheId>/)
│  │  ├─ productCache.js   # shared Redis cache in front of per-SKU lookups (+ export/import)
│  │  └─ productEvents.js  # Redis ring buffer of per-lookup events (feeds /products/monitor)
│  ├─ routes/products.js   # product REST + web views + live monitor + cache export/import
│  ├─ web/view.js          # server-rendered HTML (renderReceipt / renderList)
│  └─ healthcheck.js  healthcheck-worker.js   # container healthchecks (see Podman)
├─ cli/receipts            # bash + curl CLI (no Node needed)
├─ cli/products            # bash + curl CLI: product cache export/import/stats
├─ scripts/                # fetch + verify 3rd-party blobs (see its README) — fetch-tessdata.sh,
│                          #   fetch-better-sqlite3.sh, download-paddleocr-*.py, verify-blobs.sh, SHA256SUMS.txt
├─ test/                   # node:test suite — see test/README.md
│  ├─ *.test.js            # hermetic (no network/redis/keys); run by `npm test`
│  ├─ live/*.live.test.js  # real services; self-skip when prereqs absent
│  ├─ acceptance/          # bash/curl black-box suite vs a container stack (see its README)
│  ├─ fixtures/ helpers/   # costco sample fixtures + harness (fetch/redis stubs)
├─ tessdata/               # offline Tesseract eng/osd.traineddata (gitignored; fetch via scripts/)
├─ .vendor/                # better-sqlite3 native prebuilts (gitignored; fetch via scripts/)
├─ docs/API.md             # full HTTP API reference + curl walkthrough
├─ data/                   # durable records, scoped per identity: data/<tenant>/<user>/{receipts,uploads,profileResults,products}/ (+ data/<tenant>/receiptProfiles/)
├─ docker-compose.yml      # PARAMETERIZED (project/port/OCR/label/base-url) — see Podman
├─ Dockerfile  Containerfile  .env.example
└─ README.md

# Test corpus is a SIBLING repo (moved out of this project):
../codex-receipt-ocr-human-reviewed-ground-truth/samples/   # human-reviewed ground truth
├─ costco/*.jpg           # Costco receipts, descriptively named: costco-<store>-<date>[-total-…|-original|-rotated|-sideways].jpg
└─ samsclub/*.jpg         # Sam's Club receipts: samsclub-<store>-<date>-total-…
```

OCR now **auto-corrects orientation** before recognizing (Tesseract OSD — see
the gotchas), so files are named by content/orientation (e.g.
`costco-boca-raton-2026-05-26-original.jpg` and its `-rotated`/`-sideways`
siblings): feed any sample to Tesseract regardless of how it was shot.

### Reference docs (read these instead of guessing or duplicating)

- **`README.md`** (repo root) — the **canonical user-facing guide**: quick
  start, the modes table, the full env-var **Configuration reference**, Podman
  notes, REST/Telegram usage, and Troubleshooting. It's the source of truth for
  "how does an operator run/configure this?" — read it (don't restate it) when a
  question is about setup, config defaults, or the supported run modes.
- **`docs/API.md`** — full HTTP API reference + curl walkthrough.
- **`test/README.md`** — test design / coverage map.
- **`scripts/README.md`** — how to fetch & checksum-verify the gitignored blobs
  (tessdata, better-sqlite3 prebuilts, optional PaddleOCR model assets).
- **[`references/stack-bringup.md`](references/stack-bringup.md)** — idioms for
  standing up a fresh, isolated stack for a purpose (qa/feat prefixes), built on
  the parameterized compose file; points back to the README for the rest.

## Getting started (local dev)

```bash
cd ~/Projects/claude-receipt-ocr
npm install --ignore-scripts          # TLS interception blocks better-sqlite3's native build (see persistence)
tar -xzf .vendor/better-sqlite3-v11.10.0-node-v115-darwin-arm64.tar.gz \
    -C node_modules/better-sqlite3/   # drop in the vendored prebuilt (macOS arm64)
npm test                              # ~274 hermetic tests — no network, no Redis, no API keys
```

A **fresh clone/worktree lacks the gitignored blobs** (`tessdata/*.traineddata`,
`.vendor/*.tar.gz`) and `node_modules`. Fetch + checksum-verify the blobs first
with the fetch scripts (they copy from the known-good sibling checkout
`../claude-ocr-receipt/receipt-enricher` when present, else download):

```bash
scripts/fetch-all.sh      # tessdata + better-sqlite3, all verified vs scripts/SHA256SUMS.txt
```

The hermetic suite must always pass and stay self-contained (it stubs `fetch`
and injects a fake Redis; see `test/helpers/harness.js`). `npm test` is scoped
to `test/*.test.js` so the live tests never run by accident. **It does read one
real file**: the ground-truth sample image at
`../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-original.jpg`
(via `test/fixtures/costco-sample.js`), so that sibling repo must be checked out.

### Running the app

Three ways, depending on whether you need the queue/worker:

- **Read-only / no Redis:** `npm run server`, then open http://localhost:8080.
  Redis-connection errors in the log are harmless — only the upload→queue path
  needs Redis; the read/view endpoints read records straight from `data/`.
- **Process a receipt without the queue:** call `pipeline.processReceipt(id)`
  directly (how records get seeded locally — see "Process a receipt locally").
- **Full stack (the real upload→queue→worker path):** run it in containers with
  Podman — see "Containerized stack (Podman)" below.

## Containerized stack (Podman)

Podman **is** installed on this host (older notes that said "no Podman" are
stale). What you need to know:

- The binary lives at **`/opt/podman/bin`** and isn't always on `PATH` —
  `export PATH="/opt/podman/bin:$PATH"` first. The VM is a running `applehv`
  machine (`podman machine list`; `podman machine start` if stopped).
- **Use `podman-compose` (hyphen), NOT `podman compose`.** Plain `podman
  compose` delegates to an external `docker-compose` provider that can't reach
  the podman socket here ("Cannot connect to the Docker daemon"). The hyphenated
  `podman-compose` (a pyenv/pip shim) drives the CLI directly and works.
- `podman-compose` does **not** auto-recreate running containers on `up` (you
  get "container name already in use"). To apply code/compose/env changes:
  `podman-compose -p receipt-enricher down` then `podman-compose -p receipt-enricher up --build -d`.
- **Always pass `-p receipt-enricher`.** podman-compose names built images
  `<project>_<service>` and resolves the project name from (in order) the `-p`
  flag → `COMPOSE_PROJECT_NAME` → the compose `name:` (`${RECEIPT_PROJECT:-receipt-enricher}`)
  → the dir basename. A `RECEIPT_PROJECT` or `COMPOSE_PROJECT_NAME` left exported
  in your shell silently poisons the name; an invalid value (one not starting
  with a letter/digit) makes the build fail with `Error: tag
  _-receipt-enricher_worker: invalid reference format` (podman rejects the image
  tag — note `redis` still builds since it uses a prebuilt image). The norm regex
  `[^-_a-z0-9]` keeps leading `_`/`-`, so the junk survives to the tag. `-p` wins
  over both env vars and `name:`, so it's deterministic regardless of environment.
  If you skip `-p`, first `echo "$RECEIPT_PROJECT"; echo "$COMPOSE_PROJECT_NAME"`
  and `unset` any stray value.

```bash
export PATH="/opt/podman/bin:$PATH"
cd ~/Projects/claude-receipt-ocr      # repo root (the compose file lives here)
podman-compose -p receipt-enricher up --build -d   # redis + api(:8080) + worker
curl -fsS localhost:8080/health | jq .
podman-compose -p receipt-enricher down            # stop, KEEP volumes
podman-compose -p receipt-enricher down -v         # stop + WIPE data volumes (fresh slate)
```

**Pin the OCR engine at `up` time** by prefixing the env var (it's a host-side
compose param, *not* a CLI/per-upload flag): `OCR_PROVIDER=tesseract
podman-compose -p receipt-enricher up --build -d`. Add `--no-cache` for a
guaranteed clean image (the README quick-start does). `/health` is your
confirmation — it returns `{status, redis, ocrProvider, enrichment,
receiptProfiles, time}` (`src/app.js`), so `jq '{status, ocrProvider,
receiptProfiles}'` tells you in one shot whether the engine pin took
(`ocrProvider: "tesseract"` vs a plain `up`'s `"auto"`) and how many profiles
seeded. `status` is `ok` only when Redis is up.

The compose file is **parameterized** with prod-safe defaults, so the same file
serves prod and the test suite: `RECEIPT_PROJECT` (project name),
`RECEIPT_API_PORT` (host port), `OCR_PROVIDER`, `RECEIPT_SUITE` (container
label), `PUBLIC_BASE_URL`. A plain `up` is unchanged (project `receipt-enricher`,
port 8080, `auto` OCR). **`PUBLIC_BASE_URL` defaults to `http://localhost:8080`
and is what the API advertises in `statusUrl`/`viewUrl`** — set it whenever the
published host port differs (e.g. the test stack on 18080) or links point at the
wrong port.

**Fresh stack for a specific purpose (qa / feat / repro).** Because the compose
file is parameterized, you can run a second, fully isolated stack by varying
host-side env vars — pick a purpose **prefix** and a free port, and keep `-p`,
`RECEIPT_PROJECT`, and `PUBLIC_BASE_URL` consistent (volumes are namespaced by
project name, so isolation from prod is automatic):

```bash
PREFIX=feat; PORT=38080; PROJ=${PREFIX}-receipt-enricher   # qa→28080, feat→38080, …
RECEIPT_PROJECT=$PROJ RECEIPT_API_PORT=$PORT RECEIPT_SUITE=$PREFIX \
PUBLIC_BASE_URL=http://localhost:$PORT OCR_PROVIDER=tesseract \
  podman-compose -p "$PROJ" up --build --no-cache -d
API_URL=http://localhost:$PORT ./cli/receipts health        # CLI needs API_URL set
podman-compose -p "$PROJ" down -v                            # teardown (same -p!)
```

The acceptance suite is just the canonical instance of this pattern
(`test-receipt-enricher` on `18080`). **For the full parameter matrix, port
convention, and the prefix-specific gotchas, read
[`references/stack-bringup.md`](references/stack-bringup.md).**

**Healthchecks are real** (`src/healthcheck.js` GETs `/health`;
`src/healthcheck-worker.js` PINGs Redis). They're *script files*, not inline
`node -e "..."`: the runtime runs the healthcheck via `/bin/sh`, where parens in
an inline program (`fetch(...)`) throw `syntax error` and the container shows
`unhealthy` forever.

## Acceptance suite (bash/curl) — `test/acceptance/`

Black-box tests that bring the stack up in containers and drive it from the
outside via the CLI and raw curl. Separate from `npm test` (hermetic) and
`test/live/*` (node-driven). Full details in `test/acceptance/README.md`.

```bash
cd ~/Projects/claude-receipt-ocr
bash test/acceptance/run-all.sh                # up → cli/ + rest/ steps → teardown
bash test/acceptance/run-all.sh --vision       # Anthropic instead of Tesseract
bash test/acceptance/run-all.sh --no-teardown  # leave the stack up to inspect
bash test/acceptance/rest/20_upload.sh         # one step (stack must be up first)
```

- **Layout:** `lib/{common,compose}.sh`, `lifecycle/{00_up,99_down}.sh`, `cli/*`
  (via `cli/receipts`), `rest/*` (raw curl). Steps are independently runnable and
  self-seed a receipt (cached id in `.state/`, gitignored).
- **Isolated from any prod stack on the host:** distinct project
  `test-receipt-enricher`, host port `18080`, label `io.receipt-enricher.suite=
  test`, separate volumes. Teardown is scoped to the test project and **refuses
  to run against the prod name `receipt-enricher`**; removes volumes by default
  (`RE_TEST_KEEP_VOLUMES=1` keeps them).
- **OCR default = offline Tesseract** — works in-container because
  `tesseract.js-core` (wasm) and `tessdata/eng.traineddata` are bundled, so no
  CDN. `RE_TEST_OCR=vision` uses `claude-sonnet-4-6`. Assertions are structural +
  HTTP only; item-count/store are asserted only on the vision path (Tesseract
  text is noisy by design).
- **Engine:** `podman` by default; `RE_TEST_ENGINE=docker` switches to
  `docker compose`. Config: `RE_TEST_{ENGINE,PROJECT,API_PORT,BASE,OCR,SAMPLE,
  KEEP_VOLUMES,NO_TEARDOWN,POLL_TIMEOUT}`.

## Extraction modes & expected behavior

Provider selection is computed in `config.js` from env (`OCR_PROVIDER=auto` by
default):

| You have…                       | Extraction     | Enrichment        |
|---------------------------------|----------------|-------------------|
| nothing                         | Tesseract OCR  | skipped           |
| `TAVILY_API_KEY`                | Tesseract OCR  | Tavily images     |
| `ANTHROPIC_API_KEY` (or OpenAI) | vision model   | skipped           |
| both                            | vision model   | Tavily images     |

Receipt lifecycle (`status`): `queued → processing → done` (or `failed`).
Canonical parsed shape: `{ store:{name,date}, items:[{description,sku,qty,
unitPrice,price,enrichment}], totals:{subtotal,tax,total,itemCount,sumOfItems,
subtotalMatch} }`. `parse/receiptParser` canonicalizes known store names to the
chain (vision's "Costco Wholesale" → "Costco" via `KNOWN_STORES`), and
`subtotalMatch` is a data-quality signal (do items reconcile with the printed
subtotal? `null` if none). The pipeline summary flags a *shortfall* — items
summing under the subtotal, a likely missed line (an overage is expected when a
discount line is excluded, so it isn't flagged).

**Quality reality:** the vision path reads layout, returns clean items, the
store name, even discount lines, and handles a rotated photo with no
preprocessing — it is the recommended path. Tesseract is a best-effort offline
fallback: it needs an upright, sharp image and produces noisy descriptions and
the occasional digit slip. The bigger/“best” Tesseract model is not meaningfully
better here — image quality is the bottleneck, not the model.

## Multi-tenancy (identity, scoping, per-tenant queues)

Every resource is owned by an identity — a **(tenantId, userId)** pair — and a
resource's public id is the **composite id** `"<tenant>:<user>:<cacheId>"`
(e.g. `main:main:1b70d95bbd9f462f`). `src/identity.js` is the single home for the
scheme; change it there, nowhere else. Segments are `[A-Za-z0-9_-]{1,64}` (UUIDs,
`main`, …) and deliberately exclude `:` and `/`.

- **The composite id IS the `receiptId` everywhere** — URLs, `job.data`, store
  lookups. The stores parse it (`identity.resolveId`) to derive scoped paths; the
  queue parses the tenant to pick its queue. So most call sites still pass a single
  "receiptId", it's just composite now. `identity.resolveId` is lenient: a **bare**
  id (no `:`) resolves under the default scope, which is why pre-existing ids and
  single-tenant tests keep working.
- **Identity on a request** (`identity.resolveIdentity`): `X-Tenant-Id`/`X-User-Id`
  headers → `tenantId`/`userId` form fields → the configured default
  (`config.defaultTenantId`/`defaultUserId`, env `DEFAULT_TENANT_ID`/`DEFAULT_USER_ID`,
  default `main`/`main`). It's resolved at **creation** (upload) and on collection
  endpoints (`GET /api/receipts`, `/api/products`, profile CRUD); receipt-scoped
  routes (`…/receipts/:id/…`) derive the tenant from the composite `:id` instead.
  **Strict mode:** set the defaults *empty* (`DEFAULT_TENANT_ID=`) and every request
  must carry the headers or it 400s. Unset entirely falls back to `main` (dev/tests).
- **Tenants are provisioned accounts** (`src/tenants.js`, a Redis SET `re:tenants`):
  an upload for an unknown tenant 400s ("unknown tenant"). Create one with
  `POST /api/tenants {tenantId}` (or `receipts tenant create <id>`), which also seeds
  that tenant's example profiles. The **default tenant is always allowed** and is
  auto-registered at boot (`server.js` calls `tenants.ensureDefault()`).
- **What's scoped vs shared:**

  | Data | Scope | Location / key |
  |------|-------|----------------|
  | receipts, uploads, profile **results**, product **results** | per tenant **+ user** | `data/<tenant>/<user>/…` |
  | profile **definitions** | per **tenant** (lazily seeded) | `data/<tenant>/receiptProfiles/` |
  | enrich cache | per **tenant** | `<tenant>:enrich:tavily:<sha1>` |
  | product (SKU→product) cache + `/products/monitor` events | **global** (cross-tenant) | `products:<resolver>:<sha1>`, `products:events` |

  `store.list`/`resultStore.listAll`/`productStore.listAll` take a scope (default
  identity); `profileStore.*` take a trailing `{ tenantId }` (default tenant).
- **Per-tenant queues + the worker registry watch.** Each tenant has its own queue
  `receipts-<tenant>`. The worker (`worker.js start()`) registers the default
  tenant, lists `re:tenants`, runs one BullMQ `Worker` per tenant queue, and
  **re-polls the registry** (every `TENANT_WATCH_MS`, default 5s) so a tenant
  onboarded at runtime gets a Worker without a restart. This is exactly what
  `test/acceptance/rest/95_multitenancy.sh` proves end-to-end (a runtime-created
  tenant's upload reaching `done`).
- **`:` is forbidden in BOTH BullMQ queue names and custom job ids** (see Guardrails),
  so the queue uses a `-` separator and `identity.jobId()` hashes the composite id.

Hermetic coverage: `test/{identity,tenants,multitenancy,queue}.test.js`; live
coverage: the acceptance step above.

## Persistence layer (pluggable record backend)

Durable records go through a **pluggable persistence layer** (`src/persistence/`)
chosen by `PERSISTENCE` — exactly like `OCR_PROVIDER` picks the OCR engine, NOT
per-record. Backends implement a generic document interface (`get/put/delete/
list`) over a key tuple `{ kind, tenant, user, id, sub }`; the four record stores
(`store.js`, `receiptProfiles/{profileStore,resultStore}.js`,
`products/productStore.js`) and the tenant registry call it instead of touching
`fs` directly.

- **`sqlite`** (the **default**) — one generic `docs` table in a SQLite file
  (`SQLITE_PATH`, default `<DATA_DIR>/receipt-enricher.db`) via `better-sqlite3`.
- **`filesystem`** — the original scope-partitioned JSON files under `DATA_DIR`;
  byte-identical layout, so pre-existing data still reads.
- **`postgresql`** — TODO; the selector throws a clear "not implemented" error.

**Image blobs always stay on the filesystem** (`uploads/`) regardless of backend
(`store.imagePathFor` unchanged); a blob-store abstraction (e.g. S3) is future work.

**The tenant registry is durable.** `src/tenants.js` writes the provisioned-tenant
list through the persistence layer *and* the Redis SET (`re:tenants`); at boot
`tenants.hydrate()` (called in `server.js` and `worker.js`) repopulates the Redis
SET from the durable list, so the tenant list survives a Redis recycle. Redis is
still the runtime working copy the worker watches. `/health` reports
`persistence: "<backend>"`.

### `better-sqlite3` is a native module — two hard-won traps

`better-sqlite3` ships prebuilt binaries on GitHub, fetched by `prebuild-install`
at `npm install`. On this Node 20 + TLS-interception setup, BOTH bite:

1. **`better-sqlite3@12` dropped Node 20 prebuilts** (ships ABI v127+/Node 22+ only),
   so on Node 20 (ABI **v115**) it falls back to a source compile. **Pinned to
   `better-sqlite3@11.10.0`** — the last release with a Node-20 prebuilt for
   darwin + linux(musl). Don't bump it without re-checking prebuilt availability.
2. **TLS interception blocks the download from Node** (`prebuild-install` and node-gyp
   fail with `unable to get local issuer certificate`). **`curl` is NOT blocked**,
   so the prebuilts are vendored with curl into `.vendor/` (gitignored, fetched
   per machine like `tessdata`). Fetch + verify them with
   **`scripts/fetch-better-sqlite3.sh`** (copies from the sibling checkout or
   downloads from GitHub, then checks `scripts/SHA256SUMS.txt`); see also
   `.vendor/README.md`. Local dev: `npm install --ignore-scripts` then `tar -xzf
   .vendor/better-sqlite3-v11.10.0-node-v115-darwin-arm64.tar.gz -C
   node_modules/better-sqlite3/`. The container (`node:20-alpine` = **musl**)
   build does the same with the `linuxmusl-<arch>` prebuilt (see `Dockerfile`). A
   fresh worktree/clone lacks `.vendor/*.tar.gz` — re-fetch with the script
   (same gotcha as the missing `tessdata` blobs).

### Testing the persistence layer

- **Hermetic:** `test/persistence.test.js` runs the backend contract against BOTH
  `filesystem` + `sqlite`; the rest of `npm test` runs on the **default sqlite**,
  and `test/persistence-stores.test.js` pins `filesystem` so both backends are
  covered store-level in one run. Tenant durability (`hydrate()` after a simulated
  Redis recycle) is covered too. `npm test` stays offline (sqlite → temp file).
- **Acceptance:** `RE_TEST_PERSISTENCE` (default `sqlite`; `--sqlite` /
  `--persistence fs` flags) + `test/acceptance/rest/96_persistence.sh` assert the
  active backend, that the sqlite DB lands on the data volume, and that a record
  **survives an api/worker restart**; `stack/10_container_contents.sh` verifies
  the native module loads. Both backends pass 18/18.

## Receipt profiles & transformers (post-OCR cleanup)

A *profile* is metadata that binds a name to a **transformer** — a code module
under `src/receiptProfiles/transformers/` (loaded by `registry.js`, listed at
`GET /api/transformers`). Applying a profile runs the transformer over a parsed
receipt and stores the result **separately** with a change log; the original
record is never mutated. This is orthogonal to OCR: the *engine* (Tesseract vs
vision) is chosen at stack-up time via `OCR_PROVIDER`; the *profile* is a
separate post-OCR step. Two transformers ship, each tuned to its OCR source:

| Transformer        | Tuned for         | What it does                                            |
|--------------------|-------------------|---------------------------------------------------------|
| `usGrocery`        | clean vision output | normalize store/date, fold per-item discounts, rewrite Costco water |
| `tesseractGroceryUs` | noisy Tesseract output | strip junk prefixes + embedded SKUs, Title-Case ALL-CAPS, recover store name, rewrite water |

**Seeding (and its sharp edge).** On boot `server.js` calls
`profileStore.seedIfEmpty()`, which loads **every** `*.json` in
`src/receiptProfiles/seedProfiles/`. Two seed files ship, so a fresh store gets
two profiles: **`usGrocery1`** (→ `usGrocery`, the vision pairing) and
**`tesseractGroceryUs1`** (→ `tesseractGroceryUs`, the Tesseract pairing). The
gotcha is in the name: it seeds **only when the profile store is empty**. Adding
or changing a seed file therefore does *nothing* to an existing store — you must
wipe the data volume (`podman-compose -p receipt-enricher down -v`) and bring it
back up for new seeds to take. Confirm with `curl -fsS localhost:8080/health |
jq .receiptProfiles` (expect 2) or `GET /api/receiptProfiles`. Profile names
must be camelCase letters/digits, no dashes/spaces (`validate.js` `NAME_RE`).

**Applying a profile.** Three paths: at upload (`receipts upload <img> --profile
<id|name>`, or raw `-F profileId=<id|name>` → runs a BullMQ flow: OCR child →
applyProfile parent); after the fact (`POST /api/receipts/<id>/applyProfile/
<name>`, `?async=1` to queue it); or server-wide via `DEFAULT_PROFILE_ID`
(`config.defaultProfileId`) so every upload that omits one gets it.
`profileStore.get()` resolves a profile by `rp_…` id **or** by name. The cleaned
result is at `GET /api/receipts/<id>/profileResults/<name>` and viewable at
`…/profileResults/<name>/view`.

**Debugging a profile upload that 400s.** `receipts upload --profile foo` failing
with a bare `curl: (22) … 400` almost always means the profile doesn't exist —
the route returns `400 {"error":"unknown profile \"foo\""}`, but the CLI's
`curl -fsS` swallows the body so you only see the code. See the real error with:
`curl -sS -o /tmp/b -w 'HTTP %{http_code}\n' -F receipt=@<img> -F
profileId=<name> localhost:8080/api/receipts; cat /tmp/b`. The fix is usually to
register/seed the profile (see seeding above), not to change the upload.

## Products (line item → product) — the final stage

After a profile result exists, the **product resolver** maps each cleaned line
item to product info: `productTitle`, `productDescription`, `productUrl` (the top
substantiating web link), `brand`, `category`, `emoji` (see below), `confidence`. The backend is a
configurable **resolver adapter** chosen by config — exactly like `OCR_PROVIDER`
picks the OCR engine, NOT a per-receipt record. This intentionally does **not**
mirror receiptProfiles' CRUD model (there is no "product profile" object and no
per-item config).

- **Resolvers** live in `src/products/resolvers/` (code modules, like
  transformers), loaded by `registry.js`, listed at `GET /api/productResolvers`.
  The active one is `config.products.resolver` (`PRODUCT_RESOLVER`, default
  `anthropic`). A `tavily` resolver is a future drop-in (deferred — Tavily is
  TLS-blocked on this network; see gotchas).
- **`anthropic` resolver** calls a low-end model (`PRODUCT_ANTHROPIC_MODEL`,
  default `claude-haiku-4-5`) via raw `fetch` to `/v1/messages` (mirrors
  `src/ocr/vision.js` — no SDK). With `PRODUCT_ANTHROPIC_WEB_SEARCH=1` (default)
  it enables Anthropic's **server-side** `web_search`/`web_fetch` tools so the
  link is real and grounded — the retrieval runs on Anthropic's infra, which is
  why it works here even though direct Tavily/CDN fetches are TLS-blocked. It
  handles `pause_turn` by re-sending.
- **Input is always a profile result** (`receiptId` + `receiptProfileId`);
  results are keyed by the source profile id at
  `data/products/<receiptId>/<profileId>.json`.
- **Graceful degrade** (mirrors enrich): no key / disabled → items list with null
  product fields and `stats.skipped`; a per-item error is recorded in `error`.
- **Product emoji (on by default, optional).** Each product also gets a single
  meaningful `emoji` (🥚 for Kirkland eggs, 🥛 for milk), rendered in the product
  view's 64px image placeholder (`.thumb.emoji` in `view.js`; products carry no
  real image). It's requested in the SAME resolver call that identifies the
  product — **zero extra backend calls**. Gated by `config.products.emoji`
  (`PRODUCT_EMOJI_ENABLED`, default `1`): when off, `anthropic.js#buildSystem`
  drops the emoji clause from the system prompt AND `resolve()` forces
  `emoji:null`, so the flag is authoritative end-to-end. `normalizeEmoji()` only
  accepts a short string containing a real `\p{Extended_Pictographic}` glyph
  (rejects prose / `"none"` / `"N/A"`), so junk never reaches the view. The emoji
  rides in the shared product cache value like the other fields.

**Run it.** Three paths, mirroring profiles:
- At upload: **on by default** whenever a profile is applied
  (`PRODUCT_RESOLVE_ON_UPLOAD=1`) — a 3-level BullMQ flow `process-receipt` →
  `applyProfile` → `resolveProducts`. Opt out per-upload with form field
  `resolveProducts=0`. (Products need a profile, so an upload with no
  `profileId`/`DEFAULT_PROFILE_ID` is OCR-only.) Note: the receipt reaches
  `status:done` after OCR (the child job), *before* `applyProfile`/`resolveProducts`
  run — so `receipts ... --wait` returns before products are ready; poll
  `GET /api/receipts/<id>/products/<profile>` (404 until persisted).
- After the fact: `POST /api/receipts/<id>/profileResults/<profileId>/resolveProducts`
  (`?async=1` to queue, `?dryRun=1` to skip persistence).
- Read: `GET /api/receipts/<id>/products[/<profileId>]`, `GET /api/products`;
  HTML at `/products` and `/receipts/<id>/products/<profileId>/view` (renders only
  a STORED result — never resolves fresh on a GET, since resolution makes live
  backend calls). Job ids stay `:`-free: `resolveProducts-<receiptId>-<profileId>`.

**Config** (`config.products`): `enabled` (`PRODUCTS_ENABLED`), `resolver`,
`maxItems` (`PRODUCT_MAX_ITEMS`, default 100), `concurrency` (`PRODUCT_CONCURRENCY`,
default 5), `cacheEnabled`/`cacheTtlSeconds` (`PRODUCT_CACHE_ENABLED`,
`PRODUCT_CACHE_TTL_SECONDS`, default 30d), `eventsMax` (`PRODUCT_EVENTS_MAX`,
default 500), `resolveOnUpload`, `emoji` (`PRODUCT_EMOJI_ENABLED`, default on),
and an `anthropic` block reusing the vision Anthropic creds. `/health` includes
`products: { enabled, resolver, emoji }`.

**Gotcha — web tools on Haiku need `allowed_callers: ['direct']`.** The
`web_search_20260209`/`web_fetch_20260209` tools default to the *programmatic
tool calling* (dynamic-filtering) caller, which Haiku 4.5 does NOT support —
without `allowed_callers: ['direct']` every resolve 400s with "does not support
programmatic tool calling". `resolvers/anthropic.js#buildTools` sets it; keep it.
Verified live: with the fix, Haiku 4.5 resolves clean vision line items to real
products with grounded retailer URLs. (Fallback: `PRODUCT_ANTHROPIC_MODEL=claude-sonnet-4-6`.)

**Performance — shared cache + parallel lookups.** Each SKU lookup is an
independent, network-bound backend call, so `resolveService` resolves a receipt's
items in a **bounded parallel pool** (`PRODUCT_CONCURRENCY`, default 5) instead of
one-at-a-time, and fronts every lookup with a **shared, Redis-backed cache**
(`src/products/productCache.js`). The key is `products:<resolver>:sha1(store|sku|
description)` — price/qty are deliberately excluded so the same product recurring
across receipts/sessions is a hit. It lives in Redis, so it's shared across all
worker/server processes (not per-process); only non-null results are cached
(mirrors enrich), and a Redis error degrades to a miss, never a failure.
`stats.cached` is a sub-count of `stats.resolved` (so `resolved+skipped+errors`
still equals the item count). Config: `PRODUCT_CACHE_ENABLED`,
`PRODUCT_CACHE_TTL_SECONDS` (default 30d).

**Live monitor (technical console).** `GET /products/monitor` (alias
`/observe/cache/products`; `?interval=<sec>`, a trailing `s` is tolerated) is a
dark, auto-refreshing, autoscrolling page that tails product lookups and makes
**cache HITs obvious** (green rows, ~0 ms latency, live hit-rate /
backend-time-avoided). It polls `GET /api/products/events`, a JSON feed over a
Redis ring buffer of per-lookup events (`src/products/productEvents.js`, list
`products:events`, capped by `PRODUCT_EVENTS_MAX` (default 500; `0` disables)).
The buffer is Redis-backed ON PURPOSE: the **worker** resolves while the
**server** renders the page — different processes — so an in-process array
wouldn't be visible. Each event: `{seq, ts, outcome: hit|miss|empty|error,
latencyMs, store, sku, description, productTitle, confidence, cacheKey,
receiptId, model, dryRun}`.

**`products` CLI + cache export/import.** A companion bash+curl CLI (`cli/products`,
alongside `cli/receipts`) manages the product layer — chiefly snapshotting the
shared cache:
- `products cache export <path.json>` → `GET /api/products/cache/export`
- `products cache import <path.json> [--flush]` → `POST /api/products/cache/import` (`?flush=1`)
- `products cache stats` → `GET /api/products/cache/stats`
- `products resolvers` / `products health`

Export/import is a **parallel, offline path to populating product data** — seed a
known cache before an acceptance run so SKU lookups are served from cache instead
of live Anthropic calls. The export doc is `{type:"receipt-enricher/products-
cache", version, exportedAt, resolver, count, entries:[{key,value,ttlSeconds}]}`;
import accepts that or a bare entries array, skips reserved `products:events*`
keys, and falls back to `PRODUCT_CACHE_TTL_SECONDS` when an entry omits a TTL. The
acceptance step `test/acceptance/cli/50_productsCacheIo.sh` exercises the
round-trip fully offline (no Anthropic key needed).

## Environment gotchas (hard-won — check these first when something "doesn't work")

This repo is developed on a managed network, which causes several
non-obvious failures. Before debugging code, rule these out:

1. **TLS interception.** Node uses its *own* CA bundle (separate from
   the macOS keychain / `curl`), so on this network outbound HTTPS to *some*
   hosts fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Observed:
   `api.anthropic.com` ✅ reachable, `cdn.jsdelivr.net` ❌ blocked,
   `api.tavily.com` ❌ blocked. Consequences: the vision path works, but the
   Tesseract first-run CDN download and Tavily enrichment fail.
   **Fix:** `export NODE_EXTRA_CA_CERTS=/path/to/internal-root-ca.pem` (proper) or
   `NODE_TLS_REJECT_UNAUTHORIZED=0` (insecure, dev-only). `npm install` works.

2. **An empty `ANTHROPIC_API_KEY` is exported in the shell** (`""`). `dotenv`
   never overwrites an already-set variable, so that empty export *shadows* the
   key in `.env`. Symptom: vision skips/fails with "no API key" even though the
   key is in `.env`. **Fix:** `unset ANTHROPIC_API_KEY` (the real app uses plain
   `dotenv`, so it needs this). The live tests already work around it by loading
   `.env` with `override: true` (see `test/live/_shared.js`).

3. **`.env` location.** The app loads `.env` from the repo root (the project dir).
   The live-test helper loads it with override. `config.js` uses plain
   `dotenv.config()` (cwd-relative, no override).

4. **Tesseract needs local language data (orientation is now auto-handled).**
   - **Orientation:** the pipeline auto-corrects rotation before recognizing —
     `src/ocr/tesseract.js` runs Tesseract OSD (`tessdata/osd.traineddata`, the
     legacy oem-0 core) to detect the 90° quadrant, then recognizes with it
     corrected; with nothing to correct it falls back to `rotateAuto` for skew.
     OSD is best-effort (skips below `config.tesseractOsdMinConfidence`, or if
     `osd.traineddata` is missing). So you no longer need an upright copy — feed
     any orientation; the old `rotated_*` samples were deleted accordingly.
   - Language data lives in `tessdata/eng.traineddata` (offline; gitignored —
     fetch + verify with **`scripts/fetch-tessdata.sh`**; see also
     `tessdata/README.md`). The code points Tesseract there via
     `config.tessdataDir` (override `TESSDATA_PATH`), so no CDN download is
     needed. Without local data on a CDN-blocked network, `tesseract.js` hangs
     (its download has no timeout) — the live test preflights and skips fast.
   - In the **container**, Tesseract runs fully offline: `tesseract.js-core`
     (wasm) is reinstalled by `npm ci` and `tessdata` is `COPY`d in, so the
     CDN-hang doesn't apply there.

5. **`podman compose` vs `podman-compose`, and a substitution bug.** Use the
   hyphenated `podman-compose` (see "Containerized stack"). Also, podman-compose
   mishandles **nested** `${VAR:-...${VAR2:-x}}` default expansions — it leaks a
   literal `}` into the value. Keep compose interpolation **flat** (this is why
   `PUBLIC_BASE_URL` defaults to a literal `http://localhost:8080`, not a nested
   `...${RECEIPT_API_PORT}`).

## Testing model

- **Hermetic** (`npm test`): each `test/*.test.js` runs in its own process,
  stubs global `fetch`, injects an in-memory fake Redis via the require cache,
  and uses a temp `DATA_DIR`. No keys, no network, no Redis. Keep it that way.
- **Live** (`npm run test:live:vision|tesseract|stack|samples`): real services,
  each self-skips when its prerequisite (API key / local lang data / running
  stack) is missing, and prints the extracted receipt. `SAMPLE_IMAGE` overrides
  the input photo for the single-image tests; `test:live:samples` runs the
  vision model over the whole
  `../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/` corpus as a
  quality smoke test.
- **Acceptance** (`test/acceptance/run-all.sh`): bash/curl black-box tests
  against a containerized stack, isolated from prod. See the dedicated section
  above and `test/acceptance/README.md`.
- Coverage map and the TLS-interception/Colab notes are in `test/README.md`.

## Common tasks

**Run one test file:** `node --test test/parser.test.js`

**See vision extraction on the real receipt (needs the key):**
```bash
cd ~/Projects/claude-receipt-ocr && unset ANTHROPIC_API_KEY   # drop the empty shadow var
npm run test:live:vision                          # auto-loads .env with override
```

**Run Tesseract offline on a sample (any orientation — auto-corrected):**
```bash
SAMPLE_IMAGE=../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-original.jpg npm run test:live:tesseract
```

**Run the whole sample corpus through the containerized Tesseract + cleanup
profile** (the CLI selects a *profile*, not the engine; the engine is pinned at
`up` time — see Receipt profiles for why both pieces are needed):
```bash
export PATH="/opt/podman/bin:$PATH"; cd ~/Projects/claude-receipt-ocr
OCR_PROVIDER=tesseract podman-compose -p receipt-enricher up --build -d
curl -fsS localhost:8080/health | jq '{status, ocrProvider, receiptProfiles}'  # expect tesseract, ≥2
for img in ../codex-receipt-ocr-human-reviewed-ground-truth/samples/*/*.jpg; do
  ./cli/receipts upload "$img" --wait --profile tesseractGroceryUs1
done
```

**Process a receipt locally and view it (no Docker/Redis):** load `.env` with
`{ override: true }` first, then `store.createReceipt(...)` →
`pipeline.processReceipt(id)` (enrichment auto-skips with no Tavily key, so the
cache/Redis is never touched), then `npm run server` and open
`http://localhost:8080/receipts/<id>/view`.

**Add/canonicalize a recognized store:** edit `src/parse/store-aliases.json`
(canonical name → lowercase alias substrings; override the path with
`STORE_ALIASES_PATH`). The parser loads it at startup and falls back to a
built-in list if the file is missing. **Add/adjust an extractor:** `src/ocr/`.
**Change the web view:** `src/web/view.js` (pure, dependency-free, unit-tested).

**Resolve products for a receipt's profile result (after a profile is applied):**
```bash
curl -fsS -X POST "localhost:8080/api/receipts/$ID/profileResults/tesseractGroceryUs1/resolveProducts" | jq .
# then: open "localhost:8080/receipts/$ID/products/tesseractGroceryUs1/view"
```
A 409 means the profile hasn't been applied yet; all-`skipped` means no
`ANTHROPIC_API_KEY` (degrades, no network). If items 400 with "does not support
programmatic tool calling", the web-tool `allowed_callers` fix is missing (see
Products) — or set `PRODUCT_ANTHROPIC_MODEL=claude-sonnet-4-6`.

**Watch product lookups + cache hits live:** open `localhost:8080/products/monitor`
(or `/observe/cache/products?interval=3s`) and resolve/upload some receipts —
cache HITs show green at ~0 ms vs amber backend misses. JSON behind it:
`curl -fsS "localhost:8080/api/products/events?limit=50" | jq .stats`.

**Snapshot / restore the product cache (e.g. seed a known cache before an
acceptance run so SKU lookups are cache hits, not live Anthropic calls):**
```bash
API_URL=http://localhost:8080 ./cli/products cache export /tmp/cache.json
API_URL=http://localhost:8080 ./cli/products cache import /tmp/cache.json --flush
API_URL=http://localhost:8080 ./cli/products cache stats
```

## Guardrails

- Keep `npm test` hermetic — never let it require network, Redis, or keys.
- Never commit secrets: `.env*` is gitignored (root + project); `.env.example`
  stays tracked.
- `src/ocr/vision.js` must require `../config`/`../logger` (one level up). A
  past bug used `./config`/`./logger`, which broke the entire vision path with
  `MODULE_NOT_FOUND`; `ocr-vision.test.js` and `pipeline.test.js` guard it.
- **BullMQ forbids `:` in BOTH queue names AND custom job ids.** Composite ids are
  full of `:`, so: the per-tenant queue uses a `-` separator (`receipts-<tenant>`,
  `queue.js#queueNameFor`) and job ids hash the composite id (`identity.jobId` →
  `receipt-<sha1>`). A past `receipt:<id>` job id, and (this session) a
  `receipts:<tenant>` queue name, each made *every* upload fail with HTTP 400
  ("Custom Id cannot contain :" / "Queue name cannot contain :"). The hermetic
  suite's fake Redis doesn't validate either (it stores the job but never enqueues
  to real BullMQ) — the **acceptance suite catches both**, since it hits real Redis.
  Keep queue names and job ids `:`-free. `test/queue.test.js` guards the naming.
- The acceptance suite must stay isolated: never point its teardown at the prod
  project, never bind the prod host port. Defaults (`test-receipt-enricher`,
  18080) already ensure this; the teardown guard refuses the prod name.
- **Tesseract (and better-sqlite3) blobs aren't in git** (`tessdata/*.traineddata`
  and `.vendor/*.tar.gz` are gitignored; only their `README.md`s are tracked). A
  fresh clone/`git worktree` therefore lacks them, and `Dockerfile`'s `COPY . .`
  then bakes an EMPTY tessdata into the image → OCR fails at runtime with a cryptic
  "tesseract worker error" and the receipt goes `failed`. Fetch + verify them with
  **`scripts/fetch-all.sh`** (or the per-component `scripts/fetch-tessdata.sh` /
  `scripts/fetch-better-sqlite3.sh`) before building. The acceptance step
  `test/acceptance/stack/10_container_contents.sh` (runs first in `run-all.sh`)
  asserts both blobs are baked into the worker+api containers, so this fails fast
  with a clear message instead of the opaque OCR error.
- **Blob checksums live in `scripts/SHA256SUMS.txt`.** Every fetch verifies
  against it. If a blob legitimately changes (e.g. a new tesseract build),
  recompute (`shasum -a 256 <file>`) and update that manifest in the same change;
  `scripts/verify-blobs.sh` is the CI/pre-build gate.
- **Products require a profile result.** `resolveService` reads
  `data/profileResults/<receiptId>/<profileId>.json`; it 409s if the profile
  hasn't been applied. The product HTML view renders only a STORED result (never
  resolves fresh on a GET — resolution makes live backend calls). Server-side web
  tools on Haiku need `allowed_callers: ['direct']` (see Products).
- **Keep `docs/API.md` in sync with the routes.** It's the canonical HTTP API
  reference. Whenever you add, remove, or change an endpoint in
  `src/routes/*.js` (path, method, query params, request/response shape, or
  status codes), update `docs/API.md` in the same change — both the **Endpoints**
  table and the relevant section/curl example. The web routes live alongside the
  REST routes (e.g. `src/routes/receiptProfiles.js` carries both `/api/...` and
  the HTML `/...view`/list views), so a "just a view" change still counts.
