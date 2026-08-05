#!/bin/bash
set -euo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLOINKY_FAST_CLI="${PLOINKY_FAST_CLI:-$TESTS_DIR/../bin/ploinky-local}"

: "${FAST_STATE_FILE:?FAST_STATE_FILE is not set. Export it before sourcing lib.sh.}"
touch "$FAST_STATE_FILE"

# The fast suite builds its fixture directly in a temporary host workspace.
# Use the branch-local CLI so that every command sees that exact fixture,
# instead of routing through a Box whose workspace mount points elsewhere.
ploinky() {
  PLOINKY_ROUTER_HEALTH_SOCKET="${PLOINKY_ROUTER_HEALTH_SOCKET:-${TEST_ROUTER_HEALTH_SOCKET:-}}" \
    "$PLOINKY_FAST_CLI" "$@"
}

if [[ -t 1 ]]; then
  FAST_COLOR_STAGE=$'\033[92m'
  FAST_COLOR_CHECK=$'\033[96m'
  FAST_COLOR_PASS=$'\033[32m'
  FAST_COLOR_FAIL=$'\033[31m'
  FAST_COLOR_INFO=$'\033[94m'
  FAST_COLOR_RESET=$'\033[0m'
else
  FAST_COLOR_STAGE=""
  FAST_COLOR_CHECK=""
  FAST_COLOR_PASS=""
  FAST_COLOR_FAIL=""
  FAST_COLOR_INFO=""
  FAST_COLOR_RESET=""
fi

FAST_CHECK_ERRORS=0

# Cross-platform `timeout` shim. coreutils `timeout` is on every Linux distro
# but not on default macOS — `brew install coreutils` ships it as `gtimeout`.
# Detect once at lib.sh source time:
#   - if external `timeout` exists in PATH, do nothing (Linux happy path)
#   - else if `gtimeout` exists, define a function that delegates to it
#   - else define a perl-based fallback that supports the flag set used by
#     this suite (`DURATION CMD...` and `-k DURATION DURATION CMD...`)
# All scripts in tests/ source lib.sh so the shadow takes effect everywhere.
if [[ -z "$(type -P timeout 2>/dev/null || true)" ]]; then
  _FAST_GTIMEOUT="$(type -P gtimeout 2>/dev/null || true)"
  if [[ -n "$_FAST_GTIMEOUT" ]]; then
    timeout() { "$_FAST_GTIMEOUT" "$@"; }
  else
    _fast_timeout_to_seconds() {
      local raw="$1"
      case "$raw" in
        *ms) echo $(( ${raw%ms} / 1000 )) ;;
        *s)  echo "${raw%s}" ;;
        *m)  echo $(( ${raw%m} * 60 )) ;;
        *h)  echo $(( ${raw%h} * 3600 )) ;;
        ''|*[!0-9]*)
          echo "lib.sh timeout shim: bad duration '$raw'" >&2
          return 1
          ;;
        *)   echo "$raw" ;;
      esac
    }
    timeout() {
      local kill_after_arg=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -k)
            kill_after_arg="$2"
            shift 2
            ;;
          --kill-after=*)
            kill_after_arg="${1#--kill-after=}"
            shift
            ;;
          --)
            shift
            break
            ;;
          -*)
            echo "lib.sh timeout shim: unsupported flag '$1'" >&2
            return 125
            ;;
          *)
            break
            ;;
        esac
      done
      if [[ $# -lt 2 ]]; then
        echo "lib.sh timeout shim: usage: timeout [-k DURATION] DURATION COMMAND [ARG]..." >&2
        return 125
      fi
      local duration="$1"
      shift
      local _secs _kill_secs=0
      _secs=$(_fast_timeout_to_seconds "$duration") || return 125
      if [[ -n "$kill_after_arg" ]]; then
        _kill_secs=$(_fast_timeout_to_seconds "$kill_after_arg") || return 125
      fi
      perl -e '
        use strict;
        use warnings;
        use POSIX qw(setpgid);
        my ($timeout_s, $kill_after_s, @cmd) = @ARGV;
        my $pid = fork();
        die "fork: $!" unless defined $pid;
        if ($pid == 0) {
          # Run the child in its own process group so we can signal the whole
          # tree on timeout — coreutils `timeout` does the same thing. Without
          # this, killing only $pid leaves grandchildren (e.g. `tail -f`)
          # running and the wait blocks forever.
          setpgid($$, $$);
          exec { $cmd[0] } @cmd;
          warn "exec failed: $!";
          exit 127;
        }
        # Best-effort group setup from the parent side too (handles the race
        # between fork and the child exec).
        eval { setpgid($pid, $pid); };
        my $timed_out = 0;
        local $SIG{ALRM} = sub {
          $timed_out = 1;
          kill "-TERM", $pid;
          if ($kill_after_s > 0) {
            sleep $kill_after_s;
            kill "-KILL", $pid;
          }
        };
        alarm $timeout_s;
        waitpid $pid, 0;
        my $status = $?;
        alarm 0;
        exit 124 if $timed_out;
        exit(128 + ($status & 127)) if $status & 127;
        exit($status >> 8);
      ' "$_secs" "$_kill_secs" "$@"
    }
  fi
  unset _FAST_GTIMEOUT
fi

init_results() {
  if [[ -n "${FAST_RESULTS_FILE:-}" ]]; then
    echo -n "" > "$FAST_RESULTS_FILE"
  fi
}

log_result() {
  if [[ -n "${FAST_RESULTS_FILE:-}" ]]; then
    echo "$1" >> "$FAST_RESULTS_FILE"
  else
    echo "[DEBUG] FAST_RESULTS_FILE is not set. Cannot log result: $1" >&2
  fi
}

stage_header() {
  local label="$1"
  printf "%s===== %s =====%s\n" "$FAST_COLOR_STAGE" "$label" "$FAST_COLOR_RESET"
  log_result ""
  log_result "===== $label ====="
}

test_info() {
  local message="$1"
  printf "%s[INFO]%s %s\n" "$FAST_COLOR_INFO" "$FAST_COLOR_RESET" "$message"
}

fail_message() {
  local message="$1"
  local label="[FAIL]"
  if [[ -n "$FAST_COLOR_FAIL" ]]; then
    printf "%s%s%s %s\n" "$FAST_COLOR_FAIL" "$label" "$FAST_COLOR_RESET" "$message"
  else
    printf "%s %s\n" "$label" "$message"
  fi
}

pass_message() {
  local message="$1"
  local label="[PASS]"
  if [[ -n "$FAST_COLOR_PASS" ]]; then
    printf "%s%s%s %s\n" "$FAST_COLOR_PASS" "$label" "$FAST_COLOR_RESET" "$message"
  else
    printf "%s %s\n" "$label" "$message"
  fi
}

test_check() {
  local description="$1"
  local callback="$2"
  shift 2

  local output
  if output=$("$callback" "$@" 2>&1); then
    pass_message "$description"
    log_result "[PASS] $description"
  else
    FAST_CHECK_ERRORS=$((FAST_CHECK_ERRORS + 1))
    fail_message "$description"
    log_result "[FAIL] $description"
    if [[ -n "$output" ]]; then
      printf '%s' "$output" | sed 's/^/        /'
      echo
      echo "        Error: $output" >> "$FAST_RESULTS_FILE"
    fi
  fi
}

test_action() {
  local description="$1"
  local callback="$2"
  shift 2

  test_info "$description"
  if ! "$callback" "$@" >/dev/null 2>&1; then
    fail_message "Action '$description' failed."
    # Actions are critical, exit the stage if one fails.
    exit 1
  fi
}

finalize_checks() {
  if (( FAST_CHECK_ERRORS > 0 )); then
    return "$FAST_CHECK_ERRORS"
  fi
  return 0
}

write_state_var() {
  local key="$1"
  local value="$2"
  [[ -n "$key" ]] || { echo "State key missing" >&2; return 1; }
  local escaped
  printf -v escaped %q "$value"
  local tmp
  if [[ -f "$FAST_STATE_FILE" ]]; then
    tmp=$(mktemp)
    awk -v k="$key" -v v="$escaped" ' \
      BEGIN { updated = 0 } \
      $0 ~ ("^" k "=") { print k "=" v; updated = 1; next } \
      { print } \
      END { if (!updated) print k "=" v } \
    ' "$FAST_STATE_FILE" >"$tmp"
    mv "$tmp" "$FAST_STATE_FILE"
  else
    echo "${key}=${escaped}" >"$FAST_STATE_FILE"
  fi
}

load_state() {
  set -a
  # shellcheck disable=SC1090
  source "$FAST_STATE_FILE"
  set +a
}

require_var() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Required state variable '${key}' is missing." >&2
    return 1
  fi
}

