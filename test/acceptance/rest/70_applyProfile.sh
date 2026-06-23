#!/usr/bin/env bash
# REST: Receipt Profiles (Step 1, code-transformer model) — list transformers,
# apply the shipped `usGrocery` profile to an already-processed receipt, verify
# the canonicalized result + audit trail, then pretty-print the receipt.
#
# Uses the seeded `usGrocery1` profile (bound to the on-disk `usGrocery`
# transformer). On the default Costco sample the transformer deterministically
# normalizes the store to "Costco" and rewrites water items to "Water 5 Liter".
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: receipt profiles (applyProfile)"

id="$(ensure_receipt)"
body="$(mktemp)"

# --- transformers are discoverable -----------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/transformers")"
assert_http     "GET /api/transformers -> 200"   "200" "$code"
assert_num_gt   "usGrocery transformer present"   "$(jq -r '[.[] | select(.id=="usGrocery")] | length' "$body")" "0"

# --- the seeded usGrocery1 profile exists ----------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/receiptProfiles/usGrocery1")"
assert_http     "seeded usGrocery1 present"       "200" "$code"
assert_eq       "usGrocery1 binds transformer"    "usGrocery" "$(jq -r '.transformer' "$body")"

# --- apply it (persisting) -------------------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST \
        "$RE_TEST_BASE/api/receipts/$id/applyProfile/usGrocery1")"
assert_http     "apply profile -> 200"            "200" "$code"
# The usGrocery normalization (store -> Costco, water rewrite) relies on a clean
# store name, which only the vision pipeline reliably yields. Under Tesseract the
# store is usually unreadable, so usGrocery is a near no-op — the dedicated
# tesseractGroceryUs profile (81_tesseractProfile.sh) covers that path instead.
if [ "$RE_TEST_OCR" = "vision" ]; then
  assert_eq     "store normalized to Costco"      "Costco" "$(jq -r '.store.name' "$body")"
  assert_num_gt "audit trail has changes"         "$(jq -r '.changes | length' "$body")" "0"
  assert_num_gt "water item(s) rewritten"         "$(jq -r '[.items[] | select(.description=="Water 5 Liter")] | length' "$body")" "0"
fi

# --- read the persisted result back ----------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' \
        "$RE_TEST_BASE/api/receipts/$id/profileResults/usGrocery1")"
assert_http     "GET persisted result -> 200"     "200" "$code"
if [ "$RE_TEST_OCR" = "vision" ]; then
  assert_eq     "persisted store name"            "Costco" "$(jq -r '.store.name' "$body")"
fi

# --- dry run does not persist ----------------------------------------------
dryname="acceptDry$$"
curl -fsS -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg name "$dryname" '{name:$name, transformer:"usGrocery"}')" \
  "$RE_TEST_BASE/api/receiptProfiles" >/dev/null
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST \
        "$RE_TEST_BASE/api/receipts/$id/applyProfile/$dryname?dryRun=1")"
assert_http     "dryRun apply -> 200"             "200" "$code"
assert_eq       "dryRun flagged"                  "true" "$(jq -r '.dryRun' "$body")"
code="$(curl -sS -o /dev/null -w '%{http_code}' \
        "$RE_TEST_BASE/api/receipts/$id/profileResults/$dryname")"
assert_http     "dryRun left nothing persisted"   "404" "$code"

# --- error paths -----------------------------------------------------------
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
        "$RE_TEST_BASE/api/receipts/$id/applyProfile/noSuchProfile")"
assert_http     "unknown profile -> 404"          "404" "$code"
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
        -H 'content-type: application/json' -d '{"name":"badX","transformer":"noSuch"}' \
        "$RE_TEST_BASE/api/receiptProfiles")"
assert_http     "unknown transformer -> 400"      "400" "$code"

# --- show the canonicalized receipt ----------------------------------------
# Re-fetch the persisted usGrocery1 result and pretty-print it the same way
# 40_view.sh renders a receipt, so a human sees the receipt AFTER profiling.
curl -fsS "$RE_TEST_BASE/api/receipts/$id/profileResults/usGrocery1" > "$body"
step_banner "Canonicalized receipt (after profile 'usGrocery1')"
jq '{ id: .receiptId,
      status: ("done · profile:" + .profileName),
      extraction: { provider: ("transformer:" + .transformer) },
      store: .store, items: .items, totals: .totals,
      summary: ("Canonicalized by \(.profileName) [\(.transformer)]: \(.changes | length) change(s)") }' "$body" \
  | render_receipt_text
info "changes applied by 'usGrocery1':"
jq -r '.changes[] | "    \(.field)\(if .itemIndex != null then "[\(.itemIndex)]" else "" end): \(.from) → \(.to)"' "$body" >&2

# --- cleanup the throwaway profile we created ------------------------------
curl -fsS -X DELETE "$RE_TEST_BASE/api/receiptProfiles/$dryname" >/dev/null 2>&1 || true
rm -f "$body"

report
