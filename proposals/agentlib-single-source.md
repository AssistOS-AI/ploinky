# Proposal: Single-Source Resolution for achillesAgentLib

Status: proposal (not implemented). Date: 2026-08-25.

Scope: how Ploinky core, the Ploinky Box, and all agents obtain achillesAgentLib. mcp-sdk is out of scope except where the two share machinery.

## 1. Requirements

| # | Requirement |
| --- | --- |
| R1 | If achillesAgentLib is present in the current workspace (the folder from which `ploinky start <agent>` is run), Ploinky Box and Ploinky agents use it from there. |
| R2 | Otherwise achillesAgentLib is cloned from GitHub. |
| R3 | Ploinky Box, Ploinky core code, and Ploinky agents all use the same achillesAgentLib. |

This proposal supersedes all previous partial mechanisms (notably the `PLOINKY_AGENTLIB_REF` `file:` pass-through); it is a from-scratch design, with the existing mechanisms listed in §7 as removals.

## 2. Current state (analysis)

Today three independent resolution mechanisms produce up to four coexisting copies of achillesAgentLib with independent revisions. Nothing ties them together.

| # | Copy | Location | Materialized by | Revision policy | Consumers |
| --- | --- | --- | --- | --- | --- |
| 1 | Runtime copy | `<ploinky-install>/node_modules/achillesAgentLib` | Manual `git clone`, or `ploinky update` → `refreshPloinkyRuntimeAchillesDependency` (`cli/commands/updateService.js:363`: `git pull --rebase --autostash`, clone if missing) | Whatever is checked out | Host CLI (`cli/shell.js:15`, `cli/commands/llmSystemCommands.js:32`, `cli/commands/cli.js:95`), host-run router JWT paths via `Agent/lib/jwtSign.mjs` / `jwtVerify.mjs`, presence gates in `cli/main.js:36` and `bin/ploinky-local:7` |
| 2 | Agent dep caches | `<workspace>/.ploinky/deps/{global,agents}/…/node_modules/achillesAgentLib` | `npm install` of merged `globalDeps/package.json` + agent package.json (`cli/utils/dependencies/dependencyCache.js`, `prepareGlobalCache` / `prepareAgentCache`) | Moving remote default branch (spec has no `#ref`), or `PLOINKY_AGENTLIB_REF` override (branch / full spec / `file:`) | Every agent container/sandbox via ro-mounts at `/code/node_modules` and `/Agent/node_modules` (`cli/sandbox/docker/agentServiceManager.js:891`), Podman staged symlink trees, bwrap ro-binds, seatbelt host symlinks |
| 3 | Box pinned deps | `<workspace>/.ploinky/box/dependencies`, mounted rw at `/opt/ploinky/node_modules` | `installPinnedDependencies` at Box container start (`ploinky-box/entrypoint/entrypoint.mjs:323`) — detached checkout at the lock SHA | `ploinky-box/dependencies.lock.json` pin, hand-edited only (no writer exists in-repo) | In-Box `ploinky-local` serving code (Router, WebChat, LLM) via bare specifiers |
| 4 | In-Box nested agent caches | `/workspace/.ploinky/deps/…` (same as #2, computed in-Box) | Same flow, run by `ploinky-local` inside the Box | Same as #2 | Nested agent containers |

Structural facts that shape the solution:

| Fact | Evidence |
| --- | --- |
| `/opt/ploinky` inside the Box is a read-only bind mount of the host ploinky checkout; `/opt/ploinky/node_modules` is a separate writable workspace-backed mount that masks it. | `ploinky-box/lifecycle/container.mjs:102`, `ploinky-box/constants.mjs:50` (`BOX_DATA_MOUNTS.dependencies`), `tests/integration/ploinkyBoxNative.test.mjs:160` |
| The workspace is mounted rw at `/workspace` inside the Box, and the entrypoint enforces `PLOINKY_WORKSPACE_ROOT=/workspace`. Anything in the workspace is visible in-Box with no new mounts. | `ploinky-box/lifecycle/container.mjs:103`, `ploinky-box/entrypoint/ploinky-box-entrypoint` (`require_value PLOINKY_WORKSPACE_ROOT /workspace`) |
| The Box entrypoint runs the dependency step (`entrypoint.mjs --prepare-only`) before emitting `PLOINKY_BOX_READY` and before `exec "$@"` — dependencies are in place before any `ploinky-local` process starts. | `ploinky-box/entrypoint/ploinky-box-entrypoint` |
| achillesAgentLib declares zero npm dependencies; "installing" it is a plain directory copy, no npm required. | `node_modules/achillesAgentLib/package.json` (`"dependencies": {}` — package name `ploinky-agent-lib`, installed under the dependency-key directory name) |
| All core imports are bare `achillesAgentLib/...` specifiers in ~6 files plus two `require.resolve` sites; no importer has fallback path logic. | `cli/shell.js:15`, `cli/commands/cli.js:95`, `cli/commands/llmSystemCommands.js:32`, `Agent/lib/jwtSign.mjs:1`, `Agent/lib/jwtVerify.mjs:1`, `Agent/server/AgentServer.mjs:28` |
| Workspace root resolution: `PLOINKY_WORKSPACE_ROOT` env, else nearest ancestor with `.ploinky`, else cwd. | `cli/utils/config.js:4` |
| `repos.js` already provides clone / branch-policy / dirty-state / remote-probe primitives to reuse. | `cli/utils/repos.js` (`installRepo`, `ensureRepoOnBranch`, `repoIsDirty`, `remoteBranchExists`, `parseBranchPolicy`) |

Concrete pain today: a single Box deployment runs its Router on the lock pin while its nested agents npm-install the remote default branch; the dev host CLI runs a third revision. `PLOINKY_AGENTLIB_REF` only harmonizes surfaces #2/#4, never #1/#3. The prior local-source attempt (`PLOINKY_AGENTLIB_REF=file:...`, verbatim pass-through in `cli/utils/dependencies/dependencyInstaller.js:90`) is container-only, invisible to commit-based cache invalidation, and npm materializes `file:` directory deps as symlinks that do not survive container mount boundaries.

## 3. Proposed design: one workspace-scoped AgentLib source

### 3.1 The resolver

Introduce a single resolver, `resolveAgentLibSource()` (new module, e.g. `cli/utils/dependencies/agentLibSource.js`), that every consumer goes through. It answers one question per workspace: which directory is THE achillesAgentLib for this workspace?

| Priority | Source | Condition | Behavior |
| --- | --- | --- | --- |
| 1 | Workspace checkout | `<PLOINKY_WORKSPACE_ROOT>/achillesAgentLib` or `<…>/AchillesAgentLib` exists | Use it as-is. Never mutate it. Validate it (contains `package.json` named `ploinky-agent-lib`, or `index.mjs` + `jwt/`). An invalid or ambiguous candidate (both spellings present) is a hard error, not a silent fallback — presence signals intent. |
| 2 | Managed clone | Nothing at priority 1 | Clone from the canonical GitHub URL into `<workspace>/.ploinky/agentlib/achillesAgentLib` if absent, honoring the existing `--branch` policy semantics (branch exists on the lib remote → check it out; `--branch-fallback default` → remote default branch; `fail` → abort). After cloning it is stable — it never silently tracks the remote; only `ploinky update` advances it. |

Output: `{ dir, provenance: 'workspace'|'managed', commit, dirty, fingerprint }`, persisted to `<workspace>/.ploinky/agentlib.json` with the directory recorded workspace-relative — equally valid on the host and inside the Box (where the workspace appears at `/workspace`).

Fingerprint: `commit` plus a hash of the dirty diff and untracked-file list for git checkouts; a content hash for a non-git directory. Cheap to recompute (a few git calls), recomputed on every lifecycle command.

Timing: the resolver runs (and may clone) only during workspace lifecycle commands — `start`, `restart`, `update`, `deps prepare` — never as a side effect of importing a module, so no network I/O sneaks into unrelated commands. A separate read-only path (§3.4) serves imports.

The canonical URL moves to one shared constant. Today it is duplicated across `globalDeps/package.json`, `ACHILLES_REPO_URL` in `cli/commands/updateService.js:8`, and `ploinky-box/dependencies.lock.json`.

### 3.2 Agent caches (surfaces #2 and #4)

`readGlobalDepsPackage` stops handing npm an `achillesAgentLib` git spec at all — npm installs only `mcp-sdk` plus agent-specific deps. Cache preparation then copies the resolved lib directory (excluding `.git`) into `<cache>/node_modules/achillesAgentLib` as the LAST step of preparation — after `backend.install` — because `npm install` prunes packages it does not recognize (the same behavior behind the known npm-11 prune hazard); copying before an agent-package install would get the copy deleted.

The cache stamp gains an `agentLibFingerprint` field checked by `isGlobalCacheValid` / `isAgentCacheValid`, so editing the workspace checkout invalidates and re-copies on the next `ploinky start` / `restart`. Copying a dependency-free pure-JS tree is fast.

All four delivery mechanisms keep working untouched, because they all point at the cache's `node_modules`, which now simply contains a copy instead of an npm-git install: Docker nested ro-mounts, Podman staged symlink trees, bwrap ro-binds, seatbelt host symlinks. Nothing about the runtime container layout changes, and `AgentServer.mjs` needs no changes (its `require.resolve` finds the copy in the mounted cache exactly as before).

### 3.3 The Box (surface #3)

The entrypoint's dependency step (`ploinky-box/entrypoint/entrypoint.mjs:323` → `installPinnedDependencies`) becomes source-aware:

| Case | Behavior |
| --- | --- |
| `/workspace/.ploinky/agentlib.json` resolves to a source (written by the host resolver before container creation) | Stage-copy that directory into `/opt/ploinky/node_modules/achillesAgentLib` using the existing transactional staging/backup/rollback machinery in `ploinky-box/entrypoint/install-dependencies.mjs`. Record provenance + fingerprint in the dependency marker; fingerprint comparison replaces the git-HEAD check for this entry in `installationMatches`. |
| No workspace source (e.g. a bare image boot with no resolved workspace) | Fall back to today's pinned GitHub fetch from `dependencies.lock.json`. The lock keeps its role as the sealed, integrity-anchored fallback. |
| mcp-sdk | Unchanged: always installed from the lock pin. The lock's exactly-two-names validation stays untouched. |

In-Box core code then needs zero changes: its bare specifiers already resolve to `/opt/ploinky/node_modules/achillesAgentLib`, which now holds the workspace bytes. Ordering is already correct: the prep step completes before `PLOINKY_BOX_READY` and before anything execs `ploinky-local` (verified in `ploinky-box-entrypoint`).

### 3.4 Host core (surface #1)

The only place needing import-site changes, and it is small (~6 sites plus 2 gates). Recommended mechanism: an explicit helper rather than a Node loader hook.

`resolveAgentLibFile(subpath)` returns a `file://` URL from, in order: the `PLOINKY_AGENTLIB_DIR` env (set by CLI bootstrap after resolution, inherited by the Router it spawns) → the workspace's `agentlib.json` → plain `createRequire` bare resolution as the container/compat fallback → a loud error naming the fix.

| Site | Change |
| --- | --- |
| `Agent/server/AgentServer.mjs:28`, `cli/commands/llmSystemCommands.js:32` | Already resolve-then-import; swap the resolver call. (AgentServer runs in containers where the fallback branch is always correct, so it can also stay entirely unchanged.) |
| `cli/shell.js:15`, `cli/commands/cli.js:95` | Static/dynamic bare imports become helper-routed dynamic imports (top-level await where needed). |
| `Agent/lib/jwtSign.mjs`, `Agent/lib/jwtVerify.mjs` | One-line re-export shims become 3-line top-level-await re-exports through a self-contained mini-helper inside `Agent/` (the `Agent/` tree is mounted standalone into containers and must not import from `cli/`). |
| `cli/commands/llmProviderUtils.js:10` | The `LLMConfig.json` candidate-path list collapses into `resolveAgentLibFile('LLMConfig.json')`. |
| `cli/main.js:36` (`assertRuntimeDependencies`) | Changes from "does `<install>/node_modules/achillesAgentLib` exist" to "does a source resolve", with the remedy named in the error. |
| `bin/ploinky-local:7` bash gate | Remove the bash stat-check (it would wrongly block dev hosts once the canonical location moves to the workspace) and rely on the rewritten `assertRuntimeDependencies`, which runs before any command and fails fast with a better message. In-Box the old check would still pass, but removing it keeps one gate, not two. |

Host core imports directly from the resolved directory — no copy step — so a developer editing the workspace checkout sees changes on the next CLI/Router restart.

The alternative (a `module.register()` resolution hook rewriting the bare specifier; zero import-site churn) is workable but adds loader-ordering magic and a Node ≥ 20.6 floor; the explicit greppable helper matches the repo's fail-loud style.

### 3.5 ploinky-local in every mode

`bin/ploinky-local` is the same normal CLI (`cli/index.js`) in two contexts; both are covered:

| ploinky-local context | Lib source at runtime | Changes needed |
| --- | --- | --- |
| Inside the Box | `/opt/ploinky/node_modules/achillesAgentLib`, synced from the resolved workspace source by the entrypoint before ploinky-local starts | None to imports; bash gate satisfied either way |
| Nested-agent orchestration (in-Box) | Same resolver against `PLOINKY_WORKSPACE_ROOT=/workspace`; copies into `/workspace/.ploinky/deps/…` caches with the same fingerprint the host computed | Already part of the agent-cache leg (§3.2) |
| Directly on a dev host (no Box) | Resolved dir imported via helper + `PLOINKY_AGENTLIB_DIR`; caches for sandboxed agents per §3.2 | Helper-routed imports (§3.4) + bash-gate removal |

Multi-workspace hosts (several workspaces sharing one ploinky checkout, each potentially with a different lib) work precisely because resolution is workspace-anchored, not install-anchored. This is why the "symlink inside the installation's node_modules" option is rejected: it is global mutable state keyed to a single workspace.

This design also fixes a divergence ploinky-local has today: its Router runs the lock pin while its nested agents install the remote default branch.

### 3.6 `ploinky update`

| Provenance | `ploinky update` behavior |
| --- | --- |
| workspace | Never mutate the user's checkout. Report its commit/dirty state and whether the remote has moved. |
| managed | Fetch and fast-forward per branch policy; the fingerprint change then invalidates caches naturally. |

This replaces achillesAgentLib's share of the `git ls-remote` moving-dep invalidation in `cli/commands/updateService.js:352` / `invalidateDepsCacheForMovingGitDeps`; mcp-sdk keeps that mechanism. `refreshPloinkyRuntimeAchillesDependency` (pull/clone into the install tree's `node_modules`) retires.

