# scripts/ — fetch & verify 3rd-party blobs

This repo deliberately does **not** commit the large binary assets its OCR /
persistence stack depends on (they're gitignored). A fresh clone or `git
worktree` therefore lacks them, and `docker build` / `podman build` would bake
an empty `tessdata/` and a missing native module into the image. These scripts
fetch each component's blobs and **verify every download against a recorded
SHA-256** so a corrupt, blocked, or tampered file fails loudly instead of
silently shipping.

One script per 3rd-party component, each covering that component's specific flow.

| Script | Component | Fetches |
|--------|-----------|---------|
| [`fetch-tessdata.sh`](fetch-tessdata.sh) | Tesseract (tesseract.js) | `tessdata/eng.traineddata`, `tessdata/osd.traineddata` |
| [`fetch-better-sqlite3.sh`](fetch-better-sqlite3.sh) | better-sqlite3 (persistence) | `.vendor/better-sqlite3-*.tar.gz` (3 arches) |
| [`download-paddleocr-v6-small-assets.py`](download-paddleocr-v6-small-assets.py) | PaddleOCR PP-OCRv6 small | det + rec model cache (optional tarball) |
| [`download-paddleocr-vl-1.6.py`](download-paddleocr-vl-1.6.py) | PaddleOCR-VL 1.6 | full VLM + aux model bundle tarball |
| [`fetch-all.sh`](fetch-all.sh) | — | runs the two runtime fetchers + verify |
| [`verify-blobs.sh`](verify-blobs.sh) | — | checks all present blobs vs `SHA256SUMS.txt` |

## Quick start (fresh clone, before building)

```bash
scripts/fetch-all.sh            # fetch tessdata + better-sqlite3, then verify
```

## Source selection (the TLS-interception reality)

This network's TLS proxy blocks some hosts even for `curl` (jsdelivr, Tavily),
so the **most reliable source is the known-good sibling checkout**
`../claude-ocr-receipt/receipt-enricher`. The bash fetchers default to
`--auto`: copy from that checkout if present, else download over the network
(with an insecure-TLS `curl -k` retry as the documented workaround). Either
way, the bytes are checksum-verified before they win.

```bash
scripts/fetch-tessdata.sh --local      # only the sibling checkout (no network)
scripts/fetch-tessdata.sh --network    # only the CDN / GitHub
scripts/fetch-tessdata.sh --auto       # local-then-network (default)

# point at a different known-good copy:
SOURCE_REPO=/path/to/receipt-enricher scripts/fetch-better-sqlite3.sh --local
```

## Integrity

[`SHA256SUMS.txt`](SHA256SUMS.txt) holds the canonical hashes for the tessdata
and better-sqlite3 blobs (captured from the working sibling checkout). Verify
anytime:

```bash
scripts/verify-blobs.sh
# or, equivalently:
(cd "$(git rev-parse --show-toplevel)" && shasum -a 256 -c scripts/SHA256SUMS.txt)
```

The PaddleOCR Python downloaders write their **own** `SHA256SUMS.txt` next to
the tarball they produce (model snapshots aren't committed here), and the VL
script re-verifies with `--verify`:

# Use the canonical snapshot names (these match the .gitignore patterns, so the
# large outputs are never accidentally committed):
```bash
python3 scripts/download-paddleocr-vl-1.6.py \
    --out-dir paddleocr-vl-1.6-full-snapshot \
    --tarball paddleocr-vl-1.6-full-snapshot.tar.gz
python3 scripts/download-paddleocr-vl-1.6.py \
    --tarball paddleocr-vl-1.6-full-snapshot.tar.gz --verify
python3 scripts/download-paddleocr-v6-small-assets.py \
    --tarball paddleocr-v6-small-rotation-sweep-assets.tar.gz
```

> If you pass a non-canonical `--tarball NAME.tar.gz`, add `NAME.tar.gz` to
> `.gitignore` first — only the canonical `paddleocr-*` names are pre-ignored.

> The PaddleOCR scripts are replicated from
> `../codex-receipt-ocr-paddleocr-downloads` (they need PaddleOCR/PaddlePaddle +
> a Python env) and are **optional** — this app's runtime path is Tesseract /
> vision, not PaddleOCR. They're kept here so the model assets used by the
> codex eval runs can be recreated reproducibly with integrity checks.

## Updating a checksum (intentional blob change)

If a blob legitimately changes (e.g. a new tesseract model build), recompute and
update the recorded hash:

```bash
shasum -a 256 tessdata/eng.traineddata     # paste the new hash into scripts/SHA256SUMS.txt
```
