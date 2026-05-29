# Real Ploinky Local LLM Runtime Test Plan

Date: 2026-05-29

## Goal

Bring up a real `localLLM` Ploinky agent on this machine, using the hardware-aware LLM runtime path, a real container image, the real `base-local` launcher, a real downloaded GGUF model, and the normal Ploinky router route:

```text
POST /localLLM/v1/chat/completions
```

The test is successful only when the response comes from a running local model engine, not from the fake launcher.

## Current Machine Baseline

Observed locally:

- Host: `darwin arm64`
- Node: `darwin arm64`
- Docker CLI: not installed
- Podman: installed; `podman info` reports Linux `arm64`

Therefore the first real test path on this machine should be:

```bash
PLOINKY_LLM_ARCHITECTURE_ID=cpu-arm64
PLOINKY_LLM_AGENT_IMAGE=localhost/ploinky/llm-runtime-cpu-arm64:smoke
```

If the operator specifically wants Docker Desktop instead of Podman, install Docker Desktop first and re-run the same plan with Docker available. Ploinky currently auto-selects `podman` before `docker` when both are present.

## Important Current Gaps

Before an end-to-end prompt test can pass, these must be fixed or handled in the smoke branch:

1. `local-llm-architectures/build/families/cpu/Dockerfile.arm64` is a placeholder. It installs Node and Bash, but not `llama-server` or the Hugging Face `hf` CLI.
2. The placeholder Dockerfiles define an `ENTRYPOINT` that tails forever. A real runtime image must either have no entrypoint or use an entrypoint such as `tini --` that execs the command Ploinky passes.
3. `llm-runtime/base-local/agent-models.json` currently lists only `fake-cpu`. The `/v1/chat/completions` path selects from `agent-models.json`, so it will not start `modelLauncher_llama-cpp-cpu.sh` unless that launcher is a declared candidate.
4. The `fake-cpu` launcher does not start an OpenAI-compatible engine. If it is selected, chat proxying should fail or return no real model output.

## Success Criteria

The run is accepted when all of these are true:

- Ploinky starts `base-local` as alias `localLLM`.
- The selected architecture is `cpu-arm64`.
- The container image is the locally built real image.
- `selected-architecture.json` exists under `.ploinky/agents/localLLM/runtime/`.
- The container exposes the public runtime proxy on host localhost only.
- The control service port `9002` is not host-published.
- `/agent-card` works through the router.
- `/runtime/describe` works through the agent's localhost-published runtime port.
- `launchers.describe` for `llama-cpp-cpu` reports `llama.cpp`.
- `launchers.prepare` downloads or reuses the GGUF under `/models/artifacts`.
- `launchers.start` starts a real `llama-server` process on internal port `8080`.
- `POST /localLLM/v1/chat/completions` returns a coherent model response.
- Restarting the agent reuses the cached model instead of downloading again.
- `HF_TOKEN` or other secrets do not appear in selected architecture state, labels, runtime logs, or launcher logs.

## Phase 1: Build A Real CPU ARM64 Runtime Image

Create a smoke-image Dockerfile in the architecture repo, or temporarily replace the placeholder CPU ARM64 Dockerfile on a smoke branch.

The image must contain:

- `bash`
- `curl`
- `jq`
- `node` and `npm`
- `python3`
- Hugging Face Hub CLI exposing the `hf` command
- `llama-server` on `PATH`
- no blocking `ENTRYPOINT`
- `/models/hf-cache`, `/models/artifacts`, `/models/derived`, and `/runtime`

Recommended image tag:

```bash
localhost/ploinky/llm-runtime-cpu-arm64:smoke
```

Build command for this machine:

```bash
cd /Users/danielsava/work/file-parser/local-llm-architectures
podman build \
  --platform linux/arm64 \
  -t localhost/ploinky/llm-runtime-cpu-arm64:smoke \
  -f build/families/cpu/Dockerfile.arm64 \
  build/families/cpu
```

Image preflight:

```bash
podman run --rm --platform linux/arm64 localhost/ploinky/llm-runtime-cpu-arm64:smoke node --version
podman run --rm --platform linux/arm64 localhost/ploinky/llm-runtime-cpu-arm64:smoke bash --version
podman run --rm --platform linux/arm64 localhost/ploinky/llm-runtime-cpu-arm64:smoke hf --help
podman run --rm --platform linux/arm64 localhost/ploinky/llm-runtime-cpu-arm64:smoke llama-server --version
podman run --rm --platform linux/arm64 localhost/ploinky/llm-runtime-cpu-arm64:smoke sh -lc 'test -d /models/hf-cache && test -d /models/artifacts && test -d /models/derived && test -d /runtime'
```

Expected result: all commands exit `0`. If a command passed after the image but did not run because an entrypoint swallowed it, fix the image before continuing.

## Phase 2: Make `base-local` Select The Real Launcher

Update `llm-runtime/base-local/agent-models.json` for the smoke run so `llama-cpp-cpu` is a declared candidate before `fake-cpu`:

