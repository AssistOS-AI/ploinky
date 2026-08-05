#!/bin/bash
# This script is the orchestrator for the E2E test suite.
# It runs through stages of preparing, starting, stopping, and destroying
# a test environment, verifying the system's state at each step.
# It is designed to run all verification steps and provide a final summary,
# even if some individual checks fail.

# Exit immediately if a command exits with a non-zero status.
# We will disable this for sections where we want to continue on error.
set -euo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLOINKY_REPO_ROOT=$(cd -- "$TESTS_DIR/.." && pwd)

# Load branch configuration if present
if [[ -f "$TESTS_DIR/branch_config.sh" ]]; then
    source "$TESTS_DIR/branch_config.sh"
fi

# --- Ploinky branch selection ---
# When PLOINKY_BRANCH is set, create a git worktree at that branch and use it
# instead of the current working copy. This allows testing any ploinky branch.
#
# Usage:
#   PLOINKY_BRANCH=bwrap-integration ./tests/run-all.sh
#   PLOINKY_BRANCH=main ./tests/run-all.sh
#
PLOINKY_WORKTREE=""
if [[ -n "${PLOINKY_BRANCH:-}" ]]; then
  current_branch=$(git -C "$PLOINKY_REPO_ROOT" branch --show-current 2>/dev/null || echo "")
  if [[ "$PLOINKY_BRANCH" == "$current_branch" ]]; then
    echo "[test] PLOINKY_BRANCH='${PLOINKY_BRANCH}' matches current branch — using working copy."
  else
    # Remove any existing worktree for this branch (e.g. from interrupted previous runs)
    _existing_wt=$(git -C "$PLOINKY_REPO_ROOT" worktree list --porcelain 2>/dev/null | awk -v b="$PLOINKY_BRANCH" '/^worktree /{wt=$2} /^branch /{if($2=="refs/heads/"b) print wt}')
    if [[ -n "$_existing_wt" ]]; then
      echo "[test] Removing stale worktree at ${_existing_wt}..."
      git -C "$PLOINKY_REPO_ROOT" worktree remove --force "$_existing_wt" 2>/dev/null || rm -rf "$_existing_wt"
    fi
    git -C "$PLOINKY_REPO_ROOT" worktree prune 2>/dev/null || true
    unset _existing_wt
    PLOINKY_WORKTREE=$(mktemp -d "${TMPDIR:-/tmp}/ploinky-test-worktree-XXXXXX")
    echo "[test] Creating worktree for ploinky branch '${PLOINKY_BRANCH}' at ${PLOINKY_WORKTREE}..."
    git -C "$PLOINKY_REPO_ROOT" worktree add "$PLOINKY_WORKTREE" "$PLOINKY_BRANCH" 2>&1 | sed 's/^/  /'

    # Install dependencies in the worktree (including postinstall which clones achillesAgentLib)
    if [[ -f "$PLOINKY_WORKTREE/package.json" ]]; then
      echo "[test] Installing dependencies in worktree..."
      (cd "$PLOINKY_WORKTREE" && npm install --no-audit --no-fund 2>&1 | tail -3 | sed 's/^/  /')
    fi

    # Find .env from the original repo tree and make it available in the worktree.
    # The LLM suggestion tests walk up from TESTS_DIR to find .env, but the worktree
    # is in /tmp (no .env ancestors). Symlink it into the worktree root so tests find it.
    _orig_dir="$PLOINKY_REPO_ROOT"
    while [[ "$_orig_dir" != "/" ]]; do
      if [[ -f "$_orig_dir/.env" ]]; then
        echo "[test] Loading API keys from ${_orig_dir}/.env"
        set -a; source "$_orig_dir/.env"; set +a
        ln -sf "$_orig_dir/.env" "$PLOINKY_WORKTREE/.env"
        break
      fi
      _orig_dir=$(dirname "$_orig_dir")
    done
    unset _orig_dir

    # Override TESTS_DIR to use the worktree's tests (they match the branch)
    TESTS_DIR="$PLOINKY_WORKTREE/tests"
    # Prepend worktree bin to PATH so 'ploinky' resolves to the branch under test
    export PATH="$PLOINKY_WORKTREE/bin:$PATH"
    echo "[test] Using ploinky from: $(which ploinky)"
  fi
fi
export PLOINKY_BRANCH="${PLOINKY_BRANCH:-}"

# State file for sharing variables between scripts
# BSD mktemp (macOS) keeps the trailing literal `.env` and never substitutes
# the X-template, leaving stale state files in TMPDIR after every run.
FAST_STATE_FILE=$(mktemp "${TMPDIR:-/tmp}/fast-suite-state-XXXXXX")
export FAST_STATE_FILE

# Results file for the final summary
FAST_RESULTS_FILE="$TESTS_DIR/lastRun.results"
export FAST_RESULTS_FILE

# Global error counter
TOTAL_ERRORS=0
ABORTED=0

