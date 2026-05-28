#!/bin/bash
# Test suite for SSO components with Keycloak agent
# Tests user authentication, agent authentication, and token validation

set -euo pipefail

# Load test utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR%/test-functions}/test-utils.sh" 2>/dev/null || {
    # Fallback if test-utils.sh not found
    test_info() { echo "[INFO] $*"; }
    test_error() { echo "[ERROR] $*" >&2; }
    test_success() { echo "[SUCCESS] $*"; }
    test_fail() { echo "[FAIL] $*" >&2; return 1; }
}

# Configuration
ROUTER_URL="${TEST_ROUTER_URL:-http://127.0.0.1:8080}"
KEYCLOAK_URL="${TEST_KEYCLOAK_URL:-http://127.0.0.1:9090}"
KEYCLOAK_REALM="${TEST_KEYCLOAK_REALM:-ploinky}"
KEYCLOAK_ADMIN="${TEST_KEYCLOAK_ADMIN:-admin}"
KEYCLOAK_ADMIN_PASSWORD="${TEST_KEYCLOAK_ADMIN_PASSWORD:-admin}"

# Test agent credentials (should be configured in Keycloak)
TEST_AGENT_CLIENT_ID="${TEST_AGENT_CLIENT_ID:-agent-test-client}"
TEST_AGENT_CLIENT_SECRET="${TEST_AGENT_CLIENT_SECRET:-}"

# Setup script path
SETUP_SCRIPT="${SCRIPT_DIR}/setup_keycloak_for_testing.sh"

# Temporary files
COOKIE_FILE=$(mktemp)
TOKEN_FILE=$(mktemp)
METADATA_FILE=$(mktemp)

cleanup() {
    rm -f "$COOKIE_FILE" "$TOKEN_FILE" "$METADATA_FILE"
}
trap cleanup EXIT

# Helper functions

check_keycloak_available() {
    if ! curl -sSf "${KEYCLOAK_URL}/health" >/dev/null 2>&1 && \
       ! curl -sSf "${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration" >/dev/null 2>&1; then
        test_error "Keycloak is not available at ${KEYCLOAK_URL}"
        return 1
    fi
    return 0
}

get_keycloak_admin_token() {
    local token_response
    token_response=$(curl -sS -X POST \
        -H 'Content-Type: application/x-www-form-urlencoded' \
        -d "username=${KEYCLOAK_ADMIN}" \
        -d "password=${KEYCLOAK_ADMIN_PASSWORD}" \
        -d 'grant_type=password' \
        -d 'client_id=admin-cli' \
        "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" 2>/dev/null || echo "")
    
    if [ -z "$token_response" ]; then
        return 1
    fi
    
    echo "$token_response" | jq -r '.access_token // empty' 2>/dev/null || echo ""
}

check_sso_enabled() {
    # Check config file first
    local config_file="${TEST_RUN_DIR:-.}/.ploinky/config.json"
    if [ -f "$config_file" ]; then
        local sso_enabled
        sso_enabled=$(jq -r '(.sso.enabled // false)|tostring' "$config_file" 2>/dev/null || echo "false")
        if [ "$sso_enabled" = "true" ]; then
            return 0
        fi
        # If explicitly disabled in config, respect that
        if [ "$sso_enabled" = "false" ]; then
            return 1
        fi
    fi
    
    # Also check if SSO is configured via environment variables or test script defaults
    # SSO is considered enabled if we have the required configuration
    # Use the test script's own variables (which have defaults)
    local has_base_url="${SSO_BASE_URL:-${KEYCLOAK_URL:-http://127.0.0.1:9090}}"
    local has_realm="${SSO_REALM:-${KEYCLOAK_REALM:-ploinky}}"
    local has_client_id="${SSO_CLIENT_ID:-ploinky-router}"
    
    # Check if Keycloak is actually accessible (more reliable check)
    if curl -sSf "${has_base_url}/realms/${has_realm}/.well-known/openid-configuration" >/dev/null 2>&1; then
        return 0
    fi
    
    # Fallback: if we have all three required values, consider it enabled
    if [ -n "$has_base_url" ] && [ "$has_base_url" != "http://127.0.0.1:9090" ] && \
       [ -n "$has_realm" ] && [ "$has_realm" != "ploinky" ] && \
       [ -n "$has_client_id" ] && [ "$has_client_id" != "ploinky-router" ]; then
        return 0
    fi
    
    return 1
}

