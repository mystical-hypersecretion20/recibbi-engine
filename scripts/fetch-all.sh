#!/usr/bin/env bash
# Fetch + verify ALL runtime blobs this repo needs but does not commit:
# Tesseract language data and the better-sqlite3 native prebuilts.
#
# This is the one command to run on a fresh clone/worktree before
# `docker build` / `podman build` (otherwise the image bakes empty tessdata
# and is missing the native sqlite binary).
#
# PaddleOCR model assets are NOT fetched here — they are large, optional, and
# require a Python env. Use scripts/download-paddleocr-*.py for those.
#
# Usage: scripts/fetch-all.sh [--auto|--local|--network]
set -euo pipefail
HERE="$(dirname "$0")"
FLAG="${1:-}"

bash "$HERE/fetch-tessdata.sh"       "$FLAG"
bash "$HERE/fetch-better-sqlite3.sh" "$FLAG"
bash "$HERE/verify-blobs.sh"
