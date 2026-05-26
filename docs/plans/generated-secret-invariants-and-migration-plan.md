# Ploinky Generated Secret Invariants And Migration Plan

Status: planning handoff
Date: 2026-05-26
Scope: Ploinky core secret derivation, manifest/runtime-resource secret contracts, and the AssistOSExplorer WebMeet/DPU/Soul Gateway/OnlyOffice migrations affected by `PLOINKY_MASTER_KEY`.

## Goal

Ploinky should have a simple default rule for workspace-generated agent secrets:

> Every generated secret that belongs to one agent is derived from `PLOINKY_MASTER_KEY` through the current agent identity.

The manifest spelling for that rule is `generatedSecret: true`. This avoids repeating `deriveRepoName`, `deriveAgentName`, `deriveName`, and `deriveBytes` for ordinary per-agent secrets.

The important caveat is that some current `derive: "derived-master"` entries are not ordinary per-agent secrets. They are shared credentials deliberately made equal across multiple agents. Those must either remain as explicit legacy shared derivations or be migrated to an owner-service model where one agent owns the raw secret and other agents call it through Ploinky-mediated APIs.

## Current Observations

Ploinky derives `PLOINKY_DERIVED_MASTER_KEY` from `PLOINKY_MASTER_KEY` and injects the derived key into agents. Agents do not receive `PLOINKY_MASTER_KEY`.

`deriveAgentSecret()` in `ploinky/cli/services/masterKey.js` derives secrets with the label:

```text
ploinky/agent-secret/<repoName>/<agentName>/<secretName>/v1
```

The default byte length is 32 and the default encoding is hex.

Manifest env resolution in `ploinky/cli/services/secretVars.js` supports:

- `derive: "derived-master"` for compatibility and explicit logical shared identities.
- `generatedSecret: true` for per-agent generated secrets scoped to the current repo, current agent, and env name.

Runtime resource planning in `ploinky/cli/services/runtimeResourcePlanner.js` supports:

- `{{derivedMasterSecret:NAME}}` for compatibility.
- `{{generatedSecret:NAME}}` for the new per-agent resource-template form.

WebMeet currently uses explicit shared derivation labels because several agents must agree on the same LiveKit, TURN, and internal-token values:

- `webmeetInfra/liveKitServerAgent` writes LiveKit/Egress/TURN config from `WEBMEET_LIVEKIT_API_KEY`, `WEBMEET_LIVEKIT_API_SECRET`, and `WEBMEET_TURN_PASSWORD`.
- `webmeetAgent` signs participant tokens, room-admin tokens, AgentDispatchService calls, and Egress calls from the same LiveKit API key/secret.
- `webmeetLivekitAiAgent` maps the same credentials into `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` for the LiveKit Agents worker.
- `webmeetAgent` and `webmeetLivekitAiAgent` share `WEBMEET_AGENT_INTERNAL_TOKEN` for transcript writes.

Therefore replacing those entries with `generatedSecret: true` immediately would break credential equality. The right migration is to stop sharing those raw credentials.

## Terms

Agent-owned generated secret:
A workspace-generated secret used by one agent and not intentionally equal to another agent's secret. Example: `PLOINKY_WEBMEET_MASTER_KEY`, `DPU_MASTER_KEY`.

Shared service credential:
A raw credential that currently has to be identical across multiple agents. Example: LiveKit API key/secret, TURN password, OnlyOffice JWT secret, embedded Soul Gateway API key.

External/operator credential:
A credential whose value originates outside Ploinky. Example: provider API keys, deployment SSH keys, upstream service tokens.

Topology/config value:
Non-secret runtime information such as URLs, hostnames, ports, realms, and profile-specific public paths.

## New Invariants

1. `PLOINKY_MASTER_KEY` is the workspace root secret. It must never be injected into agent runtimes.

2. `PLOINKY_DERIVED_MASTER_KEY` is a derived runtime key. It may be injected into enabled agents under the current single-workspace trust model, but it must not be described as tenant isolation or non-repudiation between mutually hostile agents.

3. `generatedSecret: true` is the preferred manifest contract for a workspace-generated secret owned by the current agent.

4. A `generatedSecret` env entry derives from the current repo name, current agent name, and the env name. It does not accept `deriveRepoName`, `deriveAgentName`, `deriveName`, `deriveBytes`, or format fields.

5. `{{generatedSecret:NAME}}` is the preferred runtime-resource template for a generated secret owned by the current agent.

6. New generated secrets are always 32 bytes before encoding. The default encoded form is hex.

