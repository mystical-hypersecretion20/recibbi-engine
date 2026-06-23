#!/usr/bin/env bash
# REST: GET /receipts/:id/view returns an HTML page.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: GET /receipts/:id/view"

id="$(ensure_receipt)"

body="$(mktemp)"
ctype="$(curl -sS -o "$body" -w '%{content_type}' "$RE_TEST_BASE/receipts/$id/view")"
code="$(curl -sS -o /dev/null -w '%{http_code}' "$RE_TEST_BASE/receipts/$id/view")"
assert_http     "GET view"            "200" "$code"
assert_contains "view: content-type html" "$ctype" "text/html"
assert_contains "view: body is HTML"  "$(head -c 300 "$body")" "<"
rm -f "$body"

report
