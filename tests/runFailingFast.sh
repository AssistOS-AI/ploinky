#!/bin/bash
# runFailingFast.sh — targeted re-runner for the test_all.sh failures
#
# Builds a single fresh workspace via doPrepare.sh + doStart.sh, then executes
# only the test functions that were failing in lastRun.results. Skips the
# stop/startAgain/restart/destroy stages and the node unit tests so iterations
# complete in ~5 minutes instead of ~15.
#
# Usage:
#   bash tests/runFailingFast.sh
#
# Honors:
#   PLOINKY_BRANCH (forwarded to test_all.sh's worktree logic — not used here)
#   FAST_VERIFY_TIMEOUT (caps each test_check at this many seconds; default 60)

set -uo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLOINKY_REPO_ROOT=$(cd -- "$TESTS_DIR/.." && pwd)

# Initialize the same state plumbing test_all.sh uses, so lib.sh helpers and
# the existing prepare/start scripts work without modification.
FAST_STATE_FILE=$(mktemp -t fast-suite-state.XXXXXX)
export FAST_STATE_FILE
FAST_RESULTS_FILE="$TESTS_DIR/lastRun.failingFast.results"
export FAST_RESULTS_FILE

cleanup() {
  if command -v ploinky >/dev/null 2>&1; then
    ploinky destroy >/dev/null 2>&1 || true
  fi
  if [[ -n "${TEST_RUN_DIR:-}" && -d "$TEST_RUN_DIR" ]]; then
    rm -rf "$TEST_RUN_DIR"
  fi
  rm -f "$FAST_STATE_FILE"
}
trap cleanup EXIT

source "$TESTS_DIR/lib.sh"
init_results

# ---- Stage: Prepare workspace ----
stage_header "PREPARE STAGE"
bash "$TESTS_DIR/doPrepare.sh"
load_state
require_var "TEST_RUN_DIR"
require_var "TEST_AGENT_NAME"
require_var "TEST_ROUTER_PORT"
cd "$TEST_RUN_DIR"

# ---- Stage: Start workspace + demo ----
stage_header "START STAGE"
bash "$TESTS_DIR/doStart.sh" "$TEST_AGENT_NAME" "$TEST_ROUTER_PORT"
load_state

# ---- Source only the test-function modules we need ----
source "$TESTS_DIR/test-functions/check_preinstall_run.sh"
source "$TESTS_DIR/test-functions/routingserver_aggregation_test.sh"
source "$TESTS_DIR/test-functions/router_static_assets.sh"
source "$TESTS_DIR/test-functions/volume_mount_tests.sh"
source "$TESTS_DIR/test-functions/workspace_dependency_startup_tests.sh"
source "$TESTS_DIR/test-functions/install_command_verification.sh"
source "$TESTS_DIR/test-functions/agent_blob_upload_and_download.sh"
source "$TESTS_DIR/test-functions/demo_agent_dir_perm.sh"
source "$TESTS_DIR/test-functions/global_agent_verification.sh"
source "$TESTS_DIR/test-functions/devel_agent_verification.sh"
source "$TESTS_DIR/test-functions/manifest_ports_test.sh"
source "$TESTS_DIR/test-functions/mcp_tests.sh"
source "$TESTS_DIR/test-functions/disable_repo_test.sh"
source "$TESTS_DIR/test-functions/logs_commands.sh"
source "$TESTS_DIR/test-functions/llm_cli_suggestions.sh"
source "$TESTS_DIR/test-functions/webchat_tests.sh"
source "$TESTS_DIR/test-functions/test_sso_params.sh"

# Re-resolve dependency-test container names like testsAfterStart.sh does.
SIMULATOR_CONTAINER=$(compute_container_name "simulator" "demo")
EXPLORER_CONTAINER=$(compute_container_name "explorer" "fileExplorer")
MODERATOR_CONTAINER=$(compute_container_name "moderator" "webmeet")
test_start_result_file="$TEST_AGENT_WORKSPACE/start-result"

