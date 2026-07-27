fast_check_install_marker_via_shell() {
  local marker="/root/install_marker.txt"
  if ! { echo "test -f '$marker' && echo install_marker_ok"; echo "exit"; } \
      | ploinky shell "$TEST_AGENT_NAME" \
      | grep -qF -- "install_marker_ok"; then
    echo "File '${marker}' not found via 'ploinky shell'." >&2
    echo "--- ploinky shell marker check ---" >&2
    { echo "ls -la /root"; echo "exit"; } | ploinky shell "$TEST_AGENT_NAME" >&2
    echo "---------------------------" >&2
    return 1
  fi
}
