# Independent Review: No-Wait Agent Loading-Page Implementation Plan

Status: complete and closure-approved. Every substantiated finding was accepted and incorporated into the implementation plan before implementation dispatch.

Review date: 2026-08-27.

Independent Codex task: `01a043d5-8add-7fe0-a05d-354d04efac0a` (`Review no-wait loading plan`).

Reviewed artifact: `proposals/no-wait-agent-loading-page-implementation-plan.md`.

Initial verdict: `CHANGES REQUIRED` — no P0 findings; three P1, three P2, and two P3 findings. Final read-only closure verdict after amendment: `APPROVE`.

The review was strictly read-only. It did not edit files, create or switch branches, commit, push, deploy, or mutate fixtures.

## Disposition

| Severity | Finding | Evidence validated against current code/policy | Disposition in amended plan |
| --- | --- | --- | --- |
| P1 | Lifecycle observation occurred before authorization | The draft's original flow and dispatch order observed no-wait state before `ensureHttpRouteAccess`. Current failed plans return at `cli/server/RoutingServer.js:389`, while route access occurs near `RoutingServer.js:545`; `CLAUDE.md:21` requires the same authenticated route policy/ACL. | Accepted. Sections 5, 7.2, 9, 10, 12.4, 18, and 19 now require request classification without lifecycle I/O, successful route authorization, lease revalidation, then observation. Resolver-spy tests prove zero lifecycle I/O for unsuccessful access and equivalent unauthorized output across all lifecycle states. |
| P1 | The claimed generation-bound no-wait identity did not exist | `readNoWaitRunMarker` validates run/time/wave/status name at `cli/commands/noWaitLogObserver.js:81`; `createNoWaitRunBinding` copies `instanceId` and `enableGeneration` from the current record at `noWaitLogObserver.js:113`; the final fence compares those copied values at `noWaitLogObserver.js:277`. Worker args at `cli/commands/noWaitWorkerArgs.js:14`, markers at `cli/commands/workspaceUtil.js:464`, process proof at `noWaitLogObserver.js:245`, and worker expected identity at `cli/commands/noWaitWorker.js:1655` omit the generation IDs. | Accepted. Section 7.1 makes end-to-end producer/observer hardening a prerequisite: exact staged identity is required in worker args, markers, every status, spawn failure, process identity, worker admission, and registry fence; superseding transitions retire the prior marker. Sections 11, 12.2, 17–19 add affected files, ownership, and generation-A/generation-B regressions. |
| P1 | Existing failure summaries were unsafe for browser disclosure | `summarizeNoWaitFailure` includes producer error text at `cli/commands/noWaitLogObserver.js:136`. `cli/utils/diagnosticText.js:11` redacts credential-shaped values and controls but does not remove paths, URLs, ports, images/containers, or topology. Spawn/worker exceptions are persisted at `cli/commands/workspaceUtil.js:487` and `cli/commands/noWaitWorker.js:1842`. | Accepted. Sections 7.3, 8.2, 8.5, 12.2, 18, and 19 prohibit producer diagnostics in browser responses and use only allowlisted codes with constant generic copy. Detailed bounded summaries remain Marketplace/operator-only. Hostile diagnostic tests cover paths, URLs/query data, PIDs, images/containers, ports, stacks, secrets, and controls. |
| P2 | A successful permanently targetless agent could poll forever | `network.mode: none` intentionally publishes no ports at `cli/utils/agents.js:525`. The worker can publish `running` with `hostPort: null` at `cli/commands/noWaitWorker.js:1797` and `noWaitWorker.js:1824`. | Accepted after closure correction. Sections 7.2–7.3, 8.1–8.2, 8.5, 9, 12.3, 13, 18, and 19 exclude permanently targetless contracts from a new loading-page navigation but deliberately admit an existing startup probe through authorization, lease validation, and exact observation so it can receive fixed terminal `route_unavailable`. A deterministic `network:none` regression proves polling terminates. |
| P2 | The browser gate was timing-racy and could not produce its required trace | The existing fixture uses `setTimeout` at `tests/test-functions/workspace_dependency_startup_tests.sh:77`; the draft depended on starting Playwright “immediately.” Shared Explorer config sets `trace: 'off'` at `AssistOSExplorer/tests/smoke/playwright.config.mjs:42`, while the Copilot spec demonstrates explicit redacted tracing at `specs/05-copilot-folder-launch.spec.mjs:125` and `:262`. | Accepted. Sections 13 and 14 replace timing with a test-owned blocked/release latch. Playwright releases readiness only after proving the initial `503` and a `202` probe. The feature spec explicitly starts/stops redacted tracing, attaches it, and asserts the artifact exists. Timers are watchdogs only. |
| P2 | Explorer branch/worktree isolation was not mechanically complete | The smoke runner does not verify its Git revision. `ploinky/CLAUDE.md:34` and `:56` require participating repositories and runner source to be recorded/default-pinned. `AssistOSExplorer/CLAUDE.md:3` identifies `AssistOS-AI/AssistOSExplorer` as canonical, while the planning checkout's `origin` is a distinct `PloinkyRepos` mirror. | Accepted. Sections 3.2, 14, 15, 18, and 19 require three separate checkouts: Ploinky feature, Explorer feature-test, and clean canonical-default Explorer release runner. Every gate records and verifies canonical URL, symbolic HEAD, branch/upstream, exact SHA, and clean status. The user's existing Explorer checkout is never switched in place. |
| P3 | Dedicated-host behavior was only tested at route-plan level | Dedicated public hosts have separate host-first selection, bare-path canonicalization, and surface precedence in `cli/server/edgeRoutePlan.js:72`, `:371`, and `:702`. | Accepted. Section 12.5 now requires a full control-host and dedicated-host Router matrix across access decisions and lifecycle states, including bare URL retention, same-URL probing, generation rotation, and Router/MCP surface exclusion. |
| P3 | The named header unit test exercised the wrong proxy path | Ordinary agent-root forwarding uses `stripRouterIdentityHeaders` at `cli/server/routerHandlers.js:145` and `:282`. `tests/unit/proxyHeaders.test.mjs:4` exercises the separate agent-port `sanitizeRequestHeaders` path. | Accepted. Sections 11, 12.5, 18, and 19 require focused ordinary `proxyHttpPassthrough`/`stripRouterIdentityHeaders` coverage, retain the agent-port sanitizer case, and prove header absence in the live upstream capture. |

