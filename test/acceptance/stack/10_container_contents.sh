#!/usr/bin/env bash
# STACK: assert build-time requirements are actually baked into the running
# images — things the app needs at runtime that are easy to omit from the build
# context and produce only cryptic runtime failures.
#
# Motivating bug (recurring): the Tesseract language blobs (tessdata/*.traineddata)
# are large, gitignored files present only in a full checkout. Building from a
# fresh worktree (which lacks them) bakes an EMPTY tessdata into the image — OCR
# then fails at runtime with an opaque "tesseract worker error" and the receipt
# just goes `failed`. This check turns that into an explicit, early failure:
# "eng.traineddata missing/too small in <service> container".
#
# Runs as a `stack/` step so run-all.sh executes it FIRST (before cli/ + rest/),
# failing fast with a clear message instead of a confusing OCR error downstream.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
. "$DIR/../lib/compose.sh"
require_curl
require_stack   # containers must be up (00_up.sh / run-all brings them up)
step_banner "STACK: baked-in image contents (OCR blobs, wasm core, app source)"

TESSDATA_DIR="${TESSDATA_PATH:-/app/tessdata}"

# Assert a file exists in a container and is at least min_bytes. Reports the
# measured size (or -1 if absent/unreadable) so failures are self-explanatory.
check_file() {  # service path min_bytes desc
  local svc="$1" path="$2" min="$3" desc="$4" size
  size="$(in_container "$svc" "wc -c < '$path' 2>/dev/null || echo -1" | tr -dc '0-9-')"
  [ -n "$size" ] || size="-1"
  assert_num_gt "$desc [$svc]" "$size" "$min"
}

# Assert a path exists (file or dir) in a container.
check_path() {  # service path desc
  local svc="$1" path="$2" desc="$3" out
  out="$(in_container "$svc" "[ -e '$path' ] && echo yes || echo no" | tr -dc 'a-z')"
  assert_eq "$desc [$svc]" "yes" "$out"
}

# The OCR happens in the worker; the api shares the same image. Verify the
# Tesseract blobs are present and plausibly-sized (not empty placeholders) in
# BOTH, so a broken COPY is caught regardless of which service is inspected.
for svc in worker api; do
  check_file "$svc" "$TESSDATA_DIR/eng.traineddata" 1000000 "eng.traineddata baked in (>1MB)"
  check_file "$svc" "$TESSDATA_DIR/osd.traineddata" 1000000 "osd.traineddata baked in (>1MB)"
done

# The wasm OCR core must be installed (npm ci), or Tesseract can't run offline.
check_path  worker "/app/node_modules/tesseract.js-core" "tesseract.js-core wasm present"

# better-sqlite3 is a NATIVE module: its prebuilt binary must be baked in and
# loadable for this image's arch (the Dockerfile vendors it offline). Verify it
# actually loads in BOTH services — a missing/mismatched binary otherwise only
# surfaces (under PERSISTENCE=sqlite) as a cryptic runtime crash. Cheap to check
# regardless of the active backend.
for svc in worker api; do
  out="$(in_container "$svc" "node -e \"new (require('better-sqlite3'))(':memory:').exec('SELECT 1'); console.log('ok')\" 2>/dev/null" | tr -dc 'a-z')"
  assert_eq "better-sqlite3 native module loads [$svc]" "ok" "$out"
done
# Sanity: app source actually copied in.
check_path  worker "/app/src/server.js" "app source present"
check_path  worker "/app/src/products/resolvers/anthropic.js" "products resolver present"

report
