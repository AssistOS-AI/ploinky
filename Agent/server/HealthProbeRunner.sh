#!/bin/sh
set -eu

PROBE_TOKEN_PREFIX='PLOINKY_PROBE_TOKEN='
PROBE_CLEANUP_ATTEMPTS=40
PROBE_CLEANUP_INTERVAL_SECONDS='0.05'
PROBE_ACTIVE_PREFIX='active-'
PROBE_CANCEL_DIR='cancelled'
PROBE_TIMEOUT_DIR='timed-out'
PROBE_CONTROL_ROOT='/run/ploinky-health-probes'
PROBE_OUTPUT_BLOCK_SIZE=4096
PROBE_OUTPUT_BLOCK_COUNT=256
PROBE_REQUEST_FILE='request'
PROBE_CLAIM_DIR='claimed'
PROBE_BROKER_READY_DIR='.broker-ready'
PROBE_BROKER_POLL_SECONDS='0.05'

fail() {
    printf '%s\n' "ploinky health probe runner: $*" >&2
    exit 125
}

require_plain_token() {
    case "${1:-}" in
        ''|*[!A-Za-z0-9._-]*) fail 'probe token is invalid' ;;
    esac
}

require_control_path() {
    control_path="${1:-}"
    token="${2:-}"
    [ "$control_path" = "${PROBE_CONTROL_ROOT}/${token}" ] \
        || fail 'probe control path is invalid'
}

positive_duration_is_valid() {
    value="${1:-}"
    case "$value" in
        ''|*[!0-9.]*|.*|*.*.*|*.) return 1 ;;
    esac
    case "$value" in
        *[1-9]*) return 0 ;;
        *) return 1 ;;
    esac
}

require_positive_duration() {
    positive_duration_is_valid "${1:-}" || fail 'probe duration is invalid'
}

proc_stat_path_fields() {
    stat_path="$1"
    IFS= read -r stat 2>/dev/null < "$stat_path" || return 1
    PROC_PID="${stat%% *}"
    fields="${stat##*) }"
    set -- $fields
    [ "$#" -ge 20 ] || return 1
    case "$PROC_PID" in
        ''|*[!0-9]*) return 1 ;;
    esac
    PROC_STATE="$1"
    PROC_SESSION_ID="$4"
    shift 19
    PROC_START_TIME="$1"
}

proc_stat_fields() {
    proc_stat_path_fields "/proc/$1/stat"
}

proc_namespace_pid_fields() {
    status_path="$1"
    requested_namespace_depth="${2:-0}"
    PROC_NAMESPACE_PID=''
    PROC_NAMESPACE_DEPTH=0
    while read -r status_key status_values; do
        [ "$status_key" = 'NSpid:' ] || continue
        set -- $status_values
        for namespace_pid in "$@"; do
            PROC_NAMESPACE_DEPTH=$((PROC_NAMESPACE_DEPTH + 1))
            if [ "$requested_namespace_depth" -eq 0 ] \
                || [ "$PROC_NAMESPACE_DEPTH" -eq "$requested_namespace_depth" ]; then
                PROC_NAMESPACE_PID="$namespace_pid"
            fi
        done
        break
    done 2>/dev/null < "$status_path" || return 1
    if [ "$requested_namespace_depth" -gt 0 ] \
        && [ "$PROC_NAMESPACE_DEPTH" -lt "$requested_namespace_depth" ]; then
        return 1
    fi
    case "$PROC_NAMESPACE_PID" in
        ''|*[!0-9]*) return 1 ;;
    esac
}

proc_identity_fields() {
    proc_identity_pid="$1"
    proc_stat_fields "$proc_identity_pid" || return 1
    proc_namespace_pid_fields \
        "/proc/$PROC_PID/status" "${CURRENT_NAMESPACE_DEPTH:-0}" || return 1
}

proc_self_identity_fields() {
    # Nested rootless Podman can expose a procfs mounted in an ancestor PID
    # namespace. The stat PID is therefore the stable /proc key while NSpid's
    # final field is the PID accepted by kill(1) in this container namespace.
    proc_stat_path_fields /proc/self/stat || return 1
    proc_namespace_pid_fields "/proc/$PROC_PID/status" || return 1
    CURRENT_NAMESPACE_DEPTH="$PROC_NAMESPACE_DEPTH"
}

