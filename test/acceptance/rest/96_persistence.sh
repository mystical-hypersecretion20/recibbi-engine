#!/usr/bin/env bash
# REST: persistence layer. Proves the configured durable-record backend
# ($RE_TEST_PERSISTENCE) is actually in effect AND that a processed receipt
# SURVIVES a process restart — i.e. it was written to durable storage on the
# shared data volume, not just held in memory. Runs identically for both
# backends (filesystem default; `--sqlite` selects the SQLite backend), so the
# acceptance suite covers persistence on both.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
. "$DIR/../lib/compose.sh"
require_curl; require_jq; require_stack
step_banner "REST: persistence backend = $RE_TEST_PERSISTENCE (+ durability across restart)"

# 1) /health advertises the active backend.
backend="$(curl -fsS "$RE_TEST_BASE/health" | jq -r '.persistence')"
assert_eq "active backend" "$RE_TEST_PERSISTENCE" "$backend"

# 2) The backend wrote where we expect on the data volume — concrete proof the
#    switch took effect, inspected inside the api container. A processed receipt
#    must exist first (so the DB/dir is created), and `compose exec` can return a
#    transient empty result, so seed + retry before asserting.
ensure_receipt >/dev/null
DB_PATH="${SQLITE_PATH:-/app/data/receipt-enricher.db}"
db_present=""
for _ in 1 2 3; do
  db_present="$(in_container api "test -e '$DB_PATH' && echo yes || echo no" 2>/dev/null | tr -dc 'a-z')"
  [ -n "$db_present" ] && break
  sleep 1
done
if [ "$RE_TEST_PERSISTENCE" = "sqlite" ]; then
  assert_eq "sqlite db file present on volume" "yes" "$db_present"
else
  assert_eq "no sqlite db file (filesystem backend)" "no" "$db_present"
fi

# 3) Seed a processed receipt, then restart the app processes and confirm the
#    record is still retrievable (durable storage, not in-memory state).
id="$(ensure_receipt)"
assert_nonempty "seeded receipt id" "$id"

info "restarting api + worker to force fresh processes ..."
compose restart api worker >/dev/null 2>&1 || die "compose restart failed"
wait_healthy

body="$(mktemp)"
code="$(curl -sS -o "$body" -w '%{http_code}' "$RE_TEST_BASE/api/receipts/$id")"
assert_http "receipt readable after restart"      "200"  "$code"
assert_eq   "same id after restart"               "$id"  "$(jq -r '.id' "$body")"
assert_eq   "status still done after restart"     "done" "$(jq -r '.status' "$body")"
rm -f "$body"

# 4) It also still shows up in the listing (durable, not just direct-get).
listed="$(curl -fsS "$RE_TEST_BASE/api/receipts?limit=100" | jq -r --arg id "$id" '[.[]|select(.id==$id)]|length')"
assert_eq "receipt present in list after restart" "1" "$listed"

report