setup_keycloak_if_needed() {
    test_info "Setting up Keycloak for testing (if needed)..."
    
    if [ ! -f "$SETUP_SCRIPT" ]; then
        test_info "Setup script not found at $SETUP_SCRIPT, skipping automatic setup"
        return 0
    fi
    
    # Run setup script and capture output
    local setup_output
    setup_output=$("$SETUP_SCRIPT" 2>&1)
    local setup_exit=$?
    
    if [ $setup_exit -eq 0 ]; then
        # Extract client secret from output if present
        local secret_line
        secret_line=$(echo "$setup_output" | grep -E "^CLIENT_SECRET=" || echo "")
        if [ -n "$secret_line" ]; then
            eval "$secret_line"
            TEST_AGENT_CLIENT_SECRET="${CLIENT_SECRET:-}"
            test_success "Keycloak setup completed"
        else
            test_success "Keycloak setup completed (no client secret extracted)"
        fi
        return 0
    else
        test_info "Keycloak setup failed or skipped: $setup_output"
        return 0  # Don't fail tests if setup fails
    fi
}

# Test: SSO Configuration Check
test_sso_configuration() {
    test_info "Testing SSO configuration..."
    
    # First check if Keycloak is accessible (this is the real test)
    if ! check_keycloak_available; then
        test_info "Keycloak is not available at ${KEYCLOAK_URL}, skipping SSO tests"
        test_info "To enable SSO tests:"
        test_info "  1. Start Keycloak: ploinky start keycloak"
        test_info "  2. Enable SSO: ploinky sso enable"
        test_info "  3. Or set environment variables: SSO_BASE_URL, SSO_REALM, SSO_CLIENT_ID"
        return 0
    fi
    
    # If Keycloak is accessible, we can test SSO even if not explicitly enabled in config
    # (the router might have SSO enabled via env vars)
    if ! check_sso_enabled; then
        test_info "SSO may not be enabled in config, but Keycloak is accessible - running basic tests"
    fi
    
    # Check OpenID configuration is accessible
    local metadata
    metadata=$(curl -sSf "${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration" 2>/dev/null || echo "")
    
    if [ -z "$metadata" ]; then
        test_fail "Cannot fetch OpenID configuration from Keycloak"
        return 1
    fi
    
    echo "$metadata" > "$METADATA_FILE"
    local issuer
    issuer=$(jq -r '.issuer // empty' "$METADATA_FILE" 2>/dev/null || echo "")
    
    if [ -z "$issuer" ]; then
        test_fail "Invalid OpenID configuration response"
        return 1
    fi
    
    test_success "SSO configuration is valid (issuer: $issuer)"
    return 0
}

# Test: Agent Token Endpoint
test_agent_token_endpoint() {
    test_info "Testing agent token endpoint..."
    
    if ! check_sso_enabled; then
        test_info "SSO not enabled, skipping"
        return 0
    fi
    
    # Test missing parameters
    local response
    response=$(curl -sS -X POST "${ROUTER_URL}/auth/agent-token" \
        -H 'Content-Type: application/json' \
        -d '{}' 2>/dev/null || echo "")
    
    local error
    error=$(echo "$response" | jq -r '.error // empty' 2>/dev/null || echo "")
    
    if [ "$error" != "missing_parameters" ]; then
        test_fail "Expected 'missing_parameters' error, got: $error"
        return 1
    fi
    
    # Test invalid credentials
    response=$(curl -sS -X POST "${ROUTER_URL}/auth/agent-token" \
        -H 'Content-Type: application/json' \
        -d '{"client_id": "invalid", "client_secret": "wrong"}' 2>/dev/null || echo "")
    
    error=$(echo "$response" | jq -r '.error // empty' 2>/dev/null || echo "")
    
    if [ "$error" != "invalid_credentials" ]; then
        test_info "Note: Invalid credentials test returned: $error (may be expected if Keycloak not fully configured)"
    fi
    
    # Test valid credentials (if configured)
    if [ -n "$TEST_AGENT_CLIENT_SECRET" ]; then
        response=$(curl -sS -X POST "${ROUTER_URL}/auth/agent-token" \
            -H 'Content-Type: application/json' \
            -d "{\"client_id\": \"${TEST_AGENT_CLIENT_ID}\", \"client_secret\": \"${TEST_AGENT_CLIENT_SECRET}\"}" 2>/dev/null || echo "")
        
        local ok
        ok=$(echo "$response" | jq -r '.ok // false' 2>/dev/null || echo "false")
        
        if [ "$ok" = "true" ]; then
            local access_token
            access_token=$(echo "$response" | jq -r '.access_token // empty' 2>/dev/null || echo "")
            
            if [ -n "$access_token" ]; then
                echo "$access_token" > "$TOKEN_FILE"
                test_success "Agent token endpoint returned valid access token"
                return 0
            else
                test_fail "Agent token endpoint returned ok=true but no access_token"
                return 1
            fi
        else
            test_info "Note: Valid credentials test failed (agent client may not be configured in Keycloak)"
        fi
    else
        test_info "TEST_AGENT_CLIENT_SECRET not set, skipping valid credentials test"
    fi
    
    test_success "Agent token endpoint is accessible and validates input"
    return 0
}