detect_container_runtime() {
  # Respect CONTAINER_RUNTIME env var if set (used by CI workflows)
  if [[ -n "${CONTAINER_RUNTIME:-}" ]]; then
    if command -v "$CONTAINER_RUNTIME" >/dev/null 2>&1; then
      if $CONTAINER_RUNTIME ps >/dev/null 2>&1; then
        echo "$CONTAINER_RUNTIME"
        return 0
      fi
    fi
    echo "Specified CONTAINER_RUNTIME='${CONTAINER_RUNTIME}' is not available or not working." >&2
    return 1
  fi

  # Auto-detect if not specified
  local runtime
  for runtime in docker podman; do
    if command -v "$runtime" >/dev/null 2>&1; then
      if $runtime ps >/dev/null 2>&1; then
        echo "$runtime"
        return 0
      fi
    fi
  done
  echo "No usable container runtime (docker/podman) available." >&2
  return 1
}

require_runtime() {
  load_state
  if [[ "${FAST_AGENT_RUNTIME:-}" == "bwrap" || "${FAST_AGENT_RUNTIME:-}" == "seatbelt" ]]; then return 0; fi
  if [[ -z "${FAST_CONTAINER_RUNTIME:-}" ]]; then
    local runtime
    if runtime=$(detect_container_runtime); then
      FAST_CONTAINER_RUNTIME="$runtime"
      write_state_var "FAST_CONTAINER_RUNTIME" "$FAST_CONTAINER_RUNTIME"
    else
      return 1
    fi
  fi
}

resolve_agent_name_from_container() {
  local container_name="$1"
  load_state
  require_var "TEST_RUN_DIR" || return 1
  local registry="$TEST_RUN_DIR/.ploinky/agents.json"
  if [[ ! -f "$registry" ]]; then
    return 1
  fi
  FAST_TMP_REGISTRY="$registry" FAST_TMP_CONTAINER="$container_name" node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.env.FAST_TMP_REGISTRY, "utf8") || "{}");
    const entry = data[process.env.FAST_TMP_CONTAINER];
    if (entry && entry.agentName) process.stdout.write(entry.agentName);
    else process.exit(1);
  '
}

