# Implementation Plan: Generic Loading Page for Booting No-Wait Agents

Status: implemented and pushed on the dedicated feature branch; focused and live integration verification, the feature-specific browser transition, and all three fresh canonical Explorer release gates passed. The complete canonical Ploinky suite remains an explicitly directed skip/deviation.

Plan date: 2026-08-27.

Independent review: Codex task `01a043d5-8add-7fe0-a05d-354d04efac0a`, completed 2026-08-27 with initial `CHANGES REQUIRED`. All eight substantiated findings were incorporated; after one closure-pass correction, the reviewer returned final `APPROVE`. The disposition record is in `proposals/no-wait-agent-loading-page-implementation-plan-review.md`.

Primary implementation repository: `ploinky`.

Production branch name: `feature/no-wait-agent-loading-page`.

Test-only browser branch, if the tracked Playwright regression is added to the Explorer smoke suite: `test/no-wait-agent-loading-page-e2e` in `AssistOSExplorer`.

## 1. Outcome

Ploinky's Router will render a generic, self-contained loading page when an authorized browser navigates to the ordinary HTTP route of an exact no-wait agent whose current background run is positively verified as pending or starting. The browser remains on the requested URL, polls that same route through a Router-owned startup probe, waits until one ready edge generation remains stable for a settling window, and reloads into the real agent application automatically.

The implementation remains generic. It must not name WebMeet, Explorer, or any other optional agent in Ploinky core. It must preserve route policy, guest scoping, host-first selection, immutable generation leases, and current structured failure behavior for API, MCP, WebSocket, asset, and other non-document traffic.

The change is incomplete until it has been implemented on a separate feature branch, committed and pushed as an exact candidate, exercised by a deterministic browser E2E test that observes the loading-to-application transition, and passed the fresh Explorer deployment plus all three mandatory headless release gates in `ploinky/CLAUDE.md`.

## 2. Verified planning baseline

The planning checkout was inspected on 2026-08-27 with the following state:

| Repository | Planning checkout | Relevant observation |
| --- | --- | --- |
| `ploinky` | `feature/webtty-core` at `6ee1a013` | Clean checkout. The current branch changes `RoutingServer.js` and `edgeRoutePlan.js` for WebTTY, so it must not be used accidentally as this feature's branch point. |
| `ploinky` remote default | `origin/master` at `19c86a1a` | The no-wait route and early `TARGET_INACTIVE` behavior also exist on the default branch. |
| `AssistOSExplorer` | `feature/webtty-core` | Clean checkout. Its WebMeet wait route is a reference implementation, not a production dependency for the Ploinky change. |

Implementation must not assume these commit IDs remain current. The implementation task must fetch remotes, record the then-current exact branch points, and re-open the named seams before editing.

## 3. Branch, worktree, commit, and E2E isolation

### 3.1 Production branch

The implementation session must use an independent Codex worktree and a dedicated Ploinky branch. It must not add this work to `feature/webtty-core`, `master`, `ploinky-proxy`, or another existing feature branch.

The branch procedure is:

1. Verify that the Ploinky checkout used as the source is clean. Preserve unrelated user changes and stop if they overlap this feature.
2. Fetch `origin` without rewriting local work.
3. Resolve and record `refs/remotes/origin/HEAD`, its default branch, and its exact commit.
4. Create `feature/no-wait-agent-loading-page` from the fetched default-branch commit. If that branch already exists, inspect it and reuse it only when it contains this feature and no unrelated work; otherwise stop rather than overwriting it.
5. Record the branch point, upstream, runtime version, and initial `git status --short --branch` in the E2E evidence directory.
6. Keep all Ploinky production code, fixtures, unit tests, integration tests, and proposal updates on that branch.
7. Commit and push the exact candidate before any release-candidate deployment. Do not test uncommitted production source in the fresh Explorer release gate.

The implementation must use the human repository identity already configured for commits and must not add AI/tool attribution or co-author footers.

### 3.2 Browser test and canonical release-runner worktrees

The production implementation does not require an Explorer runtime change. A deterministic browser regression does require a tracked Playwright spec because Playwright is owned by `AssistOSExplorer/tests/smoke`, not by Ploinky.

Use three mechanically separate checkouts throughout implementation and testing:

| Checkout | Required state and use |
| --- | --- |
| Ploinky feature worktree | `feature/no-wait-agent-loading-page`, created from the recorded fetched Ploinky canonical remote-default SHA; owns all production changes |
| Explorer feature-test worktree | `test/no-wait-agent-loading-page-e2e`, created from the recorded fetched `AssistOS-AI/AssistOSExplorer` canonical remote-default SHA; owns only the new smoke spec, test-only configuration/helper, and test documentation |
| Explorer canonical release-runner worktree | Clean checkout at the recorded `AssistOS-AI/AssistOSExplorer` canonical remote-default SHA; runs OnlyOffice, Copilot, and WebMeet and must never be switched to the test branch |

Identify the canonical Explorer remote by its repository URL and policy, not by assuming the local remote name: the planning checkout used `assistos-ai` for `AssistOS-AI/AssistOSExplorer` and `origin` for a separate `PloinkyRepos` mirror. Fetch the canonical remote, record its URL and symbolic default branch, and verify any mirror equivalence rather than assuming it. Never switch or edit the user's existing Explorer checkout in place.

Before every feature-specific or canonical gate, record the runner checkout's remote URL, symbolic remote `HEAD`, branch/detached state, upstream, exact commit, and clean status, then assert `HEAD` equals the intended recorded revision. The feature-test branch is feasible only as the runner for the dedicated loading-page gate; deployed Explorer source and all three authoritative release gates remain on the clean canonical-default checkout.

### 3.3 No merge during implementation

Passing the plan does not authorize merging to a default branch. The implementation task ends with pushed feature branches, exact commit evidence, and test results. Merge/release is a later explicit decision.

## 4. Current request and lifecycle flow

| Stage | Current behavior | Relevant seam |
| --- | --- | --- |
| Enable preparation | Creates the exact agent registry identity and stages its route with `hostPort: null`. | `cli/utils/agents.js`, `planAgentEnable` |
| Background worker | Publishes a run-scoped `starting` status, launches the runtime, and performs semantic readiness. | `cli/commands/noWaitWorker.js` |
| Activation | Publishes the real route only after readiness, then publishes terminal `running`. | `cli/commands/noWaitWorker.js`, `upsertRoute` |
| Observation | Validates run ID, start time, wave, status filename, worker process for active starts, and a current registry tuple. It currently copies `instanceId`/`enableGeneration` from the current record rather than proving that the marker and statuses were produced for that generation. | `cli/commands/noWaitLogObserver.js` |
| Route planning | Resolves the staged route, sees no valid `hostPort`, and returns failed `TARGET_INACTIVE` before evaluating route policy. | `cli/server/edgeRoutePlan.js`, `agentRootPlan` |
| HTTP dispatch | Converts the failed plan directly to a JSON `503`, before ordinary agent-route authentication. | `cli/server/RoutingServer.js`, `processRequest` |
| Existing UI workaround | Explorer's WebMeet toolbar opens an Explorer wait route, probes target and MCP readiness, then requires a stable Router generation before redirecting. | `AssistOSExplorer/explorer/shared/ui/agent-runtime-loader/agent-runtime-wait-route.js` |

Before Router startup state can rely on the observer, the implementation must extend the no-wait producer/observer protocol so the staged registry generation, worker arguments, marker, every status, process identity, and final registry fence all carry and prove the same immutable identity. It must not infer startup from an absent port, process existence alone, container state alone, logs, elapsed time alone, or Marketplace's presentation model.

