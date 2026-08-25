#!/bin/bash
set -euo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$TESTS_DIR/lib.sh"

test_info "Preparing isolated workspace for fast suite."

TEST_REPO_NAME="testRepo"
TEST_AGENT_NAME="testAgent"
TEST_AGENT_QUALIFIED="${TEST_REPO_NAME}/${TEST_AGENT_NAME}"
write_state_var "TEST_REPO_NAME" "$TEST_REPO_NAME"
write_state_var "TEST_AGENT_NAME" "$TEST_AGENT_NAME"
write_state_var "TEST_AGENT_QUALIFIED" "$TEST_AGENT_QUALIFIED"
HEALTH_AGENT_NAME="healthProbes"
write_state_var "TEST_HEALTH_AGENT_NAME" "$HEALTH_AGENT_NAME"
TEST_AGENT_TO_DISABLE_NAME="agentToBeDisabled"
TEST_AGENT_TO_DISABLE_QUALIFIED="${TEST_REPO_NAME}/${TEST_AGENT_TO_DISABLE_NAME}"
write_state_var "TEST_AGENT_TO_DISABLE_NAME" "$TEST_AGENT_TO_DISABLE_NAME"
write_state_var "TEST_AGENT_TO_DISABLE_QUALIFIED" "$TEST_AGENT_TO_DISABLE_QUALIFIED"
write_state_var "TEST_AGENT_TO_DISABLE_SHOULD_START" "1"
write_state_var "TEST_AGENT_TO_DISABLE_EXPECT_RUNNING" "1"
TEST_AGENT_DEP_GLOBAL_NAME="testAgentDepGlobal"
write_state_var "TEST_AGENT_DEP_GLOBAL_NAME" "$TEST_AGENT_DEP_GLOBAL_NAME"
TEST_AGENT_DEP_DEVEL_NAME="testAgentDepDevel"
write_state_var "TEST_AGENT_DEP_DEVEL_NAME" "$TEST_AGENT_DEP_DEVEL_NAME"
ENABLE_ALIAS_AGENT_NAME="enableAliasAgent"
ENABLE_ALIAS_AGENT_ALIAS="aliasAgent"
write_state_var "TEST_ENABLE_ALIAS_AGENT_NAME" "$ENABLE_ALIAS_AGENT_NAME"
write_state_var "TEST_ENABLE_ALIAS_AGENT_ALIAS" "$ENABLE_ALIAS_AGENT_ALIAS"
OPENAI_AGENT_NAME="openaiAgent"
write_state_var "TEST_OPENAI_AGENT_NAME" "$OPENAI_AGENT_NAME"

if [[ -z "${TEST_RUN_DIR:-}" ]]; then
  TEST_RUN_DIR=$(mktemp -d -t ploinky-fast-XXXXXX)
  write_state_var "TEST_RUN_DIR" "$TEST_RUN_DIR"
fi
TEST_ROUTER_HEALTH_SOCKET="/tmp/ploinky-router-${TEST_RUN_DIR##*.}.sock"
write_state_var "TEST_ROUTER_HEALTH_SOCKET" "$TEST_ROUTER_HEALTH_SOCKET"

test_info "Workspace root: $TEST_RUN_DIR"

cd "$TEST_RUN_DIR"

if command -v bwrap >/dev/null 2>&1; then
  FAST_AGENT_RUNTIME="bwrap"
elif [[ "$(uname -s)" == "Darwin" ]] && command -v sandbox-exec >/dev/null 2>&1; then
  FAST_AGENT_RUNTIME="seatbelt"
else
  FAST_AGENT_RUNTIME="container"
fi
write_state_var "FAST_AGENT_RUNTIME" "$FAST_AGENT_RUNTIME"
test_info "Agent runtime: $FAST_AGENT_RUNTIME"

if [[ -z "${FAST_CONTAINER_RUNTIME:-}" ]]; then
  runtime=$(detect_container_runtime)
  write_state_var "FAST_CONTAINER_RUNTIME" "$runtime"
  test_info "Detected container runtime: $runtime"
fi

# Initialize the complete trusted graph source set before this fixture
# customizes routing. A partial source set is intentionally rejected. Import
# the initializer directly so fixture setup does not clone default boot repos.
edge_generation_module="$TESTS_DIR/../cli/sandbox/edgeGeneration.js"
node --import "$TESTS_DIR/helpers/agentlibTestContract.mjs" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const edge = await import(pathToFileURL(process.argv[1]).href);
  edge.initializeFreshEdgeRoutingSources({ workspaceRoot: process.cwd() });
