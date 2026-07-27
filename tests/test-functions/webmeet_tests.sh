assert_webmeet_whoami() {
  require_var "TEST_ROUTER_PORT"
  local base_url="http://127.0.0.1:${TEST_ROUTER_PORT}/webmeet"
  local body_file
  body_file=$(mktemp) || return 1

  local status
  status=$(curl -sS -o "$body_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --data '{"token":"legacy-token"}' \
    "${base_url}/auth" 2>/dev/null || echo "000")

  if [[ "$status" != "404" ]]; then
    echo "Removed WebMeet token auth endpoint should be absent with HTTP 404, got ${status}." >&2
    cat "$body_file" >&2 || true
    rm -f "$body_file"
    return 1
  fi

  if ! grep -q 'Not Found' "$body_file"; then
    echo "Removed WebMeet token auth endpoint returned an unexpected body." >&2
    cat "$body_file" >&2 || true
    rm -f "$body_file"
    return 1
  fi

  rm -f "$body_file"
}
