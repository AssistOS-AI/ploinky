# Ploinky LLM Runtime Containers Implementation Plan

## Purpose

This plan translates the revised LLM runtime container specification into concrete work for the current repository. It is based on a read-only analysis of `ploinky/`, the current placeholder directories `local-llm-architectures/` and `llm-runtime/`, and the workspace runtime invariants.

The implementation must preserve the central boundary:

- Ploinky core owns deployment, hardware detection, safe runtime policy, container lifecycle, volumes, routing, and reuse.
- `local-llm-architectures/` owns the declarative architecture catalog, image metadata, runtime policy recommendations, and build/test assets for hardware families.
- `llm-runtime/` owns specialized Ploinky agents, `agent-models.json`, launcher selection, model priorities, launchers, internal MCP tools, and model process management.
- The router and WebChat must not learn local model semantics, optional agent names, launcher names, or domain-specific MCP tools.

## Current Ploinky Findings

- Container startup is centralized in `ploinky/cli/services/docker/agentServiceManager.js`.
- Runtime detection currently chooses Podman or Docker but does not inspect daemon platform, OCI platform, or accelerators.
- Image resolution currently flows through `resolveManifestImage()` in `ploinky/cli/services/docker/secretVars.js`.
- Container reuse currently depends mainly on an env/network hash label and does not include architecture id, image digest, policy hash, catalog id, or catalog ref.
- `containerSecurity` currently supports only `privileged`.
- Manifest volume policy already restricts manifest host paths under `.ploinky`; this should remain the persistent-state rule.
- Router endpoints are already generic: `/agent-card`, `/agent-card/<agent>`, `/v1/chat/completions/<agent>`, and `/mcps/<agent>/mcp`.
- The shared `AgentServer` exposes `/agent-card`, `/mcp`, and `/v1/chat/completions`, but the LLM runtime images may provide their own runtime server on port `9000`.
- `local-llm-architectures/` and `llm-runtime/` currently only contain README placeholders.

## Non-Negotiable Boundaries

1. Ploinky core must not hardcode optional agents such as `planning-local`, `coding-local`, `relevance`, or `language-translation`.
2. Ploinky core must not parse or interpret `agent-models.json`.
3. The architecture catalog must be declarative data only. Ploinky must not execute catalog code during runtime selection.
4. Runtime policy must be typed and allowlisted. Raw container args are forbidden.
5. Devices must be allowlisted explicitly. Device mounts are not manifest volumes.
6. Host volumes must remain under `.ploinky`, except for validated device grants.
7. `HF_TOKEN` may be injected as an env secret, but must never appear in image refs, command lines, state files, metadata, or logs.
8. The router should continue to proxy generic surfaces and should not acquire LLM-specific dispatch logic.

## Phase 1: Bootstrap `local-llm-architectures/`

Create a real external-catalog-style repository in `local-llm-architectures/`.

Recommended structure:

```text
local-llm-architectures/
  catalog.json
  schemas/
    catalog.schema.json
    architecture.schema.json
    image.schema.json
    runtime-policy.schema.json
  architectures/
    cpu-amd64.json
    cpu-arm64.json
    nvidia-cuda-amd64.json
    nvidia-cuda-arm64.json
    amd-rocm-amd64.json
    vulkan-amd64.json
    vulkan-arm64.json
    intel-openvino-amd64.json
  images/
    cpu-amd64.json
    cpu-arm64.json
    nvidia-cuda-amd64.json
    amd-rocm-amd64.json
    vulkan-amd64.json
    intel-openvino-amd64.json
  build/
    common/
    families/
    variants/
  launchers/
    examples/
  tests/
    catalog/
    detection-fixtures/
```

Schema requirements:

- Use strict schemas with no unknown runtime-consumed fields.
- Catalog fields: `schemaVersion`, `catalogId`, `updatedAt`, `defaultFallback`, `architectures`, `images`.
- Architecture fields: `id`, `status`, `platform`, `accelerator`, `match`, `image`, `runtimePolicy`, `engineDefaults`, `fallbackPriority`.
- Runtime policy fields: `platform`, `resources`, `devices`, `securityOpt`, `ipc`, `gpus`.
- Image metadata must include digest fields before release.
- Do not allow `rawArgs`, arbitrary shell snippets, post-select hooks, or executable catalog logic.

Initial architecture entries:

- `cpu-amd64`, stable, `linux/amd64`.
- `cpu-arm64`, stable, `linux/arm64`.
- `nvidia-cuda-amd64`, stable, `linux/amd64`.
- `nvidia-cuda-arm64`, experimental, `linux/arm64`.
- `amd-rocm-amd64`, stable, `linux/amd64`.
- `vulkan-amd64`, stable, `linux/amd64`.
- `vulkan-arm64`, experimental, `linux/arm64`.
- `intel-openvino-amd64`, stable, `linux/amd64`.

Implementation detail:

- Image references should support a safe agent-id template, such as a literal template token for the agent image name.
- Ploinky should only substitute validated values such as manifest `id` or active alias. It must not perform shell-style expansion from catalog data.

## Phase 2: Add Ploinky Catalog Loading

Create `ploinky/cli/services/llmArchitectureCatalog.js`.

Responsibilities:

- Resolve catalog source from:
  - `PLOINKY_LLM_ARCHITECTURES_REPO`
  - `PLOINKY_LLM_ARCHITECTURES_REF`
  - `PLOINKY_LLM_ARCHITECTURES_PATH`
  - `PLOINKY_LLM_CATALOG_CACHE_DIR`
- Support local path, local git repository, and remote git repository.
- Cache cloned catalogs under `.ploinky` or the configured cache dir.
- Read JSON only.
- Validate all JSON before returning it.
- Reject path traversal in referenced architecture or image files.
- Reject unknown fields in runtime-consumed objects.
- Return normalized catalog metadata, architecture records, image records, source path, ref, and validation diagnostics.

Recommended dependency decision:

- Prefer `ajv` for strict JSON Schema validation if adding a dependency is acceptable.
- If dependency churn is undesirable, implement a small internal strict validator for the first pass and keep schemas as the published contract.

## Phase 3: Add Hardware and Platform Detection

Create `ploinky/cli/services/hardwareDetection.js`.

Responsibilities:

- Detect selected container runtime using the existing Podman/Docker logic as the base.
- Inspect daemon platform using:
  - `docker info`
  - `docker version`
  - `podman info --format json`
- Normalize architecture values:
  - Node `x64` and `uname -m` `x86_64` to `amd64`.
  - Node `arm64` and `uname -m` `aarch64` to `arm64`.
  - OCI `linux/amd64` and `linux/arm64` as canonical platforms.
- Run allowlisted accelerator probes with short timeouts:
  - NVIDIA Docker: `nvidia-smi -L`.
  - NVIDIA Podman CDI: `nvidia-ctk cdi list`.
  - AMD ROCm: `/dev/kfd`, `/dev/dri`, `rocminfo`, `amd-smi`.
  - Intel/OpenVINO: `/dev/dri`, `/dev/accel`, `lspci`.
  - Vulkan: `/dev/dri`, `vulkaninfo --summary`.
  - CPU fallback: daemon OCI platform.
- Return structured facts and evidence.
- Avoid logging raw command output when it may contain host-specific sensitive paths. Keep evidence concise and redacted.

## Phase 4: Add Architecture Selection

Create `ploinky/cli/services/llmArchitectureSelector.js`.

Responsibilities:

- Accept manifest, active profile, agent name, alias, catalog, hardware facts, and process env.
- Filter architectures by:
  - Valid status.
  - OCI platform compatibility.
  - Accelerator family.
  - Required probe matches.
  - Catalog match rules.
- Apply explicit overrides after validation:
  - `PLOINKY_LLM_ARCHITECTURE_ID`
  - `PLOINKY_LLM_AGENT_IMAGE`
  - `PLOINKY_<AGENT>_IMAGE`
  - `PLOINKY_LLM_FORCE_PLATFORM`
  - `PLOINKY_LLM_ACCELERATOR`
- Prefer stable accelerator matches.
- Use catalog CPU fallback if an accelerator is unavailable.
- Return:
  - `architectureId`
  - `catalogId`
  - `catalogRef`
  - `platform`
  - `acceleratorFamily`
  - `imageRef`
  - `imageDigest`
  - `runtimePolicy`
  - `engineDefaults`
  - decision explanation
  - probe evidence summary

Selection rules:

- Experimental architectures should only win when explicitly selected or enabled by a profile.
- Image override may replace the image, but must not bypass runtime policy validation.
- Architecture override must fail closed if the selected architecture does not exist or is incompatible with hard safety rules.

