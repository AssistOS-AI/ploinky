# Local instruction skills

RoboTeam owns discovery, selection, and immutable execution catalogs for uppercase `SKILL.md` instruction skills. Ploinky carries the launch scope and maintains compatibility exports. Typed AgentLib skill modules and their reload lifecycle are separate.

## Launch metadata

The host command captures its original working directory before entering the Box. It resolves the directory and the selected workspace canonically and rejects a launch outside that workspace. A launch from `workspace/project` receives the following reserved environment in the Box and nested runtime:

| Variable | Value |
| --- | --- |
| `PLOINKY_SKILL_SCOPE_VERSION` | `1` |
| `PLOINKY_SKILL_SCOPE` | `<workspace>/project`, at the same path inside the Box |
| `PLOINKY_HOST_LAUNCH_CWD` | Canonical original host directory; provenance only |

These values come from the host invocation, after manifest/profile/resource environment processing. A browser directory or conversation execution directory cannot set them. The Box still enters the workspace root; `WORKSPACE_PATH` and a conversation's saved execution cwd remain separate. No filesystem grant, mount, Box identity, or same-scope reuse restriction is added.

Separate invocations may attach CLI processes with different bounded scopes in the same Box and even the same running agent container. An existing HTTP service retains its activation environment. Consumers persist the trusted scope with their conversation policy; changing a later process environment must not rewrite an existing conversation's policy. A later CLI invocation does not change the activation scope of an already-running HTTP service. There is no browser-supplied scope override in this contract.

Legacy direct `ploinky-local` or library callers without host metadata use the actual cwd when contained in the selected workspace. When the caller explicitly selects a workspace from an unrelated cwd, that selected workspace remains the legacy default. Supplied host metadata is always checked for containment; it cannot use this fallback.

Successful full-graph activation saves its scope in `.ploinky/graph-skill-scope.json` under the existing workspace mutation lock. Start, full restart, and update with restart advance this record only after health and AgentLib admission checks succeed. Plain update and ad-hoc commands leave it unchanged. A failed replacement captures and restores the preceding graph's saved scope even when the failed command was launched from another directory; the new caller's scope is never substituted for it.

The saved record contains a workspace identity and a relative launch directory, with no credentials. Rollback checks the directory again before starting the old graph. Missing legacy metadata, a removed or redirected launch directory, or invalid saved state cannot silently expand discovery to the whole workspace. A successful explicit activation migrates missing metadata. If a legacy graph has no record and a candidate fails, Ploinky restores the outer Box but refuses to guess the old graph's scope; run `ploinky start AGENT` from the intended launch directory to establish it. Malformed or cross-workspace records are rejected before mutation.

## Compatibility installation

Manifest and default installation use `.agents/.ploinky-skill-exports.json` version 1. Each skill records its owner (`manifest` or `defaults:<repository>`), source, export kind and SHA-256 ownership proof. For a symbolic link, the proof covers the link itself and its target text, not the changing contents of the source. Names alone never establish ownership.

Manifest and default installers publish relative symbolic links under .agents/skills, pointing to the selected repository skill directory. Source edits are immediately visible through these links on the host and in the workspace mount. Fresh output is recorded. Unmodified owned copies from previous versions migrate to links. An update or removal proceeds only when the current output still matches its recorded ownership proof. Unrecorded legacy output, user edits, new local files, mode changes, manually removed output, and output belonging to another exporter are preserved with diagnostics. Duplicate manifest skill names fail before export and require an explicit source choice. Independent `.claude` directories and aliases are preserved; compatibility links are created only at absent paths.

