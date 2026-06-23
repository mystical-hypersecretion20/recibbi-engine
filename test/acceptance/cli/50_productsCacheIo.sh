#!/usr/bin/env bash
# CLI driver: the `products` CLI cache export/import round-trip.
#
# This exercises a PARALLEL, OFFLINE path to populating product data: instead of
# resolving SKUs through the live Anthropic resolver, the product cache can be
# seeded from a file (and snapshotted back out). It's fully independent of
# ANTHROPIC_API_KEY, so it runs identically on the offline (tesseract) and
# vision acceptance paths. We seed a known cache via `import`, verify `stats`,
# `export` it, and prove the round-trip by re-importing the exported file.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "CLI: products cache export/import"

PRODUCTS_CLI="$(products_cli)"
[ -x "$PRODUCTS_CLI" ] || chmod +x "$PRODUCTS_CLI" 2>/dev/null || true

# products CLI is reachable / API up
out="$(API_URL="$RE_TEST_BASE" "$PRODUCTS_CLI" health 2>/dev/null)" || die "products health failed"
assert_eq "products health: status ok" "ok" "$(printf '%s' "$out" | jq -r '.status')"

work="$(mktemp -d)"
seed="$work/seed.json"
exported="$work/exported.json"
key1="products:anthropic:acc${$}a"
key2="products:anthropic:acc${$}b"

# A known, synthetic cache export (no Anthropic involved).
cat > "$seed" <<JSON
{
  "type": "receipt-enricher/products-cache",
  "version": 1,
  "entries": [
    { "key": "$key1", "value": {"productTitle":"ACC Test Water","productUrl":"https://example.com/acc","confidence":0.99}, "ttlSeconds": 600 },
    { "key": "$key2", "value": {"productTitle":"ACC Test Eggs","confidence":0.5}, "ttlSeconds": 600 }
  ]
}
JSON

# --- import (flush first so the count is deterministic) --------------------
out="$(API_URL="$RE_TEST_BASE" "$PRODUCTS_CLI" cache import "$seed" --flush 2>/dev/null)" || die "products cache import failed"
assert_eq     "import reports 2 imported"     "2" "$(printf '%s' "$out" | jq -r '.imported')"
assert_eq     "import reports 0 skipped"      "0" "$(printf '%s' "$out" | jq -r '.skipped')"

# --- stats reflect the import ----------------------------------------------
out="$(API_URL="$RE_TEST_BASE" "$PRODUCTS_CLI" cache stats 2>/dev/null)" || die "products cache stats failed"
assert_eq     "stats shows 2 entries"         "2" "$(printf '%s' "$out" | jq -r '.entries')"

# --- export to a file; the known entry survives the round-trip -------------
API_URL="$RE_TEST_BASE" "$PRODUCTS_CLI" cache export "$exported" >/dev/null 2>&1 || die "products cache export failed"
[ -s "$exported" ] || die "export produced no file"
assert_eq     "export type tag"               "receipt-enricher/products-cache" "$(jq -r '.type' "$exported")"
assert_num_gt "export count >= 2"             "$(jq -r '.count' "$exported")" "1"
assert_eq     "exported known key present"    "1" "$(jq -r --arg k "$key1" '[.entries[]|select(.key==$k)]|length' "$exported")"
assert_eq     "exported value intact"         "ACC Test Water" "$(jq -r --arg k "$key1" '.entries[]|select(.key==$k)|.value.productTitle' "$exported")"

# --- re-import the export -> valid round-trip ------------------------------
out="$(API_URL="$RE_TEST_BASE" "$PRODUCTS_CLI" cache import "$exported" 2>/dev/null)" || die "products re-import failed"
assert_num_gt "re-import imported >= 2"       "$(printf '%s' "$out" | jq -r '.imported')" "1"

# --- bad path is reported, not silently ignored ----------------------------
if API_URL="$RE_TEST_BASE" "$PRODUCTS_CLI" cache import "$work/nope.json" >/dev/null 2>&1; then
  fail "import of a missing file should fail"
else
  pass "import of a missing file fails cleanly"
fi

info "seeded cache holds $(jq -r '.count' "$exported") entries (offline, no Anthropic call)"
rm -rf "$work"
report
