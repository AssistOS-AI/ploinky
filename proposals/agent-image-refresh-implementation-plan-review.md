# Review: Agent Image Refresh Implementation Plan

Status: independent read-only review. No plan or code file was edited.

Review date: 2026-11-03.

Reviewed artifact: `proposals/agent-image-refresh-implementation-plan.md`, checked against branch `claude/dazzling-fermi-59l84k` at `6127f55`, plus `/home/user/AssistOSExplorer` and `/home/user/container-image-builds`. One live registry probe was run (see §4).

Verdict: **CHANGES REQUIRED before handing this to an implementer.** The direction is sound: an anonymous Bearer `HEAD` by tag, a set-membership test against the local repo digests, pulls before locks, and recreation keyed on the container's image ID. There are no P0 findings. There are two P1 findings: the plan text as written would crash `ensureAgentService`, and its local-only rule silently overwrites local builds in the Box. Several P2 findings cover guarantee gaps, race placement, operational risk and over-engineering. Most `file:line` references are accurate (§4).

## 1. Findings ranked by severity

### P1-1. D6 code as written throws on the hot path of every start

The plan's code for the `ensureAgentService` hook contains four constructs that throw. Each one sits inside the recreate-reason block, which every container start, restart and no-wait launch passes through.

- **Null dereference.** The plan writes `serviceLlmAdmissionContext.catalogIdentity.imageRef || image` (D6, bullet 2). For every non-LLM agent, `resolveLlmRuntimeAdmissionContext` returns `catalogIdentity: null` (`cli/sandbox/docker/llmRuntimeIntegration.js:214-218`). This throws a `TypeError` for every non-LLM container agent. It must be `catalogIdentity?.imageRef`.
- **`readMpsLaunch` throws.** Phase 2 step 3 uses `readMpsLaunch(options.mpsLaunch, …)?.imageId`. That function throws an `MpsError` when the key or share does not match (`cli/sandbox/hardwareLimits/mpsLaunch.mjs:16-19`), and `?.` does not catch a throw. The MPS special case is also unnecessary. MPS coordination runs `ensureImagePresent` and inspects the same ref under the same locks immediately before it creates the container by ID (`mpsLifecycle.mjs:151-154, 352-354`). So `image inspect --format {{.Id}} <desired ref>` returns the same ID. Drop the special case.
- **`normalizeImageId` throws.** It raises `PLOINKY_DEPS_IMAGE_IDENTITY_REQUIRED` instead of returning null (`cli/utils/dependencies/store/installContract.mjs:47-53`). The plan says the helper "returns null" on unparsable evidence, so it must wrap every inspect and normalize call in `try/catch`.
- **Name collision.** The plan exports `inspectContainerImageId` from `imageIdentity.mjs`. `agentServiceManager.js:1400` already declares a module-local function with that name, and its meaning is different: it returns the image ID of an image ref. It is used at `:1856`, and `tests/unit/hardwareLimitsInstallerImage.test.mjs:60` asserts its source text. Importing the new export without an alias is a duplicate-declaration `SyntaxError`, which stops the whole CLI from loading. Rename the new exports, for example `readContainerImageId`, `readLocalImageId` and `readRepoDigests`. Do not rename the existing local function.

Fix: rewrite the D6 bullets and Phase 2 step 3 with these corrections. Gate the check on `existingRuntimeAtEntry && !recreateReason`, so targeted or forced recreates do not spawn extra inspects. Insert it after the AgentLib block, which spans `agentServiceManager.js:4282-4289` (the plan says ":4283"), and before the dependency block at `:4296`.

### P1-2. The "local-only" rule does not hold under Podman, so acceptance #3 is false and a documented dev workflow breaks

D2 treats "present with empty or `null` RepoDigests" as local-only. That signal is reliable only on Docker's classic store. Podman, which runs every Box, lists `<name>@sha256:<manifest digest>` in RepoDigests for images it built or committed itself. Docker's containerd image store very likely does the same. It is the default for new Engine installs, and this machine's client is Engine 29.9.2.

The concrete breakage is `container-image-builds/scripts/install-roboteam-local-in-box.sh`:

1. It runs `podman build -t docker.io/assistos/roboteam-agent:runtime` inside the Box.
2. It then runs `ploinky-local reinstall roboTeamAgent`.
3. Under the plan, the next `ploinky start`, `restart` or `update` sees that the registry digest is not in the local set. It pulls, overwrites the developer's build, and recreates roboTeamAgent and roboWorkAgent from the published image.

The plan's unit test ("local-only refs make zero fetch") would pass while production behaves otherwise.

Fix:

- **Phase 0, before writing code.** Verify empirically with `podman build -t docker.io/x/y:t . && podman image inspect --format '{{json .RepoDigests}}' docker.io/x/y:t`, and do the same on Docker with the containerd store.
- **State the semantics explicitly.** Recommended for v1: "a mutable registry reference follows its registry". Keep the empty-RepoDigests skip only as a Docker-classic nicety, not as a guarantee.
- **Add a persisted per-workspace opt-out.** Read the policy from `process.env.PLOINKY_IMAGE_REFRESH`, then from the workspace var `resolveVarValue('PLOINKY_IMAGE_REFRESH')`. There is precedent: `agentServiceManager.js:2157` reads `PLOINKY_AGENT_CLIENT_ID` this way. This makes `ploinky var PLOINKY_IMAGE_REFRESH off` work inside the Box with no supervisor change. It can replace Phase 4 step 11's env forwarding.
- **Coordinate the dev script change** (in container-image-builds): it should set the var, or tag local builds under `localhost/`.
- **Deferred alternative,** only if local builds must survive automatically: Ploinky records `canonicalRef → imageId` whenever `pullImage` succeeds, and refreshes only when the local ID equals the recorded ID or no record exists. This adds state and can be a follow-up.

### P2-1. The recreation guarantee has a bypass, so acceptance #2 is false

The no-wait worker adopts a ready runtime without calling `ensureAgentService` when all of these hold: the dependency check finds no problem, there is no `link-install`, and the network is not `default` or `bridge` (`cli/commands/noWaitWorker.js:1966-1981`).

Take a no-wait agent with `host` or `none` networking that has a `start` command and no `package.json`. Its `needsDependencies` is false, so the dependency check returns `''` (`agentServiceManager.js:1413-1432`). That agent is never recreated after its image moves.

Fix: add the image-identity reason to that `adopted` predicate, and add a unit test for it.

### P2-2. The motivating agents are no-wait, so the start and restart pre-passes never touch them

In AssistOSExplorer, `explorer/manifest.json` enables `"roboTeamAgent global no-wait"`, and roboTeamAgent enables `"roboWorkAgent global"`. Every path to them crosses a no-wait edge, so `classifyDependencyGraphWaitMode` puts both in `noWait` (`cli/utils/workspaceDependencyGraph.js:385-421`). All of Explorer's blocking nodes use pinned `ploinky-node@sha256` images. Two things follow:

- **The pre-passes are no-ops for this case.** The start pre-pass (D5, "blocking nodes") and the full-restart pre-pass do nothing for `roboteam-agent:runtime`. Phase 3 step 9, the no-wait worker change, is the only thing that delivers the motivating case on `start`. On `restart`, both agents are stopped first and their pull happens afterwards in the workers, so the "downtime excludes pull time" claim does not hold for them.
- **Recreation already works for these two agents.** Both have no `start` command, so `needsDependencies` is true. Once the tag moves, `runtimeDependencyReuseProblem` already returns `'runtime image changed'` (`runtimeDependencies.mjs:391`), giving `dependencyGenerationChanged` (`agentServiceManager.js:4296-4310`). For them the only missing piece is the pull. D6 is a generalization for start-command agents without a `package.json`.

Fix:

- Order Phase 3 by value: the worker, then targeted restart, then start, then full restart, then update.
- Give the full-restart and update pre-passes `includeNoWait: true`. Restart is about to stop those agents anyway, and this keeps the pull out of their downtime.
- Add a manual step on the real Explorer graph. After a re-push, both containers should be recreated. The second worker, roboTeamAgent in the later wave, should report the image as `current` and make no second pull.

