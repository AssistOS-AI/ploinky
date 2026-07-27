delete_matching_lines() {
  local file="$1"
  local expression="$2"
  local backup="${file}.bak"

  rm -f "$backup"
  if ! sed -i.bak "$expression" "$file"; then
    rm -f "$backup"
    return 1
  fi
  rm -f "$backup"
}

fast_test_dynamic_app_name() {
  load_state
  require_var "TEST_RUN_DIR" || return 1
  
  local secrets_file="$TEST_RUN_DIR/.ploinky/.secrets"
  
  # Save original APP_NAME if exists
  local original_app_name=""
  if grep -q "^APP_NAME=" "$secrets_file" 2>/dev/null; then
    original_app_name=$(grep "^APP_NAME=" "$secrets_file" | head -1 | cut -d= -f2-)
  fi
  
  # Test 1: Server responds before config change
  if ! assert_router_status_ok; then
    echo "Server not responding before config change" >&2
    return 1
  fi
  
  # Test 2: Change APP_NAME
  local test_app_name="DynamicTestApp_$$"
  echo "APP_NAME=${test_app_name}" >> "$secrets_file"
  
  # Give it a moment to be picked up (TTL=0 means instant, but allow for request processing)
  sleep 0.5
  
  # Test 3: Server still responds after config change (proves no crash)
  if ! assert_router_status_ok; then
    echo "Server not responding after APP_NAME change" >&2
    # Restore original
    delete_matching_lines "$secrets_file" "/^APP_NAME=/d"
    if [[ -n "$original_app_name" ]]; then
      echo "APP_NAME=${original_app_name}" >> "$secrets_file"
    fi
    return 1
  fi
  
  # Test 4: Change APP_NAME again to different value
  local test_app_name2="DynamicTestApp2_$$"
  delete_matching_lines "$secrets_file" "/^APP_NAME=/d"
  echo "APP_NAME=${test_app_name2}" >> "$secrets_file"
  
  sleep 0.5
  
  # Test 5: Server still responds after second change
  if ! assert_router_status_ok; then
    echo "Server not responding after second APP_NAME change" >&2
    # Restore original
    delete_matching_lines "$secrets_file" "/^APP_NAME=/d"
    if [[ -n "$original_app_name" ]]; then
      echo "APP_NAME=${original_app_name}" >> "$secrets_file"
    fi
    return 1
  fi
  
  # Restore original APP_NAME
  delete_matching_lines "$secrets_file" "/^APP_NAME=/d"
  if [[ -n "$original_app_name" ]]; then
    echo "APP_NAME=${original_app_name}" >> "$secrets_file"
  fi
  
  return 0
}

fast_test_sso_client_secret_propagation() {
  load_state
  require_var "TEST_RUN_DIR" || return 1
  
  local secrets_file="$TEST_RUN_DIR/.ploinky/.secrets"
  
  # Save all original SSO values
  local original_base_url=""
  local original_realm=""
  local original_client_id=""
  local original_client_secret=""
  
  if grep -q "^SSO_BASE_URL=" "$secrets_file" 2>/dev/null; then
    original_base_url=$(grep "^SSO_BASE_URL=" "$secrets_file" | head -1 | cut -d= -f2-)
  fi
  if grep -q "^SSO_REALM=" "$secrets_file" 2>/dev/null; then
    original_realm=$(grep "^SSO_REALM=" "$secrets_file" | head -1 | cut -d= -f2-)
  fi
  if grep -q "^SSO_CLIENT_ID=" "$secrets_file" 2>/dev/null; then
    original_client_id=$(grep "^SSO_CLIENT_ID=" "$secrets_file" | head -1 | cut -d= -f2-)
  fi
  if grep -q "^SSO_CLIENT_SECRET=" "$secrets_file" 2>/dev/null; then
    original_client_secret=$(grep "^SSO_CLIENT_SECRET=" "$secrets_file" | head -1 | cut -d= -f2-)
  fi
  
  # Set test SSO config
  delete_matching_lines "$secrets_file" "/^SSO_BASE_URL=/d"
  delete_matching_lines "$secrets_file" "/^SSO_REALM=/d"
  delete_matching_lines "$secrets_file" "/^SSO_CLIENT_ID=/d"
  delete_matching_lines "$secrets_file" "/^SSO_CLIENT_SECRET=/d"
  
  echo "SSO_BASE_URL=https://test-sso.example.com" >> "$secrets_file"
  echo "SSO_REALM=test-realm" >> "$secrets_file"
  echo "SSO_CLIENT_ID=test-client-$RANDOM" >> "$secrets_file"
  echo "SSO_CLIENT_SECRET=test-secret-$RANDOM" >> "$secrets_file"
  
  sleep 0.5
  
  # Test that server still responds (config was read)
  local response
  if ! assert_router_status_ok; then
    response="Router health check failed"
    echo "Server not responding after SSO config change: ${response}" >&2
    # Restore original
    delete_matching_lines "$secrets_file" "/^SSO_/d"
    [[ -n "$original_base_url" ]] && echo "SSO_BASE_URL=${original_base_url}" >> "$secrets_file"
    [[ -n "$original_realm" ]] && echo "SSO_REALM=${original_realm}" >> "$secrets_file"
    [[ -n "$original_client_id" ]] && echo "SSO_CLIENT_ID=${original_client_id}" >> "$secrets_file"
    [[ -n "$original_client_secret" ]] && echo "SSO_CLIENT_SECRET=${original_client_secret}" >> "$secrets_file"
    return 1
  fi
  
  # Change ONLY the client secret (this was the bug!)
  local new_secret="test-secret-$RANDOM-changed"
  delete_matching_lines "$secrets_file" "/^SSO_CLIENT_SECRET=/d"
  echo "SSO_CLIENT_SECRET=${new_secret}" >> "$secrets_file"
  
  sleep 0.5
  
  # Verify server still responds after changing ONLY client secret
  if ! assert_router_status_ok; then
    echo "Server not responding after changing ONLY SSO_CLIENT_SECRET" >&2
    # Restore original
    delete_matching_lines "$secrets_file" "/^SSO_/d"
    [[ -n "$original_base_url" ]] && echo "SSO_BASE_URL=${original_base_url}" >> "$secrets_file"
    [[ -n "$original_realm" ]] && echo "SSO_REALM=${original_realm}" >> "$secrets_file"
    [[ -n "$original_client_id" ]] && echo "SSO_CLIENT_ID=${original_client_id}" >> "$secrets_file"
    [[ -n "$original_client_secret" ]] && echo "SSO_CLIENT_SECRET=${original_client_secret}" >> "$secrets_file"
    return 1
  fi
  
  # Restore original SSO config
  delete_matching_lines "$secrets_file" "/^SSO_/d"
  if [[ -n "$original_base_url" ]]; then
    echo "SSO_BASE_URL=${original_base_url}" >> "$secrets_file"
  fi
  if [[ -n "$original_realm" ]]; then
    echo "SSO_REALM=${original_realm}" >> "$secrets_file"
  fi
  if [[ -n "$original_client_id" ]]; then
    echo "SSO_CLIENT_ID=${original_client_id}" >> "$secrets_file"
  fi
  if [[ -n "$original_client_secret" ]]; then
    echo "SSO_CLIENT_SECRET=${original_client_secret}" >> "$secrets_file"
  fi
  
  return 0
}
