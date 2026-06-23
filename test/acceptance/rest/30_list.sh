#!/usr/bin/env bash
# REST: GET /api/receipts (and ?limit=) lists receipts including a known one.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: GET /api/receipts"

id="$(ensure_receipt)"

body="$(mktemp)"
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/receipts?limit=20")"
assert_http     "GET list"                   "200" "$code"
assert_nonempty "list: is an array"          "$(jq -r 'if type=="array" then "array" else "" end' "$body")"
assert_eq       "list: contains the receipt" "1"   "$(jq -r --arg id "$id" 'map(select(.id==$id)) | length' "$body")"
rm -f "$body"

report
