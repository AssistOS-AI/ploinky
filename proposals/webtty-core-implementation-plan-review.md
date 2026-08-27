# Review: WebTTY-to-Ploinky-Core Implementation Plan

Review date: 2026-08-27.

Plan under review: `ploinky/proposals/webtty-core-implementation-plan.md` (plan date 2026-08-27).

**Verdict: APPROVE WITH CHANGES.**

The plan is architecturally sound, its git history is exactly accurate, its self-declared "Observed" facts held up under adversarial checking on all four repositories, and its labeling of unknowns (native spike, PTY topology, logout events) matches the code. No P0 was found. Two P1 defects (an internal contradiction in old-Box failure semantics, and a mutation-gate assumption that misses the canonical local-admin session), three P2 seam/test omissions, and five P3 notes need fixing in the plan text before implementation starts. No architectural rework is needed.

## Review scope and baselines

| Repository | Branch | Verified baseline |
| --- | --- | --- |
| ploinky | master | `021d9a91626d50486e32d95b0897efdb7fe8d819` — `Merge agentlib-direct-mount into master` |
| agentlib-direct-mount tip | — | `9ab08acf84dcb43090e6b0af860597f947b668ec`; **is** an ancestor of master (`git merge-base --is-ancestor`) |
| basic | main | `e5c0393dbd01f37a1871911b65fa8da1e0bc4315` |
| container-image-builds | main | `8a20d2c62bcef1f072614fab69cfa7de8ca621b7` |
| AssistOSExplorer | main | `e7b551020a9117879c978be0f3528f7028a45024` |

Method: read-only review. All baselines, cited commits, and every P1/P2-grade citation were verified personally against the files. Five parallel read-only exploration agents traced auth, routing, lifecycle/mounts, image builds, and Explorer/basic retirement; at least one citation from each agent report was re-verified verbatim before use. No files were modified and no test suites were executed (deterministic test breaks are asserted by inspection of hardcoded assertions).

---

## Findings

### P1-1 — Old-Box failure semantics are internally contradictory (plan §2.11 vs §8 vs §18 vs §19)

The plan states four times what happens when a Box lacks the native WebTTY bundle, and the statements disagree.

| Plan location | Statement | Implied semantic |
| --- | --- | --- |
| §8 | "A missing/tampered/incompatible bundle is a hard startup error" (validation placed in Box admission, `ploinky/ploinky-box/contract/image.mjs`) | Box-level refusal |
| §18 | "If Ploinky's declared native contract and the Box image differ, stop with a hard error" | Box-level refusal |
| §2.11 | Old Box "fails closed before WebTTY becomes available" | Ambiguous |
| §19 failure table | Browser behavior: "WebTTY unavailable; no install attempt" | Feature-level fail-closed (requires a running Router, i.e. an admitted Box) |

Concrete failure mode if an implementer picks the Box-level reading: the Box identity is deliberately versionless (`assistos/ploinky-box` marker, empty labels — `ploinky/ploinky-box/contract/image.mjs:137-146`; ploinky/CLAUDE.md invariant 10), and the Box bind-mounts the invoking Ploinky checkout at `/opt/ploinky` (`ploinky/ploinky-box/lifecycle/container.mjs:114`), so running new source against an existing Box image is the normal development loop and the exact release window between §18 groups 2 and 3. Box-level hard-error bricks every such workspace entirely — not just WebTTY — contradicting §19 and coupling unrelated workloads to a terminal feature, against the spirit of §7's own "unrelated Ploinky commits must not require a new Box."

The defect is the inconsistency; either semantic is permissible under the no-backcompat mandate. Recommendation: the feature-scoped semantic.

**Exact edit** — make all four touchpoints say one thing (recommended wording):

| Plan location | Replacement text |
| --- | --- |
| §8 | "A missing/tampered/incompatible bundle causes **WebTTY readiness** to fail closed — page, API, and stream return the §19 unavailable behavior with expected-versus-observed contract categories. Box admission itself is unchanged and never blocks on the WebTTY bundle. It is never an instruction to run npm." |
| §18 | "If Ploinky's declared native contract and the Box image differ, WebTTY stays unavailable with a hard operator error; the Box and all non-WebTTY routes run normally." |
| §2.11 | "…WebTTY fails closed (unavailable, with operator evidence) before any terminal is offered…" |