### P2-3. Retag race: place the pre-passes after settlement

The plan runs the start pre-pass before `acquireSettledWorkspaceMutationLease`, and the full-restart pre-pass before `settleWorkspaceBeforeRestart()`. Both are windows in which an earlier start's no-wait workers can still create and attest containers under the lease.

A moved tag then fails attestation: the container's `.Image` no longer matches a fresh `image inspect` (`routerAuthorityAttestation.js:752` against `agentServiceManager.js:2467` and `:2548`). This failure is fail-closed. It cleans up the candidate, and it heals within the very command that caused it, because that command supersedes the earlier workers. It does not wait for the "next start" (§7 of the plan says it does).

Cheap fix with no extra lock:

- **Start:** `await waitForNoWaitRunsToSettle({ operation: 'workspace-start' })` (exported, holds no lease, `noWaitRunSettlement.js:151`), then refresh, then `acquireSettledWorkspaceMutationLease`.
- **Full restart:** refresh after `await settleWorkspaceBeforeRestart();`, which has released its lease by then (`workspaceUtil.js:3711-3740`), and before `inactivateEdgeRoutingGeneration('cli-workspace-restart')`. Agents are still serving at that point, so downtime is unchanged. The existing ordering test `tests/unit/cliLifecycleInactivation.test.mjs:64-70` still passes.
- **Update image phase:** optionally do the same settle wait before pulling.
- **Phase 5 create-by-ID:** drop it (see §3).

### P2-4. Over-engineering: simplify before giving this to a mid-tier implementer

Recommended cuts, none of which loses correctness for the user's goal:

| Plan element | Recommendation | Why |
| --- | --- | --- |
| `registryAuth.mjs`: auth.json reading, the Basic flow, `credHelpers`/`credsStore` detection | **Drop.** On 401 or 403 after the anonymous token, **delegate** to `<runtime> pull`. | In-Box Podman auth lives in `$XDG_RUNTIME_DIR` on a tmpfs that resets every Box start. Docker Desktop uses `credsStore`, which the plan already delegates. Dropping this removes the credential-handling surface (invariant 8). |
| `GET` plus `sha256(body)` fallback for registries without `Docker-Content-Digest` | **Drop.** Delegate to pull instead. | Rare in practice, and it adds a code path that counts as a pull on some registries. |
| Check concurrency of 4, a 60 s phase budget, a one-redirect-hop cap | **Drop.** Use sequential checks, a 10 s timeout per request, the per-host breaker, and default `fetch` redirects. | There are 1-3 mutable refs in practice. The breaker already bounds worst-case latency. |
| Proxy detection that matches `NO_PROXY` | **Simplify.** Any `HTTPS_PROXY`/`ALL_PROXY` (either case) without `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` means delegate. | `NO_PROXY` semantics are subtle, and delegating is safe. |
| Record fields `containerImageId` and `containerImageDigest` (D6 "Registry record") | **Drop.** | Nothing reads them, since the recreate decision uses inspect. Writing them also changes the `containerMonitor.js:394` restart digest. |
| Graph-level `imageIdentityReasonImpl` in `graphNodeRuntimeReplacementReason` | **Drop.** Use `ensureAgentService` plus the worker predicate (P2-1). | This mirrors `dependencyGenerationChanged`, which lives only in `ensureAgentService` and is exercised by the real start path (`tests/unit/dependencyStoreRuntimeIntegration.test.mjs:371-379`). The graph check can never see no-wait images anyway, because they are not pulled yet at planning time. It also saves churn in 4 test files. |
| MPS `launch.imageId` special case | **Drop** (P1-1). | Equivalent to inspecting the ref. |
| `local-build` skip rule | **Drop.** | `LOCAL_IMAGE_BUILD_DEFINITIONS` is empty and not exported (`common.js:158`). |
| The pre-pass pulls *missing* images | **Skip missing images.** The worker prefetch and the in-lease `ensureImagePresent` handle them as today. | Avoids a second attempt and a doubled timeout on failure. Keeps first-start behavior unchanged. |
| `resolveAgentLaunchImageRef` running a new LLM probe in targeted restart | **Use `descriptor.catalogIdentity?.imageRef \|\| resolveManifestImage(...)` everywhere.** | The admission already carries it: `admittedStart.admissions[]`, `directAdmission` (`cli.js:491` via `workspaceUtil.js:3821`), and the worker's `runtimeAdmission`. |

