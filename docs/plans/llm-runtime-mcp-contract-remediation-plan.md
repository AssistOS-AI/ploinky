# LLM Runtime Findings Remediation Plan

## Purpose

Bring the new `llm-runtime` agents and hardware-aware catalog integration into alignment with the existing Ploinky runtime contract.

The confirmed finding is not that Ploinky lacks MCP support. Existing Ploinky agents already expose MCP through `/mcp`, usually by running the shared `/Agent/server/AgentServer.sh` and declaring tools in `mcp-config.json`. The new LLM runtime agents currently replace that path with `manifest.start = "node /Agent/llm-runtime/runtime-agent/mcp-server.mjs"`, and that custom server exposes REST-style runtime endpoints but not the existing Streamable HTTP MCP endpoint.

This plan also covers the architecture-selection, Podman/NVIDIA, platform-validation, hardware-probe, model-storage, and registry-image findings from review.

The implementation goal is:

- LLM runtime agents expose a real `/mcp` endpoint.
- Architecture overrides remain explicit but still validated.
- Catalog image/platform/policy combinations cannot drift into impossible selections.
- Accelerator availability is based on confirmed runtime signals, not device-file presence alone.
- Model artifacts live under `/models`, while `/runtime` stays ephemeral runtime state.
- Registry records report the actual catalog-selected image.

## Current Observations

- Ploinky's shared `AgentServer.mjs` loads MCP declarations from `/code/mcp-config.json` by default.
- The shared `AgentServer.mjs` exposes Streamable HTTP MCP at `/mcp`.
- The shared server verifies router-minted invocation JWTs before executing configured MCP tools.
- Many AssistOSExplorer agents use the pattern:
  - `manifest.json` declares `agent`.
  - `scripts/startAgent.sh` performs local setup.
  - The script ends with `exec sh /Agent/server/AgentServer.sh`.
  - Tool contracts live in `mcp-config.json`.
- Some AssistOSExplorer agents with no explicit `agent` or `start` still get MCP because Ploinky falls back to `sh /Agent/server/AgentServer.sh`.
- Explorer is the main custom-server exception. It implements MCP directly with the MCP SDK and explicitly routes `/mcp` to `StreamableHTTPServerTransport`.
- WebMeet is a hybrid. It starts a domain API, starts shared `AgentServer` on an internal MCP port, then runs a public proxy that forwards `/mcp` to the MCP sidecar.
- The new LLM runtime agents use `manifest.start`, which bypasses the default AgentServer fallback.
- The current LLM runtime server handles `/health`, `/agent-card`, `/runtime/*`, and `/v1/chat/completions`, but `/mcp` returns 404.

## Additional Review Findings

### P1: Architecture Override Bypasses Compatibility Validation

`PLOINKY_LLM_ARCHITECTURE_ID` currently selects the requested architecture directly before platform and probe filtering. That lets a CPU-only machine force `nvidia-cuda-amd64` and receive a CUDA runtime policy with `gpus: all`.

Required behavior:

- Explicit architecture overrides select only a catalog-declared architecture that is still compatible with the detected or explicitly forced platform, runtime, status gate, and required probes.
- An override may influence choice among compatible candidates; it must not bypass hardware safety.
- If the operator requests an incompatible architecture, selection must fail with a clear explanation instead of silently falling through or applying unsafe policy.

### P1: NVIDIA Podman Path Is Not Representable

`nvidia-cuda-amd64` currently requires `nvidiaSmi` and declares `gpus: all`. That works only for Docker's NVIDIA path. `containerRuntimePolicy.js` correctly rejects `gpus` for Podman, but the catalog has no Podman/CDI NVIDIA architecture or policy.

Required behavior:

- Docker NVIDIA selection uses `--gpus all` only when Docker runtime and NVIDIA Docker probes are compatible.
- Podman NVIDIA selection uses CDI devices, for example `--device nvidia.com/gpu=all`, only when `nvidia-ctk cdi list` succeeds.
- The catalog and selector must distinguish Docker-NVIDIA and Podman-CDI policies.

### P2: Architecture Platform Can Disagree With Image Platform

