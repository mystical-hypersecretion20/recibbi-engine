#!/usr/bin/env bash
# REST: POST /api/receipts -> 202, then poll GET /api/receipts/:id to done.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: POST /api/receipts + poll"

[ -f "$RE_TEST_SAMPLE" ] || die "sample image not found: $RE_TEST_SAMPLE"

body="$(mktemp)"
code="$(curl -sS -o "$body" -w '%{http_code}' \
        -F "receipt=@$RE_TEST_SAMPLE" -F "source=acceptance-rest" \
        "$RE_TEST_BASE/api/receipts")"
assert_http     "POST upload accepted"   "202" "$code"
id="$(jq -r '.id' "$body")"
assert_nonempty "POST upload: id"        "$id"
assert_eq       "POST upload: queued"    "queued" "$(jq -r '.status' "$body")"
rm -f "$body"
[ -n "$id" ] && [ "$id" != "null" ] || die "no id returned from upload"

# Poll to a terminal state.
waited=0; status=""
while :; do
  status="$(curl -fsS "$RE_TEST_BASE/api/receipts/$id" | jq -r '.status')"
  [ "$status" = "done" ] && break
  [ "$status" = "failed" ] && break
  [ "$waited" -ge "$RE_TEST_POLL_TIMEOUT" ] && { fail "poll: timed out after ${RE_TEST_POLL_TIMEOUT}s (status $status)"; report; exit; }
  sleep "$RE_TEST_POLL_INTERVAL"; waited=$((waited + RE_TEST_POLL_INTERVAL))
done
assert_eq "poll: reaches done" "done" "$status"

# Validate the finished record structurally.
rec="$(mktemp)"
code="$(curl -sS -o "$rec" -w '%{http_code}' "$RE_TEST_BASE/api/receipts/$id")"
assert_http     "GET record"                  "200" "$code"
assert_nonempty "record: has items array"     "$(jq -r 'if (.items|type)=="array" then "array" else "" end' "$rec")"
assert_nonempty "record: itemCount present"   "$(jq -r '.totals.itemCount' "$rec")"
if [ "$RE_TEST_OCR" = "vision" ]; then
  assert_num_gt "record: items > 0"           "$(jq -r '.items | length' "$rec")" 0
  assert_num_gt "record: sumOfItems > 0"      "$(jq -r '.totals.sumOfItems' "$rec")" 0
fi
rm -f "$rec"

printf '%s' "$id" > "$RE_STATE_ID_FILE"
report
