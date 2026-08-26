check_postinstall_marker() {
  load_state
  require_var "TEST_RUN_DIR"
  require_var "TEST_AGENT_DEP_GLOBAL_NAME"

  # The dependency is enabled in global mode, so its passthrough
  # WORKSPACE_PATH is the workspace root.
  local marker_path="$TEST_RUN_DIR/postinstall_marker.txt"

  if [[ ! -f "$marker_path" ]]; then
    echo "Postinstall marker '$marker_path' not found." >&2
    return 1
  fi

  if ! grep -Fxq "postinstall_ok" "$marker_path"; then
    echo "Postinstall marker missing expected contents in '$marker_path'." >&2
    echo "--- marker contents ---" >&2
    cat "$marker_path" >&2
    echo "-----------------------" >&2
    return 1
  fi
}