collect_token_pids() {
    token="$1"
    TOKEN_PIDS=' '
    token_paths="$(
        grep -Fl "${PROBE_TOKEN_PREFIX}${token}:" /proc/[0-9]*/environ 2>/dev/null \
            || true
    )"
    for environ_path in $token_paths; do
        pid="${environ_path#/proc/}"
        pid="${pid%/environ}"
        case "$pid" in
            ''|*[!0-9]*) continue ;;
        esac
        TOKEN_PIDS="${TOKEN_PIDS}${pid} "
    done
}

process_has_collected_token() {
    pid="$1"
    case "$TOKEN_PIDS" in
        *" $pid "*) return 0 ;;
        *) return 1 ;;
    esac
}

append_candidate_proc_pid() {
    candidate_proc_pid="$1"
    case "$CANDIDATE_PROC_PIDS" in
        *" $candidate_proc_pid "*) return 0 ;;
    esac
    CANDIDATE_PROC_PIDS="${CANDIDATE_PROC_PIDS}${candidate_proc_pid} "
}

append_session_descendant_proc_pids() {
    session_id="$1"
    [ "$session_id" -gt 0 ] || return 0

    descendant_queue="$session_id"
    seen_parents=" $session_id "
    while [ -n "$descendant_queue" ]; do
        set -- $descendant_queue
        descendant_parent="$1"
        shift
        descendant_queue="$*"
        for children_path in "/proc/$descendant_parent"/task/[0-9]*/children; do
            [ -r "$children_path" ] || continue
            children=''
            IFS= read -r children 2>/dev/null < "$children_path" \
                || [ -n "$children" ] \
                || continue
            for child_proc_pid in $children; do
                case "$child_proc_pid" in
                    ''|*[!0-9]*) continue ;;
                esac
                append_candidate_proc_pid "$child_proc_pid"
                case "$seen_parents" in
                    *" $child_proc_pid "*) ;;
                    *)
                        seen_parents="${seen_parents}${child_proc_pid} "
                        if [ -n "$descendant_queue" ]; then
                            descendant_queue="$descendant_queue $child_proc_pid"
                        else
                            descendant_queue="$child_proc_pid"
                        fi
                        ;;
                esac
            done
        done
    done
}

collect_session_candidate_proc_pids() {
    session_id="$1"
    # Deadline and cancellation watchers are already inside the freshly
    # created probe session. Walk only that exact tree here; a whole-container
    # token scan is reserved for the final escaped-descendant proof.
    TOKEN_PIDS=' '
    CANDIDATE_PROC_PIDS=' '
    append_session_descendant_proc_pids "$session_id"
}

collect_candidate_proc_pids() {
    session_id="$1"
    token="$2"
    collect_token_pids "$token"
    CANDIDATE_PROC_PIDS="$TOKEN_PIDS"
    append_session_descendant_proc_pids "$session_id"
}

process_matches_probe() {
    proc_pid="$1"
    session_id="$2"
    proc_identity_fields "$proc_pid" || return 1
    if { [ "$session_id" -gt 0 ] && [ "$PROC_SESSION_ID" = "$session_id" ]; } \
        || process_has_collected_token "$proc_pid"; then
        MATCHED_SIGNAL_PID="$PROC_NAMESPACE_PID"
        MATCHED_PROC_PID="$PROC_PID"
        MATCHED_START_TIME="$PROC_START_TIME"
        return 0
    fi
    return 1
}

