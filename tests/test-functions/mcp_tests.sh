fast_mcp_client_status() {
  local output
  output=$(ploinky client status simulator 2>&1)
  if ! echo "$output" | grep -q 'ok=true'; then
    echo "Output from 'ploinky client status simulator' did not include 'ok=true'." >&2
    echo "Output:" >&2
    echo "$output" >&2
    return 1
  fi
}

fast_mcp_list_tools() {
  local output
  output=$(ploinky client list tools)
  if ! grep -q 'run_simulation' <<<"$output"; then
    echo "run_simulation not found in client list tools" >&2
    return 1
  fi
}

fast_mcp_run_simulation() {
  local output
  output=$(ploinky client tool run_simulation -iterations 10)
   if ! echo "$output" | jq -e '.content[0].text | fromjson | .ok == true' >/dev/null; then
     echo "run_simulation did not return ok:true. Output: $output" >&2
     return 1
   fi
}

fast_mcp_demo_async_task() {
  # Retry up to 15s — after restart the demo agent's MCP tools may not be
  # registered with the router yet (AgentServer still initialising).
  local attempts=15
  local i output
  for (( i=0; i<attempts; i++ )); do
    output=$(ploinky client tool demo_async_task)
    if echo "$output" | jq -e '.metadata.taskId' >/dev/null 2>&1; then
      if echo "$output" | jq -e '.content[0].text | contains("Task completed")' >/dev/null 2>&1; then
        return 0
      fi
    fi
    # Only retry if the tool was "not found" (agent not ready yet)
    if ! echo "$output" | grep -q "not found"; then
      break
    fi
    sleep 1
  done
  echo "demo_async_task failed after ${attempts}s. Output: $output" >&2
  return 1
}