```json
{
  "schemaVersion": 1,
  "profiles": [
    {
      "id": "primary",
      "description": "Primary chat profile using llama.cpp CPU for real local smoke tests.",
      "candidates": [
        { "launcher": "llama-cpp-cpu", "priority": 200, "requiredAccelerators": ["cpu"] },
        { "launcher": "fake-cpu", "priority": 1, "requiredAccelerators": ["cpu"] }
      ]
    }
  ]
}
```

Do not rely on `priority` alone for this test. The current runtime selection walks candidates in document order.

Validate locally:

```bash
cd /Users/danielsava/work/file-parser/llm-runtime
node --test tests/*.test.mjs
```

## Phase 3: Create A Disposable Ploinky Workspace

Use a clean workspace so the test does not disturb the main repository's `.ploinky` state.

```bash
export TEST_WS="$HOME/tmp/ploinky-llm-real-smoke"
rm -rf "$TEST_WS"
mkdir -p "$TEST_WS"
cd "$TEST_WS"
```

Make the local Ploinky CLI available:

```bash
export PATH="/Users/danielsava/work/file-parser/ploinky/bin:$PATH"
```

Install the local `llm-runtime` repo into the workspace. If `ploinky add repo` accepts the local file URL, use it:

```bash
ploinky add repo llm-runtime file:///Users/danielsava/work/file-parser/llm-runtime
ploinky enable repo llm-runtime
```

Fallback if local `add repo` has trouble with the file URL:

```bash
mkdir -p .ploinky/repos
git clone /Users/danielsava/work/file-parser/llm-runtime .ploinky/repos/llm-runtime
ploinky enable repo llm-runtime
```

Enable `base-local` as the user-facing alias `localLLM`:

```bash
ploinky enable agent llm-runtime/base-local devel llm-runtime as localLLM
```

Expected result: `.ploinky/agents.json` contains an enabled agent with alias `localLLM`.

## Phase 4: Start Ploinky With Explicit LLM Runtime Env

Use the local catalog and local image override:

```bash
export PLOINKY_LLM_ARCHITECTURES_PATH="/Users/danielsava/work/file-parser/local-llm-architectures"
export PLOINKY_LLM_ARCHITECTURE_ID="cpu-arm64"
export PLOINKY_LLM_AGENT_IMAGE="localhost/ploinky/llm-runtime-cpu-arm64:smoke"
```

Optional, only if the model requires gated access:

```bash
export HF_TOKEN="<fine-grained-read-token>"
```

Start the router and agent:

```bash
ploinky start localLLM 18088
```

Expected result:

- Ploinky starts a Podman container for `localLLM`.
- Ploinky writes `.ploinky/agents/localLLM/runtime/selected-architecture.json`.
- The router listens on `127.0.0.1:18088`.

If startup fails because Ploinky cannot find the local image, verify:

```bash
podman image inspect localhost/ploinky/llm-runtime-cpu-arm64:smoke
```

## Phase 5: Verify Runtime Selection And Ports

Inspect Ploinky state:

```bash
ploinky status
cat .ploinky/agents/localLLM/runtime/selected-architecture.json | jq .
```

Expected selected architecture fields:

```json
{
  "architecture": {
    "id": "cpu-arm64",
    "platform": "linux/arm64",
    "acceleratorFamily": "cpu",
    "imageRef": "localhost/ploinky/llm-runtime-cpu-arm64:smoke",
    "imageSource": "env-override"
  }
}
```

Find the container and port mappings:

```bash
podman ps --filter 'label=ploinky.llm.architecture=cpu-arm64'
podman inspect "$(podman ps --filter 'label=ploinky.llm.architecture=cpu-arm64' --format '{{.Names}}' | head -n1)" \
  --format '{{json .Config.Labels}}' | jq .
podman port "$(podman ps --filter 'label=ploinky.llm.architecture=cpu-arm64' --format '{{.Names}}' | head -n1)"
```

Expected:

- Labels include `ploinky.llm.architecture=cpu-arm64`.
- Host publishes container port `9000` and `8080` on `127.0.0.1`.
- Host does not publish container port `9002`.

Save the host port mapped to container `9000`:

```bash
export LLM_AGENT_PORT="$(podman port "$(podman ps --filter 'label=ploinky.llm.architecture=cpu-arm64' --format '{{.Names}}' | head -n1)" 9000/tcp | sed 's/.*://')"
```

## Phase 6: Verify Agent Discovery And Runtime Control

Router-level agent card:

```bash
curl -fsS http://127.0.0.1:18088/localLLM/agent-card | jq .
curl -fsS http://127.0.0.1:18088/agent-card | jq .
```

Direct localhost diagnostic runtime endpoint:

```bash
curl -fsS "http://127.0.0.1:${LLM_AGENT_PORT}/health" | jq .
curl -fsS "http://127.0.0.1:${LLM_AGENT_PORT}/runtime/describe" | jq .
curl -fsS "http://127.0.0.1:${LLM_AGENT_PORT}/runtime/launchers" | jq .
curl -fsS "http://127.0.0.1:${LLM_AGENT_PORT}/runtime/launchers/llama-cpp-cpu" | jq .
```

Expected:

- `runtime.describe` shows selected architecture `cpu-arm64`.
- `launchers` includes `llama-cpp-cpu` with `ok: true`.
- `launchers/llama-cpp-cpu` reports engine `llama.cpp`.

## Phase 7: Prepare And Start The Real Launcher

Prepare/download the default model:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"launcher":"llama-cpp-cpu","instanceId":"manual-smoke","parameters":{}}' \
  "http://127.0.0.1:${LLM_AGENT_PORT}/runtime/launchers/prepare" | jq .
```

Expected:

- JSON includes `prepared`.
- Host model cache under `.ploinky/agents/localLLM/models/artifacts/` contains the GGUF file.

Start the launcher explicitly:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"launcher":"llama-cpp-cpu","instanceId":"manual-smoke","parameters":{}}' \
  "http://127.0.0.1:${LLM_AGENT_PORT}/runtime/launchers/start" | jq .
```

Verify status:

```bash
curl -fsS "http://127.0.0.1:${LLM_AGENT_PORT}/runtime/instances/manual-smoke" | jq .
```

Expected:

- Instance status is running.
- A `llama-server` process exists inside the container.

```bash
podman exec "$(podman ps --filter 'label=ploinky.llm.architecture=cpu-arm64' --format '{{.Names}}' | head -n1)" \
  sh -lc 'ps -ef | grep [l]lama-server'
```

## Phase 8: Send A Real Prompt Through Ploinky Router

Use the router path, not the direct container port:

```bash
curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "localLLM",
    "messages": [
      {
        "role": "user",
        "content": "Reply with exactly: Ploinky local LLM smoke OK"
      }
    ],
    "temperature": 0,
    "max_tokens": 32
  }' \
  http://127.0.0.1:18088/localLLM/v1/chat/completions | jq .
```

Expected:

- HTTP status `200`.
- Response shape is OpenAI-compatible.
- `choices[0].message.content` contains a real generated answer close to the requested text.
- The response is not produced by `fake-cpu`; the active instance should be `chat-primary` or `manual-smoke` using `llama-cpp-cpu`.

Confirm instance state after the chat request:

```bash
curl -fsS "http://127.0.0.1:${LLM_AGENT_PORT}/runtime/instances/chat-primary" | jq .
```

## Phase 9: Restart And Cache-Reuse Check

Restart the agent:

```bash
ploinky restart localLLM
```

Re-resolve `LLM_AGENT_PORT`, then prompt again:

```bash
export LLM_AGENT_PORT="$(podman port "$(podman ps --filter 'label=ploinky.llm.architecture=cpu-arm64' --format '{{.Names}}' | head -n1)" 9000/tcp | sed 's/.*://')"

curl -fsS \
  -H 'Content-Type: application/json' \
  -d '{"model":"localLLM","messages":[{"role":"user","content":"Say: cache reuse works"}],"temperature":0,"max_tokens":32}' \
  http://127.0.0.1:18088/localLLM/v1/chat/completions | jq .
```

Expected:

- Prompt succeeds after restart.
- Model file remains under `.ploinky/agents/localLLM/models/artifacts/`.
- Prepare/start should not require another full download.

## Phase 10: Security And Failure Checks

Secret redaction:

```bash
grep -R "hf_" .ploinky/agents/localLLM/runtime .ploinky/agents/localLLM/models 2>/dev/null || true
grep -R "HF_TOKEN" .ploinky/agents/localLLM/runtime 2>/dev/null || true
```

Expected: no secret values. `HF_TOKEN` should not appear in selected architecture state or runtime logs.

Wrong architecture fails closed on this machine:

```bash
PLOINKY_LLM_ARCHITECTURE_ID=nvidia-cuda-amd64 \
PLOINKY_LLM_AGENT_IMAGE=localhost/ploinky/llm-runtime-cpu-arm64:smoke \
ploinky reinstall localLLM
```

Expected: selection fails with a compatibility reason such as `accelerator-family-unavailable` or `required-probes-unmet`.

Restore valid env before continuing:

```bash
export PLOINKY_LLM_ARCHITECTURE_ID=cpu-arm64
```

Control port exposure:

```bash
podman port "$(podman ps --filter 'label=ploinky.llm.architecture=cpu-arm64' --format '{{.Names}}' | head -n1)" | grep 9002 && echo "unexpected 9002 exposure"
```

Expected: no `9002` mapping.

## Cleanup

In the disposable test workspace:

```bash
cd "$TEST_WS"
ploinky destroy
```

Optional image cleanup:

```bash
podman rmi localhost/ploinky/llm-runtime-cpu-arm64:smoke
```

## Follow-Up Automation

After the manual run passes once, convert the flow into a guarded smoke script:

```text
llm-runtime/tests/e2e/real-ploinky-cpu-smoke.sh
```

The script should be opt-in and require:

```bash
RUN_REAL_LLM_SMOKE=1
```

It should skip unless:

- `podman` or `docker` is present.
- The requested local smoke image exists.
- `PLOINKY_LLM_ARCHITECTURES_PATH` points to a valid catalog.
- The operator accepts model download/network use.

The automated smoke should not run in the default unit-test suite because it downloads model artifacts, creates containers, and mutates a Ploinky workspace.