## Phase 5: Add Safe Runtime Policy Mapping

Create `ploinky/cli/services/containerRuntimePolicy.js`.

Responsibilities:

- Merge policy sources in this precedence order:
  1. Ploinky safety floor.
  2. Agent manifest minimum contract.
  3. Architecture catalog recommendation.
  4. Active profile local adjustments.
  5. Explicit validated overrides.
- Validate the merged policy.
- Convert the merged policy into Docker or Podman `run` args.
- Compute a stable `runtimePolicyHash` from the canonical policy.

Allowed fields:

- `platform`
- `resources.memory`
- `resources.cpus`
- `resources.pidsLimit`
- `resources.shmSize`
- `resources.ulimits.memlock`
- `devices[].type = cdi`
- `devices[].type = hostDevice`
- `securityOpt`
- `ipc`
- `gpus`

Allowlist:

- CDI devices: `nvidia.com/gpu=all` and validated `nvidia.com/gpu=<id>` forms.
- Host devices: `/dev/kfd`, `/dev/dri`, `/dev/accel`, and validated child paths where needed.
- `securityOpt`: start with `label=disable` only.
- `ipc`: default or `host`.
- `gpus`: start with `all`; add explicit device lists only after tests.
- Ulimits: start with `memlock`.

Rejected:

- `rawArgs`.
- Unknown policy keys.
- Arbitrary host devices.
- Implicit privileged mode.
- Host filesystem mounts outside `.ploinky`.
- Image references containing secrets.

## Phase 6: Integrate with `agentServiceManager`

Modify `ploinky/cli/services/docker/agentServiceManager.js`.

Integration points:

1. Resolve active profile as today.
2. Detect whether the manifest opted into hardware-aware LLM startup.
3. If not opted in, preserve the existing startup behavior.
4. If opted in:
   - Load the architecture catalog.
   - Detect hardware and container daemon platform.
   - Select architecture and image.
   - Build validated runtime policy args.
   - Compute full reuse hash.
5. Ensure selected image resolution happens before dependency-cache preparation.
6. Inject runtime policy args into `podman run` or `docker run`.
7. Add labels:
   - `ploinky.llm.architecture`
   - `ploinky.llm.catalog`
   - `ploinky.llm.catalogref`
   - `ploinky.llm.policyhash`
   - `ploinky.llm.imagedigest`
   - `ploinky.reusehash`
8. Write selected architecture state to the mounted runtime directory before container start:

```text
.ploinky/<agent-or-alias>/runtime/selected-architecture.json
```

9. Include in the reuse key:
   - env hash
   - effective network
   - architecture id
   - image ref
   - image digest
   - OCI platform
   - runtime policy hash
   - catalog id
   - catalog ref

10. Recreate the container when the reuse hash changes.

Manifest opt-in:

Use a small explicit extension, for example:

```json
{
  "llmRuntime": {
    "enabled": true,
    "architectureCatalog": true
  }
}
```

This keeps existing agents unchanged.

Port routing:

- The LLM runtime MCP server should be reachable on container port `9000`.
- The engine should bind internally to `8080`.
- The manifest should list the `9000` port first until Ploinky has an explicit `routing.port` or `mcpPort` manifest field.
- Prefer adding an explicit routing/MCP port field to avoid relying on port ordering.

## Phase 7: Bootstrap `llm-runtime/`

Treat `llm-runtime/` as a Ploinky agent repository.

Recommended structure:

```text
llm-runtime/
  README.md
  shared/
    runtime-agent/
      mcp-server.mjs
      lib/
        launcherRegistry.mjs
        launcherProcess.mjs
        modelProfiles.mjs
        runtimeState.mjs
        redaction.mjs
        schemas.mjs
    launchers/
      lib/
        config.sh
        process.sh
        redaction.sh
  schemas/
    agent-models.schema.json
    launcher-describe.schema.json
    launch-config.schema.json
  base-local/
    manifest.json
    agent-card.json
    agent-models.json
    launchers/
  planning-local/
    manifest.json
    agent-card.json
    agent-models.json
    launchers/
  relevance/
    manifest.json
    agent-card.json
    agent-models.json
    launchers/
  language-detection/
    manifest.json
    agent-card.json
    agent-models.json
    launchers/
  tests/
    unit/
    smoke/
```

First-wave agent order:

