---
name: paddleocr-dev
description: >-
  Developer/operator guide for the two optional PaddleOCR OCR engines in THE
  Receipt Enricher project (~/Projects/claude-receipt-ocr): the `paddle`
  (PP-OCRv6 small) and `paddle-vl` (PaddleOCR-VL 1.6 full-pipeline) sidecar
  containers, the generic REST OCR client (src/ocr/rest.js) that drives them, and
  their docker-compose wiring + chunked acceptance corpus. Use this skill
  WHENEVER working on PaddleOCR in this repo: building, running, or debugging the
  services/ocr-paddle* sidecars; selecting OCR_PROVIDER=paddle|paddle-vl; staging
  the baked-in model blobs (scripts/stage-paddle-*.sh); the REST OCR provider;
  the optional --paddle/--paddle-vl acceptance flags and the 1-2-4-8 chunked
  corpus step; or diagnosing the hard-won PaddleOCR failure modes — a sidecar
  that is `unhealthy`/`failed`/OOM-killed (exit 137), `libGL.so.1: cannot open
  shared object file`, `int(Tensor) is not supported in static graph mode`,
  `fetch failed` after ~300s, `timed out after Nms`, podman overlay `input/output
  error` blocking image builds, a base-image pull failing TLS interception (`x509:
  certificate signed by unknown authority` from registry-1.docker.io),
  podman-machine memory sizing, or PaddleOCR-VL
  being slow (~120s–14min/receipt) under amd64 emulation. Reach for this even
  when the user just says "the paddle container is crashing", "VL OCR is timing
  out", or "run the paddle acceptance tests" without naming the cause.
---

# PaddleOCR engines — developer guide

Two **optional** OCR engines run as their own containers and are reached over
HTTP by the worker via the generic REST OCR client. Tesseract stays the default;
a plain `up` never builds or starts these. This skill is the memory of how they
fit together and — more importantly — every wall hit getting PaddleOCR-VL to run
on a constrained amd64-emulated host, so you don't rediscover them.

Read [`references/troubleshooting.md`](references/troubleshooting.md) when a
sidecar is crashing/timing out — it's the symptom→cause→fix table for every
failure mode below. This SKILL.md is the architecture + how-to-run.

## Where things live

```
src/ocr/rest.js                  # generic REST OCR client (worker → sidecar)
src/ocr/index.js                 # routes any non-vision/non-tesseract provider → rest.js
src/config.js                    # config.ocr.{restTimeoutMs, rest.{paddle,paddle-vl}.url}
services/ocr-paddle/             # PP-OCRv6 small sidecar (server.py + Dockerfile + requirements)
services/ocr-paddle-vl/          # PaddleOCR-VL 1.6 sidecar (server.py + Dockerfile + requirements)
services/README.md               # sidecar overview + HTTP contract + staging
scripts/stage-paddle-models.sh   # stage baked-in model blobs into services/*/models (gitignored)
scripts/stage-paddle-certs.sh    # stage internal CA certs into services/*/certs  (gitignored)
docker-compose.yml               # ocr-paddle / ocr-paddle-vl services behind compose profiles
test/acceptance/corpus/10_chunked_corpus.sh   # the 1-2-4-8 chunked corpus step
```

**Reference implementation (the source of truth for the OCR logic):** the eval
harness at `../codex-tmp01-project-eval-harness/`. Its
`services/ocr-paddle{,-vl}/receipt_paddle*_ocr/cli.py` are the batch runners our
sidecar `server.py` files were ported from, and `src/eval/paddleOcrVlProvider.js`
is where the **1-2-4-8 exponential batching** (`PADDLEOCR_VL_BATCH_SIZES`)
originates. The model blobs live at `~/Projects/receipt-lens-models/` (VL full
snapshot ~2 GB; PP-OCRv6 small det/rec). Eval run profiles:
`20260613T-paddleocr-v6-small-no-orientation-rotation-sweep-v2` and
`20260615T-paddleocr-vl-v1.6-full-pipeline-plain-250k-1024-chunked-1-2-4-8`.

## Architecture (why it's shaped this way)

