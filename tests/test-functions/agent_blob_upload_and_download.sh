fast_check_agent_blob_upload() {
  require_var "TEST_RUN_DIR"
  require_var "TEST_ROUTER_PORT"
  require_var "TEST_AGENT_NAME"
  require_var "TEST_AGENT_WORKSPACE"

  local upload_file
  # BSD mktemp (macOS default) only substitutes the X-template when the X's
  # are at the very end — a trailing literal suffix like `.bin` makes it
  # create a file named literally `fast-agent-upload.XXXXXX.bin`. Keep the
  # X's at the tail and let dd write the random payload.
  if ! upload_file=$(mktemp "$TEST_RUN_DIR/fast-agent-upload.XXXXXX"); then
    echo "Failed to allocate temporary upload file." >&2
    return 1
  fi

  if ! dd if=/dev/urandom of="$upload_file" bs=1M count=1 2>/dev/null; then
    echo "Failed to generate random upload payload." >&2
    rm -f "$upload_file"
    return 1
  fi

  local response
  if ! response=$(curl -fsS -X POST --data-binary @"$upload_file" \
      -H 'Content-Type: application/octet-stream' \
      -H 'X-Mime-Type: application/octet-stream' \
      "http://127.0.0.1:${TEST_ROUTER_PORT}/blobs/${TEST_AGENT_NAME}"); then
    echo "curl upload request failed." >&2
    rm -f "$upload_file"
    return 1
  fi

  local blob_id
  blob_id=$(echo "$response" | jq -r '.id // empty')
  if [[ -z "$blob_id" ]]; then
    echo "Upload response missing blob id. Response: $response" >&2
    rm -f "$upload_file"
    return 1
  fi

  local blob_download_url
  local blob_url
  blob_download_url=$(echo "$response" | jq -r '.downloadUrl // empty')
  if [[ -n "$blob_download_url" ]]; then
    if [[ "$blob_download_url" != "http://127.0.0.1:${TEST_ROUTER_PORT}/blobs/${TEST_AGENT_NAME}/"* ]]; then
      echo "Upload downloadUrl unexpected. downloadUrl='$blob_download_url' response='$response'" >&2
      rm -f "$upload_file"
      return 1
    fi
    blob_url="${blob_download_url#http://127.0.0.1:${TEST_ROUTER_PORT}}"
    if [[ -z "$blob_url" || "$blob_url" == "$blob_download_url" ]]; then
      echo "Unable to derive blob path from downloadUrl='$blob_download_url'." >&2
      rm -f "$upload_file"
      return 1
    fi
    if [[ "$blob_url" != "/blobs/${TEST_AGENT_NAME}/"* ]]; then
      echo "Derived blob path unexpected. path='$blob_url' downloadUrl='$blob_download_url'" >&2
      rm -f "$upload_file"
      return 1
    fi
  else
    blob_url=$(echo "$response" | jq -r '.url // empty')
    if [[ -z "$blob_url" || "$blob_url" != "/blobs/${TEST_AGENT_NAME}/"* ]]; then
      echo "Upload response URL unexpected. url='$blob_url' response='$response'" >&2
      rm -f "$upload_file"
      return 1
    fi
    blob_download_url="http://127.0.0.1:${TEST_ROUTER_PORT}${blob_url}"
  fi

  # Non-shared blobs are owned by the canonical short agent name in .data.
  local blob_path="$TEST_RUN_DIR/.data/$TEST_AGENT_NAME/blobs/$blob_id"
  local blob_meta="${blob_path}.json"

  if [[ ! -f "$blob_path" ]]; then
    echo "Uploaded blob file not found at $blob_path" >&2
    rm -f "$upload_file"
    return 1
  fi

  if ! cmp -s "$upload_file" "$blob_path"; then
    echo "Blob contents do not match uploaded payload." >&2
    rm -f "$upload_file"
    return 1
  fi

  if [[ ! -f "$blob_meta" ]]; then
    echo "Blob metadata file missing at $blob_meta" >&2
    rm -f "$upload_file"
    return 1
  fi

  write_state_var "FAST_AGENT_UPLOAD_FILE" "$upload_file"
  write_state_var "FAST_AGENT_BLOB_ID" "$blob_id"
  write_state_var "FAST_AGENT_BLOB_URL" "$blob_url"
  write_state_var "FAST_AGENT_BLOB_DOWNLOAD_URL" "$blob_download_url"
  write_state_var "FAST_AGENT_BLOB_PATH" "$blob_path"
  write_state_var "FAST_AGENT_BLOB_META" "$blob_meta"
}

