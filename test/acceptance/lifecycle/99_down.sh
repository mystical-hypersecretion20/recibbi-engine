#!/usr/bin/env bash
# Tear down the TEST stack. Removes volumes by default (set RE_TEST_KEEP_VOLUMES=1
# to keep them). Refuses to run against the production project name.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/../lib/common.sh"
. "$DIR/../lib/compose.sh"

stack_down
info "teardown complete for '$RE_TEST_PROJECT'"
