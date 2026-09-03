# Adversarial Review: WebTTY-in-Ploinky-Core Implementation

Review date: 2026-08-28.

Scope: the `feature/webtty-core` candidate branches across four repositories, reviewed as implemented (read-only; no files edited, no branches switched, no deployment).

**Verdict: APPROVE WITH CHANGES.** Both previously-reported fixes are implemented and test-pinned, all seven findings from the plan review are resolved, the security constraints hold everywhere probed, and the packaging is stronger than the plan demanded. One composite **P1 availability defect** survives adversarial reading: closing a terminal while a foreground command runs (or any worker crash) triggers a feature-wide WebTTY outage that persists across Router restarts and clears only by Box recreation or manual record deletion. It is fail-closed — not a security hole — but it fires on routine use.

## Baselines

| Repository | Branch tip (verified = pushed) | Default branch at review time | Merge-base |
| --- | --- | --- | --- |
| ploinky | `07327ba01bd726147b3759e64fc7790b4fb9c782` | master @ `b99134ab` | `021d9a91` (behind master) |
| basic | `10d39d50a8b288eefff5298590743401e1c51d88` | main @ `e5c0393d` | `e5c0393d` (current) |
| container-image-builds | `233105b1bf65e6cb9ef4453bbeac725086d86797` | main @ `8a20d2c6` | `8a20d2c6` (current) |
| AssistOSExplorer | `5689b8697185c2db7cfc7a05934646df7aef0eab` (remote `assistos-ai`) | main @ `6acfa0bf` | `e7b55102` (behind main) |

Ploinky feature commits: `e39b36d9` (plan), `1d5e6ad0` (native contract), `143ddba5` (image admission), `0dce7830` (Router integration), `6ee1a013` (legacy listener retirement), `07327ba0` (PTY exit-identity polling fix). The ploinky working tree carried only the two allowed unrelated no-wait proposal files; they were preserved and ignored.

## Execution limitations (read first)

1. **The review prompt was truncated** mid-sentence at "Look for PID-reuse," — item 1 was treated as the PTY exit-identity fix (including PID-reuse hazards); item 2 was inferred from the constraints list as the cli-channel mutation-proof fix. The full-diff review covers whatever else the truncated list named.
2. **A harness safety classifier blocked all subagent launches and most Bash** (git diff/show, shasum, any test invocation) for the session. Despite the task permitting unit tests, **no test suite was executed**; this is an inspection-only review via file reads and greps, and every citation is personally reviewed. The lockfile pin and vendor hashes are verified as CI-enforced mechanisms (`ploinky/tests/unit/webttyNativeRuntime.test.mjs:59-60` recomputes the lockfile SHA-256 against the pinned constant; `ploinky/tests/unit/webttyAssets.test.mjs:22-23` re-hashes every vendor file), not locally recomputed. Run the suites from a fresh session.
3. Both feature branches are **based behind their current remote defaults** (see table) and the intervening default-branch commits could not be enumerated — a merge/rebase check is required before landing.
4. Native amd64/arm64 build + PTY probe evidence is obtainable only from the CI build gates (by design of the Dockerfile-embedded smoke); it could not and should not be produced locally.

## Findings

### P1-1 — Routine foreground-job closures (and worker crashes) cause a feature-wide WebTTY outage that survives Router restarts

The chain, each link verified by inspection:

| Link | Evidence |
| --- | --- |
| The live kill-path pins full topology including `foregroundProcessGroupId === pid` | `ploinky/core-services/webtty/process-identity.mjs:115-124` (`requirePtyTopology`), enforced immediately before every group signal at lines 183-194 |
| Any foreground job makes that false, so TERM/KILL are refused and the worker reports `cleanup-unproven` | `ploinky/core-services/webtty/terminal-worker.mjs:295-311` — non-STALE revalidation error → `reportCleanupUnproven()`; no signal is delivered, cleanup degrades to master-close SIGHUP |
| One `cleanup-unproven` disables the entire feature and force-closes every other terminal | `ploinky/cli/server/webtty/sessionManager.mjs:218-227` and `disableForUnprovenCleanup` at 437-448; `ready` is set only in `initialize()`, so the 503 persists until Router restart. A worker crash/OOM-kill takes the same path (`cleanupProven` false → lines 483-493) |
| The outage then survives Router restarts | `ploinky/cli/server/webtty/runtimeRecords.mjs:261-266` — `recoverEntry` refuses `cleanupState: 'unproven'` and `ptyState: 'pty-starting'` records **before** any liveness check, so even a record whose worker and PTY are provably dead (start-token semantics) blocks recovery forever. Clearing requires Box recreation or manual deletion under `/run/ploinky/webtty` |

