# Stack bring-up reference

Two things live here: (1) a pointer to the project's canonical README, and (2)
the idioms for standing up a **fresh, isolated stack for a specific purpose**
(qa, feat, a bugfix repro, …) using the parameterized compose file. Read this
when you need more than the default `podman-compose -p receipt-enricher up`.

## Canonical README (read it for user-facing setup)

The authoritative user-facing guide is the live project README — **don't
duplicate it, read it**:

- **`README.md`** (repo root) — quick start, the modes table (which keys
  enable vision vs Tesseract vs Tavily), the full **Configuration reference**
  (every env var + default), Podman/security notes, REST + Telegram usage, and
  Troubleshooting. When a question is "how does an operator run/configure this?",
  the README is the source of truth; this skill is the developer-side companion.
- **`docs/API.md`** — full HTTP API + curl walkthrough.

The README's Quick start uses `--build --no-cache` deliberately, so a reused
command never serves a stale image layer. Carry that habit into the idioms below.

## Why purpose-prefixed stacks work

The compose file (`docker-compose.yml`, at the repo root) is **parameterized**
with prod-safe defaults, so the *same* file runs prod, the acceptance suite, and
any ad-hoc stack — fully isolated — just by varying host-side env vars:

| Env var              | Compose use                                  | Default               |
|----------------------|----------------------------------------------|-----------------------|
| `RECEIPT_PROJECT`    | compose `name:` → image/volume/network prefix | `receipt-enricher`    |
| `RECEIPT_API_PORT`   | published host port (`:8080` in-container)   | `8080`                |
| `OCR_PROVIDER`       | engine (`auto`\|`vision`\|`tesseract`)       | `auto`                |
| `PUBLIC_BASE_URL`    | links the API advertises (`statusUrl`/`viewUrl`) | `http://localhost:8080` |
| `RECEIPT_SUITE`      | label `io.receipt-enricher.suite`            | `prod`                |
| `DEFAULT_PROFILE_ID` | profile applied to every upload that omits one | `` (none)           |

Isolation is automatic: volumes are named `<project>_redis-data` /
`<project>_receipt-data`, so a distinct project name gives a distinct data store
and queue — no cross-talk with prod. The acceptance suite is just the canonical
example of this (`test-receipt-enricher`, port `18080`, label `test`).

## The idiom: a fresh stack for a purpose

Pick a **prefix** that names the purpose (`qa`, `feat`, `bug1234`, …) and a free
host port. Keep `-p`, `RECEIPT_PROJECT`, and `PUBLIC_BASE_URL` mutually
consistent — that's the whole trick.

```bash
export PATH="/opt/podman/bin:$PATH"
cd ~/Projects/claude-receipt-ocr

PREFIX=feat            # purpose tag — MUST start with a letter/digit (podman tag rule)
PORT=38080             # any free host port ≠ prod 8080 / acceptance 18080
PROJ=${PREFIX}-receipt-enricher

RECEIPT_PROJECT=$PROJ \
RECEIPT_API_PORT=$PORT \
RECEIPT_SUITE=$PREFIX \
PUBLIC_BASE_URL=http://localhost:$PORT \
OCR_PROVIDER=tesseract \
  podman-compose -p "$PROJ" up --build --no-cache -d

# Health + sanity (note: point the CLI at THIS stack's port, not the default 8080)
curl -fsS localhost:$PORT/health | jq '{status, ocrProvider, receiptProfiles}'
API_URL=http://localhost:$PORT ./cli/receipts health
```

Drive it through the CLI by overriding `API_URL` each call (the CLI defaults to
`http://localhost:8080`):

```bash
API_URL=http://localhost:$PORT ./cli/receipts upload \
  ../codex-receipt-ocr-human-reviewed-ground-truth/samples/costco/costco-boca-raton-2026-05-26-original.jpg \
  --wait --profile tesseractGroceryUs1
```

Tear it down — **always target the same `-p`**, and `-v` to reclaim its volumes:

```bash
podman-compose -p "$PROJ" down -v
```

A suggested (not enforced) port convention to avoid collisions:

| Purpose             | project name            | host port |
|---------------------|-------------------------|-----------|
| prod / default      | `receipt-enricher`      | `8080`    |
| acceptance suite    | `test-receipt-enricher` | `18080`   |
| qa                  | `qa-receipt-enricher`   | `28080`   |
| feature work        | `feat-receipt-enricher` | `38080`   |

