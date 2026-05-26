# Implementation Prompt: Generated Secret Invariants

Use this prompt from `/Users/danielsava/work/file-parser`.

## Task

Implement or verify the generated-secret invariant and migration plan documented at:

`/Users/danielsava/work/file-parser/ploinky/docs/plans/generated-secret-invariants-and-migration-plan.md`

The goal is to remove the old manifest-level derived-secret convention and make `generatedSecret: true` the only supported manifest model for deterministic generated env secrets.

## Required Reading

1. Read `/Users/danielsava/work/file-parser/CLAUDE.md`.
2. Read `/Users/danielsava/work/file-parser/ploinky/CLAUDE.md`.
3. Read the plan document named above.
4. Before touching AssistOSExplorer agents, read `/Users/danielsava/work/file-parser/AssistOSExplorer/CLAUDE.md`.
5. Before touching Soul Gateway, read `/Users/danielsava/work/file-parser/proxies/soul-gateway/CLAUDE.md`.

## Operating Rules

- Do not revert unrelated user changes.
- Inspect `git status` in every subrepo before editing.
- Keep changes scoped to generated-secret contracts, manifest migrations, and matching docs/tests.
- Do not add AI/tool attribution to commits, docs metadata, comments, changelogs, release notes, or PR text.
- Do not print, log, or persist secret values.
- Do not preserve the removed manifest convention.

## Invariants To Enforce

1. `PLOINKY_MASTER_KEY` is the workspace root secret and must never be injected into agents.
2. `PLOINKY_DERIVED_MASTER_KEY` remains the runtime key for invocation JWTs and generated-secret derivation.
3. `generatedSecret: true` is the only supported manifest spelling for deterministic generated env secrets.
4. Agent-scoped generated secrets derive from current repo name, current agent name, and env name.
5. Workspace-scoped generated secrets use `sharedGeneratedSecret: true` and derive from the source env name.
6. Generated secrets do not accept custom repo, agent, name, byte-length, or encoding knobs.
7. Generated secrets ignore same-named process env, `.ploinky/.secrets`, `.env`, and manifest defaults unless `explicitOverride: true` is set or `explicitOverrideRequires` is satisfied.
8. `{{generatedSecret:NAME}}` is the only supported runtime-resource generated-secret template.
9. The old runtime-resource generated-secret template must fail loudly.
10. Cross-agent raw shared credentials should migrate toward owner-mediated operations, but current shared credentials may use workspace-scoped generated secrets until that boundary exists.

## Implementation Checklist

1. In Ploinky core, add or verify workspace-scoped generated-secret derivation.
2. Reject manifest env entries containing removed derived-secret fields.
3. Resolve `sharedGeneratedSecret: true` through source env name (`varName` if present, otherwise `name`).
4. Keep `explicitOverride: true` and `explicitOverrideRequires` for external overrides. Soul Gateway consumers use `explicitOverride: true` so a user-supplied `SOUL_GATEWAY_API_KEY` can use the `LLMConfig.json` default gateway URL when no env URL is present.
5. Reject the removed runtime-resource template and keep `{{generatedSecret:NAME}}`.
6. Convert AssistOSExplorer and Soul Gateway manifests:
   - per-agent secrets: `generatedSecret: true`
   - shared credentials: `sharedGeneratedSecret: true`
   - OnlyOffice `JWT_SECRET`: `varName: "ONLYOFFICE_JWT_SECRET"` plus workspace scope
7. Update Ploinky, AssistOSExplorer, Soul Gateway docs/specs, and runtime-invariants skills.
8. Update tests so they assert the old convention is rejected, not preserved.
9. Run verification commands and a final search for removed manifest keys.

## Verification Commands

Run from Ploinky:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/generatedSecretEnv.test.mjs
node --test tests/unit/runtimeResourcePlanner.test.mjs
node --test tests/unit/wildcardEnv.test.mjs
node --test tests/unit/profileSystem.test.mjs
node --check cli/services/masterKey.js
node --check cli/services/secretVars.js
node --check cli/services/runtimeResourcePlanner.js
git diff --check
```

Run manifest parsing:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer
node -e 'const fs=require("fs"); for (const file of ["explorer/manifest.json","gitAgent/manifest.json","llmAssistant/manifest.json","onlyOffice/manifest.json","webassist/manifest.json","webmeetAgent/manifest.json","webmeetInfra/liveKitServerAgent/manifest.json","webmeetLivekitAiAgent/manifest.json"]) JSON.parse(fs.readFileSync(file,"utf8"));'
cd /Users/danielsava/work/file-parser/proxies/soul-gateway
node -e 'JSON.parse(require("fs").readFileSync("manifest.json","utf8"))'
```
