fast_assert_volume_mount() {
  require_var "TEST_RUN_DIR"
  require_var "TEST_AGENT_CONT_NAME"

  local host_dir="$TEST_RUN_DIR/.data/test-volumes/data"
  local marker_file="$host_dir/marker.txt"
  mkdir -p "$host_dir"
  echo "volumes-ok" >"$marker_file"

  local output
  if ! output=$(ploinky shell "$TEST_AGENT_NAME" <<'SHELL'
cat /mnt/test-data/marker.txt
exit
SHELL
  ); then
    echo "Failed to read mounted file from container." >&2
    return 1
  fi

  if ! grep -q 'volumes-ok' <<<"$output"; then
    echo "Volume mount missing expected marker." >&2
    echo "$output" >&2
    return 1
  fi
}
