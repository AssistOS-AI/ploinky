# Implementation Plan: Direct-Mounted achillesAgentLib Single Source

Status: proposed implementation plan (not implemented). Date: 2026-08-25.

This is the direct-mount design. It is an alternative to `proposals/agentlib-single-source.md`, which materializes copies. The existing proposal remains unchanged.

This plan is intentionally a clean break. It provides no install-tree fallback, legacy Box link, old cache migration, deprecated environment alias, or transition period. Existing managed caches may be discarded after exact workspace ownership is proven; user-owned local checkouts are never deleted or mutated.

## 1. Outcome and acceptance contract

For one resolved Ploinky workspace:

1. If `<workspace>/achillesAgentLib` exists, it is the selected source. Ploinky never mutates it.
2. If that exact path is absent, Ploinky obtains a managed checkout from the canonical GitHub repository under `<workspace>/.ploinky/agentlib/`.
3. Ploinky core, the outer Box, and every agent runtime read achillesAgentLib from that one selected directory. No runtime receives a copied package tree.
4. The public `ploinky` path and direct host `ploinky-local` path use the same selector, validation rules, revision policy, and attestation format.
5. An invalid present local checkout is a hard error. Ploinky must not silently fall back to GitHub when the local path signals developer intent.
6. The source is mounted read-only in every Ploinky-managed mount namespace, including read-only shadows for aliases exposed by a broader writable workspace bind. A host developer can still edit a local checkout; a coherent activation requires `ploinky restart`.
7. Readiness proves the selected source identity and content fingerprint at the core and agent boundaries. A descriptor or container label alone is not proof that the expected files were loaded.

“Same source” means the same physical host directory/inode generation, exposed under a stable runtime path where a mount namespace exists. It does not mean several directories that happened to contain equal bytes when copied.

## 2. Current seams this plan changes

The implementation must replace all current independent AgentLib paths together:

| Surface | Current behavior | Direct-mount target behavior |
| --- | --- | --- |
| Public `ploinky` | `bin/ploinky` delegates to the Box supervisor; the Box installs its own locked AgentLib checkout | The host supervisor selects AgentLib before Box reconciliation and bind-mounts that source into the Box |
| Direct `ploinky-local` | Shell gate and core imports require `<ploinky>/node_modules/achillesAgentLib` | A bootstrap selects the workspace source before importing core code and sets an explicit runtime contract |
| Box core | Resolves bare imports through `/opt/ploinky/node_modules/achillesAgentLib` | Every framework import resolves explicitly from the direct mount at `/opt/ploinky-agentlib`; the old Box package path is forbidden |
| Agent dependency caches | npm installs an independent Git dependency into every cache | npm does not install AgentLib; each cache contains only a symlink to the direct runtime source |
| Docker/Podman agents | Receive only prepared `node_modules` copies | Also receive the selected source as an exact read-only bind at `/opt/ploinky-agentlib` |
| bwrap agents | Receive prepared `node_modules` and the Ploinky `Agent/` runtime | Also receive an exact `--ro-bind` of the selected source at `/opt/ploinky-agentlib` |
| seatbelt agents | See host paths under a generated read policy | Their cache symlink targets the selected host path; the profile grants read and denies write for that exact source |
| Update | Several mechanisms pull or reinstall separate AgentLib copies | Only the source owner advances a managed generation; all consumers restart against the new selection |

The outer Box host lock and the inner workspace lifecycle lock are separate today. The new source lifecycle must preserve that ownership split rather than creating a lock that both sides try to mutate.

## 3. Target data flow

```text
resolved workspace root
        |
        +-- <workspace>/achillesAgentLib exists and validates
        |        -> selected local source (never mutated)
        |
        `-- absent
                 -> managed GitHub generation under .ploinky/agentlib/
                              |
                              v
                   one AgentLibSelection
                   { sourceDir, mode, sourceId,
                     commit, fingerprint, policy }
                              |
               +--------------+----------------+
               |                               |
       public `ploinky`                  direct `ploinky-local`
               |                               |
       host ro-bind into Box            core imports host source
       /opt/ploinky-agentlib             through explicit resolver
               |                               |
       in-Box core + nested agents       host/container agents
               |                               |
               +---- agent cache symlink ------+
                    achillesAgentLib -> selected runtime path