## Observed

The reviewer confirmed that the proposed Router-owned `agent-root-pending` plan kind is feasible. It also confirmed that a tracked test-only Explorer branch can coexist with the canonical release gates when the runner checkouts are physically separated and revision-pinned.

The original plan already captured the required pushed Ploinky candidate, literal fresh `~/work/testExplorerFresh` deployment, loaded AgentLib and immutable image/revision evidence, separate OnlyOffice/Copilot/WebMeet gates, and full fresh reruns after any failed candidate.

## Inferred

The P1 findings were release-blocking because they invalidated the draft's authorization, stale-generation, and disclosure guarantees. The P2/P3 findings were also accepted because the supported runtime and current test harness made the failure modes concrete, even where production frequency was unknown.

## Unknown / deferred to implementation evidence

The implementation must still select the smallest crash-consistent marker-retirement sequence after reopening the registry transaction seam. It must also validate browser console behavior for a main-document `503`, choose the narrowest compatible `frame-ancestors` policy, and resolve fresh-fixture credentials/image/release pins without exposing secrets.

## Final review disposition

The first closure pass found one contradiction in the targetless-probe dispatch path. That contradiction was corrected by separating initial-navigation eligibility from existing-probe terminalization. The reviewer then verified the exact authorization, pre-observation lease, hardened observation, post-observation lease, and terminal-response path and returned `APPROVE` without reopening any of the other seven findings.

No finding was rejected or deferred out of scope. The amended plan resolves all eight valid findings and is ready to be handed to an independent implementation task. Implementation must still verify the amended assumptions against its freshly fetched branch base before editing.