resolve_agent_runtime_from_container() {
  local container_name="$1"
  load_state
  require_var "TEST_RUN_DIR" || return 1
  local registry="$TEST_RUN_DIR/.ploinky/agents.json"
  if [[ ! -f "$registry" ]]; then
    echo "${FAST_AGENT_RUNTIME:-container}"
    return 0
  fi
  FAST_TMP_REGISTRY="$registry" FAST_TMP_CONTAINER="$container_name" node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(process.env.FAST_TMP_REGISTRY, "utf8") || "{}");
    const entry = data[process.env.FAST_TMP_CONTAINER];
    process.stdout.write((entry && entry.runtime) || "");
  ' || true
}

is_bwrap_agent() {
  local container_name="$1"
  local rt
  rt=$(resolve_agent_runtime_from_container "$container_name")
  if [[ -z "$rt" ]]; then
    rt="${FAST_AGENT_RUNTIME:-container}"
  fi
  [[ "$rt" == "bwrap" || "$rt" == "seatbelt" ]]
}

# Returns true when the detected agent runtime is a sandbox (bwrap or seatbelt)
is_sandbox_runtime() {
  load_state
  [[ "${FAST_AGENT_RUNTIME:-container}" == "bwrap" || "${FAST_AGENT_RUNTIME:-container}" == "seatbelt" ]]
}

resolve_realpath() {
  local target="$1"
  if [[ -z "$target" ]]; then
    return 1
  fi

  if command -v realpath >/dev/null 2>&1; then
    realpath "$target"
    return $?
  fi

  node -e "const fs=require('fs'); const path=require('path'); const target=process.argv[1]; try { console.log(fs.realpathSync(target)); } catch (_) { console.log(path.resolve(target)); }" "$target"
}

compute_container_name() {
  local agent_name="$1"
  local repo_name="$2"
  if [[ -z "$agent_name" ]]; then
    echo "Agent name is required for computing container name." >&2
    return 1
  fi
  load_state
  require_var "TEST_RUN_DIR" || return 1
  local cwd="$TEST_RUN_DIR"
  if [[ -z "$repo_name" && -n "${TEST_REPO_NAME:-}" ]]; then
    repo_name="$TEST_REPO_NAME"
  fi
  FAST_TMP_CWD="$cwd" FAST_TMP_AGENT="$agent_name" FAST_TMP_REPO="$repo_name" node <<'NODE'
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cwd = process.env.FAST_TMP_CWD;
const agent = process.env.FAST_TMP_AGENT;
let repo = process.env.FAST_TMP_REPO || '';
let workspaceRoot = cwd;

function sanitize(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

try {
  if (!repo) {
    const mapPath = path.join(cwd, '.ploinky', 'agents.json');
    const raw = fs.readFileSync(mapPath, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (data && typeof data === 'object') {
      for (const value of Object.values(data)) {
        if (value && typeof value === 'object' && value.agentName === agent && value.repoName) {
          repo = value.repoName;
          break;
        }
      }
    }
  }
} catch (_) {
  // ignore lookup failures; fallback to provided repo if any
}

const safeAgent = sanitize(agent);
const safeRepo = sanitize(repo);
try {
  workspaceRoot = fs.realpathSync(cwd);
} catch (_) {
  workspaceRoot = path.resolve(cwd);
}
const projectDir = sanitize(path.basename(workspaceRoot));
const hash = crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 8);
console.log(`ploinky_${safeRepo}_${safeAgent}_${projectDir}_${hash}`);
NODE
}

assert_dir_exists() {
  local path="$1"
  if [[ ! -d "$path" ]]; then
    echo "Expected directory '${path}' to exist." >&2
    return 1
  fi
}

assert_file_exists() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Expected file '${path}' to exist." >&2
    return 1
  fi
}

assert_file_contains() {
  local path="$1"
  local pattern="$2"
  if [[ ! -f "$path" ]]; then
    echo "File '${path}' missing." >&2
    return 1
  fi
  if ! grep -Eq "$pattern" "$path"; then
    echo "File '${path}' does not contain pattern '${pattern}'." >&2
    return 1
  fi
}

find_file_pattern_line() {
  local path="$1"
  local pattern="$2"
  if [[ ! -f "$path" ]]; then
    echo "File '${path}' missing." >&2
    return 1
  fi
  local line
  line=$(grep -n -m 1 -F "$pattern" "$path" | cut -d: -f1)
  if [[ -z "$line" ]]; then
    echo "Pattern '${pattern}' not found in '${path}'." >&2
    return 1
  fi
  echo "$line"
}

assert_file_pattern_before() {
  local path="$1"
  local earlier="$2"
  local later="$3"
  local earlier_line
  local later_line
  earlier_line=$(find_file_pattern_line "$path" "$earlier") || return 1
  later_line=$(find_file_pattern_line "$path" "$later") || return 1
  if (( earlier_line >= later_line )); then
    echo "Pattern '${earlier}' (line ${earlier_line}) does not appear before '${later}' (line ${later_line}) in '${path}'." >&2
    return 1
  fi
}

read_route_host_port() {
  local routing_file="$1"
  local route_key="$2"
  if [[ ! -f "$routing_file" ]]; then
    echo "Routing file '${routing_file}' missing." >&2
    return 1
  fi
  FAST_TMP_ROUTING_FILE="$routing_file" FAST_TMP_ROUTE_KEY="$route_key" node <<'NODE'
const fs = require('fs');

const routingFile = process.env.FAST_TMP_ROUTING_FILE;
const routeKey = process.env.FAST_TMP_ROUTE_KEY;

const raw = fs.readFileSync(routingFile, 'utf8');
const data = JSON.parse(raw || '{}');
const route = data?.routes?.[routeKey];
const hostPort = Number(route?.hostPort);
if (!Number.isFinite(hostPort) || hostPort <= 0) {
  process.exit(1);
}
process.stdout.write(String(hostPort));
NODE
}