Concrete scenario: an administrator runs `top`, a pager, or a long build; the tab closes, the DELETE keepalive fires, logout lands, or the idle timeout expires → bash's `tpgid` is the job's pgid, not bash's pid → refused signal → unproven → all admin terminals killed, `/webtty` 503 until the Box is recreated. Classification: availability/operational, explicitly **not** a security failure — every path fails closed and no unverified signal is ever sent.

Aggravating facts:

1. The behavior is deliberate and test-pinned — "cleanup revalidation ambiguity emits cleanup-unproven and never force-signals" (`ploinky/tests/unit/webttyTerminalWorker.test.mjs:183`), "one unproven cleanup quiesces every other live WebTTY session" (`ploinky/tests/unit/webttySessionManager.test.mjs:379`), "PTY evidence requires pid=pgrp=session=tpgid" (`ploinky/tests/unit/webttyProcessIdentity.test.mjs:50`) — but **no test models the routine trigger** of a foreground job at close time.
2. The implementation itself proves the `tpgid` pin unnecessary for kill safety: the recovery path's own verified group-kill (`ploinky/cli/server/webtty/runtimeRecords.mjs:242-250`) checks pid/uid/start-token/pgrp/session but **not** the foreground group.

Layered fix (any subset helps, all three recommended):

1. Drop `foregroundProcessGroupId` (job-control state, not group identity) from the live-kill revalidation so it matches the recovery path's own criteria.
2. On a refused signal, dispose the PTY master and then reuse the existing `waitForPtyProcessExit` liveness primitive to confirm death — the SIGHUP usually kills the session, converting today's "unproven" into "proven" with no new mechanism.
3. Reorder `recoverEntry` to run the both-processes-dead check before the state-based refusals so provably dead records self-heal at the next Router start.

Separately, consider scoping runtime unproven cleanup to per-session quarantine rather than feature-wide disable, per the plan's own §19 framing.

### P2-1 — PTY output does not count as activity, so an actively streaming terminal is idle-closed

`touch()` is called only from `input`, `resize`, and `attachStream` (`ploinky/cli/server/webtty/sessionManager.mjs:299-324, 391`); `onOutput` (345-366) never refreshes `lastActivityAt`, and the idle check at line 538 closes at 10 minutes. A build or `tail -f` producing continuous output with no keystrokes is closed mid-run — and because such a session almost always has a foreground job, this idle close is a reliable trigger for P1-1. Fix: refresh activity (rate-limited) on delivered output, or document that idle means input-idle and lengthen the default.

### P3 notes