- **Sidecars, not in-process.** PaddleOCR + paddlepaddle + the model blobs are
  heavy (the VL image is ~3.9 GB). Baking them into the lean Node image would
  bloat every api/worker container. Instead each engine is its own container
  exposing `GET /health` and `POST /ocr`; the worker POSTs the image and gets
  transcribed text back, which the heuristic parser turns into line items —
  exactly like the Tesseract path. So `paddle`/`paddle-vl` behave like Tesseract
  downstream (plain text → parser), NOT like the vision path (structured JSON).
- **Models are baked into the sidecar images** (offline at runtime) — only the
  *build* needs the staged blobs. This was a deliberate choice over a runtime
  bind-mount so the containers need no host paths or network at run time.
- **Generic REST client.** `src/ocr/index.js` sends anything that isn't
  `vision`/`tesseract` to `src/ocr/rest.js`, which resolves the backend URL from
  `config.ocr.rest[provider].url`. Adding a third HTTP OCR engine = register a
  URL + pick a new `OCR_PROVIDER` value; no new dispatch code.
- **`rest.js` uses the built-in `http`/`https` client, NOT global `fetch`.** This
  is load-bearing — see the undici gotcha below. Don't "modernize" it back to
  fetch.
- **Warm model.** `server.py` loads the model once at boot (a background thread
  when `OCR_PRELOAD=1`) and serializes `predict()` behind a lock. `/health`
  reports `ready:false` until the model is loaded; callers must wait for
  `ready:true` (cold VL load is ~60–95 s) or the first request blocks/fails.

## Running the sidecars

```bash
export PATH="/opt/podman/bin:$PATH"
cd ~/Projects/claude-receipt-ocr

# 1) Stage the gitignored build inputs (models + internal CA certs) ONCE per machine:
scripts/stage-paddle-models.sh
scripts/stage-paddle-certs.sh

# 2) Bring up the stack WITH the sidecar profile AND point the app at it.
#    PP-OCRv6 small (fast):
OCR_PROVIDER=paddle    podman-compose -p receipt-enricher --profile paddle    up --build -d
#    PaddleOCR-VL 1.6 (heavy, slow):
OCR_PROVIDER=paddle-vl podman-compose -p receipt-enricher --profile paddle-vl up --build -d

curl -fsS localhost:8080/health | jq '{ocrProvider}'   # confirm the engine took
```

The compose services are named `ocr-paddle` / `ocr-paddle-vl`; the worker reaches
them at `http://ocr-paddle:8090` / `http://ocr-paddle-vl:8090` (defaults in
`config.js` and the api/worker env). Override with `OCR_PADDLE_URL` /
`OCR_PADDLE_VL_URL`. See the repo README's **PaddleOCR sidecars** section for the
operator-facing version.

## Acceptance: the chunked corpus

PaddleOCR is **off by default** in the acceptance suite. `--paddle` / `--paddle-vl`
(or `RE_TEST_OCR=paddle*`) activate the matching compose profile, wait for the
sidecar's model to warm, and run `corpus/10_chunked_corpus.sh`: the whole
ground-truth corpus pushed through in exponential **1, 2, 4, 8** waves
(`RE_TEST_BATCH_SIZES`), mirroring the eval harness. Assertions are structural
(every receipt reaches `done` with `provider==<engine>`); OCR text quality is
reported, not asserted.

```bash
bash test/acceptance/run-all.sh --paddle        # full suite incl. chunked corpus
bash test/acceptance/run-all.sh --paddle-vl     # VL — slow; see timing below
```

**Why chunk at all if the sidecar serializes inference?** The chunking is faithful
to the eval (where it amortized model-load across a batch). In our warm-sidecar
model the peak memory is one inference regardless of chunk size, so **chunk size
is NOT a memory or stability lever** — don't reach for "limit the chunk size" to
fix OOM/timeouts; the real levers are VM RAM, the per-inference params, and the
client timeout (below).

## PaddleOCR-VL under amd64 emulation — the reality

