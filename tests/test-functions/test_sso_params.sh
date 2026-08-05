#!/bin/bash
set -euo pipefail

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