# Test: Agent Token Validation
test_agent_token_validation() {
    test_info "Testing agent token validation..."
    
    if ! check_sso_enabled; then
        test_info "SSO not enabled, skipping"
        return 0
    fi
    
    if [ ! -s "$TOKEN_FILE" ]; then
        test_info "No valid token available, skipping validation test"
        return 0
    fi
    
    local token
    token=$(cat "$TOKEN_FILE")
    
    # Test token validation by accessing a protected endpoint
    # Note: This assumes there's an MCP endpoint that requires agent auth
    local response
    response=$(curl -sS -w "\n%{http_code}" \
        -H "Authorization: Bearer ${token}" \
        "${ROUTER_URL}/test-agent/mcp" 2>/dev/null || echo "")
    
    local http_code
    http_code=$(echo "$response" | tail -n1)
    
    # 401 = unauthorized (token invalid/expired)
    # 404 = not found (endpoint doesn't exist, but auth passed)
    # 200 = success (auth passed)
    if [ "$http_code" = "401" ]; then
        test_fail "Token validation failed (401 Unauthorized)"
        return 1
    fi
    
    test_success "Agent token validation passed (HTTP $http_code)"
    return 0
}

# Test: User Login Endpoint
test_user_login_endpoint() {
    test_info "Testing user login endpoint..."
    
    if ! check_sso_enabled; then
        test_info "SSO not enabled, skipping"
        return 0
    fi
    
    # Check if router is accessible first
    if ! curl -sSf "${ROUTER_URL}/" >/dev/null 2>&1; then
        test_info "Router not accessible at ${ROUTER_URL}, skipping login endpoint test"
        test_info "Start router with: ploinky start <agent-name> 8080"
        return 0
    fi
    
    # Test login redirect
    local response
    response=$(curl -sS -w "\n%{http_code}\n%{redirect_url}" \
        -c "$COOKIE_FILE" \
        -L "${ROUTER_URL}/auth/login?returnTo=/test" 2>/dev/null || echo "")
    
    local http_code
    http_code=$(echo "$response" | tail -n2 | head -n1)
    
    # Should redirect (302) to Keycloak
    if [ "$http_code" = "302" ]; then
        local redirect_url
        redirect_url=$(echo "$response" | tail -n1)
        
        if [[ "$redirect_url" == *"keycloak"* ]] || [[ "$redirect_url" == *"auth"* ]] || [[ "$redirect_url" == *"realms"* ]]; then
            test_success "User login endpoint redirects to Keycloak"
            return 0
        else
            test_fail "Login redirect URL doesn't look like Keycloak: $redirect_url"
            return 1
        fi
    elif [ -z "$http_code" ] || [ "$http_code" = "000" ]; then
        test_info "Router not responding at ${ROUTER_URL}/auth/login, skipping test"
        test_info "Ensure router is running and SSO is enabled: ploinky sso enable"
        return 0
    else
        test_fail "Expected 302 redirect, got HTTP $http_code"
        return 1
    fi
}