The sidecars pin `linux/amd64` (paddlepaddle ships reliable CPU wheels only for
x86_64), so on Apple Silicon they run **emulated**: slower and RAM-hungry. Hard
numbers measured on a 16 GiB M1 Pro, podman applehv VM:

| Thing | Observed |
|---|---|
| VL model load (cold) | ~60–95 s |
| VL simple receipt (Sam's Club, ~4 items) | ~175–230 s |
| VL complex receipt (Costco) | **~330–850 s (~5.5–14 min)** |
| VL full 15-receipt corpus (1-2-4-8) | ~122 min, completed 15/15 |
| PP-OCRv6 small per receipt | ~8–120 s |
| PP-OCRv6 full corpus | ~520 s |

### From-scratch rebuild — build times & image sizes

Measured rebuilding both images from an **empty** image cache (base layers
re-pulled), VM at 8 GiB. Builds are fine at 8 GiB — only VL *inference* needs
≥12 GiB.

| Image | Tag | Size | Build time (cold) |
|---|---|---|---|
| `localhost/ocr-paddle` (PP-OCRv6 small) | `dev` | 1.55 GB | ~4.5 min |
| `localhost/ocr-paddle-vl` (VL 1.6 full pipeline) | `dev` | 4.08 GB | ~8 min |

### Single-receipt smoke test (standalone probe, `samsclub-…-total-22-53.jpg`)

The quickest end-to-end validation after a rebuild — one simple Sam's Club
receipt (4 items, total $22.53) via the standalone-probe recipe below.

**Test fixture (pin this exact file so results are comparable run-to-run):**
- File: `samples/samsclub/samsclub-daytona-beach-2026-01-06-total-22-53.jpg`
- Source repo: `../codex-receipt-ocr-human-reviewed-ground-truth` (also mirrored
  in the eval harness at `…/human-reviewed-ground-truth/samples/samsclub/`)
- **sha256:** `f02ca67685838250bdd1d3b90c4280b892a3a15dd379583a86ed7b24dd19c426`
- Verify before testing: `shasum -a 256 path/to/receipt.jpg` (or
  `shasum -a 256 -c SHA256SUMS` from the ground-truth repo, which checksums all
  20 sample files). The numbers below are only meaningful against this exact file.

| Engine | VM RAM | Model load | Inference | Result |
|---|---|---|---|---|
| `paddle` (v6) | 8 GiB | <5 s | **~9 s** | all 4 items, TOTAL 22.53 ✓ |
| `paddle-vl` | 12 GiB | ~35 s | **~187 s (~3.1 min)** | cleaner layout, `# ITEMS SOLD 4`, TOTAL 22.53 ✓, OOM=false Restart=0 |

VL output is better-structured than v6 (SKU + name + price on one line per item)
but ~20× slower. Both are clean HTTP 200s.

Tuning knobs (compose env on `ocr-paddle-vl`; defaults match the eval profile):
`PADDLEOCR_VL_MAX_NEW_TOKENS` (1024), `PADDLEOCR_VL_MAX_PIXELS` (250000),
`PADDLEOCR_VL_MIN_PIXELS` (3136). Lowering them cuts memory and *some* time, but
**layout-detection + multi-region VLM passes dominate** the wall time on complex
receipts, so reductions help less than you'd hope (Costco was ~640 s even at
128 tok / 70k px). Prioritize completion over fidelity when you just need all
receipts through: 128/70k + a generous timeout gets every receipt to `done`.

## The five walls (each is a one-line fix you will forget)

These bit in sequence getting the VL corpus green. Full detail +
symptom/log-signature in [`references/troubleshooting.md`](references/troubleshooting.md).

1. **`libGL.so.1: cannot open shared object file`** (VL sidecar crashes on
   import). `paddlex[ocr]` drags in GUI OpenCV. Fix: `libgl1` in the VL
   Dockerfile's apt install. (PP-OCRv6 avoids it — no `paddlex[ocr]`.)
2. **OOM-killed on model load / inference** (exit 137, `OOMKilled=true`). The VL
   bundle needs **≥12 GiB**; 8 GiB OOMs on load. On a 16 GiB host bump the podman
   VM (`podman machine stop && podman machine set --memory 12288 && podman
   machine start`). **14 GiB leaves macOS ~2 GiB and destabilized podman during
   builds** — 12 GiB is the safer ceiling. Revert when done.
