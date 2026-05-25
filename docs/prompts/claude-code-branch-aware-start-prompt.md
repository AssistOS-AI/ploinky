# Claude Code Prompt: Branch-Aware Start

You are working in `/Users/danielsava/work/file-parser`.

Primary goal: implement branch-aware fresh workspace startup in Ploinky so an
operator can deploy an agent and its manifest-declared dependencies from a
feature branch with a command like:

```bash
ploinky start AchillesIDE/explorer 8080 --branch embedded-soul-gateway
```

Use this plan as the source of truth:

`/Users/danielsava/work/file-parser/ploinky/docs/plans/branch-aware-start-plan.md`

## Required Starting Context

Inspect status and diffs before editing:

```bash
cd /Users/danielsava/work/file-parser/ploinky && git status --short --branch && git diff
cd /Users/danielsava/work/file-parser/AssistOSExplorer && git status --short --branch && git diff
```

There may be dirty changes from prior work. Do not revert unrelated changes.
Do not stage sibling repos, generated dependency trees, unrelated untracked
files, or local runtime state. If you need a branch for your work, do not use a
`codex/` prefix.

Read these before code changes:

- `/Users/danielsava/work/file-parser/CLAUDE.md`
- `/Users/danielsava/work/file-parser/ploinky/CLAUDE.md`
- `/Users/danielsava/work/file-parser/ploinky/docs/specs/DS002-workspace-and-repository-model.md`
- `/Users/danielsava/work/file-parser/ploinky/docs/specs/DS003-agent-manifest-and-registry.md`
- `/Users/danielsava/work/file-parser/ploinky/docs/specs/DS007-dependency-caches-and-startup-readiness.md`

## Hard Invariants

- Ploinky core must stay generic. Do not hardcode Explorer, Soul Gateway,
  provider backends, or product-specific agent behavior into the runtime.
- Branch selection is repository-management state, not an agent-auth or router
  feature.
- `ploinky start --branch` must not update or replace the Ploinky runtime that
  is currently executing. The caller or deployment workflow is responsible for
  putting the Ploinky checkout on the intended branch before invocation.
- Do not reset, clean, or discard an existing managed repo checkout unless the
  operator passed an explicit force/reset flag.
- Repository operations must remain scoped to `.ploinky/repos/<repo>`.
- Do not inject `PLOINKY_MASTER_KEY` into agents or change secret handling.
- Do not change router auth, MCP auth, HTTP-service auth, or secure-wire
  behavior except where tests need to adapt to branch-aware startup state.
- Do not deploy to production from this implementation task.
- Do not add AI/tool attribution to commits, docs, PR text, comments, or
  metadata.

## Existing Behavior To Preserve

- `ploinky add repo <name> [url] [branch]` and
  `ploinky enable repo <name> [branch]` already support branch selection when
  cloning a repo.
- `ploinky start` currently accepts only a static agent and optional port.
- Startup calls bootstrap before command dispatch, and bootstrap auto-clones
  default repos: `basic`, `AchillesIDE`, and `AchillesCLI`.
- Manifest `enable` entries already support string and object forms, including
  aliases, `noWait`, and dependency-local `profile`.
- The workspace dependency graph must still start dependencies wave by wave and
  preserve no-wait behavior.

## Target CLI

Implement:

```text
ploinky start <staticAgent> [port] \
  [--branch <branch>] \
  [--repo-branch <repo=branch>]... \
  [--branch-fallback default|fail] \
  [--reset-repos]
```

Support both separated and equals forms:

```text
--branch embedded-soul-gateway
--branch=embedded-soul-gateway
--repo-branch proxies=embedded-soul-gateway
--repo-branch=webmeetInfra=main
```

Recommended behavior:

- `--branch <branch>` is the branch candidate for repos involved in this start.
- `--repo-branch <repo=branch>` overrides the branch candidate for one repo.
- `--branch-fallback default` allows missing candidate branches to fall back to
  the repo default.
- `--branch-fallback fail` aborts startup when a required branch is missing.
- `--reset-repos` permits hard reset and clean for managed repos only.
- Without `--reset-repos`, dirty existing managed repo checkouts must fail with
  a clear message.

## Implementation Tasks

1. Add branch policy parsing and helpers in Ploinky:
   - parse start flags without confusing the static agent and port;
   - produce a branch policy object with `branch`, `repoBranches`,
     `fallback`, and `resetRepos`;
   - validate malformed `--repo-branch` values with clear errors.

2. Refactor repository operations in `cli/services/repos.js`:
   - replace raw shell-string clone paths with `execFileSync`;
   - add shared helpers for resolving, cloning, fetching, checking out, and
     safely resetting managed repos;
   - record resolved branch metadata in `.ploinky/repo_sources.json`;
   - keep existing `add repo` and `enable repo` behavior compatible.

3. Make bootstrap branch-aware:
   - parse enough start options before `bootstrap()` runs;
   - pass branch policy into bootstrap;
   - clone default repos on the requested branch when available;
   - preserve existing first-run behavior when no branch flags are supplied.

