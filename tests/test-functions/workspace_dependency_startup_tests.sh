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

fast_graph_cleanup_latched_workspace() {
  local workspace="$1"
  local canonical_workspace
  local running_dir
  local cleanup_log
  local cleanup_failed=0
  local release_file
  local temporary_file
  local marker_file
  local status_name
  local status_path
  local terminal_observed
  local attempt
  local worker_pid
  local worker_command
  local router_manager_pid=""
  local router_listener_pid=""
  local router_port=""
  local runtime
  local container_name
  local instance_id
  local enable_generation
  local workspace_scope
  local network_name
  local labels
  local attached_containers
  local seen_scopes="|"
  local container_count=0
  local workspace_scope_count=0
  local -a runtimes=()
  local -a container_names=()
  local -a instance_ids=()
  local -a enable_generations=()
  local -a status_paths=()
  local -a workspace_scopes=()
  local -a workspace_scope_runtimes=()

  if [[ -z "$workspace" || ! -d "$workspace" ]]; then
    return 0
  fi
  canonical_workspace=$(cd "$workspace" && pwd -P)
  running_dir="$canonical_workspace/.ploinky/running/no-wait"
  cleanup_log="$workspace/.ploinky/logs/latched-no-wait-cleanup.log"
  mkdir -p "${cleanup_log%/*}"

  if [[ -f "$workspace/.ploinky/running/router.pid" ]]; then
    router_manager_pid=$(tr -d '[:space:]' <"$workspace/.ploinky/running/router.pid")
    [[ "$router_manager_pid" =~ ^[1-9][0-9]*$ ]] || router_manager_pid=""
  fi
  router_port=$(jq -r '.port // empty' "$workspace/.ploinky/routing.json" 2>/dev/null || true)
  if [[ "$router_port" =~ ^[1-9][0-9]*$ ]]; then
    router_listener_pid=$(lsof -nP -t -iTCP:"$router_port" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)
  else
    router_port=""
  fi

  if [[ -f "$workspace/.ploinky/agents.json" ]]; then
    while IFS=$'\t' read -r runtime container_name instance_id enable_generation; do
      [[ -n "$runtime" && -n "$container_name" ]] || continue
      case "$runtime" in
        podman|docker) ;;
        *) continue ;;
      esac
      runtimes+=("$runtime")
      container_names+=("$container_name")
      instance_ids+=("$instance_id")
      enable_generations+=("$enable_generation")
      container_count=$((container_count + 1))
    done < <(jq -r '
      to_entries[]
      | select(.value.type == "agent" and .value.repoName == "noWaitFixtureRepo")
      | [.value.runtime, .key, .value.instanceId, .value.enableGeneration]
      | @tsv
    ' "$workspace/.ploinky/agents.json")
  fi

  if [[ -d "$running_dir" ]]; then
    while IFS= read -r marker_file; do
      status_name=$(jq -r '.statusFile // empty' "$marker_file" 2>/dev/null || true)
      if [[ -n "$status_name" && "$status_name" == "${status_name##*/}" ]]; then
        status_paths+=("$running_dir/$status_name")
      fi
    done < <(find "$running_dir" -maxdepth 1 -type f -name '*.current.json' -print)
  fi

  # A failure can occur while detached no-wait workers are still blocked in
  # the fixture. Release only those test-owned latches, then require every
  # published worker to reach a terminal protocol state before destroy.
  for release_file in \
    "$workspace/.data/slowAgent/release-readiness" \
    "$workspace/.data/rotatorAgent/release-readiness"; do
    if [[ -d "${release_file%/*}" && ! -e "$release_file" ]]; then
      temporary_file="${release_file}.cleanup.$$"
      (
        umask 077
        printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$temporary_file"
        mv "$temporary_file" "$release_file"
      ) || true
    fi
  done

  for status_path in "${status_paths[@]-}"; do
    [[ -n "$status_path" ]] || continue
    terminal_observed=0
    for (( attempt=0; attempt<120; attempt++ )); do
      if [[ -f "$status_path" ]] \
        && jq -e '.state == "running" or .state == "failed"' "$status_path" >/dev/null 2>&1; then
        terminal_observed=1
        break
      fi
      sleep 0.25
    done
    if (( terminal_observed == 0 )); then
      printf 'No terminal no-wait status was published at %s.\n' "$status_path" >>"$cleanup_log"
      cleanup_failed=1
    fi
  done

  # A terminal status is fenced before the detached worker exits. Wait for
  # exact structured-argv workers from this workspace, then terminate only an
  # exact survivor so it cannot cross a launch boundary after destroy.
  for (( attempt=0; attempt<80; attempt++ )); do
    if ! ps -axo pid=,command= | awk -v root="$running_dir" '
      index($0, "/cli/commands/noWaitWorker.js ") &&
        index($0, "--status-file " root "/") { found=1 }
      END { exit(found ? 0 : 1) }
    '; then
      break
    fi
    sleep 0.25
  done
  while IFS= read -r worker_pid; do
    [[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] || continue
    worker_command=$(ps -p "$worker_pid" -o command= 2>/dev/null || true)
    if [[ "$worker_command" == *'/cli/commands/noWaitWorker.js '* \
      && "$worker_command" == *"--status-file ${running_dir}/"* ]]; then
      printf 'Detached no-wait worker %s survived terminal convergence.\n' "$worker_pid" >>"$cleanup_log"
      cleanup_failed=1
      kill -TERM "$worker_pid" 2>/dev/null || true
    fi
  done < <(ps -axo pid=,command= | awk -v root="$running_dir" '
    index($0, "/cli/commands/noWaitWorker.js ") &&
      index($0, "--status-file " root "/") { print $1 }
  ')
  for (( attempt=0; attempt<20; attempt++ )); do
    if ! ps -axo pid=,command= | awk -v root="$running_dir" '
      index($0, "/cli/commands/noWaitWorker.js ") &&
        index($0, "--status-file " root "/") { found=1 }
      END { exit(found ? 0 : 1) }
    '; then
      break
    fi
    sleep 0.25
  done
  while IFS= read -r worker_pid; do
    [[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] || continue
    worker_command=$(ps -p "$worker_pid" -o command= 2>/dev/null || true)
    if [[ "$worker_command" == *'/cli/commands/noWaitWorker.js '* \
      && "$worker_command" == *"--status-file ${running_dir}/"* ]]; then
      printf 'Detached no-wait worker %s ignored SIGTERM; sending SIGKILL.\n' "$worker_pid" >>"$cleanup_log"
      cleanup_failed=1
      kill -KILL "$worker_pid" 2>/dev/null || true
    fi
  done < <(ps -axo pid=,command= | awk -v root="$running_dir" '
    index($0, "/cli/commands/noWaitWorker.js ") &&
      index($0, "--status-file " root "/") { print $1 }
  ')

  # Capture the exact managed network scope while at least one registered
  # fixture container still exists. Networks are test-owned teardown state,
  # but are not removed by the ordinary destroy command.
  for (( attempt=0; attempt<container_count; attempt++ )); do
    runtime="${runtimes[$attempt]}"
    container_name="${container_names[$attempt]}"
    workspace_scope=$(
      "$runtime" container inspect "$container_name" \
        --format '{{ index .Config.Labels "io.assistos.ploinky.workspace" }}' 2>/dev/null || true
    )
    if [[ -n "$workspace_scope" && "$seen_scopes" != *"|${workspace_scope}|"* ]]; then
      workspace_scopes+=("$workspace_scope")
      workspace_scope_runtimes+=("$runtime")
      seen_scopes+="${workspace_scope}|"
      workspace_scope_count=$((workspace_scope_count + 1))
    fi
  done

  if ! (
    cd "$workspace" && ploinky destroy
  ) >>"$cleanup_log" 2>&1; then
    cleanup_failed=1
  fi

  # Prove every exact registered runtime is absent. If ordinary destroy left
  # one behind, remove only the record whose immutable labels still match and
  # fail the test so cleanup cannot silently mask the regression.
  for (( attempt=0; attempt<container_count; attempt++ )); do
    runtime="${runtimes[$attempt]}"
    container_name="${container_names[$attempt]}"
    instance_id="${instance_ids[$attempt]}"
    enable_generation="${enable_generations[$attempt]}"
    if "$runtime" container inspect "$container_name" >/dev/null 2>&1; then
      if "$runtime" container inspect "$container_name" | jq -e \
        --arg instance_id "$instance_id" \
        --arg enable_generation "$enable_generation" '
          .[0].Config.Labels["io.assistos.ploinky.managed"] == "1"
          and .[0].Config.Labels["io.assistos.ploinky.instance-id"] == $instance_id
          and .[0].Config.Labels["io.assistos.ploinky.enable-generation"] == $enable_generation
        ' >/dev/null 2>&1; then
        printf 'Ordinary destroy preserved exact fixture container %s.\n' "$container_name" >>"$cleanup_log"
        cleanup_failed=1
        "$runtime" container rm -f "$container_name" >>"$cleanup_log" 2>&1 || true
      else
        printf 'Refusing to remove container %s without exact fixture labels.\n' "$container_name" >>"$cleanup_log"
        cleanup_failed=1
      fi
    fi
    if "$runtime" container inspect "$container_name" >/dev/null 2>&1; then
      printf 'Exact fixture container %s still exists after cleanup.\n' "$container_name" >>"$cleanup_log"
      cleanup_failed=1
    fi
  done

  for (( attempt=0; attempt<workspace_scope_count; attempt++ )); do
    workspace_scope="${workspace_scopes[$attempt]}"
    runtime="${workspace_scope_runtimes[$attempt]}"
    while IFS= read -r network_name; do
      [[ -n "$network_name" ]] || continue
      labels=$("$runtime" network inspect "$network_name" --format '{{json .Labels}}' 2>/dev/null || true)
      attached_containers=$("$runtime" network inspect "$network_name" --format '{{json .Containers}}' 2>/dev/null || true)
      if [[ "$labels" == *'"io.assistos.ploinky.managed":"1"'* \
        && "$labels" == *"\"io.assistos.ploinky.workspace\":\"${workspace_scope}\""* \
        && $(jq -r 'if type == "object" and length == 0 then "empty" else "occupied" end' \
          <<<"${attached_containers:-null}" 2>/dev/null || true) == 'empty' ]]; then
        "$runtime" network rm "$network_name" >>"$cleanup_log" 2>&1 || cleanup_failed=1
      else
        printf 'Refusing to remove non-empty or foreign network %s.\n' "$network_name" >>"$cleanup_log"
        cleanup_failed=1
      fi
    done < <("$runtime" network ls \
      --filter "label=io.assistos.ploinky.workspace=${workspace_scope}" \
      --format '{{.Name}}')
    if "$runtime" network ls \
      --filter "label=io.assistos.ploinky.workspace=${workspace_scope}" \
      --format '{{.Name}}' | grep -q .; then
      printf 'Managed fixture networks still exist for workspace scope %s.\n' "$workspace_scope" >>"$cleanup_log"
      cleanup_failed=1
    fi
  done

  # Destroy uses bounded Router shutdown. Give the exact processes, listener,
  # and health socket the same bounded convergence window before proving they
  # are absent, so teardown does not mistake normal asynchronous exit for a
  # leak while still failing closed on a real survivor.
  for (( attempt=0; attempt<80; attempt++ )); do
    terminal_observed=1
    for worker_pid in "$router_listener_pid" "$router_manager_pid"; do
      if [[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$worker_pid" 2>/dev/null; then
        terminal_observed=0
      fi
    done
    if [[ -n "$router_port" ]] \
      && lsof -nP -iTCP:"$router_port" -sTCP:LISTEN >/dev/null 2>&1; then
      terminal_observed=0
    fi
    if [[ -n "${PLOINKY_ROUTER_HEALTH_SOCKET:-}" && -e "$PLOINKY_ROUTER_HEALTH_SOCKET" ]]; then
      terminal_observed=0
    fi
    (( terminal_observed == 1 )) && break
    sleep 0.25
  done

  for worker_pid in "$router_listener_pid" "$router_manager_pid"; do
    [[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] || continue
    if kill -0 "$worker_pid" 2>/dev/null; then
      printf 'Fixture Router process %s survived destroy.\n' "$worker_pid" >>"$cleanup_log"
      cleanup_failed=1
    fi
  done
  if ps -axo command= | awk -v root="$running_dir" '
    index($0, "/cli/commands/noWaitWorker.js ") &&
      index($0, "--status-file " root "/") { found=1 }
    END { exit(found ? 0 : 1) }
  '; then
    printf 'A detached no-wait worker still names the fixture status root.\n' >>"$cleanup_log"
    cleanup_failed=1
  fi
  if [[ -n "$router_port" ]] && lsof -nP -iTCP:"$router_port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Fixture Router port %s is still listening.\n' "$router_port" >>"$cleanup_log"
    cleanup_failed=1
  fi
  if [[ -n "${PLOINKY_ROUTER_HEALTH_SOCKET:-}" && -e "$PLOINKY_ROUTER_HEALTH_SOCKET" ]]; then
    printf 'Fixture Router health socket still exists at %s.\n' "$PLOINKY_ROUTER_HEALTH_SOCKET" >>"$cleanup_log"
    cleanup_failed=1
  fi

  if (( cleanup_failed != 0 )); then
    echo "Latched no-wait fixture cleanup failed; preserved evidence at '${workspace}'." >&2
    cat "$cleanup_log" >&2
    return 1
  fi
  rm -rf "$workspace"
}

fast_graph_finish_latched_workspace() {
  local workspace="$1"

  # The explicit final cleanup owns the only teardown attempt from this point.
  # Disarm the failure trap first so a nonzero cleanup result preserves its
  # evidence instead of invoking cleanup again against partially cleaned state.
  trap - EXIT
  fast_graph_cleanup_latched_workspace "$workspace"
}

fast_graph_init_workspace() {
  local workspace="$1"
  local router_port="$2"
  local repo_name="${3:-graphRepo}"

  PLOINKY_ROUTER_HEALTH_SOCKET="/tmp/ploinky-fast-${workspace##*.}.sock"
  export PLOINKY_ROUTER_HEALTH_SOCKET
  mkdir -p "$workspace/.ploinky/repos/${repo_name}"
  node --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const edge = await import(pathToFileURL(process.argv[1]).href);
    edge.initializeFreshEdgeRoutingSources({ workspaceRoot: process.argv[2] });
  ' "$TESTS_DIR/../cli/sandbox/edgeGeneration.js" "$workspace"
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
  "readiness": {
    "protocol": "tcp",
    "port": 7000
  },
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

  if ! (
    cd "$workspace"
    PLOINKY_STATIC_AGENT_READY_TIMEOUT_MS="$static_timeout_ms" \
    PLOINKY_DEPENDENCY_AGENT_READY_TIMEOUT_MS="$dep_timeout_ms" \
    PLOINKY_STATIC_AGENT_READY_INTERVAL_MS=100 \
    PLOINKY_DEPENDENCY_AGENT_READY_INTERVAL_MS=100 \
    PLOINKY_STATIC_AGENT_READY_PROBE_TIMEOUT_MS=250 \
    PLOINKY_DEPENDENCY_AGENT_READY_PROBE_TIMEOUT_MS=250 \
    ploinky start "$agent_name" "$router_port" >"$start_log" 2>&1
  ); then
    echo "Workspace graph start failed. Start log follows:" >&2
    cat "$start_log" >&2
    return 1
  fi
}

fast_graph_wait_for_router_port() {
  local router_port="$1"
  local start_log="${2:-}"
  local attempts=80
  local delay=0.25
  local i

  for (( i=0; i<attempts; i++ )); do
    if curl -sS -o /dev/null "http://127.0.0.1:${router_port}/status" 2>/dev/null; then
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
  local router_port
  local url
  local attempts=20
  local delay=0.25
  local i

  if ! jq -e --arg route_key "$route_key" '.routes[$route_key] | type == "object"' "$routing_file" >/dev/null; then
    echo "Route '${route_key}' missing from '${routing_file}'." >&2
    return 1
  fi
  router_port=$(jq -er '.port | select(type == "number" and . > 0)' "$routing_file")
  url="http://127.0.0.1:${router_port}/base-agent-additional-server/${route_key}/7000${route_path}"
  for (( i=0; i<attempts; i++ )); do
    if assert_http_response_contains "$url" "$expected" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done
  assert_http_response_contains "$url" "$expected"
}

fast_graph_assert_route_unpublished() {
  local workspace="$1"
  local route_key="$2"
  local routing_file="$workspace/.ploinky/routing.json"
  local selector_file="$workspace/.ploinky/data/edge-routing/active.json"
  local router_port
  local status

  if ! jq -e '.state != "active"' "$selector_file" >/dev/null; then
    echo "Route '${route_key}' unexpectedly belongs to an active edge generation." >&2
    return 1
  fi
  router_port=$(jq -er '.port | select(type == "number" and . > 0)' "$routing_file")
  status=$(curl -sS -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:${router_port}/base-agent-additional-server/${route_key}/7000/" 2>/dev/null || true)
  case "$status" in
    2??|3??)
      echo "Route '${route_key}' was reachable through inactive edge generation (HTTP ${status})." >&2
      return 1
      ;;
  esac
}

fast_test_recursive_dependency_graph_startup() (
  set -euo pipefail

  local workspace
  local router_port
  local repo_root
  local start_log

  workspace=$(mktemp -d -t ploinky-graph-start-XXXXXX)
  trap "fast_graph_cleanup_workspace $(printf '%q' "$workspace")" EXIT

  router_port=8080
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_start_http_agent "$repo_root" "tcpLeaf" "1200" '[]' 'tcp-leaf-ok'
  fast_graph_create_delayed_mcp_agent "$repo_root" "mcpLeaf" "1" '[]'
  fast_graph_create_start_http_agent "$repo_root" "mid" "0" '["tcpLeaf", "mcpLeaf"]' 'mid-ok'
  fast_graph_create_start_http_agent "$repo_root" "root" "0" '["mid"]' 'root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
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

  router_port=8080
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_agent_http_agent "$repo_root" "overrideDep" "0" '[]' 'override-dep-ok' 'tcp'
  fast_graph_create_start_http_agent "$repo_root" "root" "0" '["overrideDep"]' 'root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
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

  router_port=8080
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_start_http_agent "$repo_root" "root" "0" '[]' 'static-root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
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

  router_port=8080
  fast_graph_init_workspace "$workspace" "$router_port"
  repo_root="$workspace/.ploinky/repos/graphRepo"

  fast_graph_create_agent_http_agent "$repo_root" "brokenDep" "0" '[]' 'broken-dep-ok'
  fast_graph_create_start_http_agent "$repo_root" "root" "0" '["brokenDep"]' 'root-ok'

  (
    cd "$workspace"
    ploinky enable repo graphRepo >/dev/null 2>&1
  )

  start_log="$workspace/.ploinky/logs/broken-dependency-start.log"
  if fast_graph_start_workspace "$workspace" "root" "$router_port" "$start_log" "4000" "3000"; then
    echo "Broken dependency unexpectedly allowed workspace start." >&2
    return 1
  fi

  find_file_pattern_line "$start_log" "Dependent agent 'brokenDep' did not become ready within 3000ms." >/dev/null
  assert_port_listening "$router_port"
  assert_file_exists "$workspace/.ploinky/running/router.pid"
  fast_graph_assert_route_unpublished "$workspace" "root"
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

  router_port=8080
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
  "readiness": {
    "protocol": "tcp",
    "port": 7000
  },
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
  "readiness": {
    "protocol": "tcp",
    "port": 7000
  },
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
  )

  start_log="$workspace/.ploinky/logs/config-provider-start.log"
  if ! (
    cd "$workspace"
    PLOINKY_MASTER_KEY="shell-master-key" \
    PLOINKY_STATIC_AGENT_READY_TIMEOUT_MS=12000 \
    PLOINKY_STATIC_AGENT_READY_INTERVAL_MS=100 \
    PLOINKY_STATIC_AGENT_READY_PROBE_TIMEOUT_MS=250 \
    ploinky start root "$router_port" >"$start_log" 2>&1
  ); then
    echo "Config-provider workspace start failed. Start log follows:" >&2
    cat "$start_log" >&2
    if [[ -f "$workspace/.ploinky/logs/router.log" ]]; then
      echo "Router log follows:" >&2
      cat "$workspace/.ploinky/logs/router.log" >&2
    fi
    return 1
  fi
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

fast_graph_create_latched_no_wait_http_agent() {
  local repo_root="$1"
  local agent_name="$2"
  local response_text="$3"
  local agent_dir="${repo_root}/${agent_name}"

  mkdir -p "$agent_dir"
  cat >"$agent_dir/latched-http.js" <<'EOF'
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const workspacePath = process.env.WORKSPACE_PATH || process.cwd();
const blockedMarker = path.join(workspacePath, 'worker-starting-and-blocked');
const releaseFile = path.join(workspacePath, 'release-readiness');
const probeCountFile = path.join(workspacePath, 'startup-probe-header-count');
const port = Number(process.env.PORT || 7000);
const responseText = process.env.RESPONSE_TEXT || 'ready';
const readyElementId = process.env.READY_ELEMENT_ID || 'agent-ready';
const watchdogMs = Number(process.env.LATCH_WATCHDOG_MS || 180000);
const startedAt = Date.now();
let startupProbeHeaderCount = 0;

fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(probeCountFile, '0\n', 'utf8');
fs.writeFileSync(blockedMarker, `${new Date().toISOString()}\n`, { encoding: 'utf8', flag: 'wx' });

function recordProbeHeader(req) {
  if (Object.prototype.hasOwnProperty.call(req.headers, 'x-ploinky-agent-startup-probe')) {
    startupProbeHeaderCount += 1;
    fs.writeFileSync(probeCountFile, `${startupProbeHeaderCount}\n`, 'utf8');
  }
}

function responseHeaders(contentType) {
  return {
    'cache-control': 'no-store',
    'content-type': contentType,
    'x-test-startup-probe-count': String(startupProbeHeaderCount),
  };
}

function startServer() {
  const server = http.createServer((req, res) => {
    recordProbeHeader(req);
    if (req.url === '/index.html' || req.url === '/') {
      const body = `<!doctype html>
<html lang="en" data-agent-asset="pending">
<head><meta charset="utf-8"><title>Latched fixture ready</title></head>
<body><main id="${readyElementId}" data-startup-probe-count="${startupProbeHeaderCount}">${responseText}</main><script src="ready-asset.js"></script></body>
</html>`;
      res.writeHead(200, responseHeaders('text/html; charset=utf-8'));
      res.end(body);
      return;
    }
    if (req.url === '/ready-asset.js') {
      res.writeHead(200, responseHeaders('application/javascript; charset=utf-8'));
      res.end("document.documentElement.dataset.agentAsset = 'loaded';\n");
      return;
    }
    if (req.url === '/api/status' || req.url === '/health') {
      res.writeHead(200, responseHeaders('application/json; charset=utf-8'));
      res.end(JSON.stringify({ ok: true, startupProbeHeaderCount }));
      return;
    }
    if (req.url === '/favicon.ico') {
      res.writeHead(204, responseHeaders('image/x-icon'));
      res.end();
      return;
    }
    res.writeHead(404, responseHeaders('application/json; charset=utf-8'));
    res.end(JSON.stringify({ error: 'NOT_FOUND' }));
  });
  server.listen(port, '0.0.0.0');
}

const latchPoll = setInterval(() => {
  if (fs.existsSync(releaseFile)) {
    clearInterval(latchPoll);
    startServer();
    return;
  }
  if (Date.now() - startedAt >= watchdogMs) {
    clearInterval(latchPoll);
    process.stderr.write('latched fixture watchdog expired before release\n');
    process.exit(70);
  }
}, 50);
EOF

  cat >"$agent_dir/manifest.json" <<EOF
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "agent": "node /code/latched-http.js",
  "readiness": {
    "protocol": "tcp",
    "port": 7000
  },
  "routerAccess": {
    "httpRoutes": [
      { "path": "/index.html", "access": "public" },
      { "path": "/ready-asset.js", "access": "public" },
      { "path": "/api/status", "access": "public" },
      { "path": "/health", "access": "public" }
    ]
  },
  "profiles": {
    "default": {
      "env": {
        "LATCH_WATCHDOG_MS": "180000",
        "READY_ELEMENT_ID": "${response_text}",
        "RESPONSE_TEXT": "${response_text}"
      }
    }
  }
}
EOF
}

fast_graph_create_targetless_no_wait_agent() {
  local repo_root="$1"
  local agent_dir="${repo_root}/targetlessAgent"

  mkdir -p "$agent_dir"
  cat >"$agent_dir/targetless.js" <<'EOF'
const fs = require('node:fs');
const path = require('node:path');

const workspacePath = process.env.WORKSPACE_PATH || process.cwd();
fs.mkdirSync(workspacePath, { recursive: true });
fs.writeFileSync(
  path.join(workspacePath, 'targetless-running'),
  `${new Date().toISOString()}\n`,
  { encoding: 'utf8', flag: 'wx' }
);
setInterval(() => {}, 60000);
EOF

  cat >"$agent_dir/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "start": "node /code/targetless.js",
  "readiness": {
    "protocol": "none"
  },
  "routerAccess": {
    "httpRoutes": [
      { "path": "/index.html", "access": "public" }
    ]
  },
  "profiles": {
    "default": {
      "network": {
        "mode": "none"
      }
    }
  }
}
EOF
}

fast_graph_create_latched_no_wait_fixture() {
  local workspace="$1"
  local router_port="$2"
  local repo_root

  fast_graph_init_workspace "$workspace" "$router_port" "noWaitFixtureRepo"
  repo_root="$workspace/.ploinky/repos/noWaitFixtureRepo"
  fast_graph_create_latched_no_wait_http_agent "$repo_root" "slowAgent" "slow-agent-ready"
  fast_graph_create_latched_no_wait_http_agent "$repo_root" "rotatorAgent" "rotator-agent-ready"
  fast_graph_create_targetless_no_wait_agent "$repo_root"
  fast_graph_create_start_http_agent \
    "$repo_root" \
    "launcher" \
    "0" \
    '["slowAgent no-wait", "rotatorAgent no-wait", "targetlessAgent no-wait"]' \
    'launcher-ready'
}

fast_graph_wait_for_exact_file() {
  local target="$1"
  local label="$2"
  local attempts="${3:-480}"
  local i

  for (( i=0; i<attempts; i++ )); do
    if [[ -f "$target" ]]; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for ${label} at '${target}'." >&2
  return 1
}

fast_graph_release_latch_atomically() {
  local release_file="$1"
  local temporary_file="${release_file}.tmp.$$"

  if [[ -e "$release_file" || -e "$temporary_file" ]]; then
    echo "Latch release target already exists: '${release_file}'." >&2
    return 1
  fi
  (
    umask 077
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$temporary_file"
    mv "$temporary_file" "$release_file"
  )
}

fast_graph_startup_request() {
  local url="$1"
  local body_file="$2"
  local headers_file="$3"
  shift 3
  curl --http1.1 -sS --max-time 5 \
    -D "$headers_file" \
    -o "$body_file" \
    -w '%{http_code}' \
    "$@" \
    "$url"
}

fast_graph_wait_for_probe_state() {
  local url="$1"
  local expected_status="$2"
  local expected_state="$3"
  local body_file="$4"
  local headers_file="$5"
  local attempts="${6:-240}"
  local status
  local curl_exit=0
  local i

  for (( i=0; i<attempts; i++ )); do
    : >"$body_file"
    : >"$headers_file"
    if status=$(fast_graph_startup_request \
        "$url" "$body_file" "$headers_file" \
        -H 'Accept: application/json' \
        -H 'Sec-Fetch-Dest: empty' \
        -H 'Sec-Fetch-Mode: cors' \
        -H 'X-Ploinky-Agent-Startup-Probe: 1'); then
      curl_exit=0
    else
      curl_exit=$?
      status="curl_error"
    fi
    if [[ "$status" == "$expected_status" ]] \
      && jq -e --arg state "$expected_state" '.state == $state' "$body_file" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Probe did not reach state '${expected_state}' with HTTP ${expected_status}." >&2
  echo "Last observed probe status: ${status} (curl exit ${curl_exit})." >&2
  [[ -s "$body_file" ]] && cat "$body_file" >&2
  return 1
}

fast_test_latched_no_wait_loading_transition() (
  set -euo pipefail

  local workspace
  local router_port
  local start_log
  local slow_blocked
  local slow_release
  local rotator_blocked
  local rotator_release
  local targetless_marker
  local body_file
  local headers_file
  local route_url
  local targetless_url
  local initial_status
  local fetch_status
  local mcp_status
  local websocket_status
  local active_status
  local first_ready_generation
  local rotated_generation
  local fixture_socket

  workspace=$(mktemp -d -t ploinky-no-wait-latched-XXXXXX)
  trap "fast_graph_cleanup_latched_workspace $(printf '%q' "$workspace")" EXIT
  # The managed routing topology is deliberately persisted at the canonical
  # Router port. Test isolation comes from the temporary workspace and its
  # loopback-only runtime, not from mutating that topology contract.
  router_port=8080
  fast_graph_create_latched_no_wait_fixture "$workspace" "$router_port"
  fixture_socket="$PLOINKY_ROUTER_HEALTH_SOCKET"

  (
    cd "$workspace"
    ploinky enable repo noWaitFixtureRepo >/dev/null 2>&1
  )

  start_log="$workspace/.ploinky/logs/latched-no-wait-start.log"
  fast_graph_start_workspace "$workspace" "launcher" "$router_port" "$start_log"
  fast_graph_wait_for_router_port "$router_port" "$start_log"
  find_file_pattern_line "$start_log" "[start] launcher: ready after" >/dev/null

  slow_blocked="$workspace/.data/slowAgent/worker-starting-and-blocked"
  slow_release="$workspace/.data/slowAgent/release-readiness"
  rotator_blocked="$workspace/.data/rotatorAgent/worker-starting-and-blocked"
  rotator_release="$workspace/.data/rotatorAgent/release-readiness"
  targetless_marker="$workspace/.data/targetlessAgent/targetless-running"
  fast_graph_wait_for_exact_file "$slow_blocked" "slowAgent blocked marker"
  fast_graph_wait_for_exact_file "$rotator_blocked" "rotatorAgent blocked marker"
  fast_graph_wait_for_exact_file "$targetless_marker" "targetlessAgent running marker"
  [[ ! -e "$slow_release" ]]
  [[ ! -e "$rotator_release" ]]

  body_file="$workspace/response-body.json"
  headers_file="$workspace/response-headers.txt"
  route_url="http://127.0.0.1:${router_port}/slowAgent/index.html"
  targetless_url="http://127.0.0.1:${router_port}/targetlessAgent/index.html"

  initial_status=$(fast_graph_startup_request \
    "$route_url" "$body_file" "$headers_file" \
    -H 'Accept: text/html' \
    -H 'Sec-Fetch-Dest: document' \
    -H 'Sec-Fetch-Mode: navigate')
  [[ "$initial_status" == "503" ]]
  grep -Eiq '^content-type: text/html' "$headers_file"
  grep -Fq 'data-ploinky-agent-startup-page="starting"' "$body_file"
  grep -Fq 'This page will open automatically when it is ready.' "$body_file"
  if grep -Eiq 'runId|instanceId|enableGeneration|workerPid|statusFile|container(Id|Name)?|\.ploinky|/Users/|/root/|token|secret' "$body_file"; then
    echo "Startup document exposed a raw lifecycle or credential-like value." >&2
    return 1
  fi

  fast_graph_wait_for_probe_state "$route_url" "202" "starting" "$body_file" "$headers_file"
  jq -e '
    .state == "starting"
    and (.generation | test("^sha256:[a-f0-9]{64}$"))
    and .retryAfterMs == 1000
    and ((keys - ["generation", "retryAfterMs", "state"]) | length == 0)
  ' "$body_file" >/dev/null

  fetch_status=$(fast_graph_startup_request \
    "$route_url" "$body_file" "$headers_file" \
    -H 'Accept: application/json' \
    -H 'Sec-Fetch-Dest: empty' \
    -H 'Sec-Fetch-Mode: cors')
  [[ "$fetch_status" == "503" ]]
  jq -e '. == {"error":"TARGET_INACTIVE"}' "$body_file" >/dev/null
  grep -Eiq '^content-type: application/json' "$headers_file"

  mcp_status=$(fast_graph_startup_request \
    "http://127.0.0.1:${router_port}/slowAgent/mcp" "$body_file" "$headers_file" \
    -H 'Accept: application/json')
  [[ "$mcp_status" == "503" ]]
  ! grep -Fq 'data-ploinky-agent-startup-page=' "$body_file"

  websocket_status=$(fast_graph_startup_request \
    "$route_url" "$body_file" "$headers_file" \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==')
  [[ "$websocket_status" != "101" ]]
  ! grep -Fq 'data-ploinky-agent-startup-page=' "$body_file"

  initial_status=$(fast_graph_startup_request \
    "$targetless_url" "$body_file" "$headers_file" \
    -H 'Accept: text/html' \
    -H 'Sec-Fetch-Dest: document' \
    -H 'Sec-Fetch-Mode: navigate')
  [[ "$initial_status" == "503" ]]
  jq -e '. == {"error":"TARGET_INACTIVE"}' "$body_file" >/dev/null
  fast_graph_wait_for_probe_state "$targetless_url" "503" "unavailable" "$body_file" "$headers_file"
  jq -e '. == {
    "state":"unavailable",
    "code":"route_unavailable",
    "message":"This agent does not provide a web page."
  }' "$body_file" >/dev/null

  fast_graph_release_latch_atomically "$slow_release"
  fast_graph_wait_for_probe_state "$route_url" "200" "ready" "$body_file" "$headers_file"
  first_ready_generation=$(jq -er '.generation | select(test("^sha256:[a-f0-9]{64}$"))' "$body_file")
  jq -e '
    .routes.slowAgent.hostPort as $port
    | ($port | type) == "number"
      and $port == ($port | floor)
      and $port >= 1
      and $port <= 65535
  ' "$workspace/.ploinky/routing.json" >/dev/null

  active_status=$(fast_graph_startup_request \
    "$route_url" "$body_file" "$headers_file" \
    -H 'Accept: text/html' \
    -H 'Sec-Fetch-Dest: document' \
    -H 'Sec-Fetch-Mode: navigate')
  [[ "$active_status" == "200" ]]
  grep -Fq 'id="slow-agent-ready"' "$body_file"
  grep -Eiq '^x-test-startup-probe-count: 0' "$headers_file"
  assert_file_contains "$workspace/.data/slowAgent/startup-probe-header-count" "0"
  active_status=$(fast_graph_startup_request \
    "http://127.0.0.1:${router_port}/slowAgent/ready-asset.js" "$body_file" "$headers_file" \
    -H 'Accept: application/javascript')
  [[ "$active_status" == "200" ]]
  grep -Fq "dataset.agentAsset = 'loaded'" "$body_file"

  fast_graph_release_latch_atomically "$rotator_release"
  for (( active_status=0; active_status<240; active_status++ )); do
    fast_graph_wait_for_probe_state "$route_url" "200" "ready" "$body_file" "$headers_file" "1" || true
    rotated_generation=$(jq -r '.generation // ""' "$body_file" 2>/dev/null || true)
    if [[ "$rotated_generation" =~ ^sha256:[a-f0-9]{64}$ ]] \
      && [[ "$rotated_generation" != "$first_ready_generation" ]]; then
      break
    fi
    sleep 0.25
  done
  if [[ -z "$rotated_generation" || "$rotated_generation" == "$first_ready_generation" ]]; then
    echo "Explicit rotator release did not change the reported edge generation." >&2
    return 1
  fi
  assert_file_contains "$workspace/.data/slowAgent/startup-probe-header-count" "0"

  if ! fast_graph_finish_latched_workspace "$workspace"; then
    return 1
  fi
  [[ ! -e "$workspace" ]]
  [[ ! -e "$slow_blocked" ]]
  [[ ! -e "$slow_release" ]]
  [[ ! -e "$rotator_blocked" ]]
  [[ ! -e "$rotator_release" ]]
  [[ ! -e "$fixture_socket" ]]

  if [[ -n "${PLOINKY_NO_WAIT_LATCH_EVIDENCE_FILE:-}" ]]; then
    local ploinky_source_root
    ploinky_source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
    node "$ploinky_source_root/tests/release/noWaitLoadingEvidence.mjs" \
      record-latch-pass \
      --output "$PLOINKY_NO_WAIT_LATCH_EVIDENCE_FILE" \
      --repo-root "$ploinky_source_root"
  fi
)