' "$edge_generation_module"

# The runtime contract exposes one exact Router TCP mapping.
router_port=8080
write_state_var "TEST_ROUTER_PORT" "$router_port"
test_info "Using Router contract port: $router_port"

mkdir -p "$TEST_RUN_DIR/.ploinky"
cat >"$TEST_RUN_DIR/.ploinky/routing.json" <<EOF
{
  "port": ${router_port}
}
EOF

repo_root=".ploinky/repos/${TEST_REPO_NAME}"
agent_root="${repo_root}/${TEST_AGENT_NAME}"
mkdir -p "$agent_root"
test_info "Bootstrapped repository skeleton at ${agent_root}."
write_state_var "TEST_AGENT_REPO_PATH" "$agent_root"

agent_host_port=$(allocate_port)
write_state_var "TEST_AGENT_HOST_PORT" "$agent_host_port"
test_info "Assigned host port ${agent_host_port} for ${TEST_AGENT_NAME}."

manifest_template="${TESTS_DIR}/testAgent/manifest.json"
script_template="${TESTS_DIR}/testAgent/testSSOParams.sh"

sed "s/__HOST_PORT__/${agent_host_port}/g" "$manifest_template" >"${agent_root}/manifest.json"
cp "$script_template" "${agent_root}/testSSOParams.sh"
chmod +x "${agent_root}/testSSOParams.sh"

cp "${TESTS_DIR}/testAgent/server.js" "${agent_root}/server.js"
cp "${TESTS_DIR}/testAgent/mock_shell.sh" "${agent_root}/mock_shell.sh"
cp "${TESTS_DIR}/testAgent/start_script.sh" "${agent_root}/start_script.sh"

# Provide a predictable static asset for router tests (served via /${TEST_AGENT_NAME}/...).
printf 'fast-static-ok' >"${agent_root}/fast-static.txt"
write_state_var "TEST_STATIC_ASSET_PATH" "/${TEST_AGENT_NAME}/fast-static.txt"
write_state_var "TEST_STATIC_ASSET_EXPECTED" "fast-static-ok"

openai_agent_root="${repo_root}/${OPENAI_AGENT_NAME}"
mkdir -p "$openai_agent_root"

cat >"${openai_agent_root}/openai-chat.js" <<'EOF'
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input || '{}'); } catch (_) { payload = {}; }
  const request = payload.request && typeof payload.request === 'object' ? payload.request : {};
  const messages = Array.isArray(request.messages) ? request.messages : [];
  let lastUser = 'hello';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === 'user' && typeof msg.content === 'string') {
      lastUser = msg.content;
      break;
    }
  }
  const created = Math.floor(Date.now() / 1000);
  const content = `echo:${lastUser}`;
  const model = typeof request.model === 'string' && request.model.trim() ? request.model.trim() : 'demo-chat';
  if (request.stream === true) {
    const chunk = {
      id: 'chatcmpl-stream-demo',
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }]
    };
    process.stdout.write(`data: ${JSON.stringify(chunk)}\n\n`);
    process.stdout.write('data: [DONE]\n\n');
    return;
  }
  const response = {
    id: 'chatcmpl-demo',
    object: 'chat.completion',
    created,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
  process.stdout.write(JSON.stringify(response));
});
EOF

cat >"${openai_agent_root}/manifest.json" <<EOF
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "endpoints": {
    "chatCompletions": {
      "command": "node",
      "args": ["/code/openai-chat.js"],
      "supportsStream": true
    },
    "agent-card": {
      "tags": ["fast", "coding"],
      "summary": "Test agent for OpenAI-compatible chat completions.",
      "whenToUse": "Use for validating AgentServer OpenAI endpoints in the test suite.",
      "input": {
        "conventions": "Send OpenAI chat-completions payloads with messages[].content.",
        "schema": {
          "type": "object",
          "properties": {
            "messages": { "type": "array" },
            "stream": { "type": "boolean" }
          }
        }
      }
    }
  }
}
EOF

# Agent used to exercise disable flows later in the suite
disable_agent_root="${repo_root}/${TEST_AGENT_TO_DISABLE_NAME}"
mkdir -p "$disable_agent_root"

cat >"${disable_agent_root}/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "agent": "node -e \"setInterval(()=>{}, 1_000_000)\"",
  "readiness": {
    "protocol": "none"
  }
}
EOF
# Agent used to verify health probe behaviour
health_agent_root="${repo_root}/${HEALTH_AGENT_NAME}"
mkdir -p "$health_agent_root"
write_state_var "TEST_HEALTH_AGENT_REPO_PATH" "$health_agent_root"