7. `generatedSecret` values ignore same-named process env, `.ploinky/.secrets`, `.env`, and manifest defaults. They are deterministic workspace-owned values, not operator-overridable configuration.

8. `derive: "derived-master"`, `{{derivedMasterSecret:NAME}}`, `deriveRepoName`, `deriveAgentName`, `deriveName`, `deriveBytes`, and `deriveFormat` are legacy compatibility tools. They remain valid only for explicit shared derivation identities and backwards-compatible migrations.

9. Cross-agent shared raw credentials must not be added by default. If several agents need a service-owned capability, the service-owning agent should hold the raw credential and expose a Ploinky-mediated operation.

10. Service-owned credentials belong to the owning agent. Consumers should call the owner through secure wire, declared MCP tools, or a declared protected HTTP service with router-established identity. They should not receive the owner's static API secret merely to perform service operations.

11. Browser-facing outputs may receive derived products such as short-lived participant tokens, public URLs, ICE server config, or scoped invite tokens. Browser-facing outputs must never receive raw API secrets, master keys, shared service keys, or invocation JWTs.

12. Any temporary shared-credential exception must be documented in the owning DS spec, name the logical derivation identity, explain why owner-mediated calls are not yet possible, and include a migration path.

## Current Secret Classification

| Secret | Current location | Classification | Target |
|---|---|---|---|
| `PLOINKY_WEBMEET_MASTER_KEY` | `AssistOSExplorer/webmeetAgent/manifest.json` | Agent-owned generated secret | Convert to `generatedSecret: true`. |
| `DPU_MASTER_KEY` | `AssistOSExplorer/dpuAgent/manifest.json` runtime resource | Agent-owned generated secret | Convert to `{{generatedSecret:DPU_MASTER_KEY}}`. |
| `ENCRYPTION_KEY` | `proxies/soul-gateway/manifest.json` | Agent-owned generated secret, but label name differs from env name | Candidate for `generatedSecret: true` only with rotation/compatibility decision. |
| `ADMIN_SESSION_SIGNING_KEY` | `proxies/soul-gateway/manifest.json` | Agent-owned generated secret, but label name differs from env name | Candidate for `generatedSecret: true` only with rotation/compatibility decision. |
| `SOUL_GATEWAY_API_KEY` | `proxies/soul-gateway`, `AssistOSExplorer/explorer`, `AssistOSExplorer/llmAssistant` | Shared service credential | Keep explicit shared identity until embedded gateway auth moves to router/secure-wire or owner-issued scoped credentials. |
| `ONLYOFFICE_JWT_SECRET` / `JWT_SECRET` | `AssistOSExplorer/explorer`, `AssistOSExplorer/onlyOffice` | Shared service signing secret | Keep explicit shared identity unless OnlyOffice integration is redesigned around an owner-mediated signing boundary. |
| `WEBMEET_LIVEKIT_API_KEY` | WebMeet and LiveKit manifests | Shared LiveKit service credential | Move ownership to `liveKitServerAgent`; remove from consumers after owner API exists. |
| `WEBMEET_LIVEKIT_API_SECRET` | WebMeet and LiveKit manifests | Shared LiveKit service credential | Move ownership to `liveKitServerAgent`; remove from consumers after owner API exists. |
| `WEBMEET_TURN_PASSWORD` | WebMeet and LiveKit manifests | Shared TURN service credential | Move ownership to `liveKitServerAgent`; expose only ICE config to consumers/browser. |
| `WEBMEET_AGENT_INTERNAL_TOKEN` | `webmeetAgent`, `webmeetLivekitAiAgent` | Shared internal bearer token | Replace with router/secure-wire identity or a scoped owner-issued invocation token. |

## Implementation Plan

### Phase 0: Baseline And Safety

1. Work from `/Users/danielsava/work/file-parser`.
2. Read root `CLAUDE.md`, then the local `CLAUDE.md` files for each touched repo or agent.
3. Load the runtime-invariants guidance before touching manifests, router auth, HTTP services, MCP, secure wire, or secrets.
4. Inspect `git status` in each affected subrepo before edits.
5. Do not revert unrelated changes.
6. Treat current `generatedSecret` support as baseline if present. If working on a branch where it is absent, implement it before migrations.

### Phase 1: Lock The Ploinky Core Contract

Target files:

- `ploinky/cli/services/masterKey.js`
- `ploinky/cli/services/secretVars.js`
- `ploinky/cli/services/runtimeResourcePlanner.js`
- `ploinky/tests/unit/derivedMasterEnv.test.mjs`
- `ploinky/tests/unit/runtimeResourcePlanner.test.mjs`
- Ploinky DS specs and HTML docs listed in Phase 2