collect_matching_probe_identities() {
    session_id="$1"
    token="$2"
    collect_excluded_pattern=":${3:-}:"
    MATCHING_PROBE_IDENTITIES=''
    collect_candidate_proc_pids "$session_id" "$token"
    for proc_pid in $CANDIDATE_PROC_PIDS; do
        case "$collect_excluded_pattern" in
            *":$proc_pid:"*) continue ;;
        esac
        if process_matches_probe "$proc_pid" "$session_id"; then
            identity="${MATCHED_SIGNAL_PID}:${MATCHED_PROC_PID}:${MATCHED_START_TIME}"
            if [ -n "$MATCHING_PROBE_IDENTITIES" ]; then
                MATCHING_PROBE_IDENTITIES="$MATCHING_PROBE_IDENTITIES $identity"
            else
                MATCHING_PROBE_IDENTITIES="$identity"
            fi
        fi
    done
}

collect_matching_session_identities() {
    session_id="$1"
    token="$2"
    collect_excluded_pattern=":${3:-}:"
    MATCHING_PROBE_IDENTITIES=''
    collect_session_candidate_proc_pids "$session_id"
    for proc_pid in $CANDIDATE_PROC_PIDS; do
        case "$collect_excluded_pattern" in
            *":$proc_pid:"*) continue ;;
        esac
        if process_matches_probe "$proc_pid" "$session_id"; then
            identity="${MATCHED_SIGNAL_PID}:${MATCHED_PROC_PID}:${MATCHED_START_TIME}"
            if [ -n "$MATCHING_PROBE_IDENTITIES" ]; then
                MATCHING_PROBE_IDENTITIES="$MATCHING_PROBE_IDENTITIES $identity"
            else
                MATCHING_PROBE_IDENTITIES="$identity"
            fi
        fi
    done
}

signal_collected_probe_identities() {
    signal="$1"
    session_id="$2"
    identities="$3"
    for identity in $identities; do
        signal_pid="${identity%%:*}"
        identity_rest="${identity#*:}"
        proc_pid="${identity_rest%%:*}"
        expected_start="${identity_rest#*:}"
        if process_matches_probe "$proc_pid" "$session_id" \
            && [ "$MATCHED_SIGNAL_PID" = "$signal_pid" ] \
            && [ "$MATCHED_START_TIME" = "$expected_start" ]; then
            kill -s "$signal" "$signal_pid" 2>/dev/null || true
        fi
    done
}

signal_matching_session_processes() {
    signal="$1"
    session_id="$2"
    token="$3"
    signal_excluded_proc_ids="${4:-}"
    collect_matching_session_identities "$session_id" "$token" "$signal_excluded_proc_ids"
    identities="$MATCHING_PROBE_IDENTITIES"
    signal_collected_probe_identities "$signal" "$session_id" "$identities"
}

cleanup_probe_processes() {
    session_id="$1"
    token="$2"
    cleanup_excluded_proc_ids="${3:-}"

    collect_matching_probe_identities "$session_id" "$token" "$cleanup_excluded_proc_ids"
    [ -z "$MATCHING_PROBE_IDENTITIES" ] && return 0
    identities="$MATCHING_PROBE_IDENTITIES"

    # One whole-container token scan snapshots escaped descendants. Revalidate
    # the captured PID/start-time identities for both signals instead of
    # repeating that expensive scan before TERM and again before KILL.
    signal_collected_probe_identities TERM "$session_id" "$identities"
    sleep "$PROBE_CLEANUP_INTERVAL_SECONDS"
    signal_collected_probe_identities KILL "$session_id" "$identities"

    attempt=0
    while [ "$attempt" -lt "$PROBE_CLEANUP_ATTEMPTS" ]; do
        sleep "$PROBE_CLEANUP_INTERVAL_SECONDS"
        collect_matching_probe_identities "$session_id" "$token" "$cleanup_excluded_proc_ids"
        [ -z "$MATCHING_PROBE_IDENTITIES" ] && return 0
        identities="$MATCHING_PROBE_IDENTITIES"
        signal_collected_probe_identities KILL "$session_id" "$identities"
        attempt=$((attempt + 1))
    done

    collect_matching_probe_identities "$session_id" "$token" "$cleanup_excluded_proc_ids"
    printf '%s\n' \
        "ploinky health probe runner: exact probe descendants survived cleanup: ${MATCHING_PROBE_IDENTITIES:-unknown}" \
        >&2
    return 1
}

