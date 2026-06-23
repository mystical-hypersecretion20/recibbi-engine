#!/usr/bin/env bash
# CLI driver: render a receipt as pretty-printed text and confirm its web view
# is reachable as HTML.
#
# We deliberately do NOT call `receipts view`, which launches a local browser
# (`open`/`xdg-open`). Instead we fetch the record via `receipts status` and
# render it as readable text, then check the view endpoint with curl (no browser).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "CLI: render receipt (text) + view reachable"

id="$(ensure_receipt)"

# Fetch the record through the CLI and render it as text (no browser).
rec="$(API_URL="$RE_TEST_BASE" "$(cli)" status "$id" 2>/dev/null)" || die "cli status failed"
text="$(printf '%s' "$rec" | render_receipt_text)"
printf '%s\n' "$text" >&2     # human-readable receipt to the console

assert_eq       "cli status: id matches"     "$id" "$(printf '%s' "$rec" | jq -r '.id')"
assert_nonempty "rendered text produced"     "$text"
assert_contains "rendered text names receipt" "$text" "Receipt $id"

# Confirm the HTML view is reachable WITHOUT opening a browser.
url="$RE_TEST_BASE/receipts/$id/view"
ctype="$(curl -sS -o /dev/null -w '%{content_type}' "$url")"
code="$(curl -sS -o /dev/null -w '%{http_code}' "$url")"
assert_http     "view page loads"  "200" "$code"
assert_contains "view is HTML"     "$ctype" "text/html"

report
