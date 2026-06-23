#!/usr/bin/env bash
# Optional PaddleOCR corpus run: push the WHOLE human-reviewed ground-truth
# corpus through the active OCR engine in exponential 1,2,4,8 chunks — the same
# batching the eval harness used (PADDLEOCR_VL_BATCH_SIZES). This is the slow,
# opt-in test; it self-skips unless RE_TEST_OCR is a PaddleOCR engine (paddle or
# paddle-vl), so a normal tesseract/vision run is unaffected.
#
# "Chunking" here mirrors the eval: images are uploaded in waves of size 1, then
# 2, 4, 8 (last size repeats), each wave finishing before the next starts. The
# VL sidecar keeps the model warm across the whole run, so each receipt pays only
# inference (~120s, more under emulation), not a model reload per wave.
#
# Assertions are structural (every receipt reaches `done` with the expected
# provider); OCR text quality is reported, not asserted (it varies by engine).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"

require_curl; require_jq; require_stack
step_banner "PaddleOCR chunked corpus ($RE_TEST_OCR)"

case "$RE_TEST_OCR" in
  paddle|paddle-vl) ;;
  *) info "skip: RE_TEST_OCR=$RE_TEST_OCR is not a PaddleOCR engine"; exit 0 ;;
esac

[ -d "$RE_TEST_CORPUS_DIR" ] || die "corpus dir not found: $RE_TEST_CORPUS_DIR"

# Collect corpus images (jpg/png), sorted for a stable, reproducible order.
images=()
while IFS= read -r f; do images+=("$f"); done < <(find "$RE_TEST_CORPUS_DIR" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \) | sort)
total="${#images[@]}"
[ "$total" -gt 0 ] || die "no images found under $RE_TEST_CORPUS_DIR"

# Optional cap for a quicker smoke run (RE_TEST_CORPUS_LIMIT=N).
if [ -n "${RE_TEST_CORPUS_LIMIT:-}" ] && [ "$RE_TEST_CORPUS_LIMIT" -lt "$total" ]; then
  images=("${images[@]:0:$RE_TEST_CORPUS_LIMIT}")
  total="${#images[@]}"
fi
info "corpus: $total image(s) from $RE_TEST_CORPUS_DIR"
info "chunk sizes: $RE_TEST_BATCH_SIZES   per-receipt timeout: ${RE_TEST_POLL_TIMEOUT}s"

# Wait for one receipt id to reach done|failed; echo its final status.
wait_for_done() {
  local id="$1" waited=0 s=""
  while :; do
    s="$(curl -fsS "$RE_TEST_BASE/api/receipts/$id" 2>/dev/null | jq -r '.status // "missing"')"
    case "$s" in done|failed) printf '%s' "$s"; return 0 ;; esac
    if [ "$waited" -ge "$RE_TEST_POLL_TIMEOUT" ]; then printf 'timeout'; return 0; fi
    sleep "$RE_TEST_POLL_INTERVAL"; waited=$((waited + RE_TEST_POLL_INTERVAL))
  done
}

read -r -a sizes <<< "$RE_TEST_BATCH_SIZES"
offset=0; wave=0; processed=0
run_started=$(date +%s)

while [ "$offset" -lt "$total" ]; do
  # Pick this wave's size (last configured size repeats), bounded by remaining.
  idx=$wave; [ "$idx" -ge "${#sizes[@]}" ] && idx=$(( ${#sizes[@]} - 1 ))
  size="${sizes[$idx]}"
  remaining=$(( total - offset ))
  [ "$size" -gt "$remaining" ] && size="$remaining"

  info "── chunk $((wave + 1)): $size image(s) (offset $offset) ──"
  ids=(); names=()
  for ((i = 0; i < size; i++)); do
    img="${images[$((offset + i))]}"
    name="$(basename "$img")"
    id="$(curl -fsS -F "receipt=@$img" -F "source=acceptance-corpus" "$RE_TEST_BASE/api/receipts" | jq -r '.id // empty')"
    if [ -z "$id" ]; then fail "upload $name (no id)"; continue; fi
    ids+=("$id"); names+=("$name")
    info "  uploaded $name -> $id"
  done

  # Wait for every receipt in the wave, then assert + report.
  for ((j = 0; j < ${#ids[@]}; j++)); do
    id="${ids[$j]}"; name="${names[$j]}"
    status="$(wait_for_done "$id")"
    rec="$(curl -fsS "$RE_TEST_BASE/api/receipts/$id" 2>/dev/null)"
    provider="$(printf '%s' "$rec" | jq -r '.extraction.provider // "—"')"
    items="$(printf '%s' "$rec" | jq -r '(.items | length) // 0')"
    ocrms="$(printf '%s' "$rec" | jq -r '.timings.ocrMs // 0 | floor')"
    store="$(printf '%s' "$rec" | jq -r '.store.name // "—"')"
    assert_eq "corpus $name reached done" "done" "$status"
    if [ "$status" = "done" ]; then
      assert_eq "corpus $name provider" "$RE_TEST_OCR" "$provider"
      info "    $name: items=$items store='$store' ocr=${ocrms}ms"
      processed=$((processed + 1))
    fi
  done

  offset=$((offset + size)); wave=$((wave + 1))
done

elapsed=$(( $(date +%s) - run_started ))
info "corpus complete: $processed/$total processed across $wave chunk(s) in ${elapsed}s"
report
