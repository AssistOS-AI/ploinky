# Task 4 Report: Fresh Edge Source Classifier and Entry-Order Guards

## Status

DONE

## Commit

`cc45dfc Fail closed fresh edge source initialization`

## What I Implemented

- Extended fresh edge source classification so persisted generation evidence and legacy bootstrap residue are described explicitly. The classifier now recognizes the active selector, topology marker, non-empty edge/topology generation directories, `.bootstrap-transaction.json`, and `.bootstrap.lock.release-*` entries.
- Kept bootstrap fail-closed: a partial source tuple or any evidence/residue throws `EDGE_GENERATION_SOURCE_UNAVAILABLE` before source creation. The error directs the operator to destroy and recreate with a clean workspace volume, or restore a complete backup. No repair, rollback, cleanup, or residue removal was added.
- Added regression coverage for a partial source tuple and all four required evidence/residue cases, including no source creation and residue preservation assertions.
- Added the workspace start and agent-enable preparation source-order guard. Existing production ordering was already correct, so no `workspaceUtil.js` or `agents.js` change was needed.

## TDD Evidence

### Task 4.1 RED

Command:

```bash
node --test tests/unit/edgeGenerationHardCut.test.mjs
```

Observed result: 50 passed and 2 failed out of 52 tests. The partial-source test received the existing incomplete-state error but it lacked destroy/recreate clean-workspace guidance. The evidence/residue test failed because the active selector was not identified as generation evidence in the diagnostic; legacy bootstrap residue was likewise not classified.

### Task 4.1 GREEN

Command:

```bash
node --test tests/unit/edgeGenerationHardCut.test.mjs
```

Observed result: 52 passed, 0 failed. The new partial-source and evidence/residue tests passed together with the existing focused edge-generation suite.

### Task 4.2 Guard

Command:

```bash
node --test tests/unit/workspaceDependencyGraph.test.mjs
```

Observed result: 42 passed, 0 failed. The new guard passed without a production ordering change: `startWorkspace()` classifies before generation inactivation, router-port persistence, and manifest repository preparation; `prepareAgentEnableBatch()` classifies before agent/routing reads and the edge apply lock.

## Verification

| Check | Result |
| --- | --- |
| `node --test tests/unit/edgeGenerationHardCut.test.mjs` | PASS, 52/52 |
| `node --test tests/unit/workspaceDependencyGraph.test.mjs` | PASS, 42/42 |
| `git diff --check` before commit | PASS, no output and exit 0 |
| Scoped self-review | PASS, no Task 4 findings |

## Files Changed

- `cli/services/edgeGeneration.js`
- `tests/unit/edgeGenerationHardCut.test.mjs`
- `tests/unit/workspaceDependencyGraph.test.mjs`

## Self-Review Findings

No findings. The all-four-present no-op remains ahead of evidence checking, all-four-absent with no evidence still creates exactly the four sources, and every partial/stale path exits before source installation. The change adds no bootstrap transaction, journal, rollback, repair, cleanup, lock-release protocol, or host publication behavior.

## Concerns

None.

## Review Finding Fix: Documentation Alignment

### What Changed

- Updated `docs/specs/DS005-routing-and-web-surfaces.md` and `docs/architecture.html` to describe the all-absent-only bootstrap state machine: initialization is allowed only when all four persisted source documents are absent and there is no generation evidence or legacy bootstrap residue.
- Documented that a partial source set, generation evidence, or legacy bootstrap residue fails closed with `EDGE_GENERATION_SOURCE_UNAVAILABLE`, leaves existing files untouched, and requires destroy/recreate with a clean workspace or restoration from a complete backup.

### Verification

- `rg -n "explicit repair|automatic repair|partial set or retained generation evidence" docs/specs/DS005-routing-and-web-surfaces.md docs/architecture.html` — no matches (exit 1, the expected `rg` result for an empty match set).
- `node --test tests/unit/edgeGenerationHardCut.test.mjs tests/unit/workspaceDependencyGraph.test.mjs` — 94 passed, 0 failed.
- `git diff --check` — no output and exit 0.

