check_preinstall_run() {
  load_state
  require_var "TEST_START_LOG"
  require_runtime

  local log_path="$TEST_START_LOG"

  # Retry up to 30s — the explorer's install hooks may still be running
  local attempts=30
  local i
  for (( i=0; i<attempts; i++ )); do
    # Primary check: look for lifecycle hook log entries in the start log.
    if [[ -f "$log_path" ]] && grep -Eq "(\[(preinstall|install)\] explorer:|Running preinstall hook for explorer)" "$log_path"; then
      return 0
    fi

    local explorer_root="${TEST_RUN_DIR}/.ploinky/repos/fileExplorer/explorer"
    if [[ -f "${explorer_root}/shared/vendor/axi-face/src/axi-face.mjs" \
       && -f "${explorer_root}/shared/vendor/axi-face/packs/index.json" ]]; then
      return 0
    fi

    # Also check the testAgent start log — the watchdog launched during the
    # first start may have created the explorer container there.
    local agent_log="${TEST_AGENT_START_LOG:-}"
    if [[ -n "$agent_log" && -f "$agent_log" ]] && grep -Eq "(\[(preinstall|install)\] explorer:|Running preinstall hook for explorer)" "$agent_log"; then
      return 0
    fi

    # Fallback: verify the install hook actually ran inside the container by
    # checking the container logs for output from the explorer's install.sh
    local explorer_container
    explorer_container=$(compute_container_name "explorer" "fileExplorer") || true
    if [[ -n "$explorer_container" ]]; then
      local container_logs=""
      if is_bwrap_agent "$explorer_container"; then
        local sandbox_log
        for sandbox_log in "$TEST_RUN_DIR/.ploinky/logs/explorer-bwrap.log" "$TEST_RUN_DIR/.ploinky/logs/explorer-seatbelt.log"; do
          [[ -f "$sandbox_log" ]] && break
        done
        container_logs=$(cat "$sandbox_log" 2>&1) || true
      else
        container_logs=$($FAST_CONTAINER_RUNTIME logs "$explorer_container" 2>&1) || true
      fi
      if echo "$container_logs" | grep -q "Installing explorer dependencies"; then
        return 0
      fi
    fi

    sleep 1
  done

  echo "No preinstall/install evidence for explorer found after ${attempts}s." >&2
  echo "Checked: start-demo.log, AxiFace vendored assets, testAgent_start_log, and container logs." >&2
  if [[ -f "$log_path" ]]; then
    echo "--- start log tail ---" >&2
    tail -n 40 "$log_path" >&2
    echo "----------------------" >&2
  fi
  return 1
}
