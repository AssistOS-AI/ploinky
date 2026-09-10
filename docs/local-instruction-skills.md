# Local instruction skills

RoboTeam owns discovery, selection, and immutable execution catalogs for uppercase `SKILL.md` instruction skills. Ploinky carries the launch scope and maintains compatibility exports. Typed AgentLib skill modules and their reload lifecycle are separate.

## Launch metadata

The host command captures its original working directory before entering the Box. It resolves the directory and the selected workspace canonically and rejects a launch outside that workspace. A launch from `workspace/project` receives the following reserved environment in the Box and nested runtime:

| Variable | Value |
| --- | --- |
| `PLOINKY_SKILL_SCOPE_VERSION` | `1` |
| `PLOINKY_SKILL_SCOPE` | `/workspace/project` |
| `PLOINKY_HOST_LAUNCH_CWD` | Canonical original host directory; provenance only |

These values come from the host invocation, after manifest/profile/resource environment processing. A browser directory or conversation execution directory cannot set them. The Box still enters `/workspace`; `WORKSPACE_PATH` and a conversation's saved execution cwd remain separate. No filesystem grant, mount, Box identity, or same-scope reuse restriction is added.

Separate invocations may attach CLI processes with different bounded scopes in the same Box and even the same running agent container. An existing HTTP service retains its activation environment. Consumers persist the trusted scope with their conversation policy; changing a later process environment must not rewrite an existing conversation's policy. A later CLI invocation does not change the activation scope of an already-running HTTP service. There is no browser-supplied scope override in this contract.

Legacy direct `ploinky-local` or library callers without host metadata use the actual cwd when contained in the selected workspace. When the caller explicitly selects a workspace from an unrelated cwd, that selected workspace remains the legacy default. Supplied host metadata is always checked for containment; it cannot use this fallback.

Successful full-graph activation saves its scope in `.ploinky/graph-skill-scope.json` under the existing workspace mutation lock. Start, full restart, and update with restart advance this record only after health and AgentLib admission checks succeed. Plain update and ad-hoc commands leave it unchanged. A failed replacement captures and restores the preceding graph's saved scope even when the failed command was launched from another directory; the new caller's scope is never substituted for it.

The saved record contains a workspace identity and a relative launch directory, with no credentials. Rollback checks the directory again before starting the old graph. Missing legacy metadata, a removed or redirected launch directory, or invalid saved state cannot silently expand discovery to `/workspace`. A successful explicit activation migrates missing metadata. If a legacy graph has no record and a candidate fails, Ploinky restores the outer Box but refuses to guess the old graph's scope; run `ploinky start AGENT` from the intended launch directory to establish it. Malformed or cross-workspace records are rejected before mutation.

## Compatibility installation

Manifest and default installation use `.agents/.ploinky-skill-exports.json` version 1. Each skill records its owner (`manifest` or `defaults:<repository>`), source, and SHA-256 of the last exported relative paths, entry types, bytes, and modes. Names alone never establish ownership.

Fresh output is recorded. An update or removal proceeds only when the entire current output still matches the recorded export. Unrecorded legacy output, user edits, new local files, mode changes, manually removed output, and output belonging to another exporter are preserved with diagnostics. Duplicate manifest skill names fail before export and require an explicit source choice. Independent `.claude` directories and aliases are preserved; compatibility links are created only at absent paths.

The installer serializes exports per target, stages and verifies source content with bounded retries, and atomically publishes the ownership ledger. It moves an unchanged prior tree to `.agents/.ploinky-export-backups/`, validates it again after moving, and preserves it permanently. These backups retain edits through file descriptors opened before replacement; they are outside accepted skill roots and are not current catalog entries. Inspect them before manual cleanup. An interrupted export lock is left for inspection rather than automatically stolen. An interrupted ledger write leaves conservative ownership mismatches for the next attempt.

Automatic local refresh reads original working files at RoboTeam's execution boundary. It does not require running an installer, `ploinky update`, a Git commit, or a session reset.