Simplified D1/D7 decision rule:

1. Send `HEAD`. On a 401 Bearer challenge, fetch an anonymous token and send `HEAD` again.
2. A 200 with a valid digest gives a membership test, then `current` or `pull`.
3. DNS, connect, timeout, 5xx or 429 gives **unavailable**: warn and keep the cached image.
4. Everything else gives **delegate** (`<runtime> pull`): 401/403/404 after the token, a non-Bearer challenge, TLS-class errors, a proxy in use, or a missing digest header. The engine owns credentials, proxies, CAs and insecure-registry configuration.

The plan must list the TLS-class errors explicitly as `err.cause.code` values:

- `CERT_*`
- `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
- `SELF_SIGNED_CERT_IN_CHAIN`
- `DEPTH_ZERO_SELF_SIGNED_CERT`
- `ERR_TLS_*`
- `ERR_SSL_*`
- `EPROTO`

`EPROTO` also covers a plain-HTTP registry.

### P2-5. Error containment in the new pre-pass code is under-specified

- **Full restart.** The new `preflightWorkspaceStartRuntimeCapabilities()` call in `cli.js` runs outside `startWorkspace`'s try/catch. It can throw for manifest, graph or LLM-catalog reasons. Target collection also calls `resolveManifestImage`, which throws on unresolved `${…}` placeholders (`secretVars.js:782-790`). The plan only says "only policy errors propagate" for `startWorkspace`. State the same for `cli.js` restart, targeted restart, the worker and update: collection errors are caught per node and globally, and the refresh is skipped with a debug line.
- **Policy validation order.** The plan says an invalid policy "throws before any mutation", but the start hook sits after `prepareDefaultBootRepositories` and `prepareManifestRepositories` (`workspaceUtil.js:2950-2958`). Those clone and update checkouts. Parse the policy at the top of `startWorkspace`, of the restart branch, and of `runUpdate`. In update, emit a `PLOINKY_UPDATE_*`-coded failed record so the existing `thrownRecord` path turns it into a record.
- **Update image phase.** It must run inside the outer `try` of `runUpdate` (`updateCommand.js:119-155`), so that an `UpdateCancelledError` from `cancellation.checkpoint('image', …)` becomes a `cancelled` record. It should run even if a git phase failed, but not after a cancellation.

### P2-6. A broken re-push now propagates automatically, and rollback cannot undo it

Before this change, a bad `roboteam-agent:runtime` push only hurt fresh installs. After it, the next `start`, `restart` or `update` on every workspace pulls the bad image and recreates the agents.

The Box rollback path cannot restore the previous state. `restorePriorGraph` in `ploinky-box/supervisor.mjs:1131-1146` re-runs the prior start argv against the same image store. The tag has moved, so the old image survives only as an untagged ID.

The plan should state this, and say that manual recovery is `podman tag <oldId> <ref>`. Any cleanup (Phase 5) must never remove a superseded ID before its replacement passed readiness. The publish workflow ships `linux/amd64,linux/arm64` with `provenance: false`, and buildx output is not reproducible, so every push to `main` that touches the image paths triggers a pull and a recreate everywhere.

### P2-7. Disk growth in the workspace image store

Each re-push of a multi-GB image leaves a dangling image in `.ploinky/box/images` once its containers are recreated. That directory is workspace-backed and survives Box destroy (`docs/specs/DS004-main-behavior.md:45,103`). Nothing removes these images short of `destroy --delete-cache`.

Make an explicit v1 decision. Recommended minimal version: after a command's graph reached readiness, run `<rt> image rm <supersededId>` without `--force` for each ID this command superseded, and ignore failures. The engine itself refuses to remove an image that a running or stopped container, or another tag, still references. If keeping one generation for manual rollback (P2-6) matters more, state that instead.

### P2-8. Test plan gaps, and existing tests that break but are not listed

Existing tests that break and are not listed:

- `tests/unit/noWaitWorker.test.mjs`, test `an LLM runtime never prefetches the manifest image the catalog will replace` (≈`:3005-3027`). It asserts the LLM skip that the plan removes, so it must be rewritten, not just awaited.
- `tests/unit/noWaitWorker.test.mjs:2930-2984`. It asserts synchronous return shapes and `ensureImage(image, {runtime, allowLocalBuild:false})` exactly. The plan must define the new injection seam, for example `refreshImage = (ref) => session.refresh(ref)`, and the result shape.
- `tests/unit/hardwareLimitsInstallerImage.test.mjs:60`. It breaks if an implementer resolves the P1-1 collision by renaming the existing function.

Tests to add:

- A **behavioral** fake-engine test: start, change `FAKE_ENGINE_IMAGE_HEX`, start again, and assert the replacement reason is `imageChanged` for a start-command agent without `package.json`. The fake engine already freezes `Image` at create and makes `image inspect` follow the environment (`tests/unit/dependencyStoreFakeEngine.mjs:20,59-66,94-99`), so only the `{{.Image}}` format from plan step 6 is missing.
- A source-order test that the `ensureAgentService` image check precedes `adoptManagedRuntimeOnly = !managedReconciliationPreparationLease` and the host/none early return. Copy the pattern of `dependencyStoreRuntimeIntegration.test.mjs:371-375`.
- The worker adoption predicate (P2-1).
- Collection errors in restart and update never fail the command.
- An invalid policy is rejected before repo preparation.
- Cancellation during the image phase.
- The Podman local-build case, whichever semantics are chosen (P1-2).

Integration note: under Docker, the shell suites' `tests/testAgent/manifest.json` (`node:24.15.0-bullseye`) would `HEAD` Docker Hub on every start. See P3-1.

The manual recipe should add the Explorer no-wait graph (P2-2) and the in-Box local-build case (P1-2).

## 2. Lower-severity notes (P3)

1. **Unqualified refs behave differently per engine.** Under Docker, the default `node:18-alpine` (`secretVars.js:762`) and official version tags such as `node:24.15.0-bullseye` would be checked and periodically re-pulled and recreated, because Docker Library rebuilds those tags. Under Podman they are skipped. Recommendation: refresh only refs with an explicit registry host, on both engines. That is consistent, keeps tests free of network traffic, and all AssistOSExplorer refs are qualified.
2. **`additionalNodes`.** Extra enabled runtimes are launched synchronously (`await launchAdditionalRuntimes`, `workspaceUtil.js:3513`), so the collector must treat them as blocking. `classifyDependencyGraphWaitMode` covers only graph nodes.
3. **Targeted restart placement.** Refresh only after the precondition checks (`cli.js:633-648`: registered record, running state and accepted-drain checks). Skip the refresh when `directAdmission` carries a hardware refusal, so it never pulls gigabytes for a restart that will be refused.
4. **`restart router`.** It still reconciles drift through `startWorkspace`. With D6, it recreates any agent whose tag moved since creation, for example after `update <repo>` pulled. The "containers untouched" message becomes approximate. Likewise, acceptance #6 ("`off` restores today's behavior") is not exact, because `imageChanged` is not gated by the policy. Say so in the plan; both are acceptable.
5. **Pull budget.** A pull killed at the 15 min budget keeps completed layers, but a single layer that cannot finish in 15 min never refreshes. Document this, or derive the budget from `PLOINKY_IMAGE_PULL_TIMEOUT_MS`.
6. **Registry mirrors and pull-through caches** (`registry-mirrors`, `registries.conf` mirrors). The `HEAD` goes to the origin while the pull may come from a lagging mirror, giving "changed; pulling" on every command until the mirror catches up. Document it.
7. **Docker Hub quota.** Delegated pulls and the `always` policy may count against Docker Hub pull quota, because a pull fetches the manifest with `GET`. On 2026-11-03 the probe returned `ratelimit-limit: 100;w=3600` for anonymous `HEAD` responses.
8. **Pinned detection.** Treat any `@<algorithm>:<hex>` as pinned, not only `@sha256:`.
9. **Box env forwarding**, if kept. Pass the value into `boundedCoreEnvironment` and `buildContainerExecArgs` explicitly rather than reading `process.env` inside them. That keeps the exact-argv tests in `ploinkyBoxCli` and `ploinkyBoxSupervisor` hermetic.
10. **New `image` update phase and version skew.** Version skew is not a problem. The host relaunches itself after a self-update (`ploinky-box/bin/ploinky-box.mjs:899`), and the in-Box core runs from the same `/opt/ploinky` mount (`ploinky-box/lifecycle/container.mjs:187`). Host validation at `updateOutcome.js:240` therefore accepts the new phase. Say this in the plan so nobody adds compatibility code.
11. **Log wording.** `(sha256:bc7c… -> local sha256:0a1b…)` reads as if the remote replaced the local. Use `(local sha256:0a1b…, registry sha256:bc7c…)`.
12. **Shared tags after a targeted restart.** `restart roboTeamAgent` moves the tag shared with roboWorkAgent, which keeps running the old image until its next lifecycle pass. Consider naming the other agents on that ref in the summary line.
13. **Docs.** DS004 (main behavior of `start`, `restart` and `update`) may need a sentence besides DS006 and DS009.

## 3. Open questions: recommendations

- **Q1 (`pull-failed` during `update`).** Record it as `skipped` with code `image-pull-failed`, `attempted: true`, `required: false`. That gives exit 0 and status `complete-with-skips`, and the record is still named under "Not verified" (`updateSummary.js:37-41`). This matches the rule that registry and pull problems never fail `start` or `restart`, and the cached image keeps working. Exit 1 (`partial`) would make a successful git update look failed to automation.
- **Q2 (manifest `imagePullPolicy`).** No. Digest pinning is the per-agent opt-out, and the workspace policy (env or var, P1-2) is the global one. A manifest field would be agent-controlled policy in workspace-writable files, and it would change the admission and manifest digests.
- **Q3 (catalog `digest` → `ref@digest`).** Do half of it in v1: treat catalog images that declare `digest` as **pinned for refresh**, and skip them. Today the catalog digest is only hashed into the reuse labels and never enforced (`llmRuntimeIntegration.js:171-190`, `llmArchitectureSelector.js:255`). Refreshing such a tag would deliberately diverge from the declared digest. Creating containers from `ref@digest` is a separate change, because it alters reuse hashes, labels and `containerImage` records.
- **Q4 (`reinstall` and `enable`).** Leave them out of v1. They keep missing-only pulls plus forced recreation or `imageChanged`. An optional follow-up is to reuse the targeted-restart single-ref hook in `reinstall <agent>`, since operators treat it as "fresh container".
- **Retag race.** Accept it, shrink the windows with settle-first ordering (P2-3), and document it. The failure is fail-closed and heals within the superseding command. Two sibling workers on one ref do not race in practice: the later one sees `current`, because the barrier orders roboWorkAgent before roboTeamAgent. **Do not** implement create-by-ID (Phase 5 step 13, second half). Its blast radius covers the `containerImage` record and the LLM dependency fallback (`agentServiceManager.js:1433`), the installer identity split (`selectLaunchImages`, `:1536`), the attestation target, entrypoint and shell detection, and the reuse labels. That cost is out of proportion to a rare, self-healing race.

## 4. Verified claims

The probe on 2026-11-03 matched the plan exactly. `HEAD registry-1.docker.io/v2/assistos/roboteam-agent/manifests/runtime` returned 401 with a `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:assistos/roboteam-agent:pull"` challenge. With the anonymous token it returned 200, `application/vnd.oci.image.index.v1+json`, and digest `sha256:bc7c8956426d8173cae0df1c7c61a7f9390d6043c97af2d6f70b12dba156665c`. The index has `linux/amd64` and `linux/arm64` members.