Experimental ARM64 accelerator records reference AMD64 images:

- `nvidia-cuda-arm64` references `nvidia-cuda-amd64`.
- `vulkan-arm64` references `vulkan-amd64`.

The selector currently does not validate that the selected image's platform matches the architecture platform.

Required behavior:

- Catalog loading or selection rejects architecture records whose image platform conflicts with the architecture platform.
- Runtime policy platform, architecture platform, and image platform must agree unless the image record explicitly declares a valid multi-platform contract.
- `allowExperimental` must not allow impossible image/platform combinations.

### P2: Accelerator Availability Is Overstated

`hardwareDetection.js` currently marks:

- Vulkan available when `/dev/dri` exists.
- Intel OpenVINO available when `/dev/dri` exists.
- ROCm available when `/dev/kfd` and `/dev/dri` exist.

The spec requires runtime or renderer confirmation, such as `vulkaninfo`, `rocminfo`, `amd-smi`, or an Intel device probe.

Required behavior:

- Device-file probes are necessary but not sufficient for accelerated families.
- ROCm requires `/dev/kfd`, `/dev/dri`, and `rocminfo` or `amd-smi`.
- Vulkan requires `/dev/dri` and `vulkaninfo --summary` with a renderer.
- Intel OpenVINO requires `/dev/dri` or `/dev/accel` plus an Intel GPU/NPU confirmation probe.
- CPU remains the mandatory fallback.

### P2: Model Artifacts Are Stored Under `/runtime`

`modelLauncher_llama-cpp-cpu.sh` currently stores model files under `/runtime/models`. The manifests do not mount `/models` or set the environment contract documented in the spec.

Required behavior:

- Long-lived model data lives under `/models`.
- Hugging Face cache lives under `/models/hf-cache`.
- Downloaded artifacts live under `/models/artifacts`.
- Derived engine artifacts live under `/models/derived`.
- `/runtime` contains only state, logs, PIDs, launch configs, and selected architecture metadata.

### P3: Registry Image Record Can Report The Wrong Image

`agentServiceManager.js` writes `.ploinky/agents.json` with the manifest-resolved `image` value after `startAgentContainer()` has already selected the catalog image. Runtime labels are correct, but the registry can report a stale or templated image.

Required behavior:

- The registry record must store the actual image used for container startup.
- It should also store the unresolved manifest image separately if useful for diagnostics.
- LLM runtime image digest, architecture id, policy hash, and catalog id/ref should remain available in labels and registry metadata.

## Target Design

Use the WebMeet-style hybrid pattern for LLM runtime agents:

1. Keep the current runtime control server, but treat it as an internal runtime service.
2. Run the existing Ploinky shared `AgentServer` as the MCP sidecar.
3. Add a small public LLM runtime proxy on the manifest-published port.
4. Route `/mcp` through the proxy to the AgentServer sidecar.
5. Route `/runtime/*`, `/health`, `/agent-card`, and `/v1/chat/completions` through the proxy to the runtime control service.
6. Declare runtime operations in `mcp-config.json`, backed by small command wrappers that call the internal runtime service.

This preserves Ploinky's existing MCP behavior and secure-wire verification, while avoiding a forked MCP implementation inside the LLM runtime server.

## Port Layout

Use explicit internal port names so the public contract is stable:

- Public agent port: `9000`
  - Bound by the manifest profile.
  - Served by the new proxy process.
  - Handles `/mcp`, `/health`, `/agent-card`, `/runtime/*`, and `/v1/chat/completions`.
- Internal MCP sidecar port: `9001`
  - Served by `/Agent/server/AgentServer.sh`.
  - Receives proxied `/mcp` traffic only.
- Internal runtime control port: `9002`
  - Served by the existing runtime control server.
  - Receives proxied runtime REST and chat traffic.
- Internal model endpoint port: `8080`
  - Served by the active model engine.
  - Still started only by a launcher.

Suggested environment variables:

- `PLOINKY_LLM_PUBLIC_PORT=9000`
- `PLOINKY_LLM_MCP_PORT=9001`
- `PLOINKY_LLM_CONTROL_PORT=9002`
- `PLOINKY_LLM_ENGINE_PORT=8080`

