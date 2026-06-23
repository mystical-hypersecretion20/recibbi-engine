# shellcheck shell=bash
# Engine-aware compose lifecycle. SOURCE after lib/common.sh.
#
# Everything here is scoped to the TEST project ($RE_TEST_PROJECT) via -p, so it
# can never touch a production stack on the same host. stack_down additionally
# refuses to run if the project name equals the production name.

# Resolve the compose command into the array _COMPOSE_CMD.
_resolve_engine() {
  case "$RE_TEST_ENGINE" in
    podman)
      # podman lives in /opt/podman/bin on this host; ensure it's reachable.
      case ":$PATH:" in
        *":/opt/podman/bin:"*) ;;
        *) PATH="/opt/podman/bin:$PATH"; export PATH ;;
      esac
      command -v podman-compose >/dev/null 2>&1 || \
        die "podman-compose not found (RE_TEST_ENGINE=podman). Plain 'podman compose' is not used."
      _COMPOSE_CMD=(podman-compose)
      ;;
    docker)
      command -v docker >/dev/null 2>&1 || die "docker not found (RE_TEST_ENGINE=docker)"
      _COMPOSE_CMD=(docker compose)
      ;;
    *)
      die "unknown RE_TEST_ENGINE='$RE_TEST_ENGINE' (use 'podman' or 'docker')"
      ;;
  esac
}

# Run a compose subcommand against the test project + base compose file.
compose() {
  _resolve_engine
  local profile_args=()
  [ -n "${RE_TEST_COMPOSE_PROFILE:-}" ] && profile_args=(--profile "$RE_TEST_COMPOSE_PROFILE")
  # NB: ${arr[@]+"${arr[@]}"} — expand to nothing when the array is empty. A bare
  # "${profile_args[@]}" trips `set -u` ("unbound variable") on macOS bash 3.2.
  ( cd "$PROJECT_DIR" && "${_COMPOSE_CMD[@]}" -p "$RE_TEST_PROJECT" ${profile_args[@]+"${profile_args[@]}"} -f docker-compose.yml "$@" )
}

# Run a shell command inside a service container (api|worker|redis). -T disables
# the pseudo-TTY so output is capturable in $(...). Used by the stack/ checks to
# assert image contents (e.g. the Tesseract blobs are baked in).
in_container() {
  compose exec -T "$1" sh -c "$2"
}

# Build + start the test stack, then wait until /health is OK.
stack_up() {
  info "engine=$RE_TEST_ENGINE  project=$RE_TEST_PROJECT  port=$RE_TEST_API_PORT  ocr=$RE_TEST_OCR  persistence=$RE_TEST_PERSISTENCE"
  [ -n "${RE_TEST_COMPOSE_PROFILE:-}" ] && info "compose profile: $RE_TEST_COMPOSE_PROFILE (PaddleOCR sidecar)"
  info "building + starting the test stack ..."
  compose up --build -d || die "compose up failed"
  wait_healthy
  wait_sidecar_ready
}

# When a PaddleOCR engine is active, wait for its sidecar to finish loading the
# model (its /health reports ready=true). Until then the first receipt would
# block on a cold model load; for VL that's minutes. No-op for non-paddle runs.
wait_sidecar_ready() {
  local svc="${RE_TEST_COMPOSE_PROFILE:-}"
  [ -n "$svc" ] || return 0
  case "$svc" in paddle) svc="ocr-paddle" ;; paddle-vl) svc="ocr-paddle-vl" ;; esac
  info "waiting for $svc model to load (ready=true) ..."
  local waited=0
  while :; do
    if in_container "$svc" "python -c \"import urllib.request,json,sys; d=json.load(urllib.request.urlopen('http://127.0.0.1:8090/health',timeout=3)); sys.exit(0 if d.get('ready') else 1)\"" >/dev/null 2>&1; then
      info "$svc model is loaded and ready"
      return 0
    fi
    if [ "$waited" -ge "$RE_TEST_POLL_TIMEOUT" ]; then
      warn "$svc logs (tail):"; compose logs --tail 30 "$svc" >&2 2>/dev/null || true
      die "$svc did not become ready within ${RE_TEST_POLL_TIMEOUT}s"
    fi
    sleep 5; waited=$((waited + 5))
  done
}

# Poll the API /health endpoint until it returns 200 (status ok) or times out.
wait_healthy() {
  info "waiting for $RE_TEST_BASE/health ..."
  local waited=0
  while :; do
    if curl -fsS "$RE_TEST_BASE/health" >/dev/null 2>&1; then
      info "stack is healthy at $RE_TEST_BASE"
      return 0
    fi
    if [ "$waited" -ge "$RE_TEST_POLL_TIMEOUT" ]; then
      warn "last container status:"; compose ps >&2 || true
      die "stack did not become healthy within ${RE_TEST_POLL_TIMEOUT}s"
    fi
    sleep 2; waited=$((waited + 2))
  done
}

# Tear down the test stack. Removes volumes unless RE_TEST_KEEP_VOLUMES=1.
stack_down() {
  # SAFETY GUARD: never operate on the production project name.
  if [ "$RE_TEST_PROJECT" = "$PROD_PROJECT_NAME" ]; then
    die "refusing to tear down project '$RE_TEST_PROJECT' (matches production name '$PROD_PROJECT_NAME'). Set RE_TEST_PROJECT to a test-only name."
  fi
  if [ "$RE_TEST_KEEP_VOLUMES" = "1" ]; then
    info "tearing down '$RE_TEST_PROJECT' (keeping volumes)"
    compose down || warn "compose down returned non-zero"
  else
    info "tearing down '$RE_TEST_PROJECT' (removing volumes)"
    compose down -v || warn "compose down -v returned non-zero"
    # Belt-and-suspenders: ensure the named volumes are gone even if the engine
    # ignored -v. Scoped strictly to the test project.
    _resolve_engine
    if [ "${_COMPOSE_CMD[0]}" = "podman-compose" ]; then
      podman volume rm "${RE_TEST_PROJECT}_redis-data" "${RE_TEST_PROJECT}_receipt-data" >/dev/null 2>&1 || true
    fi
  fi
  rm -f "$RE_STATE_ID_FILE"
}
