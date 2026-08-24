fast_check_webchat_alias_override() {
  load_state
  require_var "TEST_ROUTER_PORT"
  require_var "TEST_ENABLE_ALIAS_AGENT_ALIAS"

  local router_port="$TEST_ROUTER_PORT"
  local alias_name="$TEST_ENABLE_ALIAS_AGENT_ALIAS"
  local url="http://127.0.0.1:${router_port}/webchat?agent=${alias_name}"
  local tmp_file
  tmp_file=$(mktemp) || return 1

  local http_status
  if ! http_status=$(curl -sS -o "$tmp_file" -w '%{http_code}' "$url" 2>/dev/null); then
    echo "WebChat alias curl request failed for ${url}." >&2
    rm -f "$tmp_file"
    return 1
  fi

  if [[ "$http_status" != "302" ]]; then
    echo "WebChat alias request should redirect to router login; got HTTP ${http_status} for ${url}." >&2
    if [[ -s "$tmp_file" ]]; then
      echo "--- response body ---" >&2
      cat "$tmp_file" >&2 || true
      echo "---------------------" >&2
    fi
    rm -f "$tmp_file"
    return 1
  fi

  if ! grep -q 'Authentication required' "$tmp_file"; then
    echo "Unexpected WebChat alias redirect response for agent '${alias_name}'." >&2
    echo "--- response body ---" >&2
    cat "$tmp_file" >&2 || true
    echo "---------------------" >&2
    rm -f "$tmp_file"
    return 1
  fi

  rm -f "$tmp_file"
}

fast_check_webchat_logout_flow() {
  load_state
  require_var "TEST_ROUTER_PORT"

  local router_url="http://127.0.0.1:${TEST_ROUTER_PORT}"
  local body_file
  body_file=$(mktemp) || { rm -f "$cookie_jar"; return 1; }

  local status
  status=$(curl -sS -o "$body_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -X POST "${router_url}/webchat/auth" \
    -d '{"token":"legacy-token"}' 2>/dev/null || echo "000")
  if [[ "$status" != "410" ]]; then
    echo "Legacy WebChat auth endpoint should return HTTP 410, got ${status}." >&2
    cat "$body_file" >&2 || true
    rm -f "$body_file"
    return 1
  fi

  if ! grep -q 'surface_token_auth_removed' "$body_file"; then
    echo "Legacy WebChat auth endpoint response missing removal marker." >&2
    cat "$body_file" >&2 || true
    rm -f "$body_file"
    return 1
  fi

  rm -f "$body_file"
}
