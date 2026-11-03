# Implementation Plan: Agent Image Refresh on start, restart and update

Status: proposed implementation plan (not implemented). Date: 2026-11-03. Branch: `claude/dazzling-fermi-59l84k`.

Executable code and tests are the source of truth (AGENTS.md); every behavior claim below was checked against the current tree. New code is dependency-free Node.js (`engines.node >= 22`): `fetch`, `AbortSignal.timeout`, `node:crypto`, `node:child_process`, `node:test`. No npm dependency is added.

## 1. Outcome and acceptance contract

1. On `ploinky start`, `ploinky restart` (full or `restart <agent>`) and `ploinky update`, each container agent's image reference is checked against its registry when the reference is mutable (a tag). When the registry's manifest digest for that tag is not one of the local image's repo digests, the image is pulled again.
2. A running agent whose container was created from a different image ID than the one its reference now resolves to locally is always recreated by the next lifecycle pass. This holds whether or not the agent needs a dependency cache.
3. Digest-pinned references (`repo@sha256:…`, including `repo:tag@sha256:…`) are never checked or re-pulled. Local-only images are never overwritten.
4. Pulls happen outside the workspace mutation lease, restart locks and network lock.
5. Offline or registry errors never fail a start or restart: Ploinky keeps the cached image, prints one warning, and continues. A failed pull for an image the registry proved changed fails the update phase record, but it does not block activation.
6. `PLOINKY_IMAGE_REFRESH=off` restores today's behavior: images are pulled only when missing.
7. `restart router` never checks or pulls images.

## 2. Verified current behavior

| Concern | Source (current line) | Fact |
| --- | --- | --- |
| Missing-only pull | `cli/sandbox/docker/common.js:287` `ensureImagePresent` | Returns `false` when `imageExists` (`<rt> image inspect <ref>`, :181) succeeds; otherwise `pullImage` (:204, spawnSync with streamed progress and a timeout from `PLOINKY_IMAGE_PULL_TIMEOUT_MS`, default 30 min), then the local-build fallback (`LOCAL_IMAGE_BUILD_DEFINITIONS` :158, currently empty). |
| Create path | `agentServiceManager.js:2234` | `ensureImagePresent(image)` and then `inspectImageEntrypoint` are called inside the create path, under the lease. |
| Managed network path | `agentServiceManager.js:2722-2751` | When `adoptManagedRuntimeOnly` is set, both images must already be present and nothing is pulled. Otherwise the helper image (digest-pinned, `routerAuthorityAttestation.js:30`) and the target image are made present before the network transaction. |
| No-wait prefetch | `cli/commands/noWaitWorker.js:1470`, call at :1911 | Synchronous and missing-only. It runs outside every lock and skips LLM runtimes because the catalog image may differ from the manifest image. |
| LLM image | `agentServiceManager.js:1745`; `llmArchitectureSelector.js:254-280` | The catalog `imageRef` (or a `PLOINKY_LLM_AGENT_IMAGE` override) replaces the manifest image. Admissions carry it as `admission.descriptor.catalogIdentity.imageRef` (`runtimeCapabilities.js:523`). |
| GPU share launch | `selectLaunchImages` :1536; `mpsLifecycle.mjs:151-154,352-354` | These launches create the container from the immutable image ID. MPS re-runs `ensureImagePresent` and re-inspects the reference on every coordination, so it picks up a newly pulled ID. |
| Recreate reasons | `ensureAgentService` :3805, checks at :4253-4380 | The image ID is checked only inside `runtimeDependencyReuseProblem` (`runtimeDependencies.mjs:391`, `'runtime image changed'`). That check is skipped when `needsDependencies` is false (`containerDependencyReuseProblem` :1413: `start` command, no `package.json`, not LLM). |
| Graph-level reuse | `workspaceUtil.js:1285` `graphNodeRuntimeReplacementReason` | Start decides per node whether to rotate identity using env hash, limits, LLM reuse hash and contract drift. It has no image check. |
| Adoption | `agentServiceManager.js:2467,2548`; `routerAuthorityAttestation.js:752` | Adoption compares the container's `.Image` with a fresh `image inspect {{.Id}} <ref>`. Today a re-tagged reference therefore makes managed adoption fail instead of producing a clean recreate. |
| Start order | `workspaceUtil.js:2950-2970` | Repositories are prepared, then `admittedStart = preflightWorkspaceStartRuntimeCapabilities()` (:2961, pure, includes the LLM catalog ref), then `acquireSettledWorkspaceMutationLease` (:2970). The no-wait split is `classifyDependencyGraphWaitMode` (:3168). |
| Restart | `cli/commands/cli.js:438-685` | `restart router` (:440) calls `startWorkspace`. In targeted restart the sandbox path uses `ensureAgentService({forceRecreate})` and the container path (:653) uses `reconcileExactHardwareInstance` under `exact-agent-restart`. Full restart (:671-680) settles, stops all agents (so all are recreated as `runtimeStopped`), then calls `startWorkspace`. |
| Update | `cli/commands/updateCommand.js` `runUpdate` | Git and skills work runs under the lease, and the output is records (`updateOutcome.js:14` phases). In the Box flow the host restarts the whole graph after a full update when the graph is active and activation is allowed (`supervisor.mjs:2404`, `executeBoundedRestart` :1830 with `coreArgv=['restart']`). Targeted forms only record pending activation. |
| Box | `bin/ploinky` → `ploinky-box`; `ploinky-box/constants.mjs:99-104` | Agents run under nested rootless Podman inside the Box. The image store is the workspace bind `.ploinky/box/images`. Host environment variables are not forwarded to in-Box commands (`ploinky-box/process.mjs` allowlist, `boundedCoreEnvironment` `supervisor.mjs:4423`, `command/execute.mjs:13`), so there are no proxy variables in the Box. The host bounds in-Box start, restart and update to 30 min (`supervisor.mjs:4461,4664`). |
| Registry probe (live) | `HEAD registry-1.docker.io/v2/assistos/roboteam-agent/manifests/runtime` | Without a token the response is `401` with `WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:assistos/roboteam-agent:pull"`. With the anonymous token it is `200` with `content-type: application/vnd.oci.image.index.v1+json` and `docker-content-digest: sha256:bc7c…`, so the tag is a multi-arch index. |

