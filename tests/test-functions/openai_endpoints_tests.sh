fast_openai_chat_completions() {
  local output
  output=$(PLOINKY_ROUTER_URL="http://127.0.0.1:${TEST_ROUTER_PORT}" \
    PLOINKY_AGENT_LIB_DIR="${PLOINKY_AGENT_LIB_DIR:-$TESTS_DIR/../Agent}" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
const agentLibDir = process.env.PLOINKY_AGENT_LIB_DIR || '/Agent';
const { createAgentHttpClient } = await import(`${agentLibDir}/client/AgentHttpClient.mjs`);

const client = createAgentHttpClient();
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
  output=$(PLOINKY_ROUTER_URL="http://127.0.0.1:${TEST_ROUTER_PORT}" \
    PLOINKY_AGENT_LIB_DIR="${PLOINKY_AGENT_LIB_DIR:-$TESTS_DIR/../Agent}" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
const agentLibDir = process.env.PLOINKY_AGENT_LIB_DIR || '/Agent';
const { createAgentHttpClient } = await import(`${agentLibDir}/client/AgentHttpClient.mjs`);

const client = createAgentHttpClient();
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

fast_openai_capabilities() {
  local output
  output=$(PLOINKY_ROUTER_URL="http://127.0.0.1:${TEST_ROUTER_PORT}" \
    PLOINKY_AGENT_LIB_DIR="${PLOINKY_AGENT_LIB_DIR:-$TESTS_DIR/../Agent}" \
    TEST_OPENAI_AGENT_NAME="$TEST_OPENAI_AGENT_NAME" \
    node --input-type=module <<'NODE'
const agentLibDir = process.env.PLOINKY_AGENT_LIB_DIR || '/Agent';
const { createAgentHttpClient } = await import(`${agentLibDir}/client/AgentHttpClient.mjs`);

const client = createAgentHttpClient();
const response = await client.capabilities();
process.stdout.write(JSON.stringify(response));
NODE
  )
  if ! echo "$output" | jq -e --arg agent "$TEST_OPENAI_AGENT_NAME" '.agents | map(select(.name == $agent)) | length == 1' >/dev/null; then
    echo "Capabilities missing expected agent: $output" >&2
    return 1
  fi
  if ! echo "$output" | jq -e --arg agent "$TEST_OPENAI_AGENT_NAME" '.agents[] | select(.name == $agent) | .payload.capabilities.tags | index("fast")' >/dev/null; then
    echo "Capabilities missing expected tags: $output" >&2
    return 1
  fi
  if ! echo "$output" | jq -e --arg agent "$TEST_OPENAI_AGENT_NAME" '.agents[] | select(.name == $agent) | .payload.capabilities.summary | length > 0' >/dev/null; then
    echo "Capabilities missing summary: $output" >&2
    return 1
  fi
}
