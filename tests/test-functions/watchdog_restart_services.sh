watchdog_restart_services() {
  load_state
  require_var "TEST_AGENT_CONT_NAME" || return 1
  require_var "TEST_ROUTER_PORT" || return 1
  require_var "TEST_RUN_DIR" || return 1

  require_runtime || return 1

  if ! wait_for_container "$TEST_AGENT_CONT_NAME"; then
    echo "Container '${TEST_AGENT_CONT_NAME}' is not running before watchdog test." >&2
    return 1
  fi

  local original_container_pid
  original_container_pid=$(get_container_pid "$TEST_AGENT_CONT_NAME" 2>/dev/null || true)

  # Get the Watchdog PID from the pid file
  local watchdog_pid_file="$TEST_RUN_DIR/.ploinky/running/router.pid"
  local watchdog_pid=""
  if [[ -f "$watchdog_pid_file" ]]; then
    watchdog_pid=$(cat "$watchdog_pid_file" 2>/dev/null)
    test_info "Watchdog PID from file: ${watchdog_pid}"
    if kill -0 "$watchdog_pid" 2>/dev/null; then
      test_info "Watchdog (PID ${watchdog_pid}) is running."
    else
      echo "WARNING: Watchdog (PID ${watchdog_pid}) is NOT running!" >&2
    fi
  else
    echo "WARNING: Watchdog PID file not found at $watchdog_pid_file" >&2
  fi

  local router_pid
  router_pid=$(lsof -nP -t -iTCP:"$TEST_ROUTER_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)

  if [[ -z "$router_pid" ]]; then
    echo "Unable to determine RoutingServer PID for port ${TEST_ROUTER_PORT}." >&2
    return 1
  fi

  test_info "Sending SIGKILL to RoutingServer (PID: ${router_pid})."

  if ! kill -9 "$router_pid" 2>/dev/null; then
    echo "Failed to send SIGKILL to RoutingServer PID ${router_pid}." >&2
    return 1
  fi

  test_info "Sending SIGKILL to agent container ${TEST_AGENT_CONT_NAME}."
  if is_bwrap_agent "$TEST_AGENT_CONT_NAME"; then
    local agent_name
    agent_name=$(resolve_agent_name_from_container "$TEST_AGENT_CONT_NAME")
    local pid
    pid=$(cat "$TEST_RUN_DIR/.ploinky/bwrap-pids/${agent_name}.pid")
    # Kill the entire process group (bwrap + sandboxed children) so the
    # port is freed and the watchdog can restart cleanly.
    if ! kill -9 -- -"$pid" 2>/dev/null; then
      # Fallback: kill just the PID if process group kill fails
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    if ! $FAST_CONTAINER_RUNTIME kill --signal SIGKILL "$TEST_AGENT_CONT_NAME" >/dev/null 2>&1; then
      echo "Failed to send SIGKILL to container '${TEST_AGENT_CONT_NAME}'." >&2
      return 1
    fi
  fi

  test_info "Waiting for watchdog to restore services."

  # Check if Watchdog is still running after killing the RoutingServer
  sleep 1
  if [[ -n "$watchdog_pid" ]]; then
    if kill -0 "$watchdog_pid" 2>/dev/null; then
      test_info "Watchdog (PID ${watchdog_pid}) is still running after RoutingServer kill."
    else
      echo "ERROR: Watchdog (PID ${watchdog_pid}) has EXITED after RoutingServer kill!" >&2
      echo "This means the Watchdog is not restarting the RoutingServer." >&2
    fi
  fi

  # Wait for the router to come back up (up to 60 seconds)
  if ! wait_for_router; then
    echo "Router did not restart within expected time after SIGKILL." >&2
    # Extra debug: check Watchdog status again
    if [[ -n "$watchdog_pid" ]]; then
      if kill -0 "$watchdog_pid" 2>/dev/null; then
        echo "DEBUG: Watchdog is still running but router didn't restart." >&2
      else
        echo "DEBUG: Watchdog has exited." >&2
      fi
    fi
    return 1
  fi

  local new_router_pid
  new_router_pid=$(lsof -nP -t -iTCP:"$TEST_ROUTER_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1)
  if [[ -z "$new_router_pid" ]]; then
    echo "Unable to determine RoutingServer PID after watchdog restart." >&2
    return 1
  fi

  if [[ "$new_router_pid" == "$router_pid" ]]; then
    echo "RoutingServer PID did not change after watchdog restart." >&2
    return 1
  fi

  if ! wait_for_container "$TEST_AGENT_CONT_NAME"; then
    echo "Watchdog did not restart container '${TEST_AGENT_CONT_NAME}' within expected time." >&2
    return 1
  fi

  if ! assert_container_running "$TEST_AGENT_CONT_NAME"; then
    echo "Container '${TEST_AGENT_CONT_NAME}' not running after watchdog restart." >&2
    return 1
  fi

  local restarted_pid
  restarted_pid=$(get_container_pid "$TEST_AGENT_CONT_NAME" 2>/dev/null || true)

  if [[ -z "$restarted_pid" || "$restarted_pid" == "0" ]]; then
    echo "Container PID not reported after watchdog restart." >&2
    return 1
  fi

  if [[ -n "$original_container_pid" && "$original_container_pid" != "0" && "$original_container_pid" == "$restarted_pid" ]]; then
    echo "Container PID did not change after watchdog restart." >&2
    return 1
  fi

  if ! assert_router_status_ok; then
    echo "Router status check failed after watchdog restart." >&2
    return 1
  fi

  return 0
}
