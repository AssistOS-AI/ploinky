#!/bin/bash

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"

load_state
require_var "TEST_RUN_DIR"
require_var "TEST_AGENT_CONT_NAME"
require_var "TEST_AGENT_LOG"
require_var "TEST_PERSIST_MARKER"
require_var "TEST_ROUTER_LOG_SNAPSHOT"
require_var "TEST_ROUTER_PORT"
require_var "TEST_AGENT_TO_DISABLE_NAME"
require_var "TEST_AGENT_TO_DISABLE_CONT_NAME"
require_var "TEST_REPO_NAME"

require_runtime

disable_agent() {
    ( cd "$TEST_RUN_DIR" && ploinky disable agent "$TEST_AGENT_TO_DISABLE_NAME" )
  }

test_check "Destroy removed dependency cache" assert_file_not_exists "$TEST_RUN_DIR/.ploinky/deps"
test_check "Destroy preserved agent data" assert_dir_exists "$TEST_RUN_DIR/.data"

test_action "Action: Disabling agent ${TEST_AGENT_TO_DISABLE_NAME}" disable_agent

assert_agent_removed_from_registry() {
  local agent_name="$1"
  local repo_name="$2"
  local container_name
  if ! container_name=$(compute_container_name "$agent_name" "$repo_name"); then
    echo "Failed to compute container name for '${repo_name}/${agent_name}'." >&2
    return 1
  fi
  if grep -Fq "$container_name" "$TEST_RUN_DIR/.ploinky/agents.json"; then
    echo "Registry still contains container '${container_name}'." >&2
    return 1
  fi
}

test_check "${TEST_AGENT_TO_DISABLE_NAME} no longer in agents registry" assert_agent_removed_from_registry "$TEST_AGENT_TO_DISABLE_NAME" "$TEST_REPO_NAME"
test_check "Router log snapshot records shutdown" check_router_stop_entry "$TEST_ROUTER_LOG_SNAPSHOT" "$TEST_ROUTER_PORT" "TEST_ROUTER_DESTROY_LAST_ENTRY" "${TEST_ROUTER_STOP_LAST_ENTRY:-}"
test_check "RoutingServer process stopped" assert_routing_server_stopped
test_check "Test agent container removed" assert_container_absent "$TEST_AGENT_CONT_NAME"

# Move out of the workspace before deleting the directory.
cd "$TESTS_DIR"
rm -rf "$TEST_RUN_DIR"
test_info "Destroy procedure completed."

test_check "Temporary workspace directory deleted" assert_file_not_exists "$TEST_RUN_DIR"
test_check "Agent log removed with workspace" assert_file_not_exists "$TEST_AGENT_LOG"
test_check "Persistence marker removed with workspace" assert_file_not_exists "$TEST_PERSIST_MARKER"

finalize_checks
