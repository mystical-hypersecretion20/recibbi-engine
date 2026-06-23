#!/usr/bin/env bash
# Verify every present blob against scripts/SHA256SUMS.txt.
#
# Files that are absent are reported as MISSING (not a hard failure) so this can
# run on a partial checkout; any file that IS present must match its recorded
# hash or the script exits non-zero. Good as a pre-build / CI gate.
#
# Usage: scripts/verify-blobs.sh
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

rc=0 present=0 missing=0
log "verifying blobs against $SUMS_FILE"

# Read "<hash>  <relpath>" lines, skipping comments/blanks.
while read -r want relpath; do
  [ -z "${want:-}" ] && continue
  case "$want" in \#*) continue ;; esac
  abs="$REPO_ROOT/$relpath"
  if [ ! -f "$abs" ]; then
    warn "MISSING  $relpath"
    missing=$((missing+1))
    continue
  fi
  got="$(sha256_of "$abs")"
  if [ "$want" = "$got" ]; then
    ok "OK       $relpath"
    present=$((present+1))
  else
    printf '%s[x]%s MISMATCH %s\n     expected %s\n     got      %s\n' \
      "$_c_red" "$_c_reset" "$relpath" "$want" "$got" >&2
    rc=1
  fi
done < "$SUMS_FILE"

echo
log "verified=$present  missing=$missing"
if [ "$rc" -ne 0 ]; then
  die "one or more blobs FAILED checksum verification"
fi
if [ "$missing" -gt 0 ]; then
  warn "some blobs are not present — run scripts/fetch-tessdata.sh / fetch-better-sqlite3.sh"
fi
ok "all present blobs match SHA256SUMS.txt"