# Cleanup trap to remove the temporary state file on exit
cleanup() {
  # The state file is temporary and should be removed.
  rm -f "$FAST_STATE_FILE"
  # Clean up ploinky worktree if one was created
  if [[ -n "$PLOINKY_WORKTREE" && -d "$PLOINKY_WORKTREE" ]]; then
    echo "[test] Removing ploinky worktree at ${PLOINKY_WORKTREE}..."
    git -C "$PLOINKY_REPO_ROOT" worktree remove --force "$PLOINKY_WORKTREE" 2>/dev/null || rm -rf "$PLOINKY_WORKTREE"
  fi
  # The results file is an intended artifact and is not removed.
}
trap cleanup EXIT

is_fast_suite_run_dir() {
  local candidate="${1:-}"
  local temp_root candidate_parent candidate_name

  [[ -n "$candidate" && -d "$candidate" && ! -L "$candidate" ]] || return 1
  temp_root=$(cd -- "${TMPDIR:-/tmp}" && pwd -P) || return 1
  candidate_parent=$(cd -- "$(dirname -- "$candidate")" && pwd -P) || return 1
  candidate_name=$(basename -- "$candidate")

  [[ "$candidate_parent" == "$temp_root" ]] || return 1
  [[ "$candidate_name" =~ ^ploinky-fast-([[:alnum:]]{6}|XXXXXX\.[[:alnum:]]{10})$ ]]
}

abort_suite() {
  if [[ $ABORTED -eq 1 ]]; then
    exit 130
  fi
  ABORTED=1
  trap - INT TERM
  set +e
  echo "\n[INFO] Interrupt received. Cleaning up workspace..." >&2
  unset TEST_RUN_DIR TEST_ROUTER_HEALTH_SOCKET
  load_state 2>/dev/null || true
  if is_fast_suite_run_dir "${TEST_RUN_DIR:-}"; then
    if [[ -x "${PLOINKY_FAST_CLI:-}" ]]; then
      (
        cd -- "$TEST_RUN_DIR" || exit 1
        PLOINKY_ROUTER_HEALTH_SOCKET="${TEST_ROUTER_HEALTH_SOCKET:-${PLOINKY_ROUTER_HEALTH_SOCKET:-}}" \
          timeout -k 5s 60s "$PLOINKY_FAST_CLI" destroy
      ) >/dev/null 2>&1
    fi
    rm -rf -- "$TEST_RUN_DIR"
  elif [[ -n "${TEST_RUN_DIR:-}" ]]; then
    echo "[WARN] Refusing interrupt cleanup for non-fast-suite path: ${TEST_RUN_DIR}" >&2
  fi
  if [[ -n "${PLOINKY_WORKTREE:-}" && -d "$PLOINKY_WORKTREE" ]]; then
    git -C "$PLOINKY_REPO_ROOT" worktree remove --force "$PLOINKY_WORKTREE" 2>/dev/null || rm -rf "$PLOINKY_WORKTREE"
  fi
  cd "$TESTS_DIR"
  exit 130
}
trap abort_suite INT TERM

handle_interrupt_exit() {
  local code="$1"
  if [[ $code -eq 130 || $code -eq 143 ]]; then
    abort_suite
  fi
}

# Source the library of helper functions
source "$TESTS_DIR/lib.sh"

# Initialize/clear the results file at the start of the run
init_results

# Default timeouts (seconds)
ACTION_TIMEOUT="${FAST_ACTION_TIMEOUT:-420}"
# The saved-start verification intentionally reruns the complete start suite
# before its persistence checks. On Podman this can exceed seven minutes even
# when every individual check stays within its own bounded timeout.
VERIFY_TIMEOUT="${FAST_VERIFY_TIMEOUT:-600}"
# START_ACTION_TIMEOUT increased to 420s to account for container-based dependency installation
# Each agent runs npm install in a container (~15s), and multiple agents are started
START_ACTION_TIMEOUT="${FAST_START_ACTION_TIMEOUT:-420}"

# Function to run a single stage of the test suite.
# A stage consists of an "action" (do*) and a "verification" (tests*).
run_stage() {
  local label="$1"
  local action="$2"
  local verify="$3"

  stage_header "$label"

  if [[ -n "$action" ]]; then
    run_with_timeout "$ACTION_TIMEOUT" "Executing action script: ${action}" bash "$TESTS_DIR/$action"
    local action_exit=$?
    handle_interrupt_exit "$action_exit"
    if [[ $action_exit -ne 0 ]]; then
      return 1
    fi
  fi

  if [[ -n "$verify" ]]; then
    set +e
    
    FAST_CHECK_ERRORS=0
    run_with_timeout "$VERIFY_TIMEOUT" "Running verification script: ${verify}" bash "$TESTS_DIR/$verify"
    local exit_code=$?
    handle_interrupt_exit "$exit_code"

    if [[ $exit_code -eq 124 ]]; then
        log_result "[FAIL] ${verify} timed out after ${VERIFY_TIMEOUT} seconds."
        TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
    elif [[ $exit_code -ne 0 ]]; then
        log_result "[FAIL] ${verify} reported ${exit_code} failure(s)."
        TOTAL_ERRORS=$((TOTAL_ERRORS + exit_code))
    fi

    set -e
  fi

  return 0
}