If the Box-level semantic is instead intended, §19's row must change to "no Router starts; Box admission refused," and the plan must state explicitly that existing Boxes brick on new source until the new image is pulled, including during development.

### P1-2 — The "existing generic browser-mutation gate" does not cover the canonical local-admin session (plan §12)

Personally reviewed: the central mutation gate runs only when `req.authChannel !== 'cli'` (`ploinky/cli/server/RoutingServer.js:601-604`), and the local admin cookie session — `ploinky_jwt` with payload channel `cli`, user `local:admin` — is assigned exactly `authChannel = 'cli'` (`ploinky/cli/server/authHandlers/authContext.js:723-729`). That is also precisely the identity `isLocalAdminUser` most directly recognizes (`ploinky/cli/server/auth/localService.js:151-160`).

So §12's "Register a dedicated handler after normal authentication and the existing generic browser-mutation gate," plus the table's "Admin plus exact origin/session/host/generation mutation proof," is not delivered by the central gate for the most common deployment: on a local workspace, `POST /webtty/sessions`, `input`, `resize`, and `DELETE` from the canonical local admin would carry **no origin/CSRF/generation proof at all**. The only residual defense is the cookie's `SameSite: 'Lax'` attribute (`ploinky/cli/server/authHandlers/authRoutes.js:246`, 510, 645, 705), which blocks cross-site POST cookie attachment in modern browsers but is not the proof the plan's own invariant and §17.1's mutation-security row promise.

**Exact edit** — add to §12: "The central RoutingServer mutation gate deliberately exempts sessions with `authChannel === 'cli'` (RoutingServer.js:602-604), and the canonical `local:admin` cookie session is that channel. The WebTTY handler must therefore enforce a mutation proof itself on every mutating route for every channel, and must state which proof covers the cli-channel local-admin session — the local-control-origin admin proof (`verifyAdminMutationRequest`), or a deliberately extended browser mutation proof. Tests must include a mutating request from an `authChannel 'cli'` local admin." Add the same case to §17.1's Mutation security row.

Supporting unknown for the spike list: whether a local-origin request carries the route-plan lease/generation binding the browser-proof MAC requires (`ploinky/cli/server/browserMutationSecurity.js:86-96`) — if not, the admin-control proof is the only workable local mechanism.

### P2-1 — §13's routing seam table is incomplete: one deterministic test break and one silent fall-through hazard

All four named symbols exist exactly as the plan states (`ROUTER_SURFACE_CATALOG` at `ploinky/cli/sandbox/edgeGeneration.js:28-38`, `ROUTER_OWNED_FIRST_SEGMENTS` at `ploinky/cli/server/policy/HttpRouteAccessPath.js:12-27`, `isRouterOwnedPath` at `ploinky/cli/server/RoutingServer.js:215-240`). Two seams are missing:

1. `ploinky/tests/unit/httpRouteAccessPath.test.mjs:50-57` hard-codes the expected `ROUTER_OWNED_FIRST_SEGMENTS` set in a `deepEqual`, and line 43 enumerates reserved paths — adding `webtty` to the policy set without updating both breaks CI deterministically. §13's table lists only "Edge-generation tests."
2. The reservation in `edgeRoutePlan.js` is **two functions**: the selected-surface match in `surfaceForPath` (`ploinky/cli/server/edgeRoutePlan.js:493-495`) and the unconditional reservation in `isReservedRouterSurface` (`ploinky/cli/server/edgeRoutePlan.js:499-522`). The fail-closed guarantee the plan's routing table promises ("Reserved-path 404, never agent-root fallback") is produced solely by the second function feeding the deny at `edgeRoutePlan.js:750-752`; adding only the first produces a **silent** fall-through of `/webtty` to the agent root on non-selecting hosts — the exact behavior the constraints forbid.

**Exact edit** — in §13's table: reword the `edgeRoutePlan.js` row to "add the selected-surface match in `surfaceForPath` **and** the unconditional segment reservation in `isReservedRouterSurface`; the second is what the 'never agent-root fallback' row depends on," and add a row "`tests/unit/httpRouteAccessPath.test.mjs` — add `webtty` to the reserved-path loop (line 43) and the `ROUTER_OWNED_FIRST_SEGMENTS` lockstep set (lines 52-56)." Optionally add one sentence deciding CLI/observability parity (the removed core surface had `cli/server/utils/routerEnv.js` COMPONENTS, startup banner, and `/health` counter entries; the plan is silent).

