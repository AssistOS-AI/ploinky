#!/bin/sh
set -eu

PROBE_CONTROL_ROOT='/run/ploinky-health-probes'
PROBE_BROKER='/Agent/server/HealthProbeRunner.sh'
PROBE_READY="$PROBE_CONTROL_ROOT/.broker-ready"
RELAY_BROKER='/Agent/server/RuntimeHttpRelay.mjs'
RELAY_SOCKET="$PROBE_CONTROL_ROOT/runtime-relay.sock"
BROKER_START_ATTEMPTS=100
BROKER_START_INTERVAL_SECONDS='0.05'
RELAY_START_ATTEMPTS=600
probe_broker_pid=''
relay_broker_pid=''
relay_ready=''

stop_brokers() {
    [ -z "$probe_broker_pid" ] || kill -TERM "$probe_broker_pid" 2>/dev/null || true
    [ -z "$relay_broker_pid" ] || kill -TERM "$relay_broker_pid" 2>/dev/null || true
    [ -z "$probe_broker_pid" ] || wait "$probe_broker_pid" 2>/dev/null || true
    [ -z "$relay_broker_pid" ] || wait "$relay_broker_pid" 2>/dev/null || true
    [ -z "$relay_ready" ] || rmdir "$relay_ready" 2>/dev/null || true
}

fail() {
    stop_brokers
    printf '%s\n' "ploinky agent entrypoint: $*" >&2
    exit 125
}

[ "$#" -gt 0 ] || fail 'main command is missing'
[ -d "$PROBE_CONTROL_ROOT" ] || fail 'health probe control mount is unavailable'
[ "${PLOINKY_HEALTH_PROBE_BROKER:-}" = '0' ] \
    || [ "${PLOINKY_HEALTH_PROBE_BROKER:-}" = '1' ] \
    || fail 'health probe broker selection is invalid'

# The bind survives managed replacement. Remove only the empty readiness marker
# from the retired broker before starting this generation; request directories
# remain untouched so an ambiguous predecessor can never be silently erased.
rmdir "$PROBE_READY" 2>/dev/null || [ ! -e "$PROBE_READY" ] \
    || fail 'stale health probe broker marker is not an empty directory'

if [ "$PLOINKY_HEALTH_PROBE_BROKER" = '1' ]; then
    [ -f "$PROBE_BROKER" ] || fail 'health probe broker is unavailable'
    sh "$PROBE_BROKER" serve "$PROBE_CONTROL_ROOT" &
    probe_broker_pid="$!"

    attempt=0
    while [ ! -d "$PROBE_READY" ]; do
        if ! kill -0 "$probe_broker_pid" 2>/dev/null; then
            set +e
            wait "$probe_broker_pid"
            broker_status="$?"
            set -e
            fail "health probe broker exited during startup (status $broker_status)"
        fi
        [ "$attempt" -lt "$BROKER_START_ATTEMPTS" ] \
            || fail 'health probe broker did not become ready'
        sleep "$BROKER_START_INTERVAL_SECONDS"
        attempt=$((attempt + 1))
    done
fi

if command -v node >/dev/null 2>&1; then
    [ -f "$RELAY_BROKER" ] || fail 'runtime relay broker is unavailable'
    relay_ready_token="$(node -e "process.stdout.write(require('node:crypto').randomUUID())")" \
        || fail 'runtime relay readiness token could not be generated'
    relay_ready="$PROBE_CONTROL_ROOT/.runtime-relay-ready-$relay_ready_token"
    node "$RELAY_BROKER" serve "$RELAY_SOCKET" "$relay_ready" &
    relay_broker_pid="$!"

    attempt=0
    while [ ! -d "$relay_ready" ]; do
        if ! kill -0 "$relay_broker_pid" 2>/dev/null; then
            set +e
            wait "$relay_broker_pid"
            relay_status="$?"
            set -e
            fail "runtime relay broker exited during startup (status $relay_status)"
        fi
        [ "$attempt" -lt "$RELAY_START_ATTEMPTS" ] \
            || fail 'runtime relay broker did not become ready'
        sleep "$BROKER_START_INTERVAL_SECONDS"
        attempt=$((attempt + 1))
    done
    kill -0 "$relay_broker_pid" 2>/dev/null \
        || fail 'runtime relay broker exited after publishing readiness'
    rmdir "$relay_ready" \
        || fail 'runtime relay readiness marker could not be consumed'
    relay_ready=''
else
    [ ! -e "$RELAY_SOCKET" ] && [ ! -L "$RELAY_SOCKET" ] \
        || fail 'runtime relay socket exists but Node.js is unavailable'
fi

main_pid=''
termination_fallback_status=''
forward_termination() {
    signal_status="$1"
    # One termination request is enough. Ignore repeats while the application
    # performs its bounded drain so the wrapper cannot mask its acknowledgement.
    trap '' HUP INT TERM
    if [ -z "$main_pid" ]; then
        stop_brokers
        exit "$signal_status"
    fi
    termination_fallback_status="$signal_status"
    kill -TERM "$main_pid" 2>/dev/null || true
}

trap 'forward_termination 129' HUP
trap 'forward_termination 130' INT
trap 'forward_termination 143' TERM

"$@" &
main_pid="$!"
set +e
wait "$main_pid"
main_status="$?"
set -e

# A signal trap interrupts wait(1) before the main application necessarily
# exits. Reap it again and preserve its real result: exit zero is the explicit
# graceful-drain acknowledgement, while a default SIGTERM remains exit 143.
if [ -n "$termination_fallback_status" ]; then
    set +e
    wait "$main_pid"
    acknowledged_status="$?"
    set -e
    if [ "$acknowledged_status" -ne 127 ]; then
        main_status="$acknowledged_status"
    elif [ "$main_status" -eq 127 ]; then
        main_status="$termination_fallback_status"
    fi
fi

trap - HUP INT TERM
stop_brokers
exit "$main_status"
