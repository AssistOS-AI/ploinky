# Branch-Aware Start Plan

## Goal

Make fresh workspace deployment from feature branches ergonomic and
reproducible. The target operator experience is:

```bash
ploinky start AchillesIDE/explorer 8080 --branch embedded-soul-gateway
```

or, when one dependency intentionally stays on another branch:

```bash
ploinky start AchillesIDE/explorer 8080 \
  --branch embedded-soul-gateway \
  --repo-branch webmeetInfra=main
```

The feature must work for Explorer plus Soul Gateway, but it must stay generic:
Ploinky core should understand repositories, manifests, branches, and dependency
graphs, not Explorer-specific agent ids or Soul Gateway-specific behavior.

## Current State

Ploinky already has branch support at repository install time:

- `ploinky add repo <name> [url] [branch]`
- `ploinky enable repo <name> [branch]`
- `ploinky add repo <name> [url] --branch <branch>`
- `ploinky enable repo <name> --branch <branch>`

`ploinky start` does not parse branch flags. It currently treats only the first
two arguments as static agent and router port, so `--branch` is not a supported
start-time option.

Startup also runs bootstrap before command dispatch. Bootstrap auto-clones the
default repositories (`basic`, `AchillesIDE`, `AchillesCLI`) from their default
branches before `start` can inspect its arguments. That means a future
`ploinky start explorer --branch X` must make bootstrap branch-aware before the
normal command handler runs.

Explorer currently references `proxies/soul-gateway` through an `enable` entry.
For a truly fresh workspace, Ploinky must either see `proxies` in manifest repo
directives or learn to auto-install missing repos referenced by prefixed
manifest enable entries. The generic fix is to make prefixed dependency
references (`repo/agent` or `repo:agent`) resolve their repository source
through the normal predefined, stored, or manifest-discovered repo source
mechanism.

## Non-Goals

- Do not make `ploinky start` update or replace the Ploinky runtime that is
  already executing. The operator or deploy workflow must put the Ploinky
  checkout on the requested branch before invoking that branch's CLI.
- Do not add Explorer, Soul Gateway, or provider-specific conditionals to
  Ploinky core.
- Do not reset, clean, or discard existing local repository changes unless the
  operator passes an explicit force/reset flag.
- Do not change the meaning of existing `add repo`, `enable repo`, or `update`
  commands except where they share new branch-safe helpers.

## Target CLI

### Start Syntax

Add branch-aware options to `start`:

```text
ploinky start <staticAgent> [port] [--branch <branch>] [--repo-branch <repo=branch>]... [--branch-fallback default|fail] [--reset-repos]
```

Equivalent forms:

```text
--branch embedded-soul-gateway
--branch=embedded-soul-gateway
--repo-branch proxies=embedded-soul-gateway
--repo-branch=webmeetInfra=main
```

Recommended defaults:

- `--branch <branch>` is the branch candidate for repos involved in this start.
- `--repo-branch <repo=branch>` overrides the branch candidate for one repo.
- `--branch-fallback default` means a repo may stay on its configured default
  branch when the candidate branch does not exist on its remote.
- `--branch-fallback fail` makes missing branch support fail startup.
- `--reset-repos` allows hard reset and clean for managed `.ploinky/repos`
  checkouts. Without it, dirty existing checkouts must fail with clear guidance.

### Examples

Feature branch exists for Ploinky-managed Explorer and proxies repos:

```bash
ploinky start AchillesIDE/explorer 8080 --branch embedded-soul-gateway
```

Feature branch exists for Explorer and proxies, but WebMeet infra should stay
on main:

```bash
ploinky start AchillesIDE/explorer 8080 \
  --branch embedded-soul-gateway \
  --repo-branch webmeetInfra=main
```

Strict CI/deploy mode:

```bash
ploinky start AchillesIDE/explorer 8097 \
  --branch embedded-soul-gateway \
  --repo-branch webmeetInfra=main \
  --branch-fallback fail \
  --reset-repos
```

## Branch Policy Model

Introduce a small internal branch policy object:

```js
{
  branch: "embedded-soul-gateway",
  fallback: "default",
  resetRepos: false,
  repoBranches: {
    webmeetInfra: "main",
    proxies: "embedded-soul-gateway"
  }
}
```

Resolution order for a repo:

1. Explicit `--repo-branch <repo=branch>`.
2. Explicit branch on a manifest `repos` object, when present.
3. Start-level `--branch`.
4. Stored branch in `.ploinky/repo_sources.json`.
5. Repository default branch.