3. **`int(Tensor) is not supported in static graph mode`** (500 from the VL
   sidecar). paddle runs the VLM in a worker thread; the static-engine layout
   model flips the process graph mode and the thread inherits it. Fix: the
   dynamic-mode guard already in `services/ocr-paddle-vl/server.py` (`if not
   paddle.in_dynamic_mode(): paddle.disable_static()` before predict). Keep it.
4. **`fetch failed` after ~300 s, sidecar healthy** (worker side). Node's `fetch`
   (undici) has a hidden **300 s `headersTimeout`** that fires before any
   AbortController — fatal for VL calls that legitimately run minutes. Fix:
   `src/ocr/rest.js` uses `http.request` (no hidden ceiling), bounded only by
   `OCR_REST_TIMEOUT_MS`. Don't revert to fetch; its hermetic test stubs
   `http.request`, not fetch.
5. **`timed out after Nms`** (worker gives up while the sidecar is still
   generating; sidecar logs `BrokenPipeError`). The default
   `OCR_REST_TIMEOUT_MS=600000` (10 min) is too low for complex VL receipts —
   raise it (e.g. `1200000`) and set the acceptance `RE_TEST_POLL_TIMEOUT` to
   match.

## Podman storage / build pitfalls (environment, not code)

- **`x509: certificate signed by unknown authority` pulling the base image**
  (`Trying to pull docker.io/library/python:3.x-slim... Error: ... pinging
  container registry registry-1.docker.io`). The TLS-intercepting proxy intercepts the
  **registry** pull, and that trust path is **separate from pip's** — staging the
  CA certs into `services/*/certs/` only fixes pip *inside* the build, not the
  base-image pull *before* it. This surfaces whenever the image cache is empty
  (fresh machine, after `podman machine reset`, or aggressive prune). Fix: install
  the same internal CA bundle into the **podman VM's** trust store, then rebuild:
  ```bash
  cat services/ocr-paddle/certs/*.crt | podman machine ssh \
    'sudo tee /etc/pki/ca-trust/source/anchors/internal-ca-bundle.crt >/dev/null && sudo update-ca-trust'
  ```
  It persists across `podman machine stop/start` (lives on the VM disk), but a
  `podman machine reset` wipes it — re-run after a reset.
- **`input/output error` on overlay mount / `Post "http://d/.../build": EOF`**
  during `up --build`. The VM's container storage got corrupted (repeated OOM
  kills + memory changes). `podman system prune -f` reclaims dangling layers; a
  `podman machine stop/start` clears stuck mounts. If builds still fail, the
  nuclear option is `podman machine reset` (wipes ALL images — then the ~2 GB VL
  image rebuilds from scratch, slow).
- **Deliver a Node-side fix without rebuilding** (when builds are blocked but the
  images already exist): bind-mount the fixed source over `/app/src` via a
  throwaway `docker-compose.override.yml`, then `up` (NO `--build`). node_modules,
  tessdata, and better-sqlite3 stay baked; only app code is overlaid. Remove the
  override afterward — it must not be committed.
- **A fresh worktree lacks `.env`** (gitignored, not copied into worktrees), and
  `podman-compose` hard-errors `Env file ... does not exist` because compose
  declares `env_file: .env`. Create an empty `.env` (no keys needed when
  `OCR_PROVIDER` is pinned).

## Guardrails

- Keep the two engines behind compose profiles and off the default `up`; keep
  Tesseract the default. Model blobs and certs stay gitignored (only the
  Dockerfile/server.py/requirements are committed).
- `src/ocr/rest.js` must stay on `http`/`https` (not fetch) and its hermetic test
  (`test/ocr-rest.test.js`) must stay offline by stubbing `http.request`.
- The VL `server.py` dynamic-mode guard and the `libgl1` apt line are load-bearing
  — removing either re-breaks VL inference.
- When you change the podman VM memory for a heavy run, **revert it afterward**
  (the host needs its RAM back).
