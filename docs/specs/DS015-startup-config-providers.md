---
id: DS015
title: Startup Config Providers
status: implemented
owner: ploinky-team
summary: Defines generic startup config providers, allowlisted redacted persistence, and the strict boundary that keeps edge publication, topology, and credentials under Ploinky core.
---

# DS015 Startup Config Providers

## Introduction

Some workspaces need one enabled agent to compute ordinary configuration that
sibling agents consume at startup. Externally owned service settings are one
example. Startup config providers define that ordered preflight contract. Box
edge topology, hostnames, Cloudflare ingress, TURN credentials, and Router
targets are explicitly not provider-agent responsibilities; Ploinky core owns
those through its generation-based topology contract.

## Core Content

A provider agent declares a top-level `providesConfig` object in its manifest. The object must include a host-side `command` and an `outputs` allowlist. Each output declaration names one environment variable and whether the value is sensitive. Optional outputs may be absent from a provider response; required output support is reserved for providers that need fail-closed value presence.

```json
{
  "providesConfig": {
    "command": "node runtime/provider.mjs",
    "outputs": [
      { "name": "EXAMPLE_SERVICE_REGION", "sensitive": false },
      { "name": "EXAMPLE_PROVIDER_TOKEN", "sensitive": true }
    ]
  }
}
```

A static or consumer manifest opts into providers through `configProviders`, either at the top level or inside the active profile. When an active profile declares `configProviders`, that list replaces the default profile list. Each entry names an agent using the same repository-qualified reference syntax as `enable[]` and may select the provider agent profile.

```json
{
  "profiles": {
    "prod": {
      "configProviders": [
        { "agent": "example/config-provider global", "profile": "default" }
      ]
    }
  }
}
```

During `ploinky start`, Ploinky prepares the complete recursive manifest repository graph without starting its processes and resolves a planning graph from those manifests. It captures an early inactive, targetless route-and-identity generation before the static preinstall hook and providers execute. Static preinstall failure aborts startup before any provider runs. Providers then execute against that validated topology. Ploinky reloads the registry, aborts the early preparation lease, re-evaluates retained predecessor runtime hashes against provider output, rotates every newly stale predecessor tuple, and captures the final inactive targetless generation before starting blocking waves. Tuples already minted during the early preparation are fresh and have no predecessor process, so they are retained instead of being minted twice. This ordering lets provider output participate in the same first-launch env resolution pass as operator-supplied workspace variables without reusing a predecessor tuple or racing dependent startup. Additional already-enabled agents outside the graph start after the blocking waves; detached no-wait helpers are spawned last and use the identities accumulated across both preparations.

Provider commands run on the host from the provider agent directory. Their
environment is intentionally small: runtime path helpers such as
`PLOINKY_WORKSPACE_ROOT`, provider identity helpers such as
`PLOINKY_PROVIDER_AGENT`, the selected provider manifest/profile env entries,
and the active workspace profile are present. After merging manifest env,
Ploinky strips the complete shared reserved-agent set rather than maintaining a
provider-local subset. Providers must not receive workspace master material,
TURN or Cloudflare credentials, any `PLOINKY_AGENT_*` identity/instance/
generation/signing value, or its generated-provenance markers. Provider-specific
`PLOINKY_PROVIDER_*` metadata remains available. After stripping config-supplied
reserved values, Ploinky overlays the three non-secret box-owned runtime
locators `PLOINKY_EDGE_TOPOLOGY_FILE`, `PLOINKY_ROUTER_URL`, and
`PLOINKY_INTERNAL_ROUTER_URL`. A provider can read the validated targetless
topology but cannot redirect those locators through its manifest or profile.

Provider stdout must be JSON with schema version `1`:

```json
{
  "version": 1,
  "values": [
    {
      "name": "EXAMPLE_SERVICE_REGION",
      "value": "eu-central",
      "sensitive": false,
      "source": "generated"
    }
  ],
  "warnings": []
}
```

The runtime validates every returned value before persistence. It rejects invalid
env names, undeclared names, reserved Ploinky names, names beginning with
`PLOINKY_AGENT_`, edge-topology names, generated or shared-generated secret
names owned by any node in the dependency graph, and values whose `sensitive`
flag disagrees with the provider manifest. Provider failures abort startup
because consumers may otherwise start with stale or missing configuration.

Accepted values are written by Ploinky itself through the encrypted workspace secret store. Provider code must not call `ploinky var` as the normal persistence path and must not require master-key material. Unchanged values are skipped so repeated startup does not churn `.ploinky/.secrets`.

Ploinky records redacted provider metadata under `.ploinky/config-providers/<provider>.json`. Metadata may include provider id, manifest version, output names, sources, warnings, and timestamps, but it must not include raw values. Current metadata redacts all returned values, including non-sensitive public URLs, so diagnostics cannot accidentally expose tokens through string interpolation or mixed payloads.

## Decisions & Questions

### Question #1: Why add a startup provider phase instead of using static preinstall hooks?

Response:
Static preinstall hooks run early enough to seed values, but they make the static application own another agent's configuration logic. Startup config providers keep that logic with the provider agent while still running before dependent env resolution.

### Question #2: Why does Ploinky persist provider output instead of letting the provider write workspace vars?

Response:
Writing workspace vars requires access to the encrypted store and its master-derived key. Keeping persistence in Ploinky lets provider subprocesses run without `PLOINKY_MASTER_KEY` while still using the existing encrypted workspace var system and redaction rules.

### Question #3: Why block generated and shared-generated secret names?

Response:
Generated secrets are derived from the workspace master key and manifest
identity. Letting a config provider overwrite those names would blur ownership
between external configuration helpers and Ploinky's generated credential
contract. Providers may publish provider-owned values, but they must not replace
generated service secrets or box-owned edge topology.

### Question #4: Why can a generic provider not own edge publication or topology?

Response:
Provider output is workspace configuration that Ploinky validates and persists;
it is not live authorization or box-boundary state. Cloudflare reconciliation,
TURN credential custody, immutable route generations, and topology publication
must remain coordinated by Ploinky core so a provider cannot add an outer port,
activate a hostname, or publish stale consumer locators through ordinary env
values.

## Conclusion

Startup config providers are an opt-in preflight layer for configuration that must exist before dependencies start. They preserve Ploinky's secret boundaries by validating allowlisted outputs, stripping master and identity material from provider environments, persisting through the runtime, and recording only redacted metadata.
