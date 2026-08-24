---
title: DS017-startup-config-providers
summary: Defines what startup config providers are, how manifests select them, their execution and JSON contract, persistence, ordering, and protected boundaries.
---

# DS017 Startup Config Providers

## Introduction

A startup config provider is an agent repository component that runs a bounded host-side command before graph runtimes start and returns ordinary workspace configuration as versioned JSON. It is useful when a value must be discovered or generated at startup and then consumed through another agent's normal manifest `env` declaration. The provider computes candidate values; Ploinky validates, persists, reloads, and distributes them.

## Core Content

### Actors and ownership

| Actor | Responsibility |
| --- | --- |
| Consuming static agent | Selects providers through top-level or active-profile `configProviders` and declares the returned variable names it needs through ordinary manifest `env`. |
| Provider agent | Declares `providesConfig.command` and an explicit list of allowed outputs. Its repository contains the command, but the command receives no authority to write Ploinky state directly. |
| Dependency graph resolver | Resolves each provider reference using the same repository-qualified, alias, profile, and dependency rules as other manifest agents. A selected provider must resolve within the admitted startup graph. |
| Startup coordinator | Creates an early inactive targetless topology, runs static preinstall, invokes providers in declared order, reloads persisted values, recalculates affected runtime identities, and creates the final launch lease. |
| Provider validator | Parses versioned JSON, checks every name and sensitivity declaration against the provider manifest, rejects protected outputs, and bounds warnings and metadata. |
| Encrypted workspace store | Persists accepted changed values in `.ploinky/.secrets` using the workspace master-key hierarchy. Provider code never receives the master key or storage key. |
| Consuming runtime | Receives a provider value only when its own selected manifest or profile declares that variable in `env`; provider output does not automatically enter every agent. |

### Manifest configuration

| Field | Contract |
| --- | --- |
| `providesConfig.command` | Required non-empty shell command for a provider. Ploinky runs it from the provider agent directory with a five-minute execution bound and a one-megabyte output bound. |
| `providesConfig.outputs` | Array of the only variable names the command may return. Duplicate names, invalid environment names, and reserved `PLOINKY_*` names are rejected. |
| `providesConfig.outputs[].name` | Required environment variable name matching `[A-Za-z_][A-Za-z0-9_]*`. |
| `providesConfig.outputs[].sensitive` | Boolean, default `false`. The returned value must repeat exactly the declared sensitivity flag. Metadata is redacted regardless of this flag. |
| `providesConfig.outputs[].required` | Boolean declaration retained as part of the output contract. Consumers still declare their own required environment inputs. |
| `configProviders` | Array on the static manifest or its active profile selecting provider agents. Entries may be strings or objects naming `agent`, `ref`, `spec`, or `name`. |
| `configProviders[].profile` | Optional provider profile, normalized and resolved with the same profile rules as the graph node. |

The provider and consumer declarations are intentionally separate. The provider owns which names it can compute; the static agent owns which provider runs; each consuming agent owns which returned names enter its environment.

```json
{
  "providesConfig": {
    "command": "node scripts/discover-config.mjs",
    "outputs": [
      { "name": "SERVICE_BASE_URL", "sensitive": false, "required": true },
      { "name": "SERVICE_ACCESS_TOKEN", "sensitive": true, "required": true }
    ]
  }
}
```

```json
{
  "configProviders": ["infrastructure/config-discovery"],
  "env": [
    { "name": "SERVICE_BASE_URL", "required": true },
    { "name": "SERVICE_ACCESS_TOKEN", "required": true }
  ]
}
```

### Provider execution flow

<figure class="diagram">
<pre class="mermaid">flowchart TD
    A[Resolve complete startup graph] --> B[Create inactive targetless generation]
    B --> C[Run static preinstall hook]
    C --> D[Resolve selected provider agents and profiles]
    D --> E[Run provider command with stripped bounded environment]
    E --> F[Parse version 1 JSON output]
    F --> G[Validate names, sensitivity, and protected-name rules]
    G --> H[Persist only changed values in encrypted store]
    H --> I[Write value-redacted provider metadata]
    I --> J[Reload registry and manifest environment]
    J --> K[Rotate stale runtime tuples and capture final launch lease]
    G -->|Invalid output| L[Abort before consumer launch]</pre>