### P2-2 — Direct retirement misses concrete consumers (plan §15, §16)

| Missed consumer | Evidence | Failure mode |
| --- | --- | --- |
| `ploinky/container/listener-inventory-tests.mjs:704` | `assert.equal(profile.requiredContainers.length, 20)` | Removing the webtty required-container entry from the profile leaves 19 → hard test failure |
| `ploinky/container/profiles/full-explorer-listeners.json:21` | `7681` remains in `controlPorts` | Stale-but-inert (membership set over observed records, `ploinky/container/listener-inventory.mjs:502,508`); §16.3's own absence-audit terms would flag it |
| Explorer repo rows + contract test | `'basic\|https://github.com/AssistOS-AI/basic.git'` at `AssistOSExplorer/.github/workflows/deploy-explorer-qa.yml:1005` and `destroy-explorer-qa.yml:436`, asserted present by `AssistOSExplorer/tests/smoke/lib/deploy-workflow-contract.test.mjs:31-33` | §15.2 removes the `basic` repo from the manifest, but §15.6 covers only *surface* enumerations — the workflow repo lists and their contract test break or go stale |

**Exact edit** — §16.3: add "update `container/listener-inventory-tests.mjs` required-container count 20→19, and remove `7681` from the profile's `controlPorts`." §15: add a step "Remove the `basic` repository row from `deploy-explorer-qa.yml` and `destroy-explorer-qa.yml` `GRAPH_REPOSITORIES` and update `tests/smoke/lib/deploy-workflow-contract.test.mjs` in the same change as the manifest repo removal."

For completeness: the `basic`-repo deletion list itself is complete, and `verify-retired-source-absence.yml` needs no change since `basic/webtty` is not in its forbidden list — adding it is optional hardening.

### P2-3 — §8 doesn't reconcile the anti-runtime-contract guard rails or the existing-image probe asymmetry

`container-image-builds/tests/box-transport-entrypoint.test.mjs` (read in full): its third test (lines 35-46) exists specifically to keep the Box identity versionless — line 44 forbids any `BOX_RUNTIME_CONTRACT|runtime-contract|contract-[0-9]+` mention in `reproduce-ploinky-box-private-routing.yml`, line 40 forbids Dockerfile LABELs, and admission hard-cuts on non-empty labels (`ploinky/ploinky-box/contract/image.mjs:137-146`). The plan's design is compatible in substance (contract as an in-image *file*, labels stay empty, no Box rename), and the reproduce workflow pulls-and-verifies rather than rebuilds, so no edit there is forced — but §17.2's per-arch native image evidence has no stated home, and if it lands in that reproduce workflow the guard regex trips. §8's "update the source-boundary assertions deliberately" names the right files but only describes the entrypoint-source invariant.

Separately: admission is asymmetric today — `inspectAndValidateImage` runs the `podman run --network=none` probe for new images (`ploinky/ploinky-box/contract/image.mjs:236-247`) while `inspectAndValidateExistingImage` (lines 249-258) does config-inspect plus ID equality only. §8 requires probing already-present images; that is a behavior change to the existing-image path the plan should name (seam: `validateExistingImage` in `ploinky/ploinky-box/lifecycle/transactions.mjs:251,270-271`).

**Exact edit** — extend §8's test-update paragraph: "The third test in `tests/box-transport-entrypoint.test.mjs` (unversioned marker, empty labels, and the anti-`runtime-contract` regex over the reproduce workflow) and `tests/image-definitions.test.mjs:509` are deliberate guard rails for the versionless Box identity; amend them consciously, keep `Config.Labels` empty and the marker unversioned, and state where the §17.2 per-arch evidence runs (a new workflow or manual evidence — not `reproduce-ploinky-box-private-routing.yml` unless its guard test is amended in the same change). The Box admission probe for already-present images extends `inspectAndValidateExistingImage`, which today performs no container probe — a deliberate behavior change."

### P3-1 — Unproven stale record fails all WebTTY readiness (plan §10)

Deliberately fail-closed and defensible, but one corrupt record then disables the feature until an operator clears `/run/ploinky/webtty` or restarts the Box. Consider per-record quarantine (refuse to signal, keep the feature up, surface the record as operator evidence), or at minimum document the recovery action.