## 5. Target request flow

```text
browser GET /<agent>/<document>
             |
             v
host-first route selection + immutable edge lease
             |
             v
route exists, but hostPort is not active
             |
             v
HTTP-only agent-root-pending plan with route policy decision
             |
             +-- non-document / MCP / WebSocket / API --> existing generic 503; no lifecycle I/O
             |
             v
classify document/probe eligibility without lifecycle I/O
             |
             v
same ensureHttpRouteAccess gate as the eventual agent document
             |
             +-- denied/not authenticated/wrong guest scope --> existing deny/login behavior; no lifecycle I/O
             |
             v
revalidate the captured edge lease
             |
             v
exact generation-bound no-wait marker + status + process + registry observation
             |
             +-- unknown/stale-unprovable/superseded/not-no-wait --> existing generic 503
             +-- cannot ever publish ordinary HTTP --> fixed authorized terminal-unavailable page
             |
             v
revalidate the captured edge lease again
             |
             v
self-contained 503 HTML page at the original URL
             |
             v
same-URL X-Ploinky-Agent-Startup-Probe GETs
             |
             +-- pending/starting --> 202 JSON; continue polling
             +-- verified failed --> terminal safe error + Retry
             +-- ready generation changes --> reset settling clock
             +-- same ready generation for 2500 ms --> location.reload()
             |
             v
normal active agent route, static read or proxy
```

## 6. Route-plan changes

### 6.1 Introduce an HTTP-only pending agent plan

Refactor `agentRootPlan` in `cli/server/edgeRoutePlan.js` so policy is compiled and evaluated after the exact route is selected but before an invalid target port is collapsed into a denial.

For `transport === "http"`, a selected non-disabled, non-draining route with no valid `hostPort` should return an `ok: true` plan with:

| Field | Required value |
| --- | --- |
| `kind` | `agent-root-pending` |
| Route identity | `routeKey`, captured `route`, canonical path, upstream path, host selection, listener |
| Authorization | The exact `decision` produced by the captured generation policy for the canonical path and method |
| Generation | Captured `lease` and `snapshot` |
| Target | No dialable target and no fabricated port |
| Diagnostic category | Internal fixed category such as `TARGET_INACTIVE`; do not expose lifecycle detail here |

WebSocket resolution must keep returning a failed inactive-target plan. The feature does not create a WebSocket waiting protocol.

### 6.2 Keep agent-plan classification explicit

Add or use a narrow helper for the two agent-root kinds instead of spreading string arrays through RoutingServer. Audit every `routePlan.kind === "agent-root"` check in HTTP, WebSocket, auth-context, forwarding, and tests. Only the HTTP authorization and pending-page path should accept `agent-root-pending`; any code that requires a target must continue to require active `agent-root`.

### 6.3 Lease rule

A pending plan is observational only. It authorizes no static-file read and no upstream dial. Before returning a startup HTML or JSON response based on a lifecycle observation, the Router must prove the captured lease is still current. An active readiness probe must call the normal route-plan commit check before reporting `ready`.

## 7. Exact no-wait startup-state resolver

Create a read-only server module, recommended path `cli/server/noWaitAgentStartupState.js`.

### 7.1 Mandatory producer/observer identity hardening

Current no-wait markers do not prove `instanceId` or `enableGeneration`: the observer copies those values from whichever registry record is current. The Router feature must not ship until the production no-wait identity protocol is hardened end to end.

Define one immutable identity containing `containerName`, `instanceId`, `enableGeneration`, `repoName`, `shortAgent`, normalized alias, `routeKey`, `runId`, `runStartedAtMs`, `waveIndex`, and exact run-scoped status filename. Then:

1. Capture it from the newly staged record and launch schedule before spawning a worker.
2. Add the generation and route identity fields as required, strictly parsed `noWaitWorkerArgs.js` flags; the worker must refuse missing, duplicated, malformed, or non-canonical identity values.
3. Publish the complete identity in the current marker, canonical status, every run-scoped pending/starting/running/failed status, spawn-failure status, and the worker process command identity.
4. Validate every field byte-for-byte in marker reading, `sameNoWaitRun`, binding creation, status observation, process proof, the worker's lifecycle admission check, and the final fresh registry fence. Terminal `running` and `failed` statuses require the same generation proof even when no live process remains.
5. Atomically retire the prior current marker before committing a superseding staged registry generation. Apply the same retirement on disable/remove/re-enable and on successful transitions that schedule no replacement no-wait worker. A crash or retirement failure must fail closed; a stale marker must never be paired with the next record.
6. Add protocol regressions in which a generation-A marker/status is combined with a generation-B record for marker-only pending, starting, running, failed, statusless, and spawn-failure cases. Every combination must be rejected as superseded/unverified.

Detailed Marketplace/operator diagnostics may continue to use the hardened observation. Browser responses use a separate fixed-code mapping described below.

### 7.2 Resolver input and identity validation

The resolver accepts a captured pending plan only after route access has succeeded, never an arbitrary route name supplied by the browser. It must:

1. Read `route.container` from the captured route.
2. Resolve that exact container in `plan.snapshot.agents`.
3. Require a record whose complete immutable identity agrees with the captured route/snapshot. Resolve its selected runtime profile and classify whether it can publish ordinary HTTP; this capability is an output used to distinguish `starting`/`running` from terminal `unavailable`, not a resolver-admission prerequisite.
4. Read the current no-wait marker using the hardened `readNoWaitRunMarker`.
5. Create the immutable binding using the hardened `createNoWaitRunBinding` and captured record.
6. Call `observeBoundNoWaitRun` with a fresh canonical registry reader so its final tuple fence remains authoritative.
7. Recheck the edge lease after observation and before returning any renderable state.

No request that fails route access may call this resolver or touch lifecycle files/processes.

### 7.3 Normalized result

| Observer outcome | Resolver outcome | Browser eligibility |
| --- | --- | --- |
| `pending` | `starting`, `queued: false` | Loading page allowed |
| `starting`, active wave | `starting`, `queued: false` | Loading page allowed |
| `starting`, queued barrier | `starting`, `queued: true` | Loading page allowed |
| `failed` | `failed` plus a browser-specific allowlisted failure code only | Authorized fixed-copy terminal page allowed |
| `running` while a fresh plan resolves an active ordinary HTTP target | `generation_changed` | Never claim ready from the stale pending plan; force a new route resolution |
| `running` under a runtime profile such as `network.mode: none` that cannot publish ordinary HTTP | `unavailable` | Authorized fixed-copy terminal page; stop polling |
| Marker missing | `unverified` | Existing generic inactive response |
| Superseded | `generation_changed` or `unverified` | No lifecycle disclosure |
| Strictly generation-proven stale timeout | `failed` with browser code `startup_timed_out`, only after authorization | Fixed-copy terminal page allowed |
| Invalid state, process proof failure, tuple mismatch, read error | `unverified` | Existing generic inactive response and bounded operator log |

The module must not return raw status JSON, paths, PIDs, container IDs, stack traces, environment data, or log content.

Loader eligibility must exclude a selected profile that cannot ever publish ordinary HTTP. The terminal `unavailable` mapping remains as a defense for a page already open while the exact contract changes or completes targetless.

### 7.4 Marketplace reuse

Do not make RoutingServer call `collectMarketplaceNoWaitStates`, which scans every agent and mixes presentation concerns with observation. Factor only the shared one-record observation/mapping needed by both modules. Preserve Marketplace's current response shape and tests.

## 8. Startup page and probe protocol

Create a small module, recommended path `cli/server/agentStartupPage.js`, that owns request classification, safe rendering, probe response formatting, and constants.