run_node_unit_tests() {
    local unit_dir="$TESTS_DIR/unit"
    if [[ ! -d "$unit_dir" ]]; then
      echo "Unit test directory '$unit_dir' not found." >&2
      return 1
    fi

    local test_files=()
    while IFS= read -r -d '' file; do
      test_files+=("$file")
    done < <(find "$unit_dir" -maxdepth 1 -type f \( -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \) -print0)

    if (( ${#test_files[@]} == 0 )); then
      echo "No unit test files found in '$unit_dir'." >&2
      return 1
    fi

    node --test "${test_files[@]}"
}

# --- Main Test Execution Flow ---

# The 'destroy' action is handled in a final, separate block
# to ensure cleanup is attempted even if a stage fails.
# The 'set -e' at the top level will cause the script to exit if any 'do*' script fails.
# We wrap the main stages in a subshell with its own error handling
# to make sure the final summary and cleanup runs.
if ! run_stage "PREPARE STAGE" "doPrepare.sh" "testsAfterPrepare.sh"; then
  fail_message "PREPARE STAGE aborted. Proceeding to cleanup."
  log_result "[FATAL] PREPARE STAGE aborted."
  TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
fi

# Load state from prepare stage to get TEST_AGENT_NAME and TEST_ROUTER_PORT
load_state

stage_header "START STAGE"
set +e
run_with_timeout "$START_ACTION_TIMEOUT" "Executing action script: doStart.sh with args" bash "$TESTS_DIR/doStart.sh" "$TEST_AGENT_NAME" "$TEST_ROUTER_PORT"
start_action_exit=$?
set -e
handle_interrupt_exit "$start_action_exit"
if [[ $start_action_exit -ne 0 ]]; then
  fail_message "START STAGE aborted. Proceeding to cleanup."
  log_result "[FATAL] START STAGE aborted."
  TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
else
  set +e
  FAST_CHECK_ERRORS=0
  run_with_timeout "$VERIFY_TIMEOUT" "Running verification script: testsAfterStart.sh" bash "$TESTS_DIR/testsAfterStart.sh"
  exit_code=$?
  handle_interrupt_exit "$exit_code"
  if [[ $exit_code -eq 124 ]]; then
      log_result "[FAIL] testsAfterStart.sh timed out after ${VERIFY_TIMEOUT} seconds."
      TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
  elif [[ $exit_code -ne 0 ]]; then
      log_result "[FAIL] testsAfterStart.sh reported ${exit_code} failure(s)."
      TOTAL_ERRORS=$((TOTAL_ERRORS + exit_code))
  fi
  set -e
fi

if ! run_stage "STOP STAGE" "doStop.sh" "testsAfterStop.sh"; then
  fail_message "STOP STAGE aborted. Proceeding to cleanup."
  log_result "[FATAL] STOP STAGE aborted."
  TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
fi

if ! run_stage "START AGAIN STAGE" "doStart.sh" "testsAfterStartAgain.sh"; then
  fail_message "START AGAIN STAGE aborted. Proceeding to cleanup."
  log_result "[FATAL] START AGAIN STAGE aborted."
  TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
fi

if ! run_stage "RESTART STAGE" "doRestart.sh" "testsAfterRestart.sh"; then
  fail_message "RESTART STAGE aborted. Proceeding to cleanup."
  log_result "[FATAL] RESTART STAGE aborted."
  TOTAL_ERRORS=$((TOTAL_ERRORS + 1))
fi

# --- Cleanup Stage ---
# This stage runs regardless of the success of previous stages.
set +e # Allow cleanup to run fully
run_stage "DESTROY STAGE"      "doDestroy.sh"         "testsAfterDestroy.sh"
set -e # Re-enable for final summary logic

# --- Post-destroy unit checks ---
stage_header "NODE UNIT STAGE"
set +e
FAST_CHECK_ERRORS=0
test_check "Node unit tests" run_node_unit_tests
finalize_checks
node_unit_failures=$?
if (( node_unit_failures > 0 )); then
  TOTAL_ERRORS=$((TOTAL_ERRORS + node_unit_failures))
fi
set -e

# --- Final Summary ---
stage_header "TEST SUMMARY"

if (( TOTAL_ERRORS == 0 )); then
  pass_message "All tests passed!"
  log_result "[PASS] All tests passed!"
  echo "Full report available in: $FAST_RESULTS_FILE"
  exit 0
else
  fail_message "Suite finished with ${TOTAL_ERRORS} failure(s)."
  log_result "[FAIL] Suite finished with ${TOTAL_ERRORS} failure(s)."
  echo "Full report available in: $FAST_RESULTS_FILE"
  # On failure, print a condensed view of just the failures.
  grep -i "\[FAIL\]\|\[FATAL\]" "$FAST_RESULTS_FILE"
  exit 1
fi
