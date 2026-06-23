#!/usr/bin/env bash
# REST: error paths — unknown id (404), non-image upload (400), no file (400).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_stack
step_banner "REST: error cases"

# Unknown receipt id -> 404
code="$(curl -sS -o /dev/null -w '%{http_code}' "$RE_TEST_BASE/api/receipts/deadbeefdeadbeef")"
assert_http "unknown id -> 404" "404" "$code"

# Non-image upload -> 400
tmptxt="$(mktemp)"; printf 'not an image\n' > "$tmptxt"
code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -F "receipt=@$tmptxt;type=text/plain" "$RE_TEST_BASE/api/receipts")"
assert_http "non-image upload -> 400" "400" "$code"
rm -f "$tmptxt"

# Upload with no file field -> 400
code="$(curl -sS -o /dev/null -w '%{http_code}' \
        -F "source=acceptance" "$RE_TEST_BASE/api/receipts")"
assert_http "no file -> 400" "400" "$code"

report
