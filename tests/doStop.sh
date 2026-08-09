#!/bin/bash
set -euo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"

load_state
require_var "TEST_RUN_DIR"
require_var "TEST_AGENT_CONT_NAME"
require_var "TEST_AGENT_NAME"
require_var "TEST_REPO_NAME"
require_var "TEST_ENABLE_ALIAS_AGENT_NAME"

cd "$TEST_RUN_DIR"

# Enabling an agent starts its runtime, which synchronously attests the Router
# authority over the private health socket. `ploinky stop` kills the Router, so
# every Router-dependent enable must complete before the stop below.
ENABLE_ALIAS_AGENT_DEVEL_ALIAS="aliasDevel"
test_info "Enabling ${TEST_ENABLE_ALIAS_AGENT_NAME} in devel mode with alias ${ENABLE_ALIAS_AGENT_DEVEL_ALIAS} before Router shutdown."
ploinky enable agent "$TEST_ENABLE_ALIAS_AGENT_NAME" devel "$TEST_REPO_NAME" as "$ENABLE_ALIAS_AGENT_DEVEL_ALIAS"
write_state_var "TEST_ENABLE_ALIAS_AGENT_DEVEL_ALIAS" "$ENABLE_ALIAS_AGENT_DEVEL_ALIAS"
alias_devel_container=$(compute_container_name "$ENABLE_ALIAS_AGENT_DEVEL_ALIAS" "$TEST_REPO_NAME")
write_state_var "TEST_ENABLE_ALIAS_AGENT_DEVEL_CONTAINER" "$alias_devel_container"

test_info "Stopping workspace for ${TEST_AGENT_NAME}."
ploinky stop

wait_for_container_stop "$TEST_AGENT_CONT_NAME"

test_info "Stop procedure completed."