4. Wire branch policy into `ploinky start`:
   - add `parseStartArgs(options)` in or near `cli/commands/cli.js`;
   - pass the branch policy to `startWorkspace`;
   - preserve `start <agent> <port>` compatibility.

5. Make manifest repo handling branch-aware:
   - support string and object values in manifest `repos`;
   - object form should allow `{ "url": "...", "branch": "..." }`;
   - apply branch resolution order from the plan:
     explicit `--repo-branch`, manifest branch, start-level `--branch`, stored
     branch, repository default.

6. Auto-install missing repos referenced by prefixed manifest enable entries:
   - when an enable entry references `repo/agent` or `repo:agent`, ensure the
     repo is installed and enabled before resolving the manifest;
   - use predefined, stored, or manifest-discovered repo source lookup;
   - keep this generic. This should help `proxies/soul-gateway`, but the code
     should not special-case it.

7. Preserve dependency graph behavior:
   - object enable entries with dependency-local `profile` must still work;
   - `noWait` behavior and no-wait workers must continue working;
   - agent registry records should continue to store agent/profile/alias state,
     while branch state stays on repo source metadata unless a test proves a
     stronger restart contract is needed.

8. Update docs/specs:
   - `ploinky/docs/ploinky-overview.md`
   - `ploinky/docs/cli-reference.html`
   - `ploinky/docs/specs/DS002-workspace-and-repository-model.md`
   - `ploinky/docs/specs/DS003-agent-manifest-and-registry.md`
   - `ploinky/docs/operations.html`
   - update generated/static docs only if this repo normally keeps them in sync
     manually.

9. Update Explorer deployment docs/workflow if needed:
   - `AssistOSExplorer/.github/workflows/deploy-skills-explorer.yml`
   - `AssistOSExplorer/docs/deploy-skills-explorer.md`
   - keep existing `branch` and `proxies_branch` inputs;
   - add `ploinky_branch` and `achilles_branch` inputs if implementing the
     workflow part from the plan;
   - make the workflow put the runtime checkout and Achilles checkout on the
     requested branches before invoking Ploinky;
   - use branch-aware `ploinky start` with explicit `--repo-branch` overrides
     for repos that should not follow the main branch.

## Tests To Add

Add focused unit tests for:

- `parseStartArgs()`:
  - positional static agent and port;
  - `--branch value` and `--branch=value`;
  - repeated `--repo-branch repo=branch`;
  - malformed `--repo-branch` values;
  - default fallback and reset flag parsing.
- branch policy resolution order.
- `addRepo()` and `enableRepo()` preserving existing branch behavior.
- missing repo clone at requested branch.
- existing clean repo checkout switching to requested branch.
- existing dirty repo refusal without `--reset-repos`.
- `--reset-repos` hard-resetting only managed `.ploinky/repos/<repo>`.
- missing branch behavior for fallback `default` and `fail`.
- bootstrap cloning default repos with requested branch.
- manifest `repos` object values with explicit branch.
- prefixed manifest `enable` entries auto-installing a missing repo.
- dependency-local `profile` and `noWait` behavior still passing.

Prefer temporary local git fixtures for branch-switch tests so the tests do not
depend on network or GitHub state.

## Verification

Run targeted Ploinky checks:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/profileSystem.test.mjs \
  tests/unit/workspaceDependencyGraph.test.mjs \
  tests/unit/runtimeResourcePlanner.test.mjs
```

Run every new unit test file you add:

```bash
node --test tests/unit/<new-test-file>.test.mjs
```

Run syntax checks for edited CLI modules:

```bash
node --check cli/index.js
node --check cli/commands/cli.js
node --check cli/services/repos.js
node --check cli/services/ploinkyboot.js
node --check cli/services/bootstrapManifest.js
node --check cli/services/workspaceUtil.js
```

Run formatting/whitespace checks:

```bash
git diff --check
```

If startup control flow changed substantially, also run:

```bash
tests/fast/test_all.sh
```

If the Explorer workflow is touched:

```bash
cd /Users/danielsava/work/file-parser/AssistOSExplorer
git diff --check
```

Do a manual scratch-workspace smoke when practical:

```bash
BRANCH=embedded-soul-gateway
WORK=/tmp/ploinky-branch-aware-start
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"
PLOINKY_MASTER_KEY=<64-hex-key> ploinky start AchillesIDE/explorer 8080 \
  --branch "$BRANCH" \
  --repo-branch webmeetInfra=main \
  --branch-fallback default
```

Verify:

```bash
git -C "$WORK/.ploinky/repos/AchillesIDE" branch --show-current
git -C "$WORK/.ploinky/repos/proxies" branch --show-current
ploinky status
curl -I http://127.0.0.1:8080/dashboard
```

If a check cannot be run because of local dependencies, container runtime
availability, network access, or missing secrets, state that clearly.

## Deliverable Summary Expected

When done, summarize:

- files changed by repo;
- the implemented CLI syntax;
- how bootstrap became branch-aware;
- how missing prefixed dependency repos are installed generically;
- branch safety behavior for clean, dirty, missing, and reset cases;
- deployment workflow changes, if any;
- validation commands and results;
- any skipped checks or remaining risks.
