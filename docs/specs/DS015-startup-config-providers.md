---
id: DS015
title: Startup Config Providers
status: implemented
owner: ploinky-team
summary: Defines startup config providers that run before dependency env resolution, validate allowlisted outputs, and persist redacted public or secret configuration through the workspace secret store.
---

# DS015 Startup Config Providers

## Introduction

Some workspaces need one enabled agent to compute configuration that sibling agents consume at startup. Public route topology, tunnel identifiers, and externally owned service URLs are examples: they are not Ploinky-generated secrets, but they must still be available before dependent manifests resolve their environment. Startup config providers define that ordered preflight contract.

## Core Content

A provider agent declares a top-level `providesConfig` object in its manifest. The object must include a host-side `command` and an `outputs` allowlist. Each output declaration names one environment variable and whether the value is sensitive. Optional outputs may be absent from a provider response; required output support is reserved for providers that need fail-closed value presence.

```json
{
  "providesConfig": {
    "command": "node runtime/provider.mjs",
    "outputs": [
      { "name": "ONLYOFFICE_PUBLIC_URL", "sensitive": false },
      { "name": "WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN", "sensitive": true }
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
        { "agent": "basic/web-publishing global", "profile": "default" }
      ]
    }
  }
}
```

During `ploinky start`, Ploinky applies manifest repository and enable directives, builds the recursive dependency graph, then runs startup config providers before enabling missing graph nodes and before dependency env maps are built. This ordering lets provider output participate in the same manifest env resolution pass as operator-supplied workspace variables.

Provider commands run on the host from the provider agent directory. Their environment is intentionally small: runtime path helpers such as `PLOINKY_WORKSPACE_ROOT`, provider identity helpers such as `PLOINKY_PROVIDER_AGENT`, the selected provider manifest/profile env entries, and the active workspace profile are present. Workspace master material and router-issued identity secrets are stripped; providers must not receive `PLOINKY_MASTER_KEY`, `PLOINKY_DERIVED_MASTER_KEY`, `PLOINKY_AGENT_SECRET`, `PLOINKY_AGENT_API_KEY`, or `PLOINKY_AGENT_API_PUBLIC_KEY`.

Provider stdout must be JSON with schema version `1`:

```json
{
  "version": 1,
  "values": [
    {
      "name": "ONLYOFFICE_PUBLIC_URL",
      "value": "https://office.example.com",
      "sensitive": false,
      "source": "generated"
    }
  ],
  "warnings": []
}
```

The runtime validates every returned value before persistence. It rejects invalid env names, undeclared names, reserved Ploinky names, names beginning with `PLOINKY_AGENT_`, generated or shared-generated secret names owned by any node in the dependency graph, and values whose `sensitive` flag disagrees with the provider manifest. Provider failures abort startup because consumers may otherwise start with stale or missing topology.

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
Generated secrets are derived from the workspace master key and manifest identity. Letting a config provider overwrite those names would blur ownership between external topology providers and Ploinky's generated credential contract. Providers may publish public topology or provider-owned external credentials, but they must not replace generated service secrets.

## Conclusion

Startup config providers are an opt-in preflight layer for configuration that must exist before dependencies start. They preserve Ploinky's secret boundaries by validating allowlisted outputs, stripping master and identity material from provider environments, persisting through the runtime, and recording only redacted metadata.