The installer serializes exports per target, stages the relative link after checking the source descriptor, and atomically publishes the ownership ledger. Compatibility copy operations retain bounded source-content verification. It moves an unchanged prior tree to `.agents/.ploinky-export-backups/`, validates it again after moving, and preserves it permanently. These backups retain edits through file descriptors opened before replacement; they are outside accepted skill roots and are not current catalog entries. Inspect them before manual cleanup. Every writer (Ploinky default and manifest installs, marketplace install/remove and Explorer's skill handlers) publishes through one transaction protocol. The export lock is still the `.agents/.ploinky-skill-exports.lock` directory, now holding an owner record (token, process and boot identity); it is released only by its owner and reclaimed only after the owner is proven dead in the same boot and PID namespace. A host-driven in-Box `ploinky update` also records the Box run the host attests, in this lock and in the `ploinky-skill-exports-config.lock` it holds in the common Git directory; a later host-driven update reclaims such a lock only when the host attests that run ended: the same Box container restarted, or it was replaced and the new container is the workspace's only one in the same engine. Any other lock from another host, Box or namespace, or a legacy lock without an owner record, is never stolen: it is reported as blocked. To recover, stop every exporter, remove the lock directory, and the next export recovers the pending journal automatically. Pending intent lives in a separate journal; the ledger publication is the commit point, so an interrupted transaction is rolled back before it and rolled forward after it, and any path edited since is preserved and the transaction quarantined. Marketplace-created links are owned by the `marketplace` owner only when marketplace created them; marketplace removal leaves other output alone. Backups are tagged by transaction and retained (their size is reported); only unpublished staging of a proven-dead writer is collected automatically.

During ploinky update, a successfully read repository determines available skills. Missing selected skills are removed from ploinky-skills-manifest.json and their unchanged owned links are retired, including dangling links. Repository entries and unrelated manifest fields remain intact; removing the final skill leaves an empty selection. A missing skills directory in an existing Git repository represents an empty source. Unreadable or invalid sources fail without pruning their selections. Strict standalone manifest installation still reports missing selections rather than rewriting the manifest. Manifest pruning checks for concurrent edits and publishes its JSON replacement atomically.

Automatic local refresh reads original working files at RoboTeam's execution boundary. It does not require running an installer, `ploinky update`, a Git commit, or a session reset.

Workspace repository recommendations retain repositories containing skill folders without SKILL.md. Each missing descriptor produces a warning shown in Explorer and RoboTeam; only available skills can be selected. Existing descriptors still require valid names and descriptions.

Automatic workspace discovery excludes repositories containing AchillesAgentLib typed descriptors (`oskill.md`, `cskill.md`, `dcgskill.md`, or `tskill.md`) under `skills/`, including nested directories and repositories that also contain SKILL.md skills. These are not incomplete instruction-skill repositories and do not produce missing-SKILL.md recommendations.

## Shared repository installation

Repository discovery, Marketplace, agent resolution and link-install prefer workspace Git checkouts, including a unique checkout matching the registered Git origin, before `.ploinky/repos`. Discovery never pulls a checkout. `GET /api/marketplace/list-repos` returns `repositories` with `name`, `source`, `origin`, `kind` and discovery warnings. Typed AchillesAgentLib repositories are excluded from Anthropic skill recommendations.

`POST /api/marketplace/install` accepts a mixed batch:

```json
{"repos":[{"repoName":"AdvancedLanguageAgent","destination":"/workspace/project/dependencies/ALA"}],"skillRepos":[{"repoName":"DocumentationSkills","destination":"/workspace/project","skills":["review-specs"]}]}
```

A repo destination is the symlink path. Optional `sourcePath` selects a relative directory inside that repository. A skill-repository destination is the project directory; install prepares `.agents/skills`, links each selected skill folder there, and prepares `.claude` as a relative symlink to `.agents`. An empty skills array still prepares the layout. Sources must already exist in a discovered repository inside the workspace. Destinations must remain inside the workspace, including resolved parent directories.

Install is additive and idempotent. It returns `results` and `conflicts`; correct links are `present`, new links are `installed`, and other existing entries are `conflict`. It never overwrites files or removes omitted selections. `POST /api/marketplace/remove` accepts an array of absolute destination paths. It removes only symlinks, including dangling links, reports missing paths as `absent`, and preserves ordinary files and directories as conflicts. Removal does not touch source files. Consumers explicitly remove their own obsolete links before installing a changed selection.

Agents reuse `Agent/client/RepositoryClient.mjs` for `listRepositories`, `prepareRepository`, `install` and `remove`. Requests use the generated Router descriptor and path/body-bound signed agent assertions. Browser mutations retain administrator and CSRF checks. Mutation routes take the workspace mutation lease. Link-install and managed skill exports reuse the link publication primitive, preserving their existing staging lifecycle.

Staged link-install exports calculate their relative targets from the final `/Agent/linked` location, not the staging directory. For example, `/Agent/linked/Library -> ../../workspace/Library` resolves to the existing workspace mount. The internal `linkParent` option controls both creation and idempotence checks; it is not an endpoint parameter.
