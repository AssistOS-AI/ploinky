#!/bin/bash

test_logs_tail_router() {
  load_state
  require_var "TEST_ROUTER_LOG" || return 1

  local router_log="$TEST_ROUTER_LOG"
  if [[ ! -f "$router_log" || ! -s "$router_log" ]]; then
    echo "Router log file '${router_log}' is missing or empty." >&2
    return 1
  fi

  local output=""
  local status=0
  output=$(timeout 2s "$PLOINKY_FAST_CLI" logs tail router 2>&1) || status=$?
  if (( status != 0 && status != 124 )); then
    echo "'ploinky logs tail router' failed with exit status ${status}." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  output=${output//$'\r'/}
  if [[ -z "${output//[[:space:]]/}" ]]; then
    echo "'ploinky logs tail router' produced no log output." >&2
    return 1
  fi
}

# Resolves the container key the log command must address for the fixture's
# demo agent, so no test hardcodes a specific agent identifier.
_logs_demo_container() {
  compute_container_name "simulator" "demo"
}

# Builds an isolated workspace holding only synthesized no-wait state. The log
# command is read-only, but pointing it at a scratch root keeps the live test
# workspace untouched.
_logs_scratch_workspace() {
  local root
  root=$(mktemp -d "${TMPDIR:-/tmp}/ploinky-logs-scratch.XXXXXX")
  mkdir -p "$root/.ploinky/logs/no-wait" "$root/.ploinky/running/no-wait"
  printf '%s' "$root"
}

# Writes a marker, a run-scoped status, and the matching run-scoped log for one
# terminal no-wait state. A terminal status needs no live worker process, so
# this exercises the reader's real path without spawning one.
_logs_write_no_wait_run() {
  local root="$1" container="$2" state="$3" body="$4"
  local run_id="11111111-2222-4333-8444-555555555555"
  local started=1760000000000
  printf '%s' "$body" > "$root/.ploinky/logs/no-wait/${container}.${run_id}.log"
  cat > "$root/.ploinky/running/no-wait/${container}.current.json" <<EOF
{"containerName":"${container}","instanceId":"instance-fixture","enableGeneration":"generation-fixture",
 "repoName":"logsFixture","shortAgent":"fixture","alias":"","routeKey":"fixture",
 "runId":"${run_id}","runStartedAtMs":${started},"waveIndex":0,
 "statusFile":"${container}.${run_id}.json"}
EOF
  cat > "$root/.ploinky/running/no-wait/${container}.${run_id}.json" <<EOF
{"containerName":"${container}","instanceId":"instance-fixture","enableGeneration":"generation-fixture",
 "repoName":"logsFixture","shortAgent":"fixture","alias":"","routeKey":"fixture",
 "runId":"${run_id}","runStartedAtMs":${started},"waveIndex":0,
 "statusFile":"${container}.${run_id}.json","state":"${state}","sequencePhase":"active",
 "sequencePhaseStartedAtMs":${started},"pid":1,"phase":"readiness",
 "error":{"message":"probe never became ready","stack":"Error: probe never became ready\\n    at internal"}}
EOF
  # The reference has to resolve before any observation happens, so the
  # fixture registry carries the record this run belongs to.
  cat > "$root/.ploinky/agents.json" <<EOF
{"${container}":{"type":"agent","repoName":"logsFixture","agentName":"fixture",
 "runtime":"podman","instanceId":"instance-fixture","enableGeneration":"generation-fixture"}}
EOF
}

test_logs_last_five() {
  load_state
  require_var "TEST_ROUTER_LOG" || return 1

  local router_log="$TEST_ROUTER_LOG"
  if [[ ! -f "$router_log" || ! -s "$router_log" ]]; then
    echo "Router log file '${router_log}' is missing or empty." >&2
    return 1
  fi

  local output
  if ! output=$(ploinky logs last 5 router); then
    echo "'ploinky logs last 5 router' failed." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  output=${output//$'\r'/}
  local _log_lines=()
  local log_line
  while IFS= read -r log_line || [[ -n "$log_line" ]]; do
    _log_lines+=("$log_line")
  done <<<"$output"
  if (( ${#_log_lines[@]} != 5 )); then
    echo "Expected 5 log lines, got ${#_log_lines[@]}." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
}

# `logs last <N> <agent>` must address the registered runtime for one exact
# enabled agent and produce whatever output that runtime currently has.
test_logs_last_agent_runtime() {
  load_state
  local container
  container=$(_logs_demo_container) || return 1
  if [[ -z "$container" ]]; then
    echo "Could not compute the demo agent container name." >&2
    return 1
  fi

  local output=""
  local status=0
  output=$(ploinky logs last 20 "$container" 2>&1) || status=$?
  if (( status != 0 )); then
    echo "'ploinky logs last 20 ${container}' failed with exit status ${status}." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  # A healthy agent may legitimately have emitted nothing yet, so assert the
  # command resolved the target rather than a specific line count.
  if grep -q "is not one enabled agent" <<<"$output"; then
    echo "'${container}' did not resolve to an enabled agent." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  if grep -q "no exact log source is available" <<<"$output"; then
    echo "No log source was available for '${container}'." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  return 0
}

# A bounded cancellation must terminate the follower and leave nothing running.
test_logs_tail_agent_cancels_cleanly() {
  load_state
  local container
  container=$(_logs_demo_container) || return 1

  local output=""
  local status=0
  output=$(timeout 3s "$PLOINKY_FAST_CLI" logs tail "$container" 2>&1) || status=$?
  # 0 is a clean end, 124 is the bounded cancellation, 130/143 are the mapped
  # operator signals. Anything else means the follower failed.
  if (( status != 0 && status != 124 && status != 130 && status != 143 )); then
    echo "'ploinky logs tail ${container}' failed with exit status ${status}." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  if grep -q "is not one enabled agent" <<<"$output"; then
    echo "'${container}' did not resolve to an enabled agent." >&2
    return 1
  fi
  # No follower may survive the cancellation.
  if pgrep -f "logs tail ${container}" >/dev/null 2>&1; then
    echo "A 'logs tail ${container}' follower survived cancellation." >&2
    return 1
  fi
  return 0
}

# Every documented reference form must reach the same record, and ambiguous or
# unknown references must fail closed with a usable suggestion list.
test_logs_agent_reference_forms() {
  load_state
  local container
  container=$(_logs_demo_container) || return 1

  local status=0
  ploinky logs last 5 "$container" >/dev/null 2>&1 || status=$?
  if (( status != 0 )); then
    echo "The exact registry key '${container}' did not resolve." >&2
    return 1
  fi

  local output=""
  status=0
  output=$(ploinky logs last 5 "definitely-not-an-enabled-agent" 2>&1) || status=$?
  if (( status != 1 )); then
    echo "An unknown agent reference returned ${status} instead of 1." >&2
    return 1
  fi
  if ! grep -q "is not one enabled agent" <<<"$output"; then
    echo "An unknown agent reference did not report why it failed." >&2
    printf '%s\n' "$output" >&2
    return 1
  fi
  return 0
}

# Strict count parsing rejects malformed counts; a count without a target reads Router logs.
test_logs_rejects_invalid_counts() {
  load_state
  local candidate
  for candidate in 0 1.5 007 10001 12abc; do
    local status=0
    ploinky logs last "$candidate" >/dev/null 2>&1 || status=$?
    if (( status != 1 )); then
      echo "'logs last ${candidate}' returned ${status} instead of a usage failure." >&2
      return 1
    fi
  done
  if ! ploinky logs last 5 >/dev/null 2>&1; then
    echo "'logs last 5' did not use the default Router target." >&2
    return 1
  fi
  return 0
}

# A current no-wait run must be readable through `--startup`, and a failed run
# must return 1 while exposing only the worker's bounded, redacted summary.
test_logs_startup_terminal_states() {
  load_state
  local container="ploinky_logs_fixture_agent"
  local root
  root=$(_logs_scratch_workspace) || return 1
  local rc=0

  _logs_write_no_wait_run "$root" "$container" "running" "startup fixture line one"$'\n'
  local output=""
  local status=0
  output=$(PLOINKY_WORKSPACE_ROOT="$root" "$PLOINKY_FAST_CLI" logs last 20 "$container" --startup 2>&1) || status=$?
  if (( status != 0 )); then
    echo "A running startup read returned ${status} instead of 0." >&2
    printf '%s\n' "$output" >&2
    rc=1
  elif ! grep -q "startup fixture line one" <<<"$output"; then
    echo "Startup output was not visible for a running no-wait run." >&2
    printf '%s\n' "$output" >&2
    rc=1
  fi

  _logs_write_no_wait_run "$root" "$container" "failed" "startup fixture failure line"$'\n'
  output=""
  status=0
  output=$(PLOINKY_WORKSPACE_ROOT="$root" "$PLOINKY_FAST_CLI" logs last 20 "$container" --startup 2>&1) || status=$?
  if (( status != 1 )); then
    echo "A failed startup read returned ${status} instead of 1." >&2
    printf '%s\n' "$output" >&2
    rc=1
  else
    if ! grep -q "startup fixture failure line" <<<"$output"; then
      echo "The failed run's startup output was not shown." >&2
      rc=1
    fi
    if ! grep -q "probe never became ready" <<<"$output"; then
      echo "The bounded failure summary was not exposed." >&2
      rc=1
    fi
    # Only the bounded, redacted fields may appear; never the raw stack.
    if grep -q "at internal" <<<"$output"; then
      echo "A raw worker stack leaked into the failure summary." >&2
      rc=1
    fi
  fi

  rm -rf "$root"
  return $rc
}

# A controlled scratch run starts with no status, exposes a startup sentinel,
# then publishes `running` beside a distinct process-specific sandbox log. This
# proves ordered startup-to-runtime handoff without creating a real runtime.
test_logs_startup_runtime_handoff_order() {
  load_state
  local root container run_id started pid digest startup_sentinel runtime_sentinel
  root=$(_logs_scratch_workspace) || return 1
  container="ploinky_logs_handoff_fixture"
  run_id="66666666-7777-4888-9999-aaaaaaaaaaaa"
  started=$(node -e 'process.stdout.write(String(Date.now()))') || return 1
  pid=$$
  startup_sentinel="LOGS_FIXTURE_STARTUP_SENTINEL"
  runtime_sentinel="LOGS_FIXTURE_RUNTIME_SENTINEL"
  mkdir -p "$root/.ploinky/logs/agents"
  printf '%s\n' "$startup_sentinel" > "$root/.ploinky/logs/no-wait/${container}.${run_id}.log"
  cat > "$root/.ploinky/running/no-wait/${container}.current.json" <<EOF
{"containerName":"${container}","instanceId":"instance-handoff","enableGeneration":"generation-handoff",
 "repoName":"logsFixture","shortAgent":"handoff","alias":"","routeKey":"handoff",
 "runId":"${run_id}","runStartedAtMs":${started},"waveIndex":0,
 "statusFile":"${container}.${run_id}.json"}
EOF
  cat > "$root/.ploinky/agents.json" <<EOF
{"${container}":{"type":"agent","repoName":"logsFixture","agentName":"handoff",
 "runtime":"bwrap","pid":${pid},"instanceId":"instance-handoff","enableGeneration":"generation-handoff"}}
EOF
  digest=$(node -e '
    const crypto = require("crypto");
    process.stdout.write(crypto.createHash("sha256")
      .update(`instance-handoff\0generation-handoff\0${process.argv[1]}`).digest("hex"));
  ' "$pid") || return 1

  (
    sleep 0.3
    printf '%s\n' "$runtime_sentinel" > "$root/.ploinky/logs/agents/${container}.${digest}.log"
    local temporary="$root/.ploinky/running/no-wait/.${container}.${run_id}.tmp"
    cat > "$temporary" <<EOF
{"containerName":"${container}","instanceId":"instance-handoff","enableGeneration":"generation-handoff",
 "repoName":"logsFixture","shortAgent":"handoff","alias":"","routeKey":"handoff",
 "runId":"${run_id}","runStartedAtMs":${started},"waveIndex":0,
 "statusFile":"${container}.${run_id}.json","state":"running","sequencePhase":"active",
 "sequencePhaseStartedAtMs":${started},"pid":${pid}}
EOF
    mv "$temporary" "$root/.ploinky/running/no-wait/${container}.${run_id}.json"
  ) &
  local publisher_pid=$!

  local output="" status=0 rc=0
  output=$(PLOINKY_WORKSPACE_ROOT="$root" timeout 3s "$PLOINKY_FAST_CLI" logs tail "$container" 2>&1) || status=$?
  wait "$publisher_pid" || true
  if (( status != 0 && status != 124 && status != 130 && status != 143 )); then
    echo "Controlled startup handoff failed with status ${status}." >&2
    printf '%s\n' "$output" >&2
    rc=1
  else
    local startup_line runtime_line
    startup_line=$(grep -n "$startup_sentinel" <<<"$output" | head -1 | cut -d: -f1)
    runtime_line=$(grep -n "$runtime_sentinel" <<<"$output" | head -1 | cut -d: -f1)
    if [[ -z "$startup_line" || -z "$runtime_line" || "$startup_line" -ge "$runtime_line" ]]; then
      echo "Startup and runtime sentinels were not emitted in handoff order." >&2
      printf '%s\n' "$output" >&2
      rc=1
    fi
  fi
  rm -rf "$root"
  return $rc
}

# In sandbox mode the reader must use the process-specific file whose name is
# derived from the registry tuple and finalized pid, with no legacy fallback.
test_logs_sandbox_process_specific_file() {
  load_state
  if ! is_sandbox_runtime; then
    return 0
  fi
  require_var "TEST_RUN_DIR" || return 1
  local container
  container=$(_logs_demo_container) || return 1

  local expected
  expected=$(TEST_LOG_REGISTRY="$TEST_RUN_DIR/.ploinky/agents.json" TEST_LOG_CONTAINER="$container" node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const registry = JSON.parse(fs.readFileSync(process.env.TEST_LOG_REGISTRY, "utf8"));
    const record = registry[process.env.TEST_LOG_CONTAINER] || {};
    if (!record.instanceId || !record.enableGeneration || !record.pid) process.exit(0);
    const digest = crypto.createHash("sha256")
      .update(`${record.instanceId}\0${record.enableGeneration}\0${record.pid}`)
      .digest("hex");
    process.stdout.write(`${process.env.TEST_LOG_CONTAINER}.${digest}.log`);
  ') || true

  if [[ -z "$expected" ]]; then
    echo "The sandbox record has no finalized identity tuple and pid yet." >&2
    return 1
  fi
  if [[ ! -f "$TEST_RUN_DIR/.ploinky/logs/agents/$expected" ]]; then
    echo "Expected process-specific sandbox log '${expected}' was not created." >&2
    ls -1 "$TEST_RUN_DIR/.ploinky/logs/agents" 2>/dev/null >&2 || true
    return 1
  fi
  # The legacy shared names must be gone.
  if compgen -G "$TEST_RUN_DIR/.ploinky/logs/*-bwrap.log" >/dev/null 2>&1 \
     || compgen -G "$TEST_RUN_DIR/.ploinky/logs/*-seatbelt.log" >/dev/null 2>&1; then
    echo "A legacy sandbox log filename still exists." >&2
    return 1
  fi
  return 0
}

# Opt-in host/Box acceptance. The caller supplies the exact already-running
# Box identity; this function only inspects it, runs the public logs route, and
# checks the process table. It never prepares, starts, repairs, or adopts a Box.
#
# Required when PLOINKY_TEST_BOX_LOG_CANCELLATION=1:
#   PLOINKY_TEST_BOX_CLI          absolute path to the host `ploinky` wrapper
#   PLOINKY_TEST_BOX_ENGINE       docker or podman
#   PLOINKY_TEST_BOX_CONTAINER_ID full immutable 64-hex Box container id
_logs_box_followers() {
  local engine="$1" container_id="$2"
  "$engine" container exec --user podman "$container_id" sh -c \
    'pgrep -af "([p]loinky-local .*logs|[d]ocker logs|[p]odman logs)" || true'
}

_logs_verify_exact_owned_box() {
  local engine="$1" container_id="$2"
  "$engine" container inspect "$container_id" | \
    PLOINKY_TEST_EXPECTED_ROOT="$TEST_RUN_DIR" \
    PLOINKY_TEST_EXPECTED_ID="$container_id" node -e '
      const crypto = require("node:crypto");
      const path = require("node:path");
      let raw = "";
      process.stdin.on("data", chunk => { raw += chunk; });
      process.stdin.on("end", () => {
        let records;
        try { records = JSON.parse(raw); } catch (_) { process.exit(2); }
        const record = Array.isArray(records) ? records[0] : records;
        const root = path.resolve(process.env.PLOINKY_TEST_EXPECTED_ROOT || "");
        const hash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 12);
        const slug = (path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/g, "") || "box");
        const labels = record?.Config?.Labels || record?.Labels || {};
        const id = String(record?.Id || record?.ID || "").toLowerCase();
        const name = String(record?.Name || "").replace(/^\//, "");
        const valid = id === String(process.env.PLOINKY_TEST_EXPECTED_ID || "").toLowerCase()
          && name === `ploinky-box-${slug}-${hash}`
          && labels["io.assistos.ploinky-box.path-hash"] === hash
          && labels["io.assistos.ploinky-box.role"] === "box"
          && record?.State?.Running === true;
        process.exit(valid ? 0 : 3);
      });
    '
}

_logs_box_signal_case() {
  local signal="$1" expected_status="$2"
  local cli="$3" engine="$4" container_id="$5"
  local output_file
  output_file=$(mktemp "${TMPDIR:-/tmp}/ploinky-box-logs-signal.XXXXXX") || return 1
  local target
  target=$(_logs_demo_container) || return 1

  "$cli" logs tail "$target" >"$output_file" 2>&1 &
  local wrapper_pid=$!
  local observed=0
  local attempt
  for attempt in {1..50}; do
    if ! kill -0 "$wrapper_pid" >/dev/null 2>&1; then
      break
    fi
    if [[ -n "$(_logs_box_followers "$engine" "$container_id")" ]]; then
      observed=1
      break
    fi
    sleep 0.1
  done
  if (( observed != 1 )); then
    echo "The ${signal} Box acceptance case never observed its in-Box logs follower." >&2
    cat "$output_file" >&2
    kill -KILL "$wrapper_pid" >/dev/null 2>&1 || true
    wait "$wrapper_pid" >/dev/null 2>&1 || true
    rm -f "$output_file"
    return 1
  fi

  kill -s "$signal" "$wrapper_pid" || {
    echo "Could not send ${signal} to the host logs wrapper." >&2
    rm -f "$output_file"
    return 1
  }
  for attempt in {1..80}; do
    kill -0 "$wrapper_pid" >/dev/null 2>&1 || break
    sleep 0.1
  done
  if kill -0 "$wrapper_pid" >/dev/null 2>&1; then
    echo "The host logs wrapper did not exit within its bounded cleanup window after ${signal}." >&2
    kill -KILL "$wrapper_pid" >/dev/null 2>&1 || true
    wait "$wrapper_pid" >/dev/null 2>&1 || true
    rm -f "$output_file"
    return 1
  fi

  local status=0
  wait "$wrapper_pid" || status=$?
  if (( status != expected_status )); then
    echo "The ${signal} Box logs case returned ${status}, expected ${expected_status}." >&2
    cat "$output_file" >&2
    rm -f "$output_file"
    return 1
  fi

  for attempt in {1..50}; do
    [[ -z "$(_logs_box_followers "$engine" "$container_id")" ]] && break
    sleep 0.1
  done
  local survivors
  survivors=$(_logs_box_followers "$engine" "$container_id")
  rm -f "$output_file"
  if [[ -n "$survivors" ]]; then
    echo "In-Box log processes survived ${signal}:" >&2
    printf '%s\n' "$survivors" >&2
    return 1
  fi
  return 0
}

test_logs_box_signals_remove_inbox_followers() {
  load_state
  require_var "TEST_RUN_DIR" || return 1
  require_var "PLOINKY_TEST_BOX_CLI" || return 1
  require_var "PLOINKY_TEST_BOX_ENGINE" || return 1
  require_var "PLOINKY_TEST_BOX_CONTAINER_ID" || return 1

  local cli="$PLOINKY_TEST_BOX_CLI"
  local engine="$PLOINKY_TEST_BOX_ENGINE"
  local container_id="$PLOINKY_TEST_BOX_CONTAINER_ID"
  if [[ "$cli" != /* || ! -x "$cli" ]]; then
    echo "PLOINKY_TEST_BOX_CLI must be one absolute executable host wrapper path." >&2
    return 1
  fi
  if [[ "$engine" != "docker" && "$engine" != "podman" ]]; then
    echo "PLOINKY_TEST_BOX_ENGINE must be docker or podman." >&2
    return 1
  fi
  if [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
    echo "PLOINKY_TEST_BOX_CONTAINER_ID must be one immutable 64-hex id." >&2
    return 1
  fi
  if ! _logs_verify_exact_owned_box "$engine" "$container_id"; then
    echo "The supplied Box id is not the exact running owned Box for ${TEST_RUN_DIR}." >&2
    return 1
  fi
  local existing
  existing=$(_logs_box_followers "$engine" "$container_id")
  if [[ -n "$existing" ]]; then
    echo "Box cancellation acceptance requires no pre-existing logs followers:" >&2
    printf '%s\n' "$existing" >&2
    return 1
  fi

  _logs_box_signal_case INT 130 "$cli" "$engine" "$container_id" || return 1
  _logs_box_signal_case TERM 143 "$cli" "$engine" "$container_id" || return 1
  return 0
}
