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

The `local-llm-architectures/` repository owns the declarative catalog: architecture records, image metadata, runtime policy recommendations, and image-build provenance pointers. The catalog must be JSON data only. Ploinky must reject unknown fields in runtime-consumed objects and must not execute code from this tree during selection. Authoritative image build sources live in the sibling `container-image-builds/` repository; catalog build fields point at those sources for traceability and must not be treated as executable inputs by Ploinky.

The `llm-runtime/` agent repository owns specialized agents — manifests, capability metadata (`agent-card.json`), agent-owned model profiles (`agent-models.json`), launcher scripts, and the in-container runtime MCP/control implementation. Public MCP remains the normal Ploinky MCP contract: `/mcps/<agent>/mcp` reaches the runtime image's `/mcp` endpoint on container port `9000`. The runtime MCP/control service reads `/runtime/selected-architecture.json` (written by Ploinky core), reads the agent-owned `agent-models.json`, discovers launcher scripts under `/workspace/modelLaunchers`, and selects compatible launchers locally behind that MCP surface. Engines are launched on demand and listen on container port `8080`. The runtime MCP/control service does not proxy `/v1/chat/completions`; inference traffic goes through Ploinky's generic router surface to the published engine port for the active runtime container.

### Catalog Source Resolution

Ploinky resolves the catalog root in this order:

1. `PLOINKY_LLM_ARCHITECTURES_PATH` — absolute or workspace-relative path on the host.
2. `PLOINKY_LLM_ARCHITECTURES_REPO` (+ optional `PLOINKY_LLM_ARCHITECTURES_REF`) — clones the repository into a workspace-local cache (`PLOINKY_LLM_CATALOG_CACHE_DIR` or `.ploinky/llm-catalog-cache/`) and checks out the requested ref.
3. Built-in default remote repository `https://github.com/AssistOS-AI/local-llm-architectures.git` at the default ref `main`, cloned into the same workspace-local cache.

There is intentionally no implicit sibling-checkout fallback. A developer who wants to use a local `local-llm-architectures/` checkout must opt in with `PLOINKY_LLM_ARCHITECTURES_PATH`.

The catalog ref attached to selection metadata is the resolved git commit when available, otherwise the requested ref or a stable directory-content hash for non-git catalogs. When fetching a remote catalog fails but a valid cached checkout already exists for the same repository/ref, Ploinky may use the cached checkout and must still record the resolved cached commit.

### Catalog Shape

`catalog.json` lists architecture and image ids with relative paths under `architectures/` and `images/`. Paths must point inside the catalog root; path traversal is rejected.

Each architecture record declares: `id`, `status` (`stable` or `experimental`), `platform` (`linux/amd64` or `linux/arm64`), `accelerator.family` (`cpu`, `nvidia-cuda`, `amd-rocm`, `vulkan`, or `intel-openvino`), `match.requiredProbes` (zero or more probe ids that must succeed before this architecture is eligible), optional `match.containerRuntimes` (`docker` and/or `podman`), `image` (id of an image record), `runtimePolicy` (typed contract — see below), `engineDefaults` (`enginePort`, `runtimePort`), and `fallbackPriority` (lower wins).

Each image record declares: `id`, literal `ref` (`docker.io/assistos/llm-runtime:<tag>` in the default catalog), optional `digest` (`sha256:<64-hex>`), `platform`, `engines`, and a required `build` block for the image-build pipeline (`context`, `dockerfile`, `workflow`, and `engineVersionsLock`). In the default catalog, those build fields are workspace-relative provenance pointers rooted at `container-image-builds/` (`context` is exactly `container-image-builds`, `workflow` is `container-image-builds/.github/workflows/publish-llm-runtime-images.yml`, and `dockerfile`/`engineVersionsLock` point under `container-image-builds/images/llm-runtime-*/`). Image refs must not use shell expansion or agent-name interpolation. Engine inventory in `engines` describes the installed engine families only; it must not carry model, launcher, or default-generation policy.