Keep compatibility with the existing `PLOINKY_LLM_RUNTIME_PORT` during migration, but stop using it ambiguously for both public and control traffic.

## Implementation Phases

### Phase A: Fix Architecture Selection Overrides

Update `ploinky/cli/services/llmArchitectureSelector.js`.

Implementation tasks:

- Extract candidate compatibility checks into a single reusable function, for example `validateCandidateCompatibility(candidate, catalog, hardware, options)`.
- Use that function for both automatic candidates and `PLOINKY_LLM_ARCHITECTURE_ID`.
- Validate these dimensions for override selections:
  - architecture exists in the catalog.
  - status is `stable`, unless `allowExperimental` is active.
  - architecture platform matches daemon or forced platform.
  - accelerator family matches `PLOINKY_LLM_ACCELERATOR` when provided.
  - required probes are present and successful.
  - image exists and is compatible with the architecture platform.
  - runtime policy is compatible with the selected container runtime.
- Return a structured rejection reason for failed overrides.

Tests:

- CPU-only hardware plus `PLOINKY_LLM_ARCHITECTURE_ID=nvidia-cuda-amd64` fails.
- CPU-only hardware plus `PLOINKY_LLM_ARCHITECTURE_ID=cpu-amd64` succeeds on `linux/amd64`.
- Missing required probe fails even with an architecture override.
- Experimental architecture override fails unless `allowExperimental` is enabled.
- `PLOINKY_LLM_FORCE_PLATFORM` and architecture override must agree.

### Phase B: Add Runtime-Aware NVIDIA Catalog Support

Update `local-llm-architectures` schemas, catalog records, and selector logic.

Recommended first implementation:

- Add `match.containerRuntimes` to `architecture.schema.json`.
- Keep the existing Docker-oriented NVIDIA architecture as Docker-only:
  - `id`: `nvidia-cuda-amd64`
  - `match.containerRuntimes`: `["docker"]`
  - `match.requiredProbes`: `["nvidiaSmi"]`
  - `runtimePolicy.gpus`: `"all"`
- Add a Podman CDI variant:
  - `id`: `nvidia-cuda-cdi-amd64`
  - `platform`: `linux/amd64`
  - `accelerator.family`: `nvidia-cuda`
  - `match.containerRuntimes`: `["podman"]`
  - `match.requiredProbes`: `["nvidiaCdi"]`
  - `runtimePolicy.devices`: `[{ "type": "cdi", "name": "nvidia.com/gpu=all" }]`
  - no `runtimePolicy.gpus`.
- Update selector compatibility to reject architectures whose `match.containerRuntimes` does not include the detected runtime.
- Keep `containerRuntimePolicy.js` rejection of Podman `gpus`; it is the correct safety floor.

Tests:

- Docker + `nvidiaSmi` selects Docker NVIDIA and emits `--gpus all`.
- Podman + `nvidiaCdi` selects CDI NVIDIA and emits `--device nvidia.com/gpu=all`.
- Podman + only `nvidiaSmi` does not select Docker NVIDIA.
- Docker + only `nvidiaCdi` does not emit CDI unless Docker CDI support is explicitly added later.

### Phase C: Validate Architecture/Image/Policy Platform Consistency

Update catalog loading and selection.

Implementation tasks:

- During catalog validation, resolve every architecture's `image` field to an image record.
- Reject missing image references.
- If `image.platform` is present, require it to equal `architecture.platform`.
- If `runtimePolicy.platform` is present, require it to equal `architecture.platform`.
- Add a future-compatible image schema extension only if needed:
  - `platforms`: array of OCI platforms for a real manifest-list image.
  - If `platforms` exists, the architecture platform must be included.
  - Do not allow both contradictory `platform` and `platforms`.
- Fix current bad records:
  - either add real `nvidia-cuda-arm64` and `vulkan-arm64` image records, or disable/remove those architecture records until images exist.
  - do not point ARM64 architectures at AMD64 image records.

Tests:

- Catalog validation rejects ARM64 architecture referencing AMD64 image.
- Catalog validation rejects runtime policy platform mismatch.
- `allowExperimental` does not bypass image platform validation.
- Valid CPU AMD64 and CPU ARM64 records continue to pass.