remove_marker_dir() {
    marker_path="$1"
    for marker_entry in \
        "$marker_path/$PROBE_CANCEL_DIR" \
        "$marker_path/$PROBE_TIMEOUT_DIR" \
        "$marker_path"/"$PROBE_ACTIVE_PREFIX"*; do
        [ -d "$marker_entry" ] || continue
        rmdir "$marker_entry" 2>/dev/null || true
    done
    rmdir "$marker_path" 2>/dev/null || true
}

marker_is_cancelled() {
    control_path="$1"
    [ -d "$control_path/$PROBE_CANCEL_DIR" ]
}

bounded_output_reader() {
    fifo_path="$1"
    output_path="$2"
    {
        dd bs="$PROBE_OUTPUT_BLOCK_SIZE" count="$PROBE_OUTPUT_BLOCK_COUNT" 2>/dev/null
        cat >/dev/null
    } < "$fifo_path" > "$output_path"
}

remove_session_artifacts() {
    marker_path="$1"
    stdout_fifo="$2"
    stderr_fifo="$3"
    rm -f "$stdout_fifo" "$stderr_fifo"
    remove_marker_dir "$marker_path"
}

session_run() {
    control_path="$1"
    token="$2"
    script_name="$3"
    timeout_seconds="$4"
    kill_after_seconds="$5"
    marker_path="$control_path/session"
    stdout_fifo="$control_path/stdout-fifo"
    stderr_fifo="$control_path/stderr-fifo"

    [ "${PLOINKY_PROBE_SESSION:-}" = 1 ] \
        || fail 'session runner requires exact setsid provenance'
    [ "${PLOINKY_PROBE_TOKEN:-}" = "${token}:" ] \
        || fail 'session runner requires its exact probe token'

    proc_self_identity_fields || fail 'cannot inspect probe session identity'
    session_proc_pid="$PROC_PID"
    session_signal_pid="$PROC_NAMESPACE_PID"
    [ "$session_signal_pid" = "$$" ] \
        || fail 'probe namespace identity is inconsistent'
    [ "$PROC_SESSION_ID" = "$session_proc_pid" ] \
        || fail 'probe session identity is inconsistent'
    start_time="$PROC_START_TIME"

    umask 077
    [ -d "$control_path" ] || fail 'probe control directory is unavailable'
    if ! mkdir "$marker_path" 2>/dev/null; then
        if marker_is_cancelled "$control_path"; then
            remove_marker_dir "$marker_path"
            exit 125
        fi
        fail 'probe marker already exists'
    fi
    trap 'remove_session_artifacts "$marker_path" "$stdout_fifo" "$stderr_fifo"' EXIT
    trap 'exit 125' HUP INT TERM

    active_identity="$marker_path/$PROBE_ACTIVE_PREFIX$session_proc_pid-$start_time-$session_signal_pid-$token"
    mkdir "$active_identity" || fail 'probe identity marker cannot be created'
    if marker_is_cancelled "$control_path"; then
        exit 125
    fi

    set +e
    cd /code || fail 'probe workspace /code is unavailable'
    if [ ! -f "./${script_name}" ]; then
        printf '%s\n' "ploinky health probe runner: ${script_name} not found in /code" >&2
        exit 127
    fi
    rm -f \
        "$control_path/probe-stdout" \
        "$control_path/probe-stderr" \
        "$stdout_fifo" \
        "$stderr_fifo"
    mkfifo "$stdout_fifo" "$stderr_fifo" || fail 'probe output pipes cannot be created'
    bounded_output_reader "$stdout_fifo" "$control_path/probe-stdout" &
    stdout_reader_pid="$!"
    bounded_output_reader "$stderr_fifo" "$control_path/probe-stderr" &
    stderr_reader_pid="$!"
    sh "./${script_name}" >"$stdout_fifo" 2>"$stderr_fifo" &
    probe_pid="$!"
    (
        while [ ! -d "$control_path/$PROBE_CANCEL_DIR" ]; do
            sleep "$PROBE_CLEANUP_INTERVAL_SECONDS"
        done
        if proc_self_identity_fields; then
            cancellation_proc_pid="$PROC_PID"
            cancellation_excluded_proc_ids="$session_proc_pid:$cancellation_proc_pid"
            signal_matching_session_processes \
                TERM "$session_proc_pid" "$token" "$cancellation_excluded_proc_ids"
            sleep "$kill_after_seconds"
            signal_matching_session_processes \
                KILL "$session_proc_pid" "$token" "$cancellation_excluded_proc_ids"
        fi
    ) &
    cancellation_pid="$!"
    (
        sleep "$timeout_seconds"
        mkdir "$marker_path/$PROBE_TIMEOUT_DIR" 2>/dev/null || true
        if proc_self_identity_fields; then
            watchdog_proc_pid="$PROC_PID"
            watchdog_excluded_proc_ids="$session_proc_pid:$watchdog_proc_pid"
            signal_matching_session_processes \
                TERM "$session_proc_pid" "$token" "$watchdog_excluded_proc_ids"
            sleep "$kill_after_seconds"
            signal_matching_session_processes \
                KILL "$session_proc_pid" "$token" "$watchdog_excluded_proc_ids"
        else
            # The session is exact and freshly created. If procfs cannot identify
            # the watchdog itself, fail closed by terminating that whole group.
            kill -s TERM "-$session_signal_pid" 2>/dev/null || true
            sleep "$kill_after_seconds"
            kill -s KILL "-$session_signal_pid" 2>/dev/null || true
        fi
    ) &
    deadline_pid="$!"
    wait "$probe_pid"
    status="$?"
    kill -s TERM "$deadline_pid" 2>/dev/null || true
    kill -s TERM "$cancellation_pid" 2>/dev/null || true
    wait "$deadline_pid" 2>/dev/null || true
    wait "$cancellation_pid" 2>/dev/null || true

    if ! cleanup_probe_processes \
        "$session_proc_pid" "$token" "$session_proc_pid"; then
        exit 125
    fi
    wait "$stdout_reader_pid" 2>/dev/null || true
    wait "$stderr_reader_pid" 2>/dev/null || true

    if marker_is_cancelled "$control_path"; then
        status=125
    elif [ -d "$marker_path/$PROBE_TIMEOUT_DIR" ]; then
        status=124
    elif [ "$status" -eq 125 ]; then
        status=126
    fi
    set -e
    exit "$status"
}