FAST_CHECK_ERRORS=0

# ---- Failures observed in lastRun.results from the most recent test_all.sh run ----
stage_header "Demo dependency cascade"
test_check "Moderator container is running" assert_container_running "$MODERATOR_CONTAINER"
test_check "Explorer preinstall command executed" check_preinstall_run

stage_header "Routing aggregation"
test_check "Aggregation check: router server mcp aggregation" fast_mcp_list_tools_after_demo

stage_header "Router & manifest"
test_check "Router serves configured static asset" fast_assert_router_static_asset
test_check "Custom volume mount exposes marker" fast_assert_volume_mount
test_check "Manifest defined ports map correctly" fast_assert_manifest_ports

stage_header "Workspace dependency startup"
test_check "Recursive dependency graph waits wave-by-wave before starting dependents" \
  fast_test_recursive_dependency_graph_startup
test_check "Dependency readiness.protocol override applies to dependency startup gating" \
  fast_test_dependency_readiness_protocol_override

stage_header "Start command artifacts"
test_check "Start command creates start-result file" assert_file_exists "$test_start_result_file"
test_check "Start command writes expected content" assert_file_contains "$test_start_result_file" "started without shell"
test_check "Install command creates marker file (verified via shell)" fast_check_install_marker_via_shell

stage_header "Agent blob upload/download"
test_check "Router upload stores blob in agent workspace" fast_check_agent_blob_upload
test_check "Router download returns uploaded blob" fast_check_agent_blob_download

stage_header "Demo agent filesystem"
test_check "Demo agent directories exist and are read-only" fast_check_demo_agent_readonly_dirs

stage_header "Global agent verification"
test_check "Global agent working directory is the test root" fast_assert_global_agent_workdir "TEST_GLOBAL_AGENT_NAME"
test_check "Manifest dependency global agent uses workspace root" fast_assert_global_agent_workdir "TEST_AGENT_DEP_GLOBAL_NAME"

stage_header "Devel agent verification"
test_check "Devel agent cwd is the repo source and has RW permissions" fast_assert_devel_agent_workdir "TEST_DEVEL_AGENT_NAME"
test_check "Manifest dependency devel agent uses repo root" fast_assert_devel_agent_workdir "TEST_AGENT_DEP_DEVEL_NAME"

stage_header "MCP async + disable + logs + LLM"
test_check "cli tool demo_async_task completes successfully" fast_mcp_demo_async_task
test_check "disable repo removes demo entry" test_disable_repo_demo_updates_enabled_list
test_check "logs tail router streams entries" test_logs_tail_router
test_check "Invalid CLI input yields LLM suggestion and system command output" test_llm_cli_suggestions
test_check "psh surfaces LLM suggestion for freeform input" test_psh_llm_suggestions

stage_header "WebChat (1st pass — passed in full suite)"
test_check "WebChat agent override responds via curl" fast_check_webchat_alias_override
test_check "WebChat legacy token auth endpoint is disabled" fast_check_webchat_logout_flow

stage_header "WebChat SSO Parameters"
test_action "Configure WebChat CLI for test agent" configure_webchat_cli_for_test_agent
wait_for_router
test_check "Legacy WebChat token-based SSO harness is skipped" test_sso_params_disabled

# ---- Final summary ----
stage_header "TEST SUMMARY"
if (( FAST_CHECK_ERRORS == 0 )); then
  pass_message "All targeted tests passed."
  log_result "[PASS] All targeted tests passed."
  exit 0
else
  fail_message "Targeted run finished with ${FAST_CHECK_ERRORS} failure(s)."
  log_result "[FAIL] Targeted run finished with ${FAST_CHECK_ERRORS} failure(s)."
  echo "Full report: $FAST_RESULTS_FILE"
  grep -i "\[FAIL\]\|\[FATAL\]" "$FAST_RESULTS_FILE"
  exit 1
fi