### Phase D: Tighten Hardware Detection

Update `ploinky/cli/services/hardwareDetection.js`.

Implementation tasks:

- Change `summarizeAcceleratorFamilies()` so device files alone do not advertise accelerated families.
- Add or refine probes:
  - `rocminfo` command.
  - `amd-smi` command.
  - `vulkaninfo --summary` command and output check for a renderer.
  - Intel confirmation probe, preferably `lspci` parsing for Intel VGA/3D/NPU devices plus `/dev/dri` or `/dev/accel`.
- Return richer probe details so selection explanations can say which confirmation failed.
- Keep probes allowlisted, bounded by timeout, and non-fatal.
- Ensure missing optional tools do not crash detection; they should simply mark the confirmation probe as failed.

Tests:

- `/dev/dri` alone does not add `vulkan`.
- `/dev/dri` plus successful `vulkaninfo` adds `vulkan`.
- `/dev/kfd` and `/dev/dri` alone do not add `amd-rocm`.
- ROCm device files plus `rocminfo` or `amd-smi` add `amd-rocm`.
- `/dev/dri` alone does not add `intel-openvino`.
- Intel device confirmation plus `/dev/dri` or `/dev/accel` adds `intel-openvino`.
- CPU family is always present.

### Phase E: Move Model Artifacts To `/models`

Update launcher scripts and LLM runtime manifests.

Implementation tasks:

- In `modelLauncher_llama-cpp-cpu.sh`, replace `/runtime/models` with:
  - `HF_HOME="${HF_HOME:-/models/hf-cache}"`
  - `PLOINKY_MODELS_DIR="${PLOINKY_MODELS_DIR:-/models/artifacts}"`
  - `PLOINKY_DERIVED_DIR="${PLOINKY_DERIVED_DIR:-/models/derived}"`
- Store the downloaded GGUF under a deterministic artifact path below `/models/artifacts`, for example:
  - `/models/artifacts/<safe-repo-id>/<revision-or-default>/<file>`
- Keep PIDs, logs, launch configs, and instance state under `/runtime`.
- Update all first-wave LLM runtime manifests to mount:
  - `.ploinky/<agent>/models` -> `/models`
  - `.ploinky/<agent>/runtime` -> `/runtime`
- Set common env defaults in manifests or the startup wrapper:
  - `HF_HOME=/models/hf-cache`
  - `PLOINKY_MODELS_DIR=/models/artifacts`
  - `PLOINKY_DERIVED_DIR=/models/derived`
  - `PLOINKY_RUNTIME_DIR=/runtime`
- Confirm `HF_TOKEN` is only passed as an env secret and is never written to state, labels, args, or logs.

Tests:

- Launcher `prepare` creates or uses paths under `/models`, not `/runtime/models`.
- Restarting the runtime reuses cached model artifacts.
- Runtime logs and selected architecture state do not contain `HF_TOKEN`.
- Manifests include `/models` and `/runtime` mounts for every LLM runtime agent.

### Phase F: Store The Actual Runtime Image In The Agent Registry

Update `ploinky/cli/services/docker/agentServiceManager.js`.

Implementation tasks:

- Track the image actually used by `startAgentContainer()`.
- Return or persist the effective image alongside the started container record.
- Write `.ploinky/agents.json` with:
  - `containerImage`: actual image used to start the container.
  - optional `manifestImage`: unresolved or manifest-resolved template image for diagnostics.
  - optional `llmRuntime` metadata: architecture id, image digest, platform, policy hash, catalog id/ref.
- Do not clobber the selected catalog image with `${PLOINKY_<AGENT>_IMAGE}` or a stale manifest value after startup.

Tests:

- LLM runtime catalog image selection writes the selected image to `.ploinky/agents.json`.
- Explicit image override writes the override image.
- Labels and registry image agree for the effective image.
- Non-LLM agents preserve existing registry behavior.

### Phase 1: Add the Shared LLM Runtime Startup Wrapper

Add `llm-runtime/shared/runtime-agent/start-runtime-agent.sh`.

