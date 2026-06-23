#!/usr/bin/env bash
# REST: Receipt Profiles on the *Tesseract* pipeline — register the
# `tesseractGroceryUs` profile and apply it to the offline-OCR'd receipt to
# clean up Tesseract's noisy output (junk prefixes + embedded SKU codes,
# ALL-CAPS text) and recover the store name. Unlike usGrocery, it deliberately
# PRESERVES the receipt's own abbreviations (e.g. "KS WATER GAL") rather than
# expanding them.
#
# Tesseract-only: this step asserts cleanup that's meaningful on the messy
# Tesseract output, so it SKIPS for every other engine. A vision model already
# returns clean items, and the PaddleOCR engines emit a different text shape
# (often parsing to 0 heuristic items for this sample) — the ALL-CAPS/Costco
# cleanup assertions below only hold for Tesseract. The clean-item path is
# covered engine-agnostically by 70_applyProfile.sh / 80_uploadWithProfile.sh.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack

if [ "$RE_TEST_OCR" != "tesseract" ]; then
  step_banner "REST: tesseract profile (SKIPPED — engine is $RE_TEST_OCR, not tesseract)"
  info "tesseractGroceryUs targets noisy Tesseract output; only meaningful under --ocr tesseract."
  report
  exit 0
fi

step_banner "REST: tesseract cleanup profile (tesseractGroceryUs)"

id="$(ensure_receipt)"
body="$(mktemp)"

# --- the tesseractGroceryUs transformer ships with the app ------------------
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/transformers")"
assert_http     "GET /api/transformers -> 200"        "200" "$code"
assert_num_gt   "tesseractGroceryUs transformer present" \
                "$(jq -r '[.[] | select(.id=="tesseractGroceryUs")] | length' "$body")" "0"

# --- register a profile bound to it ----------------------------------------
pname="tesseractGroceryUs$$"
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST -H 'content-type: application/json' \
        -d "$(jq -n --arg name "$pname" '{name:$name, description:"clean tesseract output", transformer:"tesseractGroceryUs"}')" \
        "$RE_TEST_BASE/api/receiptProfiles")"
assert_http     "register profile -> 201"             "201" "$code"
assert_eq       "profile binds transformer"           "tesseractGroceryUs" "$(jq -r '.transformer' "$body")"

# --- capture the raw (pre-profile) descriptions for comparison --------------
raw_caps="$(curl -fsS "$RE_TEST_BASE/api/receipts/$id" \
            | jq -r '[.items[]? | select(.description | test("[A-Z]{2,}"))] | length')"

# --- apply it (persisting) -------------------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST \
        "$RE_TEST_BASE/api/receipts/$id/applyProfile/$pname")"
assert_http     "apply profile -> 200"                "200" "$code"
assert_num_gt   "audit trail has changes"             "$(jq -r '.changes | length' "$body")" "0"
assert_num_gt   "had ALL-CAPS items before cleanup"   "$raw_caps" "0"

# --- cleanup invariants -----------------------------------------------------
# These hold for every cleaned description regardless of the exact (and somewhat
# nondeterministic) Tesseract text: non-empty, no leading/trailing or double
# spaces, and the parsed SKU code no longer appears in the name.
assert_eq "no empty descriptions" "0" \
  "$(jq -r '[.items[] | select((.description // "") == "")] | length' "$body")"
assert_eq "no leading/trailing whitespace" "0" \
  "$(jq -r '[.items[] | select(.description | test("^\\s|\\s$"))] | length' "$body")"
assert_eq "no double spaces" "0" \
  "$(jq -r '[.items[] | select(.description | test("  "))] | length' "$body")"
# SKU code stripped: bind .sku before piping into the string (a bare
# `.description | contains(.sku)` would index the string and error).
assert_eq "SKU code stripped from description" "0" \
  "$(jq -r '[.items[] | select(.sku != null) | select(.sku as $s | .description | contains($s))] | length' "$body")"
# Title-Casing should strip the ALL-CAPS register text: assert the cleanup
# strictly REDUCED the ALL-CAPS-run items (robust to Tesseract emitting an odd
# token on any given run; raw_caps was asserted > 0 above).
caps_after="$(jq -r '[.items[] | select(.description | test("[A-Z]{2,}"))] | length' "$body")"
assert_num_gt "cleanup reduced ALL-CAPS items"        "$raw_caps" "$caps_after"

# --- store recovered; abbreviations preserved (NOT expanded like usGrocery) -
assert_eq       "store inferred as Costco"            "Costco" "$(jq -r '.store.name' "$body")"
# tesseractGroceryUs intentionally KEEPS the receipt's own abbreviations
# ("KS WATER GAL", "KS SPARK WAT") rather than expanding them. The
# "water -> Water 5 Liter" rewrite belongs to the usGrocery transformer
# (src/receiptProfiles/transformers/usGrocery.ts), exercised by 70/80_*.sh.
# Assert the Tesseract profile did NOT apply it, so the two transformers don't
# silently converge.
assert_eq       "water NOT expanded to usGrocery form" "0" \
  "$(jq -r '[.items[] | select(.description=="Water 5 Liter")] | length' "$body")"

# --- read the persisted result back ----------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' \
        "$RE_TEST_BASE/api/receipts/$id/profileResults/$pname")"
assert_http     "GET persisted result -> 200"         "200" "$code"

# --- show the cleaned-up receipt -------------------------------------------
step_banner "Cleaned-up receipt (after profile '$pname' on Tesseract output)"
jq '{ id: .receiptId,
      status: ("done · profile:" + .profileName),
      extraction: { provider: ("transformer:" + .transformer) },
      store: .store, items: .items, totals: .totals,
      summary: ("Tesseract output cleaned by \(.profileName) [\(.transformer)]: \(.changes | length) change(s)") }' "$body" \
  | render_receipt_text

# --- cleanup the profile we created ----------------------------------------
curl -fsS -X DELETE "$RE_TEST_BASE/api/receiptProfiles/$pname" >/dev/null 2>&1 || true
rm -f "$body"

report
