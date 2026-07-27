#!/bin/bash

test_logs_tail_router() {
  load_state
  require_var "TEST_ROUTER_LOG" || return 1

  local router_log="$TEST_ROUTER_LOG"
  if [[ ! -f "$router_log" ]]; then
    echo "Router log file '${router_log}' not found." >&2
    return 1
  fi

  if [[ ! -s "$router_log" ]]; then
    echo "Router log file '${router_log}' is empty." >&2
    return 1
  fi

  local output=""
  local status=0
  output=$(timeout 2s "$PLOINKY_FAST_CLI" logs tail 2>&1) || status=$?

  if (( status != 0 && status != 124 )); then
    echo "'ploinky logs tail' failed with exit status ${status}." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  output=${output//$'\r'/}
  if [[ -z "${output//[[:space:]]/}" ]]; then
    echo "'ploinky logs tail' produced no log output." >&2
    return 1
  fi

  return 0
}

test_logs_last_five() {
  load_state
  require_var "TEST_ROUTER_LOG" || return 1

  local router_log="$TEST_ROUTER_LOG"
  if [[ ! -f "$router_log" ]]; then
    echo "Router log file '${router_log}' not found." >&2
    return 1
  fi

  if [[ ! -s "$router_log" ]]; then
    echo "Router log file '${router_log}' is empty." >&2
    return 1
  fi

  local output
  if ! output=$(ploinky logs last 5); then
    echo "'ploinky logs last 5' failed." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  output=${output//$'\r'/}
  local _log_lines=()
  local log_line
  while IFS= read -r log_line || [[ -n "$log_line" ]]; do
    _log_lines+=("$log_line")
  done <<<"$output"
  local line_count=${#_log_lines[@]}
  if (( line_count != 5 )); then
    echo "Expected 5 log lines, got ${line_count}." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  return 0
}
