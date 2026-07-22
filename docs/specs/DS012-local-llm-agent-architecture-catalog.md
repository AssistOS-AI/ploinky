---
id: DS012
title: Local LLM Agent Architecture Catalog
status: implemented
owner: ploinky-team
summary: Defines the external declarative catalog that drives hardware-aware LLM agent container selection, the strict runtime policy contract, and the boundary between Ploinky core, the catalog, and specialized LLM agents.
---

# DS012 Local LLM Agent Architecture Catalog

## Introduction

Ploinky supports specialized LLM agents that need hardware-specific container images, accelerator devices, and resource budgets. To keep Ploinky core free of LLM-specific or vendor-specific logic, the catalog of hardware architectures, container images, and runtime policy recommendations lives in an external data repository (`local-llm-architectures/`). This document defines the catalog contract, the selection algorithm, and the non-negotiable boundaries between Ploinky core, the catalog, and specialized LLM agents.

## Core Content

### Boundary

Ploinky core owns container lifecycle, hardware detection, architecture selection, safe runtime policy emission, container reuse hashing, selected-architecture state files, and label-based observability. Ploinky core must not parse `agent-models.json`, must not execute launcher scripts, must not embed launcher or engine flags, and must not hardcode LLM agent ids, model ids, MCP tool names, or backend tags inside the router or WebChat. The router continues to proxy generic surfaces (`/agent-card`, `/v1/chat/completions/<agent>`, `/mcps/<agent>/mcp`).

The `local-llm-architectures/` repository owns the declarative catalog: architecture records, image metadata, runtime policy recommendations, and image-build assets. The catalog must be JSON data only. Ploinky must reject unknown fields in runtime-consumed objects and must not execute code from this tree during selection.

The `llm-runtime/` agent repository owns specialized agents — manifests, capability metadata (`agent-card.json`), agent-owned model profiles (`agent-models.json`), launcher scripts, and the in-container runtime control implementation. Public MCP remains the normal Ploinky MCP contract: `/mcps/<agent>/mcp` reaches the agent's `/mcp` endpoint, which is served by the shared AgentServer sidecar. The runtime control service reads `/runtime/selected-architecture.json` (written by Ploinky core) and the agent-owned `agent-models.json`, and selects compatible launchers locally behind that MCP surface.

### Catalog Source Resolution

Ploinky resolves the catalog root in this order:

1. `PLOINKY_LLM_ARCHITECTURES_PATH` — absolute or workspace-relative path on the host.
2. `PLOINKY_LLM_ARCHITECTURES_REPO` (+ optional `PLOINKY_LLM_ARCHITECTURES_REF`) — clones the repository into a workspace-local cache (`PLOINKY_LLM_CATALOG_CACHE_DIR` or `.ploinky/llm-catalog-cache/`) and checks out the requested ref.
3. Default workspace sibling `local-llm-architectures/` next to the Ploinky checkout.

The catalog ref attached to selection metadata is the resolved git commit when available, otherwise the requested ref or a stable directory-content hash for non-git catalogs.

### Catalog Shape

`catalog.json` lists architecture and image ids with relative paths under `architectures/` and `images/`. Paths must point inside the catalog root; path traversal is rejected.

Each architecture record declares: `id`, `status` (`stable` or `experimental`), `platform` (`linux/amd64` or `linux/arm64`), `accelerator.family` (`cpu`, `nvidia-cuda`, `amd-rocm`, `vulkan`, or `intel-openvino`), `match.requiredProbes` (zero or more probe ids that must succeed before this architecture is eligible), optional `match.containerRuntimes` (`docker` and/or `podman`), `image` (id of an image record), `runtimePolicy` (typed contract — see below), `engineDefaults` (`enginePort`, `runtimePort`), and `fallbackPriority` (lower wins).

Each image record declares: `id`, `ref` (image reference; may use the literal template token `${AGENT_IMAGE_NAME}` which Ploinky substitutes with a validated agent identity), optional `digest` (`sha256:<64-hex>`), optional `platform`, and an optional `build` block for the image-build pipeline.

Catalog loading rejects architecture/image records whose platforms disagree and rejects `runtimePolicy.platform` when it differs from the architecture platform. `allowExperimental` does not bypass this consistency check.

### Architecture ID Format

`PLOINKY_LLM_ARCHITECTURE_ID` must be the literal `id` of an architecture record in the active catalog. The enforced syntax is `[a-z0-9][a-z0-9._-]{0,63}`. The recommended semantic shape is:

```text
<accelerator-family>[-runtime-or-backend-variant]-<cpu-architecture>
```

The id normally includes the accelerator family for operator readability, but the id string is not the security boundary. The authoritative accelerator value remains the architecture record's `accelerator.family`, and Ploinky still validates that family, platform, required probes, runtime compatibility, image platform, and runtime policy before accepting an override.

Examples:

