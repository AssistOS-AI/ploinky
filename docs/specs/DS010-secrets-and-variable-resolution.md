---
title: DS010-secrets-and-variable-resolution
summary: Defines master-key ownership, encrypted workspace variables, manifest environment resolution, generated secrets, runtime exposure, and redaction boundaries.
---

# DS010 Secrets and Variable Resolution

## Introduction

Ploinky must let an operator supply configuration and credentials to an agent without placing reusable secrets in manifests, registry records, routing state, logs, or source control. Secret resolution is purpose-specific: the workspace master key, CLI lookup, manifest environment lookup, generated values, and request-signing credentials have separate ownership and precedence rules.

## Core Content

### Secret actors and stores

| Actor or store | Responsibility and boundary |
| --- | --- |
| Workspace operator | Supplies ordinary or sensitive values through `ploinky var`, the process environment, or a walked-up `.env` during direct development. The operator must explicitly name sensitive API-key variables in a manifest before an agent receives them. |
| `.ploinky/master-key` | Is the sole master-key source inside a managed Box. It must be one private regular file owned by the Box user, contain exactly one 64-character lowercase hexadecimal key, and use mode `0600`. It is never injected into an agent. |
| `.ploinky/.secrets` | Is the encrypted workspace variable store written by `ploinky var` and startup config providers. Values are encrypted with a purpose-derived storage key and must never be printed as part of status, routing, or provider metadata. |
| Walked-up `.env` | Is a direct-development fallback found from the current workspace path. A managed Box must ignore it for master-key ownership, although direct execution may use it according to the specific resolver. |
| Agent manifest and profile | Declare which variable names may enter an agent, whether each value is required, its source name, optional default, generated-secret ownership, runtime visibility, and explicit-override conditions. The selected profile's `env` replaces the top-level manifest `env`. |
| Startup config provider | Computes allowlisted ordinary workspace values before agent launch. Ploinky validates and persists its output; the provider never receives master material and cannot overwrite graph-owned generated-secret names. |
| Runtime launcher | Resolves only declared environment entries, removes reserved Ploinky names, injects authoritative identity values after validation, and excludes `runtime: false` entries from the running process. |
| Router and AgentServer | Use purpose-derived per-agent request secrets internally to sign and verify Agent Assertions and Router Requests. Those secrets are not ordinary manifest values and cannot be requested through `env`. |

### Secret and credential classes

| Class | Ownership and behavior |
| --- | --- |
| Workspace master key | Roots encrypted stores and all HKDF-derived keys. Managed execution reads only `.ploinky/master-key`; direct execution resolves the process environment, a walked-up `.env`, then the persisted fallback. |
| Encrypted workspace variable | Is an operator- or provider-owned name/value pair in `.ploinky/.secrets`. `$OTHER_NAME` values may alias another encrypted variable, with cycles and missing targets resolving to an empty value. |
| Manifest default | Is non-secret configuration embedded in the manifest or selected profile and is used only when no accepted explicit source resolves. Required values without a source or default fail startup. |
| Agent-generated secret | Uses `generatedSecret: true` and is deterministically derived from the workspace key, repository, agent, and inside variable name. Different agents or names receive different bytes. |
| Shared generated secret | Uses `sharedGeneratedSecret: true` and is derived from the workspace key and declared source name so explicitly cooperating agents can receive the same value. |
| Persistent random secret | Is created by `ensurePersistentSecret` when no accepted explicit value exists, stored in `.ploinky/.secrets`, and reused on later starts. It is distinct from deterministic generated secrets. |
| Agent request secret | Is derived for canonical principal `agent:<repo>/<agent>` and is injected only into credential-capable confined runtimes after exact identity and generation attestation. It signs public Router-facing Agent Assertions. |
| Private agent request secret | Is derived from principal, effective instance id, and enable generation. It signs private-listener assertions and becomes invalid when the runtime tuple changes. |
| Session, password-store, delegation, relay, and publication keys | Use separate HKDF purposes and verifier paths. Possession of one derived key must not permit derivation or use of another protocol family. |
| Ephemeral token or channel credential | Is short-lived, request- or generation-bound, replay-protected, and delivered only to its intended recipient. It must not be persisted as an ordinary workspace variable. |

### Resolution precedence

Ploinky must use the resolver belonging to the value's purpose; callers must not assume one global precedence order.