Responsibilities:

- Set strict shell mode.
- Start the internal runtime control server:
  - `PLOINKY_LLM_RUNTIME_PORT="${PLOINKY_LLM_CONTROL_PORT:-9002}" node /Agent/llm-runtime/runtime-agent/mcp-server.mjs`
- Wait for the control server `/health`.
- Start the shared Ploinky AgentServer on the internal MCP port:
  - `PORT="${PLOINKY_LLM_MCP_PORT:-9001}" sh /Agent/server/AgentServer.sh`
- Start or exec the public proxy on `PLOINKY_LLM_PUBLIC_PORT`:
  - `node /Agent/llm-runtime/runtime-agent/runtime-proxy.mjs`
- Trap `INT` and `TERM`, stop all children, and propagate startup failure.

This should mirror the cleanup style used by existing multi-process agents such as WebMeet.

### Phase 2: Add the Public Runtime Proxy

Add `llm-runtime/shared/runtime-agent/runtime-proxy.mjs`.

Responsibilities:

- Listen on `PLOINKY_LLM_PUBLIC_PORT` or `9000`.
- Forward `/mcp` and `/mcp/*` to `127.0.0.1:${PLOINKY_LLM_MCP_PORT:-9001}`.
- Forward `/health`, `/agent-card`, `/runtime/*`, and `/v1/chat/completions` to `127.0.0.1:${PLOINKY_LLM_CONTROL_PORT:-9002}`.
- Preserve headers required by MCP, especially `mcp-session-id`, `accept`, and content type.
- Preserve router-provided secure-wire headers; do not mint or reinterpret tokens in the proxy.
- Keep request and error logs redacted.
- Return clean JSON 502/504 errors when an internal service is unreachable.

Do not add agent-specific routes to Ploinky core.

### Phase 3: Convert the Current Runtime Server into an Internal Control Service

Keep `llm-runtime/shared/runtime-agent/mcp-server.mjs` for now, but rename only in documentation or comments if needed. A code rename can wait to avoid churn.

Required changes:

- Keep existing `/runtime/*`, `/health`, `/agent-card`, and `/v1/chat/completions` behavior.
- Bind to `PLOINKY_LLM_CONTROL_PORT` via the startup wrapper.
- Do not pretend this service is the MCP server unless it implements `/mcp`.
- Ensure logs name it as `llm-runtime-control` or similar.
- Keep direct unit tests for existing runtime functions.

Optional later cleanup:

- Rename `mcp-server.mjs` to `runtime-control-server.mjs`.
- Keep a compatibility shim at the old path while manifests and images transition.

### Phase 4: Add MCP Tool Wrappers

Add a generic wrapper at `llm-runtime/shared/runtime-agent/tools/runtime-tool.mjs`.

Responsibilities:

- Read the AgentServer payload from stdin.
- Validate the selected tool name and input.
- Call the internal runtime control service over localhost.
- Return MCP-compatible text content containing JSON.
- Redact secrets and avoid logging `HF_TOKEN`, invocation JWTs, or raw request payloads.

The wrapper should support these MCP tools:

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

Map the tools to existing internal runtime endpoints first. Only add new internal endpoints where the current REST surface cannot express the MCP contract cleanly.

### Phase 5: Add Shared MCP Config

Add a shared MCP config template, for example:

- `llm-runtime/shared/mcp-config.json`

Each tool entry should use:

- `command`: `/usr/local/bin/node` or `node`, depending on image contract.
- `args`: `["/Agent/llm-runtime/runtime-agent/tools/runtime-tool.mjs"]`
- `cwd`: `/code`
- `env.TOOL_NAME`: the MCP tool name.
- `inputSchema`: the same normalized schemas already used by the runtime server.
- `timeoutMs`: bounded per operation.

For image layout simplicity, either:

- copy the shared `mcp-config.json` into each agent image at `/code/mcp-config.json`, or
- set `PLOINKY_MCP_CONFIG_PATH=/Agent/llm-runtime/mcp-config.json` in the startup wrapper.

Prefer `PLOINKY_MCP_CONFIG_PATH` so agent directories do not need to duplicate identical runtime tool declarations.

