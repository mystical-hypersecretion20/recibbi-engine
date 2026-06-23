#!/usr/bin/env bash
# REST: multi-tenancy end-to-end against the real containerized stack (real Redis,
# real per-tenant BullMQ queues). Validates the three behaviors that the hermetic
# suite can only fake:
#   1. Dynamic tenant onboarding — a tenant created at RUNTIME (POST /api/tenants)
#      gets its own queue (receipts-<tenant>) that the worker starts consuming, so
#      an upload under it actually processes to `done`.
#   2. Unknown-tenant rejection — an upload for an unprovisioned tenant is 400.
#   3. Cross-tenant / cross-user isolation — a receipt is reachable by its own
#      composite id but not under another user or tenant, and listing is scoped to
#      the requesting identity.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
require_curl; require_jq; require_stack
step_banner "REST: multi-tenancy (dynamic onboarding, per-tenant queues, isolation)"

[ -f "$RE_TEST_SAMPLE" ] || die "sample image not found: $RE_TEST_SAMPLE"

# Unique, valid (`[A-Za-z0-9_-]`) ids so reruns/parallel stacks don't collide.
TENANT="acme$$"
USER="alice$$"
OTHER_USER="bob$$"
GHOST="ghost$$"          # deliberately NOT provisioned
body="$(mktemp)"

# --- 1. provision a brand-new tenant at runtime ----------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$RE_TEST_BASE/api/tenants" \
        -H 'content-type: application/json' -d "{\"tenantId\":\"$TENANT\"}")"
assert_http   "provision tenant -> 201" "201" "$code"
assert_eq     "provision: created=true" "true" "$(jq -r '.created' "$body")"
assert_eq     "provision: returns tenantId" "$TENANT" "$(jq -r '.tenantId' "$body")"

# It now appears in the registry alongside the always-present default tenant.
curl -fsS "$RE_TEST_BASE/api/tenants" > "$body"
assert_eq "GET /api/tenants lists default 'main'" "main" "$(jq -r '.default' "$body")"
assert_eq "GET /api/tenants lists the new tenant" "1" \
  "$(jq -r --arg t "$TENANT" '[.tenants[] | select(. == $t)] | length' "$body")"

# --- 2. unknown (unprovisioned) tenant is rejected --------------------------
code="$(curl -sS -o "$body" -w '%{http_code}' \
        -H "X-Tenant-Id: $GHOST" -H "X-User-Id: $USER" \
        -F "receipt=@$RE_TEST_SAMPLE" -F "source=acceptance" "$RE_TEST_BASE/api/receipts")"
assert_http     "upload for unknown tenant -> 400" "400" "$code"
assert_contains "unknown-tenant error names the tenant" "$(cat "$body")" "$GHOST"

# --- 3. upload under the new tenant/user; it must process to done -----------
# Reaching `done` is the real proof of dynamic onboarding: the tenant didn't
# exist at stack-up, so the worker had to pick up its receipts-<tenant> queue at
# runtime (registry watch) for this job to run at all.
code="$(curl -sS -o "$body" -w '%{http_code}' \
        -H "X-Tenant-Id: $TENANT" -H "X-User-Id: $USER" \
        -F "receipt=@$RE_TEST_SAMPLE" -F "source=acceptance" "$RE_TEST_BASE/api/receipts")"
assert_http "upload under new tenant -> 202" "202" "$code"
id="$(jq -r '.id' "$body")"
assert_nonempty "upload returns a composite id" "$id"
assert_eq "id is scoped to <tenant>:<user>:" "1" \
  "$(printf '%s' "$id" | grep -c "^$TENANT:$USER:" || true)"
cache="${id##*:}"   # the cacheId segment

waited=0; status=""
while :; do
  status="$(curl -fsS "$RE_TEST_BASE/api/receipts/$id" | jq -r '.status' 2>/dev/null || echo '')"
  { [ "$status" = "done" ] || [ "$status" = "failed" ]; } && break
  [ "$waited" -ge "$RE_TEST_POLL_TIMEOUT" ] && break
  sleep "$RE_TEST_POLL_INTERVAL"; waited=$((waited + RE_TEST_POLL_INTERVAL))
done
assert_eq "receipt processes to done on the per-tenant queue" "done" "$status"

# --- 4. cross-tenant / cross-user isolation ---------------------------------
# The composite id resolves; the SAME cacheId under another user or tenant 404s
# (storage is physically partitioned per tenant/user).
assert_http "own composite id -> 200" "200" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$RE_TEST_BASE/api/receipts/$id")"
assert_http "same cacheId, other USER -> 404" "404" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$RE_TEST_BASE/api/receipts/$TENANT:$OTHER_USER:$cache")"
assert_http "same cacheId, other TENANT -> 404" "404" \
  "$(curl -sS -o /dev/null -w '%{http_code}' "$RE_TEST_BASE/api/receipts/zzz$$:$USER:$cache")"

# --- 5. list scoping --------------------------------------------------------
# Listing is scoped to the requesting identity (X-Tenant-Id/X-User-Id).
curl -fsS -H "X-Tenant-Id: $TENANT" -H "X-User-Id: $USER" "$RE_TEST_BASE/api/receipts" > "$body"
assert_eq "list as owner includes the receipt" "1" \
  "$(jq -r --arg id "$id" '[.[] | select(.id == $id)] | length' "$body")"
assert_eq "list as owner is all same-scope ids" "true" \
  "$(jq -r --arg p "$TENANT:$USER:" 'all(.[]; .id | startswith($p))' "$body")"

# A different user in the SAME tenant must not see it (per-user isolation).
curl -fsS -H "X-Tenant-Id: $TENANT" -H "X-User-Id: $OTHER_USER" "$RE_TEST_BASE/api/receipts" > "$body"
assert_eq "list as another user excludes the receipt" "0" \
  "$(jq -r --arg id "$id" '[.[] | select(.id == $id)] | length' "$body")"

# The default (main:main) listing must not see it either (cross-tenant).
curl -fsS "$RE_TEST_BASE/api/receipts" > "$body"
assert_eq "default-tenant list excludes the receipt" "0" \
  "$(jq -r --arg id "$id" '[.[] | select(.id == $id)] | length' "$body")"

rm -f "$body"
report