### 3.7 Proof surface

`ploinky status` gains one AgentLib line — provenance, directory, commit, dirty flag, fingerprint. The Box dependency marker and every cache stamp carry the same fingerprint, so "same lib everywhere" becomes a checkable assertion. This directly serves the `ploinky-proxy` gate's "prove the loaded AgentLib bytes" requirement (`ploinky/CLAUDE.md` invariant 9): `--branch ploinky-proxy` yields a managed clone (or validates a workspace checkout) at that branch, and status/marker output is the evidence. `--branch-fallback fail` maps to the gate's no-fallback rule.

## 4. What this deletes

| Retired | Replaced by |
| --- | --- |
| `achillesAgentLib` entry in `globalDeps/package.json` (moving git dep fed to npm) | Resolver + copy; canonical URL in one shared constant |
| `PLOINKY_AGENTLIB_REF` full-spec/`file:` pass-through (`cli/utils/dependencies/dependencyInstaller.js:90`) and its tests (`tests/unit/agentlibRefOverride.test.mjs`, `tests/unit/globalCacheAgentlibRef.test.mjs`) | Workspace-checkout precedence; `--branch` keeps its meaning but now steers the managed clone. Keep the env name one release as an alias that errors with a pointer, then drop |
| `<ploinky-install>/node_modules/achillesAgentLib` as canonical dev location | Workspace checkout. The npm-11 "prunes extraneous achillesAgentLib" hazard disappears because nothing expects the lib there anymore |
| achillesAgentLib's role in `resolveMovingGitDepCommits` / `invalidateDepsCacheForMovingGitDeps` | Fingerprint-keyed cache stamps |
| `refreshPloinkyRuntimeAchillesDependency` (`cli/commands/updateService.js:363`) | `ploinky update`'s managed-clone advance (§3.6) |
| `bin/ploinky-local` bash presence gate | Resolver-aware `assertRuntimeDependencies` |

