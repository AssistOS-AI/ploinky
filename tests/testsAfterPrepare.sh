#!/bin/bash

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"
source "$TESTS_DIR/test-functions/workspace_dependency_startup_tests.sh"

load_state
require_var "TEST_RUN_DIR"
require_var "TEST_AGENT_WORKSPACE"

cd "$TEST_RUN_DIR"

test_check "Temporary workspace directory exists" assert_dir_exists "$TEST_RUN_DIR"
test_check "Repository directory created" assert_dir_exists "$TEST_RUN_DIR/.ploinky/repos/$TEST_REPO_NAME"
test_check "Agent manifest present" assert_file_exists "$TEST_RUN_DIR/.ploinky/repos/$TEST_REPO_NAME/$TEST_AGENT_NAME/manifest.json"
test_check "Agent registration waits for Router startup" assert_agent_not_registered
test_check "Repository enabled flag recorded" assert_enabled_repo
test_check "Isolated agent workspace created" assert_dir_exists "$TEST_AGENT_WORKSPACE"

stage_header "Workspace Dependency Startup"
test_check "Recursive dependency graph waits wave-by-wave before starting dependents" fast_test_recursive_dependency_graph_startup
test_check "Dependency readiness.protocol override applies to dependency startup gating" fast_test_dependency_readiness_protocol_override
test_check "Static start-only TCP service becomes ready without MCP probing" fast_test_static_start_only_tcp_readiness
test_check "Broken dependency leaves the generation inactive and static agent unstarted" fast_test_dependency_failure_blocks_router_startup
test_check "Startup config provider preflight persists values before static start" fast_test_startup_config_provider_preflight

finalize_checks
