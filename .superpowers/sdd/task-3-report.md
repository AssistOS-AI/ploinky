# Packet 3 Report: Compiled Generation Route Authority

## What Changed

Request-time HTTP service collection now returns cloned entries from the active generation's `compiled.services` table. Explicit routing/manifests input continues to use the existing compile-time/test helper behavior.

`edgeRoutePlan.js` now consumes only compiled service entries under its captured generation lease. It no longer imports or calls `collectHttpServiceRoutes` or `resolveHttpServiceTarget`; service plans use their compiled `definition.target` and return the existing `TARGET_INACTIVE` denial before any HTTP, SSE, or WebSocket dial when that target is absent or invalid.

The generation compiler now preserves the minimal normalized service metadata required by the established proxy contract: provider route identity and normalized delegations. This was necessary because the old request-time reconstruction had supplied those fields from manifests; retaining them in the compiled generation preserves invocation signing and delegation behavior without mutable manifest reads.

Focused tests prove that default collection ignores a manifest changed after generation, source-level planner authority is compiled-only, and both primary and explicit private service ports expose the compiled target in request plans.

## Tests Run

### RED: Task 3.1

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/httpServiceInvocation.test.mjs
```

Result: 30 passed, 1 failed. The new `default HTTP service collection consumes active compiled services without re-reading manifests` test failed as expected because `definitions[0].target` was `undefined` rather than the compiled private target.

### GREEN: Task 3.1

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/httpServiceInvocation.test.mjs
```

Result: 31 passed, 0 failed.

### RED: Task 3.2

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs
```

Result: 52 passed, 3 failed. The intended failures were the source assertion finding `collectHttpServiceRoutes` in `edgeRoutePlan.js` and the new primary-target assertion finding no `definition.target`. The third failure was a fixture characterization update: adding `metrics` correctly added `metrics.alpha.localhost` to the compiled aliases.

An interim run after the planner-only change exposed eight failures in the same command: compiled definitions lacked existing proxy-required provider route identity and normalized delegation data. That confirmed those fields had to be compiled rather than reconstructed at request time.

### GREEN: Task 3.2 and Final Verification

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky
node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs
git diff --check
```

Result: 55 passed, 0 failed. `git diff --check` produced no output and exited successfully.

## Files Changed

- `cli/server/httpServiceRoutes.js`
- `cli/server/edgeRoutePlan.js`
- `cli/services/edgeGeneration.js`
- `tests/unit/httpServiceInvocation.test.mjs`
- `tests/unit/edgeRoutePlanInterface.test.mjs`
- `tests/unit/edgeHostRouting.test.mjs`
- `.superpowers/sdd/task-3-report.md`

## Self-Review Findings

No request-time planner path reads manifests or re-normalizes service definitions. `edgeRoutePlan.js` contains no `collectHttpServiceRoutes` or `resolveHttpServiceTarget` reference. Target validation occurs after policy evaluation and before plan success, preserving lease handling and zero-dial stale/inactive behavior. Default service collection and route planning deep-clone compiled definitions so callers cannot mutate the leased snapshot.

The explicit compile-time helper mode remains intact. Existing HTTP invocation, WebSocket proxy, and lease tests remain green.

## Concerns

`cli/services/edgeGeneration.js` was not named in the Task 3.1 or Task 3.2 file lists, but the reset plan's Packet 3 section includes it and the exact green suite demonstrated it was necessary. The change is limited to compiling service metadata already consumed by the pre-existing proxy contract; it does not add a new request-time authority or broaden the packet into bootstrap, publication, or routing-schema work.

## Review Finding Fix: Delegation `queryPathRoots` Compatibility

The generation compiler now accepts the established `when.queryPathRoots` alias and emits canonical, non-empty `when.pathRoots` values in compiled service delegations. This preserves authenticated HTTP service delegation behavior without reopening request-time manifest reads.

### RED

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test --test-name-pattern='generation canonicalizes delegation queryPathRoots aliases' tests/unit/edgeGenerationHardCut.test.mjs
```

Result: 0 passed, 1 failed as expected. `applyEdgeRoutingGeneration()` rejected the supported alias with `manifest(alpha).httpServices[0].delegations[0].when is invalid` from `normalizeCompiledDelegations()`.

### GREEN

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs tests/unit/edgeGenerationHardCut.test.mjs
git diff --check
```

Result: 101 passed, 0 failed. `git diff --check` produced no output and exited successfully. The focused generation test verifies `queryPathRoots: ['/Confidential', 'Confidential/', '']` compiles to `pathRoots: ['/Confidential']` with the default `queryParam: 'path'`.

## Re-review Fix: Delegation Normalization Parity

The generation compiler now keeps explicit `ttlSeconds: 0` through validation instead of replacing it with the default TTL, and it applies the existing delegation normalizer's truthy `scopes` precedence before accepting a `scope` fallback. A truthy non-array `scopes` value therefore normalizes to an empty list and fails generation even when `scope` is otherwise valid.

### RED

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test --test-name-pattern='generation rejects delegation' tests/unit/edgeGenerationHardCut.test.mjs
```

Result: 0 passed, 1 failed as expected. `generation rejects delegation ttlSeconds below the minimum` failed because `applyEdgeRoutingGeneration()` completed without throwing for `ttlSeconds: 0`.

### GREEN

Commands:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test tests/unit/edgeGenerationHardCut.test.mjs
node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs tests/unit/edgeGenerationHardCut.test.mjs
git diff --check
```