| Plan reference | Result |
| --- | --- |
| `common.js` `ensureImagePresent` :287, `imageExists` :181, `pullImage` :204, `LOCAL_IMAGE_BUILD_DEFINITIONS` :158 | Correct. The map is empty and not exported. |
| `agentServiceManager.js:2234` (create path), `:2722-2751` (managed path), `:1745` (LLM image), `:1536` (`selectLaunchImages`), `:1413` (`containerDependencyReuseProblem`), `:2467` and `:2548` (adoption), `:2994` and `:4744` (record writes) | Correct. |
| `ensureAgentService` :3805, checks :4253-4380, AgentLib check ":4283" | Close. The block is 4282-4289. Insert after 4289. |
| `runtimeDependencies.mjs:391`; `runtimeCapabilities.js:523`; `llmArchitectureSelector.js:254-280`; `mpsLifecycle.mjs:151-154, 352-354`; `routerAuthorityAttestation.js:30`, `:752`; `installContract.mjs:47`, `:56`; `reposSource.mjs:21`; `secretVars.js:762`; `containerMonitor.js:394`; `llmArchitectureCatalog.js:259` | Correct. Note that `normalizeImageId` **throws** (P1-1). |
| `workspaceUtil.js` `graphNodeRuntimeReplacementReason` :1285; start order :2950-2970 (`admittedStart` :2961, reset :2965, lease :2970); `classifyDependencyGraphWaitMode` :3168 | Correct. |
| `cli.js` router restart :440, targeted container restart :653, full restart :671-680 | Correct. Targeted restart is `forceRecreate: true` through `reconcile.mjs:253-264`, so recreation is guaranteed there regardless of D6. Full restart stops every agent, so `runtimeStopped` guarantees recreation too. |
| `noWaitWorker.js` prefetch :1470, call :1911 | Correct. The plan missed the adoption shortcut at :1966-1981 (P2-1). |
| `updateCommand.js` `runUpdate`; `updateOutcome.js:14` (phases), `:240` (validation); `supervisor.mjs:2404` (`restart = activity.active && decision.activationAllowed`), `:1830`, `:4423`, `:4461`, `:4664`; `execute.mjs:13`; `constants.mjs:99-104` | Correct. Targeted update forms only record pending activation (`supervisor.mjs:2522`, `:2648`). Direct `ploinky-local update` restarts only through the AgentLib activation child (`cli/index.js:232-252`, `runCoreCli(['restart'])` at :144). |
| Tests named in §6 | All exist. `cliLifecycleInactivation` uses non-adjacent `assertOrdered`, so insertions do not break it. `dependencyStoreWorkspaceStartWiring` runs `startWorkspace` in a VM, so new free identifiers do cause a `ReferenceError` (correctly flagged by the plan). |