```

The stable path inside every mount namespace is:

```text
/opt/ploinky-agentlib
```

The stable package-resolution link in a prepared dependency cache is:

```text
<cache>/node_modules/achillesAgentLib -> /opt/ploinky-agentlib
```

Seatbelt is the one exception because it does not create a mount namespace. Its cache link targets the canonical selected host path instead.

## 4. Source-selection contract

### 4.1 Shared modules

Add a dependency-free top-level module group so both Box code and core code can use it without importing either lifecycle:

```text
agentlib/
  contract.mjs       constants, schema validation, errors
  source.mjs         pure selection and source validation
  materialize.mjs    explicit Git/network operations for managed sources
  fingerprint.mjs    deterministic content hashing and drift checks
  runtime.mjs        runtime path/subpath resolution and import attestation
```

The pure selector accepts an explicit `workspaceRoot`; it must not read mutable module-global workspace state. Materialization is a separate explicit call so importing a module can never clone or fetch.

### 4.2 Workspace candidate

The only implicit local candidate is exactly:

```text
<resolved-workspace-root>/achillesAgentLib
```

Do not search ancestors after the workspace has been resolved, do not search recursively, and do not accept a second capitalization variant. The public supervisor already resolves the initial launch directory, then stabilizes subsequent launches on the nearest `.ploinky` ancestor. Direct `ploinky-local` must use that same root algorithm and export the result as `PLOINKY_WORKSPACE_ROOT` before importing core modules.

Validation rules:

- Use `lstat`, reject a symlink as the candidate root, and require a real directory.
- Re-resolve and compare device/inode around validation to reject path substitution.
- Require readable `package.json` with package name `ploinky-agent-lib`.
- Validate the entry points Ploinky actually uses, including `LLMAgents`, `utils/LLMClient.mjs`, and the JWT modules.
- Reject internal symlinks that escape the selected source tree.
- If the candidate exists but fails any check, stop with a source-validation error. Do not clone as a fallback.
- If a branch policy was explicitly requested, validate the local checkout against it without modifying the checkout. `--branch-fallback fail` must remain fail-closed.

### 4.3 Managed source

When the local candidate is absent, materialize a managed source below:

```text
<workspace>/.ploinky/agentlib/
  mirror.git/
  generations/
    <commit>-<fingerprint-prefix>/
  active.json
  transaction.json        # present only during a staged transition