Required behavior:

1. `generatedSecret: true` works for array-form manifest env entries.
2. `generatedSecret: true` works for object-form manifest env entries.
3. Generated env secrets derive from `repoName`, `agentName`, and the inside env name.
4. Generated env secrets ignore process env, `.ploinky/.secrets`, `.env`, and defaults.
5. Required generated env secrets do not require profile defaults.
6. `{{generatedSecret:NAME}}` derives from `repoName`, `agentName`, and `NAME`.
7. Generated secrets use 32 bytes and hex encoding.
8. Existing `derive: "derived-master"` behavior remains backwards-compatible, including explicit shared labels and `deriveBytes`.

Suggested tests:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/derivedMasterEnv.test.mjs
node --test tests/unit/runtimeResourcePlanner.test.mjs
node --test tests/unit/wildcardEnv.test.mjs
node --check cli/services/secretVars.js
node --check cli/services/runtimeResourcePlanner.js
git diff --check
```

### Phase 2: Update Specs And Human Docs

Ploinky core docs/specs must state the new default and the legacy/shared exception:

- `ploinky/docs/specs/DS003-agent-manifest-and-registry.md`
- `ploinky/docs/specs/DS008-secrets-skills-and-llm-assistance.md`
- `ploinky/docs/specs/DS011-security-model.md`
- `ploinky/docs/spec-agent.html`
- `ploinky/docs/runtime.html`
- `ploinky/docs/operations.html`
- `ploinky/docs/architecture.html`

AssistOSExplorer runtime copies and local specs must stop presenting cross-agent raw shared credentials as the desired end state:

- `AssistOSExplorer/docs/specs/DS06-ploinky-runtime-invariants.md`
- `AssistOSExplorer/webmeetAgent/docs/specs/DS006-ploinky-runtime-invariants.md`
- `AssistOSExplorer/webmeetAgent/docs/specs/DS005-self-hosted-livekit-ai-agents.md`
- `AssistOSExplorer/webmeetInfra/docs/specs/DS002-livekit-server-agent.md`
- `AssistOSExplorer/webmeetInfra/docs/specs/DS003-ploinky-runtime-invariants.md`
- `AssistOSExplorer/webmeetLivekitAiAgent/docs/specs/DS01-ploinky-agent-invariant.md`
- `AssistOSExplorer/dpuAgent/docs/specs/DS08-ploinky-runtime-invariants.md`

Spec wording must distinguish:

- Preferred per-agent generated secrets: `generatedSecret: true` and `{{generatedSecret:NAME}}`.
- Legacy explicit shared derivation: `derive: "derived-master"` with explicit logical labels.
- External/operator credentials: never derive unless the value is truly workspace-owned.

### Phase 3: Migrate Safe Per-Agent Secrets

These migrations should preserve the derived label or be verified before merge.

1. Convert `PLOINKY_WEBMEET_MASTER_KEY` in every `AssistOSExplorer/webmeetAgent/manifest.json` profile from:

```json
{
  "name": "PLOINKY_WEBMEET_MASTER_KEY",
  "required": false,
  "derive": "derived-master"
}
```

to:

```json
{
  "name": "PLOINKY_WEBMEET_MASTER_KEY",
  "required": false,
  "generatedSecret": true
}
```

2. Convert `DPU_MASTER_KEY` in `AssistOSExplorer/dpuAgent/manifest.json` from:

```json
"DPU_MASTER_KEY": "{{derivedMasterSecret:DPU_MASTER_KEY}}"
```

to:

```json
"DPU_MASTER_KEY": "{{generatedSecret:DPU_MASTER_KEY}}"
```

3. Update matching DPU docs:

- `AssistOSExplorer/dpuAgent/README.md`
- `AssistOSExplorer/dpuAgent/docs/configuration.html`
- any local DPU runtime-invariant spec that references `{{derivedMasterSecret:DPU_MASTER_KEY}}`

4. Before and after conversion, use a local script or unit test to prove the generated value equals the old implicit current-agent `derive: "derived-master"` value for the same repo/agent/name.

Do not migrate LiveKit, TURN, OnlyOffice, or Soul Gateway shared API keys in this phase.

### Phase 4: Add Legacy Shared-Derivation Warnings

Add manifest validation or lint-style warnings for new shared derivation use.

Behavior:

1. `generatedSecret: true` never warns.
2. Plain `derive: "derived-master"` without explicit shared-label fields may warn with a migration suggestion to `generatedSecret: true`, unless compatibility is explicitly allowed.
3. `deriveRepoName`, `deriveAgentName`, `deriveName`, `deriveBytes`, and `deriveFormat` may warn unless the env entry is on a documented allowlist.
4. Existing compatibility entries should not break startup.

Initial allowlist candidates:

- WebMeet LiveKit API key/secret and TURN password.
- WebMeet internal token.
- OnlyOffice JWT shared signing secret.
- Soul Gateway embedded workspace default API key.
- Soul Gateway agent-owned keys if rotation is not approved yet.

Warnings must avoid printing secret values.

### Phase 5: Design The LiveKit Owner Boundary

Before changing WebMeet runtime behavior, update or add DS content that makes `liveKitServerAgent` the raw LiveKit/TURN credential owner.

Target owner:

`AssistOSExplorer/webmeetInfra/liveKitServerAgent`

Owner-owned generated secrets:

- LiveKit API key.
- LiveKit API secret.
- TURN password.

Target consumer capabilities:

1. Mint participant token for a room, identity, display name, grants, metadata, and attributes.
2. Create/list/delete LiveKit AI agent dispatches.
3. List room participants when WebMeet needs to verify an `AGENT` participant.
4. Start and stop Egress recordings.
5. Return non-secret public media topology: public LiveKit URL, ICE servers, TURN username, TURN URLs, and ICE transport policy.

Preferred transport:

- Use declared MCP tools over Ploinky secure wire if the caller is another agent.
- Use a declared protected HTTP service only if router-established agent/user identity is available to the service and direct internal-port bypasses are not treated as authority.
- Do not add product-specific paths to Ploinky core.
- Do not add a new shared bearer token as a replacement for the old shared bearer token.

Implementation options:

1. Add a small Node control service inside the `liveKitServerAgent` image and start it from the supervisor.
2. Add MCP tools to `liveKitServerAgent` for LiveKit operations and have `webmeetAgent` call them through secure wire.
3. If the LiveKit Agents worker absolutely requires `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, document that as a temporary exception and keep it on the allowlist until the LiveKit worker contract can be narrowed.