check_router_stop_entry() {
  local log_file="$1"
  local expected_port="$2"
  local state_var="${3:-}"
  local previous_entry="${4:-}"

  if [[ -z "$log_file" ]]; then
    echo "Router log path not provided." >&2
    return 1
  fi
  if [[ ! -f "$log_file" ]]; then
    echo "Router log '${log_file}' missing." >&2
    return 1
  fi

  local last_entry
  last_entry=$(grep '"type":"server_stop"' "$log_file" 2>/dev/null | tail -n 1 || true)
  if [[ -z "$last_entry" ]]; then
    local physical_last_entry
    physical_last_entry=$(tail -n 1 "$log_file" 2>/dev/null || true)
    echo "Router log '${log_file}' does not contain a server_stop entry. Last line: ${physical_last_entry}" >&2
    return 1
  fi

  if [[ -n "$expected_port" ]] && ! grep -q "\"port\":${expected_port}" <<<"$last_entry"; then
    echo "Router stop entry missing expected port ${expected_port}: ${last_entry}" >&2
    return 1
  fi

  if [[ -n "$previous_entry" && "$last_entry" == "$previous_entry" ]]; then
    echo "Router stop entry matches previous record." >&2
    return 1
  fi

  if [[ -n "$state_var" ]]; then
    write_state_var "$state_var" "$last_entry"
  fi

  return 0
}

assert_container_running() {
  local container="$1"
  if is_bwrap_agent "$container"; then
    local agent_name
    agent_name=$(resolve_agent_name_from_container "$container") || { echo "Cannot resolve agent name for '${container}'." >&2; return 1; }
    local pid_file="$TEST_RUN_DIR/.ploinky/bwrap-pids/${agent_name}.pid"
    if [[ ! -f "$pid_file" ]]; then
      echo "Bwrap agent '${agent_name}' PID file missing." >&2
      return 1
    fi
    local pid
    pid=$(cat "$pid_file")
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Bwrap agent '${agent_name}' (PID ${pid}) is not running." >&2
      return 1
    fi
  else
    require_runtime || return 1
    local container_names
    if ! container_names=$($FAST_CONTAINER_RUNTIME ps --format '{{.Names}}'); then
      echo "Unable to list running containers." >&2
      return 1
    fi
    if ! grep -Fxq "$container" <<<"$container_names"; then
      echo "Container '${container}' is not running." >&2
      return 1
    fi
  fi
}

assert_container_stopped() {
  local container="$1"
  if is_bwrap_agent "$container"; then
    local agent_name
    agent_name=$(resolve_agent_name_from_container "$container") || return 0
    local pid_file="$TEST_RUN_DIR/.ploinky/bwrap-pids/${agent_name}.pid"
    if [[ -f "$pid_file" ]]; then
      local pid
      pid=$(cat "$pid_file")
      if kill -0 "$pid" 2>/dev/null; then
        echo "Bwrap agent '${agent_name}' (PID ${pid}) is still running." >&2
        return 1
      fi
    fi
  else
    require_runtime || return 1
    local container_names
    if ! container_names=$($FAST_CONTAINER_RUNTIME ps --format '{{.Names}}'); then
      echo "Unable to list running containers." >&2
      return 1
    fi
    if grep -Fxq "$container" <<<"$container_names"; then
      echo "Container '${container}' is still running." >&2
      return 1
    fi
  fi
}

assert_container_exists() {
  local container="$1"
  if is_bwrap_agent "$container"; then
    # For bwrap agents, the registry entry survives ploinky stop (removed only by destroy)
    load_state
    require_var "TEST_RUN_DIR" || return 1
    local registry="$TEST_RUN_DIR/.ploinky/agents.json"
    if [[ ! -f "$registry" ]]; then
      echo "Agents registry missing." >&2
      return 1
    fi
    if ! FAST_TMP_REGISTRY="$registry" FAST_TMP_CONTAINER="$container" node -e '
      const fs = require("fs");
      const data = JSON.parse(fs.readFileSync(process.env.FAST_TMP_REGISTRY, "utf8") || "{}");
      if (!data[process.env.FAST_TMP_CONTAINER]) process.exit(1);
    '; then
      echo "Bwrap agent '${container}' not found in registry." >&2
      return 1
    fi
  else
    require_runtime || return 1
    local container_names
    if ! container_names=$($FAST_CONTAINER_RUNTIME ps -a --format '{{.Names}}'); then
      echo "Unable to list containers." >&2
      return 1
    fi
    if ! grep -Fxq "$container" <<<"$container_names"; then
      echo "Container '${container}' does not exist." >&2
      return 1
    fi
  fi
}

assert_container_absent() {
  local container="$1"
  if is_bwrap_agent "$container"; then
    local agent_name
    agent_name=$(resolve_agent_name_from_container "$container") || return 0
    local pid_file="$TEST_RUN_DIR/.ploinky/bwrap-pids/${agent_name}.pid"
    # PID file gone → absent
    if [[ ! -f "$pid_file" ]]; then
      return 0
    fi
    # PID file exists but process is dead → absent
    local pid
    pid=$(cat "$pid_file" 2>/dev/null) || return 0
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    echo "Bwrap agent '${agent_name}' (PID ${pid}) is still running." >&2
    return 1
  else
    require_runtime || return 1
    local container_names
    if ! container_names=$($FAST_CONTAINER_RUNTIME ps -a --format '{{.Names}}'); then
      echo "Unable to list containers." >&2
      return 1
    fi
    if grep -Fxq "$container" <<<"$container_names"; then
      echo "Container '${container}' still exists." >&2
      return 1
    fi
  fi
}

