#!/bin/bash

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"
source "$TESTS_DIR/test-functions/dynamic_configuration_tests.sh"
source "$TESTS_DIR/test-functions/health_probes_negative.sh"
source "$TESTS_DIR/test-functions/devel_agent_verification.sh"

load_state
require_var "TEST_HEALTH_AGENT_CONT_NAME"
require_var "TEST_HEALTH_AGENT_NAME"
require_var "TEST_ENABLE_ALIAS_AGENT_DEVEL_ALIAS"
cd "$TEST_RUN_DIR"

stage_header "Devel Alias Agent Verification"
# Sandbox alias+devel mode combination has a registration issue (ploinky shell can't find it)
if ! is_sandbox_runtime; then
  test_check "Alias devel agent uses repo workspace" fast_assert_devel_agent_workdir "TEST_ENABLE_ALIAS_AGENT_DEVEL_ALIAS"
fi

stage_header "Health Probes Failure Verification"
# Health probe scripts use 'docker exec' which is not available for sandbox agents
if ! is_sandbox_runtime; then
  test_check "Health probes retry and fail as expected" health_probes_wait_for_failure_logs
fi
test_info "Switching probes back to success"
test_check "Health probe scripts restored to success" health_probes_force_success

stage_header "Tests after start"
# Reuse the primary start verification suite.
bash "$TESTS_DIR/testsAfterStart.sh"
rerun_exit=$?
FAST_CHECK_ERRORS=$(($FAST_CHECK_ERRORS + rerun_exit))

load_state
require_var "TEST_PERSIST_MARKER"
require_var "TEST_PERSIST_FILE"

stage_header "Tests after Start Again"
test_check "Persistence marker survived restart" assert_file_content_equals "$TEST_PERSIST_MARKER" "first-run"
test_check "Agent data file still present after restart" assert_file_exists "$TEST_PERSIST_FILE"
test_check "Agent data file retains initialization signature" assert_file_contains "$TEST_PERSIST_FILE" "initialized"

# Dynamic configuration tests (no restart needed)
test_info "Testing dynamic env variable propagation (no restart)"

test_check "Dynamic APP_NAME update without restart" fast_test_dynamic_app_name
test_check "Dynamic SSO_CLIENT_SECRET update without restart" fast_test_sso_client_secret_propagation

stage_header "Manifest Environment"
test_check "Variable MY_TEST_VAR from manifest is present after start again" assert_container_env "$TEST_AGENT_CONT_NAME" "MY_TEST_VAR" "hello-manifest"

finalize_checks
