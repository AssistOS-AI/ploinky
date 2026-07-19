fast_graph_cleanup_workspace() {
  local workspace="$1"
  if [[ -z "$workspace" || ! -d "$workspace" ]]; then
    return 0
  fi
  (
    cd "$workspace" && ploinky destroy >/dev/null 2>&1
  ) || true
  rm -rf "$workspace"
}

fast_graph_init_workspace() {
  local workspace="$1"
  local router_port="$2"
  local repo_name="${3:-graphRepo}"

  mkdir -p "$workspace/.ploinky/repos/${repo_name}"
  cat >"$workspace/.ploinky/routing.json" <<EOF
{
  "port": ${router_port}
}
EOF
}

fast_graph_write_marker_script() {
  local agent_dir="$1"
  cat >"$agent_dir/write-marker.js" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target) {
  process.exit(1);
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${new Date().toISOString()}\n`, 'utf8');
EOF
}

fast_graph_write_http_service_script() {
  local agent_dir="$1"
  cat >"$agent_dir/delayed-http.js" <<'EOF'
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 7000);
const delayMs = Number(process.env.START_DELAY_MS || 0);
const responseText = process.env.RESPONSE_TEXT || 'ok';
const workspacePath = process.env.WORKSPACE_PATH || process.cwd();
const markerDir = path.join(workspacePath, 'markers');

function writeMarker(name) {
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(path.join(markerDir, name), `${new Date().toISOString()}\n`, 'utf8');
}

writeMarker('started.txt');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port, responseText }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(responseText);
});

setTimeout(() => {
  server.listen(port, '0.0.0.0', () => {
    writeMarker('ready.txt');
  });
}, delayMs);
EOF
}

fast_graph_create_start_http_agent() {
  local repo_root="$1"
  local agent_name="$2"
  local delay_ms="$3"
  local enable_json="${4:-[]}"
  local response_text="${5:-${agent_name}-ok}"
  local agent_dir="${repo_root}/${agent_name}"

  mkdir -p "$agent_dir"
  fast_graph_write_marker_script "$agent_dir"
  fast_graph_write_http_service_script "$agent_dir"

  cat >"$agent_dir/manifest.json" <<EOF
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "start": "node /code/delayed-http.js",
  "enable": ${enable_json},
  "profiles": {
    "default": {
      "env": {
        "START_DELAY_MS": "${delay_ms}",
        "RESPONSE_TEXT": "${response_text}"
      }
    }
  }
}
EOF
}

fast_graph_create_agent_http_agent() {
  local repo_root="$1"
  local agent_name="$2"
  local delay_ms="$3"
  local enable_json="${4:-[]}"
  local response_text="${5:-${agent_name}-ok}"
  local readiness_protocol="${6:-}"
  local agent_dir="${repo_root}/${agent_name}"
  local readiness_block=""

  mkdir -p "$agent_dir"
  fast_graph_write_marker_script "$agent_dir"
  fast_graph_write_http_service_script "$agent_dir"

  if [[ -n "$readiness_protocol" ]]; then
    readiness_block=$(cat <<EOF
,
  "readiness": {
    "protocol": "${readiness_protocol}"
  }
EOF
)
  fi

  cat >"$agent_dir/manifest.json" <<EOF
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "agent": "node /code/delayed-http.js",
  "enable": ${enable_json},
  "profiles": {
    "default": {
      "env": {
        "START_DELAY_MS": "${delay_ms}",
        "RESPONSE_TEXT": "${response_text}"
      }
    }
  }${readiness_block}
}
EOF
}

fast_graph_create_delayed_mcp_agent() {
  local repo_root="$1"
  local agent_name="$2"
  local delay_ms="$3"
  local enable_json="${4:-[]}"
  local agent_dir="${repo_root}/${agent_name}"

  mkdir -p "$agent_dir/tools"
  fast_graph_write_marker_script "$agent_dir"

  cat >"$agent_dir/start-delayed-mcp.sh" <<'EOF'
#!/bin/sh
set -eu
node /code/write-marker.js "$WORKSPACE_PATH/markers/mcp-started.txt"
sleep "${MCP_DELAY_MS:-0}"
node /code/write-marker.js "$WORKSPACE_PATH/markers/mcp-launched.txt"
exec sh /Agent/server/AgentServer.sh
EOF

  cat >"$agent_dir/tools/ready_tool.sh" <<'EOF'
#!/bin/sh
echo '{"content":[{"type":"text","text":"ok"}]}'
EOF

  cat >"$agent_dir/mcp-config.json" <<'EOF'
{
  "tools": [
    {
      "name": "ready_ping",
      "title": "Ready Ping",
      "description": "Return a static readiness payload.",
      "command": "tools/ready_tool.sh",
      "cwd": "workspace",
      "inputSchema": {}
    }
  ]
}
EOF

  chmod +x "$agent_dir/start-delayed-mcp.sh" "$agent_dir/tools/ready_tool.sh"

  cat >"$agent_dir/manifest.json" <<EOF
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "agent": "sh /code/start-delayed-mcp.sh",
  "enable": ${enable_json},
  "profiles": {
    "default": {
      "env": {
        "MCP_DELAY_MS": "${delay_ms}"
      }
    }
  }
}
EOF
}

fast_graph_start_workspace() {
  local workspace="$1"
  local agent_name="$2"
  local router_port="$3"
  local start_log="$4"
  local static_timeout_ms="${5:-12000}"
  local dep_timeout_ms="${6:-12000}"

  mkdir -p "$(dirname "$start_log")"

  (
    cd "$workspace"
    PLOINKY_STATIC_AGENT_READY_TIMEOUT_MS="$static_timeout_ms" \
    PLOINKY_DEPENDENCY_AGENT_READY_TIMEOUT_MS="$dep_timeout_ms" \
    PLOINKY_STATIC_AGENT_READY_INTERVAL_MS=100 \
    PLOINKY_DEPENDENCY_AGENT_READY_INTERVAL_MS=100 \
    PLOINKY_STATIC_AGENT_READY_PROBE_TIMEOUT_MS=250 \
    PLOINKY_DEPENDENCY_AGENT_READY_PROBE_TIMEOUT_MS=250 \
    ploinky start "$agent_name" "$router_port" >"$start_log" 2>&1
  )
}

fast_graph_wait_for_router_port() {
  local router_port="$1"
  local start_log="${2:-}"
  local attempts=80
  local delay=0.25
  local i

  for (( i=0; i<attempts; i++ )); do
    if curl -fsS "http://127.0.0.1:${router_port}/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  if [[ -n "$start_log" && -f "$start_log" ]]; then
    echo "Router on port ${router_port} did not become ready. Start log follows:" >&2
    cat "$start_log" >&2
  else
    echo "Router on port ${router_port} did not become ready." >&2
  fi
  return 1
}

fast_graph_assert_http_route_contains() {
  local workspace="$1"
  local route_key="$2"
  local route_path="$3"
  local expected="$4"
  local routing_file="$workspace/.ploinky/routing.json"
  local host_port
  local url
  local attempts=20
  local delay=0.25
  local i

  host_port=$(read_route_host_port "$routing_file" "$route_key") || {
    echo "Route '${route_key}' missing from '${routing_file}'." >&2
    return 1
  }
  url="http://127.0.0.1:${host_port}${route_path}"
  for (( i=0; i<attempts; i++ )); do
    if assert_http_response_contains "$url" "$expected" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  assert_http_response_contains "$url" "$expected"
}

fast_graph_assert_route_missing() {
  local workspace="$1"
  local route_key="$2"
  local routing_file="$workspace/.ploinky/routing.json"

  if read_route_host_port "$routing_file" "$route_key" >/dev/null 2>&1; then
    echo "Route '${route_key}' unexpectedly exists in '${routing_file}'." >&2
    return 1
  fi
}

fast_test_recursive_dependency_graph_startup() (
  set -euo pipefail

  local workspace
  local router_port
  local repo_root
  local start_log

  workspace=$(mktemp -d -t ploinky-graph-start-XXXXXX)
  trap "fast_graph_cleanup_workspace $(printf '%q' "$workspace")" EXIT

  router_port=$(allocate_port)
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_start_http_agent "$repo_root" "tcpLeaf" "1200" '[]' 'tcp-leaf-ok'
  fast_graph_create_delayed_mcp_agent "$repo_root" "mcpLeaf" "1" '[]'
  fast_graph_create_start_http_agent "$repo_root" "mid" "0" '["tcpLeaf", "mcpLeaf"]' 'mid-ok'
  fast_graph_create_start_http_agent "$repo_root" "root" "0" '["mid"]' 'root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
    ploinky enable agent graphRepo/root >/dev/null 2>&1
  )

  start_log="$workspace/.ploinky/logs/recursive-dependency-start.log"
  fast_graph_start_workspace "$workspace" "root" "$router_port" "$start_log"
  fast_graph_wait_for_router_port "$router_port" "$start_log"

  find_file_pattern_line "$start_log" "[start] Dependency wave 1/3: mcpLeaf, tcpLeaf" >/dev/null
  assert_file_pattern_before "$start_log" "[start] mcpLeaf: ready after" "[start] Dependency wave 2/3: mid"
  assert_file_pattern_before "$start_log" "[start] tcpLeaf: ready after" "[start] Dependency wave 2/3: mid"
  assert_file_pattern_before "$start_log" "[start] mid: ready after" "[start] Dependency wave 3/3: root"
  find_file_pattern_line "$start_log" "[start] root: ready after" >/dev/null
  fast_graph_assert_http_route_contains "$workspace" "root" "/health" '"ok":true'
)

fast_test_dependency_readiness_protocol_override() (
  set -euo pipefail

  local workspace
  local router_port
  local repo_root
  local start_log

  workspace=$(mktemp -d -t ploinky-graph-override-XXXXXX)
  trap "fast_graph_cleanup_workspace $(printf '%q' "$workspace")" EXIT

  router_port=$(allocate_port)
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_agent_http_agent "$repo_root" "overrideDep" "0" '[]' 'override-dep-ok' 'tcp'
  fast_graph_create_start_http_agent "$repo_root" "root" "0" '["overrideDep"]' 'root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
    ploinky enable agent graphRepo/root >/dev/null 2>&1
  )

  start_log="$workspace/.ploinky/logs/override-start.log"
  fast_graph_start_workspace "$workspace" "root" "$router_port" "$start_log"
  fast_graph_wait_for_router_port "$router_port" "$start_log"

  assert_file_pattern_before "$start_log" "[start] overrideDep: ready after" "[start] Dependency wave 2/2: root"
  fast_graph_assert_http_route_contains "$workspace" "overrideDep" "/health" '"ok":true'
  fast_graph_assert_http_route_contains "$workspace" "root" "/health" '"ok":true'
)

fast_test_static_start_only_tcp_readiness() (
  set -euo pipefail

  local workspace
  local router_port
  local repo_root
  local start_log

  workspace=$(mktemp -d -t ploinky-static-tcp-XXXXXX)
  trap "fast_graph_cleanup_workspace $(printf '%q' "$workspace")" EXIT

  router_port=$(allocate_port)
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_start_http_agent "$repo_root" "root" "0" '[]' 'static-root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
    ploinky enable agent graphRepo/root >/dev/null 2>&1
  )

  start_log="$workspace/.ploinky/logs/static-start.log"
  fast_graph_start_workspace "$workspace" "root" "$router_port" "$start_log"
  fast_graph_wait_for_router_port "$router_port" "$start_log"

  find_file_pattern_line "$start_log" "[start] root: ready after" >/dev/null
  fast_graph_assert_http_route_contains "$workspace" "root" "/" 'static-root-ok'
)

fast_test_dependency_failure_blocks_router_startup() (
  set -euo pipefail

  local workspace
  local router_port
  local repo_root
  local start_log

  workspace=$(mktemp -d -t ploinky-broken-dep-XXXXXX)
  trap "fast_graph_cleanup_workspace $(printf '%q' "$workspace")" EXIT

  router_port=$(allocate_port)
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_agent_http_agent "$repo_root" "brokenDep" "0" '[]' 'broken-dep-ok'
  fast_graph_create_start_http_agent "$repo_root" "root" "0" '["brokenDep"]' 'root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
    ploinky enable agent graphRepo/root >/dev/null 2>&1
  )

  start_log="$workspace/.ploinky/logs/broken-dependency-start.log"
  fast_graph_start_workspace "$workspace" "root" "$router_port" "$start_log" "4000" "3000"

  find_file_pattern_line "$start_log" "Dependent agent 'brokenDep' did not become ready within 3000ms." >/dev/null
  assert_port_not_listening "$router_port"
  assert_file_not_exists "$workspace/.ploinky/running/router.pid"
  fast_graph_assert_route_missing "$workspace" "root"
)

fast_test_startup_config_provider_preflight() (
  set -euo pipefail

  local workspace
  local router_port
  local repo_root
  local provider_dir
  local root_dir
  local start_log
  local echo_output
  local metadata_file

  workspace=$(mktemp -d -t ploinky-config-provider-XXXXXX)
  trap "fast_graph_cleanup_workspace $(printf '%q' "$workspace")" EXIT

  router_port=$(allocate_port)
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"
  provider_dir="$repo_root/provider"
  root_dir="$repo_root/root"

  mkdir -p "$provider_dir" "$root_dir"
  fast_graph_write_http_service_script "$provider_dir"

  cat >"$provider_dir/provider.js" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
if (!workspaceRoot) {
  process.exit(2);
}
const markerDir = path.join(workspaceRoot, 'markers');
fs.mkdirSync(markerDir, { recursive: true });
fs.writeFileSync(
  path.join(markerDir, 'provider-env.txt'),
  process.env.PLOINKY_MASTER_KEY ? 'present' : 'absent',
  'utf8'
);
process.stdout.write(JSON.stringify({
  version: 1,
  values: [
    {
      name: 'TEST_PROVIDER_VALUE',
      value: 'from-shell-provider',
      sensitive: false,
      source: 'generated'
    }
  ],
  warnings: []
}));
EOF

  cat >"$provider_dir/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "start": "node /code/delayed-http.js",
  "providesConfig": {
    "command": "node provider.js",
    "outputs": [
      { "name": "TEST_PROVIDER_VALUE", "sensitive": false }
    ]
  },
  "profiles": {
    "default": {
      "env": {
        "RESPONSE_TEXT": "provider-ok"
      }
    }
  }
}
EOF

  cat >"$root_dir/root.js" <<'EOF'
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 7000);
const providerValue = process.env.TEST_PROVIDER_VALUE || '';
const workspacePath = process.env.WORKSPACE_PATH || process.cwd();
const markerDir = path.join(workspacePath, 'markers');
fs.mkdirSync(markerDir, { recursive: true });
fs.writeFileSync(path.join(markerDir, 'root-provider-value.txt'), providerValue, 'utf8');

http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, provider: providerValue }));
}).listen(port, '0.0.0.0');
EOF

  cat >"$root_dir/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "start": "node /code/root.js",
  "configProviders": [
    { "agent": "graphRepo/provider", "profile": "default" }
  ],
  "profiles": {
    "default": {
      "env": [
        { "name": "TEST_PROVIDER_VALUE", "required": true }
      ]
    }
  }
}
EOF

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
    ploinky enable agent graphRepo/root >/dev/null 2>&1
  )

  start_log="$workspace/.ploinky/logs/config-provider-start.log"
  (
    cd "$workspace"
    PLOINKY_MASTER_KEY="shell-master-key" \
    PLOINKY_STATIC_AGENT_READY_TIMEOUT_MS=12000 \
    PLOINKY_STATIC_AGENT_READY_INTERVAL_MS=100 \
    PLOINKY_STATIC_AGENT_READY_PROBE_TIMEOUT_MS=250 \
    ploinky start root "$router_port" >"$start_log" 2>&1
  )
  fast_graph_wait_for_router_port "$router_port" "$start_log"

  find_file_pattern_line "$start_log" "[start] Startup config providers applied: TEST_PROVIDER_VALUE" >/dev/null
  assert_file_contains "$workspace/markers/provider-env.txt" "absent"
  assert_file_contains "$workspace/markers/root-provider-value.txt" "from-shell-provider"
  fast_graph_assert_http_route_contains "$workspace" "root" "/health" '"provider":"from-shell-provider"'

  echo_output=$(
    cd "$workspace"
    PLOINKY_MASTER_KEY="shell-master-key" ploinky echo TEST_PROVIDER_VALUE
  )
  if [[ "$echo_output" != *"TEST_PROVIDER_VALUE=from-shell-provider"* ]]; then
    echo "Expected ploinky echo to include provider value; got: $echo_output" >&2
    return 1
  fi

  metadata_file="$workspace/.ploinky/config-providers/provider.json"
  assert_file_contains "$metadata_file" "TEST_PROVIDER_VALUE"
  if grep -q "from-shell-provider" "$metadata_file"; then
    echo "Provider metadata must not contain raw output values." >&2
    return 1
  fi
)