| # | Note | Evidence |
| --- | --- | --- |
| P3-1 | `GET /webtty/assets/__proto__` (or `constructor`) resolves truthy through the frozen object's prototype, then `readFileSync(undefined)` throws → 503 instead of 404. No traversal or crash; use `Object.hasOwn` | `ploinky/cli/server/handlers/webtty.js:166-181` |
| P3-2 | `WEBTTY_IPC_BACKPRESSURE` maps to the default 503 `terminal_runtime_failure` rather than 429 | `ploinky/cli/server/webtty/workerClient.mjs:125-128`; handler `mapOperationError` at `ploinky/cli/server/handlers/webtty.js:125-142` |
| P3-3 | `subscribeInvalidation` runs after `sessions.set` outside the create try-block — if it ever threw, the session and quota slot would leak. Today it cannot throw (`ploinky/cli/server/auth/sessionEvents.js:3-7`); robustness note only | `ploinky/cli/server/webtty/sessionManager.mjs:208-211` |
| P3-4 | `cli/server/webchat/tty.js` and `cli/server/authHandlers/shared.js` are modified on the branch; current state reviewed and coherent (webchat's spawn/group-kill structure matches its pre-branch shape; shared.js exports match the new consumers) but the exact deltas were unverifiable with git blocked | Current-state inspection only |
| P3-5 | Box admission now runs a `podman run` PTY probe (60s timeout) at every Box start/reconciliation including already-present images — correct per plan; adds bounded seconds to Box start, never touches the request path | `ploinky/ploinky-box/contract/image.mjs:244-254, 311-343` |

## The two previously-reported fixes — independently verified

**Fix 1 (PTY exit identity polling): implemented as described.** Exit polling (`waitForPtyProcessExit` → `revalidatePtyProcessLiveness`, `ploinky/core-services/webtty/process-identity.mjs:153-218`) proves only exact PID + Linux start-token + non-zombie — no tty/session topology after TERM. ENOENT/ESRCH classify as stale→exited; **PID reuse** during polling yields a start-token mismatch and counts as exited, never as alive (a reused PID cannot reproduce the original's boot-tick start time); zombies count as exited; polling is deadline-bounded (500ms/10ms); `/proc` stat parsing splits on the last `)` so comm injection cannot confuse fields. Full topology **is** revalidated immediately before every negative-PID signal with an explicit no-async-between-proof-and-kill comment (lines 183-194), and the test suite pins "must not signal after topology becomes unsafe" (`ploinky/tests/unit/webttyProcessIdentity.test.mjs:189`). The only residue is the microscopic read-to-kill window inherent to non-pidfd kills — and P1-1 above, which concerns the *pre*-signal topology pin, adjacent to (not part of) this fix.

**Fix 2 (cli-channel mutation proof): implemented and test-pinned.** `/webtty` dispatches at `ploinky/cli/server/RoutingServer.js:610`, *before* the central gate that exempts `authChannel === 'cli'` (lines 618-621) — the handler is the sole enforcer and applies `verifyBrowserMutationRequest` unconditionally, before body reads, on POST sessions/input/resize and DELETE (`ploinky/cli/server/handlers/webtty.js:185, 237, 259, 279`), with `commitRouteGeneration` before allocation. CSRF minting is channel-agnostic (`ploinky/cli/server/authHandlers/authContext.js:679-703`, cli path 730-740), the client sends the explicit `X-Ploinky-Browser-CSRF-Token` header (`ploinky/cli/server/webtty/webtty.js:33-47`), and the exact scenario is tested: "local CLI administrator mutations require direct browser proof before body consumption" with `authChannel: 'cli'` and a real minted token (`ploinky/tests/unit/webttyHandler.test.mjs:72, 85, 149`).

## Resolution of the plan review's findings

| Prior finding | Status | Evidence |
| --- | --- | --- |
| P1-1 failure-semantics contradiction | **Resolved** — the Box-hard semantic is implemented (probe throws from admission; both new-image and already-present paths probe, `ploinky/ploinky-box/contract/image.mjs:324-343`) and the committed plan's §19 row was amended to match ("Box start or reconciliation is rejected before Router readiness", plan line 458) |
| P1-2 cli-channel gate bypass | **Resolved** — Fix 2 above |
| P2-1 seam table (both functions + lockstep test) | **Resolved** — `surfaceForPath` `ploinky/cli/server/edgeRoutePlan.js:496` *and* `isReservedRouterSurface` :521; lockstep test updated (`ploinky/tests/unit/httpRouteAccessPath.test.mjs:43, 52`); hard-cut tests cover selected root, local origin, `ROUTE_SURFACE_DENIED` on non-selecting hosts, and the `/webtty?agent=` shadow (`ploinky/tests/unit/edgeGenerationHardCut.test.mjs:896-969`) |
| P2-2 retirement consumers | **Resolved** — count 20→19 plus new absence assertions incl. `controlPorts` 7681 (`ploinky/container/listener-inventory-tests.mjs:704, 719-728`); `basic` rows gone from both QA workflows; the contract test asserts the `webtty` surface and forbids the old agent-port route (`AssistOSExplorer/tests/smoke/lib/deploy-workflow-contract.test.mjs:66, 149`); public-exposure test flipped to absence (`AssistOSExplorer/explorer/tests/unit/explorerManifestPublicExposure.test.js:29-39`) |
| P2-3 guard rails + existing-image probe | **Resolved** — reproduce workflow untouched so its anti-`runtime-contract` guard stands (`container-image-builds/tests/box-transport-entrypoint.test.mjs:49`); the source-boundary test was *strengthened* (exact three webtty COPY lines plus a negative lookahead forbidding any other ploinky source, lines 20-24); native evidence lives in build-stage gates on native runners |
| P3s (npm symlink, e2e gap, record scope) | npm/npx symlinked (`container-image-builds/images/ploinky-box/Dockerfile:18-19`); a real Playwright release gate was added exercising the canonical `local:admin`, `/webtty/?dir=`, `/workspace/<relative>` cwd, input round-trip, and ordinary-user denial (`AssistOSExplorer/tests/smoke/specs/01-webtty-core.spec.mjs:134-172` — read only, not executed); record-scope conservatism became part of new P1-1 |

## Constraint compliance and confirmations (all verified by inspection)

| Constraint | Result |
| --- | --- |
| node-pty compiled and packaged inside the immutable `ploinky-box` at `/usr/local/lib/ploinky/webtty`; no helper image; no runtime npm | Confirmed — builder stage derived from the exact runtime rootfs; final rootfs rebuilt from the pristine base so no compiler state can leak; in-Dockerfile hygiene gates (no cc/gcc/make, no npm caches, no C sources, exactly one `.node`); root-owned read-only tree; digest-pinned Node 24; build-time PTY smoke plus a second verify probe; build-generated `runtime-contract.json` with the lockfile SHA pinned in source and CI-recomputed (`container-image-builds/images/ploinky-box/Dockerfile:126-206`). `images/webtty-agent` deleted with absence tests (`container-image-builds/tests/image-definitions.test.mjs:110-115`); admission errors instruct image pull/rebuild only |
| Same-origin `/webtty` Router surface; no port 7681, no independent listener/service | Confirmed — surface rides the existing Router origin via SSE + POST; zero 7681/listener/EXPOSE/LABEL/VOLUME hits across the diffs; retirement complete with absence tests |
| No privileged mode, engine socket, additional bind, capability, SUID addition, host publication, or confinement relaxation | Confirmed — no changes to the Box create args or publications; the `rpm --setcaps shadow-utils` line is the pre-existing nested-rootless mechanism, not a WebTTY addition |
| Administrator-only, 403 for ordinary users at page and API | Confirmed — `ploinky/cli/server/handlers/webtty.js:73-77, 151` (401 unauthenticated / 403 authenticated non-admin, before anything else); Explorer launcher admin-gated presentation-only via one shared predicate (`AssistOSExplorer/explorer/services/auth/adminUser.js`, consumed by menu contributions, main.js, avatarApi — no duplicated `local:admin` predicates remain) |
| Workspace bind at `/workspace`; Explorer directory → `/workspace/<relative>`; no additional host filesystem access | Confirmed — cwd pipeline clean against the full attack checklist (no server-side decode anywhere, pre-normalization rejections of NUL/backslash/absolute/drive/`..`, realpath containment both Router-side and worker-side immediately before spawn, `ploinky/core-services/webtty/cwd.mjs`); launcher sends slash-stripped workspace-relative `dir` (`AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp.js:1736-1750`); smoke gate asserts `/workspace/<relative>` cwd |
| Browser mutations enforce session/origin/CSRF/host/generation proof including cli-channel local:admin | Confirmed — Fix 2 above |
| No secret inheritance by workers/shells | Confirmed and stronger than planned — fixed constant env sets with pinned values, worker-side exact-equality re-assertion (`ploinky/core-services/webtty/environment.mjs`), inherited-secrets canary test (`ploinky/tests/unit/webttyEnvironment.test.mjs:12-26`); worker fork env explicitly constructed (`ploinky/cli/server/webtty/workerClient.mjs:52-63`) |
| Session management bounds and ownership | Confirmed — exactly-once quota release on every failure path; epoch/host/generation/activation-bound ownership with non-enumerating 404s; bounded replay with explicit `reset` on gaps; single-stream replacement; backpressure closure; tombstoned idempotent DELETE; 5s lease revalidation plus event-driven logout closure wired into local revoke, policy change, and all SSO invalidation paths (`ploinky/cli/server/auth/localService.js:338-357`; genericAuthBridge emits at 302/320/363/372) |
| Vendored terminal assets | Confirmed — maintained `@xterm/xterm` 6.0.0 / `@xterm/addon-fit` 0.11.0 with per-file SHA-256 and licenses (`ploinky/cli/server/webtty/vendor/manifest.json`), CI re-hash test, no CDN, no inline script, no new cookie or storage |

## Observed / Inferred / Unknown

**Observed:** everything cited above — no subagents ran; every citation is from direct reads/greps of the checked-out branches at the verified tips.

**Inferred:** the P1-1 foreground-job scenario (standard bash job-control semantics — `tcsetpgrp` makes `tpgid` differ during any foreground command — applied to the verified code chain; the chain itself is fully observed); severity judgments.

**Unknown / not verifiable in this session:** unit/system test results (execution blocked — the deterministic assertions cited are by inspection); native amd64/arm64 build+probe evidence (CI-only by design); exact branch deltas for `webchat/tty.js` and `authHandlers/shared.js`; the content of the intervening default-branch commits for the merge check; anything in the truncated portion of the prompt beyond the stated interpretation.

## Verdict

**APPROVE WITH CHANGES** — fix P1-1 (relax the live-kill `tpgid` pin to match the recovery path's own criteria, prove death after refused signals via the existing liveness primitive, and let recovery remove provably-dead unproven records) and P2-1 (output-as-activity) before release; run the full unit suites and the native CI gates on the exact candidates, since none could be executed in this session.