| Resolver | Precedence and rule |
| --- | --- |
| Managed Box master key | `.ploinky/master-key` only. Host environment and `.env` values are ignored. |
| Direct-development master key | `process.env.PLOINKY_MASTER_KEY`, then walked-up `.env`, then `.ploinky/master-key`. Invalid format or an incompatible encrypted store fails with a key-mismatch error. |
| `secretInjector.getSecret` and multiple-secret lookup | Process environment, then encrypted `.ploinky/.secrets`, then walked-up `.env`. |
| Manifest environment lookup | Encrypted `.ploinky/.secrets`, then process environment, then walked-up `.env`, then the manifest default. Generated-secret rules are evaluated before ordinary fallback. |
| `ensurePersistentSecret` | Process environment, optional walked-up `.env`, existing encrypted workspace value, then a newly generated random value persisted to `.ploinky/.secrets`. |
| Startup provider output | Accepted provider value updates `.ploinky/.secrets` only when its value changed. It cannot target a reserved name or a generated-secret name owned by the active graph. |

### Manifest environment declarations

| Manifest field or form | Required behavior |
| --- | --- |
| `env: ["NAME"]` | Exposes `NAME` under the same name when it resolves; it is optional unless declared with object form. |
| `env: ["NAME=default"]` | Uses the inline value as the default after accepted external sources are checked. |
| `env: [{ "name": "INSIDE", "varName": "SOURCE" }]` | Maps `SOURCE` from the workspace resolvers to `INSIDE` in the runtime. |
| Object-form `env.INSIDE` | May declare `name` or `varName`, `required`, `default` or `value`, generated-secret flags, explicit-override rules, and `runtime`. |
| `required: true` | Fails environment construction when no explicit value, generated value, or default resolves. A required generated secret does not require an operator value. |
| `generatedSecret: true` | Derives the value for the owning repository, agent, and inside name. Legacy derivation fields and `generatedSecretScope` are rejected. |
| `sharedGeneratedSecret: true` | Derives a workspace-shared value from the declared source name. It must be used only when multiple agents intentionally require the same secret. |
| `explicitOverride: true` | Permits an explicit operator value to replace a generated value. Without this declaration, an existing variable with the same name does not override the generated value. |
| `explicitOverrideRequires` | Permits the generated-value override only when every named companion variable also resolves to a non-empty explicit value. |
| `runtime: false` | Resolves the value for host hooks, provider preparation, image templating, and runtime hashing but excludes the value and provenance marker from the agent process. |
| Wildcard such as `LLM_MODEL_*` | Expands matching names deterministically from accepted sources. The broad `*` form excludes names containing `API_KEY`; those must be explicitly declared. |

The selected profile's `env` is the active declaration set when present. Duplicate inside names must resolve once. The launcher must add bounded provenance metadata only for non-sensitive runtime values where supported and must never expose the source or value of a reserved credential.

### Injection and confinement

Only variables declared by the active manifest or profile may be considered for an agent runtime. Before launch, Ploinky must strip `PLOINKY_MASTER_KEY`, derived-master material, caller-supplied agent identity, Router descriptors, request credentials, publication tokens, TURN credentials, and every other reserved core name. Core may then add the validated non-secret topology locators and, for an eligible confined runtime, the exact per-agent identity and request credential.

Host, `none`, Bubblewrap, Seatbelt, lifecycle-hook, and config-provider execution must remain principal-only unless a specific confined protocol grants a fresh channel-bound credential. The workspace master key and derived-master key must never enter any agent environment. Values marked `runtime: false` must not be reintroduced by `expose`, a duplicate declaration, or runtime metadata.

The encrypted variable store must be updated atomically. Logs, errors, status output, provider metadata, runtime state, selected-architecture state, image references, command arguments, and test evidence must redact values whose names or uses indicate secrets, tokens, passwords, credentials, private keys, master keys, encryption keys, or API keys. Deletion must remove only the named encrypted variable and must not disturb unrelated values.

Startup config providers are specified separately in [DS017-startup-config-providers](specsLoader.html?spec=DS017-startup-config-providers.md). Request-bound identity and token behavior is specified in [DS015-per-agent-identity-and-request-signed-jwts](specsLoader.html?spec=DS015-per-agent-identity-and-request-signed-jwts.md).
