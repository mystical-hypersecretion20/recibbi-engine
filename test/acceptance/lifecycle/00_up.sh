#!/usr/bin/env bash
# Build + start the isolated TEST stack and wait until it is healthy.
# Safe to run while a production stack is up on the same host (separate project
# name, separate host port, separate volumes).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
. "$DIR/../lib/compose.sh"

require_curl
require_jq
stack_up
info "ready — API at $RE_TEST_BASE (view list: $RE_TEST_BASE/)"
