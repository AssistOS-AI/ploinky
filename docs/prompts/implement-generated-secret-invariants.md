# Implementation Prompt: Generated Secret Invariants

Use this prompt from `/Users/danielsava/work/file-parser`.

## Task

Implement the generated-secret invariant and migration plan documented at:

`/Users/danielsava/work/file-parser/ploinky/docs/plans/generated-secret-invariants-and-migration-plan.md`

The goal is to make `generatedSecret: true` the preferred manifest model for per-agent generated secrets, migrate the safe per-agent secrets, and preserve existing shared-service semantics until owner-mediated APIs are designed and implemented.

## Required Reading

1. Read `/Users/danielsava/work/file-parser/CLAUDE.md`.
2. Read `/Users/danielsava/work/file-parser/ploinky/CLAUDE.md`.
3. Read the plan document named above.
4. Before touching AssistOSExplorer agents, read `/Users/danielsava/work/file-parser/AssistOSExplorer/CLAUDE.md`.
5. Before touching WebMeet, read:
   - `/Users/danielsava/work/file-parser/AssistOSExplorer/webmeetAgent/CLAUDE.md`
   - `/Users/danielsava/work/file-parser/AssistOSExplorer/webmeetAgent/docs/specs/DS006-ploinky-runtime-invariants.md`
   - `/Users/danielsava/work/file-parser/AssistOSExplorer/webmeetInfra/docs/specs/DS002-livekit-server-agent.md`
   - `/Users/danielsava/work/file-parser/AssistOSExplorer/webmeetLivekitAiAgent/docs/specs/DS01-ploinky-agent-invariant.md`

## Operating Rules

- Do not revert unrelated user changes.
- Inspect `git status` in every subrepo before editing.
- Keep changes scoped to the generated-secret migration.
- Do not add AI/tool attribution to commits, docs metadata, comments, changelogs, release notes, or PR text.
- Do not print, log, or persist secret values.
- Preserve backwards compatibility for existing `derive: "derived-master"` shared credentials.
- Do not remove WebMeet LiveKit/TURN/OnlyOffice/Soul Gateway shared derivations until the relevant owner-mediated service boundary exists.

## New Invariants To Enforce

1. `PLOINKY_MASTER_KEY` is the workspace root secret and must never be injected into agents.
2. `generatedSecret: true` is the preferred manifest spelling for a workspace-generated secret owned by the current agent.
3. `generatedSecret` derives from current repo name, current agent name, and env name.
4. `generatedSecret` does not accept `deriveRepoName`, `deriveAgentName`, `deriveName`, `deriveBytes`, or encoding knobs.
5. `generatedSecret` ignores same-named process env, `.ploinky/.secrets`, `.env`, and manifest defaults.
6. `{{generatedSecret:NAME}}` is the preferred runtime-resource template for per-agent generated secrets.
7. New generated secrets are 32 bytes before encoding.
8. `derive: "derived-master"` and `{{derivedMasterSecret:NAME}}` remain compatibility paths for explicit shared derivations.
9. Cross-agent raw shared credentials are legacy exceptions and must be documented with a migration path.
10. Service-owned credentials should live with the owning agent; consumers should call owner operations instead of receiving raw service secrets.

## Implementation Slice

Complete this first slice before attempting the larger LiveKit owner-service migration.

### 1. Verify Or Finish Ploinky Core Support

Target files:

- `/Users/danielsava/work/file-parser/ploinky/cli/services/masterKey.js`
- `/Users/danielsava/work/file-parser/ploinky/cli/services/secretVars.js`
- `/Users/danielsava/work/file-parser/ploinky/cli/services/runtimeResourcePlanner.js`

Required behavior:

- `generatedSecret: true` works in array-form env entries.
- `generatedSecret: true` works in object-form env entries.
- Generated env secrets derive from `repoName`, `agentName`, and env name.
- Generated env secrets ignore operator-supplied values.
- Required generated env entries do not require profile defaults.
- `{{generatedSecret:NAME}}` works in runtime resources.
- `derive: "derived-master"` behavior remains unchanged.

### 2. Add Or Update Ploinky Tests

Target tests:

- `/Users/danielsava/work/file-parser/ploinky/tests/unit/derivedMasterEnv.test.mjs`
- `/Users/danielsava/work/file-parser/ploinky/tests/unit/runtimeResourcePlanner.test.mjs`

Test at least:

- `generatedSecret` equals `deriveAgentSecret({ repoName, agentName, name })`.
- Two different agent names produce different `generatedSecret` values for the same env name.
- Operator values do not override generated secrets.
- Object-form env works.
- Required generated secrets pass profile completeness checks.
- `{{generatedSecret:NAME}}` resolves and ignores persistent secret values.

### 3. Update Ploinky Specs And Docs

Update:

- `/Users/danielsava/work/file-parser/ploinky/docs/specs/DS003-agent-manifest-and-registry.md`
- `/Users/danielsava/work/file-parser/ploinky/docs/specs/DS008-secrets-skills-and-llm-assistance.md`
- `/Users/danielsava/work/file-parser/ploinky/docs/specs/DS011-security-model.md`
- `/Users/danielsava/work/file-parser/ploinky/docs/spec-agent.html`
- `/Users/danielsava/work/file-parser/ploinky/docs/runtime.html`
- `/Users/danielsava/work/file-parser/ploinky/docs/operations.html`
- `/Users/danielsava/work/file-parser/ploinky/docs/architecture.html`

Docs must say:

- Use `generatedSecret: true` for per-agent generated env secrets.
- Use `{{generatedSecret:NAME}}` for per-agent generated runtime-resource secrets.
- Keep `derive: "derived-master"` and `{{derivedMasterSecret:NAME}}` as compatibility/shared-identity paths.
- Cross-agent shared raw credentials should migrate toward owner-mediated operations.

### 4. Migrate Safe Per-Agent Secrets

Migrate only these safe entries:

1. In `/Users/danielsava/work/file-parser/AssistOSExplorer/webmeetAgent/manifest.json`, convert every `PLOINKY_WEBMEET_MASTER_KEY` profile entry to:

```json
{
  "name": "PLOINKY_WEBMEET_MASTER_KEY",
  "required": false,
  "generatedSecret": true
}
```

2. In `/Users/danielsava/work/file-parser/AssistOSExplorer/dpuAgent/manifest.json`, convert:

```json
"DPU_MASTER_KEY": "{{derivedMasterSecret:DPU_MASTER_KEY}}"
```

to:

```json
"DPU_MASTER_KEY": "{{generatedSecret:DPU_MASTER_KEY}}"
```

3. Update DPU docs that mention the old template:

- `/Users/danielsava/work/file-parser/AssistOSExplorer/dpuAgent/README.md`
- `/Users/danielsava/work/file-parser/AssistOSExplorer/dpuAgent/docs/configuration.html`
- relevant DPU runtime invariant spec files if they mention `{{derivedMasterSecret:DPU_MASTER_KEY}}`

Before and after these manifest edits, prove the new value equals the old implicit current-agent derived value for the same repo/agent/name. Do not print the secret values; compare booleans or hashes only.

### 5. Do Not Migrate These Yet

Leave these as explicit shared derivations for now:

- WebMeet LiveKit API key/secret.
- WebMeet TURN password.
- WebMeet internal token.
- OnlyOffice JWT shared signing secret.
- Embedded Soul Gateway API key.
- Soul Gateway agent-owned custom labels unless a rotation/compatibility decision is made.

Update docs/specs to mark these as legacy shared exceptions with migration paths, not as the desired general pattern.

### 6. Add Legacy Warning Support If Practical

If there is a clear local manifest-validation path, add non-fatal warnings for new legacy shared derivation fields outside an allowlist.

If that is too broad for the first slice, document the warning plan and leave behavior unchanged. Do not break startup.

## Larger Follow-Up Design

After the first slice is complete, draft or update specs for the LiveKit owner-service migration:

- `liveKitServerAgent` should own raw LiveKit API key, LiveKit API secret, and TURN password.
- `webmeetAgent` should ask the owner to mint participant tokens, perform RoomService operations, create/delete/list AI dispatches, and start/stop Egress.
- Browser responses should receive only short-lived participant tokens, public LiveKit URLs, and ICE config.
- `webmeetLivekitAiAgent` should stop receiving raw LiveKit credentials if the LiveKit Agents framework permits it.
- `WEBMEET_AGENT_INTERNAL_TOKEN` should be replaced with router/secure-wire identity or scoped owner-issued invocation.

Do not implement this larger migration until the DS boundary is written and the current LiveKit worker credential requirement is verified.

## Verification Commands

Run from Ploinky:

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

Run DPU tests if DPU files changed:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer/dpuAgent
node --test tests/*.test.mjs
```

Run WebMeet syntax checks if WebMeet files changed:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer/webmeetAgent
node --check lib/webmeetStore.mjs
node --check server/webmeet-api.mjs
node --check server/webmeet-public-proxy.mjs
node --test tests/unit/*.test.mjs
```

Run JSON checks for touched manifests:

```bash
node -e "JSON.parse(require('fs').readFileSync('/Users/danielsava/work/file-parser/AssistOSExplorer/webmeetAgent/manifest.json','utf8')); console.log('webmeet manifest ok')"
node -e "JSON.parse(require('fs').readFileSync('/Users/danielsava/work/file-parser/AssistOSExplorer/dpuAgent/manifest.json','utf8')); console.log('dpu manifest ok')"
```

## Expected Final Report

Report:

- The generated-secret behavior implemented or verified.
- Every manifest/doc file changed.
- Which shared derivations were intentionally left unchanged.
- Test commands run and their pass/fail result.
- Any blocked checks, especially if unrelated pre-existing changes prevent a broader test from passing.