### 8.1 Initial navigation classification

The loading page is eligible only when every condition holds:

| Condition | Rule |
| --- | --- |
| Method | Exact `GET` |
| Route kind | `agent-root-pending` |
| Route family | Ordinary agent HTTP; exclude agent MCP and Router/internal/delegated control paths |
| Accept | Includes `text/html` |
| Fetch metadata | `Sec-Fetch-Dest: document` and `Sec-Fetch-Mode: navigate` when supplied; allow a documented fallback for clients that omit Fetch Metadata but explicitly accept HTML |
| Authorization | The captured route decision has passed `ensureHttpRouteAccess` |
| Publication contract | For a new loading-page navigation, the exact selected runtime profile can publish ordinary HTTP; exclude `network.mode: none` and any other permanently targetless contract. This filter does not apply to an existing startup-probe request, which must be allowed to obtain terminal `unavailable`. |
| Lifecycle | After authorization and lease revalidation, a new loading-page navigation uses exact resolver result `starting` or `failed`; an existing probe may additionally receive terminal `unavailable`. |

`HEAD`, `OPTIONS`, JavaScript modules, stylesheets, images, ordinary `fetch`, MCP, JSON APIs, SSE, and WebSocket attempts must not receive HTML.

### 8.2 Same-route startup probe

Reserve one request header:

```text
X-Ploinky-Agent-Startup-Probe: 1
```

The probe is an exact same-origin `GET` to `window.location.href`, with credentials and `cache: "no-store"`. It is handled only for ordinary agent HTTP plans after the same route-access gate. It must never be forwarded to the agent. Existing request sanitization already strips caller `x-ploinky-*` headers; add a regression assertion for this exact header even though active probes should be intercepted earlier.

| Route/lifecycle state | Probe response |
| --- | --- |
| Verified pending/starting | `202`, `{ "state": "starting", "generation": "<opaque edge-generation id>", "retryAfterMs": 1000 }` |
| Active route with committed lease | `200`, `{ "state": "ready", "generation": "<opaque edge-generation id>" }` |
| Verified failed/timeout | `503`, `{ "state": "failed", "code": "startup_failed|startup_timed_out", "message": "Agent startup failed. Retry or contact an administrator." }` after authorization |
| Verified permanently targetless success | `503`, `{ "state": "unavailable", "code": "route_unavailable", "message": "This agent does not provide a web page." }` after authorization; stop polling |
| Edge lease changed | `503`, `{ "state": "retry", "code": "edge_generation_changed" }` |
| Unverified/ordinary inactive | Existing generic `{ "error": "TARGET_INACTIVE" }` response |
| Authentication/session no longer valid | Existing login/deny response; the page reloads through normal auth rather than interpreting it as ready |

The generation token is the opaque edge lease/generation identifier used to prove stable Router publication; it is not a no-wait run ID, `instanceId`, `enableGeneration`, PID, or container ID. All probe responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and no CORS allowance.

### 8.3 HTML requirements

The page must be fully Router-owned and self-contained because agent files are not yet available. It must contain no external script, stylesheet, image, font, or agent asset dependency.

Required response properties are:

| Property | Requirement |
| --- | --- |
| Status | `503 Service Unavailable` while starting or failed |
| Cache | `Cache-Control: no-store, no-cache, must-revalidate` and `Retry-After: 1` |
| CSP | Nonce-based or hash-based strict CSP; `default-src 'none'`; permit only the page's own script/style and same-origin probe connection |
| Other headers | `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a restrictive frame policy consistent with current Router pages |
| DOM marker | Stable non-sensitive marker such as `data-ploinky-agent-startup-page="starting"` for E2E assertions |
| Accessibility | Text status, `role="status"`/live region, keyboard-operable Retry, and reduced-motion handling |
| Content | Generic route label only after authorization; no repository path, container, PID, run ID, port, raw error, or generation in visible text |
| URL | No intermediate redirect and no query mutation; the browser remains at the originally requested URL |

Every interpolated value must be escaped for its exact HTML or JavaScript context. Prefer data attributes plus text nodes over embedding untrusted strings in executable script.

### 8.4 Browser settling algorithm

Use constants shared with tests:

| Constant | Initial value |
| --- | --- |
| Poll interval | `1000 ms` |
| Stable-generation settling window | `2500 ms` |
| Transient retry behavior | Continue indefinitely while the page remains open, with no overlapping requests |

The script tracks `candidateGeneration` and the monotonic time at which that same ready generation was first observed. A `starting`, `retry`, network failure, or different generation resets the candidate. Only a later `ready` response with the identical generation and at least 2500 ms elapsed may call `window.location.reload()`.

This is intentionally stronger than a meta refresh. Parallel no-wait activations can rotate the Router generation after the target route becomes ready; immediate reload can otherwise fetch the document under one generation and its module graph under another.

### 8.5 Terminal failure behavior

A verified terminal failure replaces the spinner with a fixed generic failure title/message and a Retry button. A verified permanently targetless success uses separate fixed unavailable copy and stops polling. Retry clears the terminal presentation and resumes route resolution. It must not automatically loop fast on a terminal state.

Never pass `summarizeNoWaitFailure`, `status.error.message`, or another producer diagnostic into browser HTML or JSON. Those existing strings can contain paths, URLs, ports, image/container names, and topology even after credential redaction. The browser protocol accepts only allowlisted internal codes mapped to constant copy. Marketplace and bounded operator logs retain their separate detailed diagnostic path.

No lifecycle I/O or failure detail is allowed for a caller who has not passed route policy. For public routes the route policy itself authorizes only the fixed presentation.

## 9. RoutingServer integration order

Modify `cli/server/RoutingServer.js` with the following order:

1. Resolve the route plan and retain the existing early handling for genuinely failed plans.
2. Recognize `agent-root-pending` only for the pending document/probe protocol. Classify method, route family, Accept/Fetch Metadata, probe header, and any snapshot-known HTTP-publication capability without lifecycle filesystem/process I/O. A new document navigation whose exact profile is permanently targetless is ineligible and receives the current generic inactive response. An existing request carrying the exact startup-probe header must not be rejected on publication capability: it may belong to a page opened while the generation could publish HTTP and must be allowed to reach exact terminal `unavailable`. Other ineligible requests return the current generic inactive response without dialing, reading agent files, or observing lifecycle state.
3. Derive `agentName`, route, canonical path, and HTTP access for active or pending agent-root plans without treating pending as dialable.
4. Run the existing MCP/delegation distinctions. Pending plans are never eligible for delegated or MCP execution.
5. Run `ensureHttpRouteAccess` for the pending ordinary HTTP route. Every denied, unauthenticated, or wrong-scope result returns immediately without invoking the lifecycle resolver.
6. Revalidate the generation lease after authentication. A login or guest-session operation may have taken long enough for activation to rotate the generation.
7. Only now resolve the exact generation-bound no-wait state. If it is not a verified renderable startup/terminal state, return the current generic inactive response.
8. Revalidate the generation lease again after observation and before writing headers.
9. Render the starting, fixed-copy failed, or fixed-copy unavailable document/probe response.
10. For an active ordinary agent-root plan carrying the startup-probe header, run normal access control, commit the active route plan, and return `ready` without a static read or upstream dial.
11. Leave normal active route dispatch unchanged for requests without the probe header.

Do not place the page renderer in the current failed-plan block at the top of `processRequest`; doing so would bypass per-route authentication and guest scoping.

## 10. Authentication and disclosure matrix

| Route decision | Initial navigation behavior |
| --- | --- |
| `public` | Render the generic page only after exact no-wait proof. |
| `guest` | Use the existing guest scope/room/session rules for the exact requested path. Render only after that gate succeeds. |
| `authenticated` | Preserve existing login/session behavior, then render after authentication. |
| `deny`, missing, invalid policy | Preserve the existing denial; never reveal whether a no-wait run exists. |

The implementation must specifically test generation rotation during login. If activation changes the generation between the pending plan and successful authentication, the response must be `edge_generation_changed`/retry behavior rather than a page based on the stale plan.

Use an injected resolver spy to prove that unauthenticated, wrong-scope guest, and denied requests perform zero lifecycle marker/status/process reads. For each unsuccessful access class, responses must be byte/status/header equivalent across missing, pending, starting, failed, stale, superseded, and malformed internal lifecycle states to the extent the existing login/session response permits.

The Router may emit bounded structured operator events for page shown, verified failure, and observation failure. Do not log every one-second probe at normal log level and do not log session cookies, URLs containing guest scope values, raw lifecycle status, or failure stacks.

## 11. Files expected to change

The final set may move slightly after implementation-base reinspection, but every deviation must be explained in the implementation report.

| Repository/file | Planned responsibility |
| --- | --- |
| `ploinky/cli/server/edgeRoutePlan.js` | HTTP-only pending plan and exact kind classification |
| `ploinky/cli/server/RoutingServer.js` | Pending dispatch, authorization order, active probe interception, lease commits |
| `ploinky/cli/server/noWaitAgentStartupState.js` | Exact single-route no-wait observation and safe normalized state |
| `ploinky/cli/server/agentStartupPage.js` | Navigation/probe classifiers, CSP-safe HTML, JSON responses, browser settling script |
| `ploinky/cli/server/authHandlers/marketplaceRoutes.js` | Reuse shared one-record observation mapping without changing API shape |
| `ploinky/cli/commands/workspaceUtil.js` | Capture/propagate immutable generation identity, atomically retire superseded markers, and identity-stamp spawn failures |
| `ploinky/cli/commands/noWaitWorkerArgs.js` | Require and strictly parse generation/repository/route identity flags |
| `ploinky/cli/commands/noWaitWorker.js` | Prove expected identity and stamp every pending/starting/running/failed status |
| `ploinky/cli/commands/noWaitLogObserver.js` | Validate identity fields in markers, statuses, process proof, and final registry fence |
| `ploinky/cli/server/routerHandlers.js` and focused tests | Lock in stripping of the reserved startup probe header on ordinary agent-root forwarding |
| `ploinky/cli/server/proxy/sanitizeRequestHeaders.js` tests | Retain the equivalent agent-port sanitizer regression |
| `ploinky/tests/unit/noWaitAgentStartupState.test.mjs` | Identity, state mapping, stale/superseded, redaction, lease races |
| `ploinky/tests/unit/agentStartupPage.test.mjs` | Negotiation, rendering, escaping, headers, client state machine |
| Existing no-wait worker-args/runtime/log tests | Complete generation-A/generation-B protocol coverage across markers, statuses, process identity, spawn failure, disable, and targetless completion |
| `ploinky/tests/unit/edgeGenerationHardCut.test.mjs` | Pending plan behavior across control/dedicated hosts and transports |
| `ploinky/tests/unit/guestAuthRoutes.test.mjs` | Public/guest/authenticated/denied pending-route authorization |
| Ordinary agent-root proxy tests plus `ploinky/tests/unit/proxyHeaders.test.mjs` | Probe header never reaches either ordinary or agent-port upstream paths |
| `ploinky/tests/test-functions/workspace_dependency_startup_tests.sh` | Live latched no-wait HTTP fixture and protocol transition integration test |
| `ploinky/tests/testsAfterPrepare.sh` or the appropriate targeted runner | Register the new fast/live integration check once, without duplicate execution |
| `ploinky/proposals/no-wait-agent-loading-page-implementation-plan.md` | Update status, exact branch points, and deviations after implementation |
| `AssistOSExplorer/tests/smoke/specs/03-no-wait-agent-loading-page.spec.mjs` | Test-only real-browser loading-to-application transition |
| `AssistOSExplorer/tests/smoke/lib/config.mjs`, trace helper imports, and `package.json` only if needed | Explicit loading-test/latch paths, spec-local redacted tracing, and one-test command; no production behavior |

Ploinky design specs are historical background under the repository contract and must not be edited as behavior source-of-truth. Executable code and tests define the feature.

## 12. Unit-test plan

### 12.1 Pending route planning

Tests must cover:

| Case | Expected result |
| --- | --- |
| Existing route, valid policy, missing port, HTTP | `agent-root-pending` with exact decision, canonical path, snapshot, and lease |
| Existing route, invalid/missing policy | Existing fail-closed policy error |
| Missing/disabled/draining route | Existing not-found/inactive behavior |
| Missing port, WebSocket transport | Failed `TARGET_INACTIVE`, never pending |
| Active valid port | Existing `agent-root` plan unchanged |
| Dedicated public host pending route | Host-first closure retained; no control-surface fallthrough |
| Lease commit fails | No ready/startup claim |

### 12.2 Lifecycle resolver

Use injected filesystem/process/registry readers following `noWaitRunScopedLogs.test.mjs` conventions. Cover pending marker grace, queued and active starting status, terminal running, terminal failed, missing marker, stale deadline, superseding marker, wrong run ID, wrong worker identity, changed `instanceId`, changed `enableGeneration`, removed agent, route/record repo mismatch, alias mismatch, malformed status, and generation replacement after observation.

Exercise the entire hardened producer/observer protocol, not just the Router wrapper. Combine generation-A markers/statuses/process identities with a generation-B record for marker-only pending, starting, running, failed, statusless, and spawn-failure states. Cover prior-marker retirement for re-enable, disable/remove, and a succeeding generation that schedules no no-wait worker. Assert strict rejection rather than rebinding current record IDs onto old evidence.

Assert that every browser result uses only allowlisted codes and fixed copy and contains none of: producer exception text, PID, container/image name, host path, URL/query, port, state-file path, stack, environment, raw JSON, secret, or control character. Keep separate assertions that Marketplace/operator summaries retain their current bounded diagnostic behavior.

### 12.3 Page and protocol

Tests must cover exact `GET`/`HEAD`/`POST`, Accept parsing, Fetch Metadata behavior, MCP exclusion, probe header normalization, CSP nonce uniqueness, HTML/attribute escaping, `HEAD` body absence, cache/security headers, JSON schemas, and response status codes.

Extract the small browser settling state machine into a testable pure function or test it with a minimal DOM/timer harness. Prove:

| Sequence | Expected client action |
| --- | --- |
| `starting`, `ready(g1)`, `ready(g1)` before 2500 ms | No reload |
| `ready(g1)`, `ready(g1)` after 2500 ms | One reload |
| `ready(g1)`, `ready(g2)` | Settling timer resets |
| `ready(g1)`, transient error, `ready(g1)` | Settling timer resets |
| `failed` | Spinner stops and Retry is enabled |
| `unavailable` | Spinner stops, fixed unavailable copy appears, and polling stops |
| Redirected/non-JSON auth response | Reload through normal route auth; never claim ready |

### 12.4 Authentication

Test public, guest with correct scope, guest with missing/wrong scope, authenticated session, unauthenticated redirect, denied route, session expiry during polling, and generation rotation during login. Resolver spies must prove zero lifecycle I/O before successful access. Unauthorized output must remain equivalent across missing, pending, starting, failed, stale, superseded, and malformed lifecycle states.

### 12.5 Dedicated-host and forwarding matrix

Parameterize Router integration tests across control-host `/<route>/...` and dedicated-host bare `/...` requests for public, guest, authenticated, deny, pending, failed, unavailable, active probe, and generation rotation. Assert host-first selection, bare-path canonical authorization, Router/MCP surface precedence, same-URL probing/reload, and that no Router/internal surface receives loader HTML.

Test `stripRouterIdentityHeaders` or `proxyHttpPassthrough` directly for ordinary agent-root forwarding of `X-Ploinky-Agent-Startup-Probe`, in addition to the existing `sanitizeRequestHeaders` agent-port case. The live fixture must also record received headers and prove the reserved header never arrives upstream.

## 13. Live integration-test plan

Extend the existing fast workspace dependency fixture rather than inventing a second lifecycle implementation.

Create a temporary repository containing:

| Agent | Behavior |
| --- | --- |
| `launcher` | Starts immediately and declares `slowAgent no-wait`. |
| `slowAgent` | Stages a public `/index.html`, writes a test-owned `worker-starting-and-blocked` marker, waits on an explicit release file/socket before TCP/MCP readiness, then serves a page containing a stable `#slow-agent-ready` marker. A watchdog timeout is failure cleanup only, never the correctness barrier. |
| Optional `failedAgent` | Publishes a deterministic bounded readiness failure for terminal-page coverage. |
| Optional `targetlessAgent` | Completes successfully with `network.mode: none` to prove loader exclusion/fixed terminal-unavailable behavior. |

