#!/bin/bash
set -euo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"

load_state
require_var "TEST_RUN_DIR"
require_var "TEST_AGENT_NAME"
require_var "TEST_ROUTER_PORT"
require_var "TEST_AGENT_CONT_NAME"
require_var "TEST_AGENT_WORKSPACE"
require_var "TEST_PERSIST_MARKER"

cd "$TEST_RUN_DIR"

mkdir -p "$TEST_RUN_DIR/.ploinky/logs"
start_log="$TEST_RUN_DIR/.ploinky/logs/start-demo.log"
: >"$start_log"
write_state_var "TEST_START_LOG" "$start_log"

test_agent_start_log="$TEST_RUN_DIR/.ploinky/logs/testAgent_start_log"
: >"$test_agent_start_log"
write_state_var "TEST_AGENT_START_LOG" "$test_agent_start_log"

if [[ $# -ge 2 ]]; then
  test_info "Starting workspace with specified agent $1 on port $2."
  ploinky start "$1" "$2" >>"$test_agent_start_log" 2>&1
else
  test_info "Starting workspace with saved configuration."
  ploinky start >>"$test_agent_start_log" 2>&1
fi

test_info "Workspace start output captured in $test_agent_start_log."

wait_for_router
wait_for_agent_log_message "$TEST_AGENT_LOG" "listening"

require_runtime
container_pid=$(get_container_pid "$TEST_AGENT_CONT_NAME")
write_state_var "TEST_LAST_KNOWN_PID" "$container_pid"
test_info "Container ${TEST_AGENT_CONT_NAME} is running (pid ${container_pid})."

routing_file="$TEST_RUN_DIR/.ploinky/routing.json"
wait_for_file "$routing_file" 40 0.25

agent_host_port="7000"
for _ in {1..10}; do
if agent_host_port=$(FAST_ROUTING_FILE="$routing_file" FAST_ROUTING_AGENT="$TEST_AGENT_NAME" node <<'NODE'
const fs = require('fs');

const routingPath = process.env.FAST_ROUTING_FILE;
const agentName = process.env.FAST_ROUTING_AGENT;

const raw = fs.readFileSync(routingPath, 'utf8');
const data = JSON.parse(raw || '{}');
const entry = (data.routes || {})[agentName] || {};
if (!entry.hostPort) {
  throw new Error('missing hostPort');
}
process.stdout.write(String(entry.hostPort));
NODE
); then
  if [[ -n "$agent_host_port" && "$agent_host_port" != "0" ]]; then
    break
  fi
fi
sleep 0.2
done

if [[ -z "$agent_host_port" || "$agent_host_port" == "0" ]]; then
  agent_host_port="7000"
fi

write_state_var "TEST_AGENT_HOST_PORT" "$agent_host_port"
write_state_var "TEST_AGENT_HEALTH_URL" "http://127.0.0.1:${agent_host_port}/health"
write_state_var "TEST_ROUTER_LOG" "$TEST_RUN_DIR/.ploinky/logs/router.log"
test_info "Agent host port resolved to ${agent_host_port}."

persist_marker="$TEST_PERSIST_MARKER"
if [[ ! -f "$persist_marker" ]]; then
  echo "first-run" >"$persist_marker"
fi

fast_mcp_start_demo() {
  ploinky start demo "$TEST_ROUTER_PORT" >>"$start_log" 2>&1
  local container_name
  container_name=$(compute_container_name "demo" "demo")
  wait_for_container "$container_name"
}

test_action "Action: Starting demo agent..." fast_mcp_start_demo

if ! wait_for_router; then
  test_info "Router failed to respond. start-demo.log contents:"
  cat "$start_log" >&2
  test_info "Watchdog log contents:"
  cat "$TEST_RUN_DIR/.ploinky/logs/watchdog.log" >&2 2>/dev/null || true
  test_info "Router log contents:"
  cat "$TEST_RUN_DIR/.ploinky/logs/router.log" >&2 2>/dev/null || true
  test_info "Running containers:"
  docker ps -a 2>/dev/null || podman ps -a 2>/dev/null || true
  exit 1
fi

ls -la "$TEST_RUN_DIR/.ploinky/bwrap-pids/" 2>/dev/null || true

test_info "Start procedure completed."