### Files Changed

- `docs/specs/DS005-routing-and-web-surfaces.md`
- `docs/architecture.html`
- `.superpowers/sdd/task-4-report.md`

### Matrix And Frontmatter

DS005 frontmatter was unchanged, so `docs/specs/matrix.md` was not regenerated.

### Concerns

None.

## Review Finding Fix: Complete Tuple No-Op Clarification

### What Changed

- Clarified `docs/specs/DS005-routing-and-web-surfaces.md` and `docs/architecture.html` so a complete four-file source tuple remains a bootstrap no-op.
- Clarified that bootstrap initializes the four source files only when all four are absent and no persisted generation evidence or legacy bootstrap residue exists.
- Clarified that partial source sets fail closed, and that generation evidence or legacy bootstrap residue fails closed when the source tuple is absent or partial, with `EDGE_GENERATION_SOURCE_UNAVAILABLE`, untouched files, and destroy/recreate with a clean workspace or complete-backup restore as the required operator path. No automatic repair is documented.

### Verification

- `rg -n "explicit repair|automatic repair|Any partial source set, generation evidence, or legacy bootstrap residue fails closed" docs/specs/DS005-routing-and-web-surfaces.md docs/architecture.html` — no matches (exit 1, the expected `rg` result for an empty match set).
- `node --test tests/unit/edgeGenerationHardCut.test.mjs tests/unit/workspaceDependencyGraph.test.mjs` — 94 passed, 0 failed.
- `git diff --check` — no output and exit 0.

### Files Changed

- `docs/specs/DS005-routing-and-web-surfaces.md`
- `docs/architecture.html`
- `.superpowers/sdd/task-4-report.md`

### Matrix And Frontmatter

DS005 frontmatter was unchanged, and `docs/specs/matrix.md` was not touched.

### Concerns

None.

## Review Finding Fix: Complete Tuple Validation Before Router Startup

### What Changed

- Moved the existing `ensureRouterReadyForStart()` call in `startWorkspace()` to immediately after the first inactive `ensureGraphNodesEnabled()` preparation.
- Kept `initializeFreshEdgeRoutingSources()` unchanged: a complete four-source tuple remains a bootstrap no-op with no repair, rollback, cleanup, retry, or new classifier validation.
- Updated the workspace dependency-graph source-order guard to require normal graph preparation before the Router/Watchdog startup call. That preparation reaches `prepareAgentEnableBatch()`, the existing owner of complete-tuple parse/schema validation.
- Updated DS005 and the architecture page to state that malformed, unreadable, or inconsistent complete state stops startup before Router/Watchdog launch through normal generation preparation.

### TDD RED

Command:

```bash
node --test tests/unit/workspaceDependencyGraph.test.mjs
```

Observed result: 41 passed and 1 failed out of 42 tests. The new `workspace graph preparation precedes Router startup and every agent startup` guard failed with `normal graph preparation must reject malformed complete edge sources before Router startup`, proving the prior source order launched the Router first.

### GREEN And Focused Verification

| Check | Result |
| --- | --- |
| `node --test tests/unit/workspaceDependencyGraph.test.mjs` | PASS, 42/42 |
| `node --test tests/unit/edgeGenerationHardCut.test.mjs tests/unit/workspaceDependencyGraph.test.mjs` | PASS, 94/94 |
| `git diff --check` | PASS, no output and exit 0 |

### Files Changed

- `cli/services/workspaceUtil.js`
- `tests/unit/workspaceDependencyGraph.test.mjs`
- `docs/specs/DS005-routing-and-web-surfaces.md`
- `docs/architecture.html`
- `.superpowers/sdd/task-4-report.md`

### Matrix And Frontmatter

DS005 frontmatter was unchanged, so `docs/specs/matrix.md` was not regenerated.

### Concerns

None.
