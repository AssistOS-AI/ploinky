#!/bin/sh
set -eu

PROBE_TOKEN_PREFIX='PLOINKY_PROBE_TOKEN='
PROBE_CLEANUP_ATTEMPTS=40
PROBE_CLEANUP_INTERVAL_SECONDS='0.05'
PROBE_ACTIVE_PREFIX='active-'
PROBE_CANCEL_DIR='cancelled'
PROBE_TIMEOUT_DIR='timed-out'

fail() {
    printf '%s\n' "ploinky health probe runner: $*" >&2
    exit 125
}

require_plain_token() {
    case "${1:-}" in
        ''|*[!A-Za-z0-9._-]*) fail 'probe token is invalid' ;;
    esac
}

require_marker_path() {
    marker_path="${1:-}"
    token="${2:-}"
    [ "$marker_path" = "/tmp/.ploinky-health-probe-${token}" ] \
        || fail 'probe marker path is invalid'
}

require_positive_duration() {
    value="${1:-}"
    case "$value" in
        ''|*[!0-9.]*|.*|*.*.*|*.) fail 'probe duration is invalid' ;;
    esac
    case "$value" in
        *[1-9]*) ;;
        *) fail 'probe duration must be positive' ;;
    esac
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

collect_candidate_proc_pids() {
    session_id="$1"
    token="$2"
    collect_token_pids "$token"
    CANDIDATE_PROC_PIDS="$TOKEN_PIDS"
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

signal_matching_probe_processes() {
    signal="$1"
    session_id="$2"
    token="$3"
    signal_excluded_proc_ids="${4:-}"
    collect_matching_probe_identities "$session_id" "$token" "$signal_excluded_proc_ids"
    identities="$MATCHING_PROBE_IDENTITIES"
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

cleanup_probe_processes() {
    session_id="$1"
    token="$2"
    cleanup_excluded_proc_ids="${3:-}"

    collect_matching_probe_identities "$session_id" "$token" "$cleanup_excluded_proc_ids"
    [ -z "$MATCHING_PROBE_IDENTITIES" ] && return 0

    signal_matching_probe_processes TERM "$session_id" "$token" "$cleanup_excluded_proc_ids"
    sleep "$PROBE_CLEANUP_INTERVAL_SECONDS"
    signal_matching_probe_processes KILL "$session_id" "$token" "$cleanup_excluded_proc_ids"

    attempt=0
    while [ "$attempt" -lt "$PROBE_CLEANUP_ATTEMPTS" ]; do
        collect_matching_probe_identities "$session_id" "$token" "$cleanup_excluded_proc_ids"
        [ -z "$MATCHING_PROBE_IDENTITIES" ] && return 0
        sleep "$PROBE_CLEANUP_INTERVAL_SECONDS"
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
    marker_path="$1"
    [ -d "$marker_path/$PROBE_CANCEL_DIR" ]
}

request_probe_cancellation() {
    marker_path="$1"
    umask 077
    if mkdir "$marker_path" 2>/dev/null; then
        mkdir "$marker_path/$PROBE_CANCEL_DIR"
        return 0
    fi
    [ -d "$marker_path" ] || fail 'probe marker is not a directory'
    mkdir "$marker_path/$PROBE_CANCEL_DIR" 2>/dev/null \
        || [ -d "$marker_path/$PROBE_CANCEL_DIR" ] \
        || fail 'probe cancellation marker cannot be created'
}

session_run() {
    marker_path="$1"
    token="$2"
    script_name="$3"
    timeout_seconds="$4"
    kill_after_seconds="$5"

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
    if ! mkdir "$marker_path" 2>/dev/null; then
        if marker_is_cancelled "$marker_path"; then
            remove_marker_dir "$marker_path"
            exit 125
        fi
        fail 'probe marker already exists'
    fi
    trap 'remove_marker_dir "$marker_path"' EXIT
    trap 'exit 125' HUP INT TERM

    active_identity="$marker_path/$PROBE_ACTIVE_PREFIX$session_proc_pid-$start_time-$session_signal_pid-$token"
    mkdir "$active_identity" || fail 'probe identity marker cannot be created'
    if marker_is_cancelled "$marker_path"; then
        exit 125
    fi

    set +e
    cd /code || fail 'probe workspace /code is unavailable'
    sh "./${script_name}" &
    probe_pid="$!"
    (
        sleep "$timeout_seconds"
        mkdir "$marker_path/$PROBE_TIMEOUT_DIR" 2>/dev/null || true
        if proc_self_identity_fields; then
            watchdog_proc_pid="$PROC_PID"
            watchdog_excluded_proc_ids="$session_proc_pid:$watchdog_proc_pid"
            signal_matching_probe_processes \
                TERM "$session_proc_pid" "$token" "$watchdog_excluded_proc_ids"
            sleep "$kill_after_seconds"
            signal_matching_probe_processes \
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
    wait "$deadline_pid" 2>/dev/null || true
    set -e

    if [ -d "$marker_path/$PROBE_TIMEOUT_DIR" ]; then
        status=124
    elif [ "$status" -eq 125 ]; then
        status=126
    fi

    if ! cleanup_probe_processes \
        "$session_proc_pid" "$token" "$session_proc_pid"; then
        exit 125
    fi
    exit "$status"
}

cleanup_timed_out_session() {
    marker_path="$1"
    token="$2"
    session_id=0
    active_seen=false

    request_probe_cancellation "$marker_path"
    for active_path in "$marker_path"/"$PROBE_ACTIVE_PREFIX"*; do
        [ -d "$active_path" ] || continue
        active_seen=true
        identity="${active_path##*/}"
        identity="${identity#$PROBE_ACTIVE_PREFIX}"
        marker_proc_pid="${identity%%-*}"
        identity="${identity#*-}"
        marker_start="${identity%%-*}"
        identity="${identity#*-}"
        marker_signal_pid="${identity%%-*}"
        marker_token="${identity#*-}"
        case "$marker_proc_pid:$marker_start:$marker_signal_pid" in
            *[!0-9:]*|::*|*::|:*|*:) fail 'probe marker identity is invalid' ;;
        esac
        [ "$marker_token" = "$token" ] || fail 'probe marker token is inconsistent'
        if proc_identity_fields "$marker_proc_pid" \
            && [ "$PROC_START_TIME" = "$marker_start" ] \
            && [ "$PROC_SESSION_ID" = "$marker_proc_pid" ] \
            && [ "$PROC_NAMESPACE_PID" = "$marker_signal_pid" ]; then
            session_id="$marker_proc_pid"
        fi
        break
    done

    cleanup_probe_processes "$session_id" "$token" \
        || fail 'timed-out probe process cleanup failed'
    if [ "$active_seen" = true ]; then
        remove_marker_dir "$marker_path"
    fi
}

mode="${1:-}"
case "$mode" in
    run)
        [ "$#" -eq 6 ] || fail 'run requires marker, token, script, timeout, and kill-after'
        marker_path="$2"
        token="$3"
        script_name="$4"
        timeout_seconds="$5"
        kill_after_seconds="$6"
        require_plain_token "$token"
        require_marker_path "$marker_path" "$token"
        case "$script_name" in
            ''|*[!A-Za-z0-9._-]*|*..*) fail 'probe script name is invalid' ;;
        esac
        require_positive_duration "$timeout_seconds"
        require_positive_duration "$kill_after_seconds"
        for command_name in grep kill mkdir rmdir setsid sleep; do
            command -v "$command_name" >/dev/null 2>&1 \
                || fail "required probe command '$command_name' is unavailable"
        done
        set +e
        PLOINKY_PROBE_TOKEN="${token}:" PLOINKY_PROBE_SESSION=1 \
            setsid sh "$0" session-run \
            "$marker_path" "$token" "$script_name" \
            "$timeout_seconds" "$kill_after_seconds" &
        session_pid="$!"
        wait "$session_pid"
        status="$?"
        set -e
        exit "$status"
        ;;
    session-run)
        [ "$#" -eq 6 ] || fail 'session-run contract is invalid'
        session_run "$2" "$3" "$4" "$5" "$6"
        ;;
    cleanup)
        [ "$#" -eq 3 ] || fail 'cleanup requires marker and token'
        require_plain_token "$3"
        require_marker_path "$2" "$3"
        for command_name in grep kill mkdir rmdir sleep; do
            command -v "$command_name" >/dev/null 2>&1 \
                || fail "required cleanup command '$command_name' is unavailable"
        done
        proc_self_identity_fields \
            || fail 'cannot inspect cleanup namespace identity'
        cleanup_timed_out_session "$2" "$3"
        ;;
    *)
        fail "unsupported mode '${mode:-<missing>}'"
        ;;
esac
