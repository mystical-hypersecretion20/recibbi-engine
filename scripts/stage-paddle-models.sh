#!/usr/bin/env bash
# Stage the PaddleOCR model blobs into the sidecar build contexts so the
# Dockerfiles can bake them into the images (offline). The blobs are large and
# gitignored (services/*/models); run this once per machine before building the
# paddle/paddle-vl services.
#
# Source bundle: the local receipt-lens-models checkout (override with
# PADDLE_MODELS_ROOT). Recreate that bundle from scratch with the downloaders in
# scripts/download-paddleocr-*.py if it's missing — see scripts/README.md.
#
# Usage:
#   scripts/stage-paddle-models.sh            # stage both (v6 + vl)
#   scripts/stage-paddle-models.sh v6         # PP-OCRv6 small only (small, fast)
#   scripts/stage-paddle-models.sh vl         # PaddleOCR-VL 1.6 only (~2 GB)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
ROOT="${PADDLE_MODELS_ROOT:-$HOME/Projects/receipt-lens-models}"
WHICH="${1:-all}"

V6_SRC="$ROOT/paddleocr/3.7.0/.paddlex/official_models"
VL_SRC="$ROOT/transformers/paddleocr-vl-1.6-full-snapshot"

stage_v6() {
  local dest="$DIR/services/ocr-paddle/models/official_models"
  [ -d "$V6_SRC/PP-OCRv6_small_det" ] || { echo "ERROR: missing $V6_SRC/PP-OCRv6_small_det" >&2; exit 1; }
  [ -d "$V6_SRC/PP-OCRv6_small_rec" ] || { echo "ERROR: missing $V6_SRC/PP-OCRv6_small_rec" >&2; exit 1; }
  echo "Staging PP-OCRv6 small det+rec -> $dest"
  rm -rf "$dest"; mkdir -p "$dest"
  cp -R "$V6_SRC/PP-OCRv6_small_det" "$dest/"
  cp -R "$V6_SRC/PP-OCRv6_small_rec" "$dest/"
  du -sh "$dest"
}

stage_vl() {
  local dest="$DIR/services/ocr-paddle-vl/models/paddleocr-vl-1.6-full-snapshot"
  [ -f "$VL_SRC/PaddleOCR-VL-1.6-0.9B/model.safetensors" ] || { echo "ERROR: missing VL bundle at $VL_SRC" >&2; exit 1; }
  echo "Staging PaddleOCR-VL 1.6 full snapshot (~2 GB) -> $dest"
  rm -rf "$dest"; mkdir -p "$(dirname "$dest")"
  cp -R "$VL_SRC" "$dest"
  du -sh "$dest"
}

case "$WHICH" in
  v6)  stage_v6 ;;
  vl)  stage_vl ;;
  all) stage_v6; stage_vl ;;
  *)   echo "usage: $0 [v6|vl|all]" >&2; exit 1 ;;
esac
echo "Done."