## 5. Decision points

| # | Decision | Recommendation |
| --- | --- | --- |
| 1 | Host-core mechanism | Explicit resolver helper + top-level-await imports (6–8 files) over a module-resolution hook — no loader magic, greppable, matches the repo's fail-loud style |
| 2 | Managed-clone default revision | Remote default branch at first clone, then frozen until explicit `ploinky update` — deterministic between updates, preserves current UX. Stricter alternative: default to the lock SHA for box-grade pinning everywhere |
| 3 | Presence-based override safety | Keep unconditional per R1, but loud: provenance logged at start, in status, and in the Box marker; optionally `PLOINKY_AGENTLIB_SOURCE=pinned` to force lock/GitHub for sealed deployments. A stray workspace dir changing runtime code is the accepted trade-off of R1 — an attacker who can write the workspace can already poison `.ploinky/deps` |
| 4 | Lock file | Keep as no-workspace fallback and mcp-sdk pin; exactly-two-names validation unchanged |

## 6. Invariant review

No new network publications; the ro `/opt/ploinky` mount is untouched; copies land only in already-writable workspace-backed paths using the existing transactional installer with its ownership checks; no credentials involved; rootless preserved; nothing agent-specific enters framework code (the lib is core runtime, already named in globalDeps and the lock). Resolver writes of `agentlib.json` serialize under the workspace lock. Box readiness semantics are unchanged — the dependency step remains part of `--prepare-only` before readiness.

