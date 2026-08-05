fast_check_install_marker_via_shell() {
  local marker="/root/install_marker.txt"
  local success_marker="__PLOINKY_INSTALL_MARKER_OK__"
  local shell_output
  if ! shell_output=$(printf '%s\n' \
      "if test -f '$marker'; then printf '%s\\n' '$success_marker'; exit 0; else exit 1; fi" \
      | PLOINKY_NO_TTY=1 ploinky shell "$TEST_AGENT_NAME"); then
    echo "File '${marker}' not found via 'ploinky shell'." >&2
    printf '%s\n' "$shell_output" >&2
    echo "--- ploinky shell marker check ---" >&2
    printf '%s\n' "ls -la /root" "exit" \
      | PLOINKY_NO_TTY=1 ploinky shell "$TEST_AGENT_NAME" >&2
    echo "---------------------------" >&2
    return 1
  fi
  if ! grep -qxF -- "$success_marker" <<<"$shell_output"; then
    echo "File '${marker}' was not proven by the exact shell marker output." >&2
    printf '%s\n' "$shell_output" >&2
    return 1
  fi
}
