# Receipt Profiles — DESIGN

> Mirrors the existing Receipt Enricher conventions (durable JSON store,
> `createApp()` Express surface, hermetic `node:test` + bash/curl acceptance,
> Docker/Podman) so deployment and testing stay identical to what's there today.
>
> **Naming convention:** the *noun* for this concept is **`receiptProfile`**
> (camelCase, no dashes anywhere — files, dirs, URL segments). The verb
> **`canonicalize`** is fine where it names the parser's existing operation
> (e.g. `canonicalStoreName`).

## 1. What a Receipt Profile is

After a receipt is extracted (vision/Tesseract) and parsed into the standard
record shape (`{ store, items[], totals }`), the *values* are still raw: the
same chain shows up as `COSTCO`, `Costco Wholesale`, `costco`; dates come in
whatever format the receipt printed; item names are terse register strings.

A **Receipt Profile** normalizes a parsed receipt by running a **transformer** —
a small TypeScript/JavaScript module that rewrites the receipt in code. You
define many profiles and **apply a chosen profile to a receipt**. The original
parsed record is never destroyed — the result is stored separately, with a full
change/audit trail the engine derives automatically.

This sits *on top of* the parser's fixed store-name canonicalization
(`src/parse/store-aliases.json`): that's one hard-coded normalization for
internal consistency; Receipt Profiles are user-defined and cover the whole
record (store, dates, item names) with arbitrary logic.

## 2. Profiles vs. transformers (the model)

The transformation logic lives in **code**, not in JSON rules:

- **Transformer** — an on-disk module under
  `src/receiptProfiles/transformers/` that exports a `transform` **entrypoint**
  (+ optional `meta`). Shipped *with the app*; referenced by id (its filename
  without extension, e.g. `usGrocery`). **Not** user-uploaded — nothing evals
  request input, so there is no remote-code-execution surface.
- **Profile** — durable JSON *metadata* that binds a name to a transformer and
  an optional config object: `{ name, description, transformer, config }`. This
  is what the REST API CRUDs.