### P3-2 — `beforeClose` is best-effort (plan §10)

The `uncaughtException` handler's shutdown call is commented out (`ploinky/cli/server/utils/processLifecycle.js:253-262` — the Router currently keeps running after an uncaught exception), and SIGKILL skips hooks entirely. The plan's real safety net — worker IPC-EOF self-cleanup plus startup reclamation — is correctly designed for this; add one sentence stating `beforeClose` is opportunistic and the records/IPC-EOF path is authoritative. The `/run/ploinky` record location is architecturally sound: the Watchdog runs in-Box and the Box's main process is `sleep infinity` under `--init`, so `/run/ploinky` survives Router crash+respawn and dies with the Box (mount and create args at `ploinky/ploinky-box/lifecycle/container.mjs:101-129`).

### P3-3 — Listener-profile ordering dependency (plan §18)

The listener profile's webtty rule is `minMatches: 1` (`ploinky/container/profiles/full-explorer-listeners.json:330-340`), so between §18 groups 4 and 5 any full-deployment listener validation *requires* the deleted agent. §18's "no interim mixed deployment" already prevents this; make the dependency explicit, or land the ploinky profile cleanup in the same integration point as Explorer's removal.

### P3-4 — No browser-level test for the new `/webtty` (plan §15/§17)

No Explorer smoke or e2e test exercises Open Terminal Here today, so the cutover deletes nothing test-covered — but the new admin-only `/webtty` page also ships with no browser-level test beyond §17.2's Box evidence. An optional Playwright smoke spec (admin sees and opens the terminal; non-admin sees no menu item and gets 403) would close that. Also worth stating in §15.5: the current menu item is shown to *all* users (`AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp-menu-contributions.js:215-228`, `disabled: false`, no role check), so the admin gate is new behavior; the two existing private admin predicates the plan wants factored are at `explorer/web-components/pages/file-exp/file-exp-application-plugins.js:38-44` and `explorer/services/profileAvatar/avatarApi.js:57-68`.

### P3-5 — Builder-stage npm availability (plan §8)

The current rootfs copies only the `node` binary and `/usr/local/lib/node_modules` from the Node stage (`container-image-builds/images/ploinky-box/Dockerfile:13-14`) — no `npm` symlink was observed, so the builder stage must invoke npm by explicit path (`node /usr/local/lib/node_modules/npm/bin/npm-cli.js ci`) or create the symlink.

---

## What the plan gets right (verified confirmations by task area)

The plan's accuracy rate is unusually high — its §22 "Observed" paragraph survived adversarial checking essentially intact.