get_container_pid() {
  local container="$1"
  if is_bwrap_agent "$container"; then
    local agent_name
    agent_name=$(resolve_agent_name_from_container "$container") || { echo "Cannot resolve agent name for '${container}'." >&2; return 1; }
    local pid_file="$TEST_RUN_DIR/.ploinky/bwrap-pids/${agent_name}.pid"
    if [[ ! -f "$pid_file" ]]; then
      echo "Bwrap agent '${agent_name}' PID file missing." >&2
      return 1
    fi
    cat "$pid_file"
  else
    require_runtime || return 1
    $FAST_CONTAINER_RUNTIME inspect --format '{{.State.Pid}}' "$container"
  fi
}

_find_bwrap_leaf_pid() {
  local pid="$1"
  local child
  # Walk process tree to find the deepest child (the actual sandboxed process)
  while true; do
    child=$(pgrep -P "$pid" 2>/dev/null | head -1)
    if [[ -z "$child" ]]; then
      echo "$pid"
      return 0
    fi
    pid="$child"
  done
}

assert_container_env() {
  local container="$1"
  local key="$2"
  local expected="$3"
  if is_bwrap_agent "$container"; then
    local bwrap_pid
    bwrap_pid=$(get_container_pid "$container") || return 1
    local pid
    pid=$(_find_bwrap_leaf_pid "$bwrap_pid")
    local value
    if [[ -f "/proc/${pid}/environ" ]]; then
      # Linux: read from /proc
      if ! tr '\0' '\n' < "/proc/${pid}/environ" | grep -q "^${key}="; then
        echo "Env '${key}' not found in sandbox agent (PID ${pid})." >&2
        return 1
      fi
      value=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep "^${key}=" | head -1 | cut -d= -f2-)
    elif command -v ps >/dev/null 2>&1; then
      # macOS: use ps to read environment (requires same user)
      local env_output
      env_output=$(ps -p "$pid" -wwwE -o command= 2>/dev/null) || { echo "Cannot read env for sandbox agent (PID ${pid})." >&2; return 1; }
      if ! echo "$env_output" | tr ' ' '\n' | grep -q "^${key}="; then
        echo "Env '${key}' not found in sandbox agent (PID ${pid})." >&2
        return 1
      fi
      value=$(echo "$env_output" | tr ' ' '\n' | grep "^${key}=" | head -1 | cut -d= -f2-)
    else
      echo "Cannot read environment for sandbox agent (PID ${pid}): no /proc and no ps." >&2
      return 1
    fi
    if [[ "$value" != "$expected" ]]; then
      echo "Sandbox agent (PID ${pid}): expected ${key}='${expected}', got '${value}'." >&2
      return 1
    fi
  else
    require_runtime || return 1
    local value
    if ! value=$($FAST_CONTAINER_RUNTIME exec "$container" printenv "$key" 2>/dev/null); then
      echo "Unable to read env '${key}' from container '${container}'." >&2
      return 1
    fi
    if [[ "$value" != "$expected" ]]; then
      echo "Container '${container}': expected ${key}='${expected}', got '${value}'." >&2
      return 1
    fi
  fi
}

assert_container_env_absent() {
  local container="$1"
  local key="$2"
  if is_bwrap_agent "$container"; then
    local bwrap_pid
    bwrap_pid=$(get_container_pid "$container") || return 0
    local pid
    pid=$(_find_bwrap_leaf_pid "$bwrap_pid")
    local value=""
    local found=0
    if [[ -f "/proc/${pid}/environ" ]]; then
      if tr '\0' '\n' < "/proc/${pid}/environ" | grep -q "^${key}="; then
        value=$(tr '\0' '\n' < "/proc/${pid}/environ" | grep "^${key}=" | head -1 | cut -d= -f2-)
        found=1
      fi
    elif command -v ps >/dev/null 2>&1; then
      local env_output
      env_output=$(ps -p "$pid" -wwwE -o command= 2>/dev/null) || true
      if [[ -n "$env_output" ]] && echo "$env_output" | tr ' ' '\n' | grep -q "^${key}="; then
        value=$(echo "$env_output" | tr ' ' '\n' | grep "^${key}=" | head -1 | cut -d= -f2-)
        found=1
      fi
    fi
    if [[ "$found" -eq 1 ]]; then
      echo "Sandbox agent (PID ${pid}) unexpectedly exposes ${key}='${value}'." >&2
      return 1
    fi
  else
    require_runtime || return 1
    local value
    if value=$($FAST_CONTAINER_RUNTIME exec "$container" printenv "$key" 2>/dev/null); then
      echo "Container '${container}' unexpectedly exposes ${key}='${value}'." >&2
      return 1
    fi
  fi
  return 0
}

assert_port_listening() {
  local port="$1"
  node - "$port" <<'NODE'
const net = require('net');
const port = parseInt(process.argv[2], 10);
if (isNaN(port)) {
  process.exit(1);
}
const s = new net.Socket();
s.setTimeout(500);
s.on('connect', () => {
  s.destroy();
  process.exit(0);
});
const fail = () => {
  s.destroy();
  process.exit(1);
};
s.on('error', fail);
s.on('timeout', fail);
s.connect(port, '127.0.0.1');
NODE
}

