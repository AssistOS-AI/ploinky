---
title: DS014-local-llm-agent-architecture-catalog
summary: Defines the actors, catalog data, hardware matching, image selection, constrained accelerator policy, storage, and failure rules for local LLM agents.
---

# DS014 Local LLM Agent Architecture Catalog

## Introduction

Ploinky may run an agent whose model server needs a platform-specific image, accelerator, and runtime policy. The agent opts into this behavior, an external JSON catalog describes supported architectures, and Ploinky converts one validated compatible record into an ordinary constrained runtime plan. Core lifecycle code must not hardcode a model, vendor, image, or accelerator choice.

## Core Content

### Main actors

| Actor | Responsibility |
| --- | --- |
| LLM agent manifest | Opts into catalog-based runtime selection, names the catalog and agent architecture entry, declares allowed environment values and persistent model use, and remains responsible for model-server behavior. |
| Architecture catalog | Supplies declarative, schema-validated platforms, accelerator requirements, images, runtime policy, defaults, fallback priority, and agent-to-architecture mappings. It is data only and cannot execute code. |
| Hardware detector | Reports the active container runtime, host and OCI platform, architecture, supported accelerator families, and bounded probe results. It always includes CPU as the portable baseline. |
| Architecture selector | Filters catalog records by status, platform, runtime, accelerator, required probes, manifest override, and declared constraints, then chooses the compatible record with the configured priority or CPU fallback. |
| Runtime policy planner | Translates only allowlisted architecture policy fields into Docker or Podman arguments and rejects privileged, unknown, arbitrary-device, raw-argument, or host-path requests. |
| Runtime launcher | Resolves the selected image, creates persistent model storage, writes redacted selection state, mounts `/models`, adds safe environment locators, and starts the agent through the normal exact-identity lifecycle. |
| Agent process | Owns model download, cache layout, model profiles, inference APIs, and application behavior within the selected runtime and declared `/models` storage. |

<figure class="diagram">
<pre class="mermaid">flowchart TB
    A[Validate manifest opt-in and architecture catalog] --> B[Detect runtime, platform, and accelerators]
    B --> C{Compatible architecture available?}
    C -->|Yes| D[Select architecture and validate image and runtime policy]
    C -->|No| F[Fail before runtime creation]
    D --> E[Prepare model storage and launch constrained runtime]
    classDef preparation fill:#e3f2fd,stroke:#1565c0,color:#0d2b45,font-weight:600
    classDef decision fill:#fff3e0,stroke:#ef6c00,color:#4a2700,font-weight:600
    classDef runtime fill:#e8f5e9,stroke:#2e7d32,color:#163a18,font-weight:600
    classDef failure fill:#ffebee,stroke:#c62828,color:#4a1111,font-weight:600
    class A,B preparation
    class C decision
    class D,E runtime
    class F failure</pre>
<figcaption><em>Local LLM architecture selection flow</em></figcaption>
</figure>

Ploinky first validates the manifest opt-in, catalog schema, identifiers, references, and paths as one preparation stage. Hardware detection then reports the active runtime, platform, architecture, available accelerator families, and core-owned probe results. Selection filters incompatible records, applies a valid explicit override or declared priority, and uses a compatible catalog-defined CPU record only when no preferred accelerator record can be selected. The selected record's image and allowlisted runtime policy must pass validation before Ploinky creates model storage, writes redacted selection state, launches the runtime, and begins ordinary readiness checks.

### Catalog contract

| Catalog data | Requirement |
| --- | --- |
| Catalog version and schema | Must match the supported JSON contract. Unknown fields, wrong types, oversized values, duplicate ids, unsafe paths, and invalid references fail validation. |
| Architecture `id` and `status` | Identify one record and whether it is eligible for selection. Identifiers must match the strict catalog allowlist. |
| `platform` | Names the compatible OCI or node platform. Selection must compare it to detected or explicitly admitted platform data. |
| `accelerator.family` | Uses an allowed family such as CPU, NVIDIA CUDA, AMD ROCm, Intel OpenVINO, or Vulkan. A non-CPU record is eligible only when the detector reports that family. |
| `accelerator.minimumComputeCapability` | Adds the bounded vendor-specific compatibility constraint when supported by the detector. It must not cause execution of catalog-supplied probe code. |
| `match.requiredProbes` | Requires named, core-owned hardware probe results. The catalog may consume probe facts but cannot define shell commands. |
| `image` | Selects a validated image reference or template. Substitution is limited to the admitted agent image identity; secrets and arbitrary expressions are prohibited. |
| `runtimePolicy` | May request only the supported resource, device, IPC, security-option, shared-memory, memlock, CPU, process, and GPU fields accepted by the runtime planner. |
| `engineDefaults` | Supplies bounded engine-specific values only for fields recognized by the planner. It cannot insert raw Docker or Podman arguments. |
| `fallbackPriority` | Orders otherwise compatible records. The selector may use a compatible CPU record when the preferred accelerator is unavailable; it must not guess an image outside catalog data. |
| Agent architecture mapping | Connects the manifest's agent entry to allowed architecture ids and optional constraints. All references must resolve inside the validated catalog. |

An explicit architecture or accelerator override must still pass every compatibility and safety check. A forced platform, unavailable accelerator, failed required probe, disallowed runtime, or incompatible override must fail rather than silently selecting an unsafe record. Automatic selection should prefer the configured accelerator order among compatible candidates and use CPU only through an explicit compatible catalog record.

### Runtime translation and storage

| Runtime output | Required behavior |
| --- | --- |
| Container image | Comes from the selected catalog record after template and image-reference validation. Manifest image secrets must not appear in the selected-state record. |
| Accelerator access | NVIDIA uses the supported Docker GPU or Podman CDI form. Other device access is limited to the planner's explicit allowlist and detected compatible hardware. |
| Runtime limits | CPU, memory, process, shared-memory, memlock, IPC, security options, and related fields remain bounded by the same runtime policy used for ordinary agents. |
| `/models` | Is an explicit persistent agent model directory. Ploinky exposes `HF_HOME`, `PLOINKY_MODELS_DIR`, and `PLOINKY_DERIVED_DIR` as paths inside that mount. |
| Selected architecture state | Is non-secret JSON under the agent's persistent home and is mounted at the declared runtime path. It may contain selection ids, hardware summaries, policy hashes, probe status, and exposed environment names, but never their secret values. |
| Runtime metadata | Pids, launch state, logs, and ephemeral control data remain separate from long-lived model artifacts. |

Credentials such as Hugging Face tokens remain ordinary manifest-resolved secrets. They must not appear in image references, labels, command arguments, hardware results, selected architecture state, model profiles, or logs. The runtime planner must reject privileged mode, arbitrary devices, arbitrary host paths, raw engine arguments, unknown policy fields, and any catalog attempt to control Box publication or Router authority.

Catalog absence, invalid schema, unsupported hardware, unresolved mapping, missing compatible image, unsafe policy, or unresolved required secret must fail before container creation. Ploinky owns validation, selection, storage mounts, and safe runtime translation; the specialized agent owns model choice semantics, downloads, inference behavior, and its OpenAI-compatible or MCP interfaces.
