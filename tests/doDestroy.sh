#!/bin/bash
set -euo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"

load_state
require_var "TEST_RUN_DIR"
require_var "TEST_AGENT_NAME"
require_var "TEST_ROUTER_LOG"

cd "$TEST_RUN_DIR"

test_info "Destroying workspace for ${TEST_AGENT_NAME}."
if ! PLOINKY_ROUTER_HEALTH_SOCKET="${PLOINKY_ROUTER_HEALTH_SOCKET:-${TEST_ROUTER_HEALTH_SOCKET:-}}" \
    timeout 60s "$PLOINKY_FAST_CLI" destroy; then
    fail_message "ploinky destroy command failed or timed out after 60 seconds."
fi

router_log_snapshot=""
if [[ -f "$TEST_ROUTER_LOG" ]]; then
    router_log_snapshot=$(mktemp "${TMPDIR:-/tmp}/fast-router-log-XXXXXX")
    if ! cp "$TEST_ROUTER_LOG" "$router_log_snapshot" 2>/dev/null; then
        router_log_snapshot=""
    fi
fi
write_state_var "TEST_ROUTER_LOG_SNAPSHOT" "$router_log_snapshot"