## 7. Migration

Existing dev workspaces move (or clone) the checkout to the workspace root: `git clone https://github.com/AssistOS-AI/AchillesAgentLib.git <workspace>/achillesAgentLib`, or `mv <ploinky-install>/node_modules/achillesAgentLib <workspace>/achillesAgentLib`. During transition, the helper's final fallback (plain bare resolution) keeps setups with the checkout still under `<install>/node_modules` working unchanged. Fresh workspaces need nothing: the first `ploinky start` creates the managed clone.

## 8. Verification criteria

| Check | Command / observable |
| --- | --- |
| Resolver precedence, validation, ambiguity, fingerprint dirty-tracking | New `tests/unit/agentLibSource.test.mjs` via `node --test` |
| Cache embeds and invalidates on fingerprint | Extend `tests/unit/dependencyCache.test.mjs`; edit a lib file → `prepareAgentCache` reports a miss with a fingerprint reason |
| npm-prune ordering | Unit test: agent-with-package.json cache prep leaves `node_modules/achillesAgentLib` present after the install step |
| Box syncs workspace lib | Extend `tests/integration/ploinkyBoxNative.test.mjs`: seed `<fixture>/achillesAgentLib` with a marker file → `execInBox cat /opt/ploinky/node_modules/achillesAgentLib/<marker>` matches; a no-checkout fixture still proves the lock SHA via `git -C … rev-parse HEAD` |
| End-to-end sameness | `ploinky start` in a fresh dir → `ploinky status` shows one fingerprint; the same fingerprint appears in the Box marker and in `.ploinky/deps/*/stamp.json`; in-container `test -f /code/node_modules/achillesAgentLib/<marker>` (pattern of `tests/test-functions/demo_agent_dependency_tests.sh`) |
| ploinky-local dev host without install-tree copy | Remove `<install>/node_modules/achillesAgentLib` → `ploinky-local cli` in a workspace with a checkout still works; in an empty workspace it errors with the resolver hint until `start`/`update` clones |
| No-network fallback | Fresh workspace offline → clear resolver error naming the clone step; existing managed clone offline → start succeeds with a warning |

## 9. Estimated footprint

Resolver module + `agentlib.json` (~1 new file); `cli/utils/dependencies/dependencyInstaller.js` / `dependencyCache.js` (spec removal, copy step, stamp field); `ploinky-box/entrypoint/entrypoint.mjs` / `install-dependencies.mjs` (source-aware install); 6–8 core import sites + 2 presence gates; `cli/commands/updateService.js` / `repoAgentCommands.js` (update semantics); status output; replacement of the four agentlib-related unit test files (`agentlibBranchResolve`, `agentlibRefOverride`, `globalCacheAgentlibRef`, the agentlib share of `depsInvalidation`).