assert_port_bound_local() {
  local container="$1"
  local container_port="$2"
  local expected_host_port="${3:-}"
  local expected_ip="${4:-127.0.0.1}"

  if [[ -z "$container" || -z "$container_port" ]]; then
    echo "Container and container port are required." >&2
    return 1
  fi

  if is_bwrap_agent "$container"; then
    # Bwrap agents bind ports directly on the host (no port mapping layer).
    # Just verify the port is listening — bind address enforcement isn't
    # possible without network namespace isolation.
    local check_port="${expected_host_port:-$container_port}"
    assert_port_listening "$check_port"
    return $?
  else
    require_runtime || return 1
    local output
    if ! output=$($FAST_CONTAINER_RUNTIME port "$container" "${container_port}/tcp" 2>/dev/null); then
      echo "Unable to resolve port mapping for ${container}:${container_port}/tcp." >&2
      return 1
    fi

    local found_expected=0
    local line
    while IFS= read -r line; do
      line="${line//[$'\r\n']/}"
      line=${line# } ; line=${line% }
      [[ -z "$line" ]] && continue

      local host_part=${line%:*}
      local host_port=${line##*:}
      host_part=${host_part#[}
      host_part=${host_part%]}

      if [[ -n "$expected_host_port" && "$host_port" != "$expected_host_port" ]]; then
        continue
      fi

      if [[ "$host_part" == "0.0.0.0" || "$host_part" == "::" ]]; then
        echo "Port ${container}:${container_port}/tcp is bound to '${host_part}:${host_port}', expected ${expected_ip}." >&2
        return 1
      fi

      if [[ "$host_part" == "$expected_ip" ]]; then
        found_expected=1
      elif [[ "$host_part" == "::1" && "$expected_ip" == "127.0.0.1" ]]; then
        found_expected=1
      fi
    done <<< "$output"

    if [[ $found_expected -eq 0 ]]; then
      echo "No binding found on ${expected_ip} for ${container}:${container_port}/tcp (docker port output: ${output})." >&2
      return 1
    fi
  fi
}

assert_port_not_listening() {
  local port="$1"
  node - "$port" <<'NODE'
const net = require('net');
const port = parseInt(process.argv[2], 10);
if (isNaN(port)) {
  process.exit(0);
}
const s = new net.Socket();
s.setTimeout(500);
s.on('connect', () => {
  s.destroy();
  process.exit(1);
});
const succeed = () => {
  s.destroy();
  process.exit(0);
};
s.on('error', succeed);
s.on('timeout', succeed);
s.connect(port, '127.0.0.1');
NODE
}

assert_routing_server_stopped() {
  load_state
  require_var "TEST_ROUTER_PORT" || return 1

  local port="$TEST_ROUTER_PORT"

  if ! command -v lsof >/dev/null 2>&1; then
    echo "lsof is required to inspect router PID for port ${port}." >&2
    return 1
  fi

  local pid
  pid=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -n 1)

  if [[ -n "$pid" ]]; then
    echo "RoutingServer process still running on port ${port} (PID: ${pid})." >&2
    return 1
  fi

  return 0
}

wait_for_container() {
  local container="$1"
  local attempts=120
  local delay=0.5
  local i
  if is_bwrap_agent "$container"; then
    local agent_name
    agent_name=$(resolve_agent_name_from_container "$container") || { echo "Cannot resolve agent name for '${container}'." >&2; return 1; }
    local pid_file="$TEST_RUN_DIR/.ploinky/bwrap-pids/${agent_name}.pid"
    for (( i=0; i<attempts; i++ )); do
      if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
          return 0
        fi
      fi
      sleep "$delay"
    done
    echo "Bwrap agent '${agent_name}' did not reach running state." >&2
    return 1
  else
    require_runtime || return 1
    for (( i=0; i<attempts; i++ )); do
      local container_names
      if ! container_names=$($FAST_CONTAINER_RUNTIME ps --format '{{.Names}}'); then
        echo "Unable to list running containers." >&2
        return 1
      fi
      if grep -Fxq "$container" <<<"$container_names"; then
        return 0
      fi
      sleep "$delay"
    done
    echo "Container '${container}' did not reach running state." >&2
    return 1
  fi
}

wait_for_agent_log_message() {
  local log_file="$1"
  local pattern="$2"
  local attempts=120 # 60 seconds
  local delay=0.5

  test_info "Waiting for message '${pattern}' in file '${log_file}'"
  
  for (( i=0; i<attempts; i++ )); do
    if [[ -f "$log_file" ]] && grep -q "$pattern" "$log_file"; then
      test_info "Message found in log file."
      return 0
    fi
    sleep "$delay"
  done

  echo "Timed out waiting for message '${pattern}' in '${log_file}'." >&2
  if [[ -f "$log_file" ]]; then
    echo "--- Log file content ---" >&2
    cat "$log_file" >&2
    echo "--- End of log file ---" >&2
  else
    echo "Log file '${log_file}' was not created." >&2
  fi
  return 1
}

wait_for_container_stop() {
  local container="$1"
  local attempts=120
  local delay=0.5
  local i
  if is_bwrap_agent "$container"; then
    local agent_name
    agent_name=$(resolve_agent_name_from_container "$container") || return 0
    local pid_file="$TEST_RUN_DIR/.ploinky/bwrap-pids/${agent_name}.pid"
    for (( i=0; i<attempts; i++ )); do
      if [[ ! -f "$pid_file" ]]; then
        return 0
      fi
      local pid
      pid=$(cat "$pid_file" 2>/dev/null) || { return 0; }
      if ! kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
      sleep "$delay"
    done
    echo "Bwrap agent '${agent_name}' did not stop in time." >&2
    return 1
  else
    require_runtime || return 1
    for (( i=0; i<attempts; i++ )); do
      local container_names
      if ! container_names=$($FAST_CONTAINER_RUNTIME ps --format '{{.Names}}'); then
        echo "Unable to list running containers." >&2
        return 1
      fi
      if ! grep -Fxq "$container" <<<"$container_names"; then
        return 0
      fi
      sleep "$delay"
    done
    echo "Container '${container}' did not stop in time." >&2
    return 1
  fi
}

wait_for_router() {
  load_state
  require_var "TEST_ROUTER_HEALTH_SOCKET" || return 1
  local socket="$TEST_ROUTER_HEALTH_SOCKET"
  local attempts=120
  local delay=0.5
  local i
  for (( i=0; i<attempts; i++ )); do
    if curl -fsS --unix-socket "$socket" "http://localhost/health" 2>/dev/null \
      | grep -q '"status":"healthy"'; then
      return 0
    fi
    sleep "$delay"
  done
  echo "Router detailed health is not responding on socket ${socket} after ${attempts} attempts." >&2
  return 1
}

assert_router_status_ok() {
  load_state
  require_var "TEST_ROUTER_HEALTH_SOCKET" || return 1
  local socket="$TEST_ROUTER_HEALTH_SOCKET"
  local response
  if ! response=$(curl -fsS --unix-socket "$socket" "http://localhost/health" 2>/dev/null); then
    echo "Failed to fetch Router detailed health on socket ${socket}." >&2
    return 1
  fi
  if ! grep -q '"status":"healthy"' <<<"$response"; then
    echo "Router health missing status=healthy: ${response}" >&2
    return 1
  fi
}

assert_agent_registered() {
  load_state
  require_var "TEST_RUN_DIR" || return 1
  require_var "TEST_AGENT_NAME" || return 1
  require_var "TEST_REPO_NAME" || return 1
  local registry="$TEST_RUN_DIR/.ploinky/agents.json"
  if [[ ! -f "$registry" ]]; then
    echo "Agents registry '${registry}' missing." >&2
    return 1
  fi
  FAST_TMP_REGISTRY="$registry" FAST_TMP_AGENT="$TEST_AGENT_NAME" FAST_TMP_REPO="$TEST_REPO_NAME" node <<'NODE'
const fs = require('fs');

const registryPath = process.env.FAST_TMP_REGISTRY;
const agentName = process.env.FAST_TMP_AGENT;
const repoName = process.env.FAST_TMP_REPO;

const raw = fs.readFileSync(registryPath, 'utf8');
const data = JSON.parse(raw || '{}');
const entries = Object.values(data || {});
const found = entries.find(entry => entry && entry.agentName === agentName && entry.repoName === repoName);
if (!found) {
  console.error(`Agent '${repoName}/${agentName}' not registered.`);
  process.exit(1);
}
NODE
}

assert_enabled_repo() {
  load_state
  require_var "TEST_RUN_DIR" || return 1
  require_var "TEST_REPO_NAME" || return 1
  local enabled_file="$TEST_RUN_DIR/.ploinky/enabled_repos.json"
  if [[ ! -f "$enabled_file" ]]; then
    echo "Enabled repos file '${enabled_file}' missing." >&2
    return 1
  fi
  if ! grep -Fq "\"$TEST_REPO_NAME\"" "$enabled_file"; then
    echo "Repository '${TEST_REPO_NAME}' not marked as enabled." >&2
    return 1
  fi
}

assert_file_content_equals() {
  local path="$1"
  local expected="$2"
  if [[ ! -f "$path" ]]; then
    echo "File '${path}' missing." >&2
    return 1
  fi
  local actual
  actual=$(cat "$path")
  if [[ "$actual" != "$expected" ]]; then
    echo "File '${path}' content mismatch. Expected '${expected}', got '${actual}'." >&2
    return 1
  fi
}

assert_http_response_contains() {
  local url="$1"
  local pattern="$2"
  local body
  if ! body=$(curl -fsS "$url" 2>/dev/null); then
    echo "HTTP request to '${url}' failed." >&2
    return 1
  fi
  if ! grep -Fq "$pattern" <<<"$body"; then
    echo "Response from '${url}' missing '${pattern}'." >&2
    return 1
  fi
}

allocate_port() {
  local attempts=50
  local port
  for ((i=0; i<attempts; i++)); do
    port=$(( (RANDOM % 20000) + 20000 ))
    if command -v ss >/dev/null 2>&1; then
      if ! ss -tulwn | awk '{print $5}' | grep -Eq "(:|^).*:${port}$"; then
        echo "$port"
        return 0
      fi
    elif command -v lsof >/dev/null 2>&1; then
      if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "$port"
        return 0
      fi
    else
      # Fallback: try to bind
      if node -e "const s=require('net').createServer();s.listen($port,'127.0.0.1',()=>{s.close();process.exit(0)});s.on('error',()=>process.exit(1))"; then
        echo "$port"
        return 0
      fi
    fi
  done
  echo "Unable to locate a free TCP port after ${attempts} attempts." >&2
  return 1
}

assert_file_not_exists() {
  local path="$1"
  if [[ -e "$path" ]]; then
    echo "Unexpected path exists: '${path}'." >&2
    return 1
  fi
}

assert_not_equal() {
  local left="$1"
  local right="$2"
  local message="${3:-Values should differ.}"
  if [[ "$left" == "$right" ]]; then
    echo "$message" >&2
    return 1
  fi
}

wait_for_file() {
  local path="$1"
  local attempts="${2:-40}"
  local delay="${3:-0.25}"
  local i
  for (( i=0; i<attempts; i++ )); do
    if [[ -f "$path" ]]; then
      return 0
    fi
    sleep "$delay"
  done
  echo "File '${path}' did not appear in time." >&2
  return 1
}

run_with_timeout() {
  local timeout_seconds="$1"
  local description="$2"
  shift 2
  local command_to_run=("$@")

  test_info "$description"

  local exit_code=0
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" "${command_to_run[@]}"
    exit_code=$?
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$timeout_seconds" "${command_to_run[@]}"
    exit_code=$?
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$timeout_seconds" "${command_to_run[@]}" <<'PY'
import signal
import subprocess
import sys

if len(sys.argv) < 3:
    sys.exit(125)

try:
    timeout_seconds = float(sys.argv[1])
except ValueError:
    sys.exit(125)

command = sys.argv[2:]
process = None

def forward(sig, _frame):
    if process and process.poll() is None:
        try:
            process.send_signal(sig)
        except ProcessLookupError:
            pass

signal.signal(signal.SIGINT, forward)
signal.signal(signal.SIGTERM, forward)

try:
    process = subprocess.Popen(command)
    try:
        sys.exit(process.wait(timeout=timeout_seconds))
    except subprocess.TimeoutExpired:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        sys.exit(124)
except FileNotFoundError:
    sys.exit(127)
PY
    exit_code=$?
  else
    echo "No timeout implementation available (need timeout, gtimeout, or python3)." >&2
    return 127
  fi

  if [[ $exit_code -eq 124 ]]; then
    fail_message "Timeout: '${description}' exceeded ${timeout_seconds} seconds."
    return 124
  fi

  return $exit_code
}

to_uppercase() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]'
}