### Phase 6: Update LLM Runtime Agent Manifests

Update these manifests:

- `llm-runtime/base-local/manifest.json`
- `llm-runtime/planning-local/manifest.json`
- `llm-runtime/relevance/manifest.json`
- `llm-runtime/language-detection/manifest.json`

Required changes:

- Replace `start: "node /Agent/llm-runtime/runtime-agent/mcp-server.mjs"` with:
  - `start: "sh /Agent/llm-runtime/runtime-agent/start-runtime-agent.sh"`
- Keep the public manifest port mapped to container port `9000`.
- Add `readiness.protocol = "mcp"` for LLM runtime agents.
- Correct agent-card metadata to the form expected by the shared AgentServer if the AgentServer becomes the source of `/agent-card` later:
  - use `endpoints["agent-card"]`, not only `endpoints.agentCard`.
- Keep `llmRuntime.enabled = true`.
- Keep `HF_TOKEN` as an optional env secret.

The proxy may continue routing `/agent-card` to the runtime control service, so the agent-card manifest key correction is defensive and consistency-oriented.

### Phase 7: Preserve OpenAI-Compatible Chat

The public `/v1/chat/completions` route must continue to work after MCP is fixed.

Recommended first implementation:

- The public proxy forwards `/v1/chat/completions` to the internal runtime control service.
- The runtime control service keeps its current launcher selection and engine proxy behavior.

Alternative later implementation:

- Use shared AgentServer's `endpoints.chatCompletions` command hook.
- Add a command wrapper that calls the internal runtime control service.

Prefer the proxy path first because it preserves streaming/proxy behavior with fewer changes.

### Phase 8: Preserve Existing Runtime REST Endpoints Temporarily

Keep the current `/runtime/*` endpoints available through the public proxy during the transition.

Rationale:

- Existing tests and diagnostics may already call these endpoints.
- MCP tools become the canonical orchestration surface.
- REST endpoints remain useful for low-level smoke tests and debugging.

Document that Ploinky/orchestrators should use `/mcps/<agent>/mcp` for runtime control, not direct `/runtime/*` routes.

### Phase 9: Tests

Add or update tests in `llm-runtime/tests`:

- Starting the proxy with fake internal services routes `/mcp` to the MCP sidecar.
- Starting the wrapper with fake services fails fast when the runtime control service is unhealthy.
- `/mcp` no longer returns 404 for a runtime agent.
- MCP initialize, `notifications/initialized`, and `tools/list` succeed.
- `tools/list` includes all required runtime tools.
- `tools/call runtime.describe` returns selected architecture metadata.
- `tools/call launchers.describe` validates launcher id and rejects path traversal.
- `tools/call modelProfiles.setPriorities` rejects unknown launchers and disallowed scopes.
- `/v1/chat/completions` still proxies to the runtime control service.
- `/runtime/describe` remains available through the proxy while compatibility is retained.
- Logs do not include `HF_TOKEN` or invocation JWTs.

Add or update Ploinky unit tests:

- CPU-only forced NVIDIA override is rejected.
- Docker NVIDIA emits `--gpus all`; Podman NVIDIA emits CDI device.
- Podman never receives `--gpus`.
- Catalog validation rejects image/architecture platform mismatch.
- Hardware detection does not advertise Vulkan, Intel OpenVINO, or ROCm from device files alone.
- Registry image record uses the actual selected image.
- LLM runtime manifests using `start-runtime-agent.sh` still receive LLM image selection and runtime policy.
- MCP readiness probing succeeds against a test LLM runtime agent.
- Container reuse hash behavior is unchanged by the proxy split except for intentional manifest/start changes.

Add or update catalog/runtime integration tests:

- Fake CPU LLM runtime image exposes `/mcp`.
- Fake launcher can be described and started through MCP.
- CPU fallback path still writes `/runtime/selected-architecture.json`.
- ARM64 experimental accelerator records cannot reference AMD64 image records.

Do not run Docker/Podman E2E lifecycle tests without explicit operator consent.

### Phase 10: Documentation Updates

Update the docs added for this feature:

- `ploinky/docs/specs/DS012-local-llm-agent-architecture-catalog.md`
- `ploinky/docs/specs/DS003-agent-manifest-and-registry.md`
- `ploinky/docs/specs/DS004-runtime-execution-and-isolation.md`
- `ploinky/docs/specs/DS011-security-model.md`

Documentation changes should state:

- Existing Ploinky MCP contract is `/mcp` through router paths such as `/mcps/<agent>/mcp`.
- LLM runtime REST control endpoints are internal implementation details or transitional diagnostics.
- Runtime orchestration uses MCP tools.
- The custom runtime control server is not a substitute for Ploinky MCP unless it implements the MCP SDK transport.
- New local agents should follow either the config-driven AgentServer pattern or the Explorer-style direct MCP SDK pattern.

### Phase 11: Migration Cleanup

After tests pass and callers are updated:

- Decide whether to keep public `/runtime/*` endpoints long-term.
- If removing them, deprecate first and keep only `/mcp`, `/health`, `/agent-card`, and `/v1/chat/completions`.
- Consider renaming `mcp-server.mjs` to `runtime-control-server.mjs`.
- Keep backward-compatible symlink or shim for one release/image cycle.

## Security Requirements

- Do not add raw container args.
- Do not expose arbitrary host devices or volumes.
- Do not bypass AgentServer secure-wire validation for MCP tool calls.
- Do not log `HF_TOKEN`, invocation JWTs, bearer tokens, or raw secrets.
- Do not let MCP priority overrides introduce launchers not declared by `agent-models.json`.
- Do not let `/runtime/*` become an unauthenticated privileged control plane if it remains public; prefer MCP for state-changing operations.
- Do not hardcode LLM agent ids, model ids, launcher ids, or backend tags in Ploinky router or WebChat.

## Acceptance Criteria

- `GET /health` on an LLM runtime agent returns healthy.
- `POST /mcp` initialize succeeds on an LLM runtime agent.
- `POST /mcp` `tools/list` includes runtime, launcher, instance, and model profile tools.
- `POST /mcp` `tools/call` for `runtime.describe` returns selected architecture and policy metadata.
- `POST /mcp` `tools/call` for `launchers.describe` works for a fake CPU launcher.
- Invalid MCP tool inputs are rejected by schema or wrapper validation.
- `/v1/chat/completions` remains available for chat-capable LLM runtime agents.
- `relevance` and `language-detection` can expose MCP-only workflows without requiring an engine port.
- Ploinky readiness can use `protocol: "mcp"` for LLM runtime agents.
- Existing non-LLM agents are unaffected.
- No Ploinky router or WebChat changes hardcode local LLM agent semantics.
- `PLOINKY_LLM_ARCHITECTURE_ID` cannot force an incompatible architecture.
- NVIDIA Docker and NVIDIA Podman select distinct valid policies.
- Architecture platform, image platform, and runtime policy platform are consistent.
- Hardware detection uses confirmation probes for accelerator families.
- Model cache and artifacts are stored under `/models`, not `/runtime`.
- `.ploinky/agents.json` records the actual selected runtime image.
- Unit tests for Ploinky, `llm-runtime`, and `local-llm-architectures` pass.

## Preferred Implementation Order

1. Fix catalog validation for image/platform/policy consistency.
2. Fix architecture override compatibility validation.
3. Add Docker-vs-Podman NVIDIA catalog support.
4. Tighten hardware detection summaries and probe tests.
5. Move launcher model artifacts and manifest mounts to `/models`.
6. Fix `.ploinky/agents.json` to record the actual selected image.
7. Add the proxy and wrapper scripts without changing manifests.
8. Add shared `mcp-config.json` and wrapper tests.
9. Update one agent, preferably `base-local`, to use the new startup wrapper.
10. Verify `/mcp`, `/runtime/describe`, and `/v1/chat/completions` on `base-local`.
11. Convert `planning-local`, `relevance`, and `language-detection`.
12. Update tests for all converted agents.
13. Update DS docs and the original implementation plan to reflect the corrected architecture and MCP patterns.
14. Run unit tests.
15. Ask for explicit consent before running Docker/Podman lifecycle E2E tests.
