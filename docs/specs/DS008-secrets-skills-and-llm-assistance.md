---
id: DS008
title: Secrets, Skills, and LLM Assistance
status: implemented
owner: ploinky-team
summary: Defines secret resolution, wildcard exposure rules, default-skills installation, workspace-copied skill boundaries, and the LLM helper inputs.
---

# DS008 Secrets, Skills, and LLM Assistance

## Introduction

Ploinky’s operator tooling depends on a shared secret-resolution model and on explicit boundaries around copied skills and LLM helper context. This document defines those support-layer contracts.

## Core Content

Secret resolution must prefer process environment variables, then `.ploinky/.secrets`, then the nearest `.env` file found by walking upward from the current working directory. This precedence model applies across runtime resource templating, auth configuration, dependency helpers, and LLM settings discovery. Manifest env entries with `generatedSecret: true` are exceptions: they derive from `PLOINKY_DERIVED_MASTER_KEY` and ignore operator variables with the same name so Ploinky-owned and agent-owned generated secrets cannot drift away from the workspace derivation invariant. The narrow exceptions are generated entries with `explicitOverride: true`, which may accept an explicit operator value directly, and entries with `explicitOverrideRequires`, which may accept an explicit operator value only when all listed companion variables are also explicitly present. Ploinky injects `PLOINKY_ENV_SOURCE_<ENV_NAME>` as `generated` or `explicit` for generated env entries that resolve to a value. `generatedSecret: true` is the manifest form for a generated secret owned by the current agent and derives from the current repo, current agent, and env name. Shared service credentials that must be identical across agents use `sharedGeneratedSecret: true` and derive from the source env name, not custom repo/agent/name fields.

Required manifest env entries may deliberately omit a profile default when no
safe deployment-independent value exists. Such an entry is an explicit
operator/provider prerequisite, not an implicit empty value: profile readiness
and runtime launch resolve encrypted `ploinky var` state, provider output,
process env, and `.env`, then fail with the exact missing name if none supplies
it. No URL, hostname, public IP, realm, port, or Origin is inferred. Safe
portable values should still use `default` or `value`; secrets and
`generatedSecret: true` retain their existing resolution rules.

Startup config providers (DS015) are another writer for the encrypted workspace var store, but not another secret-ownership model. Provider subprocesses return an allowlisted JSON patch, and Ploinky validates and persists accepted values through the same encrypted `.ploinky/.secrets` store used by `ploinky var`. Provider output may include provider-owned external credentials when declared sensitive, but it must not overwrite `generatedSecret` or `sharedGeneratedSecret` names owned by any enabled graph node. Provider metadata under `.ploinky/config-providers/` is redacted and must not contain raw values.

Workspace variable commands must preserve explicit operator control. `var` writes workspace-local values, `vars` lists known names, `echo` resolves aliases, and `expose` maps values into agent environments. Wildcard expansion is allowed, but the all-match `*` pattern must exclude variable names containing `API_KEY` or `APIKEY`. Sensitive values therefore require explicit manifest or operator intent rather than accidental blanket inclusion.

`default-skills` copies skill directories from a skills repository into `.agents/skills/`. Existing directories with names supplied by that source repository must be removed and copied again so deleted upstream files do not remain locally, while unrelated skill directories already present under `.agents/skills/` or legacy `.claude/skills/` may be preserved. Legacy `.claude/skills/` skills that are not owned by the source repository may be migrated into `.agents/skills/` before Claude compatibility symlinks are created. New workspaces should get `.claude` as a symlink to `.agents`; when a non-empty existing `.claude` directory must be preserved, `.claude/skills` must instead point to `../.agents/skills`. The `.claude` compatibility path and each source-owned skill directory under `.agents/skills/` must be added to `.gitignore` through the managed marker block; `.agents/` itself must not be gitignored. The copied skills are a workspace convenience and must not be documented as runtime product pages or runtime DS files for the host project.

Managed repository update flows must refresh `AchillesCopilotBasicSkills` into eligible installed `.ploinky/repos/` entries using the same merge, `.claude` compatibility, and managed `.gitignore` behavior as `default-skills`. The managed refresh skips the `AchillesCopilotBasicSkills` source repository and repositories classified as `skills`; repositories classified as `agents`, `mixed`, or `unknown` are eligible. A failure to refresh default skills in an eligible managed repository is a command failure through the strict managed-repository update path. This managed refresh does not replace the explicit `ploinky-skills-manifest.json` behavior for workspace folders.

When the all-repository `update` flow refreshes workspace folders, each folder that contains `ploinky-skills-manifest.json` must refresh its skills from the manifest sources. The manifest is an array of repository objects shaped as `{ "url": "...", "name": "...", "branch": null, "skills": ["..."] }`; legacy string-array manifests are invalid. At each `update` run, Ploinky must clone missing manifest repositories into `.ploinky/repos/`, pull existing cached repositories there, and reconstruct `.agents/skills/` strictly from the selected `skills` lists. Duplicate skill names are resolved by manifest order so the last listed source wins. A failure to clone or update a manifest skill source, copy selected skills, or update `.gitignore` is a command failure, not just an informational warning.

The Ploinky repository does not own a local skill catalog. Skills supplied by an external agent environment and skills copied into an operator workspace under `.agents/skills/` remain tooling outside the Ploinky runtime-module boundary. Host-project documentation and the DS set must stay focused on Ploinky itself rather than creating pages or DS files for those external or workspace-copied skills.

`ploinky-shell` and invalid-command fallback logic depend on Achilles LLM tooling. The helper must load model-key definitions from Achilles config, inspect available API keys, and include `docs/ploinky-overview.md` as its system context. That file is therefore part of the implemented command-suggestion surface and must be updated whenever command semantics or operator guidance changes.

## Decisions & Questions

### Question #1: Why are external or workspace-copied skills excluded from host-project DS files?

Response:
The user-facing runtime is Ploinky, not an external or operator-managed skill catalog. Keeping those skills outside the host documentation preserves the host/runtime boundary while `default-skills` and workspace manifests continue to manage copied skills as operator tooling.

### Question #2: Why is `docs/ploinky-overview.md` treated as part of the runtime contract?

Response:
The LLM helper in `cli/commands/llmSystemCommands.js` reads that file directly to shape command suggestions. Once a documentation file becomes executable context for a runtime feature, it is no longer optional prose; it is part of the operator-visible behavior and must stay synchronized with the CLI.

### Question #3: Why does skill refresh have different merge rules for `default-skills` and `update`?

Response:
`default-skills` treats skill names from the selected source repository as owned, so it removes and replaces only those directories to preserve other operator-managed skill folders. `update`, by design, treats `ploinky-skills-manifest.json` as the explicit skill set for that workspace and therefore reconstructs `.agents/skills/` from scratch each run.

### Question #4: Why do startup config providers persist through `.ploinky/.secrets` even for non-sensitive public values?

Response:
The existing manifest env resolver already consumes workspace vars from the encrypted store before applying profile defaults. Using the same store gives provider output one consistent precedence path and avoids a second public-topology state file that every runtime manager would need to understand. Redacted metadata gives operators provenance without turning public URLs or mixed config payloads into an unencrypted diagnostic channel.

## Conclusion

Secret resolution, skill installation, and LLM assistance are support layers, but they still define observable behavior. Ploinky must keep those layers explicit, predictable, and clearly bounded from the host-project runtime documentation surface.
