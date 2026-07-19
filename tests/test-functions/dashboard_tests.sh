assert_dashboard_status() {
  require_var "TEST_ROUTER_PORT"

  local access_output
  if ! access_output=$(ploinky dashboard 2>&1); then
    echo "Failed to print the authenticated dashboard URL." >&2
    return 1
  fi
  if ! grep -q "workspace administrator account" <<<"$access_output"; then
    echo "Dashboard command did not require a workspace administrator session." >&2
    return 1
  fi
  if ploinky dashboard --rotate >/dev/null 2>&1; then
    echo "Removed dashboard token rotation was accepted." >&2
    return 1
  fi

  local base_url="http://127.0.0.1:${TEST_ROUTER_PORT}/dashboard"
  local dashboard_status auth_status
  dashboard_status=$(curl -sS -o /dev/null -w '%{http_code}' "${base_url}/") || return 1
  auth_status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${base_url}/auth") || return 1
  if [[ "$dashboard_status" != "401" || "$auth_status" != "401" ]]; then
    echo "Dashboard did not fail closed without a real Router session (root=${dashboard_status}, auth=${auth_status})." >&2
    return 1
  fi
}