### Phase 6: Move WebMeet Control-Plane Calls To The Owner

Target files:

- `AssistOSExplorer/webmeetAgent/lib/webmeetStore.mjs`
- `AssistOSExplorer/webmeetAgent/server/webmeet-api.mjs`
- `AssistOSExplorer/webmeetAgent/manifest.json`
- `AssistOSExplorer/webmeetAgent/docs/specs/DS005-self-hosted-livekit-ai-agents.md`
- `AssistOSExplorer/webmeetAgent/docs/specs/DS006-ploinky-runtime-invariants.md`
- `AssistOSExplorer/webmeetInfra/liveKitServerAgent/manifest.json`
- `AssistOSExplorer/webmeetInfra/liveKitServerAgent/scripts/hooks/preinstall.sh`
- `AssistOSExplorer/webmeetInfra/docs/specs/DS002-livekit-server-agent.md`

Changes:

1. Replace local participant JWT signing in `webmeetAgent` with an owner call.
2. Replace local RoomService calls in `webmeetAgent` with owner calls.
3. Replace local AgentDispatchService calls in `webmeetAgent` with owner calls.
4. Replace local Egress calls in `webmeetAgent` with owner calls.
5. Remove raw LiveKit API key/secret env entries from `webmeetAgent` once no code path reads them.
6. Remove TURN password env from `webmeetAgent` once it receives only non-secret ICE config.
7. Keep `WEBMEET_PUBLIC_LIVEKIT_URL` and ordinary topology defaults in profiles.
8. Add tests around the WebMeet owner client using a mocked owner service/tool.

### Phase 7: Clean Up The LiveKit AI Worker

Target files:

- `AssistOSExplorer/webmeetLivekitAiAgent/server/livekit-agent.mjs`
- `AssistOSExplorer/webmeetLivekitAiAgent/manifest.json`
- `AssistOSExplorer/webmeetLivekitAiAgent/docs/specs/DS01-ploinky-agent-invariant.md`
- `AssistOSExplorer/webmeetAgent/docs/specs/DS005-self-hosted-livekit-ai-agents.md`

Steps:

1. Verify whether the installed `@livekit/agents` runtime requires `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in the worker environment.
2. If the worker can run from dispatch-scoped or owner-issued credentials, remove the shared LiveKit key/secret from its manifest.
3. If the worker requires the raw secret, keep the current shared derivation temporarily, document it as an exception, and avoid weakening the new invariant.
4. Replace `WEBMEET_AGENT_INTERNAL_TOKEN` transcript writes with secure-wire/router-authenticated calls or an owner-issued scoped token.
5. Keep `webmeetLivekitAiAgent` optional and `no-wait`; this migration must not block normal WebMeet startup.

### Phase 8: Replace WebMeet Internal Shared Token

Target files:

- `AssistOSExplorer/webmeetAgent/server/webmeet-api.mjs`
- `AssistOSExplorer/webmeetAgent/server/webmeet-public-proxy.mjs`
- `AssistOSExplorer/webmeetLivekitAiAgent/server/livekit-agent.mjs`
- WebMeet manifests and specs

Target behavior:

1. Browser/proxy requests keep entering through declared Ploinky services.
2. The public proxy no longer needs to inject a long-lived shared token into every internal API request.
3. The AI worker persists transcript segments as a verified agent principal.
4. `webmeet-api.mjs` authorizes internal transcript writes from verified Ploinky identity and local WebMeet policy, not from possession of `WEBMEET_AGENT_INTERNAL_TOKEN`.

### Phase 9: Deprecate Legacy Shared Fields

After the known migrations are complete:

1. Keep backwards-compatible parsing for `derive: "derived-master"` and `{{derivedMasterSecret:NAME}}`.
2. Strengthen warnings for legacy fields outside the allowlist.
3. Update docs to describe legacy fields as compatibility-only.
4. Remove allowlist entries as owner-service migrations land.

## Verification Matrix

Ploinky core:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/derivedMasterEnv.test.mjs
node --test tests/unit/runtimeResourcePlanner.test.mjs
node --test tests/unit/wildcardEnv.test.mjs
node --check cli/services/masterKey.js
node --check cli/services/secretVars.js
node --check cli/services/runtimeResourcePlanner.js
git diff --check
```

DPU:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer/dpuAgent
node --test tests/*.test.mjs
```

WebMeet syntax and unit checks:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer/webmeetAgent
node --check lib/webmeetStore.mjs
node --check server/webmeet-api.mjs
node --check server/webmeet-public-proxy.mjs
node --test tests/unit/*.test.mjs
```

LiveKit AI worker:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer/webmeetLivekitAiAgent
node --check server/livekit-agent.mjs
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

LiveKit infra:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer/webmeetInfra/liveKitServerAgent
bash -n scripts/hooks/preinstall.sh
bash -n scripts/start-livekit-server-agent.sh
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

End-to-end smoke targets:

1. Start WebMeet with the default profile.
2. Join a room and receive a participant token.
3. Verify browser receives no raw LiveKit API secret.
4. Start and stop recording.
5. Attach the LiveKit AI worker and confirm a real `AGENT` participant.
6. Run scribe and confirm transcript persistence.
7. Restart Ploinky and confirm generated secrets remain deterministic.

## Risks And Unknowns

1. Converting `PLOINKY_WEBMEET_MASTER_KEY` should preserve the same value if the repo and agent identity match the current implicit derived-master defaults. Verify before migrating because this key protects existing WebMeet meeting data.

2. Converting `DPU_MASTER_KEY` should preserve the same value if the repo and agent identity match current runtime-resource expansion. Verify before migrating because this key protects DPU confidential data.

3. Soul Gateway `ENCRYPTION_KEY` and `ADMIN_SESSION_SIGNING_KEY` use custom `deriveName` labels. Converting to `generatedSecret` would rotate values unless compatibility handling is added.

4. The LiveKit Agents worker may require raw `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. If so, the final model needs either a documented exception or a deeper LiveKit worker credential design.

5. OnlyOffice may continue to need a shared signing secret because Explorer signs Document Server editor configs. Treat it as a documented shared-service exception unless a better owner boundary is designed.

6. The current shared `PLOINKY_DERIVED_MASTER_KEY` invocation model lets any enabled agent that can read its env sign invocation JWTs. The generated-secret cleanup improves manifest clarity but does not by itself provide hostile-agent isolation.

## Recommended First Implementation Slice

1. Confirm or finish Ploinky `generatedSecret` support and tests.
2. Update Ploinky specs/docs to establish the new invariant.
3. Convert only `PLOINKY_WEBMEET_MASTER_KEY` and `DPU_MASTER_KEY`, with equality checks.
4. Add warnings or at least docs for legacy shared derivation fields.
5. Draft the LiveKit owner-service DS before removing shared LiveKit credentials from WebMeet consumers.