The live test starts `launcher`, waits for the Router, synchronous root return, and exact blocked marker, then makes requests while `slowAgent` is causally prevented from becoming ready. Only after proving the initial HTML and `202` does the harness atomically create/signal the release control. If a generation rotation is exercised, gate it with a second explicit control rather than a timer. It must prove:

1. `GET /slowAgent/index.html` with browser-document headers returns `503` HTML containing the startup marker and no internal lifecycle values.
2. The same URL with the startup-probe header returns `202 starting` and a generation.
3. A normal JSON/fetch request receives the existing generic inactive JSON rather than HTML.
4. MCP and WebSocket attempts receive their existing inactive errors.
5. After semantic readiness and route activation, a probe returns `200 ready` with the active generation.
6. The ordinary URL then returns the real fixture page.
7. A generation rotation between ready probes changes the reported generation and therefore cannot satisfy the client settling rule.
8. A `network.mode: none` no-wait agent never produces an infinite loading loop.
9. Cleanup destroys only the exact temporary workspace and leaves no latch, Box/container/network/volume owned by the fixture.

## 14. Feature-specific Playwright E2E gate

### 14.1 Deterministic fixture cycle

Use the dedicated local path required by repository policy: `~/work/testExplorerFresh`. Positively identify it before any cleanup. Never target a workspace with ambiguous ownership or non-test data.

The feature-specific gate runs in its own fresh cycle:

1. Recreate `~/work/testExplorerFresh` from empty test-owned state.
2. Pin the pushed Ploinky feature commit and record the exact branch/upstream/commit.
3. Materialize the tracked, explicitly latched no-wait fixture in that workspace and record absolute blocked/release control paths.
4. Start the fixture with the canonical Ploinky executable on an isolated loopback Router port.
5. Wait for the exact `worker-starting-and-blocked` marker. Start Playwright only after that causal barrier; do not rely on “immediately,” a fixed sleep, image-pull timing, or host scheduling.
6. Let the Playwright Node test atomically signal the release control only after it has asserted the main-document `503` and observed at least one `202 starting`. The fixture may then become semantically ready.
7. Start context tracing explicitly in the spec despite shared `trace: 'off'`, stop it through the existing redacted-trace helper pattern, attach it to the test, and assert the artifact exists. Preserve the redacted trace, screenshot, response evidence, generation samples, command output, and cleanup proof outside tracked source.
8. Destroy this fixture completely. Do not reuse its Box, generation, latches, browser profile, repository checkout, volumes, or artifact directory for the release gates.

### 14.2 Browser assertions

The Playwright test must discover exactly one test and finish `1 passed`, with Chromium headless, `--workers=1`, `--retries=0`, and browser/page errors treated as failures.

It must assert:

| Assertion | Required proof |
| --- | --- |
| Initial state | Main-document response is `503`; startup page marker and visible loading text are present |
| URL | Page remains `/slowAgent/index.html`; no Explorer/hash/intermediate route |
| Protocol | At least one observed startup probe is `202 starting` |
| Causal release | The test creates the explicit release control only after the initial `503` and `202` assertions |
| Generation stability | Reload occurs only after two or more ready observations establish the same generation across the settling window |
| Handoff | `#slow-agent-ready` appears automatically without a user refresh |
| Network hygiene | No probe header reaches the fixture agent; no agent asset is requested before handoff |
| Error hygiene | No unhandled page error, console error, request failure, credential residue, or raw lifecycle detail |
| Non-document behavior | An API-context request during startup receives JSON `503`, not HTML |
| Evidence | Spec-local redacted trace is attached and exists even though shared tracing defaults to off |

Recommended command shape from the clean Explorer feature-test worktree:

```sh
cd /absolute/path/to/AssistOSExplorer/tests/smoke
SMOKE_NO_WAIT_AGENT_LOADING=1 \
SMOKE_BASE_URL=http://127.0.0.1:<isolated-port> \
SMOKE_RUN_ID=<unique-run-id> \
SMOKE_ARTIFACT_DIR=<fresh-absolute-artifact-dir> \
SMOKE_NO_WAIT_BLOCKED_MARKER=<verified-absolute-blocked-marker> \
SMOKE_NO_WAIT_RELEASE_FILE=<verified-absolute-release-file> \
node ./scripts/run-playwright.mjs \
  --project=chromium \
  --workers=1 \
  --retries=0 \
  --grep 'booting no-wait agent shows the Router loading page and opens automatically' \
  specs/03-no-wait-agent-loading-page.spec.mjs
```

The implementation must fill concrete absolute paths and the isolated port from verified local state; it must not copy placeholders literally.

## 15. Mandatory fresh Explorer release gates

After the feature-specific fixture is destroyed, create a second genuinely fresh `~/work/testExplorerFresh` cycle and follow `ploinky/CLAUDE.md` exactly.

### 15.1 Candidate pinning

Commit and push the Ploinky feature branch. Record its branch, exact pushed commit, and configured upstream. Record every deployed repository's remote URL, symbolic `HEAD`, default branch, exact default-branch commit, and upstream. Record the expected immutable Box identity, release manifest, active generation, and loaded AchillesAgentLib revision/bytes.

No uncommitted Ploinky production source, non-default deployed dependency branch, fallback branch, stale generation, or mixed commit map is acceptable.

### 15.2 Fresh deployment

The deployment command is literal and must not receive branch flags:

```sh
cd ~/work/testExplorerFresh
ploinky start explorer
```

Before browser gates, prove complete declared graph readiness, including no-wait terminal readiness and required external health; clean pinned repositories; expected Box image; fresh generation; exact loaded AgentLib; loopback-only Router TCP plus the allowed LiveKit UDP publication; and unchanged unprivileged runtime.

### 15.3 Three separate headless gates

Run the three authoritative tests separately from the clean canonical-default Explorer release-runner worktree's `tests/smoke` directory, never from the feature-test worktree. Before each test, reassert its canonical remote URL, exact default SHA, clean status, and `HEAD` equality. Each gate uses a new `SMOKE_RUN_ID` and artifact directory, Chromium headless, one worker, zero retries, no skips, and exactly `1 passed`:

| Gate | Exact selected test |
| --- | --- |
| OnlyOffice | `specs/50-onlyoffice-dpu.spec.mjs`, filtered to `Explorer-created Confidential document saves through callback, drains, and reopens after targeted restart`, with `SMOKE_ONLYOFFICE=1` |
| Copilot | `specs/05-copilot-folder-launch.spec.mjs` with the exact release manifest and Box/image/repository pins required by the release-bundle verifier |
| WebMeet | `specs/30-webmeet-room-chat.spec.mjs`, filtered to `two Explorer accounts can join one room and exchange chat`, with `SMOKE_WEBMEET_HEADLESS=1`, `SMOKE_WEBMEET_MEDIA=1`, and the strict media timeout |

The WebMeet gate is especially important because its current application-specific wait logic and its module-heavy dashboard exercise the active route after the Router change. Passing it does not replace the dedicated booting-agent test.

### 15.4 Failed-gate policy

If the feature E2E or any mandatory release gate fails, preserve the failed attempt's evidence, diagnose and fix the root cause, run scoped tests, commit and push a new candidate, destroy the failed fixture, and rerun the feature-specific gate plus all three release gates from new fresh cycles. No result from an earlier candidate or generation carries forward.

## 16. Test execution order

| Order | Gate | Exit condition |
| --- | --- | --- |
| 1 | Hardened no-wait identity-protocol tests and new focused Router/page tests | All pass with no skipped case, including generation-A/generation-B rejection |
| 2 | Existing adjacent unit suites: worker args, route plan, edge hard cut, no-wait observer/runtime state, guest auth, ordinary proxy and agent-port proxy headers | All pass unchanged except deliberate new assertions |
| 3 | New live latched no-wait integration test | Proves causally blocked pending HTML/probe through active target transition and targetless termination |
| 4 | Full Ploinky test suite via the repository's canonical test command | Clean pass |
| 5 | Adversarial implementation verification | No unresolved correctness/security finding |
| 6 | Commit and push exact Ploinky candidate | Local HEAD equals pushed upstream commit |
| 7 | Feature-specific fresh Playwright fixture | Exactly one test, `1 passed`, no retries/skips/browser errors |
| 8 | Fresh Explorer deployment proof | Exact candidate/default dependency map and complete readiness |
| 9 | OnlyOffice gate | Exactly `1 passed` |
| 10 | Copilot gate | Exactly `1 passed` |
| 11 | WebMeet gate | Exactly `1 passed` |
| 12 | Cleanup and evidence audit | Test-owned resources removed; artifacts redacted and complete |

The current root `package.json` contains an `e2e:routing-proxy` script whose referenced directory was not present during planning. Do not use that stale script as evidence for this feature.

## 17. Subagent-driven implementation approach

The independent implementation task should use subagents when the branch and base have been verified. File ownership must be explicit because every agent shares the filesystem.

| Owner | Bounded responsibility |
| --- | --- |
| Primary implementation agent | Branch/worktree control, final architecture, `edgeRoutePlan.js`, `RoutingServer.js`, resolver integration, commits/pushes, fresh deployment, and final verification |
| Worker A | Hardened identity protocol in `workspaceUtil.js`, `noWaitWorkerArgs.js`, `noWaitWorker.js`, `noWaitLogObserver.js`, and their focused protocol tests |
| Worker B | `agentStartupPage.js` and pure renderer/client-state unit tests |
| Worker C, after the primary and Worker A agree on the resolver contract | `noWaitAgentStartupState.js`, Marketplace one-record factoring, resolver tests, then the live latched fixture and test-only Explorer Playwright worktree if ownership remains conflict-free |
| Independent verifier | Read-only adversarial review of the integrated diff, route/auth ordering, disclosure boundaries, and test adequacy |

Workers must be told that they are not alone in the codebase, must not revert another worker's edits, and must confine changes to their assigned files. The primary agent must integrate and personally verify cross-cutting behavior; subagent reports are not substitutes for running tests.

If the implementation environment cannot safely isolate the AssistOSExplorer test branch from the Ploinky worktree, Worker C must stop and report the constraint. It must not edit the user's unrelated Explorer branch in place.

## 18. Risk register and required mitigations

| Risk | Mitigation and proof |
| --- | --- |
| Loader bypasses auth because inactive plans currently fail early | Pending plan carries the captured policy decision; classify without lifecycle I/O, authorize, revalidate lease, then observe; resolver-spy auth matrix tests |
| Unauthorized callers infer internal target state | Every unsuccessful access path performs zero lifecycle I/O and keeps output equivalent across all internal lifecycle states |
| HTML is returned to APIs/assets | Strict document classifier plus MCP/control exclusions; method/Accept/Fetch Metadata tests and live JSON request |
| Immediate reload races another generation | Same-generation 2500 ms settling algorithm and generation-change browser test |
| Old marker/status is rebound to a new registry generation | Identity fields originate with the staged record and are required in worker args, marker, all statuses, process proof, and registry fence; superseding transitions retire prior markers; cross-generation tests |
| Detailed worker failure leaks topology to a browser | Browser-only allowlisted codes and fixed copy; hostile diagnostic tests; detailed summary remains operator/Marketplace-only |
| Permanently targetless success polls forever | Exclude non-HTTP publication profiles from loader eligibility and terminate an already-open loader with fixed `route_unavailable` |
| Probe leaks upstream | Active interception plus focused ordinary-proxy and agent-port sanitizer regressions and fixture-agent header capture |
| Generated HTML permits injection | Context-correct escaping, CSP, no external assets, hostile route-label tests |
| One-second polling overloads Router | Single-route observation only, no global Marketplace scan, no overlapping browser request, optional short in-process deduplication only if profiling proves needed |
| Login completes after route activation | Post-auth lease check and generation-rotation test |
| Active routing regresses | Active-plan code path remains default; adjacent full unit suite and three release gates |
| E2E passes without observing startup | Explicit blocked/release latch, required `202 starting` evidence before release, main-document `503`, DOM marker assertions, and redacted trace artifact |
| Feature test contaminates canonical release evidence | Separate clean Ploinky, Explorer feature-test, and Explorer canonical-release worktrees with pre-gate remote/SHA/status assertions |

## 19. Acceptance criteria

Implementation is complete only when every statement is proven:

1. All production changes are on pushed `feature/no-wait-agent-loading-page`, based on the recorded remote default branch, with no unrelated feature history.
2. A top-level browser navigation to a positively verified booting no-wait agent shows the Router-owned loading page at the original URL.
3. The no-wait marker, every status, worker process identity, and final registry fence prove the exact staged `instanceId`/`enableGeneration` plus repository/agent/alias/route identity; generation-A evidence cannot validate generation B.
4. Public, guest, authenticated, and denied route policies behave exactly as defined for the requested path, and unsuccessful access performs zero lifecycle I/O.
5. API, MCP, WebSocket, asset, and non-document requests never receive the loading HTML.
6. Unknown, stale-unprovable, superseded, disabled, stopped, and ordinary inactive targets retain generic fail-closed behavior.
7. No route is reported ready until semantic readiness has activated a target and the active route lease commits.
8. Automatic reload occurs only after the same opaque edge generation remains stable for the full settling window.
9. Browser terminal failures expose only allowlisted codes and fixed copy; raw/sanitized producer diagnostics remain operator-only.
10. A permanently targetless successful no-wait run never leaves a loader polling indefinitely.
11. The reserved startup probe header never reaches an ordinary agent-root or agent-port upstream.
12. Control-host and dedicated-host matrices pass for auth, canonical path, surface precedence, probe, and generation rotation.
13. Focused unit tests, adjacent regression suites, the live latched integration fixture, and the complete Ploinky test suite pass.
14. The dedicated Playwright transition gate runs from its isolated test-runner worktree, releases readiness only after observing startup, passes exactly one selected test with no retries/skips, and retains an asserted redacted trace.
15. A second fresh Explorer deployment from the exact pushed candidate passes the mandatory OnlyOffice, Copilot, and WebMeet gates separately from a clean canonical-default Explorer runner worktree.
16. Every participating checkout's canonical remote, branch/upstream, exact SHA, and clean status are recorded and verified before its gate.
17. Artifacts contain no credentials or raw lifecycle state, and all test-owned latches/resources are removed with cleanup evidence.
18. No Ploinky design spec is updated as behavioral authority, no Ploinky core identifier is agent-specific, and no new public status endpoint is introduced.