The default catalog must include CPU `linux/amd64` and `linux/arm64`, NVIDIA CUDA `linux/amd64`, NVIDIA CDI `linux/amd64`, NVIDIA Spark/GB10 `linux/arm64` with minimum compute capability `12.1`, AMD ROCm `linux/amd64`, Vulkan `linux/amd64` and `linux/arm64`, and Intel/OpenVINO `linux/amd64`. The Spark arm64 record is intentionally specific (`nvidia-spark-arm64-sm121`) rather than a generic NVIDIA arm64 architecture.

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
| `nvidia-amd64` | NVIDIA CUDA image for Docker on `linux/amd64`, using Docker `--gpus`. |
| `nvidia-cdi-amd64` | NVIDIA CUDA image for Podman on `linux/amd64`, using NVIDIA CDI devices. |
| `nvidia-spark-arm64-sm121` | Spark/GB10 CUDA image for `linux/arm64`, minimum compute capability `12.1`. |
| `amd-rocm-amd64` | AMD ROCm image for `linux/amd64`. |
| `intel-amd64` | Intel/OpenVINO image for `linux/amd64`. |
| `vulkan-amd64` | Vulkan image for `linux/amd64`. |
| `vulkan-arm64` | Vulkan image for `linux/arm64`, currently experimental in the default catalog. |

Usage examples:

```bash
PLOINKY_LLM_ARCHITECTURE_ID=cpu-amd64 ploinky start planning-local
PLOINKY_LLM_ARCHITECTURE_ID=nvidia-amd64 ploinky start planning-local
PLOINKY_LLM_ARCHITECTURE_ID=nvidia-cdi-amd64 ploinky start planning-local
```

There is intentionally no per-agent architecture env var such as `PLOINKY_PLANNING_LOCAL_ARCHITECTURE_ID`. Architecture forcing is host/runtime policy applied consistently to LLM agents. Per-agent differences should use manifests, aliases, model profiles, and launcher priorities, not separate architecture ids or image replacement.

### Selection Algorithm

For each enabled LLM agent, Ploinky core:

1. Resolves the active profile, manifest env names, and effective network the same way it does for any other agent.
2. Inspects the container daemon's OCI platform (`docker info`/`docker version`/`podman info`) and falls back to the normalized Node arch when daemon inspection fails.
3. Runs the allowlisted accelerator probes (`nvidia-smi -L`, `nvidia-smi --query-gpu=compute_cap --format=csv,noheader`, `nvidia-ctk cdi list`, file existence of `/dev/kfd`, `/dev/dri`, `/dev/accel`, `rocminfo`, `amd-smi`, `lspci -nn`, `vulkaninfo --summary`) with short per-probe timeouts. Evidence is summarized; raw command output is not written into Ploinky logs. Device files are necessary but not sufficient for accelerated families: NVIDIA Spark requires a minimum compute capability from `nvidia-smi`, ROCm also requires `rocminfo` or `amd-smi`, Vulkan requires a `vulkaninfo` renderer, and Intel/OpenVINO requires an Intel confirmation probe plus `/dev/dri` or `/dev/accel`.
4. Filters catalog architectures by platform compatibility, status (experimental architectures only win when explicitly enabled), container runtime compatibility, accelerator family availability, required probes, image/platform consistency, and runtime policy validity for the selected Docker or Podman backend. The selector then prefers lower `fallbackPriority` and then a canonical accelerator ordering (`nvidia-cuda` > `amd-rocm` > `intel-openvino` > `vulkan` > `cpu`).
5. Falls back to the catalog `defaultFallback` (or any CPU architecture matching the host platform) when no accelerator architecture passes.
6. Applies validated overrides without bypassing compatibility:
   - `PLOINKY_LLM_ARCHITECTURE_ID` (single workspace-level architecture override; must exist in the catalog and match `[a-z0-9][a-z0-9._-]{0,63}`). There is intentionally no `PLOINKY_<AGENT>_ARCHITECTURE_ID`; architecture forcing is a host/runtime policy applied consistently to LLM agents.
   - `PLOINKY_LLM_FORCE_PLATFORM` (must be `linux/amd64` or `linux/arm64`).
   - `PLOINKY_LLM_ACCELERATOR` (must be a known family).
