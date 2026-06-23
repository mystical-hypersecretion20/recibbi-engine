#!/usr/bin/env bash
# Shared helpers for the blob-fetch scripts in this directory.
#
# Source it from a script:
#     source "$(dirname "$0")/lib/common.sh"
#
# Design notes for this managed network (see ../tessdata/README.md,
# ../.vendor/README.md and the receipt-enricher-dev skill):
#   - Node's TLS bundle blocks some hosts (jsdelivr CDN, Tavily). `curl` is the
#     reliable downloader here, and even it can be intercepted for some hosts.
#   - The most reliable source for these blobs is therefore the known-good
#     sibling checkout (SOURCE_REPO). Each fetch script defaults to "auto":
#     copy from SOURCE_REPO if present, else download over the network. Either
#     way the bytes are verified against scripts/SHA256SUMS.txt before they win.

set -euo pipefail

# --- locate the repo root (works whether or not we're in a git checkout) ----
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$SCRIPTS_DIR/.." && pwd)"
SUMS_FILE="$SCRIPTS_DIR/SHA256SUMS.txt"

# Sibling checkout that holds the known-good working blobs. Override with
# SOURCE_REPO=/path/to/receipt-enricher if your layout differs.
: "${SOURCE_REPO:=$REPO_ROOT/../claude-ocr-receipt/receipt-enricher}"

# Where to obtain blobs from: auto (local-then-network) | local | network
: "${SOURCE_MODE:=auto}"

# --- pretty logging ---------------------------------------------------------
_c_reset=$'\033[0m'; _c_blue=$'\033[34m'; _c_yellow=$'\033[33m'; _c_red=$'\033[31m'; _c_green=$'\033[32m'
log()  { printf '%s[*]%s %s\n' "$_c_blue"   "$_c_reset" "$*"; }
ok()   { printf '%s[+]%s %s\n' "$_c_green"  "$_c_reset" "$*"; }
warn() { printf '%s[!]%s %s\n' "$_c_yellow" "$_c_reset" "$*" >&2; }
die()  { printf '%s[x]%s %s\n' "$_c_red"    "$_c_reset" "$*" >&2; exit 1; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# --- sha256 helpers ---------------------------------------------------------
# Print the sha256 of a file (portable across macOS `shasum` and Linux `sha256sum`).
sha256_of() {
  local f="$1"
  if have_cmd shasum; then shasum -a 256 "$f" | awk '{print $1}'
  elif have_cmd sha256sum; then sha256sum "$f" | awk '{print $1}'
  else die "need 'shasum' or 'sha256sum' to verify downloads"; fi
}

# Look up the expected hash for a repo-relative path in SHA256SUMS.txt.
expected_sha256() {
  local relpath="$1"
  awk -v p="$relpath" '!/^#/ && $2==p {print $1; found=1} END{exit !found}' "$SUMS_FILE" \
    || die "no checksum recorded for '$relpath' in $SUMS_FILE"
}

# Verify a file (given by repo-relative path) against SHA256SUMS.txt.
verify_blob() {
  local relpath="$1" abs="$REPO_ROOT/$1"
  [ -f "$abs" ] || die "missing file to verify: $relpath"
  local want got
  want="$(expected_sha256 "$relpath")"
  got="$(sha256_of "$abs")"
  if [ "$want" = "$got" ]; then
    ok "verified $relpath  (sha256 ${got:0:12}…)"
  else
    die "CHECKSUM MISMATCH for $relpath
       expected $want
       got      $got
     The file is corrupt, blocked, or tampered with — refusing to use it."
  fi
}

# --- download / copy --------------------------------------------------------
# curl wrapper with a TLS interception fallback. Tries a strict download first;
# on a TLS/cert failure (curl exit 35/60) it retries with -k and a loud warning.
curl_fetch() {
  local url="$1" dest="$2"
  have_cmd curl || die "curl is required for network downloads"
  log "downloading $url"
  if curl -fSL --retry 3 --connect-timeout 20 -o "$dest" "$url"; then
    return 0
  fi
  local rc=$?
  if [ "$rc" = 35 ] || [ "$rc" = 60 ]; then
    warn "TLS verification failed (curl rc=$rc) — retrying INSECURELY (-k)."
    warn "This is the documented TLS-intercepting proxy workaround; the sha256 check below is what keeps it safe."
    curl -fSLk --retry 3 --connect-timeout 20 -o "$dest" "$url" \
      || die "download failed even with -k: $url"
  else
    die "download failed (curl rc=$rc): $url"
  fi
}

# Obtain one blob into the repo, choosing source per SOURCE_MODE, then verify.
#   obtain_blob <repo-relative-dest> <url> [source-rel-in-SOURCE_REPO]
# The third arg defaults to the same relative path inside SOURCE_REPO.
obtain_blob() {
  local relpath="$1" url="$2" src_rel="${3:-$1}"
  local dest="$REPO_ROOT/$relpath"
  local src="$SOURCE_REPO/$src_rel"
  mkdir -p "$(dirname "$dest")"

  case "$SOURCE_MODE" in
    local)
      [ -f "$src" ] || die "SOURCE_MODE=local but blob not found: $src"
      log "copying from local source: $src"
      cp "$src" "$dest" ;;
    network)
      curl_fetch "$url" "$dest" ;;
    auto)
      if [ -f "$src" ]; then
        log "copying from local source: $src"
        cp "$src" "$dest"
      else
        warn "local source missing ($src) — falling back to network"
        curl_fetch "$url" "$dest"
      fi ;;
    *) die "invalid SOURCE_MODE='$SOURCE_MODE' (use auto|local|network)" ;;
  esac

  verify_blob "$relpath"
}

# Parse the common --source/--from-local/--network flags into SOURCE_MODE.
parse_source_flag() {
  case "${1:-}" in
    --local|--from-local) SOURCE_MODE=local ;;
    --network|--remote)   SOURCE_MODE=network ;;
    --auto)               SOURCE_MODE=auto ;;
    "" ) ;;
    *) return 1 ;;
  esac
}