| Area | Result |
| --- | --- |
| 1. History/baseline | All four repo baselines match the stated SHAs exactly. `agentlib-direct-mount` (`9ab08acf`) **is** an ancestor of master. All five cited historical commits are real and correctly characterized — `9d362fc` (2025-09-08) added `cli/lib/webtty/*` and `node-pty ^1.0.0`; `704fbea` (2026-06-23) removed the core surface, `node-pty`, and the `globalDeps` seed; the basic/container-image-builds/Explorer commits match their stated subjects and dates. One nuance the plan handles correctly: the surface-catalog system postdates the old removal, so a re-add must satisfy both old and new seams — which §13 mostly does (see P2-1). |
| 2. Filesystem | The mount table in §3 is exactly right (`ploinky/ploinky-box/lifecycle/container.mjs:101-129`): workspace rw at `/workspace`, checkout ro at `/opt/ploinky`, workspace `dependencies` dir bound **over** `/opt/ploinky/node_modules` (making it unsuitable for immutable packaging, as claimed), exactly two publishes (127.0.0.1 TCP + UDP 7882), `--init`, unprivileged `podman` user. §4's claim that `basic/webtty`'s `.` mount resolves to the overall workspace is confirmed by the resolution code (`ploinky/cli/utils/runtime/manifestVolumePolicy.js:14-24`, resolving non-absolute sources against `PLOINKY_WORKSPACE_ROOT=/workspace`), and in-Box manifest sources reject absolute paths and symlink escapes (`ploinky/cli/sandbox/runtimeCapabilities.js:248-265`), so the old agent indeed cannot see arbitrary host paths. |
| 3. Runtime architecture | The Watchdog is genuinely single-child with scalar restart state (`ploinky/cli/server/Watchdog.js:72-88`), so the plan's refusal to expand it is correct. `beforeClose` exists as an async hook array (`ploinky/cli/server/RoutingServer.js:998-1010`) that a `WebttySessionManager.closeAll()` can join. Fork-per-terminal is the right choice of the three candidates: node-pty **in** Router puts native segfaults in the routing process for the whole workspace; a Watchdog-owned broker requires rewriting the single-child supervisor and keeps an idle process alive; per-terminal workers give crash isolation, zero idle cost, and IPC-EOF-driven cleanup that survives Router SIGKILL (kernel closes the channel; workers self-clean; PTY-master close SIGHUPs the shell), with PID-reuse protection via start-token revalidation. The webchat precedent (`ploinky/cli/server/webchat/tty.js` detached spawn + group kill with 500ms escalation) confirms the house pattern. The recovery-record design is sufficient for the narrow simultaneous-crash gap, and the plan correctly refuses to promise reaping of deliberately daemonized descendants. One unavoidable residue the plan implicitly accepts: a microscopic TOCTOU between the final `/proc` identity check and `kill(2)` — the standard practical limit without pidfd. |
| 4. Packaging | The Dockerfile really is staged with a final `FROM scratch AS runtime` copying a prepared rootfs, Fedora-based podman base by digest, Node 24; the publish workflow builds **natively on separate amd64/arm64 runners** (QEMU is affirmatively forbidden by `container-image-builds/tests/image-definitions.test.mjs:600`) and checks out the exact Ploinky SHA under `sources/ploinky` with cleanliness proofs — all as the plan claims. Putting the PTY smoke inside the Dockerfile respects the "no behavioral gates in the workflow" tests. The stable-fingerprint idea matches reality: admission is already structural (no source-SHA comparison; the SHA lives only in OCI index annotations), so unrelated commits already don't force a new Box. No second image, no new port, no LABEL/EXPOSE/VOLUME. The retired image pins `node-pty` at exactly `1.0.0` (no caret, `container-image-builds/images/webtty-agent/app/package.json:9`) and runs it on Node 24 (Debian, QEMU-built arm64) today — so §7's spike premise is grounded, and the plan is right that Fedora/native-arm64 still needs proving. |
| 5. Auth | `ensureAuthenticated` handles local, SSO (with refresh), and guest; `isLocalAdminUser` recognizes role `admin`, username `admin`, and `local:admin` — the "local and routed admin forms" claim holds. The plan's reason for rejecting `requireAdminControlRequest({mutation:true})` is operatively confirmed: the admin CSRF can never be minted on a routed host (`canonicalControlOrigin` nulls on forwarding headers; `mintAdminCsrfToken` throws — `ploinky/cli/server/adminControlSecurity.js:28-64`). The plan's honesty is verified: logout/revocation emit **no** reusable event (only a log line), and no long-lived stream re-validates sessions today (webchat SSE has only a keepalive timer, `ploinky/cli/server/handlers/webchat/runtimeRoutes.js:197-210`) — so the periodic auth-lease is genuinely required, and it is buildable response-free from existing resolvers (`getUserSession`/`getSession`/`isSessionRevoked`), with the session `sid` stable across JWT re-mints so a stored lease still observes later revocation. One strengthener: the Router process env contains the merged workspace env **including `.ploinky/.secrets`** (`ploinky/cli/commands/workspaceUtil.js:201-210`), which makes §9's explicit env allowlist for workers/shells mandatory, not merely defensive — the plan got this exactly right. |
| 6. Routing/API | Reserved-surface fail-closed is real and tested for webchat (`ROUTE_SURFACE_DENIED` 404, `ploinky/tests/unit/edgeGenerationHardCut.test.mjs:810-888`); generation binding is central (lease capture + `commitRouteGeneration`); host surface selection is operator-config with a loud unknown-surface error at generation-apply (`ploinky/cli/sandbox/edgeGeneration.js:652-663`), so no new authoring code is needed. GET-never-creates, SSE-attach-only, non-enumerating 404s, bounded bodies/replay are all enforceable at the described seams. |
| 7. Cwd | The decode-once/JSON transport design is correct: no server-side second percent-decode means `%2e%2e` from double-encoding becomes a literal (nonexistent) name, not traversal; NUL/backslash/absolute/drive/UNC/`..` rejections precede normalization; realpath-plus-prefix containment with a worker-side re-check catches symlink escapes and Router-to-worker directory swaps, and the plan's required tests explicitly cover literal-percent vs double-encoding and the between-check mutation. The plan also correctly frames containment as start-cwd selection, not a sandbox, for a trusted admin. The browser never sends a physical host path (`openTerminalHere` sends a slash-stripped workspace-relative `dir`, `AssistOSExplorer/explorer/web-components/pages/file-exp/file-exp.js:1737-1752`). |
| 8. UI/Explorer | `openTerminalHere` works exactly as described (agent-port URL, leading-slash strip, relative `dir`). `buildAgentPortUrl` has exactly one production caller (WebTTY) — deletion is safe; the OnlyOffice hit is test data only. `deploy-explorer-qa.yml:1137-1147` is the **only** workflow enumerating `routerSurfaces`, so §15.6's target list is complete. Choosing maintained `@xterm/*` packages is grounded: the retired image pins deprecated `xterm 5.3.0`-era names, and the old core loaded xterm from the unpkg CDN — vendoring with checksums is strictly better. |
| 9. Retirement | The `basic` deletion list is complete (`basic/webtty/` holds only `manifest.json` + `healthcheck.sh`; no stray references anywhere in that repo; the matrix row regenerates from DS frontmatter). The two ploinky profile entries are exactly where §16.3 says (`full-explorer-listeners.json:126-131` and `:329-341`). Old-protocol prohibitions are grounded: the retired agent server mints its own `webtty_agent_sid` cookie with no real auth and `GET /stream` both mints a session and spawns bash. No tombstones/redirects proposed; registry tag deletion correctly excluded. |
| 10. Verification/release | The test matrix covers destructive (worker/Router/Box crash separately, plus the simultaneous-crash record path), concurrency (quota races), malformed input, and absence checks; the release order is exercisable on exact revisions with no compatibility code, and §17.3 correctly defers the cross-repo Explorer/Playwright gates to explicit user request per ploinky/CLAUDE.md. |