Real refs (AssistOSExplorer): most agents use `docker.io/assistos/ploinky-node@sha256:…` (pinned, skipped). `roboTeamAgent` and `roboWorkAgent` use `docker.io/assistos/roboteam-agent:runtime`, which `container-image-builds/.github/workflows/publish-roboteam-agent-image.yml` re-pushes. The default manifest image is the unqualified `node:18-alpine` (`secretVars.js:762`).

## 3. Design decisions

### D1. Remote digest lookup (native fetch)

- **Reference parsing** (`imageReference.mjs`). Accept `[host[:port]/]path[:tag][@sha256:hex]`. The first component is a host if it contains `.` or `:` or equals `localhost`. Docker semantics apply: no host means `docker.io`, a one-segment Docker Hub path gets a `library/` prefix, and a missing tag means `latest`. The API host for `docker.io` and `index.docker.io` is `registry-1.docker.io`. The result is `{ registry, apiHost, repository, tag, digest, pinned, qualified }` plus a canonical string (`docker.io/library/node:18-alpine`) used as the dedupe key.
- **Request**: `HEAD https://<apiHost>/v2/<repository>/manifests/<tag>` with `Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json`. All four types are listed so the registry never converts the manifest (a conversion changes the digest). The digest is read from `Docker-Content-Digest` and must match `^sha256:[0-9a-f]{64}$`.
- **Auth**: try anonymously first. On `401` with `WWW-Authenticate: Bearer realm=…,service=…,scope=…`, parse the challenge generically (quoted params) and `GET realm?service=…&scope=…` (scope defaults to `repository:<repo>:pull`). Use `token` or `access_token`, then retry HEAD once with `Authorization: Bearer`. For Docker Hub this is `auth.docker.io`, with no special case. If the anonymous token still yields `401`/`403`/`404` and basic credentials exist for the host, repeat the token request with `Authorization: Basic`. `WWW-Authenticate: Basic` uses the credentials directly. Any other scheme is `unsupported`.
- **Credentials** (`registryAuth.mjs`, read-only): Podman order is `REGISTRY_AUTH_FILE`, then `$XDG_RUNTIME_DIR/containers/auth.json`, then `~/.config/containers/auth.json`. Docker uses `$DOCKER_CONFIG/config.json` or `~/.docker/config.json`. Read only `auths[<host>].auth` (Docker Hub keys: `docker.io`, `index.docker.io`, `https://index.docker.io/v1/`). If the host is covered only by `credHelpers` or `credsStore`, the result is `unsupported` (no helper is executed). Tokens and credentials stay in memory for one command and are never logged, persisted or put in records (invariant 8).
- **Proxy**: Node's fetch ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` is set (Node 24, and backported: the local Node 22.23 lists `--use-env-proxy`). If a proxy variable applies to the host (with `NO_PROXY` matching) and neither switch is present in `process.env`, `process.execArgv` or `NODE_OPTIONS`, the result is `unsupported`. The engine honours its own proxy configuration, so D7 delegates to `<runtime> pull`. In-Box processes have no proxy environment today.
- **Rate limits**: Docker documents that manifest `HEAD` does not count against pull limits; the probe returned `ratelimit-*` headers without being a pull. GET is never used on `docker.io`. For other registries a missing digest header falls back to `GET` of the manifest and `sha256(body)` with `node:crypto` (same Accept header).
- **Bounds**: each request has a 10 s `AbortSignal.timeout`, with at most one redirect hop and one auth retry. A per-host circuit breaker means that after the first `unreachable` for a host, the other refs on that host in the same session are `unreachable` without a request. The whole check phase has a 60 s budget.
- **Classification** (returned, never thrown): `{status:'ok', digest}` or one of `'unreachable'` (DNS, connect, timeout, 5xx), `'unsupported'` (proxy, helper, scheme, TLS verification failure, no digest on docker.io), `'denied'` (401/403 after auth), `'not-found'` (404), `'rate-limited'` (429).

