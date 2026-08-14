---
title: DS013-local-llm-agent-architecture-catalog
summary: Defines data-driven hardware detection, external LLM architecture catalogs, image selection, and constrained accelerator runtime policy.
---

# DS013 Local LLM Agent Architecture Catalog

## Introduction

Ploinky may run specialized local LLM agents without embedding vendor, model, accelerator, or image choices in core lifecycle code. Hardware-specific choices must come from validated declarative catalog data and an agent's manifest opt-in.

## Core Content

An LLM agent must opt in through its manifest runtime contract. Ploinky must load the selected catalog source as data, validate its schema and referenced paths, detect the supported host platform and devices, and select one compatible architecture according to declared priorities and constraints. No catalog script or executable code may run as part of selection.

Catalog identifiers, architecture file paths, image references, device declarations, and runtime fields must pass strict allowlists and traversal checks. Image templates may substitute only the validated agent image identity. Credentials such as Hugging Face tokens must remain manifest-resolved secrets and must not appear in image references, labels, command arguments, selected-architecture state, model profiles, or logs.

Runtime policy may specify the validated platform, memory, CPU, process, shared-memory, memlock, device, security option, IPC, and GPU fields supported by the runtime planner. Raw container arguments, privileged mode, arbitrary devices, unbounded host paths, and unknown policy fields are prohibited. NVIDIA access must use the supported Docker GPU or Podman CDI form; host-device access is limited to the explicit accelerator allowlist.

Ploinky must persist the selected architecture as non-secret runtime state under the agent's persistent home and mount it at the declared runtime path. Long-lived model data must use explicit `/models` storage, while runtime metadata, launch state, pids, and redacted logs remain separate. Specialized agents own model-profile semantics; Ploinky owns only validation, selection, and safe runtime translation.

Catalog unavailability, invalid schema, unsupported hardware, missing image mapping, unsafe runtime policy, or an unresolved secret must fail before container creation. Core fallback must remain generic and must not guess a vendor-specific image.

## Conclusion

Local LLM support must remain declarative and portable: agents and catalogs own model choices, while Ploinky enforces a narrow, validated runtime policy.
