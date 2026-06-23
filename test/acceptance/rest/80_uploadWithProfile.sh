#!/usr/bin/env bash
# REST: Receipt Profiles (Step 2, BullMQ Flows) — upload a receipt WITH a
# profileId so the worker runs the OCR pipeline first and then applies the
# profile via a BullMQ flow (child process-receipt -> parent applyProfile).
#
# Uploads the sample with -F "profileId=usGrocery1", polls until the receipt is
# `done` AND its profile result exists, then asserts the canonicalized output
# (store -> "Costco", a rewritten water item) and pretty-prints the result.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: upload with profile (BullMQ flow: OCR -> applyProfile)"

[ -f "$RE_TEST_SAMPLE" ] || die "sample image not found: $RE_TEST_SAMPLE"
body="$(mktemp)"

# --- the seeded usGrocery1 profile must exist ------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/receiptProfiles/usGrocery1")"
assert_http     "seeded usGrocery1 present"        "200" "$code"

# --- upload WITH a profileId -----------------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' \
        -F "receipt=@$RE_TEST_SAMPLE" -F "source=acceptance" -F "profileId=usGrocery1" \
        "$RE_TEST_BASE/api/receipts")"
assert_http     "upload with profileId -> 202"     "202" "$code"
id="$(jq -r '.id' "$body")"
assert_nonempty "upload returned an id"            "$id"
assert_nonempty "response carries profileId"       "$(jq -r '.profileId' "$body")"
assert_nonempty "response carries profileResultUrl" "$(jq -r '.profileResultUrl' "$body")"

# --- poll until the receipt is done AND the profile result is persisted -----
# The flow runs OCR (child) then applyProfile (parent), so the profile result
# appears only after both complete. Poll the result endpoint as the signal.
waited=0; status=""; result_code=""
while :; do
  status="$(curl -fsS "$RE_TEST_BASE/api/receipts/$id" | jq -r .status 2>/dev/null || echo '')"
  [ "$status" = "failed" ] && die "receipt $id failed to process"
  result_code="$(curl -sS -o "$body" -w '%{http_code}' \
                 "$RE_TEST_BASE/api/receipts/$id/profileResults/usGrocery1")"
  [ "$status" = "done" ] && [ "$result_code" = "200" ] && break
  [ "$waited" -ge "$RE_TEST_POLL_TIMEOUT" ] && \
    die "timed out waiting for $id (status=$status, profileResult=$result_code)"
  sleep "$RE_TEST_POLL_INTERVAL"; waited=$((waited + RE_TEST_POLL_INTERVAL))
done
assert_eq       "receipt processed"                "done" "$status"
assert_http     "profile result persisted"         "200" "$result_code"

# --- assert the canonicalized result ---------------------------------------
# The flow mechanics (OCR child -> applyProfile parent -> persisted result) hold
# in both OCR modes; the usGrocery *content* normalization only lands when the
# store name is read cleanly, which is the vision pipeline (Tesseract usually
# can't, so usGrocery is a near no-op there — see 81_tesseractProfile.sh).
assert_eq       "result transformer is usGrocery"  "usGrocery" "$(jq -r '.transformer' "$body")"
if [ "$RE_TEST_OCR" = "vision" ]; then
  assert_eq     "store normalized to Costco"       "Costco" "$(jq -r '.store.name' "$body")"
  assert_num_gt "audit trail has changes"          "$(jq -r '.changes | length' "$body")" "0"
  assert_num_gt "water item(s) rewritten"          "$(jq -r '[.items[] | select(.description=="Water 5 Liter")] | length' "$body")" "0"
fi

# --- show the canonicalized receipt ----------------------------------------
step_banner "Canonicalized receipt (uploaded with profile 'usGrocery1')"
jq '{ id: .receiptId,
      status: ("done · profile:" + .profileName),
      extraction: { provider: ("transformer:" + .transformer) },
      store: .store, items: .items, totals: .totals,
      summary: ("Uploaded + canonicalized by \(.profileName) [\(.transformer)] via BullMQ flow: \(.changes | length) change(s)") }' "$body" \
  | render_receipt_text

rm -f "$body"
report