1. `base-local`: general chat/tool assistant with CPU `llama.cpp` smoke path.
2. `planning-local`: planning/spec LLM agent with explicit profile.
3. `relevance`: reranker MCP tool agent.
4. `language-detection`: embedded classifier agent without an LLM engine server.
5. Add the remaining agents after the runtime contract is stable.

Agent manifest requirements:

- `container` should support `${PLOINKY_<AGENT>_IMAGE}` for the interim path.
- `llmRuntime.enabled` should opt into hardware-aware catalog selection.
- `HF_TOKEN` should be declared as optional.
- Volumes must be under `.ploinky/<agent-or-alias>/...`.
- Port `9000` is the runtime server/MCP/router port.
- Port `8080` is the internal OpenAI-compatible engine port and can be published only when useful.
- The agent must publish `/agent-card`.

## Phase 8: Implement the Internal Runtime Server

Implement `llm-runtime/shared/runtime-agent/mcp-server.mjs`.

Required HTTP surfaces:

- `/mcp`
- `/agent-card`
- `/v1/chat/completions` for chat-capable agents
- `/health` or equivalent readiness endpoint if useful

Required MCP tools:

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

Runtime behavior:

- Read `/runtime/selected-architecture.json`.
- Read agent-owned `agent-models.json`.
- Discover launchers from `/opt/ploinky/launchers` and any agent-local launcher directory included in the image.
- Validate launcher metadata returned by `describe`.
- Validate all MCP inputs before writing launch configs.
- Store launch configs under `/runtime/launch-configs/`.
- Store process state under `/runtime/instances/`.
- Store logs under `/runtime/logs/`.
- Enforce one active inference instance per container by default.
- Stop or reuse active instances according to launcher compatibility.
- Redact secrets from all logs and error messages.

Chat behavior:

- Map incoming chat requests to an agent-owned profile such as `primary`.
- Select the launcher locally using `agent-models.json`, active priority overrides, `runtime.describe`, and `launchers.describe`.
- Start or reuse the launcher.
- Proxy the request to `http://127.0.0.1:8080/v1/chat/completions`.
- Preserve streaming behavior where possible.
- Return a clear error when no compatible launcher is available.

Non-chat behavior:

- `relevance` should expose scoring/reranking through MCP tools.
- `language-detection` should expose a classifier MCP tool and should not require the engine port.

## Phase 9: Implement Launcher Contract

Each launcher script must support:

```text
modelLauncher_<modelId>.sh describe
modelLauncher_<modelId>.sh prepare --config <launch-config.json>
modelLauncher_<modelId>.sh start --config <launch-config.json>
modelLauncher_<modelId>.sh stop --instance <instanceId>
modelLauncher_<modelId>.sh status --instance <instanceId>
```

Launcher responsibilities:

- Own the Hugging Face repo id, revision, model files, model format, and engine.
- Use `hf download` with persistent cache.
- Prepare derived artifacts when needed.
- Map normalized MCP parameters to engine-specific flags.
- Reject unsupported parameters.
- Never log `HF_TOKEN`.
- Never accept raw engine args from MCP.
- Return structured JSON status.

Initial launcher target:

- Add one CPU `llama.cpp` launcher for a small GGUF model to make the first smoke test practical.

## Phase 10: Documentation Updates

Update Ploinky docs after implementation begins:

- `ploinky/docs/specs/DS003-agent-manifest-and-registry.md`
  - Document the LLM manifest opt-in.
  - Document templated image fallback and catalog-selected image behavior.
  - State that `agent-models.json` is agent-owned.

- `ploinky/docs/specs/DS004-runtime-execution-and-isolation.md`
  - Document hardware detection.
  - Document selected architecture state.
  - Document runtime policy args.
  - Document reuse hash changes.

- `ploinky/docs/specs/DS011-security-model.md`
  - Document device allowlists.
  - Document GPU/CDI handling.
  - Document `security-opt`, `ipc`, `shm`, and ulimit rules.
  - Document raw args rejection.
  - Document HF token handling.

- Add `ploinky/docs/specs/DS012-local-llm-agent-architecture-catalog.md`
  - Define catalog contract, selection, overrides, policy model, and boundaries.

- Update `ploinky/docs/specs/matrix.md`.

## Phase 11: Tests

Ploinky unit tests:

- Valid catalog passes.
- Invalid catalog is rejected.
- Forked/local catalog can be loaded.
- Path traversal in catalog references is rejected.
- Unknown runtime policy fields are rejected.
- `x64` normalizes to `amd64`.
- `aarch64` normalizes to `arm64`.
- Docker daemon platform is parsed.
- Podman daemon platform is parsed.
- CPU fallback is selected when accelerator probes fail.
- NVIDIA Docker policy emits `--gpus all` only when compatible.
- NVIDIA Podman policy emits CDI device only when CDI exists.
- ROCm policy emits `/dev/kfd` and `/dev/dri`.
- Arbitrary device is rejected.
- Raw args are rejected.
- Implicit privileged mode is rejected.
- Image override changes the image but policy remains validated.
- Reuse hash changes when digest changes.
- Reuse hash changes when runtime policy changes.
- Reuse hash changes when catalog id/ref changes.
- Selected architecture JSON is written without secrets.
- `HF_TOKEN` is not present in logs, labels, selected architecture state, or command-line args.

`local-llm-architectures` tests:

- Catalog schema validation.
- Every referenced architecture file exists.
- Every referenced image file exists.
- Every architecture has a supported platform.
- Every stable architecture has image metadata.
- Runtime policies do not contain forbidden fields.
- Fixture-based selection for CPU, NVIDIA, ROCm, Intel, and Vulkan.

`llm-runtime` tests:

- Agent model profile schema validation.
- Invalid profile references to nonexistent launcher are rejected.
- `launchers.list` discovers scripts.
- `launchers.describe` validates launcher JSON.
- `launchers.start` writes sanitized launch configs.
- Single active instance reuse works.
- Incompatible active instance is stopped before switching.
- Valid priority override reorders declared launchers.
- Invalid priority override rejects unknown launchers.
- Invalid priority override rejects disallowed scope.
- Reset priority returns to defaults.
- Candidate fallback selects next compatible launcher.
- `runtime.describe` includes architecture and policy hash.
- Logs redact `HF_TOKEN`.
- Chat proxy starts launcher and proxies to fake engine.
- `relevance` exposes scoring MCP tool.
- `language-detection` responds through MCP without starting an engine server.

Integration smoke tests:

- CPU container starts on `linux/amd64` or `linux/arm64`.
- Runtime MCP health responds.
- `/agent-card` publishes local-only capability metadata.
- `launchers.describe` returns schema.
- Small GGUF model starts through `llama.cpp`.
- HF cache is reused after restart.
- Agent alias starts a separate isolated container.
- Logs do not contain `HF_TOKEN`.

Optional hardware tests:

- NVIDIA Docker starts with `--gpus all`.
- NVIDIA Podman starts with `nvidia.com/gpu=all` CDI.
- AMD ROCm sees `/dev/kfd` and `/dev/dri`.
- Intel/OpenVINO serves on selected device.
- Vulkan-backed `llama.cpp` starts.

## Recommended Implementation Order

1. Add catalog schemas and minimal CPU catalog.
2. Add catalog loader and tests.
3. Add hardware detection with mocked command fixtures.
4. Add architecture selector and tests.
5. Add container runtime policy builder and tests.
6. Integrate LLM opt-in path in `agentServiceManager`.
7. Add reuse hash and selected architecture state.
8. Bootstrap `llm-runtime` with `base-local`.
9. Implement runtime MCP server with fake-launcher tests.
10. Add CPU `llama.cpp` launcher smoke path.
11. Add `planning-local`, `relevance`, and `language-detection`.
12. Update DS docs and matrix.
13. Run Ploinky fast/smoke tests and LLM runtime smoke tests.

## Acceptance Checklist

- Ploinky starts an LLM agent using the default local catalog.
- Ploinky can use a custom catalog through environment variables.
- CPU `amd64` and CPU `arm64` selection work.
- NVIDIA selection works when probes pass.
- CPU fallback works when accelerator probes fail.
- Selection explanation appears in logs and `runtime.describe`.
- Catalog loading executes no code.
- Raw container args are rejected.
- Arbitrary devices are rejected.
- Reuse hash includes architecture id, image digest, platform, catalog id/ref, and runtime policy hash.
- Launcher maps normalized parameters without Ploinky knowing engine flags.
- `HF_TOKEN` is not leaked.
- Specialized agents publish capability metadata through `/agent-card`.
- The same agent can run under different aliases.
- Priority overrides happen through MCP and remain agent-owned.
- Orchestrators can discover agents through `/agent-card` and call `/mcps/<agent>/mcp`.
