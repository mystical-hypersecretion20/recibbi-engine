#!/usr/bin/env bash
# REST: Products (final stage) — list resolvers, apply a seeded profile to the
# shared receipt, then resolve products from that profile result. Verifies the
# resolver listing, the dryRun/async variants, the 404/409 error paths, the
# persisted read-back, and the cross-receipt listing.
#
# Assertions are structural by design: whether items actually map to a product
# depends on ANTHROPIC_API_KEY being present in the stack AND the model accepting
# the server-side web tools. We always assert shape (products length == item
# count, stats present, persistence) and PRINT the resolved/skipped/errors tally
# for a human; under the vision OCR path (which implies a key) we additionally
# assert at least one item resolved.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: products (resolveProducts)"

id="$(ensure_receipt)"
body="$(mktemp)"

# Pair the profile to the OCR path (usGrocery for clean vision text, the
# Tesseract-tuned profile otherwise). Both ship seeded.
if [ "$RE_TEST_OCR" = "vision" ]; then PROFILE="usGrocery1"; else PROFILE="tesseractGroceryUs1"; fi

# --- resolvers are discoverable; anthropic is active -----------------------
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/productResolvers")"
assert_http   "GET /api/productResolvers -> 200"  "200" "$code"
assert_eq     "active resolver is anthropic"      "anthropic" "$(jq -r '.active' "$body")"
assert_num_gt "anthropic resolver listed"         "$(jq -r '[.resolvers[]|select(.id=="anthropic")]|length' "$body")" "0"

# --- ensure the profile result exists (resolution requires it) -------------
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/receipts/$id/applyProfile/$PROFILE")"
assert_http   "apply $PROFILE -> 200"             "200" "$code"
items="$(curl -fsS "$RE_TEST_BASE/api/receipts/$id/profileResults/$PROFILE" | jq -r '.items|length')"

# --- 409 when a profile has NOT been applied -------------------------------
dryname="prodDry$$"
curl -fsS -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg n "$dryname" '{name:$n, transformer:"usGrocery"}')" "$RE_TEST_BASE/api/receiptProfiles" >/dev/null
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$RE_TEST_BASE/api/receipts/$id/profileResults/$dryname/resolveProducts")"
assert_http   "resolve before apply -> 409"       "409" "$code"
curl -fsS -X DELETE "$RE_TEST_BASE/api/receiptProfiles/$dryname" >/dev/null 2>&1 || true

# --- dryRun resolves but does not persist ----------------------------------
# (Run before the persisting call so the read-back is genuinely a 404.)
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/receipts/$id/profileResults/$PROFILE/resolveProducts?dryRun=1")"
assert_http   "dryRun resolve -> 200"             "200" "$code"
assert_eq     "dryRun flagged"                    "true" "$(jq -r '.dryRun' "$body")"
code="$(curl -sS -o /dev/null -w '%{http_code}' "$RE_TEST_BASE/api/receipts/$id/products/$PROFILE")"
assert_http   "dryRun left nothing persisted"     "404" "$code"

# --- resolve (persisting) --------------------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/receipts/$id/profileResults/$PROFILE/resolveProducts")"
assert_http   "resolve products -> 200"           "200" "$code"
assert_eq     "one product per line item"         "$items" "$(jq -r '.products|length' "$body")"
assert_eq     "resolver recorded"                 "anthropic" "$(jq -r '.resolver' "$body")"
assert_nonempty "stats present"                   "$(jq -r '.stats.resolved' "$body")"
if [ "$RE_TEST_OCR" = "vision" ]; then
  assert_num_gt "at least one product resolved"   "$(jq -r '.stats.resolved' "$body")" "0"
fi
info "resolve tally: $(jq -rc '.stats' "$body")"

# --- persisted read-back ----------------------------------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/receipts/$id/products/$PROFILE")"
assert_http   "GET persisted products -> 200"     "200" "$code"
assert_eq     "persisted product count"           "$items" "$(jq -r '.products|length' "$body")"
# Every product carries the emoji field (structural; value may be null when the
# feature is off or no emoji fit). Under the vision path (key present) at least
# one resolved product should map to a real emoji.
assert_eq     "every product has an emoji field"  "$items" "$(jq -r '[.products[]|select(has("emoji"))]|length' "$body")"
if [ "$RE_TEST_OCR" = "vision" ]; then
  assert_num_gt "at least one product mapped to an emoji" "$(jq -r '[.products[]|select(.emoji!=null)]|length' "$body")" "0"
fi

# --- per-receipt + cross-receipt listings ----------------------------------
assert_num_gt "per-receipt product results"       "$(curl -fsS "$RE_TEST_BASE/api/receipts/$id/products" | jq -r 'length')" "0"
assert_num_gt "cross-receipt product results"     "$(curl -fsS "$RE_TEST_BASE/api/products" | jq -r 'length')" "0"

# --- async (re)resolve returns 202 + productsUrl ---------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/receipts/$id/profileResults/$PROFILE/resolveProducts?async=1")"
assert_http   "async resolve -> 202"              "202" "$code"
assert_eq     "async status queued"               "queued" "$(jq -r '.status' "$body")"
assert_nonempty "async productsUrl"               "$(jq -r '.productsUrl' "$body")"

# --- unknown receipt -> 404 ------------------------------------------------
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$RE_TEST_BASE/api/receipts/nope/profileResults/$PROFILE/resolveProducts")"
assert_http   "unknown receipt -> 404"            "404" "$code"

# --- show the resolved products for a human --------------------------------
curl -fsS "$RE_TEST_BASE/api/receipts/$id/products/$PROFILE" > "$body"
step_banner "Products (from profile '$PROFILE')"
jq -r '
  "Store: \(.store.name // "(unknown)")   resolver: \(.resolver) [\(.model // "—")]",
  "--------------------------------------------------",
  (.products[]? | "  \(.emoji // "·") " + (.productTitle // ("(unresolved) " + (.lineItem.description // "?")))
     + (if .productUrl then "\n      ↳ \(.productUrl)" else "" end)
     + (if .error then "\n      ! \(.error)" else "" end)),
  "--------------------------------------------------",
  "resolved \(.stats.resolved) · skipped \(.stats.skipped) · errors \(.stats.errors)"
' "$body" >&2

rm -f "$body"
report
