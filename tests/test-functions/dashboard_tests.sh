assert_dashboard_status() {
  require_var "TEST_ROUTER_PORT"

  if ! ploinky dashboard >/dev/null 2>&1; then
    echo "Failed to ensure dashboard token via 'ploinky dashboard'." >&2
    return 1
  fi

  local token token_line
  if ! token_line=$(ploinky echo WEBDASHBOARD_TOKEN 2>/dev/null); then
    echo "Failed to read WEBDASHBOARD_TOKEN via 'ploinky echo'." >&2
    return 1
  fi
  token=$(printf '%s\n' "$token_line" \
    | awk -F'=' '/^WEBDASHBOARD_TOKEN=/{print $2}' \
    | tail -n1 \
    | tr -d '\r')
  if [[ -z "$token" ]]; then
    echo "Dashboard token not found in 'ploinky echo WEBDASHBOARD_TOKEN' output." >&2
    return 1
  fi

  local base_url="http://127.0.0.1:${TEST_ROUTER_PORT}/dashboard"
  local cookie_jar body_file
  cookie_jar=$(mktemp)
  body_file=$(mktemp)

  if ! curl -fsS -c "$cookie_jar" -H 'Content-Type: application/json' \
      --data "{\"token\":\"$token\"}" "${base_url}/auth" >/dev/null; then
    echo "Failed to authenticate dashboard session." >&2
    rm -f "$cookie_jar" "$body_file"
    return 1
  fi

  local run_response
  if ! run_response=$(curl -fsS -b "$cookie_jar" \
      -H 'Content-Type: application/json' \
      -d '{"cmd":"status"}' "${base_url}/run"); then
    echo "Dashboard /run endpoint request failed." >&2
    rm -f "$cookie_jar" "$body_file"
    return 1
  fi

  local ok code stdout
  ok=$(echo "$run_response" | jq -r '.ok // false')
  code=$(echo "$run_response" | jq -r '.code // 1')
  stdout=$(echo "$run_response" | jq -r '.stdout // ""')

  if [[ "$ok" != "true" ]]; then
    echo "Dashboard /run response not ok: $run_response" >&2
    rm -f "$cookie_jar" "$body_file"
    return 1
  fi

  if [[ "$code" != "0" ]]; then
    echo "ploinky status via dashboard returned exit code ${code}." >&2
    rm -f "$cookie_jar" "$body_file"
    return 1
  fi

  if [[ -z "$stdout" ]]; then
    echo "ploinky status via dashboard produced no stdout." >&2
    rm -f "$cookie_jar" "$body_file"
    return 1
  fi

  if ! grep -q -- "- Router: listening" <<<"$stdout"; then
    echo "Dashboard status output missing '- Router: listening'." >&2
    rm -f "$cookie_jar" "$body_file"
    return 1
  fi

  rm -f "$cookie_jar" "$body_file"
}