```

Use the `achillesAgentLib` entry in `ploinky-box/dependencies.lock.json` as the one canonical remote URL and default immutable commit. `globalDeps/package.json` and `updateService.js` must no longer define competing AgentLib URLs.

Managed materialization rules:

- Clone/fetch a private bare mirror under the source lock, then create a detached, read-only-to-runtimes working generation for the selected commit.
- Reuse an already validated generation without network access.
- A normal first start with no explicit branch selects the lock commit.
- A requested branch resolves to one exact remote commit. A later ordinary start reuses it; `ploinky update` is what advances a moving branch.
- If a requested branch is absent, `--branch-fallback default` selects the lock commit and `--branch-fallback fail` aborts.
- Never mutate the generation currently mounted by running consumers.
- Keep the previous managed generation until the Box/core/agent transaction succeeds, so rollback can recreate the old mount contract.
- Prune a generation only after it is absent from `active.json`, Box mounts/labels, and the agent registry. Ambiguous ownership means preserve it.

An implementation may use a detached clone rather than a Git worktree for each generation if that proves more portable. The invariant is that updates stage a new source directory and never modify the mounted old generation in place.

### 4.4 Selection and fingerprint

The in-memory `AgentLibSelection` and persisted `active.json` should carry at least:

```json
{
  "schemaVersion": 1,
  "workspacePathHash": "...",
  "mode": "local|managed",
  "sourceRelativePath": "achillesAgentLib|.ploinky/agentlib/generations/...",
  "sourceId": {
    "device": "...",
    "inode": "..."
  },
  "remoteUrl": "... or null",
  "requestedRef": "... or null",
  "resolvedCommit": "40-hex-sha or null",
  "dirty": false,
  "contentFingerprint": "64-hex-sha256",
  "selectedAt": "ISO-8601 timestamp"
}
```

Persist workspace-relative paths; always re-derive, canonicalize, and revalidate the absolute path before use. Never trust `active.json` as authorization for a bind mount.

The content fingerprint is a deterministic hash over sorted runtime-source entries: relative path, entry type, relevant mode, symlink target, and regular-file bytes. Exclude Git administration data. Git commit/dirty metadata is useful diagnostic context but is not a substitute for a content hash.

Fingerprinting must capture source device/inode and validate the source before and after traversal. A change during hashing fails with a retryable `PLOINKY_AGENTLIB_SOURCE_CHANGED` error.

## 5. Ownership and locking

There are two execution modes with one source writer in each:

| Mode | Selection/materialization owner | Consumer behavior |
| --- | --- | --- |
| Public `ploinky` with Box | Outer host Box supervisor while holding the existing workspace Box mutation lock | Box entrypoint and in-Box `ploinky-local` validate the passed selection only; they never clone, fetch, or change `active.json` |
| Direct host `ploinky-local` | Host launcher/source manager under a workspace AgentLib lock | Core and agent managers consume the resulting environment contract |

Lock ordering must be fixed:

1. Outer Box lock, when an outer operation exists.
2. Workspace AgentLib source lock.
3. Inner/core lifecycle lock, only after the source lock has been released unless a short atomic selection commit requires both.

The outer supervisor may hold its Box lock while it invokes the inner lifecycle, as it does today, but the in-Box process must never try to acquire the AgentLib source lock. This prevents an outer/inner lock inversion.

Local source edits are outside Ploinky's locks. The lifecycle detects them through fingerprint drift; it cannot prevent the workspace owner from editing files.

## 6. Runtime contract

### 6.1 Environment

Set and validate these reserved variables before any AgentLib-dependent import:

| Variable | Host direct value | Box/container/bwrap value | Meaning |
| --- | --- | --- | --- |
| `PLOINKY_AGENTLIB_DIR` | Canonical selected host path | `/opt/ploinky-agentlib` | Only accepted AgentLib root for framework imports |
| `PLOINKY_AGENTLIB_MODE` | `local` or `managed` | Same | Provenance |
| `PLOINKY_AGENTLIB_FINGERPRINT` | Selection fingerprint | Same | Desired deployment bytes |
| `PLOINKY_AGENTLIB_COMMIT` | Commit or empty | Same | Revision evidence, not the content proof |

Agent manifests and user environment layers must not override these names. Inject them at the same final authoritative layer as other reserved runtime identity variables.

### 6.2 Core imports

Implement explicit, containment-checking helpers instead of relying on `NODE_PATH` for ESM. The helper must:

1. Require a validated `PLOINKY_AGENTLIB_DIR`.
2. Resolve requested subpaths under that root without allowing `..` escape.
3. Resolve package-export-style entry points deterministically.
4. Record the real path and SHA-256 of each loaded entry point for attestation.

Convert the current framework import sites, including:

- `cli/commands/cli.js`
- `cli/shell.js`
- `cli/commands/llmSystemCommands.js`
- `cli/commands/llmProviderUtils.js`
- `Agent/lib/jwtSign.mjs`
- `Agent/lib/jwtVerify.mjs`
- `Agent/server/AgentServer.mjs`

Because `Agent/` is mounted as a standalone runtime tree, put its small resolver in `Agent/lib/` or make it otherwise self-contained. It must not import a helper that is unavailable beneath `/Agent`.

Do not create `/opt/ploinky/node_modules/achillesAgentLib` in the Box and do not fall back to it. All framework import sites must use the explicit resolver. The Box dependency root remains for `mcp-sdk` only.

The symlink in an **agent dependency cache** is different: it is the deliberate package-resolution adapter for agent-owned bare imports, not a legacy fallback. It points directly to the selected source and is part of the new runtime contract.

### 6.3 Agent dependency caches

Change dependency preparation as follows:

- Remove `achillesAgentLib` from `globalDeps/package.json`; npm continues to install `mcp-sdk` and agent-specific dependencies.
- Treat `achillesAgentLib` as a reserved dependency key. Reject it in every agent dependency field before running npm so an agent cannot override the framework source.
- After every npm operation, atomically create or repair `node_modules/achillesAgentLib` as the last cache step. npm may prune an earlier extraneous link.
- For container and bwrap runtime keys, the symlink target is `/opt/ploinky-agentlib`.
- For seatbelt runtime keys, the target is the canonical selected host directory.
- Bump the cache stamp schema and record source mode, source ID, link target, fingerprint, and commit.
- Separate npm-cache validity from AgentLib-link validity. A changed local fingerprint should refresh the link metadata/stamp and force runtime recreation, but should not reinstall unrelated npm packages when their manifests and installer ABI are unchanged.
- Pass an explicit selection into `prepareGlobalCache`, `prepareAgentCache`, and verification functions. Do not let cache code independently rediscover a source from ambient cwd.

This preserves bare `import 'achillesAgentLib/...'` from agent-owned code while ensuring it traverses into the direct source.

### 6.4 Box mount and contract

Extend `containerCreateArgs` with one exact stable-path bind:

```text
<selection.sourceDir>:/opt/ploinky-agentlib:ro
```

The selected directory is inside the workspace, which is also mounted broadly at `/workspace`. Add a second exact read-only bind over its workspace-visible alias:

```text
<selection.sourceDir>:/workspace/<selection.sourceRelativePath>:ro
```

Without that shadow, the same inode would remain writable through `/workspace/...` and the stable read-only mount would not be a real confinement boundary.

Extend the immutable Box contract with:

- Both exact source binds, their real source path, destinations, and `RW=false`.
- Labels for AgentLib mode, source-ID hash, and content fingerprint.
- The reserved environment values in the exact allowlist.
- Desired-state comparison that replaces the versionless Box when source directory identity, mode, commit, or fingerprint differs.

Update `validateContainerConfiguration`, discovery/desired reconstruction, create/final validation, and rollback together. The expected durable bind count becomes six, plus the permitted `/tmp` tmpfs observation.

`ploinky-box/entrypoint/install-dependencies.mjs` should install only `mcp-sdk`. It must validate `/opt/ploinky-agentlib` against the passed contract and require `/opt/ploinky/node_modules/achillesAgentLib` to be absent. If that old entry is proven to be Ploinky-owned workspace cache data, remove it during the stopped/preparation transaction; if ownership is ambiguous, fail with a cleanup instruction rather than load it. Keep the AgentLib repository entry in `dependencies.lock.json` as canonical source policy, but stop treating it as a Box-local installed dependency.

### 6.5 Agent runtime mounts

For Docker and nested Podman:

- Add the selected source bind at `/opt/ploinky-agentlib`, read-only.
- Inspect the compiled writable binds. If one exposes the workspace-relative source at another container path, add a later exact read-only shadow for that alias. Admission fails if an alias cannot be shadowed unambiguously.
- Include it in `expectedBindMountsFromArgs`, exact adoption checks, persisted registry binds, and env hash/deployment identity.
- Add it for fresh and reused Podman staged layouts. The existing staged `/Agent` and `/code` trees remain separate concerns.

For bwrap:

- Add `--ro-bind <selected-host-source> /opt/ploinky-agentlib`.
- After writable project/workspace binds, add exact read-only shadows for every mapped alias of the selected source.
- Include the bind in interactive shells as well as detached starts.
- Set the reserved environment and include the fingerprint in reuse/restart decisions.

For seatbelt:

- Point the cache symlink to the canonical host source.
- Add the canonical real path to read access and an overriding protected write denial; the denial applies regardless of which workspace alias reaches the same source.
- Include the source identity/fingerprint in the profile/reuse hash so a changed selection regenerates the profile and restarts the process.

All managed runtime records must carry one structured `agentLib` section, including its stable grant and any required alias shadows. Reuse/adoption fails closed when the expected selection or any direct-source grant differs.

## 7. Command and lifecycle behavior

### 7.1 Bootstrap routing

Remove the shell-level `<ploinky>/node_modules/achillesAgentLib` gate from `bin/ploinky-local`.

Before dynamically importing AgentLib-dependent core code:

- Outside the Box, resolve/materialize the workspace source, set the reserved environment, then import `cli/main.js`.
- Inside the Box, require the supervisor-provided environment and mounted source; validate only. Missing context is an error, not permission to clone from inside the Box.
- Route `bin/ploinky-shell` through the same bootstrap before importing `cli/shell.js`.
- Keep `help`, read-only `logs`, and source-status inspection free of clone/fetch side effects.

### 7.2 Public start/restart transaction

Change `runStartTransaction` to this order while holding the outer Box lock:

1. Resolve the workspace and branch policy.
2. Select or stage the AgentLib source under the short-lived source lock.
3. Capture source ID and fingerprint.
4. Reconcile the outer Box with the desired direct-source mount contract.
5. Validate the Box mount, exclude/remove the old Box AgentLib entry, and install/verify `mcp-sdk`.
6. Invoke in-Box `ploinky-local` with the reserved selection environment.
7. Start/recreate all affected agents with direct-source grants.
8. Obtain core and agent AgentLib attestations.
9. Recompute the host source fingerprint and identity.
10. If the selection drifted, tear down the newly admitted graph and fail; do not declare readiness.
11. Atomically commit `active.json` only after full readiness.

For a first deployment, a failure removes the candidate Box and leaves a staged managed generation for retry. For a replacement, keep the old active descriptor and restore the old Box/source generation when exact ownership remains provable.

A local checkout can change independently, so rollback to an old local fingerprint is only allowed if the old fingerprint still matches. Otherwise leave the graph stopped and report that rollback was unsafe.

### 7.3 Update transaction

Replace the current split AgentLib update paths with one owner-driven transaction:

| Active source | `ploinky update` behavior |
| --- | --- |
| Local | Never pull, reset, or checkout. Revalidate and report commit/dirty/fingerprint. If bytes changed, select the new fingerprint and restart coherently. |
| Managed lock commit | Fetch source metadata as part of update; switch only if the configured lock commit changed after a Ploinky self-update. |
| Managed explicit branch | Fetch the exact remote branch, stage its new commit as a new generation, and switch through the normal Box/core/agent replacement transaction. |

The outer CLI currently prepares a Box, executes the in-Box update, then restarts the already prepared Box. Replace that flow with a supervisor-owned update method that stages AgentLib before Box reconciliation and retains rollback context until the inner update and restart finish.

Inside-Box `ploinky-local update` must skip AgentLib source mutation and state that the outer host owns it. Direct host `ploinky-local update` performs the same managed-generation transition itself.

Retire AgentLib handling from:

- `refreshPloinkyRuntimeAchillesDependency`
- moving-Git dependency invalidation
- managed-repository package refresh loops
- `PLOINKY_AGENTLIB_REF` npm-spec/file override logic; remove it immediately rather than supporting an alias or deprecation window

Keep `mcp-sdk` update/cache behavior independent.

### 7.4 Status and drift

`ploinky status` and `ploinky-local status` must be read-only and show:

- Source mode and workspace-relative source path.
- Requested ref, resolved commit, Git cleanliness, and content fingerprint.
- Active Box fingerprint/source-ID hash and current mount source.
- Core resolved root and loaded entry-point hashes.
- Each running agent's resolved package root and fingerprint/entry-point hashes.
- A clear `restart required` state if the current local content differs from the active selection.

Status must not create `.ploinky`, clone, fetch, repair links, or restart anything.

### 7.5 Live-edit semantics

A direct mount exposes local file edits immediately at the filesystem layer. Node's module cache and already-created objects mean this is not a supported hot-reload boundary. The operational contract is:

- Edit `<workspace>/achillesAgentLib`.
- Run `ploinky restart` or direct `ploinky-local restart`.
- Readiness admits one new fingerprint across core and all agents.

If files change while startup is in progress, startup fails. If they change after readiness, status reports drift; a later restart activates them coherently. Continuous automatic restart-on-edit is out of scope.

## 8. Loaded-byte attestation

Use one deployment attestation shape for core and agents:

```json
{
  "schemaVersion": 1,
  "deploymentFingerprint": "...",
  "sourceRootRealpath": "...",
  "packageJsonHash": "...",
  "entrypoints": {
    "LLMAgents/index.mjs": "...",
    "utils/LLMClient.mjs": "...",
    "jwt/jwtSign.mjs": "...",
    "jwt/jwtVerify.mjs": "..."
  }
}
```

At readiness:

- Core attests the real paths and hashes recorded by the explicit import helper.
- Each agent runs a confined probe that resolves `achillesAgentLib/package.json` and required entry points through its actual runtime `node_modules`, verifies real paths beneath the selected source, and hashes those files.
- The supervisor compares every attestation with the desired source fingerprint and selected entry-point hashes.
- Any missing, divergent, or unconfined path is a readiness failure.

For a release-candidate deployment, additionally require the exact pushed Ploinky current-branch commit, clean dependency sources at their recorded remote default branches, no fallback to alternate dependency branches, and matching loaded-byte attestation. The separate cross-repository deployment/E2E gate remains on-demand as required by `CLAUDE.md`.

## 9. Phased implementation

Implement on one feature branch as phase-sized commits, but merge only after all surfaces are wired. A partial rollout would deliberately leave multiple AgentLib authorities.

### Phase 1 — Shared source contract

Work:

- Add the `agentlib/` shared modules.
- Centralize canonical URL/default commit lookup from the Box lock.
- Implement local validation, managed staging/reuse, deterministic hashing, descriptor parsing, atomic writes, and source locking.
- Refactor branch-policy parsing so outer `ploinky` and core use the same parser.

Tests:

- Local candidate wins without invoking Git/network seams.
- Absence creates one managed generation; later offline selection reuses it.
- Invalid present directory, root symlink, escaping internal symlink, source substitution, and malformed descriptor all fail closed.
- Exact spelling and workspace-root behavior.
- Lock commit/default, explicit branch, fallback, dirty local branch, and release-candidate cases.
- Interrupted materialization never changes `active.json`.

Exit gate: a selection can be produced, staged, revalidated, and rolled back without any runtime consuming it yet.

### Phase 2 — Box direct-source contract

Work:

- Thread `AgentLibSelection` through supervisor prepare/start and lifecycle transactions.
- Add Box labels, environment, read-only mount, exact validation, desired comparison, and rollback data.
- Change the Box installer to install `mcp-sdk`, validate the direct mount, and reject/remove the old Box AgentLib cache entry under exact ownership proof.
- Make Box readiness and status expose the selected contract.

Tests to extend:

- `tests/unit/ploinkyBoxSupervisor.test.mjs`
- `tests/unit/ploinkyBoxTransactions.test.mjs`
- `tests/unit/ploinkyBoxDependencies.test.mjs`
- `tests/unit/ploinkyBoxEntrypoint.test.mjs`
- `tests/unit/ploinkyBoxDiscovery.test.mjs`
- `tests/unit/ploinkyBoxSafetyMatrix.test.mjs`

Exit gate: Box creation/reuse/replacement accepts exactly the stable read-only AgentLib bind plus its read-only workspace-alias shadow, rejects extra/wrong/mutable binds and labels, and can restore a prior managed generation after candidate failure.

### Phase 3 — Direct launcher and core imports

Work:

- Remove the bash dependency gate.
- Bootstrap direct `ploinky-local` and `ploinky-shell` before core imports.
- Set/validate the reserved environment in host and Box modes.
- Convert all framework AgentLib import/resolve sites to the explicit helper.
- Keep the core dependency assertion for `mcp-sdk`; replace the AgentLib install-tree assertion with source-contract validation.

Tests:

- Direct local checkout works with no `<ploinky>/node_modules/achillesAgentLib`.
- Direct managed checkout clones once and works offline thereafter.
- In-Box launcher never clones or mutates source state.
- Help/logs/status retain their read-only bootstrap behavior.
- Every resolved framework subpath is inside the selected root and attested.

Exit gate: both public in-Box core and direct host core load the selected bytes without relying on the Ploinky installation's AgentLib submodule.

### Phase 4 — Agent cache links and runtime grants

Work:

- Remove AgentLib from the npm manifest and reject agent overrides.
- Add post-npm atomic cache links and stamp schema v2.
- Pass the selection explicitly through dependency preparation.
- Add Docker/Podman, bwrap, and seatbelt source grants, environment, registry state, and reuse checks.
- Ensure detached start, restart, adoption, interactive shell, and Podman staged paths all use the same contract.

Tests to extend:

- `tests/unit/dependencyCache.test.mjs`
- `tests/unit/agentServiceManager.test.mjs`
- `tests/unit/podmanStaging.test.mjs`
- `tests/unit/bwrapArgs.test.mjs`
- `tests/unit/seatbeltProfile.test.mjs`
- `tests/unit/seatbeltServiceManager.test.mjs`

Exit gate: an agent npm install cannot prune the final link, an agent package cannot override AgentLib, and each runtime either resolves the direct source or fails admission.

### Phase 5 — Lifecycle, update, status, and proof

Work:

- Add supervisor-owned start/update source transactions and final drift validation.
- Make AgentLib fingerprint changes force coherent Box/core/agent replacement without reinstalling unrelated npm packages.
- Add loaded-byte probes and status rendering.
- Remove the old runtime pull, npm-ref override, and moving-dependency invalidation paths.
- Update help text and operator diagnostics.

Tests:

- Local edit plus restart changes every attested fingerprint together.
- Edit during startup fails and does not commit active state.
- Managed update stages a new generation, succeeds atomically, and prunes only unreferenced old state.
- Failed update restores the prior managed Box and agents.
- Local source appearance/disappearance switches provenance on the next lifecycle command.
- Status detects drift without mutation or network access.

Exit gate: no executable path independently installs, pulls, copies, or resolves a second achillesAgentLib.

### Phase 6 — Clean-break removal and cleanup

Work:

- Remove a prior `/opt/ploinky/node_modules/achillesAgentLib` entry after proving it is Ploinky-owned workspace cache data. Do not convert it to a link or consume it.
- Invalidate prior dependency-cache stamp versions and rebuild those managed caches with the new runtime-appropriate symlink. Do not preserve an installed/copy AgentLib directory.
- Remove or rewrite obsolete AgentLib-specific tests and release assertions.
- Remove the `node_modules/achillesAgentLib` gitlink and `.gitmodules` entry in this change. Tests that need AgentLib use an explicit fixture or the shared selector; the repository submodule is not retained as a transition aid.
- Remove `PLOINKY_AGENTLIB_REF`, its help text, and its tests immediately. If it is present in the environment, fail with an unsupported-setting error so it cannot be silently ignored. Do not interpret `file:` or arbitrary npm specs.
- Remove every bare-resolution/install-tree fallback. A missing `PLOINKY_AGENTLIB_DIR` at an AgentLib-dependent entry point is a contract error.
- Preserve old managed generations until exact non-use is proven; `destroy --delete-cache` may remove workspace-owned AgentLib managed state after the Box and agents are proven absent.

Exit gate: only the new direct-source graph is admissible. Obsolete Ploinky-owned cache state is removed or rejected without deleting or mutating a user-owned workspace checkout.

## 10. Verification matrix

### 10.1 Required automated coverage

| Scenario | Required observation |
| --- | --- |
| Local source present | No Git network call; Box/core/two agents resolve the same source fingerprint |
| Local source invalid | Hard error; managed clone is not consulted |
| Local source changes | Running status reports drift; restart admits one new fingerprint |
| Local source changes during deploy | Candidate graph is not declared ready; active descriptor remains old |
| Local source removed | Next lifecycle selects a managed generation and replaces all consumers |
| Managed first start | One GitHub materialization at the locked commit |
| Managed offline restart | No fetch; active generation reused |
| Managed branch update | New detached generation; old generation remains available for rollback |
| Wrong Box bind, writable source bind, or missing writable-alias shadow | Existing Box is incompatible and cannot be adopted |
| Agent declares AgentLib | Dependency preparation fails before npm |
| npm prunes extraneous modules | Final post-install symlink still exists and resolves correctly |
| Docker/Podman | Exact read-only source bind and actual package-resolution probe |
| bwrap | Exact read-only source bind, including interactive shell |
| seatbelt | Exact host source read grant, write denial, and host-target cache link |
| Read-only commands | Help/logs/status do not clone, fetch, repair, or create source state |
| Release-candidate policy | Exact pushed Ploinky current-branch commit, clean dependency default-branch commits, and loaded-byte hashes; no fallback |

### 10.2 Repository gates

Run targeted unit files after each phase, then:

```bash
npm test
```

When a native Linux nested-Podman environment is available, extend and run `tests/integration/ploinkyBoxNative.test.mjs` with both source modes. The integration fixture should place a unique exported marker in a local AgentLib checkout, load it through core and at least two agents, and compare runtime realpaths plus hashes rather than only checking a descriptor.

Also test direct `ploinky-local` on macOS seatbelt and Linux bwrap because those paths do not share the same mount mechanics.

Do not automatically perform the cross-repository release-candidate deployment or Playwright gate as part of normal implementation verification. Run it only when explicitly requested.

## 11. File-level change map

| Area | Primary files |
| --- | --- |
| Shared selection/materialization | New `agentlib/*.mjs`; `ploinky-box/dependencies.lock.json` remains canonical policy |
| Public CLI policy/lifecycle | `ploinky-box/bin/ploinky-box.mjs`, `ploinky-box/supervisor.mjs`, `ploinky-box/command/*` |
| Box identity and immutable contract | `ploinky-box/constants.mjs`, `ploinky-box/lifecycle/container.mjs`, `ploinky-box/lifecycle/transactions.mjs`, `ploinky-box/contract/container.mjs`, discovery/status modules |
| Box dependency/source validation | `ploinky-box/entrypoint/install-dependencies.mjs`, `ploinky-box/entrypoint/entrypoint.mjs`, `bin/ploinky-install-deps` |
| Direct bootstrap/core | `bin/ploinky-local`, `bin/ploinky-shell`, `cli/index.js`, `cli/main.js`, `cli/shell.js` |
| Framework imports | `cli/commands/cli.js`, `cli/commands/llmSystemCommands.js`, `cli/commands/llmProviderUtils.js`, `Agent/lib/jwtSign.mjs`, `Agent/lib/jwtVerify.mjs`, `Agent/server/AgentServer.mjs` |
| Dependency caches | `globalDeps/package.json`, `cli/utils/dependencies/dependencyInstaller.js`, `dependencyCache.js`, `dependencyRuntimeKey.js` if link mode must join the key |
| Container/Podman agents | `cli/sandbox/docker/agentServiceManager.js` and exact registry/adoption helpers |
| bwrap agents | `cli/sandbox/bwrap/bwrapServiceManager.js` |
| seatbelt agents | `cli/sandbox/seatbelt/seatbeltServiceManager.js`, `seatbeltProfile.js` |
| Update/status/removals | `cli/commands/updateService.js`, `repoAgentCommands.js`, `depsCommands.js`, `help.js`, `cli/utils/status.js` |
| Verification/release | Existing Box, dependency, runtime, update, status, packaging, and release test files plus new source-contract tests |

## 12. Risks and explicit limitations

| Risk | Treatment |
| --- | --- |
| Host edits a directly mounted local source while processes run | Supported as filesystem visibility, not hot reload. Detect drift and require restart; revalidate around readiness |
| Node has already cached old modules | Restart core and every agent as one graph whenever the active fingerprint changes |
| Bind mount keeps an old inode after path replacement | Managed sources use immutable generation paths; never replace a mounted generation in place |
| Candidate failure after managed update | Keep old generation and descriptor until full readiness; restore only with exact ownership proof |
| Candidate failure after uncontrolled local edit | Do not claim rollback to bytes that no longer exist; stop and report the unsafe rollback |
| npm removes an unlisted link | Create/repair the link after every npm operation and verify it before stamping the cache |
| Agent shadows the dependency | Reserve and reject the dependency key before merge/install |
| Broad workspace/project bind exposes the source as writable | Compile a later exact read-only shadow for every reachable alias and include it in the immutable mount contract |
| Symlink target differs between namespaces | Use `/opt/ploinky-agentlib` for containers/bwrap and a runtime-keyed host target for seatbelt |
| Box or agent adoption accepts stale source | Include exact mount, source identity, fingerprint, and reserved env in immutable/reuse contracts |
| Descriptor is tampered with | Treat it as state, not authority; canonicalize and validate the real source on every use |
| Managed Git metadata is inaccessible in a nested mount | Runtime proof uses source hashes and passed commit evidence; Git operations remain host-owned |

## 13. Definition of done

- `rg` finds no executable path that installs achillesAgentLib through npm, clones it inside the Box, or refreshes `<ploinky>/node_modules/achillesAgentLib`.
- `rg` finds no AgentLib install-tree fallback, Box compatibility link, `PLOINKY_AGENTLIB_REF` behavior, or tracked `node_modules/achillesAgentLib` submodule.
- A local workspace checkout is selected without network access and is never mutated by Ploinky.
- An absent checkout produces one host-managed source generation from the canonical GitHub repository.
- Box core, direct host core, Docker/Podman agents, bwrap agents, and seatbelt agents resolve through the selected source contract.
- All containerized consumers have the exact read-only stable source grant and any necessary alias shadows; no broad new source mount is introduced.
- Agent caches contain a verified symlink, not copied AgentLib bytes.
- A fingerprint change restarts/replaces the whole graph and cannot leave core and agents on different active selections.
- Status proves runtime realpaths and loaded entry-point hashes and reports local drift.
- Update and rollback preserve immutable managed generations and fail closed when exact restoration cannot be proven.
- Rootless/unprivileged execution, exact mount allowlists, network/publication contracts, versionless Box identity, and credential confinement remain unchanged.
- Targeted tests, the full repository suite, and available native runtime integration checks pass.