| Value | Meaning |
| --- | --- |
| `cpu-amd64` | CPU fallback image for OCI platform `linux/amd64`. |
| `cpu-arm64` | CPU fallback image for OCI platform `linux/arm64`. |
| `nvidia-cuda-amd64` | NVIDIA CUDA image for Docker on `linux/amd64`, using Docker `--gpus`. |
| `nvidia-cuda-cdi-amd64` | NVIDIA CUDA image for Podman on `linux/amd64`, using NVIDIA CDI devices. |
| `amd-rocm-amd64` | AMD ROCm image for `linux/amd64`. |
| `intel-openvino-amd64` | Intel/OpenVINO image for `linux/amd64`. |
| `vulkan-amd64` | Vulkan image for `linux/amd64`. |
| `vulkan-arm64` | Vulkan image for `linux/arm64`, currently experimental in the default catalog. |

Usage examples:

```bash
PLOINKY_LLM_ARCHITECTURE_ID=cpu-amd64 ploinky start base-local
PLOINKY_LLM_ARCHITECTURE_ID=nvidia-cuda-amd64 ploinky start planning-local
PLOINKY_LLM_ARCHITECTURE_ID=nvidia-cuda-cdi-amd64 ploinky start planning-local
```

There is intentionally no per-agent architecture env var such as `PLOINKY_PLANNING_LOCAL_ARCHITECTURE_ID`. Architecture forcing is host/runtime policy applied consistently to LLM agents. Per-agent differences should use manifests, aliases, model profiles, launcher priorities, or image overrides, not separate architecture ids.

### Selection Algorithm

For each enabled LLM agent, Ploinky core:

1. Resolves the active profile, manifest env names, and effective network the same way it does for any other agent.
2. Inspects the container daemon's OCI platform (`docker info`/`docker version`/`podman info`) and falls back to the normalized Node arch when daemon inspection fails.
3. Runs the allowlisted accelerator probes (`nvidia-smi -L`, `nvidia-ctk cdi list`, file existence of `/dev/kfd`, `/dev/dri`, `/dev/accel`, `rocminfo`, `amd-smi`, `lspci -nn`, `vulkaninfo --summary`) with short per-probe timeouts. Evidence is summarized; raw command output is not written into Ploinky logs. Device files are necessary but not sufficient for accelerated families: ROCm also requires `rocminfo` or `amd-smi`, Vulkan requires a `vulkaninfo` renderer, and Intel/OpenVINO requires an Intel confirmation probe plus `/dev/dri` or `/dev/accel`.
4. Filters catalog architectures by platform compatibility, status (experimental architectures only win when explicitly enabled), container runtime compatibility, accelerator family availability, required probes, image/platform consistency, and runtime policy validity for the selected Docker or Podman backend. The selector then prefers lower `fallbackPriority` and then a canonical accelerator ordering (`nvidia-cuda` > `amd-rocm` > `intel-openvino` > `vulkan` > `cpu`).
5. Falls back to the catalog `defaultFallback` (or any CPU architecture matching the host platform) when no accelerator architecture passes.
6. Applies validated overrides without bypassing compatibility:
   - `PLOINKY_LLM_ARCHITECTURE_ID` (single workspace-level architecture override; must exist in the catalog and match `[a-z0-9][a-z0-9._-]{0,63}`). There is intentionally no `PLOINKY_<AGENT>_ARCHITECTURE_ID`; architecture forcing is a host/runtime policy applied consistently to LLM agents.
   - `PLOINKY_LLM_FORCE_PLATFORM` (must be `linux/amd64` or `linux/arm64`).
   - `PLOINKY_LLM_ACCELERATOR` (must be a known family).
   - `PLOINKY_LLM_AGENT_IMAGE` or `PLOINKY_<AGENT>_IMAGE` (replaces the image ref; runtime policy validation still applies; loses the catalog digest).
7. Substitutes the literal template token `${AGENT_IMAGE_NAME}` inside `image.ref` with the manifest agent identity or active alias when present. No other shell-style expansion is performed.

### Runtime Policy Contract

Runtime policy is typed, allowlisted, and merged in this precedence order:

1. Ploinky safety floor (`ipc: "default"`).
2. Manifest `llmRuntime.runtimePolicy` (when present).
3. Architecture catalog `runtimePolicy` recommendation.
4. Active-profile `llmRuntime.runtimePolicy` (when present).
5. Explicit validated overrides.

Allowed fields: `platform`, `resources.memory`, `resources.cpus`, `resources.pidsLimit`, `resources.shmSize`, `resources.ulimits.memlock` (`soft`/`hard`), `devices[].type` (`cdi` or `hostDevice`), `securityOpt` (currently restricted to `label=disable`), `ipc` (`default` or `host`), and `gpus` (`all` or `device=<list>`).

Rejected: `rawArgs`, unknown keys, implicit `privileged: true`, manifest-volume-style mounts inside runtime policy, host devices outside the allowlist `/dev/kfd`, `/dev/dri`, `/dev/accel`, CDI devices on Docker (CDI is Podman-only by default), and `--gpus` on Podman (Podman must use a CDI device entry). The runtime emits Docker or Podman `run` arguments only for validated fields.

