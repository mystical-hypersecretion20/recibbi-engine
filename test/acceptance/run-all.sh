#!/usr/bin/env bash
# Full acceptance suite: bring up an isolated TEST stack, run every cli/ and
# rest/ step, then tear it down. Exits non-zero if any step fails.
#
# Common overrides (env or flags):
#   --engine podman|docker         RE_TEST_ENGINE       (default podman)
#   --ocr tesseract|vision|paddle|paddle-vl  RE_TEST_OCR  (default tesseract, offline)
#   --vision                       shortcut for --ocr vision
#   --paddle                       shortcut for --ocr paddle    (PP-OCRv6 small sidecar; opt-in)
#   --paddle-vl                    shortcut for --ocr paddle-vl (PaddleOCR-VL 1.6 sidecar; slow, opt-in)
#   --persistence fs|sqlite        RE_TEST_PERSISTENCE  (default filesystem)
#   --sqlite                       shortcut for --persistence sqlite
#   --keep-volumes                 RE_TEST_KEEP_VOLUMES=1 (keep data on teardown)
#   --no-teardown                  RE_TEST_NO_TEARDOWN=1  (leave the stack running)
#   -h | --help
#
# PaddleOCR engines are OFF by default: only --paddle/--paddle-vl (or
# RE_TEST_OCR=paddle*) activate the matching compose profile + sidecar and the
# chunked corpus step (corpus/). Their model blobs must be staged + images built
# first (scripts/stage-paddle-models.sh; see test/acceptance/README.md).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --engine)       RE_TEST_ENGINE="${2:?}"; shift 2 ;;
    --ocr)          RE_TEST_OCR="${2:?}"; shift 2 ;;
    --vision)       RE_TEST_OCR="vision"; shift ;;
    --paddle)       RE_TEST_OCR="paddle"; shift ;;
    --paddle-vl)    RE_TEST_OCR="paddle-vl"; shift ;;
    --persistence)  RE_TEST_PERSISTENCE="${2:?}"; shift 2 ;;
    --sqlite)       RE_TEST_PERSISTENCE="sqlite"; shift ;;
    --keep-volumes) RE_TEST_KEEP_VOLUMES=1; shift ;;
    --no-teardown)  RE_TEST_NO_TEARDOWN=1; shift ;;
    -h|--help)      usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 1 ;;
  esac
done
export RE_TEST_ENGINE RE_TEST_OCR RE_TEST_PERSISTENCE RE_TEST_KEEP_VOLUMES RE_TEST_NO_TEARDOWN 2>/dev/null || true

. "$DIR/lib/common.sh"
. "$DIR/lib/compose.sh"
require_curl; require_jq

STEPS_RUN=0
STEPS_FAILED=0
FAILED_NAMES=""

run_step() {
  local script="$1"
  STEPS_RUN=$((STEPS_RUN + 1))
  if bash "$script"; then
    return 0
  else
    STEPS_FAILED=$((STEPS_FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES ${script#$DIR/}"
  fi
}

teardown() {
  # Capture the status that triggered this EXIT trap FIRST. A bare EXIT trap
  # makes the script exit with the status of the trap's last command, so a
  # successful `stack_down` would otherwise mask a real failure (e.g. a failed
  # `stack_up` build exiting 1, or a non-zero step summary). Re-exit with `rc`.
  local rc=$?
  if [ "$RE_TEST_NO_TEARDOWN" = "1" ]; then
    warn "RE_TEST_NO_TEARDOWN=1 — leaving '$RE_TEST_PROJECT' running at $RE_TEST_BASE"
    warn "tear down later with: RE_TEST_PROJECT=$RE_TEST_PROJECT bash $DIR/lifecycle/99_down.sh"
    exit "$rc"
  fi
  stack_down
  exit "$rc"
}
trap teardown EXIT

# --- bring up the isolated test stack --------------------------------------
stack_up

# --- run every step, in order: stack/ (image/infra), cli/, rest/, corpus/ ----
# stack/ runs first so a broken image (e.g. missing OCR blobs) fails fast with a
# clear message instead of surfacing as a cryptic OCR error during cli/rest.
# corpus/ runs last and self-skips unless a PaddleOCR engine is active.
for d in stack cli rest corpus; do
  for s in "$DIR/$d"/*.sh; do
    [ -f "$s" ] || continue
    run_step "$s"
  done
done

# --- summary ---------------------------------------------------------------
printf '\n%s\n' "${_C_BLU}================ ACCEPTANCE SUMMARY ================${_C_RST}" >&2
if [ "$STEPS_FAILED" -eq 0 ]; then
  printf '%s\n' "${_C_GRN}All ${STEPS_RUN} step(s) passed.${_C_RST}" >&2
else
  printf '%s\n' "${_C_RED}${STEPS_FAILED} of ${STEPS_RUN} step(s) failed:${_C_RST}${FAILED_NAMES}" >&2
fi

[ "$STEPS_FAILED" -eq 0 ]