enable_repo_with_branch() {
  local repo_name="$1"
  local branch_var="PLOINKY_$(to_uppercase "$repo_name")_BRANCH"
  local branch="${!branch_var:-}"

  if [[ -n "$branch" ]]; then
    test_info "Enabling repository ${repo_name} (branch: ${branch})."
    ploinky enable repo "$repo_name" --branch "$branch"
  else
    test_info "Enabling repository ${repo_name}."
    ploinky enable repo "$repo_name"
  fi
}

# Pre-clone a manifest repo with a specific branch before the manifest is processed
# This allows testing with feature branches for repos defined in manifest.repos
preclone_manifest_repo() {
  local repo_name="$1"
  local repo_url="$2"
  local branch_var="PLOINKY_$(to_uppercase "$repo_name")_BRANCH"
  local branch="${!branch_var:-}"

  local repo_path=".ploinky/repos/${repo_name}"

  if [[ -d "$repo_path" ]]; then
    test_info "Repository ${repo_name} already exists, skipping pre-clone."
    return 0
  fi

  if [[ -n "$branch" ]]; then
    test_info "Pre-cloning manifest repo ${repo_name} (branch: ${branch})."
    git clone --branch "$branch" "$repo_url" "$repo_path"
  else
    test_info "Pre-cloning manifest repo ${repo_name}."
    git clone "$repo_url" "$repo_path"
  fi
}