cat >"${health_agent_root}/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "start": "node -e \"setInterval(()=>{}, 1_000_000)\"",
  "health": {
    "liveness": {
      "script": "liveness_probe.sh",
      "interval": 0.2,
      "timeout": 1,
      "failureThreshold": 1,
      "successThreshold": 1
    },
    "readiness": {
      "script": "readiness_probe.sh",
      "interval": 0.2,
      "timeout": 1,
      "failureThreshold": 1,
      "successThreshold": 1
    }
  }
}
EOF

cat >"${health_agent_root}/liveness_probe.sh" <<'EOF'
#!/bin/sh
echo live
EOF

cat >"${health_agent_root}/readiness_probe.sh" <<'EOF'
#!/bin/sh
echo ready
EOF

chmod +x "${health_agent_root}/liveness_probe.sh" "${health_agent_root}/readiness_probe.sh"
# Dependency agent that will be enabled in global mode via manifest
dep_agent_root="${repo_root}/${TEST_AGENT_DEP_GLOBAL_NAME}"
mkdir -p "$dep_agent_root"

cat >"${dep_agent_root}/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "profiles": {
    "default": {
      "postinstall": "echo 'postinstall_ok' > \"$WORKSPACE_PATH/postinstall_marker.txt\""
    }
  }
}
EOF

# Dependency agent that will be enabled in devel mode via manifest
dep_devel_root="${repo_root}/${TEST_AGENT_DEP_DEVEL_NAME}"
mkdir -p "$dep_devel_root"

cat >"${dep_devel_root}/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye",
  "start": "node -e \"require('net').createServer(()=>{}).listen(Number(process.env.PORT||7000), '0.0.0.0'); setInterval(()=>{}, 1_000_000)\"",
  "readiness": {
    "protocol": "tcp",
    "port": 7000
  }
}
EOF

# Agent used to verify manifest-enable alias support
enable_alias_agent_root="${repo_root}/${ENABLE_ALIAS_AGENT_NAME}"
mkdir -p "$enable_alias_agent_root"

cat >"${enable_alias_agent_root}/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye"
}
EOF

test_info "Enabling repository ${TEST_REPO_NAME}."
ploinky enable repo "$TEST_REPO_NAME"

# Use helper function to enable demo repo with optional branch from environment
enable_repo_with_branch "demo"

# Pre-clone manifest repos with branches before demo agent processes them
# These repos are referenced in demo's manifest.repos and need branch support for testing.
# webmeet is also pre-cloned so we can slim moderator's enable list before
# `ploinky start demo` triggers the recursive dependency-graph walk.
preclone_manifest_repo "fileExplorer" "https://github.com/AssistOS-AI/AssistOSExplorer.git"
preclone_manifest_repo "soplangBuilder" "https://github.com/AssistOS-AI/SOPLangBuilder.git"
preclone_manifest_repo "webmeet" "https://github.com/AssistOS-AI/webmeet.git"

# Trim cloned manifests to the minimum dependency surface required by
# testsAfterStart.sh. Without this, dependency-gated startup (see
# docs/dependency-gated-startup-implementation.md) cold-installs the entire
# AssistOSExplorer chain when `ploinky start demo` runs in doStart.sh, which
# blows past START_ACTION_TIMEOUT. testsAfterStart.sh only asserts that
# simulator/moderator/explorer are running and that explorer's preinstall +
# npm install ran — none of explorer's transitive deps are exercised.
slim_manifest_enable ".ploinky/repos/demo/demo/manifest.json" \
  '["demo/simulator","webmeet/moderator","fileExplorer/explorer global"]'
slim_manifest_enable ".ploinky/repos/fileExplorer/explorer/manifest.json" '[]'
slim_manifest_enable ".ploinky/repos/webmeet/moderator/manifest.json" '[]'

# moderator declares `agent: "node /code/server.js"` (HTTP, not MCP) but no
# `readiness.protocol` override, so the dependency-gated startup heuristic
# would classify it as `mcp` and forever wait on a /mcp handshake that
# server.js does not implement (the test in fast_check_moderator_get just
# does GET / over HTTP). Force the probe to TCP for the test workspace.
set_manifest_readiness_protocol ".ploinky/repos/webmeet/moderator/manifest.json" "tcp"

