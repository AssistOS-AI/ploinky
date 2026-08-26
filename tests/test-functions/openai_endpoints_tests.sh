fast_openai_chat_completions() {
  local output
  output=$(PLOINKY_TEST_AGENTLIB_RUNTIME="$TESTS_DIR/../agentlib/runtime.mjs" \
    TEST_ROUTER_PORT="$TEST_ROUTER_PORT" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const runtimeUrl = pathToFileURL(process.env.PLOINKY_TEST_AGENTLIB_RUNTIME).href;
const { importAgentLib } = await import(runtimeUrl);
const { createAgentHttpClient } = await importAgentLib('PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs');

const routerPort = String(process.env.TEST_ROUTER_PORT || '');
if (!/^[1-9][0-9]{0,4}$/.test(routerPort) || Number(routerPort) > 65535) {
  throw new Error(`Invalid TEST_ROUTER_PORT: ${routerPort}`);
}
const client = createAgentHttpClient({
  routerUrl: `http://127.0.0.1:${routerPort}`,
  env: {},
});
const response = await client.chatCompletions(process.env.TEST_OPENAI_AGENT_NAME, {
  model: 'demo',
  messages: [{ role: 'user', content: 'ping' }]
});
process.stdout.write(JSON.stringify(response));
NODE
  )
  if ! echo "$output" | jq -e '.choices[0].message.content == "echo:ping"' >/dev/null; then
    echo "Unexpected chat completion response: $output" >&2
    return 1
  fi
}

fast_openai_chat_completions_stream() {
  local output
  output=$(PLOINKY_TEST_AGENTLIB_RUNTIME="$TESTS_DIR/../agentlib/runtime.mjs" \
    TEST_ROUTER_PORT="$TEST_ROUTER_PORT" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const runtimeUrl = pathToFileURL(process.env.PLOINKY_TEST_AGENTLIB_RUNTIME).href;
const { importAgentLib } = await import(runtimeUrl);
const { createAgentHttpClient } = await importAgentLib('PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs');

const routerPort = String(process.env.TEST_ROUTER_PORT || '');
if (!/^[1-9][0-9]{0,4}$/.test(routerPort) || Number(routerPort) > 65535) {
  throw new Error(`Invalid TEST_ROUTER_PORT: ${routerPort}`);
}
const client = createAgentHttpClient({
  routerUrl: `http://127.0.0.1:${routerPort}`,
  env: {},
});
const events = [];
for await (const event of client.chatCompletionsStream(process.env.TEST_OPENAI_AGENT_NAME, {
  model: 'demo',
  messages: [{ role: 'user', content: 'ping' }]
})) {
  events.push(event);
}
process.stdout.write(JSON.stringify(events));
NODE
  )
  if ! echo "$output" | jq -e 'map(select(.done == true)) | length > 0' >/dev/null; then
    echo "Streaming output missing DONE marker: $output" >&2
    return 1
  fi
  if ! echo "$output" | jq -e 'map(select(.json.object == "chat.completion.chunk")) | length > 0' >/dev/null; then
    echo "Streaming output missing chunk payload: $output" >&2
    return 1
  fi
  if ! echo "$output" | jq -e 'map(select(.json.choices[0].delta.content == "echo:ping")) | length > 0' >/dev/null; then
    echo "Streaming output missing expected content: $output" >&2
    return 1
  fi
}

fast_openai_agent_card() {
  local output
  output=$(PLOINKY_TEST_AGENTLIB_RUNTIME="$TESTS_DIR/../agentlib/runtime.mjs" \
    TEST_ROUTER_PORT="$TEST_ROUTER_PORT" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const runtimeUrl = pathToFileURL(process.env.PLOINKY_TEST_AGENTLIB_RUNTIME).href;
const { importAgentLib } = await import(runtimeUrl);
const { createAgentHttpClient } = await importAgentLib('PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs');

const routerPort = String(process.env.TEST_ROUTER_PORT || '');
if (!/^[1-9][0-9]{0,4}$/.test(routerPort) || Number(routerPort) > 65535) {
  throw new Error(`Invalid TEST_ROUTER_PORT: ${routerPort}`);
}
const client = createAgentHttpClient({
  routerUrl: `http://127.0.0.1:${routerPort}`,
  env: {},
});
const response = await client.agentCard();
process.stdout.write(JSON.stringify(response));
NODE
  )
  if ! echo "$output" | jq -e --arg agent "$TEST_OPENAI_AGENT_NAME" '.agents | map(select(.name == $agent)) | length == 1' >/dev/null; then
    echo "Agent-card missing expected agent: $output" >&2
    return 1
  fi
  if ! echo "$output" | jq -e --arg agent "$TEST_OPENAI_AGENT_NAME" '.agents[] | select(.name == $agent) | .payload["agent-card"].tags | index("fast")' >/dev/null; then
    echo "Agent-card missing expected tags: $output" >&2
    return 1
  fi
  if ! echo "$output" | jq -e --arg agent "$TEST_OPENAI_AGENT_NAME" '.agents[] | select(.name == $agent) | .payload["agent-card"].summary | length > 0' >/dev/null; then
    echo "Agent-card missing summary: $output" >&2
    return 1
  fi
}