The resolved branch should be recorded in `.ploinky/repo_sources.json` when
Ploinky clones or safely switches a managed repo. This keeps later repair and
update behavior reproducible.

## Repository Safety

Create shared helpers in `cli/services/repos.js`:

- `parseBranchPolicyOptions(args)`
- `resolveBranchForRepo(repoName, source, branchPolicy)`
- `remoteBranchExists(repoPathOrUrl, branch)`
- `ensureRepoInstalled(name, url, { branchPolicy, branch, stdio })`
- `ensureRepoOnBranch(name, { branch, resetRepos, fallback, stdio })`

Behavior for existing repos:

1. If the repo is missing, clone it with the resolved branch when available.
2. If the repo exists and the resolved branch is already checked out, do
   nothing except record the source branch.
3. If the repo exists, is clean, and the resolved branch exists, fetch and
   checkout the branch.
4. If the repo exists and is dirty, fail unless `--reset-repos` is set.
5. If `--reset-repos` is set, fetch, checkout the branch, hard reset to
   `origin/<branch>`, and clean untracked files inside `.ploinky/repos/<repo>`.
6. If the branch does not exist:
   - with `--branch-fallback default`, keep or clone the repo on its configured
     default branch and log the fallback;
   - with `--branch-fallback fail`, abort startup.

This keeps scratch deployment convenient while making CI/deploy mode strict.

## Bootstrap Changes

`cli/index.js` currently calls `bootstrap()` before dispatching commands.
Change that flow so it extracts only global/start bootstrap options first:

1. Parse raw args enough to know whether the command is `start`.
2. If command is `start`, parse branch policy without mutating the final command
   args yet.
3. Pass the branch policy into `bootstrap({ branchPolicy })`.
4. Bootstrap clones default repos with branch awareness.
5. Continue normal command dispatch with the parsed start options.

`bootstrap()` should use repository helpers rather than shelling out through a
raw `git clone` string. That also removes shell quoting risk for branch names
and URLs.

## Start Command Changes

Add a real `parseStartArgs(options)` helper in `cli/commands/cli.js` that
returns:

```js
{
  staticAgent: "AchillesIDE/explorer",
  port: "8080",
  branchPolicy
}
```

Then call:

```js
await startWorkspace(staticAgent, port, {
  branchPolicy,
  refreshComponentToken,
  ensureComponentToken,
  enableAgent,
  killRouterIfRunning
});
```

`startWorkspace()` should pass `branchPolicy` to:

- static agent resolution/bootstrap;
- manifest directive processing;
- dependency graph repo resolution;
- no-wait worker startup only if worker needs to repair/resolve a missing repo.

Enabled-agent records should not store the branch directly unless needed for
restart reproducibility. Prefer storing branch at the repository source level in
`.ploinky/repo_sources.json`; the agent record already stores repo and agent.

## Manifest Repo and Dependency Resolution

Update `applyManifestDirectives()` so manifest `repos` values can be strings or
objects:

```json
{
  "repos": {
    "proxies": {
      "url": "https://github.com/PloinkyRepos/proxies.git",
      "branch": "main"
    }
  }
}
```

For each manifest repo directive:

1. Resolve source URL and branch through `repos.resolveRepoSource()`.
2. Apply start branch policy and explicit manifest branch.
3. Install/enable the repo with the shared safe helper.

For manifest `enable` entries:

1. Parse the dependency directive.
2. If the directive references `repo/agent` or `repo:agent`, ensure that repo
   is installed and enabled before resolving the agent manifest.
3. Use the normal predefined/stored/manifest source lookup. This keeps
   `proxies/soul-gateway` generic and lets other repos benefit from the same
   behavior.
4. Preserve existing `alias`, `noWait`, and dependency-local `profile`
   behavior.

## Update Command Interaction

Do not make `ploinky update` accept start-only flags in the first phase.
Instead:

- When a repo has a stored branch in `.ploinky/repo_sources.json`, `update repo`
  should pull the current checkout and repair non-git repos using that branch.
- If the working copy is on a different branch than the stored branch, log a
  warning and leave branch switching to `start --branch` or `add/enable repo`.

A later phase can add:

```text
ploinky update repos --branch <branch>
```

but it is not required for scratch startup.

## Deploy Workflow Changes

The deploy workflow should continue to use GitHub Actions for production-like
deploys. Add inputs:

- `ploinky_branch`
- `achilles_branch`
- keep existing `branch` for `AssistOSExplorer`;
- keep existing `proxies_branch` for `proxies`.

Before invoking `ploinky`, the workflow must put the host runtime checkout on
the requested Ploinky branch and put `node_modules/achillesAgentLib` on the
requested Achilles branch. Then it can call the new branch-aware start command:

```bash
env PLOINKY_MASTER_KEY="$PLOINKY_MASTER_KEY" "$PLOINKY" start AchillesIDE/explorer "$ROUTER_PORT" \
  --branch "${EXPLORER_BRANCH:-main}" \
  --repo-branch "proxies=${PROXIES_BRANCH:-main}" \
  --repo-branch "webmeetInfra=main" \
  --branch-fallback fail \
  --reset-repos
```

For this feature branch set, the workflow invocation would look like:

```bash
gh workflow run deploy-skills-explorer.yml \
  --repo PloinkyRepos/AssistOSExplorer \
  --ref embedded-soul-gateway \
  -f branch=embedded-soul-gateway \
  -f proxies_branch=embedded-soul-gateway \
  -f ploinky_branch=embedded-soul-gateway \
  -f achilles_branch=embedded-soul-gateway
```

## Documentation Updates

Update:

- `docs/ploinky-overview.md`
- `docs/cli-reference.html`
- `docs/specs/DS002-workspace-and-repository-model.md`
- `docs/specs/DS003-agent-manifest-and-registry.md`
- `docs/operations.html`
- `AssistOSExplorer/docs/deploy-skills-explorer.md`
- `AssistOSExplorer/README.md` if the local fresh-start instructions should
  advertise branch-aware startup.

The DS updates should state that branch selection is repository-management
state and that branch-aware start must not hardcode product-specific repos.

## Test Plan

### Ploinky Unit Tests

Add tests for:

- `parseStartArgs()` with positional port, `--branch`, `--branch=value`,
  repeated `--repo-branch`, and invalid branch assignment forms.
- branch policy resolution order.
- `addRepo()` and `enableRepo()` preserving branch metadata.
- existing clean repo switching to requested branch.
- dirty existing repo rejecting branch switch without `--reset-repos`.
- missing branch fallback behavior for both `default` and `fail`.
- bootstrap cloning default repos on the requested branch.
- manifest `repos` object values with explicit branch.
- prefixed manifest `enable` entries auto-installing missing repos.
- dependency-local profile behavior still working for object enable entries.

### CLI and Smoke Tests

Use temporary local git repositories with real branches:

1. Create fixture repos for `AchillesIDE`, `proxies`, and `webmeetInfra`.
2. Put a test agent manifest on `embedded-soul-gateway`.
3. Run `ploinky start fixture/explorer --branch embedded-soul-gateway`.
4. Assert `.ploinky/repos/fixture` and `.ploinky/repos/proxies` are on the
   requested branch.
5. Assert `.ploinky/repo_sources.json` records the branch.
6. Assert `--repo-branch webmeetInfra=main` keeps that repo on main.
7. Assert dirty checkout refusal.
8. Assert `--reset-repos` performs the hard reset only under `.ploinky/repos`.

Also rerun targeted existing suites:

```bash
node --test tests/unit/profileSystem.test.mjs \
  tests/unit/workspaceDependencyGraph.test.mjs \
  tests/unit/runtimeResourcePlanner.test.mjs
```

Run fast startup coverage if the branch-aware start path changes startup
control flow:

```bash
tests/fast/test_all.sh
```

## Rollout Plan

1. Implement parsing and branch policy helpers without changing runtime startup.
2. Replace bootstrap's raw clone path with branch-aware repo helpers.
3. Wire branch policy into `start`.
4. Add manifest repo object and prefixed dependency repo auto-install support.
5. Add docs and DS updates.
6. Update the Explorer deploy workflow to use the new command.
7. Validate locally with unit tests and at least one scratch workspace.
8. Validate deployment through GitHub Actions on a non-production workspace.

## Open Questions

1. Should `--branch` fallback default to `default` or `fail`?

   Recommendation: default to `default` for local developer convenience, but
   make deploy workflows pass `--branch-fallback fail`.

2. Should `--branch` apply to every repo involved in startup, or only repos
   without an explicit branch?

   Recommendation: apply it as a candidate after explicit repo and manifest
   branch overrides. This keeps one-branch feature deployments short while
   preserving per-repo control.

3. Should Ploinky store the branch in enabled-agent records?

   Recommendation: no for phase 1. Store branch on repo sources, because branch
   selection belongs to the checkout, not to individual agent instances.

4. Should `ploinky start explorer --branch X` support unqualified `explorer`
   before any repo exists?

   Recommendation: yes. Branch-aware bootstrap should clone `AchillesIDE` at X
   first, after which normal short-name resolution can find `explorer`.

