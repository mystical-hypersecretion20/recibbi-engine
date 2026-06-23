#!/usr/bin/env bash
# REST: GET /receipts/:id/image returns the original photo bytes.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: GET /receipts/:id/image"

id="$(ensure_receipt)"

img="$(mktemp)"; hdr="$(mktemp)"
code="$(curl -sS -o "$img" -D "$hdr" -w '%{http_code}' "$RE_TEST_BASE/receipts/$id/image")"
assert_http     "GET image"                "200" "$code"
assert_contains "image: content-type image/*" "$(tr 'A-Z' 'a-z' < "$hdr" | grep -i '^content-type')" "image/"
assert_num_gt   "image: non-empty body"    "$(wc -c < "$img" | tr -d ' ')" 0
rm -f "$img" "$hdr"

report
