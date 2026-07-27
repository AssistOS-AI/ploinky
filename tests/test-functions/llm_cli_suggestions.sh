#!/bin/bash

# Resolve the nearest .env by walking up from the project test directory.
_resolve_llm_env() {
  local dir="$TESTS_DIR"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/.env" ]]; then
      echo "$dir/.env"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

# Source the .env so API keys are exported into the current shell
# and inherited by ploinky subprocesses via process.env.
_load_llm_keys() {
  local supported_keys=(
    OPENAI_API_KEY
    ANTHROPIC_API_KEY
    GEMINI_API_KEY
    HUGGINGFACE_API_KEY
    OPENROUTER_API_KEY
    XAI_API_KEY
    MISTRAL_API_KEY
    AXIOLOGIC_API_KEY
    OPENCODE_API_KEY
    PLOINKY_AGENT_API_KEY
  )
  local key_name
  for key_name in "${supported_keys[@]}"; do
    if [[ -n "${!key_name:-}" ]]; then
      return 0
    fi
  done

  local env_file
  if env_file=$(_resolve_llm_env); then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    for key_name in "${supported_keys[@]}"; do
      if [[ -n "${!key_name:-}" ]]; then
        return 0
      fi
    done
    return 2
  fi
  echo "No .env with LLM API keys found (searched upwards from $TESTS_DIR)." >&2
  return 2
}

# Ensure CLI can forward system commands and surface LLM fallback suggestions.
test_llm_cli_suggestions() {
  load_state

  local output

  if ! output=$(ploinky ls -a 2>&1); then
    echo "'ploinky ls -a' failed." >&2
    return 1
  fi

  if ! grep -q ".ploinky" <<<"$output"; then
    echo "Expected '.ploinky' in 'ploinky ls -a' output." >&2
    printf '%s\n' "--- ploinky ls -a output ---" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  local key_status=0
  _load_llm_keys || key_status=$?
  if (( key_status == 2 )); then
    if ! output=$("$PLOINKY_FAST_CLI" please tell me your purpose 2>&1); then
      echo "Credential-free invalid-command handling failed." >&2
      return 1
    fi
    if ! grep -q "configure .env file" <<<"$output"; then
      echo "Expected credential-free invalid-command guidance." >&2
      printf '%s\n' "$output" >&2
      return 1
    fi
    return 0
  fi
  if (( key_status != 0 )); then
    return 1
  fi

  # `what` is a real command on macOS (`/usr/bin/what`, from SCCS) so the
  # original probe `ploinky what is your purpose?` ends up forwarding to it
  # instead of falling through to LLM suggestion. Use a leading word that's
  # not a binary on any common OS so the system-command lookup misses and
  # the LLM fallback fires on both Linux and macOS.
  if ! output=$(timeout 30s "$PLOINKY_FAST_CLI" please tell me your purpose 2>&1); then
    echo "'please tell me your purpose' failed or timed out." >&2
    return 1
  fi

  if ! grep -q "LLM suggested:" <<<"$output"; then
    echo "Expected single-command prompt with 'LLM suggested:' marker." >&2
    printf '%s\n' "--- please tell me your purpose output ---" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  return 0
}

# Ensure Ploinky Shell (psh) returns an LLM suggestion for freeform input.
test_psh_llm_suggestions() {
  load_state

  local key_status=0
  _load_llm_keys || key_status=$?
  if (( key_status == 2 )); then
    return 0
  fi
  if (( key_status != 0 )); then
    return 1
  fi

  local output

  if ! output=$(timeout -k 5s 45s "$TESTS_DIR/../bin/psh" "How are you?" 2>&1); then
    echo "'psh \"How are you?\"' failed or timed out." >&2
    return 1
  fi

  if ! grep -q "LLM suggested:" <<<"$output"; then
    echo "Expected 'LLM suggested:' marker from psh output." >&2
    printf '%s\n' "--- psh output ---" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  return 0
}