### D2. Local digest and comparison

- Read with `<rt> image inspect --format '{{json .RepoDigests}}' <ref>` (spawnSync, 30 s, `--format` like `installContract.mjs:56`). Docker prints `assistos/roboteam-agent@sha256:…` (no `docker.io/`). Podman prints `docker.io/assistos/roboteam-agent@sha256:…` and usually lists both the index digest and the platform manifest digest. Parse each entry with the D1 parser and keep only those whose `registry/repository` equals the reference's.
- The image is **current** iff the remote digest is in that digest set. A multi-arch tag returns the index digest, and both engines record the index digest when pulling by tag; a single-arch tag returns the manifest digest, which is also recorded. Comparing set membership instead of "first entry" makes Podman's double listing correct.
- If `image inspect` fails (image missing), pull (missing-image prefetch) without contacting the registry.
- If the image is present but has an empty or `null` RepoDigests set for that repository, treat it as **local-only** (built or tagged locally) and skip it. Never pull over it.

### D3. Skip rules (no registry contact, no pull)

`pinned` (digest in ref); `local-build` (ref in `LOCAL_IMAGE_BUILD_DEFINITIONS`); `local-only` (D2); `localhost/` registry; `unqualified` under Podman, where short names resolve through `registries.conf` and the mapping is ambiguous (they are checked as `docker.io` under Docker); sandbox runtime kinds (`bwrap`, `seatbelt`: no image); unresolved `${…}` placeholders (the transaction reports them); hardware-refused graph nodes. `adoptManagedRuntimeOnly` is not a skip rule in the refresher: refresh runs only in pre-lock phases, and `ensureAgentService` and the adoption path keep their current missing-only or never-pull behavior unchanged.

