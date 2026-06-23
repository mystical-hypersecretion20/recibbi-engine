#!/usr/bin/env bash
# CLI driver: `receipts upload <img> --wait` uploads and processes a receipt to
# completion. Validates structural invariants of the resulting record.
#
# The CLI prints the 202 JSON then the final record JSON to stdout; we slurp both
# with `jq -s` (the first object is the upload ack, the last is the final record).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "CLI: upload + wait"

[ -f "$RE_TEST_SAMPLE" ] || die "sample image not found: $RE_TEST_SAMPLE"
info "uploading $RE_TEST_SAMPLE (ocr=$RE_TEST_OCR)"

out="$(API_URL="$RE_TEST_BASE" \
       POLL_TIMEOUT="$RE_TEST_POLL_TIMEOUT" \
       POLL_SECONDS="$RE_TEST_POLL_INTERVAL" \
       "$(cli)" upload "$RE_TEST_SAMPLE" --wait 2>/dev/null)" \
  || die "cli upload --wait failed (process did not reach done?)"

id="$(printf '%s' "$out"     | jq -rs '.[0].id')"
status="$(printf '%s' "$out" | jq -rs '.[-1].status')"
items="$(printf '%s' "$out"  | jq -rs '.[-1].items | length')"
sum="$(printf '%s' "$out"    | jq -rs '.[-1].totals.sumOfItems')"
store="$(printf '%s' "$out"  | jq -rs '.[-1].store.name')"

assert_nonempty "cli upload: returned id"        "$id"
assert_eq       "cli upload: reaches done"       "done" "$status"

# Quality-dependent: vision returns clean items; tesseract is best-effort, so we
# only require >0 items when using the vision path.
if [ "$RE_TEST_OCR" = "vision" ]; then
  assert_num_gt "cli upload: items extracted"    "$items" 0
  assert_num_gt "cli upload: sumOfItems > 0"     "$sum" 0
  assert_nonempty "cli upload: store detected"   "$store"
else
  info "ocr=tesseract: items=$items sum=$sum store='$store' (not asserting extraction quality)"
fi

# Hand the id to downstream steps.
[ -n "$id" ] && [ "$id" != "null" ] && printf '%s' "$id" > "$RE_STATE_ID_FILE"

report
