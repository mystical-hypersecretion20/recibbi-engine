#!/usr/bin/env bash
# Stage the machine's trusted CA certificates into the PaddleOCR sidecar build
# contexts (services/*/certs, gitignored). On this managed macOS the
# interception proxy re-signs all outbound HTTPS, so a vanilla pip in
# the image can't verify PyPI. We export every cert the System keychain trusts —
# which includes the full interception chain — one cert per file, so
# the Dockerfile's `update-ca-certificates` ingests each and pip then VERIFIES
# TLS against the internal CA chain (no --trusted-host, no verification disabled).
#
# Re-run if the CAs rotate. macOS-specific (uses `security`).
#
# Usage: scripts/stage-paddle-certs.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root
KEYCHAIN="${PADDLE_CA_KEYCHAIN:-/Library/Keychains/System.keychain}"

command -v security >/dev/null 2>&1 || { echo "ERROR: 'security' not found (macOS only)" >&2; exit 1; }

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
security find-certificate -a -p "$KEYCHAIN" > "$tmp"
count="$(grep -c 'BEGIN CERTIFICATE' "$tmp" || true)"
[ "${count:-0}" -gt 0 ] || { echo "ERROR: no certificates found in $KEYCHAIN" >&2; exit 1; }

for svc in ocr-paddle ocr-paddle-vl; do
  dest="$DIR/services/$svc/certs"
  rm -rf "$dest"; mkdir -p "$dest"
  awk -v d="$dest" 'BEGIN{n=0} /BEGIN CERTIFICATE/{n++; f=sprintf("%s/ca-%02d.crt", d, n)} {print > f}' "$tmp"
  echo "Staged $count CA cert(s) -> $dest"
done
echo "Done."
