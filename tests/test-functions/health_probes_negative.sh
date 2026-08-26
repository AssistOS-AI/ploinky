TESTS_SUBDIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=tests/lib.sh
source "$TESTS_SUBDIR/../lib.sh"

health_probes_force_failure() {
  load_state
  require_var "TEST_HEALTH_AGENT_REPO_PATH"
  local probe_dir="$TEST_HEALTH_AGENT_REPO_PATH"

  if [[ ! -d "$probe_dir" ]]; then
    echo "Health probe agent directory '$probe_dir' not found." >&2
    return 1
  fi

cat >"${probe_dir}/liveness_probe.sh" <<'EOF'
#!/bin/sh
echo not live
exit 1
EOF

cat >"${probe_dir}/readiness_probe.sh" <<'EOF'
#!/bin/sh
echo not ready
exit 1
EOF

  chmod +x "${probe_dir}/liveness_probe.sh" "${probe_dir}/readiness_probe.sh"
}

health_probes_write_success_scripts() {
  load_state
  require_var "TEST_HEALTH_AGENT_REPO_PATH"
  local probe_dir="$TEST_HEALTH_AGENT_REPO_PATH"

  if [[ ! -d "$probe_dir" ]]; then
    echo "Health probe agent directory '$probe_dir' not found." >&2
    return 1
  fi

cat >"${probe_dir}/liveness_probe.sh" <<'EOF'
#!/bin/sh
echo live
exit 0
EOF

cat >"${probe_dir}/readiness_probe.sh" <<'EOF'
#!/bin/sh
echo ready
exit 0
EOF

  chmod +x "${probe_dir}/liveness_probe.sh" "${probe_dir}/readiness_probe.sh"
}

health_probes_force_success() {
  health_probes_write_success_scripts || return 1
  load_state
  require_var "TEST_HEALTH_AGENT_NAME"
  require_var "TEST_REPO_NAME"
  require_var "TEST_HEALTH_AGENT_CONT_NAME"
  local qualified="${TEST_REPO_NAME}/${TEST_HEALTH_AGENT_NAME}"
  ploinky reinstall "$qualified"
  wait_for_container "$TEST_HEALTH_AGENT_CONT_NAME" 20
}

health_probe_watchdog_event_count() {
  local log_file="$1"
  local event="$2"
  local container="$3"
  local reason="${4:-}"
  local error_fragment="${5:-}"

  jq -Rr \
    --arg event "$event" \
    --arg container "$container" \
    --arg reason "$reason" \
    --arg error_fragment "$error_fragment" \
    'fromjson?
      | select(.event == $event and .container == $container)
      | select($reason == "" or ((.reason // "") == $reason))
      | select($error_fragment == "" or ((.error // "") | contains($error_fragment)))
      | 1' \
    "$log_file" 2>/dev/null \
    | awk '{ count += $1 } END { print count + 0 }'
}

health_probes_wait_for_failure_logs() {
  load_state
  require_var "TEST_RUN_DIR"
  require_var "TEST_HEALTH_AGENT_CONT_NAME"
  local baseline_failures="${1:-0}"
  local baseline_restarts="${2:-0}"

  local log_file="$TEST_RUN_DIR/.ploinky/logs/watchdog.log"
  if [[ ! -f "$log_file" ]]; then
    echo "Log file '$log_file' not found." >&2
    return 1
  fi

  local attempts=120
  local i
  for (( i=0; i<attempts; i++ )); do
    local current_failures
    current_failures=$(health_probe_watchdog_event_count \
      "$log_file" \
      "container_probe_failed" \
      "$TEST_HEALTH_AGENT_CONT_NAME" \
      "" \
      "liveness probe failed")
    local current_restarts
    current_restarts=$(health_probe_watchdog_event_count \
      "$log_file" \
      "container_scheduling_restart" \
      "$TEST_HEALTH_AGENT_CONT_NAME" \
      "semantic_probe_failed")
    if (( current_failures > baseline_failures && current_restarts > baseline_restarts )); then
      return 0
    fi
    sleep 0.5
  done

  echo "Did not find a new liveness failure and managed restart in '$log_file'." >&2
  tail -n 40 "$log_file" >&2
  return 1
}

health_probes_wait_for_edge_recovery() {
  load_state
  require_var "TEST_HEALTH_AGENT_CONT_NAME" || return 1
  require_var "TEST_ROUTER_PORT" || return 1

  wait_for_container "$TEST_HEALTH_AGENT_CONT_NAME" || return 1

  local attempts=240
  local i
  for (( i=0; i<attempts; i++ )); do
    local status
    status=$(curl -sS -o /dev/null -w '%{http_code}' \
      "http://127.0.0.1:${TEST_ROUTER_PORT}/status" 2>/dev/null || true)
    if [[ "$status" == "200" ]]; then
      return 0
    fi
    sleep 0.5
  done

  echo "Router edge generation did not reactivate after health probe recovery." >&2
  return 1
}

health_probes_assert_edge_inactive() {
  load_state
  require_var "TEST_ROUTER_PORT" || return 1

  local attempts=40
  local i
  for (( i=0; i<attempts; i++ )); do
    local body_file
    body_file=$(mktemp -t ploinky-edge-inactive.XXXXXX)
    local status
    status=$(curl -sS -o "$body_file" -w '%{http_code}' \
      "http://127.0.0.1:${TEST_ROUTER_PORT}/status" 2>/dev/null || true)
    if [[ "$status" == "503" ]] && grep -q 'EDGE_GENERATION_INACTIVE' "$body_file"; then
      rm -f "$body_file"
      return 0
    fi
    rm -f "$body_file"
    sleep 0.25
  done

  echo "Failed health probe did not inactivate Router authorization." >&2
  return 1
}

health_probes_fail_closed_and_recovers() {
  load_state
  require_var "TEST_RUN_DIR" || return 1
  require_var "TEST_HEALTH_AGENT_CONT_NAME" || return 1

  local log_file="$TEST_RUN_DIR/.ploinky/logs/watchdog.log"
  if [[ ! -f "$log_file" ]]; then
    echo "Log file '$log_file' not found." >&2
    return 1
  fi
  local baseline_failures
  baseline_failures=$(health_probe_watchdog_event_count \
    "$log_file" \
    "container_probe_failed" \
    "$TEST_HEALTH_AGENT_CONT_NAME" \
    "" \
    "liveness probe failed")
  local baseline_restarts
  baseline_restarts=$(health_probe_watchdog_event_count \
    "$log_file" \
    "container_scheduling_restart" \
    "$TEST_HEALTH_AGENT_CONT_NAME" \
    "semantic_probe_failed")

  health_probes_force_failure || return 1
  if ! health_probes_wait_for_failure_logs "$baseline_failures" "$baseline_restarts"; then
    health_probes_write_success_scripts || true
    return 1
  fi
  if ! health_probes_assert_edge_inactive; then
    health_probes_write_success_scripts || true
    return 1
  fi

  # Restore the trusted probe source before the scheduled managed replacement
  # reaches semantic readiness. The watchdog must then reactivate the exact
  # generation without an unrelated CLI mutation racing its preparation.
  health_probes_write_success_scripts || return 1
  health_probes_wait_for_edge_recovery
}