> An earlier draft used a declarative two-stage JSON rule language. We replaced
> it with code transformers: context-sensitive logic ("at Costco, water →
> Water 5 Liter") is just ordinary control flow, with no `when`/`set`/operator
> vocabulary or stage-ordering rules to reason about.

## 3. Implementation plan — two steps

- **Step 1 (done) — `applyProfile`, synchronous, no BullMQ.** Engine + registry
  + profile store + result store + REST API. Apply a profile to a receipt that's
  **already processed**. Synchronous because the transform is pure and fast.
- **Step 2 (done) — BullMQ Flows.** An `applyProfile` job + a `FlowProducer` so a
  fresh upload runs `processReceipt` (child) first, then `applyProfile` (parent).
  Re-applying enqueues a childless `applyProfile` job. Reuses the Step-1 engine.

## 4. Writing a transformer

Every transformer exports a `transform` entrypoint. The engine hands it a **deep
copy** of the parsed receipt; mutate it (or return a new draft). The engine
auto-derives `changes` and recomputes totals, so authors write only the logic.

```ts
// src/receiptProfiles/transformers/types.ts (excerpt)
export interface Store { name: string | null; date: string | null; }
export interface Item {
  description: string; sku: string | null;
  qty: number | null; unitPrice: number | null; price: number | null;
  enrichment: unknown;
}
export interface ReceiptDraft { store: Store; items: Item[]; totals: Record<string, number | null>; }
export interface TransformContext {
  receiptId: string;
  config: Record<string, unknown>;             // the profile's `config` object
  log: (msg: string, extra?: Record<string, unknown>) => void;
}
export type Transform = (receipt: ReceiptDraft, ctx: TransformContext) => ReceiptDraft | void;
```

The shipped example, `usGrocery.ts`:

```ts
import type { Transform, TransformerMeta } from './types';

export const meta: TransformerMeta = { name: 'usGrocery', version: 2,
  description: 'Normalize common US grocery receipts (store name + date), fold per-item discounts into the discounted item, and a context-sensitive item rewrite.' };

const STORE_ALIASES: Record<string, string[]> = {
  Costco: ['costco wholesale', 'costco'],
  Sprouts: ['sprouts farmers market', 'sprouts'],
  Walmart: ['walmart', 'wal-mart'],
  'Whole Foods': ['whole foods market', 'whole foods'],
};

export const transform: Transform = (receipt) => {
  const { store, items } = receipt;
  // 1. Canonicalize the store name (case-insensitive, longest alias first).
  if (store.name) {
    const hay = store.name.toLowerCase();
    const m = Object.entries(STORE_ALIASES)
      .flatMap(([canonical, vs]) => vs.map((v) => ({ canonical, v })))
      .sort((a, b) => b.v.length - a.v.length)
      .find(({ v }) => hay.includes(v));
    if (m) store.name = m.canonical;
  }
  // 2. Reformat the date YYYY-MM-DD -> MM-DD-YYYY.
  if (store.date) store.date = store.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2-$3-$1');
  // 3. Fold per-item discount lines into the discounted item (store-specific).
  receipt.items = foldDiscounts(store, items, ctx.log);
  // 4. Context-sensitive: at Costco, "water" -> "Water 5 Liter".
  if (store.name === 'Costco') for (const it of receipt.items) if (/water/i.test(it.description)) it.description = 'Water 5 Liter';
  return receipt;
};
```

**Discount folding** (`foldDiscounts`) is a worked example of store-specific
control flow. A receipt often lists a per-item promo as its own negative-price
line; the transformer merges it into the item it applies to (adding the negative
amount to `price` and recording it on the item's `discount` field) and drops the
line, so the net price shows on one row. The matching rule differs by chain — at
**Costco** the discount sits next to its item and references the item's SKU
(`Discount 975416`); at **Sam's Club** a single `Instant Savings` line at the
bottom names the item (`Dog Chow (Inst Sv)`), matched by description. A discount
that can't be confidently matched is left as its own line.

**Runtime TypeScript.** Transformers may be `.ts`; the registry enables them via
`require('tsx/cjs')` (the `tsx` runtime loader, a dependency). `.js` transformers
work too. The `types.ts` (type-only) module is ignored by the registry.

A second shipped transformer, **`tesseractGroceryUs.ts`**, is a derivative of
`usGrocery` tuned for the **offline Tesseract pipeline**, whose output is far
noisier than a vision model's (leading OCR junk, the SKU code embedded in the
description, ALL-CAPS text, and a usually-unreadable store name). It strips the
junk + SKU code, collapses whitespace, Title-Cases the text, expands a few common
register abbreviations (`KS` → `Kirkland Signature`, `ORG` → `Organic`, …), and
**infers `Costco`** from the Kirkland (`KS`) items so the same context-sensitive
water rewrite applies. It demonstrates that profile cleanup is the natural place
to repair provider-specific extraction noise without touching the OCR pipeline.

## 5. The engine

`applyProfile(record, transformFn, ctx)` (`src/receiptProfiles/engine.js`):

1. Deep-copies the record's `{ store, items, totals }` (source is never mutated).
2. Runs the transformer against the copy.
3. **Diffs** input → output over the known fields (`store.name/date`,
   `item.description/sku/qty/unitPrice/price/discount`) to build the `changes`
   audit trail. Items are aligned by identity (SKU, falling back to description)
   via an LCS, so a rename shows as a field change while an inserted/removed line
   — e.g. a folded-in discount — shows as a clean add/remove instead of a
   positional cascade.
4. **Recomputes totals** (`itemCount`, `sumOfItems`, `subtotalMatch`) the same
   way `parser.finalize()` does.

Returns `{ store, items, totals, changes }`.

## 6. Storage — separate stores

Profiles and results are durable JSON, same pattern as receipts; results are
kept out of the receipt record so it stays lean. All names camelCase:

```
DATA_DIR/
├─ receipts/<id>.json                  # unchanged, lean
├─ receiptProfiles/<profileId>.json    # profile metadata (name, transformer, config)
└─ profileResults/
   └─ <receiptId>/
      └─ <profileId>.json              # one result per applied profile
```

Result document:

```jsonc
{
  "receiptId": "1b70d95bbd9f462f",
  "profileId": "rp_9f3c…",
  "profileName": "usGrocery1",
  "profileVersion": 1,
  "transformer": "usGrocery",
  "appliedAt": "2026-06-04T18:20:00.000Z",
  "dryRun": false,
  "store":  { "name": "Costco", "date": "05-26-2026" },
  "items":  [ { "description": "Water 5 Liter", … }, … ],
  "totals": { /* recomputed itemCount, sumOfItems, subtotalMatch */ },
  "changes": [
    { "field": "store.name", "from": "Costco Wholesale", "to": "Costco" },
    { "field": "item.description", "itemIndex": 0, "from": "KS Water Gal", "to": "Water 5 Liter" }
  ]
}
```

Result files key on the profile **id** (stable across renames).

## 7. HTTP API — Step 1

Base URL/conventions identical to `docs/API.md`. `:profileId` accepts the
profile **id or name**. `applyProfile` is the action-verb path. Full reference
(examples, error codes) now lives in **`docs/API.md` → Receipt Profiles**.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`    | `/api/transformers`                                  | list available transformers (id + meta) |
| `GET`    | `/api/receiptProfiles`                               | list profiles |
| `POST`   | `/api/receiptProfiles`                               | create (validated) → `201` |
| `GET`    | `/api/receiptProfiles/:id`                           | get one (id or name) |
| `PUT`    | `/api/receiptProfiles/:id`                           | replace (bumps `version`) |
| `DELETE` | `/api/receiptProfiles/:id`                           | delete → `204` |
| `POST`   | `/api/receipts/:id/applyProfile/:profileId`          | apply synchronously, persist → `200` |
| `POST`   | `/api/receipts/:id/applyProfile/:profileId?dryRun=1` | apply but don't persist |
| `GET`    | `/api/receipts/:id/profileResults`                   | list results for a receipt |
| `GET`    | `/api/receipts/:id/profileResults/:profileId`        | one result |

`/health` gains `receiptProfiles: <count>`.

## 8. Validation & safety

Profile validation (`validate.js`) is shape + referential integrity: `name` is
camelCase (`^[A-Za-z][A-Za-z0-9]{0,63}$`), `transformer` must reference a
registered transformer (else `400` with the available list), `config` (optional)
must be an object. **No arbitrary code execution:** transformers are deployed
with the app, not posted to the API. (The app remains unauthenticated — run it
on a trusted network / behind a proxy, same posture as the rest of the service.)

## 9. Code layout

```
src/
├─ receiptProfiles/
│  ├─ engine.js        # applyProfile(record, transformFn, ctx) -> {store,items,totals,changes}
│  ├─ registry.js      # loads transformers via require('tsx/cjs'); get/list/has/reload
│  ├─ profileStore.js  # profile CRUD + first-boot seed, JSON under DATA_DIR/receiptProfiles/
│  ├─ resultStore.js   # results, JSON under DATA_DIR/profileResults/<receiptId>/
│  ├─ validate.js      # profile metadata validation (name/transformer/config)
│  ├─ transformers/
│  │  ├─ types.ts             # shared transformer types
│  │  ├─ usGrocery.ts         # shipped example (vision-clean receipts)
│  │  └─ tesseractGroceryUs.ts # cleans noisy Tesseract OCR output
│  └─ seedProfiles/
│     └─ usGrocery.json  # seed profile binding -> usGrocery
└─ routes/receiptProfiles.js   # CRUD + applyProfile + results + /api/transformers
```

- `config.js` → `receiptProfiles` block: `profilesDir`, `resultsDir`,
  `transformersDir` (under `src`, since transformers ship with the app).
- `app.js` mounts the router and adds `receiptProfiles` to `/health`.
- `server.js` calls `profileStore.seedIfEmpty()` at startup (seeds
  `seedProfiles/*.json` when the dir is empty).

## 10. Deployment — unchanged (one new dep)

No new container. Lives inside the existing **`api`** service; profiles/results
persist in the existing `receipt-data` volume. The only delta is the **`tsx`**
runtime dependency (installed by the existing `npm ci --omit=dev` in the
Dockerfile; works on alpine/musl). Dockerfile and `docker-compose.yml` otherwise
untouched.

## 11. Tests

**Hermetic `node:test`:**
- `profileEngine.test.js` — run a transform fn; auto-diff `changes`, totals
  recompute, source immutability, return-new-draft, numeric diffs, ctx passthrough.
- `transformerRegistry.test.js` — registry loads the shipped `usGrocery.ts` via
  the TS loader and it behaves correctly; `types` not registered.
- `profileValidate.test.js` — name/transformer/config validation.
- `profileStore.test.js` — CRUD + version bump + unknown-transformer rejection.
- `profileSeed.test.js` / `profileResultStore.test.js` — seeding + result store.
- `profileRoutes.test.js` — full HTTP surface incl. `/api/transformers`.

**Acceptance:** `test/acceptance/rest/70_applyProfile.sh` — lists transformers,
applies the seeded `usGrocery1` to the processed Costco receipt, asserts the
normalization + audit trail, and **pretty-prints the canonicalized receipt** via
`render_receipt_text`.

Validated: 139 hermetic tests + 13/13 containerized acceptance steps, in **both**
the offline-Tesseract default and `--vision` modes (Step 2 + the
`tesseractGroceryUs` cleanup profile add the extra tests and steps).

## 12. Step 2 — BullMQ Flows (implemented)

Step 2 lets an uploader **choose a profile at upload time**: the worker runs the
OCR pipeline first, then applies the profile — wired with a BullMQ **Flow** so
the dependency is enforced by Redis, not by glue code. The same `applyProfile`
job (childless) re-applies a profile to an already-processed receipt
asynchronously. The Step-1 engine and REST surface are unchanged.

**Mechanics (Flow direction: downstream = parent).**

```
enqueueProcessAndApply(receiptId, profileId)  ==>  FlowProducer.add({
  name: 'applyProfile',  data: { receiptId, profileId },          // PARENT (downstream)
  children: [
    { name: 'process-receipt', data: { receiptId },               // CHILD (upstream, runs first)
      opts: { failParentOnFailure: true } },
  ],
})
```

The parent `applyProfile` waits in `waiting-children` until `process-receipt`
finishes, so the profile always applies to the freshly-processed record. If OCR
fails, `failParentOnFailure` fails the parent too (no stranded job).

**Code changes:**

- `src/receiptProfiles/applyService.js` — **new.** `applyProfileToReceipt(receiptId,
  profileId, { dryRun })` holds the apply logic (load receipt + profile +
  transformer → engine → result doc → persist). The sync route and the worker
  both call it (no duplication). Throws `ApplyError` with a `status` (404/422).
- `src/queue.js` — adds a `FlowProducer` (its own connection) and
  `enqueueProcessAndApply()` (the flow) + `enqueueApplyProfile()` (childless job).
  FlowProducer does **not** inherit a Queue's `defaultJobOptions`, so each node
  carries explicit opts (attempts/backoff/remove…); parent and child get distinct
  jobIds.
- `src/worker.js` — a pure `dispatch(job)` switches on `job.name`:
  `process-receipt` → `processReceipt` (unchanged name, for compatibility),
  `applyProfile` → `applyService.applyProfileToReceipt`. The real `Worker` only
  starts when run directly, so `dispatch` is unit-testable without Redis.
- `src/routes/receipts.js` — upload accepts an optional multipart `profileId`
  (validated → `400` if unknown); present → `enqueueProcessAndApply`, absent →
  the original single-job path. A server-wide `DEFAULT_PROFILE_ID`
  (`config.receiptProfiles.defaultProfileId`) applies when `profileId` is omitted.
  The `202` response includes `profileId` and `profileResultUrl`.
- `src/routes/receiptProfiles.js` — the apply route gains `?async=1`, which
  enqueues `enqueueApplyProfile` and returns `202` instead of running inline
  (default stays synchronous).
- `docker-compose.yml` — passes `DEFAULT_PROFILE_ID` (empty default) to `api` and
  `worker`. No new npm dependency (`bullmq` already ships `FlowProducer`).

**Tests:** hermetic `applyService.test.js`, `workerDispatch.test.js`,
`uploadProfile.test.js`, `tesseractGroceryUs.test.js`; acceptance
`rest/80_uploadWithProfile.sh` (upload with `profileId=usGrocery1`, poll to `done`
+ result, assert canonicalization) and `rest/81_tesseractProfile.sh` (Tesseract
mode only: register + apply `tesseractGroceryUs`, assert the cleanup invariants).
The `usGrocery` content assertions in steps 70/80 are gated to `--vision`, since
under Tesseract the store name is unreadable and `usGrocery` is a near no-op —
`81_tesseractProfile.sh` covers that pipeline instead.

## 13. Decisions

- Feature name **Receipt Profiles**; camelCase, dashless everywhere.
- Transformation is **code** (on-disk transformer modules), not JSON rules.
- Execution model: **on-disk modules** (no RCE); **runtime TS loader** (`tsx`).
- Separate result store; build in **two steps** (sync apply first, Flows second).
- Apply endpoint = action verb; `:profileId` accepts **id or name**.