fast_check_agent_blob_download() {
  require_var "TEST_ROUTER_PORT"
  require_var "TEST_AGENT_NAME"
  require_var "TEST_AGENT_WORKSPACE"

  load_state

  if [[ -z "${FAST_AGENT_UPLOAD_FILE:-}" || -z "${FAST_AGENT_BLOB_ID:-}" || -z "${FAST_AGENT_BLOB_DOWNLOAD_URL:-}" ]]; then
    echo "Agent blob upload state missing. Did the upload test run?" >&2
    return 1
  fi

  local download_file
  if ! download_file=$(mktemp "$TEST_RUN_DIR/fast-agent-download.XXXXXX"); then
    echo "Failed to allocate temporary download file." >&2
    return 1
  fi

  if ! curl -fsS -o "$download_file" "$FAST_AGENT_BLOB_DOWNLOAD_URL"; then
    echo "curl download request failed for ${FAST_AGENT_BLOB_DOWNLOAD_URL}." >&2
    rm -f "$download_file"
    return 1
  fi

  if ! cmp -s "$FAST_AGENT_UPLOAD_FILE" "$download_file"; then
    echo "Downloaded blob does not match original payload." >&2
    rm -f "$download_file"
    return 1
  fi

  rm -f "$download_file"
  rm -f "$FAST_AGENT_UPLOAD_FILE"
  rm -f "$FAST_AGENT_BLOB_PATH" "$FAST_AGENT_BLOB_META"
  write_state_var "FAST_AGENT_UPLOAD_FILE" ""
  write_state_var "FAST_AGENT_BLOB_ID" ""
  write_state_var "FAST_AGENT_BLOB_URL" ""
  write_state_var "FAST_AGENT_BLOB_DOWNLOAD_URL" ""
  write_state_var "FAST_AGENT_BLOB_PATH" ""
  write_state_var "FAST_AGENT_BLOB_META" ""
}

fast_check_shared_blob_upload() {
  require_var "TEST_RUN_DIR"
  require_var "TEST_ROUTER_PORT"

  local shared_dir="$TEST_RUN_DIR/.data/shared"
  local upload_file
  if ! upload_file=$(mktemp "$TEST_RUN_DIR/fast-shared-upload.XXXXXX"); then
    echo "Failed to allocate temporary upload file for shared blobs." >&2
    return 1
  fi

  if ! dd if=/dev/urandom of="$upload_file" bs=512K count=1 2>/dev/null; then
    echo "Failed to prepare shared upload payload." >&2
    rm -f "$upload_file"
    return 1
  fi

  local response
  if ! response=$(curl -fsS -X POST --data-binary @"$upload_file" \
      -H 'Content-Type: application/octet-stream' \
      -H 'X-Mime-Type: application/octet-stream' \
      "http://127.0.0.1:${TEST_ROUTER_PORT}/blobs"); then
    echo "curl upload request to shared endpoint failed." >&2
    rm -f "$upload_file"
    return 1
  fi

  local blob_id
  blob_id=$(echo "$response" | jq -r '.id // empty')
  if [[ -z "$blob_id" ]]; then
    echo "Shared upload response missing blob id. Response: $response" >&2
    rm -f "$upload_file"
    return 1
  fi

  local blob_download_url
  blob_download_url=$(echo "$response" | jq -r '.downloadUrl // empty')
  if [[ -z "$blob_download_url" || "$blob_download_url" != "http://127.0.0.1:${TEST_ROUTER_PORT}/blobs/"* ]]; then
    echo "Shared upload downloadUrl unexpected. url='$blob_download_url' response='$response'" >&2
    rm -f "$upload_file"
    return 1
  fi

  local shared_path="$shared_dir/$blob_id"
  if [[ ! -f "$shared_path" ]]; then
    echo "Shared upload file missing at $shared_path" >&2
    rm -f "$upload_file"
    return 1
  fi

  if ! cmp -s "$upload_file" "$shared_path"; then
    echo "Shared blob contents do not match uploaded payload." >&2
    rm -f "$upload_file"
    return 1
  fi

  local local_path
  local_path=$(echo "$response" | jq -r '.localPath // empty')
  if [[ -z "$local_path" || "$local_path" != "/shared/${blob_id}" ]]; then
    echo "Shared upload localPath incorrect. localPath='$local_path' response='$response'" >&2
    rm -f "$upload_file"
    return 1
  fi

  write_state_var "FAST_SHARED_UPLOAD_FILE" "$upload_file"
  write_state_var "FAST_SHARED_BLOB_ID" "$blob_id"
  write_state_var "FAST_SHARED_BLOB_URL" "$blob_download_url"
  write_state_var "FAST_SHARED_BLOB_PATH" "$shared_path"
}

fast_check_shared_blob_download() {
  require_var "TEST_ROUTER_PORT"
  require_var "TEST_RUN_DIR"

  load_state
  if [[ -z "${FAST_SHARED_UPLOAD_FILE:-}" || -z "${FAST_SHARED_BLOB_URL:-}" ]]; then
    echo "Shared blob upload state missing. Did the shared upload test run?" >&2
    return 1
  fi

  local download_file
  if ! download_file=$(mktemp "$TEST_RUN_DIR/fast-shared-download.XXXXXX"); then
    echo "Failed to allocate temporary download file for shared blob." >&2
    return 1
  fi

  if ! curl -fsS -o "$download_file" "${FAST_SHARED_BLOB_URL}"; then
    echo "curl download for shared blob failed." >&2
    rm -f "$download_file"
    return 1
  fi

  if ! cmp -s "$FAST_SHARED_UPLOAD_FILE" "$download_file"; then
    echo "Shared blob download does not match uploaded payload." >&2
    rm -f "$download_file"
    return 1
  fi

  rm -f "$download_file"
  rm -f "$FAST_SHARED_UPLOAD_FILE"
  rm -f "$FAST_SHARED_BLOB_PATH"
  write_state_var "FAST_SHARED_UPLOAD_FILE" ""
  write_state_var "FAST_SHARED_BLOB_ID" ""
  write_state_var "FAST_SHARED_BLOB_URL" ""
  write_state_var "FAST_SHARED_BLOB_PATH" ""
}