## 5. Suggested phasing for the implementer

0. **Empirical checks.** Run the Podman and Docker local-build RepoDigests check (P1-2). Confirm the forms of container `.Image` and image `.Id` on Podman, Docker classic and Docker containerd.
1. **Pure modules.** Write `imageReference.mjs`, `registryDigest.mjs` (anonymous plus Bearer only, using the P2-4 decision rule), `imageIdentity.mjs` (non-throwing, renamed exports) and `imageRefresh.mjs` (policy from env then var, session, dedupe, sequential checks, a pull budget, skipping missing images), with their unit tests.
2. **Recreation.** Add the `ensureAgentService` hook (P1-1 corrections), the worker adoption predicate, the fake-engine `{{.Image}}` format, and the behavioral two-start regression.
3. **Hooks, in value order.**
   1. Worker prefetch becomes a refresh using `runtimeAdmission.descriptor.catalogIdentity` (rewrite its tests).
   2. Targeted container restart, after its preconditions.
   3. Start: settle, then refresh blocking and additional nodes, then the lease.
   4. Full restart: settle, then refresh all container nodes, then inactivate and stop.
   5. The `restart router` opt-out.
   6. The update image phase (Q1 semantics).
4. **Docs and help.** Box env forwarding is optional if the var-backed policy is adopted.
5. **Decisions instead of an optional phase.** Superseded-image cleanup (P2-7) and the rollback note (P2-6). No create-by-ID.
