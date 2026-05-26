# Ploinky Generated Secret Invariants And Migration Plan

Status: implemented
Date: 2026-05-26
Scope: Ploinky core secret derivation, manifest/runtime-resource secret contracts, and the AssistOSExplorer/Soul Gateway/WebMeet/OnlyOffice migrations affected by `PLOINKY_MASTER_KEY`.

## Goal

Ploinky has one manifest model for deterministic workspace-generated agent secrets:

```json
{ "name": "SOME_SECRET", "generatedSecret": true }
```

The removed manifest model is the older manifest-level derivation convention. Manifests must not use `derive`, custom repo/agent/name derivation fields, custom byte lengths, or the `{{derivedMasterSecret:NAME}}` runtime-resource template.

## Invariants

1. `PLOINKY_MASTER_KEY` is the workspace root secret and must never be injected into agent runtimes.
2. `PLOINKY_DERIVED_MASTER_KEY` is the agent runtime root derived from `PLOINKY_MASTER_KEY`; it is still used for router invocation JWTs and as the root for generated agent secrets.
3. `generatedSecret: true` is the only supported manifest declaration for a deterministic generated env secret.
4. By default, a generated env secret is agent-scoped and derives from the current repo name, current agent name, and the env name.
5. `{{generatedSecret:NAME}}` is the only supported runtime-resource template for an agent-scoped generated secret.
6. Generated secrets are always 32 bytes before hex encoding. Manifests do not choose byte length or encoding.
7. Generated secrets ignore same-named process env, `.ploinky/.secrets`, `.env`, and manifest defaults unless the entry explicitly declares `explicitOverride: true`, or declares `explicitOverrideRequires` and all companion explicit values are present.
8. A shared generated credential must use `sharedGeneratedSecret: true`. Workspace-scoped secrets derive from the source env name (`varName` when present, otherwise `name`) and are reserved for credentials that must be identical across agents.
9. Workspace-scoped generated secrets replace custom logical derivation identities. The shared identity is the env name, not a repo/agent/name tuple.
10. Cross-agent raw credentials remain a compatibility pressure, not the preferred architecture. New designs should prefer owner-mediated service calls through secure wire, declared MCP tools, or protected HTTP services.
11. Browser-facing outputs may receive derived products such as short-lived participant tokens, public URLs, ICE server config, or scoped invite tokens. Browser-facing outputs must never receive raw API secrets, master keys, shared service keys, or invocation JWTs.

## Classification

| Secret | Target contract |
|---|---|
| `PLOINKY_WEBMEET_MASTER_KEY` | Agent-scoped `generatedSecret: true`. |
| `DPU_MASTER_KEY` | Runtime resource `{{generatedSecret:DPU_MASTER_KEY}}`. |
| `ENCRYPTION_KEY` | Agent-scoped `generatedSecret: true` in Soul Gateway embedded profile. |
| `ADMIN_SESSION_SIGNING_KEY` | Agent-scoped `generatedSecret: true` in Soul Gateway embedded profile. |
| `SOUL_GATEWAY_API_KEY` | Workspace-scoped `sharedGeneratedSecret: true` across gateway consumers. |
| `ONLYOFFICE_JWT_SECRET` / `JWT_SECRET` | Workspace-scoped generated secret using `varName: "ONLYOFFICE_JWT_SECRET"` for Document Server's `JWT_SECRET`. |
| `WEBMEET_LIVEKIT_API_KEY` | Workspace-scoped generated secret shared by WebMeet and LiveKit agents. |
| `WEBMEET_LIVEKIT_API_SECRET` | Workspace-scoped generated secret shared by WebMeet and LiveKit agents. |
| `WEBMEET_TURN_PASSWORD` | Workspace-scoped generated secret shared by WebMeet and LiveKit agents. |
| `WEBMEET_AGENT_INTERNAL_TOKEN` | Workspace-scoped generated secret until replaced by router/secure-wire identity. |

## Implementation Checklist

1. Keep `deriveAgentSecret()` for agent-scoped generated secrets.
2. Add `deriveWorkspaceSecret()` for workspace-scoped generated secrets keyed by source env name.
3. Reject manifest env entries containing the removed legacy derivation fields.
4. Resolve `sharedGeneratedSecret: true` through `deriveWorkspaceSecret()`.
5. Keep `explicitOverride: true` and `explicitOverrideRequires` support for external overrides. Soul Gateway consumers use `explicitOverride: true` so a user-supplied `SOUL_GATEWAY_API_KEY` can use the `LLMConfig.json` default gateway URL when no env URL is present.
6. Reject `{{derivedMasterSecret:NAME}}` templates and keep `{{generatedSecret:NAME}}`.
7. Convert manifests in AssistOSExplorer and Soul Gateway to generated-secret entries.
8. Update specs, prompts, and skills so they state the new invariants.
9. Verify with unit tests, JSON parsing, syntax checks, and a final search for removed manifest conventions.

## Verification

Run from `/Users/danielsava/work/file-parser/ploinky`:

```bash
node --test tests/unit/generatedSecretEnv.test.mjs
node --test tests/unit/runtimeResourcePlanner.test.mjs
node --test tests/unit/wildcardEnv.test.mjs
node --test tests/unit/profileSystem.test.mjs
node --check cli/services/masterKey.js
node --check cli/services/secretVars.js
node --check cli/services/runtimeResourcePlanner.js
git diff --check
```

Run from `/Users/danielsava/work/file-parser/AssistOSExplorer`:

```bash
node -e 'const fs=require("fs"); for (const file of ["explorer/manifest.json","gitAgent/manifest.json","llmAssistant/manifest.json","onlyOffice/manifest.json","webassist/manifest.json","webmeetAgent/manifest.json","webmeetInfra/liveKitServerAgent/manifest.json","webmeetLivekitAiAgent/manifest.json"]) JSON.parse(fs.readFileSync(file,"utf8"));'
```
