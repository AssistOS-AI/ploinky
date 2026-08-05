#!/bin/bash
set -euo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"

load_state
require_var "TEST_RUN_DIR"
require_var "TEST_AGENT_NAME"
require_var "TEST_AGENT_CONT_NAME"
require_var "TEST_ROUTER_PORT"

cd "$TEST_RUN_DIR"

require_runtime
pre_pid=$(get_container_pid "$TEST_AGENT_CONT_NAME" || echo "")
write_state_var "TEST_PRE_RESTART_PID" "$pre_pid"
test_info "Restarting workspace (pre-restart pid: ${pre_pid:-unknown})."

mkdir -p "$TEST_RUN_DIR/.ploinky/logs"
restart_log="$TEST_RUN_DIR/.ploinky/logs/restart.log"
: >"$restart_log"
write_state_var "TEST_RESTART_LOG" "$restart_log"

if ! ploinky restart >>"$restart_log" 2>&1; then
  cat "$restart_log" >&2
  exit 1
fi

wait_for_router
wait_for_agent_log_message "$TEST_AGENT_LOG" "listening"

post_pid=$(get_container_pid "$TEST_AGENT_CONT_NAME")
write_state_var "TEST_POST_RESTART_PID" "$post_pid"
write_state_var "TEST_LAST_KNOWN_PID" "$post_pid"
test_info "Restart complete (post-restart pid: ${post_pid})."

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