<figcaption><em>Startup config provider flow</em></figcaption>
</figure>

Providers must run after the static preinstall hook and before the final graph preparation lease. They execute sequentially in the order selected by the static manifest and active profile. The command runs on the host from the provider directory. Its environment may contain `PATH`, `HOME`, workspace root, active workspace profile, provider repository and agent identifiers, the provider data directory, and provider manifest/profile environment values needed by the command.

Before invocation, Ploinky must strip the workspace master key, derived-master material, reusable agent secrets, private tuple secrets, Router descriptors and authority values, generated-secret provenance, edge-publication tokens, TURN credentials, and all reserved core names. Non-secret core locators may be supplied only by Ploinky after stripping manifest-provided values.

### Output protocol

The command must write one JSON object to stdout. Diagnostic text belongs on stderr and is included only as bounded redacted failure detail.

```json
{
  "version": 1,
  "values": [
    {
      "name": "SERVICE_BASE_URL",
      "value": "http://service.internal",
      "sensitive": false,
      "source": "service-discovery"
    }
  ],
  "warnings": []
}
```

| Output member | Contract |
| --- | --- |
| `version` | Must equal `1`. Missing or unsupported versions fail provider execution. |
| `values` | Array of output objects. Every entry must be declared by `providesConfig.outputs`. |
| `values[].name` | Must be a valid declared environment name and must not begin with `PLOINKY_`, name a reserved credential, or collide with a generated or shared-generated secret owned by any active graph node. |
| `values[].value` | Is converted to a string and persisted only by Ploinky. An unchanged value does not rewrite the encrypted store. |
| `values[].sensitive` | Must exactly equal the manifest declaration. A mismatch fails the complete provider run. |
| `values[].source` | Optional bounded provenance label, defaulting to `generated`. It is metadata and grants no authority. |
| `warnings` | Optional array of bounded redacted messages recorded with the provider result. Warnings do not bypass validation. |

Ploinky must reject empty output, malformed JSON, undeclared values, duplicate declarations, sensitivity mismatches, invalid names, reserved names, topology names, and graph-owned generated-secret names. A command timeout, non-zero exit, validation failure, encryption failure, or metadata publication failure must abort startup before any consuming runtime launches.

### Persistence and protected boundaries

Accepted values must be written through the encrypted workspace store. Provider code must not call `ploinky var` as its normal persistence path and must never receive storage-key material. Ploinky may write `.ploinky/config-providers/<provider>.json` containing the provider id, manifest version, active profile, application time, output names, sensitivity flags, sources, warnings, and the literal redaction marker; it must never include a returned value.

A provider must not create or select the outer Box, host publications, Cloudflare ingress, DNS, public hostnames, Router targets, policy generations, route leases, TURN credentials, runtime capabilities, agent request secrets, or generated-secret ownership. Returning an ordinary variable whose name resembles one of those controls must be rejected. Provider output becomes ordinary workspace configuration and reaches an agent only through that agent's declared environment resolution described by [DS010-secrets-and-variable-resolution](specsLoader.html?spec=DS010-secrets-and-variable-resolution.md).

### Provider architecture rationale

| Decision | Reason |
| --- | --- |
| Separate the provider, Ploinky core, and consuming agents | The provider discovers values, core validates and persists them, and only declared consumers receive them. No workload gains direct authority over the secret store or another agent's environment. |
| Require declared outputs and one bounded versioned JSON result | Core can validate names, sensitivity, size, provenance, and completeness before any consumer starts; arbitrary stdout or file mutation cannot become configuration. |
| Run providers before the final runtime generation is admitted | Provider values may change runtime hashes and environments. Resolving them first prevents routes and identities from describing a runtime built with obsolete configuration. |
| Persist accepted values through core-owned encrypted storage | A provider never receives the workspace master key and cannot bypass ownership, redaction, or consumer filtering by writing live state itself. |
| Exclude topology, publication, policy, and identity controls from provider output | A configuration-discovery process must not redefine the boundary that confines it or mint the authority used to validate its own consumers. |
