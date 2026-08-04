fast_openai_chat_completions() {
  local output
  output=$(FAST_ROUTER_ORIGIN="http://127.0.0.1:${TEST_ROUTER_PORT}" \
    PLOINKY_AGENT_LIB_DIR="${PLOINKY_AGENT_LIB_DIR:-$TESTS_DIR/../node_modules/achillesAgentLib}" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
const agentLibDir = process.env.PLOINKY_AGENT_LIB_DIR || '/code/node_modules/achillesAgentLib';
const { createAgentHttpClient } = await import(`${agentLibDir}/PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs`);

const client = createAgentHttpClient({ routerUrl: process.env.FAST_ROUTER_ORIGIN });
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
  output=$(FAST_ROUTER_ORIGIN="http://127.0.0.1:${TEST_ROUTER_PORT}" \
    PLOINKY_AGENT_LIB_DIR="${PLOINKY_AGENT_LIB_DIR:-$TESTS_DIR/../node_modules/achillesAgentLib}" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
const agentLibDir = process.env.PLOINKY_AGENT_LIB_DIR || '/code/node_modules/achillesAgentLib';
const { createAgentHttpClient } = await import(`${agentLibDir}/PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs`);

const client = createAgentHttpClient({ routerUrl: process.env.FAST_ROUTER_ORIGIN });
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
  output=$(FAST_ROUTER_ORIGIN="http://127.0.0.1:${TEST_ROUTER_PORT}" \
    PLOINKY_AGENT_LIB_DIR="${PLOINKY_AGENT_LIB_DIR:-$TESTS_DIR/../node_modules/achillesAgentLib}" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
const agentLibDir = process.env.PLOINKY_AGENT_LIB_DIR || '/code/node_modules/achillesAgentLib';
const { createAgentHttpClient } = await import(`${agentLibDir}/PloinkyAgentSkillsSubsystem/AgentHttpClient.mjs`);

const client = createAgentHttpClient({ routerUrl: process.env.FAST_ROUTER_ORIGIN });
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