LLM catalog images **are refreshed** (they are the agent's image). The ref is taken from `admission.descriptor.catalogIdentity.imageRef` (or the `PLOINKY_LLM_AGENT_IMAGE` override already folded in), so no hardware probe is added. Pinning in the catalog is the opt-out.

### D4. Policy and configuration

- `PLOINKY_IMAGE_REFRESH` = `check` (default) | `always` | `off`. With `always`, Ploinky skips the HTTP check and runs `<runtime> pull` once per mutable ref per command, for proxied or credential-helper setups. `off` means missing-only. An unrecognized value throws before any mutation, the same way as `parseReposSource` (`cli/utils/reposSource.mjs:21`).
- **Box propagation**: the host validates the variable and forwards it as `--env PLOINKY_IMAGE_REFRESH=<v>` only when it is set, through `boundedCoreEnvironment` (`supervisor.mjs:4423`) and `buildContainerExecArgs` (`ploinky-box/command/execute.mjs:13`). It is not baked into the Box environment, so changing it never replaces the Box. Unlike `PLOINKY_REPOS_SOURCE`, it is not Box identity.
- There is no manifest field in v1, because pinning a digest is already a per-agent opt-out (open question Q2).
- **Dedupe**: an `ImageRefreshSession` per top-level command holds a `Map<runtime|canonicalRef, Promise<result>>`. Many agents share refs, and every agent with that ref gets one result. Long-lived REPL processes create a new session per command. Registry checks run with concurrency 4. Pulls run sequentially so engine progress output is not interleaved.
- **Pull budget**: each pre-pass pull uses `min(imagePullTimeoutMs(), remaining)`, with a default refresh pull budget of 15 min per command. This leaves start or restart work inside the host's 30 min bound. Refs left over after the budget are `deferred`, and their cached image is used.

### D5. Where it runs (per command)

| Command | Hook | Scope | Lock position |
| --- | --- | --- | --- |
| `start` | `startWorkspace` immediately after `admittedStart` (:2961) and before `resetPreinstallRunInProcess()` and `acquireSettledWorkspaceMutationLease` (:2970) | Blocking (non-no-wait) container nodes of `admittedStart`. No-wait nodes are left to their worker. | Before lease |
| no-wait worker | `prefetchNoWaitRuntimeImage` becomes async: it calls `session.refresh(ref)` and drops the LLM skip, because the ref comes from `runtimeAdmission.descriptor.catalogIdentity` | That one node | Outside all locks (already) |
| full `restart` | `cli.js` before `settleWorkspaceBeforeRestart()` (:671): `preflightWorkspaceStartRuntimeCapabilities()`, then refresh. The session is passed into `startWorkspace({ imageRefresh: session })`, whose pre-pass then hits the memo (new refs from freshly prepared repos are still checked) | Blocking nodes | Before stop: downtime does not include pull time |
| `restart <agent>` (container) | `cli.js` before `withHeldOrAcquiredWorkspaceMutationLease` (:653). The image comes from `resolveAgentLaunchImageRef` (manifest image, or LLM catalog image via `resolveLlmRuntimeAdmissionContext`) | That agent | Before lease |
| `restart <agent>` (sandbox) | none | n/a | n/a |
| `restart router` | `startWorkspace({ imageRefresh: false })` | none | n/a |
| `update` | `runUpdate` after the lease is released and before the report is published, so the manifests are the updated ones. Scope: bare `update` covers every graph container node (blocking and no-wait); `update <repo>` covers that repo's nodes; `update <folder>` covers nodes whose `agentPath` is under the folder; `update repos` does nothing. A workspace that was never started (no `static.agent`) gets no image phase. | See left | After lease release; `cancellation.checkpoint('image')` between pulls |

**Update activation** keeps the existing model with no new restart logic. Box full form with an active graph: the host already runs an in-Box `restart` after the update. That restart recreates every agent, and its own pre-pass finds the images current. Targeted forms, an inactive graph, and direct `ploinky-local update`: the image records are reported, and the summary line says to run `ploinky restart` (or `ploinky restart <agent>`). The supervisor's existing "pending activation" note for targeted forms covers this.

### D6. Guaranteed recreation (`imageChanged`)

- **New helper** `imageIdentityReuseReason({ runtime, containerRef, desiredImageRef, desiredImageId, inspect })` (`imageIdentity.mjs`):
  - It reads `<rt> container inspect --format '{{.Image}}' <containerRef>` and the desired ID: `desiredImageId` when given (GPU share launch: `readMpsLaunch(...).imageId`), otherwise `<rt> image inspect --format '{{.Id}}' <desiredImageRef>`.
  - Both values are normalized with `normalizeImageId` (`installContract.mjs:47`; Podman prints bare hex, Docker prints `sha256:`).
  - It returns `{ reason: 'imageChanged', detail: 'image <old12> -> <new12>' }` (prefix stripped, then `shortHash`) or `null`.
  - Any missing or unparsable evidence returns `null` (no recreate on uncertainty). The existing missing-image and dependency paths handle a pruned image.
- **Wire into `ensureAgentService`** directly after the AgentLib check (:4283), using the same `if (!recreateReason) recreateDetail = …; recreateReason ||= 'imageChanged'` pattern. Desired ref: `serviceLlmAdmissionContext.catalogIdentity.imageRef || image`. This runs before the dependency check, so the logged reason is the specific one and is independent of `needsDependencies`.
- **Wire into `graphNodeRuntimeReplacementReason`** (`workspaceUtil.js:1285`) after the LLM reuse-hash check and before the contract inspection. It uses a new injectable `imageIdentityReasonImpl` and sets `plan.runtimeReasonDetail`, so start rotates the instance identity and prints `[start] repo/agent: replacing its runtime (imageChanged: image 1a2b… -> 9f8e…)` through the existing `runtimeReplacementLog.js` path.
- **Registry record**: add `containerImageId` (normalized ID read back from the created container) at both record writes (`agentServiceManager.js:2994`, `:4744`). Add `containerImageDigest` (the matching repo digest, for display in `status`) when one is known. The recreate decision always uses container inspect, so records without these fields (existing workspaces) work unchanged. `containerMonitor.js:394` already folds `record.containerImageDigest` into its restart snapshot digest. That is intended: image identity becomes a restart input.
- **Dependency store**: a new image ID gives `runtimeDependencyReuseProblem` a new `imageId`. The recreate plans a new generation keyed by the new ID (`planRuntimeDependencies`), and npm install runs inside the create path (an existing cost, now once per image change). The old generation is left to existing store retention.
- **GPU or MPS**: MPS coordination re-inspects the ref (D2 facts), so after a pre-pass pull the share launch gets the new ID and the comparison above uses `launch.imageId`. No MPS change is needed.
- **Adoption**: because `imageChanged` is decided before the reuse and adoption branch, a re-tagged ref now produces a clean replacement instead of an adoption-attestation mismatch.

### D7. Failure handling

| Situation | `check` result | Action |
| --- | --- | --- |
| Remote digest equals a local digest | `current` | none |
| Different digest, or image missing | `pull` | `pullImage(ref, {timeoutMs})`; on error the result is `pull-failed`, with a warning, and the cached image is kept |
| `unsupported` | delegate | `<runtime> pull` (engine handles auth and proxy; an up-to-date pull fetches manifests only); on error, `pull-failed` |
| `unreachable`, `rate-limited`, `denied`, `not-found` | `unavailable` | warning, keep cached, no pull (a pull would fail the same way) |
| Budget exhausted | `deferred` | keep cached |

The pre-pass never throws for registry or pull reasons. Only an invalid policy value throws. A recreated container that fails readiness goes through the existing cleanup (`cleanupFailedPreparedRuntime`, candidate journals). The old image ID stays tagged-less on disk.

Old-image cleanup is optional and later (Phase 5). After a successful start, `<rt> image rm <oldId>` runs only for IDs this command superseded and that no container references (exact IDs, never `image prune`, per DS002 exact-identity rule). This matters because the Box image store lives in the workspace (`.ploinky/box/images`).

### D8. Output and records

- **Logs** (same `[pull]` prefix as `common.js`): `[pull] docker.io/assistos/roboteam-agent:runtime changed in the registry (sha256:bc7c8956426d -> local sha256:0a1b2c3d4e5f); pulling...`, then the existing `pullImage` lines. Warnings: `[pull] Warning: could not check <ref> (<status>: <short reason>); using the cached image.` Print one summary line when anything was checked: `[pull] Image refresh: 1 refreshed, 2 current, 0 unavailable (3 pinned skipped)`. Per-ref "current" details go to `debugLog`. Reasons pass through `sanitizeReason`.
- **Update records**: add phase `'image'` to `UPDATE_PHASES` (`updateOutcome.js:14`) and emit one record per mutable ref (`id` = canonical ref, `required: false`, `details.agents` = agent refs, `before` / `after` = `{digest, imageId}`). Pinned, local-only and `off` refs emit nothing, so they never turn an update into `complete-with-skips`.

| Result | Outcome | Code |
| --- | --- | --- |
| `pulled` | `changed` | `image-refreshed` |
| `current` | `unchanged` | `image-current` |
| `unavailable` / `deferred` | `skipped` / `deferred` | `registry-unreachable`, `registry-denied`, `rate-limited`, `refresh-budget` |
| `pull-failed` | `failed` | `image-pull-failed` (exit 1, status `partial`; activation still allowed because the record is not required) |

## 4. Module layout

All new modules are `.mjs`, under 300 lines each, and have no import-time side effects:

- `cli/sandbox/docker/imageReference.mjs`: `parseImageReference(ref, {runtime})`, `canonicalImageRef(parsed)`, `repoDigestSet(repoDigestsJson, parsed)`.
- `cli/sandbox/docker/registryAuth.mjs`: `readRegistryCredentials(host, {env, fs, homedir})` returns `{kind:'basic', authorization}`, `{kind:'helper'}` or `null`.
- `cli/sandbox/docker/registryDigest.mjs`: `fetchRemoteManifestDigest(parsed, {fetchImpl = fetch, env, credentials, timeoutMs, tokenCache, hostBreaker})` returns the D1 classification, and `proxyBlocksNativeFetch(host, env, execArgv)`.
- `cli/sandbox/docker/imageIdentity.mjs`: `inspectRepoDigests`, `inspectLocalImageId`, `inspectContainerImageId` (all take `spawn = spawnSync`), and `imageIdentityReuseReason`.
- `cli/sandbox/docker/imageRefresh.mjs`:
  - `parseImageRefreshPolicy(env)` and `IMAGE_REFRESH_ENV`.
  - `createImageRefreshSession({runtime, policy, log, fetchImpl, spawn, now, pullBudgetMs})` with `refresh(ref, {agents})` returning `{ref, action, status, reason, beforeDigest, afterDigest, beforeId, afterId}`, plus `results()` and `summaryLine()`.
  - `collectGraphImageTargets(admittedStart, {includeNoWait})` and `resolveAgentLaunchImageRef({manifest, profileConfig, agentName, repoName, alias, runtime})`.
  - `imageRefreshUpdateRecords(results)`.
  - Pulls reuse `pullImage` and `ensureImagePresent(..., {allowLocalBuild:false})` from `common.js`, which stay missing-only.

## 5. Phased implementation steps

**Phase 1: pure building blocks (no behavior change)**
1. Add `imageReference.mjs`, `registryAuth.mjs`, `registryDigest.mjs` and `imageIdentity.mjs` with injected seams, and their unit tests (section 6).
2. Add `imageRefresh.mjs` (policy, session, dedupe, budgets, D7 table) and its tests. Nothing calls it yet.

**Phase 2: guaranteed recreation**
3. `agentServiceManager.js`: in `ensureAgentService`, after :4283, call `imageIdentityReuseReason`. Desired ID comes from `readMpsLaunch(options.mpsLaunch, …)?.imageId` when `serviceAdmission.descriptor.hardwareGpu` is set, otherwise from the ref (LLM catalog ref or manifest image).
4. `agentServiceManager.js`: record `containerImageId` / `containerImageDigest` at :2994 and :4744 (inspect the created container's `.Image` once, right after create).
5. `workspaceUtil.js`: add `imageIdentityReasonImpl` to `graphNodeRuntimeReplacementReason` options. Call it after the LLM block (:1420), using `admitted?.llmStartup?.selection?.imageRef || resolveManifestImage(...)`.
6. `tests/unit/dependencyStoreFakeEngine.mjs`: answer `container inspect --format {{.Image}}` with `found[0].Image` (today it falls through to full JSON, which the helper treats as unknown).

**Phase 3: command hooks**
7. `workspaceUtil.js` `startWorkspace`:
   - Accept the option `imageRefresh` (session, `false`, or `undefined`, which creates one from env).
   - After :2961, run `await refreshAdmittedGraphImages(admittedStart, session)`. It excludes nodes in `classifyDependencyGraphWaitMode(admittedStart.graph).noWait` and refused nodes, and is wrapped so that only policy errors propagate.
8. `cli.js`:
   - Router restart passes `imageRefresh: false`.
   - Full restart creates the session and refreshes before `settleWorkspaceBeforeRestart()` (:671), then passes the session into `startWorkspace`.
   - Targeted container restart refreshes the agent's ref before :653. The sandbox path is untouched.
9. `noWaitWorker.js`: make `prefetchNoWaitRuntimeImage` async, use `createImageRefreshSession` (this is a separate process with its own session) and the catalog ref from `runtimeAdmission.descriptor.catalogIdentity`. Change the call at :1911 to `await`.
10. `updateCommand.js` `runUpdate`: after the lease `finally`, compute targets for the request scope (D5), call `cancellation.checkpoint('image', records)` before each pull, and `appendUpdateRecords(result, imageRefreshUpdateRecords(results))`. In `updateOutcome.js`, add `'image'` to `UPDATE_PHASES`. In `updateSummary.js`, add the "run `ploinky restart` to apply refreshed images" line when an `image` record is `changed` and no host activation follows.

**Phase 4: Box plumbing and docs**
11. `ploinky-box/supervisor.mjs` `boundedCoreEnvironment` (+ callers) and `ploinky-box/command/execute.mjs` `buildContainerExecArgs`: forward a validated `PLOINKY_IMAGE_REFRESH` when set on the host. Validation uses `parseImageRefreshPolicy` in `ploinky-box/command/route.mjs` for start, restart and update, before any mutation.
12. Docs (DS002 synchronization): describe the policy and the `imageChanged` reason in `docs/specs/DS006-runtime-execution-and-isolation.md`, and the image-keyed generation consequence in `DS009-dependency-caches-and-startup-readiness.md`. Add the variable to `cli/commands/help.js` and `publicUsageText` (`ploinky-box/bin/ploinky-box.mjs`). Run `fileSizesCheck.sh`.

**Phase 5 (optional, later)**
13. Superseded-image cleanup (D7). Optionally create managed containers from the immutable ID resolved once per launch (as GPU launches do) to close the retag race in section 7.

## 6. Testing

**New unit tests** (`tests/unit/*.test.mjs`, `node:test` plus `assert/strict`, style of `manifestImageResolution.test.mjs`; the seams are `fetchImpl`, `spawn`, `env` and `fs`, with no network and no engine):

- `imageReference.test.mjs`:
  - `node:18-alpine` → `docker.io/library/node:18-alpine`.
  - `assistos/x` → `:latest`.
  - `localhost:5000/a/b:t` (host with port) and `ghcr.io/o/r:t`.
  - `repo:tag@sha256:…` is pinned.
  - Uppercase or invalid refs are rejected.
  - Unqualified refs are skipped under Podman and checked under Docker.
  - The `repoDigestSet` filter covers the Docker form without `docker.io/`, the Podman form with two digests, `null`, `[]`, and foreign repos.
- `registryDigest.test.mjs`:
  - Anonymous 200, and 401 Bearer → token → 200 (assert the Accept header, the `service`/`scope` query, and one retry).
  - `access_token` field; a challenge with odd quoting.
  - Basic creds after anonymous 401; `credsStore` gives `unsupported`.
  - Proxy env without `NODE_USE_ENV_PROXY` gives `unsupported`; `NO_PROXY` match gives `ok`.
  - Timeout or abort gives `unreachable`, and the breaker skips the second ref.
  - 429, 404 and 5xx; a missing digest header (GET + sha256 for a non-Hub registry, `unsupported` for docker.io); a malformed digest.
  - A spy logger proves tokens never appear in logs or results.
- `imageRefresh.test.mjs`:
  - Policy parsing (`off`, `check`, `always`, invalid throws).
  - Two agents sharing a ref make one HEAD and at most one pull.
  - Pinned and local-only refs make zero fetch and zero spawn calls.
  - Equal digest means no pull; a different digest means a pull with a bounded timeout.
  - A missing image is pulled without a fetch.
  - `unsupported` delegates to pull; `unreachable` causes no pull and one warning.
  - Pull failure gives `pull-failed` and no throw.
  - `always` causes no fetch; `off` makes no calls.
  - Budget exhaustion gives `deferred`.
  - The update record mapping table (D8), with `required:false`; `decideUpdateStatus` keeps `activationAllowed:true` on `pull-failed`.
- `imageIdentity.test.mjs`:
  - Equal IDs across formats (`abc…` vs `sha256:abc…`) give `null`; different IDs give `imageChanged` with 12-char detail.
  - A desired `launch.imageId` overrides the ref.
  - Unparsable or missing inspect output gives `null`.

**Existing tests to update**:
- `cliLifecycleInactivation.test.mjs`: add `refreshAdmittedGraphImages(` between `const admittedStart` and the lease in the start `assertOrdered` list, and assert that the refresh precedes `await settleWorkspaceBeforeRestart();` in the full-restart slice and that `imageRefresh: false` appears in the router slice.
- `dependencyStoreWorkspaceStartWiring.test.mjs`: VM-sandbox collaborators must supply `refreshAdmittedGraphImages` and `createImageRefreshSession`, or the test fails with a ReferenceError.
- `noWaitWorker.test.mjs:2930`: `await` the now-async prefetch, and add a case where an LLM node uses the catalog ref.
- `updateResultPolicy.test.mjs` / `updateReportProtocol.test.mjs`: add `image` records. Prove that a non-required `failed` image record yields `partial` with activation allowed, and that the report round-trips the new phase (`updateOutcome.js:240` validates phases).
- `ploinkyBoxCli.test.mjs` / `ploinkyBoxSafetyMatrix.test.mjs`: the env is forwarded only when set and valid, and an invalid value is refused before any Box mutation.
- Graph replacement tests: inject `imageIdentityReasonImpl` where they stub other `…Impl` options.

**Manual verification recipe** (scratch Docker Hub repo `<you>/refresh-probe`, multi-arch):
1. `docker buildx build --platform linux/amd64,linux/arm64 -t docker.io/<you>/refresh-probe:runtime --push .` (image A). Point a test agent manifest's `container` at that ref, with a `start` command and no `package.json`, which exercises the previously missed path. Run `ploinky start <agent>`.
2. Record `podman image inspect --format '{{.Id}} {{json .RepoDigests}}'` inside the Box (`ploinky shell` or `podman exec <box> podman …`) and the agent container's `.Image`.
3. Push image B under the same tag. Run `ploinky start` again and expect `[pull] … changed in the registry`, then `replacing its runtime (imageChanged: …)`. The new container's `.Image` equals the new local ID.
4. Run `ploinky start` again: no pull, no replacement, and a `current` summary.
5. Repeat step 3 with `ploinky restart <agent>`, then with `ploinky update` (graph active: the host restart applies it; check the `image` record in the summary).
6. Disconnect the network (or `PLOINKY_IMAGE_REFRESH=check` with an unroutable registry host in a test ref): start succeeds with one warning.
7. `PLOINKY_IMAGE_REFRESH=off ploinky start` makes no registry traffic. `ploinky restart router` makes no `[pull]` lines.
8. Run steps 3-4 with direct `ploinky-local` on Docker (the classic store and the containerd store) to confirm that the container `.Image` and image `.Id` formats compare equal when unchanged.

## 7. Risks, open questions, follow-ups

- **Retag race**: a pre-lock pull by one command can move a tag while another command (an earlier start's no-wait worker) creates or attests a container from that tag under the lease. The likely result is an attestation mismatch (`agentServiceManager.js:2467`) or a container with a stale dependency generation. Both self-heal on the next start through `imageChanged` or dependency drift. Mitigations: blocking-node refs are refreshed before the lease, and workers refresh only their own ref. The full fix is the Phase 5 create-by-ID option.
- **Docker containerd store**: if container `.Image` and image `.Id` ever differ in form for the same image, every start would recreate. The normalization test and manual step 8 guard this. The helper must return `null` rather than `imageChanged` when either value fails `normalizeImageId`.
- **Cost**: an LLM image change means a multi-GB pull at start. No-wait LLM agents pull in their worker. Blocking ones pull before the lease, within the 15 min refresh budget.
- **Q1**: Should `pull-failed` during `update` exit nonzero (current recommendation, consistent with `decideUpdateStatus`) or be `skipped`?
- **Q2**: Should a manifest-level `imagePullPolicy` exist, or is digest pinning enough?
- **Q3**: Should LLM catalog entries that declare `digest` (`llmArchitectureCatalog.js:259`) be resolved as `ref@digest`, making them pinned?
- **Q4**: Should `reinstall` and `enable` also refresh? They are out of scope here; they keep missing-only behavior plus `imageChanged`.
- **Out of scope**: the Box image policy (`ploinky-box/lifecycle/transactions.mjs`). In AssistOSExplorer, `roboWorkAgent/server/environment.mjs:63` has its own missing-only `podman pull` for `roboteam-desktop:runtime` and `roboteam-browser:runtime`. That needs the same digest check, or pinned refs, as a separate change in that repository.
