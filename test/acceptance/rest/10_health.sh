#!/usr/bin/env bash
# REST: GET /health -> 200 with status ok, redis up.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: GET /health"

body="$(mktemp)"
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/health")"
assert_http     "GET /health"                 "200" "$code"
assert_eq       "GET /health: status ok"      "ok"  "$(jq -r '.status' "$body")"
assert_eq       "GET /health: redis up"       "up"  "$(jq -r '.redis' "$body")"
assert_nonempty "GET /health: ocrProvider"    "$(jq -r '.ocrProvider' "$body")"
assert_eq       "GET /health: persistence backend" "$RE_TEST_PERSISTENCE" "$(jq -r '.persistence' "$body")"
# Product emoji mapping is on by default (PRODUCT_EMOJI_ENABLED unset).
assert_eq       "GET /health: products.emoji on"  "true" "$(jq -r '.products.emoji' "$body")"
rm -f "$body"

report