Find/clean every purpose stack by its label:

```bash
podman ps -a --filter label=io.receipt-enricher.suite=feat
```

## Building images from a git worktree (extra prep)

A `git worktree` (e.g. for a feature branch under `.claude/worktrees/<name>/`) is
a **partial, fresh checkout**: a few things the build needs are *not* in git and
must be staged into the worktree before `up --build`, or the build succeeds but
the containers misbehave at runtime. `cd` into the worktree root and run the
prefixed-stack idiom from there — but first:

1. **Offline Tesseract blobs (required for OCR).** `tessdata/*.traineddata` are
   gitignored, so a fresh worktree's `tessdata/` has only `README.md`. The
   Dockerfile's `COPY . .` would then bake an EMPTY tessdata into the image and
   OCR fails at runtime with an opaque "tesseract worker error" (receipt goes
   `failed`). Fetch + verify them with the project script (copies from the
   sibling checkout or downloads, then checksums):
   ```bash
   scripts/fetch-tessdata.sh        # or scripts/fetch-all.sh for tessdata + better-sqlite3
   ```
   (The acceptance step `stack/10_container_contents.sh` asserts both are baked
   into the api+worker images, so a run-all catches a miss fast.)

2. **`.env` for the compose `env_file` (required for API keys).** Both `api` and
   `worker` declare `env_file: .env`, read from the build-context dir at compose
   time. A fresh worktree has no `.env` (it's gitignored), so the containers come
   up with **no `ANTHROPIC_API_KEY`** — vision OCR and the product resolver then
   silently degrade (Tesseract OCR; products all `skipped`). Copy it in from the
   main checkout:
   ```bash
   cp ~/Projects/claude-receipt-ocr/.env ./.env
   ```
   `.env` is also `.dockerignore`d, so it's never baked into the image — it's
   injected at run time by compose. (For a deterministic cache-hit demo also add
   `QUEUE_CONCURRENCY=1` so resolveProducts jobs run in enqueue order, ensuring a
   re-upload's identical SKUs are populated before they're looked up again.)

3. **`node_modules` — nothing to do (but know why).** A worktree has no
   `node_modules` (or a dev symlink to the main checkout's, handy for host-side
   `npm test`). It does **not** matter for the image: `node_modules/` is
   `.dockerignore`d, so the symlink is never copied into the build context, and
   the Dockerfile installs production deps fresh with `npm ci --omit=dev` inside
   the image. So don't bother "moving" it — just don't rely on it being baked.

With those staged, the normal prefixed-stack command builds cleanly from the
worktree dir (use `--no-cache` for a guaranteed-clean image):
```bash
RECEIPT_PROJECT=feat-receipt-enricher RECEIPT_API_PORT=38080 RECEIPT_SUITE=feat \
PUBLIC_BASE_URL=http://localhost:38080 OCR_PROVIDER=tesseract \
  podman-compose -p feat-receipt-enricher up --build --no-cache -d
```

## Gotchas (these bite specifically on prefixed stacks)

- **`-p` must equal `RECEIPT_PROJECT`.** `-p` wins for the project name, but
  `RECEIPT_PROJECT` still feeds the compose `name:`; a mismatch produces two
  different names and confusing orphans. Set both to `$PROJ`.
- **`PUBLIC_BASE_URL` must match the published port** or the API hands back
  `viewUrl`/`statusUrl` links pointing at the wrong port (e.g. `:8080` when you
  published `:38080`). It's kept flat (no nested `${...}`) on purpose —
  podman-compose leaks a literal `}` on nested default expansion.
- **The CLI ignores all of this** — it only knows `API_URL` (default
  `localhost:8080`). To hit a prefixed stack, prefix every `receipts …` call with
  `API_URL=http://localhost:$PORT`.
- **Prefix must start with a letter/digit.** podman tags images
  `<project>_<service>`; a name starting with `-`/`_` fails the build with
  `invalid reference format`.
- **Never point a teardown at the prod name.** `down -v` on `receipt-enricher`
  wipes prod data; keep purpose stacks on their own `$PROJ`.
- **Profiles re-seed per stack.** Each fresh stack has its own empty profile
  store, so `seedIfEmpty` re-seeds `usGrocery1` + `tesseractGroceryUs1` on first
  boot — expected, and why `receiptProfiles` should read `2` on a fresh `/health`.