7. Rejects raw image override env vars for LLM runtime selection. The selected image ref must come from the active catalog image record, and the default catalog uses literal `docker.io/assistos/llm-runtime:<tag>` refs.

### Runtime Policy Contract

Runtime policy is typed, allowlisted, and merged in this precedence order:

1. Ploinky safety floor (`ipc: "default"`).
2. Manifest `llmRuntime.runtimePolicy` (when present).
3. Architecture catalog `runtimePolicy` recommendation.
4. Active-profile `llmRuntime.runtimePolicy` (when present).
5. Explicit validated overrides.

Allowed fields: `platform`, `resources.memory`, `resources.cpus`, `resources.pidsLimit`, `resources.shmSize`, `resources.ulimits.memlock` (`soft`/`hard`), `devices[].type` (`cdi` or `hostDevice`), `securityOpt` (allowed values: `label=disable` and `seccomp=unconfined`), `ipc` (`default` or `host`), and `gpus` (`all` or `device=<list>`).

Rejected: `rawArgs`, unknown keys, implicit `privileged: true`, manifest-volume-style mounts inside runtime policy, host devices outside the allowlist `/dev/kfd`, `/dev/dri`, `/dev/accel`, CDI values that are not assignment-style device ids, CDI devices on Docker (CDI is Podman-only by default), and `--gpus` on Podman (Podman must use a CDI device entry). Host device paths are normalized and must stay under the allowlist. The runtime emits Docker or Podman `run` arguments only for validated fields.

Selection produces a canonical `runtimePolicyHash` (SHA-256 over the canonical merged policy JSON). The selected image, digest, OCI platform, catalog id, resolved catalog ref, catalog source, redacted catalog repo URL, and catalog requested ref are combined with `runtimePolicyHash` and the existing env/network hash into a stable `reuseHash`. Containers labeled with a different `ploinky.reusehash` than the desired value are torn down and recreated.

### Container Layout And Selected Architecture State

Before container start, Ploinky writes `.data/<agent-or-alias>/runtime/selected-architecture.json` with the catalog id, resolved ref, source (`path`, `git`, or `default-remote`), redacted repo URL, requested ref, architecture id, accelerator family, image id/ref/digest/source, runtime policy and policy hash, engine inventory, hardware summary (runtime, node arch, OCI platform, accelerator families, redacted probe status), and the selection explanation. The file is mounted into the container at `/runtime/selected-architecture.json` and is readable by the in-container runtime MCP/control service. The file must not contain `HF_TOKEN`, other secret names, or any secret value. Mode `0600` is requested when supported.

Ploinky mounts the agent package at `/workspace`, creates `.data/<agent-or-alias>/models` and mounts it at `/models`, and mounts alias-specific runtime state at `/runtime`. Long-lived model data belongs under `/models/hf-cache`, `/models/artifacts`, and `/models/derived`. `/runtime` is reserved for state files, launch configs, PIDs, logs, selected architecture metadata, and temporary priority overrides. Manifest volumes and runtime resources must not shadow `/workspace`, `/models`, or `/runtime`.

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

The agent-owned `agent-models.json` describes profiles and launcher candidates. Each profile lists one or more candidates with a launcher name, optional priority, and optional `requiredAccelerators` list. The in-container runtime validates the document, intersects candidates with discovered launchers (`modelLauncher_*.sh describe`) and the selected architecture's accelerator family, and picks the first eligible candidate. Ploinky core does not read these files.

Launchers live under `/workspace/modelLaunchers` and are named `modelLauncher_<launcher-id>.sh`. Each launcher must return a JSON `describe` document and support the runtime commands used by MCP tools: `prepare`, `start`, `status`, and `stop`. Launch configs may contain only startup fields such as `launcherId`, `instanceId`, profile, context, concurrency, batching, accelerator allocation, and engine-specific startup toggles. Generation request fields such as messages, sampling parameters, tools, response format, and streaming are forbidden in launch configs.

