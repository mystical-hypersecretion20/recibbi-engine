#!/usr/bin/env bash
# Fetch the offline Tesseract language data this repo needs at runtime:
#   tessdata/eng.traineddata   English LSTM model  (tesseract.js 5.x, 4.0.0_best_int)
#   tessdata/osd.traineddata   orientation & script detection (auto-rotate)
#
# Both are gitignored large binaries, so a fresh clone/worktree lacks them and
# Dockerfile's `COPY . .` would bake an EMPTY tessdata into the image (OCR then
# fails at runtime with a cryptic "tesseract worker error"). Run this first.
#
# Usage:
#   scripts/fetch-tessdata.sh [--auto|--local|--network]
#
# Source selection (SOURCE_MODE, default auto):
#   --local    copy from the known-good sibling checkout ($SOURCE_REPO/tessdata)
#   --network  download from the CDN / Tesseract data repo
#   --auto     local if present, else network  (default)
#
# Every byte is verified against scripts/SHA256SUMS.txt before it is accepted.
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

parse_source_flag "${1:-}" || die "unknown flag '$1' (use --auto|--local|--network)"

# Network sources (used only when copying from the local sibling isn't possible).
# NOTE: jsdelivr is frequently TLS-blocked on this network — the local/auto path
# is the reliable one. The matching asset for tesseract.js 5.x is the LSTM-only
# 4.0.0_best_int build.
ENG_URL="https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"
OSD_URL="https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/osd.traineddata"

log "fetching Tesseract data (mode=$SOURCE_MODE, source repo=$SOURCE_REPO)"

# eng.traineddata — the local copy is already uncompressed; the CDN serves .gz.
# Handle the gz case transparently so the on-disk result matches the checksum.
fetch_eng() {
  local dest="$REPO_ROOT/tessdata/eng.traineddata"
  local src="$SOURCE_REPO/tessdata/eng.traineddata"
  mkdir -p "$REPO_ROOT/tessdata"
  if { [ "$SOURCE_MODE" = local ] || [ "$SOURCE_MODE" = auto ]; } && [ -f "$src" ]; then
    log "copying from local source: $src"
    cp "$src" "$dest"
  elif [ "$SOURCE_MODE" = local ]; then
    die "SOURCE_MODE=local but blob not found: $src"
  else
    local tmp="$dest.gz"
    curl_fetch "$ENG_URL" "$tmp"
    log "decompressing eng.traineddata.gz"
    gunzip -f "$tmp"   # -> $dest
  fi
  verify_blob "tessdata/eng.traineddata"
}

fetch_eng
obtain_blob "tessdata/osd.traineddata" "$OSD_URL"

ok "Tesseract data ready in $REPO_ROOT/tessdata"
log "next: npm run test:live:tesseract   (should OCR instead of skipping)"