## Observed / Inferred / Unknown

**Observed (personally, this review session):** all baseline SHAs and ancestry; the five historical commits' content; existence of every plan-referenced file; `RoutingServer.js:601-620` gate condition and dispatch order; `authContext.js:719-732` cli-channel assignment; `SameSite` cookie attributes; `edgeRoutePlan.js:488-522` both functions; `httpRouteAccessPath.test.mjs:38-57`; `box-transport-entrypoint.test.mjs` (full file); the reproduce workflow's pull-and-verify shape; `container.mjs:101-129` create args; `processLifecycle.js:247-262`; `explorerManifestPublicExposure.test.js:25-35`; `listener-inventory-tests.mjs:702-704`; `deploy-explorer-qa.yml:1005`; `full-explorer-listeners.json` webtty entries and `minMatches`; retired-agent `package.json` pins and endpoint shape; the old core's CDN xterm loading.

**Delegated (five read-only exploration agents; at least one citation each re-verified verbatim before use):** the full auth-resolver, session-store, and logout traces; the complete webchat seam inventory; the Watchdog/entrypoint/mount-resolution traces; the Dockerfile/workflow/test full reads; the Explorer/basic reference sweeps.

**Inferred:** severity judgments; the silent-fall-through consequence of a missing reservation entry; `controlPorts` inertness; the dev-loop consequence in P1-1.

**Unknowns requiring a spike** (beyond the plan's own §22 list, which correctly names the node-pty/Fedora/arm64, PTY topology, `/proc` fields, and crash-behavior spikes):

| Unknown | Decides |
| --- | --- |
| Whether a local-origin request carries the route-plan lease/generation binding needed to mint the browser mutation proof for cli-channel sessions | The P1-2 mechanism (browser proof vs admin-control proof for local origins) |
| Where §17.2's per-arch final-image evidence runs | The P2-3 guard interaction with `reproduce-ploinky-box-private-routing.yml` |
| The base image's `/run` tmpfs behavior | Immaterial to the design — `/run/ploinky` is writable and Box-lifetime either way |

## Verdict

**APPROVE WITH CHANGES** — apply the two P1 edits and three P2 seam/test additions to the plan text (the P3s at the author's discretion); no architectural rework is needed, and implementation can start once §2.11/§8/§18/§19 agree on one failure semantic.
