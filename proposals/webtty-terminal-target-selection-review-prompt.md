You are performing a rigorous, read-only architecture and implementation-plan review for a follow-on Ploinky WebTTY feature.

## Goal

Review this proposal:

`/Users/danielsava/work/file-parser/ploinky/proposals/webtty-terminal-target-selection-proposal.md`

Determine whether it is correct, secure, feasible in the current codebase, and sufficiently detailed to implement. Challenge its assumptions. If there is a materially better solution, describe that solution concretely and explain why it is better. Do not merely endorse the proposal.

Save your final review here:

`/Users/danielsava/work/file-parser/ploinky/proposals/webtty-terminal-target-selection-review.md`

You may create or replace only that review file. Do not edit implementation files, the proposal, existing plans/reviews, manifests, lockfiles, tests, or Git state.

## Non-negotiable product requirements

| ID | Requirement |
|---|---|
| 1 | In Explorer, choosing a folder’s three-dot menu → “Open Terminal Here” must present a choice of runtime. |
| 2 | The choices must include the Ploinky Box and the Ploinky agent instances that actually have access to the selected folder. |
| 3 | Selecting an agent must open the shell inside that exact running container at the container path corresponding to the selected Explorer folder. |
| 4 | Eligibility must come from authoritative active runtime/mount state, not UI hard-coding or a run-mode guess. |
| 5 | The feature remains admin-only and must fail closed on stale, ambiguous, missing, or unverifiable state. |
| 6 | WebTTY is Ploinky core, not a standalone Ploinky agent. |
| 7 | `node-pty` is packaged in `ploinky-box`; do not introduce a helper image or require `node-pty` in every agent image without overwhelming technical evidence. |
| 8 | The Box terminal must access the full workspace from which Ploinky was launched. Inside the Box that host workspace is mounted at `/workspace`; a selected folder must become the matching `/workspace/<relative-path>`. |
| 9 | Backward compatibility and migrations are not required. The legacy `basic/webtty` agent may be removed directly and must not be revived. |
| 10 | Implementation must begin on new feature branches created from verified, updated default branches after WebTTY core is merged. |
| 11 | The completed implementation must pass real fresh-deployment and browser E2E tests, including process-cleanup verification. |

You may recommend a different internal architecture or a WebTTY-owned chooser page if it is demonstrably safer, simpler, or more reliable, but preserve the requested user outcome and explain any UX deviation explicitly.

## Workspace and repository safety

Start by reading:

`/Users/danielsava/work/file-parser/CLAUDE.md`

Then read the applicable repository-local instruction files completely. Inspect Git status, current branches, and default branches in every repository you examine. The worktrees may contain unrelated changes owned by other tasks.

Do not:

| Prohibited action | Reason |
|---|---|
| Checkout, switch, create, delete, reset, rebase, merge, cherry-pick, stash, commit, or amend branches | This session is a review, not implementation. |
| Discard or modify existing worktree changes | They belong to the user or other concurrent tasks. |
| Run destructive Podman, Docker, or filesystem cleanup | Runtime mutation is outside this review. |
| Run the full E2E suite | Review the tests and feasibility; do not acquire shared runtime resources. |
| Treat proposal statements as evidence | Verify important claims against code, tests, specs, manifests, image definitions, and history. |

Read-only shell commands, focused unit tests that do not mutate shared runtime state, and Git history inspection are allowed.

## Required source review

Read the proposal completely, then inspect at least the following areas and any directly connected code:

| Area | Starting points |
|---|---|
| Current WebTTY handler and authorization | `ploinky/cli/server/handlers/webtty.js` |
| Current WebTTY session lifecycle | `ploinky/cli/server/webtty/sessionManager.mjs` and adjacent runtime/audit stores |
| Box PTY worker and cwd containment | `ploinky/core-services/webtty/terminal-worker.mjs`, `ploinky/core-services/webtty/cwd.mjs` |
| Existing WebTTY plans and reviews | `ploinky/proposals/webtty-core-implementation-plan.md`, `ploinky/proposals/webtty-core-implementation-plan-review.md`, `ploinky/proposals/webtty-core-implementation-review.md` |
| Agent mode and project mount derivation | `ploinky/cli/utils/agents.js` |
| Effective OCI runtime mounts and state | `ploinky/cli/sandbox/docker/agentServiceManager.js`, `ploinky/cli/sandbox/docker/containerRegistry.js`, `ploinky/cli/sandbox/agentRuntimeState.js`, `ploinky/cli/sandbox/runtimeCapabilities.js` |
| Existing interactive agent shell | `ploinky/cli/sandbox/docker/interactive.js`, `ploinky/cli/commands/workspaceUtil.js` |
| Existing runtime relay | `ploinky/cli/server/runtimeRelay/RuntimeRelayManager.js` and its protocol/transport dependencies |
| Router and security contracts | `ploinky/docs/specs/DS004-main-behavior.md`, `ploinky/docs/specs/DS007-routing-and-web-surfaces.md`, `ploinky/docs/specs/DS013-security-model.md` |
| Box image packaging | `container-image-builds/images/ploinky-box/` and the files that install/package Ploinky production dependencies |
| Explorer launcher and menu | `AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp.js`, `AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp-menu-contributions.js` |
| Explorer configuration and agent modes | `AssistOSExplorer/explorer/manifest.json`, `AssistOSExplorer/explorer/README.md`, relevant hooks |
| Current unit and browser E2E tests | `AssistOSExplorer/explorer/tests/`, `AssistOSExplorer/tests/smoke/specs/01-webtty-core.spec.mjs`, and Ploinky WebTTY tests |

Use repository history only where it resolves a design question or exposes a regression risk. Do not spend time reconstructing history that does not affect this proposal.

## Questions you must answer

### 1. Product and UX semantics

Determine whether the proposal faithfully implements “agents that have access to this folder.” Check global, static/configured, isolated, development, manifest-volume, generated-volume, read-only, nested-mount, starting, stopped, and replaced-agent cases. Evaluate whether the chooser belongs in Explorer, in WebTTY, or should be split between them. Assess popup-blocking and stale-selection behavior.

### 2. Source of truth and path translation

Identify the authoritative current data structures for:

| Needed fact | Review question |
|---|---|
| Active workspace generation | Which exact field(s) define it? |
| Agent instance identity | Which immutable and human-readable fields must be retained? |
| Runtime ownership | How can Ploinky prove a container belongs to this workspace and agent instance? |
| Effective mounts | Are persisted binds sufficient, must the live container be inspected, or are both needed? |
| Source-to-destination mapping | Are source paths expressed in the Box namespace, Podman VM namespace, host namespace, or a mix? |
| Read-only state | Can it be determined correctly under nested and overlapping mounts? |
| Runtime replacement | Which events/records invalidate discovery tokens and live sessions? |

Try to break the proposed “most-specific active mount” algorithm with symlinks, overlapping destinations, named volumes, staged mounts, missing paths, path replacement between discovery and creation, and engine-specific normalization. State a precise corrected algorithm if the proposal is incomplete.

### 3. Target-token and TOCTOU design

Evaluate stateless signed capabilities versus server-side short-lived target records. Specify what must be bound to a token, when it expires, whether it is single-use, how it is revoked, and what is revalidated. Check whether current multi-process/server behavior makes either approach unsafe or impractical. Review how the chooser transfers a selection to a new tab without putting reusable bearer material in request logs, referrers, persistent browser history, or storage.

### 4. Remote PTY and lifecycle mechanism

This is the highest-risk area. Do not assume that the existing `podman exec -it` CLI implementation is sufficient.

Determine, from the shipped Podman/runtime APIs and current Ploinky architecture, which approach can provide:

| Capability | Required evidence |
|---|---|
| Exact exec identity | An immutable handle for the shell inside the exact container |
| Bidirectional terminal stream | Correct bytes, exit status, backpressure, and disconnect handling |
| Resize | Reliable row/column changes for the exact session |
| Signal/close | Deterministic termination of the shell and its foreground process group |
| Verification | A way to prove no inner shell or child survives close/timeout |
| Replacement safety | No attachment to a same-named replacement container |

Compare at least:

1. the Podman engine exec API with TTY/attach/resize/inspect primitives;
2. `podman exec -it` controlled by Box `node-pty` plus an explicit in-container identity and cleanup protocol;
3. an agent-side terminal broker; and
4. extending or deliberately not extending the current authenticated runtime relay.

