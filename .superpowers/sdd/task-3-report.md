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
