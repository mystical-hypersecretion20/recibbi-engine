#!/usr/bin/env bash
# CLI driver: `receipts list` includes a known receipt; `receipts status <id>`
# returns its full record.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "CLI: list + status"

id="$(ensure_receipt)"
info "using receipt id: $id"

listing="$(API_URL="$RE_TEST_BASE" "$(cli)" list 2>/dev/null)" || die "cli list failed"
found="$(printf '%s' "$listing" | jq -r --arg id "$id" 'map(select(.id == $id)) | length')"
assert_eq "cli list: contains the receipt" "1" "$found"

rec="$(API_URL="$RE_TEST_BASE" "$(cli)" status "$id" 2>/dev/null)" || die "cli status failed"
assert_eq       "cli status: id matches"   "$id"   "$(printf '%s' "$rec" | jq -r '.id')"
assert_eq       "cli status: done"         "done"  "$(printf '%s' "$rec" | jq -r '.status')"
assert_nonempty "cli status: has provider" "$(printf '%s' "$rec" | jq -r '.extraction.provider')"

report