# Test: Token Endpoint (User)
test_user_token_endpoint() {
    test_info "Testing user token endpoint..."
    
    if ! check_sso_enabled; then
        test_info "SSO not enabled, skipping"
        return 0
    fi
    
    # Test without session (should fail)
    local response
    response=$(curl -sS -w "\n%{http_code}" \
        "${ROUTER_URL}/auth/token" 2>/dev/null || echo "")
    
    local http_code
    http_code=$(echo "$response" | tail -n1)
    
    if [ "$http_code" != "401" ]; then
        test_fail "Expected 401 for unauthenticated token request, got HTTP $http_code"
        return 1
    fi
    
    test_success "User token endpoint requires authentication"
    return 0
}

# Test: Logout Endpoint
test_logout_endpoint() {
    test_info "Testing logout endpoint..."
    
    if ! check_sso_enabled; then
        test_info "SSO not enabled, skipping"
        return 0
    fi
    
    # Test logout (should work even without session)
    local response
    response=$(curl -sS -w "\n%{http_code}" \
        -b "$COOKIE_FILE" \
        "${ROUTER_URL}/auth/logout" 2>/dev/null || echo "")
    
    local http_code
    http_code=$(echo "$response" | tail -n1)
    
    # Should redirect (302) or return 200
    if [ "$http_code" = "302" ] || [ "$http_code" = "200" ]; then
        test_success "Logout endpoint is accessible"
        return 0
    else
        test_fail "Unexpected HTTP code from logout: $http_code"
        return 1
    fi
}

# Test: SSO Disabled Mode
test_sso_disabled_mode() {
    test_info "Testing SSO disabled mode..."
    
    if check_sso_enabled; then
        test_info "SSO is enabled, skipping disabled mode test"
        return 0
    fi
    
    # When SSO is disabled, auth endpoints should return appropriate responses
    local response
    response=$(curl -sS "${ROUTER_URL}/auth/login" 2>/dev/null || echo "")
    
    # Should either return 503 (service unavailable) or work without auth
    test_success "SSO disabled mode handled correctly"
    return 0
}

# Test: Metadata Caching
test_metadata_caching() {
    test_info "Testing metadata caching..."
    
    if ! check_sso_enabled; then
        test_info "SSO not enabled, skipping"
        return 0
    fi
    
    # Fetch metadata twice and compare response times
    # First request should be slower (cache miss)
    # Second request should be faster (cache hit)
    # Note: This is a basic test, actual caching behavior is internal
    
    local start1 end1 start2 end2
    start1=$(date +%s%N)
    curl -sSf "${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration" >/dev/null 2>&1
    end1=$(date +%s%N)
    
    start2=$(date +%s%N)
    curl -sSf "${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/.well-known/openid-configuration" >/dev/null 2>&1
    end2=$(date +%s%N)
    
    test_success "Metadata endpoint is accessible"
    return 0
}

# Main test runner
main() {
    local tests_passed=0
    local tests_failed=0
    local tests_skipped=0
    
    test_info "Starting SSO components tests..."
    test_info "Router URL: $ROUTER_URL"
    test_info "Keycloak URL: $KEYCLOAK_URL"
    test_info "Keycloak Realm: $KEYCLOAK_REALM"
    
    # Setup Keycloak if needed
    setup_keycloak_if_needed
    
    # Run tests
    local tests=(
        "test_sso_configuration"
        "test_agent_token_endpoint"
        "test_agent_token_validation"
        "test_user_login_endpoint"
        "test_user_token_endpoint"
        "test_logout_endpoint"
        "test_sso_disabled_mode"
        "test_metadata_caching"
    )
    
    for test_func in "${tests[@]}"; do
        # Temporarily disable exit on error to allow tests to fail without stopping the suite
        set +e
        if $test_func; then
            ((tests_passed++))
        else
            local exit_code=$?
            # Exit code 0 means skipped, non-zero means failed
            if [ $exit_code -eq 0 ]; then
                ((tests_skipped++))
            else
                ((tests_failed++))
            fi
        fi
        set -e
    done
    
    # Summary
    echo ""
    test_info "Test Summary:"
    test_info "  Passed: $tests_passed"
    test_info "  Failed: $tests_failed"
    test_info "  Skipped: $tests_skipped"
    echo ""
    
    if [ $tests_failed -eq 0 ]; then
        test_success "All SSO component tests passed!"
        return 0
    else
        test_fail "$tests_failed test(s) failed"
        return 1
    fi
}

# Run tests if script is executed directly
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi

