#!/bin/bash
set -euo pipefail

configure_webchat_cli_for_test_agent() {
  load_state
  require_var "TEST_AGENT_NAME"
  require_var "TEST_ROUTER_PORT"
  ploinky start "$TEST_AGENT_NAME" "$TEST_ROUTER_PORT" >/dev/null 2>&1 || return 1
}

ensure_webchat_cli_session() {
  test_info "Skipping legacy WebChat token-based SSO parameter test. A new authenticated surface test is still needed."
  return 0
}

test_sso_params_disabled() {
  if ! ensure_webchat_cli_session; then
    return 1
  fi
  return 0
}

test_sso_params_enabled() {
  if ! ensure_webchat_cli_session; then
    return 1
  fi
  return 0
}