write_broker_failure() {
    control_path="$1"
    message="$2"
    [ -d "$control_path" ] || return 0
    printf '%s\n' "ploinky health probe broker: $message" \
        > "$control_path/runner-stderr"
    printf '%s\n' '125' > "$control_path/result-tmp"
    mv "$control_path/result-tmp" "$control_path/result"
}

run_broker_request() {
    control_path="$1"
    token="$2"
    request_path="$control_path/$PROBE_REQUEST_FILE"
    request_version=''
    request_token=''
    request_script=''
    request_timeout=''
    request_kill_after=''
    request_extra=''

    if ! {
        IFS= read -r request_version \
            && IFS= read -r request_token \
            && IFS= read -r request_script \
            && IFS= read -r request_timeout \
            && IFS= read -r request_kill_after
    } < "$request_path"; then
        write_broker_failure "$control_path" 'request is incomplete'
        return 0
    fi
    request_lines="$(wc -l < "$request_path" 2>/dev/null || printf '0')"
    [ "$request_lines" = '5' ] || {
        write_broker_failure "$control_path" 'request has an invalid field count'
        return 0
    }
    [ "$request_version" = 'ploinky-health-probe/1' ] || {
        write_broker_failure "$control_path" 'request version is invalid'
        return 0
    }
    require_plain_token "$token"
    [ "$request_token" = "$token" ] || {
        write_broker_failure "$control_path" 'request token is inconsistent'
        return 0
    }
    case "$request_script" in
        ''|*[!A-Za-z0-9._-]*|*..*)
            write_broker_failure "$control_path" 'request script is invalid'
            return 0
            ;;
    esac
    if ! positive_duration_is_valid "$request_timeout"; then
        write_broker_failure "$control_path" 'request timeout is invalid'
        return 0
    fi
    if ! positive_duration_is_valid "$request_kill_after"; then
        write_broker_failure "$control_path" 'request kill-after is invalid'
        return 0
    fi

    if ! sh "$0" run \
        "$control_path" "$token" "$request_script" \
        "$request_timeout" "$request_kill_after"; then
        [ -f "$control_path/result" ] \
            || write_broker_failure "$control_path" 'runner failed before publishing a result'
    fi
}

