---
title: DS009-secrets-skills-and-llm-assistance
summary: Defines workspace secret resolution, generated-secret ownership, copied-skill boundaries, and generic LLM-assisted CLI context.
---

# DS009 Secrets, Skills, and LLM Assistance

## Introduction

Ploinky provides workspace configuration and operator assistance without making external skills or model providers part of its core runtime identity.

## Core Content

Managed Boxes must use only the workspace-owned `.ploinky/master-key` as the root for encrypted stores and derived secrets. Direct non-Box development may use the documented process-environment, walked-up `.env`, and persisted fallback resolution. Ordinary variable lookup and manifest environment lookup may have purpose-specific precedence; security-sensitive callers must use the resolver defined for their store instead of assuming one universal order.

Manifest `generatedSecret` values must be derived for the owning agent and secret name. `sharedGeneratedSecret` values must be derived for the declared shared service identity. Operator values may override only when the manifest explicitly allows the override and its required companion variables. The launcher must strip reserved Ploinky identity, topology, and credential names before injecting authoritative values, and no agent may receive the workspace master key or derived-master key.

Default skills may be copied into eligible repositories as workspace tooling. Ploinky must preserve their local directory contracts and update them through the repository update flow, but imported skills are not Ploinky runtime modules and must not cause core routing, lifecycle, or documentation contracts to hardcode their names or behavior.

CLI command suggestion and shell assistance may use AchillesAgentLib model configuration and the Ploinky operator overview as context. The helper must select only configured providers for which required credentials are available, must redact secrets from prompts and diagnostics, and must treat suggestions as operator-visible assistance rather than implicit command execution. Model names and provider tags must remain configuration data.

Startup config providers are a separate controlled writer to the encrypted variable store and must follow DS016. They do not become another generated-secret ownership model and must not overwrite graph-owned generated secrets.

## Conclusion

Secrets, copied skills, and LLM assistance must support the workspace while remaining bounded, configurable, and subordinate to Ploinky's generic runtime and credential model.