LLM runtime agents use a direct two-port contract. The runtime image entrypoint runs `/opt/ploinky/runtime-agent/mcp-server.mjs` on container port `9000`; this service owns `/mcp`, `/health`, and redacted diagnostic runtime routes. Engines start on demand on container port `8080`. Ploinky publishes both ports to loopback host ports and the router continues to expose only generic Ploinky surfaces. State-changing orchestration must use MCP tools behind router-request authentication; diagnostic runtime routes must not become a privileged public control plane.

## Decisions & Questions

### Question #1: Why is the architecture catalog an external repository rather than data baked into Ploinky?

Response:
Hardware support, image references, and runtime policy recommendations need to evolve faster and more independently than Ploinky's runtime contract. Keeping the catalog outside Ploinky lets operators fork it, pin it to a specific commit, or replace it entirely without modifying Ploinky. The selection contract — strict JSON-schema-equivalent validation, no executable hooks, no raw container args — is enforced by Ploinky regardless of the catalog source, with catalog tests keeping the published schemas in parity with Ploinky's runtime validators.

### Question #2: Why is the runtime policy contract typed and allowlisted instead of allowing pass-through container flags?

Response:
The catalog is consumed by the same Ploinky runtime that protects the workspace's trust boundaries. A pass-through `rawArgs` field would let any catalog grant arbitrary kernel capabilities, mount arbitrary host paths, or bypass profile mount policy. Modeling each supported field explicitly keeps catalog changes auditable, lets the runtime emit the same logical policy across Docker and Podman, and produces a stable `runtimePolicyHash` for container reuse comparison.

### Question #3: Why does the LLM runtime control implementation live in `llm-runtime/`, not in Ploinky core?

Response:
The runtime MCP/control service reads Ploinky's selected architecture, reads agent-owned model metadata, discovers launchers, and decides which launcher to start. It does not proxy `/v1/chat/completions`; inference traffic goes through Ploinky's generic router surface to the published engine port for the active runtime container. Those launcher-selection decisions are agent-specific. Keeping them inside the agent repo keeps Ploinky core free of LLM-specific dispatch logic, makes the router generic (it routes `/v1/chat/completions/<agent>` and `/mcps/<agent>/mcp` without learning model-specific flags), and lets new LLM agents add new launcher families without touching Ploinky. Public MCP remains the normal Ploinky MCP surface, and state-changing runtime tools verify router-request authentication before dispatching launchers.

### Question #4: Why does Ploinky write `selected-architecture.json` instead of letting the runtime server probe the host at start?

Response:
The container is the wrong place to run host accelerator probes — `/dev/dri` visibility, daemon platform, and CDI availability are properties of the host or container daemon. Writing the selection result before start lets the runtime MCP/control service boot deterministically with the same architecture Ploinky used to compute the reuse hash and emit run-time arguments. The state file is also the obvious source for runtime MCP tools and diagnostic routes to surface the runtime assignment to operators and orchestrators, as long as it remains free of secret names and values.

### Question #5: Why are direct image replacement env vars rejected for LLM runtime agents?

Response:
The selected image is part of the catalog contract: it carries the architecture id, platform, engine inventory, optional digest, build-source metadata, and runtime policy assumptions used for validation and reuse hashing. Allowing a direct image replacement to bypass that record would let an operator or environment accidentally pair a trusted runtime policy with an unrelated image. Requiring image refs to come from the active catalog keeps image changes reviewable, schema-validated, and visible in the selected architecture state.

## Conclusion

The architecture catalog defines what LLM agents run inside, the runtime policy defines what they may demand from the host, and the agent-owned `agent-models.json` defines what model the agent chooses to load. Keeping each layer scoped — external data catalog, Ploinky-owned typed policy, agent-owned model dispatch — preserves Ploinky's runtime invariants while letting hardware-aware LLM agents evolve independently.