# Agent enables start their runtimes and synchronously attest the Router
# authority. The real Router is launched by doStart.sh, so all non-static
# enables are intentionally deferred until its private health socket is ready.
alias_agent_container=$(compute_container_name "$ENABLE_ALIAS_AGENT_ALIAS" "$TEST_REPO_NAME")
write_state_var "TEST_ENABLE_ALIAS_AGENT_CONTAINER" "$alias_agent_container"

# Create a global agent for testing global mode
test_info "Creating global-agent."
GLOBAL_AGENT_NAME="global-agent"
write_state_var "TEST_GLOBAL_AGENT_NAME" "$GLOBAL_AGENT_NAME"
global_agent_root="${repo_root}/${GLOBAL_AGENT_NAME}"
mkdir -p "$global_agent_root"

global_agent_host_port=$(allocate_port)
write_state_var "TEST_GLOBAL_AGENT_HOST_PORT" "$global_agent_host_port"
test_info "Assigned host port ${global_agent_host_port} for ${GLOBAL_AGENT_NAME}."

global_agent_internal_port=8888
write_state_var "TEST_GLOBAL_AGENT_CONTAINER_PORT" "$global_agent_internal_port"

cat >"${global_agent_root}/manifest.json" <<EOF
{
  "lite-sandbox": true,
  "container": "node:24.15.0-bullseye",
  "profiles": {
    "default": {
      "env": {
        "PORT": "${global_agent_internal_port}"
      },
      "openPorts": [
        "127.0.0.1:${global_agent_host_port}:${global_agent_internal_port}"
      ]
    }
  }
}
EOF

global_agent_container=$(compute_container_name "$GLOBAL_AGENT_NAME" "$TEST_REPO_NAME")
write_state_var "TEST_GLOBAL_AGENT_CONT_NAME" "$global_agent_container"

# Agent whose alias will be enabled via manifest directives
GLOBAL_ALIAS_AGENT_NAME="globalAgentForAlias"
GLOBAL_ALIAS_AGENT_ALIAS="globalAgentAlias"
write_state_var "TEST_GLOBAL_ALIAS_AGENT_NAME" "$GLOBAL_ALIAS_AGENT_NAME"
write_state_var "TEST_GLOBAL_AGENT_ALIAS" "$GLOBAL_ALIAS_AGENT_ALIAS"
global_alias_agent_root="${repo_root}/${GLOBAL_ALIAS_AGENT_NAME}"
mkdir -p "$global_alias_agent_root"

cat >"${global_alias_agent_root}/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye"
}
EOF

# Create a devel agent for testing devel mode
test_info "Creating devel-agent."
DEVEL_AGENT_NAME="devel-agent"
write_state_var "TEST_DEVEL_AGENT_NAME" "$DEVEL_AGENT_NAME"
devel_agent_root="${repo_root}/${DEVEL_AGENT_NAME}"
mkdir -p "$devel_agent_root"

cat >"${devel_agent_root}/manifest.json" <<'EOF'
{
  "lite-sandbox": true,
  "container": "node:20-bullseye"
}
EOF

test_info "Setting workspace-only env var FAST_PLOINKY_ONLY"
ploinky var FAST_PLOINKY_ONLY host-secret-value

test_info "Setting var testVar"
ploinky var testVar "123"

agent_container_name=$(compute_container_name "$TEST_AGENT_NAME" "$TEST_REPO_NAME")
write_state_var "TEST_AGENT_CONT_NAME" "$agent_container_name"
test_info "Service container will be named: $agent_container_name"

disable_agent_container_name=$(compute_container_name "$TEST_AGENT_TO_DISABLE_NAME" "$TEST_REPO_NAME")
write_state_var "TEST_AGENT_TO_DISABLE_CONT_NAME" "$disable_agent_container_name"
test_info "Disable-target container will be named: $disable_agent_container_name"

health_agent_container_name=$(compute_container_name "$HEALTH_AGENT_NAME" "$TEST_REPO_NAME")
write_state_var "TEST_HEALTH_AGENT_CONT_NAME" "$health_agent_container_name"
test_info "Health probe container will be named: $health_agent_container_name"

workspace_project="$TEST_RUN_DIR/.data/$TEST_AGENT_NAME"
write_state_var "TEST_AGENT_WORKSPACE" "$workspace_project"
write_state_var "TEST_PERSIST_FILE" "$workspace_project/data/fast-persist.txt"
write_state_var "TEST_AGENT_LOG" "$workspace_project/fast-start.log"
write_state_var "TEST_PERSIST_MARKER" "$workspace_project/data/manual-marker.txt"
write_state_var "TEST_AGENT_CONTAINER_PORT" "7000"

mkdir -p "$workspace_project/data"

test_info "Preparation step complete."
