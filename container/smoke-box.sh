#!/usr/bin/env bash
# End-to-end smoke for ploinky-box. Needs a container engine and either the
# published image or SMOKE_IMAGE pointing at a local build (e.g. ploinky-box:dev).
# Usage: [SMOKE_IMAGE=...] [SMOKE_PORT=...] [SMOKE_AGENT=...] bash smoke-box.sh
set -u

BOX="$(cd "$(dirname "$0")" && pwd)/ploinky-box"
NAME="smoke$$"
PORT="${SMOKE_PORT:-8090}"
IMAGE="${SMOKE_IMAGE:-docker.io/assistos/ploinky-box:podman-node24}"
AGENT="${SMOKE_AGENT:-webtty}"
FAILED=0
TMP_IN="$(mktemp)"
TMP_OUT="$(mktemp)"

step() { # <description> <command...>
    local desc="$1"; shift
    if "$@"; then
        echo "PASS: $desc"
    else
        echo "FAIL: $desc"
        FAILED=1
    fi
}

probe_router() {
    local i
    for i in $(seq 1 30); do
        if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/status" \
           || curl -sf -o /dev/null "http://127.0.0.1:${PORT}/health"; then
            return 0
        fi
        sleep 1
    done
    return 1
}

echo "== ploinky-box smoke: instance=$NAME port=$PORT image=$IMAGE agent=$AGENT =="

step "up"                    "$BOX" --name "$NAME" --port "$PORT" --image "$IMAGE" up
step "enable agent"          "$BOX" --name "$NAME" run enable agent "$AGENT"
step "start agent + router"  "$BOX" --name "$NAME" run start "$AGENT" 8080
step "router responds"       probe_router

echo "smoke payload" > "$TMP_IN"
step "cp into box"           "$BOX" --name "$NAME" cp "$TMP_IN" box:/workspace/smoke.txt
step "cp out of box"         "$BOX" --name "$NAME" cp box:/workspace/smoke.txt "$TMP_OUT"
step "cp round-trip intact"  diff "$TMP_IN" "$TMP_OUT"

step "stop"                  "$BOX" --name "$NAME" stop
step "re-up (state kept)"    "$BOX" --name "$NAME" --port "$PORT" --image "$IMAGE" up
step "resume agents"         "$BOX" --name "$NAME" run start
step "router responds again" probe_router

if [ -n "${SMOKE_WS_AGENT:-}" ]; then
    step "ws agent enable"   "$BOX" --name "$NAME" run enable agent "$SMOKE_WS_AGENT"
    step "ws agent restart"  "$BOX" --name "$NAME" run start
    echo "NOTE: verify the additionalServerPort surface of $SMOKE_WS_AGENT manually via the router, then record the outcome in container/README.md"
else
    echo "WS-CHECK SKIPPED (set SMOKE_WS_AGENT=<agent-with-additionalServerPort> to exercise it)"
fi

printf 'y\n' | "$BOX" --name "$NAME" destroy
rm -f "$TMP_IN" "$TMP_OUT"

echo
if [ "$FAILED" -eq 0 ]; then
    echo "== SMOKE PASSED =="
else
    echo "== SMOKE FAILED =="
fi
exit "$FAILED"