## 20. Rollout and follow-up

This candidate should ship the generic Ploinky behavior without removing Explorer's current `#agent-runtime-wait` route or changing the WebMeet toolbar. Keeping the wrapper for one release is harmless, though it may add a second settling delay for toolbar launches. Direct guest and ordinary agent URLs gain the Router loader immediately.

After the Ploinky branch is reviewed, merged, and deployed successfully, a separate Explorer cleanup can make the WebMeet toolbar open `/webmeetAgent/roomLoader.html` directly and remove the application-specific wait route if a reference search confirms no remaining caller. That cleanup requires its own branch, unit updates, and browser regression; it is not part of this implementation candidate.

## 21. Observed

The staged route is targetless until no-wait readiness activates it. Routing currently turns that condition into a JSON `TARGET_INACTIVE` response before normal agent-route authorization. Marketplace consumes current no-wait observation, but the marker/status protocol does not presently bind evidence to the record's `instanceId`/`enableGeneration`; that hardening is a prerequisite, not an existing guarantee. Explorer's WebMeet workaround proves that a stable-generation window is necessary for module-heavy applications.

The Ploinky repository already has fast workspace dependency fixtures, but their current `setTimeout` delay is not a deterministic browser barrier and must be extended with a test-owned latch. Browser automation is owned by `AssistOSExplorer/tests/smoke`; its shared configuration disables tracing, so the feature spec must explicitly produce a redacted trace. Ploinky's release contract requires a committed and pushed candidate, a fresh `~/work/testExplorerFresh` deployment, and three separate authoritative headless gates when E2E is explicitly requested.

## 22. Inferred

A same-route Router probe is narrower than adding a public lifecycle endpoint: it reuses the original path's access decision, avoids exposing the Marketplace inventory, and lets the active Router generation be observed without fetching and discarding the complete application document. Authorization must precede every lifecycle observation. A distinct pending route-plan kind makes targetless handling auditable and prevents accidental use by dial/static code.

The production change can remain Ploinky-only. The only anticipated cross-repository edit is a test-only Playwright spec because adding Playwright to Ploinky would widen its dependency surface solely for one browser gate.

## 23. Unknown / not yet verified

| Unknown | Required resolution before or during implementation |
| --- | --- |
| The exact remote-default commits at implementation time | Fetch, record, and re-open the seams before editing |
| Whether the selected browser records a main-document HTTP `503` as an actionable console event | Prove in the feature Playwright gate; adjust diagnostics only if the event is expected, narrow, and not ignored globally |
| Whether CSP `frame-ancestors` should inherit a current Router page policy or be `'none'` | Compare current auth pages and supported embedding behavior; choose the narrower compatible rule |
| Exact safest crash-consistent sequencing for prior-marker retirement around the staged registry commit | Re-open the registry transaction seam; require fail-closed ordering and the cross-generation tests above before choosing the smallest implementation |
| Exact E2E credentials, immutable image identity, and release manifest | Resolve from the selected fresh local fixture without printing secrets |

## 24. Next checks

Independent review completed with eight substantiated findings: three P1, three P2, and two P3. All are incorporated in this revision and recorded in the companion review disposition. A read-only closure pass returned final `APPROVE` after verifying the corrected targetless-probe terminal path and the other seven closures.

Before editing, the independent implementation task must fetch canonical remotes, record exact base SHAs, re-open every named seam, and confirm the crash-consistent marker-retirement sequence. It must then treat this amended document as authoritative for scope and acceptance while continuing to prefer executable code/tests over historical specifications when current behavior differs.

## 25. Implementation status, evidence, and deviations

Implementation began from the fetched canonical Ploinky remote-default state recorded on 2026-08-27:

| Repository / role | Canonical remote | Symbolic default | Exact branch point or runner SHA |
| --- | --- | --- | --- |
| Ploinky production candidate | `https://github.com/AssistOS-AI/ploinky.git` | `origin/master` | branch point `5d87b1668f07abd9617eb54a7808221a7c50e878`; pushed and tested candidate `61b8c7fd0034fc522ca86574ec844b003f40c26e` on `feature/no-wait-agent-loading-page` |
| AssistOSExplorer feature-test branch | `https://github.com/AssistOS-AI/AssistOSExplorer.git` | `assistos-ai/main` | based on `6acfa0bf07592272d4a82bbe4e460f6dc4e1a233`; pushed test commit `2173bb06fafa070c019c6fc82d10927992ac6c22` on `test/no-wait-agent-loading-page-e2e` |
| AssistOSExplorer canonical release runner | `https://github.com/AssistOS-AI/AssistOSExplorer.git` | `assistos-ai/main` | clean detached checkout at `6acfa0bf07592272d4a82bbe4e460f6dc4e1a233` |

The Ploinky implementation binds the staged registry identity through worker arguments, marker, every status, structured process proof, admission, activation, and the final registry fence. Marker retirement is fail closed. The Router classifies pending ordinary-HTTP plans without lifecycle I/O, authorizes first, revalidates the immutable edge lease, then resolves one exact no-wait record. The self-contained page and same-route probe expose only fixed allowlisted browser states, preserve existing non-document behavior, strip the reserved header on both ordinary and agent-port forwarding, and require one opaque generation to remain ready for the complete settling window. Marketplace uses the factored one-record observer without becoming Router authority.

Pre-candidate verification completed on the integrated diff:

- The final 16-file focused and adjacent unit matrix passed `300/300`, including generation-A/generation-B identity rejection, the full host/auth/surface matrix, startup-page/client settling behavior, ordinary and agent-port header stripping, a real Bash regression proving cleanup failure is attempted once and preserves evidence, and Bash-3.2 nounset coverage for an empty prelaunch fixture.
- The broader unit corpus passed before the final cleanup-only test additions; all subsequently modified test files are included in the final `300/300` matrix.
- The deterministic live latched integration passed after proving the initial document `503`, at least one `202 starting` probe, causal readiness release, active `200`, targetless terminalization, generation rotation, and ordinary upstream header hygiene.
- A final strict cleanup proof found no matching temporary workspace, Router listener on port 8080, detached no-wait worker, fixture container, or fixture network.
- An independent read-only implementation verifier found no remaining P0-P3 production or security defect after its own `299/299` focused run, production syntax checks, and staged/unstaged diff audit; the primary then added and passed the one additional Bash-3.2 prelaunch-cleanup regression without changing production code.

The pushed candidate then passed the deterministic feature-specific browser transition from the tracked Explorer test branch:

- Candidate `61b8c7fd0034fc522ca86574ec844b003f40c26e` and Explorer test commit `2173bb06fafa070c019c6fc82d10927992ac6c22` were committed, pushed, clean, and exactly equal to their upstreams before the run.
- The final fresh-cycle attempt ran exactly one Chromium-headless test with one worker and zero retries: `1 passed (7.9s)`.
- The test proved an initial Router-owned `503`, two same-route `202 starting` probes before the test-owned causal release, one opaque ready generation stable for 3,051 ms, automatic `200` application handoff, and removal of the reserved startup header before upstream forwarding.
- The spec produced a sanitized trace and passed its credential-residue/input-value audit. The implementation run destroyed the first fresh fixture before release testing, but the retained `fixture-state.env` and `cleanup-state.env` files are zero bytes. The historical bundle therefore does not independently prove that fixture's state or destruction and must not be cited as doing so.
- Evidence: `/Users/danielsava/.codex/visualizations/2026/08/27/01a043ee-cf6c-74e2-9556-7f9c0278c246/no-wait-agent-loading-page-evidence/feature-e2e/no-wait-feature-61b8c7fd-attempt2`.

A second `~/work/testExplorerFresh` deployment was reported as using the literal command `cd ~/work/testExplorerFresh && ploinky start explorer`. The deployed Ploinky candidate remained `61b8c7fd0034fc522ca86574ec844b003f40c26e`; Explorer and the canonical release runner were reported at `6acfa0bf07592272d4a82bbe4e460f6dc4e1a233`; managed achillesAgentLib was `838a64bf9c5faa9f1c21935686bcfea642a42fa4`. The retained release manifest pins Box image `sha256:e633e9f39b2a03eff26d01c5d95ff064623541ed8e20d62db71dbad994571a7f` and the browser-result bundles prove the three selected Playwright tests passed. The raw deployment command, gate-time runner assertions, loaded-AgentLib attestation/readiness transcript, marker observations, and network/runtime-boundary transcript were not retained. Claims about 18 admitted runtimes, 14 terminal markers, loaded bytes, readiness, and the network boundary are therefore contemporaneous operator reports, not release-grade evidence.

The clean canonical Explorer runner then passed the three required gates separately, each as one Chromium-headless worker, zero retries, no skips, and exactly one selected test:

| Gate | Exact result | Evidence directory |
| --- | --- | --- |
| OnlyOffice | `1 passed (1.3m)` | `release-e2e/release-61b8c7fd-attempt1/onlyoffice` |
| Copilot | `1 passed (1.5m)` | `release-e2e/release-61b8c7fd-attempt1/copilot` |
| WebMeet | `1 passed (42.4s)` with strict headless media enabled | `release-e2e/release-61b8c7fd-attempt1/webmeet` |

The shared Podman VM stopped unexpectedly only after all browser gates and post-gate candidate evidence had completed. During a coordinated temporary restart, the same exited Box was stopped and destroyed through the candidate CLI. Final reachable-engine cleanup counts were zero for the exact Box name, path-hash-labelled containers, workspace-name networks and volumes, TCP 8080 listeners, and UDP 7882 users. `/Users/danielsava/work/testExplorerFresh` is absent and was moved recoverably to `/Users/danielsava/.Trash/testExplorerFresh-no-wait-passed-61b8c7fd-20260827T193316Z`; the VM was released stopped and idle.

The consolidated external evidence index is `/Users/danielsava/.codex/visualizations/2026/08/27/01a043ee-cf6c-74e2-9556-7f9c0278c246/no-wait-agent-loading-page-evidence/release-evidence-summary.md`; the exact post-gate destruction/audit transcript is `release-e2e/release-61b8c7fd-attempt1/post-gate-cleanup-audit.txt` beneath that root. The independent review disposition record remains unchanged. Commit `ab9de7c7577b1c7d7ab65627d022731be5331332` was documentation-only after the tested candidate. The post-review corrective commit adds only evidence/test tooling and this disposition; production files under `cli/` remain byte-identical to `61b8c7fd0034fc522ca86574ec844b003f40c26e`.

Deviation: the complete canonical Ploinky suite in section 16 step 4 and acceptance criterion 13 was not taken to a passing result. Two preserved attempts encountered an unrelated watchdog/test-harness sequencing race after the candidate's focused and live checks; the implementation does not modify the monitor/restart path. The task owner then explicitly directed the implementation run to skip the Ploinky suite and proceed to E2E. This deviation is recorded rather than represented as a passing gate; focused/adjacent tests, the live latched integration, the feature-specific browser transition, and all three canonical Explorer gates passed.

## 26. Post-review evidence disposition and fail-closed retention

The 2026-08-28 adversarial review approved the production implementation and found no correctness or security defect. Its three valid findings concern evidence retention. Destroyed fixtures make the missing historical observations impossible to reconstruct, so this plan accepts those historical gaps explicitly and does not synthesize replacement artifacts.

| Finding | Disposition | Enforced correction |
| --- | --- | --- |
| P2-1: release deployment, per-gate command/runner state, and attestation/readiness transcripts were not retained | Accepted as an evidence gap for the 2026-08-27 cycle; the browser results remain valid, but the missing deployment assertions are not release-grade proof | `tests/release/noWaitLoadingEvidence.mjs run` writes a redacted exact argv/`SMOKE_*` environment record, asserts and records the clean expected runner SHA and canonical remote before execution, requires named non-empty cycle artifacts, captures console output, and records the exit result. `verify --kind release` fails unless deployment plus all three gate records, fixture/cleanup state, attestation/readiness, manifest, cleanup audit, and Playwright results are non-empty. |
| P3-2: feature `fixture-state.env` and `cleanup-state.env` are empty | Accepted as an evidence gap for the destroyed feature fixture; neither file may be cited as cleanup proof | `capture` writes through an exclusive temporary file and refuses to publish a zero-byte result. `verify --kind feature` requires both populated state files, their exact capture commands, runner/command/result/console records, and the Playwright result. |
| P3-3: live latch pass was not bound to a candidate SHA and predates the final marker rename | Resolved by a fresh scoped run at a clean branch HEAD | The latch harness writes an opt-in immutable JSON pass record only after strict cleanup. It includes the exact `git rev-parse HEAD`, raw `git status --short`, branch, test name, timestamp, and result. The corrective record is retained outside source at `no-wait-agent-loading-page-evidence/post-review/live-latched-integration-head.json`. |

Every future feature or release cycle for this change must use the repository-owned evidence wrapper from the beginning of a fresh attempt. State-producing commands run through `capture`; deployment and browser commands run through `run` with the expected full runner SHA, canonical remote name/URL, and required cycle artifacts; cleanup state is captured only after destruction; and the cycle is accepted only after the matching `verify` mode passes. A successful browser process without a complete bundle is a failed evidence gate.

| Cycle phase | Wrapper contract |
| --- | --- |
| Fixture, attestation/readiness, cleanup | `capture --output <absolute-bundle-file> -- <state-command> ...`; the command must emit the raw state to stdout, and an empty/whitespace-only result is rejected |
| Feature browser gate | `run --kind feature --bundle-dir <absolute-attempt> --step playwright --runner-root <feature-runner> --expected-sha <full-sha> --remote-name <canonical-remote> --expected-remote-url <exact-url> --expected-ref refs/remotes/<canonical-remote>/<default> -- <playwright-command> ...` |
| Release deployment | The same `run` contract with `--kind deployment --step deployment`; the fixture-state capture must already exist |
| Each release browser gate | The same `run` contract with `--kind release`; fixture state and `attestation-readiness.txt` are automatic preconditions, and `SMOKE_RUN_ID` plus `SMOKE_ARTIFACT_DIR=<attempt>/<step>` are mandatory |
| Final acceptance | `verify --kind <feature-or-release> --bundle-dir <absolute-attempt>` after cleanup; any missing, empty, failed, or misplaced required artifact rejects the cycle |

The 2026-08-27 feature and release fixtures are not being recreated as part of this corrective pass. A later merge or release decision that requires raw deployment-grade proof must run a wholly fresh feature and release cycle under this wrapper; it must not reuse or amend the historical attempt directories.