serve_broker() {
    [ "$#" -eq 1 ] || fail 'serve requires the exact control root'
    control_root="$1"
    [ "$control_root" = "$PROBE_CONTROL_ROOT" ] \
        || fail 'broker control root is invalid'
    [ -d "$control_root" ] || fail 'broker control root is unavailable'
    for command_name in mkdir mv rmdir sh sleep wc; do
        command -v "$command_name" >/dev/null 2>&1 \
            || fail "required broker command '$command_name' is unavailable"
    done

    ready_path="$control_root/$PROBE_BROKER_READY_DIR"
    rmdir "$ready_path" 2>/dev/null || true
    mkdir "$ready_path" || fail 'broker ready marker cannot be created'
    trap 'rmdir "$ready_path" 2>/dev/null || true; exit 0' HUP INT TERM
    trap 'rmdir "$ready_path" 2>/dev/null || true' EXIT

    while :; do
        for control_path in "$control_root"/*; do
            [ -d "$control_path" ] || continue
            [ ! -L "$control_path" ] || continue
            token="${control_path##*/}"
            case "$token" in
                ''|*[!A-Za-z0-9._-]*) continue ;;
            esac
            request_path="$control_path/$PROBE_REQUEST_FILE"
            [ -f "$request_path" ] || continue
            [ ! -L "$request_path" ] || continue
            mkdir "$control_path/$PROBE_CLAIM_DIR" 2>/dev/null || continue
            run_broker_request "$control_path" "$token"
        done
        sleep "$PROBE_BROKER_POLL_SECONDS"
    done
}

mode="${1:-}"
case "$mode" in
    serve)
        [ "$#" -eq 2 ] || fail 'serve requires the exact control root'
        serve_broker "$2"
        ;;
    run)
        [ "$#" -eq 6 ] || fail 'run requires control path, token, script, timeout, and kill-after'
        control_path="$2"
        token="$3"
        script_name="$4"
        timeout_seconds="$5"
        kill_after_seconds="$6"
        require_plain_token "$token"
        require_control_path "$control_path" "$token"
        case "$script_name" in
            ''|*[!A-Za-z0-9._-]*|*..*) fail 'probe script name is invalid' ;;
        esac
        require_positive_duration "$timeout_seconds"
        require_positive_duration "$kill_after_seconds"
        [ -d "$control_path" ] || fail 'probe control directory is unavailable'
        for command_name in cat dd grep kill mkdir mkfifo mv rm rmdir setsid sleep; do
            command -v "$command_name" >/dev/null 2>&1 \
                || fail "required probe command '$command_name' is unavailable"
        done
        rm -f \
            "$control_path/result" \
            "$control_path/result-tmp" \
            "$control_path/runner-stdout" \
            "$control_path/runner-stderr"
        set +e
        PLOINKY_PROBE_TOKEN="${token}:" PLOINKY_PROBE_SESSION=1 \
            setsid sh "$0" session-run \
            "$control_path" "$token" "$script_name" \
            "$timeout_seconds" "$kill_after_seconds" \
            >"$control_path/runner-stdout" \
            2>"$control_path/runner-stderr"
        status="$?"
        set -e
        printf '%s\n' "$status" > "$control_path/result-tmp"
        mv "$control_path/result-tmp" "$control_path/result"
        exit 0
        ;;
    session-run)
        [ "$#" -eq 6 ] || fail 'session-run contract is invalid'
        session_run "$2" "$3" "$4" "$5" "$6"
        ;;
    *)
        fail "unsupported mode '${mode:-<missing>}'"
        ;;
esac