Selection produces a canonical `runtimePolicyHash` (SHA-256 over the canonical merged policy JSON). The selected image, digest, OCI platform, catalog id, and catalog ref are combined with `runtimePolicyHash` and the existing env/network hash into a stable `reuseHash`. Containers labeled with a different `ploinky.reusehash` than the desired value are torn down and recreated.

### Container Layout And Selected Architecture State

Before container start, Ploinky writes `.data/<agent-or-alias>/runtime/selected-architecture.json` with the catalog id and ref, architecture id, accelerator family, image id/ref/digest, runtime policy and policy hash, hardware summary (runtime, node arch, OCI platform, accelerator families, redacted probe results), the selection explanation, and the names of env variables exposed to the container (with secret names redacted). The file is mounted into the container at `/runtime/selected-architecture.json` and is readable by the in-container runtime control service. The file must not contain `HF_TOKEN` or any secret value. Mode `0600` is requested when supported.

Ploinky also creates `.data/<agent-or-alias>/models` and mounts it at `/models`. Long-lived model data belongs under `/models/hf-cache`, `/models/artifacts`, and `/models/derived`. `/runtime` is reserved for state files, launch configs, PIDs, logs, selected architecture metadata, and temporary priority overrides.

### Labels

Ploinky tags LLM agent containers with:

- `ploinky.llm.architecture`
- `ploinky.llm.catalog`
- `ploinky.llm.catalogref`
- `ploinky.llm.policyhash`
- `ploinky.llm.imagedigest`
- `ploinky.reusehash`

Non-LLM agents are unchanged and continue to carry only `ploinky.envhash`.

### Agent-Owned Model Profiles

The agent-owned `agent-models.json` describes profiles and launcher candidates. Each profile lists one or more candidates with a launcher name, optional priority, and optional `requiredAccelerators` list. The in-container runtime validates the document, intersects candidates with discovered launchers (`modelLauncher_*.sh describe`) and the selected architecture's accelerator family, and picks the first eligible candidate. Priority overrides are applied through MCP tools exposed by the shared AgentServer sidecar and stored under `/runtime/priority-overrides.json`. Ploinky core does not read these files.

LLM runtime agents use a three-port internal layout. The public agent port is `9000` and is served by a lightweight proxy. The proxy forwards `/mcp` to the shared AgentServer sidecar on `9001`, and forwards `/health`, `/agent-card`, `/runtime/*`, and `/v1/chat/completions` to the runtime control service on `9002`. The control service must bind to container loopback only; the proxy is the only intended listener for other containers or host-published traffic. State-changing orchestration should use MCP tools; `/runtime/*` remains a diagnostic compatibility surface.

## Decisions & Questions

### Question #1: Why is the architecture catalog an external repository rather than data baked into Ploinky?

Response:
Hardware support, image references, and runtime policy recommendations need to evolve faster and more independently than Ploinky's runtime contract. Keeping the catalog outside Ploinky lets operators fork it, pin it to a specific commit, or replace it entirely without modifying Ploinky. The selection contract — strict JSON-schema-equivalent validation, no executable hooks, no raw container args — is enforced by Ploinky regardless of the catalog source, with catalog tests keeping the published schemas in parity with Ploinky's runtime validators.

### Question #2: Why is the runtime policy contract typed and allowlisted instead of allowing pass-through container flags?

Response:
The catalog is consumed by the same Ploinky runtime that protects the workspace's trust boundaries. A pass-through `rawArgs` field would let any catalog grant arbitrary kernel capabilities, mount arbitrary host paths, or bypass profile mount policy. Modeling each supported field explicitly keeps catalog changes auditable, lets the runtime emit the same logical policy across Docker and Podman, and produces a stable `runtimePolicyHash` for container reuse comparison.

### Question #3: Why does the LLM runtime control implementation live in `llm-runtime/`, not in Ploinky core?

Response:
The runtime control service reads agent-owned `agent-models.json`, discovers launchers, decides which launcher to start, and proxies chat completions to the in-container engine. Those decisions are agent-specific. Keeping them inside the agent repo keeps Ploinky core free of LLM-specific dispatch logic, makes the router generic (it just proxies `/v1/chat/completions/<agent>` and `/mcps/<agent>/mcp`), and lets new LLM agents add new launcher families without touching Ploinky. Public MCP remains the normal shared AgentServer surface so secure-wire invocation checks are preserved.

### Question #4: Why does Ploinky write `selected-architecture.json` instead of letting the runtime server probe the host at start?

Response:
The container is the wrong place to run host accelerator probes — `/dev/dri` visibility, daemon platform, and CDI availability are properties of the host or container daemon. Writing the selection result before start lets the runtime control service boot deterministically with the same architecture Ploinky used to compute the reuse hash and emit run-time arguments. The state file is also the obvious source for AgentServer MCP tools and diagnostic routes to surface the runtime assignment to operators and orchestrators.

## Conclusion

The architecture catalog defines what LLM agents run inside, the runtime policy defines what they may demand from the host, and the agent-owned `agent-models.json` defines what model the agent chooses to load. Keeping each layer scoped — external data catalog, Ploinky-owned typed policy, agent-owned model dispatch — preserves Ploinky's runtime invariants while letting hardware-aware LLM agents evolve independently.