Verify which primitives actually exist in the Podman version/image used by Ploinky. Use official/local command documentation or primary upstream documentation if necessary. Clearly distinguish verified capability from inference. Recommend one design, with a fallback, and explain its failure/cleanup semantics.

### 5. Dependency and image placement

Verify that production `node-pty` is installed and copied correctly into `ploinky-box`, including native ABI/runtime requirements. Determine whether the proposed agent provider can remain entirely Box-side. Flag any hidden dependency that would force changes to agent images. Do not propose a separate helper image merely for conceptual separation.

### 6. Authorization, routing, and secrets

Trace the actual admin/auth/origin/lease/host-generation checks for discovery, page load, session creation, and WebSocket attachment. Determine where checks must be reused or added. Analyze the consequence that an agent shell inherits that agent container’s configured environment and credentials. Ensure no browser input can select arbitrary containers, argv, executable, environment, host path, or translated cwd, and no sensitive values enter target responses or audit logs.

### 7. Session manager integration

Assess whether a provider abstraction fits the current worker/session/audit/recovery model. Identify every Box-only assumption that must become target-aware, including runtime records, startup recovery, reconnect, timeouts, host shutdown, agent restart, workspace destruction, audits, and cleanup.

### 8. Branch and cross-repository sequencing

Confirm the actual default branches and whether WebTTY core is already merged. Recommend exact branch sequencing for Ploinky and AssistOSExplorer without disturbing dirty worktrees. The implementation must occur on new feature branches; the review itself must not create them.

### 9. Testability and acceptance

Review whether the proposed unit, integration, security, production-image, and browser E2E matrix can prove the feature. Add missing adversarial cases. Pay special attention to proving:

| Proof | Example |
|---|---|
| Exact runtime | The shell is in the selected immutable container, not merely a same-named target |
| Correct cwd mapping | The selected Explorer directory maps through the actual effective mount |
| Access mode | A read-only target is labeled correctly and cannot write |
| Stale-state rejection | Restart/replacement between discovery and creation fails closed |
| Cleanup | Closing with a foreground process leaves no shell, child, or exec session |
| No regression | Box WebTTY remains usable after agent failures and cleanup |

## Review method and evidence standard

Classify every substantive statement as:

| Classification | Meaning |
|---|---|
| Observed | Directly supported by current code, test, manifest, spec, command output, or primary documentation |
| Inferred | A reasoned conclusion from observed evidence; state the reasoning |
| Unknown | Not established from the available evidence; specify the cheapest decisive next check |

For each actionable finding, include:

| Field | Required content |
|---|---|
| ID and severity | `P0` critical, `P1` high, `P2` medium, or `P3` low |
| Claim | One precise problem or missing decision |
| Evidence | Exact absolute file paths and tight line references, command result, or primary-documentation link |
| Failure mode | What breaks or becomes unsafe if unaddressed |
| Recommended correction | Concrete change to the proposal or architecture |
| Verification | The test/check that proves the correction |

Do not report style preferences as findings. Do not repeat historical findings that the current code has already fixed. If an existing review claim is stale, say so.

## Required output structure

Write `/Users/danielsava/work/file-parser/ploinky/proposals/webtty-terminal-target-selection-review.md` with:

| Section | Required content |
|---|---|
| Review baseline | Date, exact commits/branches/status of each inspected repository, and files reviewed |
| Executive verdict | `approve`, `approve with changes`, or `redesign required`, with a concise rationale |
| Findings | Actionable findings ordered P0 → P3 |
| Validated decisions | Important proposal decisions supported by evidence |
| Recommended architecture | The corrected end-to-end request, target-resolution, PTY, and cleanup flow |
| Better alternative | A concrete alternative if superior; otherwise state why the proposal is preferable |
| Revised implementation sequence | Dependency-ordered steps, including the required new branches and runtime spike |
| Verification matrix | Exact unit, integration, security, image, and E2E gates |
| Unknowns and next checks | Only unresolved facts, each with a decisive check |
| Proposal changes | A concise table of exact edits that should be made before implementation |

Use tables where they make comparisons or mappings clearer. Keep findings evidence-dense and avoid generic advice.

At the end of your Claude Code response, report:

1. the verdict;
2. the count of P0/P1/P2/P3 findings;
3. the path of the saved review;
4. the three most important changes, if any; and
5. whether you found a materially better architecture.

Do not implement the feature in this session.
