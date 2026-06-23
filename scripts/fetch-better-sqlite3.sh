#!/usr/bin/env bash
# Fetch the vendored better-sqlite3 native prebuilt binaries into .vendor/.
#
# better-sqlite3 is a NATIVE module. Two constraints on this setup:
#   1. Node 20 (ABI v115) only has a prebuilt up to better-sqlite3@11.10.0 — v12
#      dropped it. The dependency is pinned to 11.10.0 (see .vendor/README.md).
#   2. TLS interception breaks prebuild-install's GitHub download from inside Node;
#      curl is not affected, so we fetch with curl and drop the tarball in.
#
# Three arches are vendored so both local dev and the container build are covered:
#   darwin-arm64       local dev on Apple Silicon
#   linuxmusl-arm64    node:20-alpine container on arm64
#   linuxmusl-x64      node:20-alpine container on x64
#
# Usage:
#   scripts/fetch-better-sqlite3.sh [--auto|--local|--network]
#
# Every tarball is verified against scripts/SHA256SUMS.txt before it is accepted.
# After fetching, optionally extract the binary for THIS machine's arch:
#   scripts/fetch-better-sqlite3.sh --local && \
#     tar -xzf .vendor/better-sqlite3-v11.10.0-node-v115-darwin-arm64.tar.gz \
#         -C node_modules/better-sqlite3/
set -euo pipefail
source "$(dirname "$0")/lib/common.sh"

parse_source_flag "${1:-}" || die "unknown flag '$1' (use --auto|--local|--network)"

V=11.10.0
ABI=v115   # Node 20
BASE="https://github.com/WiseLibs/better-sqlite3/releases/download/v$V"
ARCHES=(darwin-arm64 linuxmusl-arm64 linuxmusl-x64)

log "fetching better-sqlite3 $V prebuilts (mode=$SOURCE_MODE, source repo=$SOURCE_REPO)"

for a in "${ARCHES[@]}"; do
  fname="better-sqlite3-v$V-node-$ABI-$a.tar.gz"
  obtain_blob ".vendor/$fname" "$BASE/$fname"
done

ok "better-sqlite3 prebuilts ready in $REPO_ROOT/.vendor"
log "to use locally (macOS arm64): npm install --ignore-scripts && \\"
log "  tar -xzf .vendor/better-sqlite3-v$V-node-$ABI-darwin-arm64.tar.gz -C node_modules/better-sqlite3/"
log "(the container build extracts the linuxmusl-<arch> tarball itself — see Dockerfile)"