Result: focused generation tests: 48 passed, 0 failed. Packet 3 suite: 103 passed, 0 failed. `git diff --check` produced no output and exited successfully.

### Concerns

None.

## Re-review Fix Addendum: Shared Delegation Normalization

Generation now shares the established delegation pre-normalizer, preserving case-insensitive first-seen tools/scopes and filtering `delegations: [{}]` before compiler target validation. Publication-shaped-field rejection is unchanged.

Command: `node --test --test-name-pattern='generation (case-insensitively deduplicates delegation tools and scopes|filters no-op authenticated service delegations)' tests/unit/edgeGenerationHardCut.test.mjs`.

RED result: 0 passed, 2 failed as expected; case variants remained duplicated and the no-op entry was rejected for an invalid target.

Commands: `node --test tests/unit/edgeGenerationHardCut.test.mjs`; `node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs tests/unit/edgeGenerationHardCut.test.mjs`; `git diff --check`.

GREEN result: 50 focused generation tests passed; 105 Packet 3 tests passed; `git diff --check` exited successfully with no output.

Concerns: None.

## Review Fix: Restore Task 1 Report

Restored `.superpowers/sdd/task-1-report.md` as a tracked file using the exact content from `e975389`. No runtime source or product tests were changed.

### Verification

Commands:

```bash
git diff --name-status e975389..HEAD -- .superpowers/sdd/task-1-report.md
node --test tests/unit/httpServiceInvocation.test.mjs tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/wsServiceProxy.test.mjs
git diff --check
```

Results: the focused suite passed with 55 tests and 0 failures; `git diff --check` produced no output and exited successfully. The path comparison is expected to show no deletion after this fix commit.

### Files Changed

`.superpowers/sdd/task-1-report.md` was restored and `.superpowers/sdd/task-3-report.md` received this fix report.

### Concerns

None.

## Re-review Fix: Shared Delegation Normalization

The generation compiler now consumes the established HTTP-service delegation normalizer before applying its existing generation-specific checks. This preserves case-insensitive, first-seen de-duplication for tools and scopes, and filters no-op delegation entries before target validation. Publication-shaped service-field rejection remains in the generation compiler.

### RED

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test --test-name-pattern='generation (case-insensitively deduplicates delegation tools and scopes|filters no-op authenticated service delegations)' tests/unit/edgeGenerationHardCut.test.mjs
```

Result: 0 passed, 2 failed as expected. The first test retained case-variant duplicate tools and scopes; the second rejected `delegations: [{}]` with an invalid `targetAgentId` error.

### GREEN

Commands:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test tests/unit/edgeGenerationHardCut.test.mjs
node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs tests/unit/edgeGenerationHardCut.test.mjs
git diff --check
```

Result: focused generation tests: 50 passed, 0 failed. Packet 3 suite: 105 passed, 0 failed. `git diff --check` produced no output and exited successfully.

### Concerns

None.

## Re-review Fix: Falsy Delegation TTL Normalization

The generation compiler now matches `normalizeDelegation()` TTL normalization: a falsy `ttlSeconds` value, including numeric `0`, is treated as absent and compiles to the default TTL of `1800`. The existing truthy invalid `scopes` precedence behavior remains covered unchanged.

### RED

Command:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test --test-name-pattern='generation defaults falsy delegation ttlSeconds to 1800' tests/unit/edgeGenerationHardCut.test.mjs
```

Result: 0 passed, 1 failed as expected. `applyEdgeRoutingGeneration()` rejected `ttlSeconds: 0` with `manifest(alpha).httpServices[0].delegations[0].ttlSeconds is invalid` from `normalizeCompiledDelegations()`.

### GREEN

Commands:

```bash
cd /Users/danielsava/work/file-parser/ploinky/.worktrees/ploinky-phase1-http-router-proxy-mvp
node --test tests/unit/edgeGenerationHardCut.test.mjs
node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs tests/unit/edgeGenerationHardCut.test.mjs
git diff --check
```

Result: focused generation tests: 48 passed, 0 failed. Packet 3 suite: 103 passed, 0 failed. `git diff --check` produced no output and exited successfully.

### Concerns

None.

## Re-review Fix Addendum: Shared Delegation Normalization

Generation now shares the established delegation pre-normalizer, preserving case-insensitive first-seen tools/scopes and filtering `delegations: [{}]` before compiler target validation. Publication-shaped-field rejection is unchanged.

Command: `node --test --test-name-pattern='generation (case-insensitively deduplicates delegation tools and scopes|filters no-op authenticated service delegations)' tests/unit/edgeGenerationHardCut.test.mjs`.

RED result: 0 passed, 2 failed as expected; case variants remained duplicated and the no-op entry was rejected for an invalid target.

Commands: `node --test tests/unit/edgeGenerationHardCut.test.mjs`; `node --test tests/unit/edgeRoutePlanInterface.test.mjs tests/unit/edgeHostRouting.test.mjs tests/unit/edgeDialLease.test.mjs tests/unit/httpServiceInvocation.test.mjs tests/unit/wsServiceProxy.test.mjs tests/unit/edgeGenerationHardCut.test.mjs`; `git diff --check`.

GREEN result: 50 focused generation tests passed; 105 Packet 3 tests passed; `git diff --check` exited successfully with no output.

Concerns: None.