# Replace the `enable` array of a cloned manifest with the supplied JSON list.
# Used by the fast suite to keep the dependency-gated startup wave bounded:
# the demo / explorer / moderator manifests upstream enable a transitive chain
# (postgres + dpuAgent + gitAgent + llmAssistant + multimedia + tasksAgent + ...)
# that the assertions in testsAfterStart.sh do not require, and which would
# otherwise blow past START_ACTION_TIMEOUT during cold install. The slim only
# touches the cloned copy under .ploinky/repos/, never the upstream source.
slim_manifest_enable() {
  local manifest_path="$1"
  local enable_json="$2"
  if [[ ! -f "$manifest_path" ]]; then
    test_info "slim_manifest_enable: ${manifest_path} not found, skipping."
    return 0
  fi
  MANIFEST_PATH="$manifest_path" ENABLE_JSON="$enable_json" node <<'NODE'
const fs = require('node:fs');
const target = process.env.MANIFEST_PATH;
const enable = JSON.parse(process.env.ENABLE_JSON);
const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
manifest.enable = enable;
fs.writeFileSync(target, JSON.stringify(manifest, null, 4) + '\n');
NODE
  test_info "slim_manifest_enable: ${manifest_path} -> ${enable_json}"
}

# Force a `readiness.protocol` value on a cloned manifest. Used by the fast
# suite to opt out of the MCP handshake probe for HTTP agents whose manifest
# declares an `agent` command (which the dependency-gated startup heuristic
# would otherwise classify as MCP — see docs/static-agent-readiness-probe-bug.md).
# Recognized values: "tcp" | "mcp".
set_manifest_readiness_protocol() {
  local manifest_path="$1"
  local protocol="$2"
  if [[ ! -f "$manifest_path" ]]; then
    test_info "set_manifest_readiness_protocol: ${manifest_path} not found, skipping."
    return 0
  fi
  MANIFEST_PATH="$manifest_path" READINESS_PROTOCOL="$protocol" node <<'NODE'
const fs = require('node:fs');
const target = process.env.MANIFEST_PATH;
const protocol = String(process.env.READINESS_PROTOCOL || '').trim().toLowerCase();
if (protocol !== 'tcp' && protocol !== 'mcp') {
  console.error(`set_manifest_readiness_protocol: invalid protocol '${protocol}'`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
manifest.readiness = { ...(manifest.readiness || {}), protocol };
fs.writeFileSync(target, JSON.stringify(manifest, null, 4) + '\n');
NODE
  test_info "set_manifest_readiness_protocol: ${manifest_path} -> ${protocol}"
}
