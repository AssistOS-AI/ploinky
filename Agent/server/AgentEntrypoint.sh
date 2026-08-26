#!/bin/sh
set -eu

PROBE_CONTROL_ROOT='/run/ploinky-health-probes'
PROBE_BROKER='/Agent/server/HealthProbeRunner.sh'
PROBE_READY="$PROBE_CONTROL_ROOT/.broker-ready"
BROKER_START_ATTEMPTS=100
BROKER_START_INTERVAL_SECONDS='0.05'

fail() {
    printf '%s\n' "ploinky agent entrypoint: $*" >&2
    exit 125
}

[ "$#" -gt 0 ] || fail 'main command is missing'
[ -f "$PROBE_BROKER" ] || fail 'health probe broker is unavailable'
[ -d "$PROBE_CONTROL_ROOT" ] || fail 'health probe control mount is unavailable'

# The bind survives managed replacement. Remove only the empty readiness marker
# from the retired broker before starting this generation; request directories
# remain untouched so an ambiguous predecessor can never be silently erased.
rmdir "$PROBE_READY" 2>/dev/null || [ ! -e "$PROBE_READY" ] \
    || fail 'stale health probe broker marker is not an empty directory'

sh "$PROBE_BROKER" serve "$PROBE_CONTROL_ROOT" &
broker_pid="$!"

attempt=0
while [ ! -d "$PROBE_READY" ]; do
    if ! kill -0 "$broker_pid" 2>/dev/null; then
        set +e
        wait "$broker_pid"
        broker_status="$?"
        set -e
        fail "health probe broker exited during startup (status $broker_status)"
    fi
    [ "$attempt" -lt "$BROKER_START_ATTEMPTS" ] \
        || fail 'health probe broker did not become ready'
    sleep "$BROKER_START_INTERVAL_SECONDS"
    attempt=$((attempt + 1))
done

main_pid=''
terminate() {
    status="$1"
    trap - HUP INT TERM
    if [ -n "$main_pid" ]; then
        kill -TERM "$main_pid" 2>/dev/null || true
    fi
    kill -TERM "$broker_pid" 2>/dev/null || true
    [ -z "$main_pid" ] || wait "$main_pid" 2>/dev/null || true
    wait "$broker_pid" 2>/dev/null || true
    exit "$status"
}

trap 'terminate 129' HUP
trap 'terminate 130' INT
trap 'terminate 143' TERM

"$@" &
main_pid="$!"
set +e
wait "$main_pid"
main_status="$?"
set -e

kill -TERM "$broker_pid" 2>/dev/null || true
wait "$broker_pid" 2>/dev/null || true
exit "$main_status"
