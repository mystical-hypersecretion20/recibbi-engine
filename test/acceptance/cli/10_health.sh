#!/usr/bin/env bash
# CLI driver: `receipts health` reports the API + Redis are up.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "CLI: health"

out="$(API_URL="$RE_TEST_BASE" "$(cli)" health 2>/dev/null)" || die "cli health failed"
assert_eq "cli health: status ok"      "ok" "$(printf '%s' "$out" | jq -r '.status')"
assert_eq "cli health: redis up"       "up" "$(printf '%s' "$out" | jq -r '.redis')"
assert_nonempty "cli health: ocrProvider reported" "$(printf '%s' "$out" | jq -r '.ocrProvider')"

report
