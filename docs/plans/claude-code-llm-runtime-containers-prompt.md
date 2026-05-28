# Claude Code Prompt: Implement Ploinky LLM Runtime Containers

You are working in `/Users/danielsava/work/file-parser`.

Implement the plan in:

```text
ploinky/docs/plans/llm-runtime-containers-implementation-plan.md
```

The goal is to add hardware-aware LLM runtime containers to Ploinky using:

- `local-llm-architectures/` for the external declarative architecture catalog.
- `llm-runtime/` for specialized Ploinky agents, agent-owned model profiles, launchers, and the internal runtime MCP server.
- `ploinky/` changes only for catalog loading, hardware detection, architecture selection, safe runtime policy, container startup, reuse hashing, selected architecture state, and documentation.

## Read First

Before editing, read:

```text
CLAUDE.md
ploinky/CLAUDE.md
ploinky/docs/plans/llm-runtime-containers-implementation-plan.md
ploinky/cli/services/docker/agentServiceManager.js
ploinky/cli/services/docker/common.js
ploinky/cli/services/docker/containerSecurity.js
ploinky/cli/services/manifestVolumePolicy.js
ploinky/cli/services/docker/secretVars.js
ploinky/cli/server/RoutingServer.js
ploinky/Agent/server/AgentServer.mjs
ploinky/docs/specs/DS003-agent-manifest-and-registry.md
ploinky/docs/specs/DS004-runtime-execution-and-isolation.md
ploinky/docs/specs/DS011-security-model.md
```

Also preserve these invariants:

- Ploinky core must not hardcode optional agent ids such as `planning-local`, `coding-local`, `relevance`, or `language-translation`.
- Ploinky core must not parse or interpret `agent-models.json`.
- Router and WebChat must remain generic and must not learn local model semantics.
- The architecture catalog is declarative data only. Do not execute catalog code.
- Raw container args are forbidden.
- Device access must be allowlisted.
- Persistent host paths must remain under `.ploinky`, except validated devices.
- `HF_TOKEN` must not appear in image refs, command lines, labels, selected architecture state, metadata, logs, or tests snapshots.

## Implementation Strategy

Work in small, testable phases. Do not try to implement every agent or hardware backend at once.

Recommended first milestone:

1. Bootstrap `local-llm-architectures/` with strict schemas and CPU catalog entries.
2. Add Ploinky catalog loading.
3. Add hardware/platform detection with mocked tests.
4. Add architecture selection and CPU fallback.
5. Add safe runtime policy mapping.
6. Integrate the opt-in LLM startup path into `agentServiceManager`.
7. Bootstrap one minimal `llm-runtime/base-local` agent with a fake/test launcher.
8. Add unit tests proving the boundaries and reuse hash.

After that, add the real CPU `llama.cpp` launcher smoke path and then additional specialized agents.

## Required Ploinky Modules

Create:

```text
ploinky/cli/services/llmArchitectureCatalog.js
ploinky/cli/services/hardwareDetection.js
ploinky/cli/services/llmArchitectureSelector.js
ploinky/cli/services/containerRuntimePolicy.js
```

Expected responsibilities:

- `llmArchitectureCatalog.js`
  - Resolve catalog from env, local path, local git repo, or remote git repo.
  - Validate JSON.
  - Reject unknown fields and path traversal.
  - Return normalized catalog, architecture, image, source, and ref metadata.

- `hardwareDetection.js`
  - Detect Docker or Podman.
  - Inspect daemon OCI platform.
  - Normalize CPU architecture.
  - Run allowlisted accelerator probes with timeouts.
  - Return structured facts and concise evidence.

- `llmArchitectureSelector.js`
  - Filter catalog architectures by platform, status, accelerator, and probes.
  - Apply validated overrides.
  - Prefer stable accelerator matches.
  - Fall back to CPU.
  - Return selected image, digest, architecture id, platform, policy, defaults, and explanation.

- `containerRuntimePolicy.js`
  - Merge safety floor, manifest, catalog policy, profile adjustments, and explicit overrides.
  - Reject raw args and unknown fields.
  - Validate device, GPU, IPC, security-opt, shm, and ulimit allowlists.
  - Emit Docker/Podman run args.
  - Compute a canonical runtime policy hash.

## Agent Service Integration

Modify `ploinky/cli/services/docker/agentServiceManager.js`.

Add an explicit manifest opt-in, for example:

```json
{
  "llmRuntime": {
    "enabled": true,
    "architectureCatalog": true
  }
}
```

Behavior:

- Existing non-LLM agents must keep the current behavior.
- For opted-in LLM agents:
  - Load and validate architecture catalog.
  - Detect hardware and daemon platform.
  - Select architecture and image.
  - Build safe runtime policy args.
  - Resolve selected image before dependency-cache preparation.
  - Add runtime policy args to `docker run` or `podman run`.
  - Add labels for architecture, catalog, digest, policy hash, and reuse hash.
  - Write `.ploinky/<agent-or-alias>/runtime/selected-architecture.json`.
  - Include env hash, network, architecture id, image ref/digest, platform, policy hash, catalog id, and catalog ref in the reuse key.

Be careful with ports:

- The LLM runtime MCP/router port is container port `9000`.
- The engine port is `8080`.
- Until an explicit manifest routing port is added, list `9000` before `8080` in LLM agent manifests.
- Prefer adding an explicit routing/MCP port field if it can be done cleanly and tested.

## `local-llm-architectures/` Work

Create the structure:

```text
local-llm-architectures/
  catalog.json
  schemas/
  architectures/
  images/
  build/
  launchers/examples/
  tests/catalog/
  tests/detection-fixtures/
```

Start with CPU entries:

- `cpu-amd64`
- `cpu-arm64`

Then add stubbed but schema-valid entries for:

- `nvidia-cuda-amd64`
- `nvidia-cuda-arm64`
- `amd-rocm-amd64`
- `vulkan-amd64`
- `vulkan-arm64`
- `intel-openvino-amd64`

Keep the stubs declarative and safe. Do not add executable hooks.

## `llm-runtime/` Work

Treat `llm-runtime/` as a Ploinky agent repository.

Create a shared runtime server and one first agent:

```text
llm-runtime/
  shared/runtime-agent/mcp-server.mjs
  shared/runtime-agent/lib/
  shared/launchers/lib/
  schemas/
  base-local/
    manifest.json
    agent-card.json
    agent-models.json
    launchers/
  tests/
```

The runtime server must expose:

- `/mcp`
- `/agent-card`
- `/v1/chat/completions` for chat-capable agents

MCP tools to implement or stub with validated behavior:

- `runtime.describe`
- `runtime.health`
- `runtime.logs`
- `modelProfiles.list`
- `modelProfiles.describe`
- `modelProfiles.setPriorities`
- `modelProfiles.resetPriorities`
- `launchers.list`
- `launchers.describe`
- `launchers.prepare`
- `launchers.start`
- `instance.status`
- `instance.stop`
- `instance.logs`

Use a fake/test launcher first so tests do not require downloading a real model. Add the real CPU `llama.cpp` launcher after the runtime contract is stable.

Launcher contract:

```text
modelLauncher_<modelId>.sh describe
modelLauncher_<modelId>.sh prepare --config <launch-config.json>
modelLauncher_<modelId>.sh start --config <launch-config.json>
modelLauncher_<modelId>.sh stop --instance <instanceId>
modelLauncher_<modelId>.sh status --instance <instanceId>
```

The runtime server must:

- Read `/runtime/selected-architecture.json`.
- Read agent-owned `agent-models.json`.
- Discover launchers.
- Validate launcher metadata.
- Enforce one active inference instance per container by default.
- Store sanitized config/state/logs under `/runtime`.
- Redact `HF_TOKEN`.

## Documentation Work

Update:

```text
ploinky/docs/specs/DS003-agent-manifest-and-registry.md
ploinky/docs/specs/DS004-runtime-execution-and-isolation.md
ploinky/docs/specs/DS011-security-model.md
```

Add:

```text
ploinky/docs/specs/DS012-local-llm-agent-architecture-catalog.md
```

Update:

```text
ploinky/docs/specs/matrix.md
```

Document:

- Manifest opt-in.
- External architecture catalog.
- Hardware detection.
- Safe runtime policy.
- Reuse hash.
- Selected architecture state.
- Security allowlists.
- Agent-owned `agent-models.json`.
- Router remains generic.

## Tests to Add

Add unit tests before broad integration work.

Ploinky tests:

- Valid catalog passes.
- Invalid catalog fails.
- Forked/local catalog works.
- Path traversal is blocked.
- Unknown policy fields fail.
- CPU architecture normalization.
- Docker/Podman platform parsing.
- CPU fallback.
- NVIDIA Docker `--gpus all`.
- NVIDIA Podman CDI device.
- ROCm devices.
- Arbitrary devices rejected.
- Raw args rejected.
- Implicit privileged rejected for LLM runtime policy.
- Reuse hash changes for digest, policy, catalog, and architecture changes.
- Selected architecture state does not contain secrets.

`llm-runtime` tests:

- Agent model profile schema validation.
- Invalid profile launcher reference rejected.
- Launcher discovery.
- Launcher describe validation.
- Priority override validation.
- Priority reset.
- Candidate fallback.
- Runtime describe includes selected architecture and policy hash.
- Logs redact `HF_TOKEN`.
- Chat proxy works against a fake engine.

Smoke tests:

- Existing Ploinky fast tests still pass.
- Existing Ploinky smoke tests still pass.
- Minimal CPU LLM runtime agent starts.
- Runtime health responds.
- `/agent-card` responds.
- Fake launcher describe/start works.

## Commands

After meaningful changes, run the narrowest relevant tests first. Before reporting completion for runtime/startup changes, run:

```bash
cd /Users/danielsava/work/file-parser/ploinky
tests/fast/test_all.sh
tests/smoke/test_all.sh
```

If those are too expensive or blocked, explain exactly what was run and what remains.

## Deliverable Expectations

Keep changes incremental and reviewable.

For each milestone, report:

- Files changed.
- Behavior added.
- Tests added or updated.
- Tests run.
- Known limitations.

Do not claim hardware support is complete until there are tests or real validation for that hardware family.
