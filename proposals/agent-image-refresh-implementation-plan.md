# Implementation Plan: Agent Image Refresh on update

Status: implementation plan, revision 3 (scope reduced: `ploinky update` is the only command that refreshes images). Date: 2026-11-03. Branch: `claude/dazzling-fermi-59l84k`.

**Scope (revision 3).** The registry check and the pull of a changed tag happen **only** in `ploinky update`. `ploinky start`, `ploinky restart` (all forms) and the no-wait worker never contact a registry and never pull a changed tag; their existing missing-image behavior is unchanged. They only recreate a container whose image ID already changed locally (the `imageChanged` reason), so an image pulled by `update` takes effect at the update's activation restart or at the next start or restart. The start, restart and worker pre-passes of earlier revisions are removed.

This revision incorporates `proposals/agent-image-refresh-implementation-plan-review.md` and the coordinator's decisions on it. Executable code and tests are the source of truth (AGENTS.md); every reference below was checked against the tree.

New code is dependency-free Node.js (`engines.node >= 22`). It uses global `fetch`, `AbortSignal.timeout`, `node:child_process`, and `node:test`. No npm dependency is added.

## 1. Outcome and acceptance contract

1. **Refresh.** On `ploinky update` only, Ploinky checks a container agent's image reference against its registry when **all** of the following hold:
   - the reference names an explicit registry host (`docker.io/…`, `ghcr.io/…`);
   - it is a mutable tag;
   - it is present locally.

   If the registry's manifest digest for that tag is not one of the local image's repo digests, the image is pulled again. Locally built images are not special: a registry-qualified mutable tag follows its registry.
2. **Recreation.** An existing container whose image ID differs from the ID its reference now resolves to locally is replaced on its next lifecycle pass. "Next lifecycle pass" means `ensureAgentService` or the no-wait worker's ready-reuse check. This happens whether or not the agent needs dependencies. The log reason is `imageChanged`.
3. **Never refreshed:**
   - references pinned by digest (`@<algorithm>:<hex>`);
   - LLM catalog images whose catalog entry declares `digest`;
   - unqualified references (`node:18-alpine`), on both engines;
   - `localhost/…` references;
   - images that are missing locally. These keep today's path: the worker prefetch or the in-lease `ensureImagePresent`, which `update` does not change.
4. **Locks and budget.** Pulls run outside the workspace mutation lease, the restart locks and the network lock. With the registry digest known, the digest is pulled and the tag is then moved under a brief workspace mutation lease (a busy lease defers the move). The update image phase runs after the lease is released, only when no no-wait worker is in flight, and within a time budget kept below the host's 30-minute in-Box limit; refs beyond the budget are deferred.
5. **Failure handling:**
   - Registry unreachable: warn and keep the cached image.
   - Registry reachable but the digest cannot be proven: run `<runtime> pull`.
   - Pull failure: warn and keep the cached image.
   - Nothing in the refresh fails `update`. A failure becomes a `skipped` record and the exit code stays 0.
6. **Opt-out.** Refreshing is simply what `ploinky update` does by default. The workspace variable `PLOINKY_IMAGE_REFRESH` has two recognised values: `off` (`ploinky var PLOINKY_IMAGE_REFRESH off`) and `on` (the default, so a workspace can switch back because `ploinky var` has no unset): a developer escape hatch for workspaces that build agent images locally under the published tag (`install-roboteam-local-in-box.sh` sets it automatically).
   - It is read **only** from the workspace variable, never from the process environment, and is not forwarded from the host.
   - When it is `off`, `update` logs one line saying so and checks and pulls nothing.
   - Any other non-empty value (including the former `check` and `always`) is ignored: `update` logs one warning and refreshes as usual. It never fails the update and adds no record.
   - `imageChanged` recreation (contract item 2) is unaffected, because it reacts only to local state.
7. **`start` and every `restart` form** (including `restart router`) never check or pull. They still recreate an agent whose tag already moved locally, the same way they handle every other drift reason.

## 2. Verified current behavior

| Concern | Source (current line) | Fact |
| --- | --- | --- |
| Missing-only pull | `cli/sandbox/docker/common.js` | `ensureImagePresent` :287 returns early when `imageExists` :181 succeeds. `pullImage` :204 streams progress and uses `PLOINKY_IMAGE_PULL_TIMEOUT_MS` (default 30 min). `probeContainerRuntime` :115 returns `null` instead of exiting. |
| Existing image-ID helper | `cli/sandbox/docker/agentServiceManager.js:1400` | `inspectContainerImageId(runtime, imageRef)` is module-local and never throws. It returns the normalized ID of an image **ref**, or `null`. `tests/unit/hardwareLimitsInstallerImage.test.mjs:60` asserts its call text, so **do not rename it**. |
| Recreate reasons | `ensureAgentService` :3805 | `image` is the manifest image (:4214). `serviceLlmAdmissionContext` (:3899) has `catalogIdentity: null` for non-LLM agents. The AgentLib block is :4281-4289 and the dependency block :4291-4310. The only image-ID check is inside `runtimeDependencyReuseProblem` (`runtimeDependencies.mjs:391`), and it is skipped when `needsDependencies` is false (`containerDependencyReuseProblem` :1413). |
| ID normalization | `cli/utils/dependencies/store/installContract.mjs:47` | `normalizeImageId` **throws** on bad input. Podman prints bare hex; Docker prints `sha256:` hex. |
| No-wait worker | `cli/commands/noWaitWorker.js` | The prefetch at :1470 is synchronous and missing-only, and skips LLM runtimes; its call site is :1911. `admittedRuntime` :1788, `llmAdmissionContext` :1790. The ready-reuse shortcut (`adopted`, :1962-1981) adopts a ready `host`/`none` runtime without calling `ensureAgentService`. |
| Settling | `cli/commands/noWaitRunSettlement.js` | `waitForNoWaitRunsToSettle` :151 holds no lease and throws `PLOINKY_NO_WAIT_RUN_IN_FLIGHT` at its deadline. `inspectInFlightNoWaitWorkers` :101 is exported. `settleWorkspaceBeforeRestart` (`workspaceUtil.js:3711`) releases its lease before returning. |
| Update | `cli/commands/updateCommand.js` `runUpdate` :101 | `parseUpdateRequest` :120, then the lease and handlers, the release, and `releaseFailed` :146. The `catch` at :152 turns errors into records (`thrownRecord`: `PLOINKY_UPDATE_*` becomes `failed` before mutation). In the Box flow the host restarts an active graph after a full update (`ploinky-box/supervisor.mjs:2404`). Host and Box run the same `/opt/ploinky` source, so the new `image` phase needs no version-skew handling (host validation is at `updateOutcome.js:240`). |
| Workspace variables | `cli/utils/security/secretVars.js:38` | `resolveVarValue(name)` decrypts `.ploinky` secrets and works in-Box. There is precedent at `agentServiceManager.js:2157`. |
| Box | `ploinky-box/process.mjs`, `constants.mjs:99-104` | Agents run under nested Podman. The image store is the workspace bind `.ploinky/box/images`. Host environment variables, including proxy variables, are not forwarded into in-Box commands. The host bounds in-Box start, restart and update to 30 min. |
| Registry (live probe) | `HEAD registry-1.docker.io/v2/assistos/roboteam-agent/manifests/runtime` | Without a token: `401` with `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:assistos/roboteam-agent:pull"`. With an anonymous token: `200`, OCI index, `docker-content-digest: sha256:bc7c…`. |

**The motivating case.** In AssistOSExplorer, `roboTeamAgent` and `roboWorkAgent` use `docker.io/assistos/roboteam-agent:runtime`; all other agents are pinned to a digest.
- Both are **no-wait** nodes (Explorer enables `roboTeamAgent … no-wait`), so only the update image phase (which includes no-wait nodes) refreshes them.
- Both have no `start` command, so the dependency check already recreates them once the tag moves locally. For them the missing piece is the pull.
- The `imageChanged` reason generalizes recreation to agents that have a `start` command and no `package.json`.

## 3. Design decisions

### D1. Reference parsing (`cli/sandbox/docker/imageReference.mjs`)

`parseImageReference(ref)` returns `null` for an empty ref, a ref with whitespace, or an uppercase repository path. Otherwise it returns `{ registry, apiHost, repository, tag, digest, pinned, explicitRegistry, canonical }`:

- **Digest and pinning.** Split at `@` into the name and an optional digest. `pinned` is true when the digest matches `/^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[0-9a-fA-F]{32,}$/`.
- **Registry host.** The first `/`-segment is a host if it contains `.` or `:` or equals `localhost`; `explicitRegistry` records this. Without a host, `registry` is `docker.io` and `explicitRegistry` is false. `index.docker.io` normalizes to `docker.io`.
- **Repository and tag.** A one-segment Docker Hub repository becomes `library/<name>`. The tag is the text after the last `:` that follows the last `/`; it defaults to `latest`.
- **API host.** `registry-1.docker.io` for `docker.io`; otherwise the host itself, including any port.

`repoDigestSet(repoDigests, parsed)` returns a `Set` of digests. It parses each RepoDigests entry with the same function and keeps those whose `registry/repository` equals the ref's. The Docker form `assistos/x@sha256:…` normalizes to `docker.io`; the Podman form is already qualified.

### D2. Remote digest (`cli/sandbox/docker/registryDigest.mjs`)

`fetchRemoteManifestDigest(parsed, { fetchImpl = fetch, timeoutMs = 10_000, unreachableHosts = new Set() })` returns `{ status: 'ok', digest }`, `{ status: 'unavailable', reason }` or `{ status: 'undetermined', reason }`. It never throws.

**Request.** `HEAD https://<apiHost>/v2/<repository>/manifests/<tag>` with:
- `Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json`;
- `signal: AbortSignal.timeout(timeoutMs)`;
- default `fetch` redirect handling.

**Anonymous Bearer only.** On `401`:
1. Parse `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`. Quoted parameters are separated by commas, and the scheme is matched case-insensitively.
2. `GET realm?service=…&scope=…`. The scope defaults to `repository:<repository>:pull`. Read `token` or `access_token` from the JSON body.
3. Send the `HEAD` once more with `Authorization: Bearer <token>`.

Ploinky reads no credentials, so there is no `registryAuth.mjs`. The token stays in a local variable for one call and is never logged, persisted, or returned (invariant 8).

**Classification:**
- `ok`: `200` with `Docker-Content-Digest` matching `^sha256:[0-9a-f]{64}$`.
- `unavailable` (warn, keep cached), and the API host is added to `unreachableHosts` so later refs on that host are not re-requested:
  - HTTP `429` or `5xx`;
  - a thrown fetch error that is not TLS-class: DNS, connect, reset, `AbortError`/`TimeoutError`, or any other unknown fetch error.
- `undetermined` (delegate to `<runtime> pull`):
  - a `200` without a valid digest;
  - a non-Bearer challenge;
  - a token request that is refused or has no token;
  - `401`/`403`/`404` or any other `4xx` after the token;
  - a TLS-class error. The code is taken from `err.cause?.code ?? err.code` and matches `CERT_*`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `ERR_TLS_*`, `ERR_SSL_*`, or `EPROTO`. `EPROTO` also covers plain-HTTP registries.

**Proxy.** `nativeFetchIgnoresProxy(env = process.env, execArgv = process.execArgv, nodeMajor)` returns true when any of `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY` or `all_proxy` is non-empty **and** none of these is present:
- `env.NODE_USE_ENV_PROXY === '1'` and `process.versions.node` >= 22.21.0 or >= 24 (`nodeHonoursEnvProxy`; on older Node a proxy environment means the engine pulls);
- `--use-env-proxy` in `execArgv`;
- `--use-env-proxy` in `NODE_OPTIONS`.

(Recent 22.x and Node 24 support `--use-env-proxy`.) When it returns true, the session skips the `HEAD` and delegates to the engine. `NO_PROXY` is not interpreted. In-Box processes have no proxy variables today.

**Rate limits.** Docker documents that a manifest `HEAD` does not count as a pull; the live probe returned `ratelimit-limit: 100;w=3600`. Fallback pulls (digest unknown) do count, because the engine fetches the manifest with `GET`.

### D3. Opt-out (`cli/sandbox/docker/imageRefresh.mjs`)

```js
export const IMAGE_REFRESH_VAR = 'PLOINKY_IMAGE_REFRESH';

// The workspace variable is the only source. `off` turns the refresh off, `on` is the default; anything else is ignored.
export function resolveImageRefreshPolicy({ readVar = resolveVarValue } = {})  // { policy: 'off' | 'refresh', ignoredValue }
```

The variable is read inside the in-Box process through the workspace variable store, so nothing changes in `ploinky-box/`. An unreadable store means refresh. A manifest-level policy is not provided.

### D4. The refresh session (`imageRefresh.mjs`)

`createImageRefreshSession({ policy, runtime = undefined, log = console.log, beforePull = null, …seams })` returns an object with:
- `enabled`, which is `policy !== 'off'`;
- `refresh(ref, { agents = [] })`, which returns `Promise<result>`;
- `results()`;
- `summaryLine()`.

Seams for tests: `fetchImpl`, `spawn`, `env`, `execArgv`, `pull` (defaults to `pullImage`), `readImageId` (defaults to a non-throwing wrapper of `containerToolchainIdentity`), `readRepoDigests`.

`runtime` resolves lazily to `probeContainerRuntime()`. Never call `getRuntime()` here, because it exits the process on hosts that have only a sandbox runtime. Results are memoized per `runtime|canonical`, and the `agents` lists of all callers are merged.

`refresh` **never throws**. The one exception is an error thrown by the caller's `beforePull`, which propagates unchanged (update cancellation, D8). Steps, in order:

1. Skip, with no registry contact and no pull, when any of these holds:
   - policy is `off`;
   - the ref does not parse;
   - the ref is `pinned`;
   - the ref is not `explicitRegistry` (both engines);
   - the registry is `localhost`;
   - no runtime was found.
2. `local = readRepoDigests(ref)`. This runs `<rt> image inspect --format '{{json .RepoDigests}}' <ref>` with a 30 s timeout. A non-zero exit means the image is missing: skip and do not pull. An empty or `null` array gives an empty set, which proves nothing and so leads to a pull.
3. If `deadlineMs - now() < min(60 s, configured pull timeout)`, the result is `deferred`: no registry call, no pull (code `image-refresh-deferred`).
4. If `nativeFetchIgnoresProxy()` is true, the digest is unknown and the engine will pull the tag (step 6). Otherwise `remote = await fetchRemoteManifestDigest(parsed, { unreachableHosts })` (one `Set` per session):
   - `ok` and `local.has(remote.digest)`: `current`.
   - `ok` and not present: log, remember the digest, continue.
   - `unavailable`: warn, keep cached.
   - `undetermined`: log `asking <rt> to pull`, digest unknown, continue.
5. `beforeId = readImageId(ref)`, then `await beforePull?.()`. The pull timeout is `min(PLOINKY_IMAGE_PULL_TIMEOUT_MS, deadlineMs - now())`. A pull whose timeout was cut short by the budget and then timed out is `deferred` (no timeout advice), not `pull-failed`. Every `deferred`, `retag-deferred`, `turned-off` and `tag-changed` result logs one `[pull]` line with its reason.
6. Pull:
   - **Digest known:** `pull('<registry>/<repository>@<digest>', { runtime, log, timeoutMs })`. The tag does not move. `afterId = readImageId(<digest ref>)`. If it equals `beforeId` the result is `current`. Otherwise `beforeRetag` (the cancellation checkpoint) runs, then `withRetagLease`, which the commands layer implements with a brief workspace mutation lease (5 s wait; a failed release is logged as a warning), runs a callback that **revalidates**: if the workspace policy is now `off` the result is `turned-off` (code `image-refresh-turned-off`); if `readImageId(ref)` no longer equals the `beforeId` read before the pull the result is `tag-changed` (code `image-tag-changed`, the tag moved during the update, for example a local build); otherwise `<rt> tag <afterId> <ref>`. If the lease stays busy the result is `retag-deferred` (code `image-retag-deferred`) and nothing is rolled back. A failing `tag` command is `pull-failed`.
   - **Digest unknown:** `pull(ref, ...)`; `afterId = readImageId(ref)`; `refreshed` when the ID changed, else `current`.
   - On a pull throw: `await afterPullFailure?.()` (a hook error propagates, see below), then `pull-failed`, warn, keep cached.
   - A `refreshed` result prints the rollback hint (D7). There is no automatic rollback retag.
7. Any unexpected internal error: result `error` (code `image-refresh-error`), id = the normalized ref, with a warning.

`beforePull` and `afterPullFailure` are the caller's hooks. An error they throw propagates unchanged. The update passes a cancellation checkpoint for both, with the git records plus the image records so far, so a pull that failed because a signal arrived is a cancellation and never a `pull-failed` record.

Checks are sequential; there are 1-3 mutable refs in practice. There is no concurrency and no redirect cap.

**Target collection.** `collectAdmittedImageTargets(admittedStart, { includeNoWait = false, filter = null })` iterates `admittedStart.admissions` and skips a record when any of these holds:
- `runtimeKind !== 'container'`;
- `hardwareRefusal` is set;
- the node is no-wait and `includeNoWait` is false;
- `admission.descriptor?.catalogIdentity?.imageDigest` is set (catalog-pinned, decision Q3).

For each remaining record:
- The ref is `catalogIdentity?.imageRef`. Failing that, it is `resolveManifestImage(manifest, profileConfig, { agentName, repoName })`:
  - `manifest` is decoded from `manifestBytesBase64`;
  - `profileConfig` comes from `resolveManifestRuntimeProfile(manifest, { agentName: agentId, profileName: record.profileName || undefined, path: \`manifest(${agentId})\` })`;
  - `repoName` and `agentName` are split from `admission.agentId` at its last `/`.
- Each record is wrapped in `try/catch`. An unresolved `${…}` placeholder or a bad manifest becomes a debug line, never a throw.
- It returns `{ ref, repoName, agentName, manifestPath }`.

`refreshAdmittedGraphImages(admittedStart, session, options)` groups the targets by ref, then calls `await session.refresh(ref, { agents })` once per ref. When anything was checked, it prints `session.summaryLine()`.

### D5. Guaranteed recreation (`imageChanged`)

The logic lives in `cli/sandbox/docker/imageChange.mjs` (`readRuntimeContainerImageId`, `readLocalImageId`, `containerImageChange`, `desiredImageRef`, `imageChangeDetail`), so the already oversized `agentServiceManager.js` and `noWaitWorker.js` gain only an import and a call site. `inspectContainerImageId` in `agentServiceManager.js` is left untouched.

`containerImageChange({ runtime, containerName, imageRef })` compares `container inspect --format '{{.Image}}'` with `image inspect --format '{{.Id}}'` of the reference, both through `normalizeImageId` (Podman prints bare hex, Docker prefixes `sha256:`). It returns `{ observed, desired }` on a difference and `null` when equal or when either side is unknown: uncertainty never forces a replacement. Readers are injectable for tests.

**Hook 1, in `ensureAgentService`**, after the AgentLib block and before the dependency comment. It runs before the managed adoption and the host/none early return, so a re-pulled tag yields a clean replacement instead of an adoption-attestation mismatch:

```js
    if (existingRuntimeAtEntry && !recreateReason) {
        const imageChange = containerImageChange({
            runtime, containerName, imageRef: serviceLlmAdmissionContext.catalogIdentity?.imageRef || image,
        });
        if (imageChange) {
            debugLog(`[ensureAgentService] ${agentName}: image changed, recreating container`);
            recreateDetail = imageChangeDetail(imageChange);
            recreateReason = 'imageChanged';
        }
    }
```

The existing `logRuntimeReplacement` then prints `[start] repo/agent: replacing its runtime (imageChanged: image 0a1b2c3d4e5f -> bc7c8956426d)`.

- **GPU-share (MPS) clients need no special case.** MPS coordination runs `ensureImagePresent` and inspects the same ref under the same locks before it creates the container by ID.
- **No graph-level check and no new registry-record fields.** This mirrors `dependencyGenerationChanged`, which also lives only in `ensureAgentService`.

**Hook 2, in the no-wait worker's ready reuse** (`noWaitWorker.js`, inside `capture(lifecycle)`, before `const adopted = ...`): a ready runtime is adopted only while `containerImageChange({ runtime: admittedRuntime, containerName, imageRef: desiredImageRef(runtimeAdmission.descriptor?.catalogIdentity, () => resolveManifestImage(...)) })` is `null`, and the `adopted` predicate gains `&& !imageChange`. It is covered by a source-order assertion only; the worker has no cheap seam for a behavioral test.

### D6. Where refresh runs: `ploinky update` only

`ploinky update` is the only command that contacts a registry or pulls a changed tag. `ploinky start`, `ploinky restart` (every form, including `restart router`) and the no-wait worker never do: their image handling stays exactly as it is today (a missing image is pulled by the worker prefetch or the in-lease `ensureImagePresent`; a present image is used as is). They do pick up an image that `update` already pulled, through the local, network-free `imageChanged` reason (D5), whether it runs as the update's activation restart or as the operator's next start or restart.

`refreshWorkspaceGraphImages(session, { includeNoWait = true, filter = null })` is added to `workspaceUtil.js`. It resolves `preflightWorkspaceStartRuntimeCapabilities()` (a failure logs a `[pull] Warning: image refresh skipped; ...` line and returns `[]`), then calls `refreshAdmittedGraphImages(admitted, session, { includeNoWait, filter })`. Only the update image phase (D8) calls it. `startWorkspace`, `cli.js` and `prefetchNoWaitRuntimeImage` are unchanged.


### D7. Logging and rollback

The prefix is `[pull]`, as in `common.js`. Per-ref "current" lines go to `debugLog`. Reasons pass through `sanitizeReason`, and tokens never appear.

- **Changed:** `[pull] docker.io/assistos/roboteam-agent:runtime: registry digest differs (local sha256:0a1b2c3d4e5f, registry sha256:bc7c8956426d); pulling...` After this come the existing `pullImage` lines.
- **Delegated:** `[pull] <ref>: registry digest not readable (<reason>); asking podman to pull` (the engine pulls the tag and no retag happens).
- **Refreshed:** `[pull] <ref> refreshed for repo/agent[, …]; previous image <64-hex old ID>. To roll back: <runtime> tag <64-hex old ID> <ref>, then ploinky restart.`
- **Warnings:**
  - `[pull] Warning: registry <host> unreachable for <ref> (<reason>); using the cached image.`
  - `[pull] Warning: pull of <ref> failed (<message>); using the cached image.`
- **Summary:** `[pull] Image refresh: 1 refreshed, 2 current, 0 unavailable, 0 failed, 0 deferred.`, printed only when at least one ref was checked.

There is **no automatic pruning** in this change. The previous image stays on disk without a tag, and that is what the rollback hint relies on. The Box's automatic graph rollback (`restorePriorGraph`, `supervisor.mjs:1131-1146`) cannot restore it, because the tag has already moved; recovery is the manual `tag` command. Dangling images accumulate in the workspace-backed `.ploinky/box/images` until `destroy --delete-cache`. This is a known follow-up (section 7).

### D8. Update phase and records

Code lives in `cli/commands/updateImagePhase.js` (the commands layer: target collection, record mapping, filters, the phase itself, the tag-move lease). `cli/sandbox/docker/imageRefresh.mjs` returns plain result objects and does not import the update records.

- **Phase.** `'image'` is in `UPDATE_PHASES` (`updateOutcome.js`, before `'activation'`).
- **Policy.** In `runUpdate`, right after `parseUpdateRequest`, `resolveImageRefreshPolicy()` is called. It never fails the update. `off`: the phase logs `[update] Image refresh is turned off for this workspace ...` and does nothing. An ignored value: one `[update] Warning: PLOINKY_IMAGE_REFRESH='...' is ignored ...` line, then the refresh runs. The records model has no informational outcome, so neither case adds a record.
- **Budget.** `runUpdateCommand` records its start time. The image phase deadline is `start + IMAGE_PHASE_BUDGET_MS`, where `IMAGE_PHASE_BUDGET_MS = UPDATE_RUNNER_DEFAULTS.timeoutMs - 10 min` (the host bounds the whole in-Box update, `ploinky-box/update/coreRunner.mjs`, 30 min). Each pull is capped at the remaining budget; once less than 60 s remain, the remaining refs are recorded `skipped` / `image-refresh-deferred` and the update continues with exit 0.
- **`appendImageRefreshPhase`** (after the `releaseFailed` block, before the outer `catch`, only when the result is not a cancellation):
  - Unchanged result, with no log, when `request.kind === 'repos'`.
  - When the git phase blocks activation (`activationAllowed === false`; a `partial` update still refreshes): one `skipped` record, id `image-refresh`, code `image-refresh-skipped-git-failed`; no image moves while activation is blocked.
  - Otherwise it creates the session with the budget, `beforePull` and `afterPullFailure` set to `cancellation.checkpoint('image', [...git records, ...image records so far])`, and `withRetagLease` from `createRetagLease` (brief workspace mutation lease; the caller's lease is reused when the caller holds one). A `UpdateCancelledError` keeps all records and reaches the existing `catch` as a `cancelled` record.
  - A throw from `refreshImages` other than `UpdateCancelledError` is logged as `[pull] Warning: image refresh skipped (...)` and recorded as an optional `skipped` record, code `image-refresh-error`.
  - When something was refreshed and `!hostActivates`, it logs `[update] Refreshed images take effect after \`ploinky restart\` (or \`ploinky restart <agent>\`).` In the Box flow with an active graph, the host's follow-up restart activates them.
- **`refreshUpdateImages({ request, session, log })`** uses lazy imports, so existing update tests do not load `workspaceUtil.js`:
  1. Return `[]` when `getConfig()?.static?.agent` is unset. A never-started workspace is checked at its first start.
  2. Return `[]` with one log line when `inspectInFlightNoWaitWorkers().length` is non-zero (this avoids the race in section 7).
  3. Otherwise call `refreshWorkspaceGraphImages(session, { includeNoWait: true, filter })` with `filter = buildImageFilter(request)`: `target.repoName === request.repoName` for `kind: 'repo'`; for a folder-scoped `all`, agents whose manifest is under the folder **or under the registered repositories directory** (`.ploinky/repos`), because `update all` updates every registered repository whatever the current folder; `null` for a bare update.
- **Records.** One per mutable ref: `id` = canonical ref, `required: false`, `details.agents`, `before`/`after` = `{ imageId }`. Skipped refs (pinned, unqualified, missing, policy `off`) emit **no** record.

| Result | Outcome | Code | Notes |
| --- | --- | --- | --- |
| `refreshed` | `changed` | `image-refreshed` | |
| `current` | `unchanged` | `image-current` | |
| `unavailable` | `skipped` | `registry-unreachable` | |
| `pull-failed` | `skipped` | `image-pull-failed` | `attempted: true`; exit 0 (`complete-with-skips`) |
| `deferred` | `skipped` | `image-refresh-deferred` | budget exhausted |
| `retag-deferred` | `skipped` | `image-retag-deferred` | lease busy; the digest was pulled, the tag did not move |
| `error` | `skipped` | `image-refresh-error` | unexpected internal error |
| `turned-off` | `skipped` | `image-refresh-turned-off` | the policy became `off` during the pull; the tag did not move |
| `tag-changed` | `skipped` | `image-tag-changed` | the tag moved during the update; the tag did not move |
| phase skipped | `skipped` | `image-refresh-workers-active`, `image-refresh-graph-unavailable` | id `image-refresh`; no ref was checked, so the update is `complete-with-skips` |

## 4. Module layout

All new modules are `.mjs`, have no import-time side effects, and stay under 300 lines.

- `cli/sandbox/docker/imageReference.mjs`: `parseImageReference`, `repoDigestSet` (D1).
- `cli/sandbox/docker/registryDigest.mjs`: `fetchRemoteManifestDigest`, `nativeFetchIgnoresProxy`, `isTlsClassError` (D2).
- `cli/sandbox/docker/imageChange.mjs`: `containerImageChange` and its helpers (D5).
- `cli/commands/updateImagePhase.js`: target collection, `refreshAdmittedGraphImages`, record mapping, filters, `refreshWorkspaceGraphImages`, the retag lease and `appendImageRefreshPhase` (D8).
- `cli/sandbox/docker/imageRefresh.mjs`: `IMAGE_REFRESH_VAR`, `resolveImageRefreshPolicy`, `createImageRefreshSession`. It imports `probeContainerRuntime`, `imagePullTimeoutMs` and `pullImage` from `common.js`, `readLocalImageId` from `imageChange.mjs`, `resolveVarValue` from `secretVars.js` and `debugLog` from `utils.js`. It does not import anything from `cli/commands/`.
- Modified files (each gains only an import and a call site, because three of them are already over the size limit):
  - `agentServiceManager.js`: D5 hook 1;
  - `noWaitWorker.js`: D5 hook 2;
  - `updateCommand.js` and `updateOutcome.js`: D8;
  - `workspaceUtil.js` is **not** modified;
  - help text only (the DS specification files are not edited: AGENTS.md forbids it for behavior work).

## 5. Phased implementation steps

**Phase 0: empirical checks (no code).** Record the outputs in the PR description.
1. Inside a Box, run Podman and record `container inspect --format '{{.Image}}'`, `image inspect --format '{{.Id}}'` and `{{json .RepoDigests}}` after `pull docker.io/assistos/roboteam-agent:runtime`. Expect the index digest `bc7c...` in RepoDigests, and the two IDs equal after normalization.
2. Repeat on Docker with the classic store and with the containerd store. If the containerd store reports IDs in another form, `containerImageChange` must still compare them equal; fix the normalization before Phase 2.

**Phase 1: pure modules and their unit tests.** Write `imageReference.mjs`, `registryDigest.mjs` and `imageRefresh.mjs` (D1-D4, D8 record mapping).

**Phase 2: recreation.**
3. In `agentServiceManager.js`, add `readRuntimeContainerImageId` and the exported `containerImageChange`, widen the `installContract.mjs` import, and add the `ensureAgentService` hook (D5, hook 1).
4. In `noWaitWorker.js`, add the import and the `adopted` predicate (D5, hook 2).
5. In `tests/unit/dependencyStoreFakeEngine.mjs`, add the `{{.Image}}` format to the container-inspect branch.
6. Add the behavioral regression from section 6.

**Phase 3: the update image phase (D8).** Add `'image'` to `UPDATE_PHASES`, the policy parse, and `updateImagePhase.js` (`appendImageRefreshPhase`, `refreshUpdateImages`, `refreshWorkspaceGraphImages`).

**Phase 4: docs and the cross-repository step.**
7. Docs: `cli/commands/help.js` only (`update` refreshes by default; `ploinky var PLOINKY_IMAGE_REFRESH off` opts out). DS004/DS006/DS009 are not edited. Run `fileSizesCheck.sh`.
8. In `/home/user/container-image-builds/scripts/install-roboteam-local-in-box.sh`, as a separate commit in that repository, insert inside the `agent|all` build branch, right after the local agent image build succeeded (not before the prerequisites):

    ```bash
    # Local builds reuse the published tags; stop Ploinky from refreshing them from the registry.
    if /opt/ploinky/bin/ploinky-local var PLOINKY_IMAGE_REFRESH off; then
        echo "[local-images] image refresh is off for this workspace"
    else
        echo "[local-images] could not set PLOINKY_IMAGE_REFRESH; run 'ploinky var PLOINKY_IMAGE_REFRESH off' before the next update" >&2
    fi
    ```

    It is set only when the agent image was built locally. Refreshing the agent tag would replace the local build.


## 6. Testing

**New unit tests** (`tests/unit/*.test.mjs`, `node:test` plus `node:assert/strict`, style of `manifestImageResolution.test.mjs`). The seams are `fetchImpl`, `spawn`, `env`, `pull`, `readVar` and `readImageId`; there is no network and no engine.

- `imageReference.test.mjs`: reference parsing (`docker.io/...`, `node:18-alpine`, `docker.io/node`, `localhost:5000/a/b:t`, `ghcr.io/o/r:t`, digest pinning, malformed refs) and `repoDigestSet`.
- `registryDigest.test.mjs`: anonymous `200`; `401` Bearer to token to `200` (Accept header, `service`/`scope` query, exactly one retry, `access_token`, odd quoting); the `undetermined` and `unavailable` classes; the unreachable-host memo; `nativeFetchIgnoresProxy`; the token never appears in logs or results.
- `imageRefresh.test.mjs`: the opt-out (`off` only, workspace variable only, other values ignored and reported); the session (digest pull plus retag with one `HEAD` for two agents, busy lease, failing `tag`, same-ID digest pull, skip classes, equal digest, empty RepoDigests, `undetermined` fallback to a tag pull, `unavailable`, `pull-failed`, `error`, `off`, proxy fallback, hook errors propagating, budget deferral and per-pull timeout capping, unknown runtime).
- `agentImageChange.test.mjs`: `containerImageChange`, `desiredImageRef` and `imageChangeDetail` through injected readers, including Podman's bare-hex `.Image`.
- `updateImagePhase.test.mjs`: target collection, `refreshAdmittedGraphImages`, the record table, the agent filters (including registered repos from a subdirectory), `refreshUpdateImages` (no static agent, in-flight worker skip, filter forwarding), the retag lease, and `appendImageRefreshPhase` (ignored-value warning, `off` log line, git-failed skip, `repos`, budget deferral, digest pull plus retag and `image-retag-deferred`, cancellation carrying the image records and a signal-killed pull).
- `updateImageRefreshPhase.test.mjs`: the command level through `runUpdateCommand`: an invalid policy is a skipped record with exit 0 and the repositories still update; image records follow the git records; a failed pull stays exit 0; a workspace without a static agent has nothing to refresh; a throwing refresh is a warning; cancellation keeps the git records.
- `updateReportProtocol.test.mjs`: an `image` record round-trips through the published report.
- Behavioral regression in `tests/unit/dependencyStoreRuntimeWiring.test.mjs`, with `wiringWorkspace(t, { packageJson: null })` (a start command and no `package.json`): a first start; then the engine resolves the tag to another image ID (`FAKE_ENGINE_IMAGE_HEX`, standing in for the pull `ploinky update` performed) and the next start recreates the container (`createdByThisLaunch === true`); a third start with the same ID reuses it.

**Existing tests that were updated:**
1. `tests/unit/dependencyStoreRuntimeIntegration.test.mjs`: assert that `containerImageChange(` precedes both `adoptManagedRuntimeOnly = !managedReconciliationPreparationLease` and the host/none early-return `debugLog`, that `recreateReason = 'imageChanged'` is present, and that the no-wait `capture` contains `/&& !imageChange/`.
2. `tests/unit/dependencyStoreFakeEngine.mjs`: add the container-inspect `{{.Image}}` format (bare hex with `FAKE_ENGINE_BARE_CONTAINER_IMAGE=1`, as Podman prints it).
3. `tests/unit/hardwareLimitsInstallerImage.test.mjs:60` must keep passing unchanged (guard against renaming `inspectContainerImageId`).
4. The update tests (`updateResultPolicy`, `updateReportProtocol`, `updateCancellation`, `workspaceLeaseOperationOwnership`, `ploinkyBoxHostExclusionsInterrupt`) must stay green: the default image phase returns early in workspaces without `static.agent`.

**Manual verification recipe.**
1. Push a multi-arch image A to a scratch repo `docker.io/<you>/refresh-probe:runtime`.
2. Point a test agent at that ref, with a `start` command and no `package.json`. Run `ploinky start`.
3. Push image B under the same tag, then run `ploinky start`. Expect no `[pull]` lines and no replacement: start never contacts the registry.
4. Run `ploinky update`. Expect `registry digest differs`, the rollback hint and an `image` record `image-refreshed`. With an active Box graph, the host restart activates it; otherwise run `ploinky restart` and expect `replacing its runtime (imageChanged: ...)`.
5. Run `ploinky update` again. Expect `1 current` and no pull.
6. Run `ploinky var PLOINKY_IMAGE_REFRESH off`, push again, and run `ploinky update`: one "turned off" line, no registry traffic. Run `ploinky var PLOINKY_IMAGE_REFRESH bogus`, then `ploinky update`: one warning, and the refresh runs as usual.
7. Offline (block the registry host): `ploinky update` succeeds with one warning and a `registry-unreachable` record. Roll back with the printed `podman tag ...` and `ploinky restart`.
8. In-Box local build: run `install-roboteam-local-in-box.sh agent`, then `ploinky update`. The local build is kept, and the variable reads `off`.


## 7. Decisions, risks and known follow-ups

**Decisions on the former open questions:**
- **Q1.** A failed pull during `update` is a `skipped` record with code `image-pull-failed`. Exit 0.
- **Q2.** There is no per-manifest pull policy. Digest pinning is the per-agent opt-out, and the workspace variable is the global one.
- **Q3.** LLM catalog entries that declare `digest` count as pinned and are not refreshed.
- **Q4.** `reinstall` and `enable` are out of scope. They keep missing-only pulls; `imageChanged` still applies when they go through `ensureAgentService`.

**Tag moves.** When the registry digest is known, the image is pulled by digest outside every lock (the tag does not move) and the tag is moved with `<rt> tag` under a brief workspace mutation lease; a busy lease defers the move (`image-retag-deferred`). The residual window is the fallback path (digest unknown), where the engine pulls the tag itself while a no-wait worker of an earlier start could create or attest from it; the update skips the image phase while any worker is in flight, and the attestation fails closed otherwise. Creating containers from image IDs is **not** part of this change.

**Operational risks:**
- A broken re-push reaches every workspace at its next update. Mitigations: the rollback hint, pinning agent images by digest in production, and `PLOINKY_IMAGE_REFRESH off`. The Box's automatic graph rollback restores sources, not the moved tag.
- A lagging registry mirror can report "changed" on every update until it catches up.
- A fallback pull counts against the Docker Hub pull quota.
- The image phase has a time budget below the host's 30-minute in-Box bound; refs it cannot finish are deferred to the next update.

**Known follow-ups:**
- Superseded-image cleanup, which would remove dangling images from `.ploinky/box/images`. A future change could run `<rt> image rm <oldId>` without `--force`, only after the replacement passed readiness. It is not in this change, so that rollback remains possible.
- An AssistOSExplorer change: `roboWorkAgent/server/environment.mjs:63` has its own missing-only `podman pull` for `roboteam-desktop:runtime` and `roboteam-browser:runtime`.
- The Box image refresh on full `ploinky update` is specified in §8.

## 8. Addendum: Box image refresh on full `ploinky update`

Status: proposed (not implemented), revision 2. It incorporates `box-image-addendum-review.md` and the coordinator's decisions on it. Line numbers refer to HEAD `751df69`, where the code is unchanged since `a17ddc7`.

### 8.1 Outcome

During a **host-side full update** (`ploinky update` and `ploinky update [all] <folder>`, which is `kind: 'all'` → `runFullUpdate`, `ploinky-box/supervisor.mjs:2255-2257, 2277`), the supervisor checks the Box image reference `plan.imageRef` (`:1714`, `resolveBoxImageReference(env)`, honouring `PLOINKY_BOX_IMAGE`) against its registry. When the registry proves that the tag moved, the new image is pulled **by digest** (no tag moves), validated, and a Box replacement is forced through the existing transaction. The transaction's own pull then moves the tag, as every replacement does today.

When the registry is reachable but the digest cannot be proven, the transaction itself pulls the tag under its lock and replaces the Box only if the tag now names another image. The outcome is one non-required `image` record.

No check happens in any of these cases:
- `update repos` and `update repo <name>` (`runTargetedUpdate` :2554 never replaces a Box);
- `--dry-run`, `start` and `restart`;
- the Box is absent (the creation path pulls);
- the reference is digest-pinned, unqualified or `localhost/…`;
- the running Box's image-ref label differs from `plan.imageRef` (the transaction already replaces and pulls because the reference changed);
- `PLOINKY_IMAGE_REFRESH` is `off`. The same workspace variable also covers agent images; the help text says so.

### 8.2 Verified current behavior

- `requiresReplacement` (`ploinky-box/lifecycle/transactions.mjs:565-588`) compares the reference string (:583) and the AgentLib selection (:587). In AgentLib **local** mode, a reused Box never picks up a re-pushed tag. In **image** mode, the selection reads the **local tag**, and the engine's image store is shared by every workspace on the host. So a tag moved by any workspace changes the selection, and `agentLibSelectionChanged` then replaces or refuses this workspace's Box (§8.3 D7).
- **Pulls and validation.**
  - `pullBoxImage(engine, imageRef, runner, { stdout, stderr, timeoutMs = 1_800_000 })` (:173) is module-local. It takes the engine **object** and uses `engine.name`.
  - Replacement and creation run `pullBoxImage` then `validateImage(engine.name, imageRef, runner)` (:723-724).
  - In image mode, `desiredAgentLib.supplyingImageId !== normalizeImageId(image.immutableId)` refuses before any mutation (:727-729).
  - `restoreOldContainer` (:309-345) recreates the old Box from its immutable `old.imageId`.
- **Signatures, by engine argument type:**
  - The engine **object**: `pullBoxImage(engine, …)`.
  - The engine **name**:
    - `inspectAndValidateImage(engineName, imageRef, runner)` (`ploinky-box/contract/image.mjs:341`);
    - `inspectAndValidateExistingImage(engineName, imageId, imageRef, runner)` (:350);
    - `probeImageAgentLib(engineName, imageId, runner)` (`ploinky-box/image-agentlib.mjs:81`);
    - `runner.query(engineName, args, { timeoutMs })` (`ploinky-box/process.mjs:172`, default timeout 10 s, returns `{ ok, status, stdout, stderr, error }`).
  - `normalizeImageId` (`ploinky-box/contract/image-id.mjs`) only adds `sha256:` and never throws.
- **The AgentLib loader.** `imageBundleLoader(ownership, imageRef)` (`supervisor.mjs:439-443`) calls `loadBoxAgentLibImage({ engine, imageRef, …, refresh: ownership.state === 'absent' })`. For an existing Box it inspects `imageRef` locally (no pull); `imageRef` is used only to inspect and in error text, so a digest ref or an image ID works. It is called at:
  - `prepareBoxForCommand` :978 (generic commands, `allowReplacement` defaults to true);
  - `runStartTransaction` :1369 (a guarded start when `requiredId !== null`);
  - `runFullUpdate` :2311;
  - `runTargetedUpdate` :2568 (`allowReplacement: false`).
- **Policy.** The policy is the encrypted workspace variable. The host never decrypts `.ploinky/data/.secrets`. The supervisor already runs read-only in-Box programs (`readInboxStatus` :844).
- **Layering.** `cli/sandbox/docker/imageReference.mjs` and `registryDigest.mjs` import nothing, so `ploinky-box/` may import them, as it already imports `cli/commands/updateOutcome.js` and others. `imageRefresh.mjs` must not be imported by `ploinky-box/`, because of its imports.
- **Activity.** `runFullUpdate` receives `activity`. When `activity.undetermined` is true, `restart` is false (:2404).
- **Records.** `inputRecords` is built after the reconcile (:2353).

### 8.3 Decisions

**D1. Policy read inside the Box.**
- **`cli/utils/security/secretAlias.mjs`** (new, no imports): move `resolveAlias` out of `secretVars.js` (:25-34) as `resolveSecretAlias(value, secrets)`. `secretVars.js` imports it, and `resolveVarValue` is unchanged.
- **`cli/sandbox/docker/imageRefreshPolicy.mjs`** (new; imports only `secretAlias.mjs`). It exports:
  - `IMAGE_REFRESH_VAR = 'PLOINKY_IMAGE_REFRESH'`;
  - `imageRefreshPolicyOf(raw)`: a trimmed `'off'` gives `{ policy: 'off', ignoredValue: '' }`; anything else gives `{ policy: 'refresh', ignoredValue: <raw unless '' or 'on'> }`;
  - `imageRefreshPolicyFromSecrets(secrets)`, which is `imageRefreshPolicyOf(secrets?.[VAR] === undefined ? '' : resolveSecretAlias(secrets[VAR], secrets))`.

  In `imageRefresh.mjs`, `resolveImageRefreshPolicy` keeps `readVar = resolveVarValue`, returns `imageRefreshPolicyOf(readVar(IMAGE_REFRESH_VAR))`, and re-exports `IMAGE_REFRESH_VAR`. Behavior is unchanged.
- **`ploinky-box/inbox/readImageRefreshPolicy.mjs`** (new). It imports `fs`, `SECRETS_FILE` from `cli/utils/config.js`, `decryptSecretsText` from `cli/utils/security/encryptedSecretsFile.js` (exported, :128) and `imageRefreshPolicyFromSecrets`. It exports a function used by the tests:

  ```js
  export function readImageRefreshPolicyFile(file = SECRETS_FILE, { fsApi = fs, decrypt = decryptSecretsText } = {}) {
      let raw = '';
      try { raw = fsApi.readFileSync(file, 'utf8').trim(); }
      catch (error) { if (error?.code !== 'ENOENT') return { policy: 'unknown' }; }
      try { return { policy: imageRefreshPolicyFromSecrets(raw ? decrypt(raw) : {}).policy }; }
      catch (_) { return { policy: 'unknown' }; }
  }
  ```

  When run as the main module, it prints `JSON.stringify(readImageRefreshPolicyFile())`. It never writes; `readSecretsFile` is not used because it rewrites an empty file. Tests call the function with injected `fsApi` and `decrypt`; they never spawn the file outside a Box, where it would take the non-managed master-key path.
- **Host call** (in the step, D3):

  ```js
  runner.query(engine.name, ['container', 'exec', '--user', 'podman',
      ...boxWorkspaceExecOptions(workspaceRoot), container.id,
      '/usr/local/bin/node', '/opt/ploinky/ploinky-box/inbox/readImageRefreshPolicy.mjs'], { timeoutMs: 15_000 })
  ```

  Import `boxWorkspaceExecOptions` from `ploinky-box/contract/workspace-root.mjs` (:183), as `supervisor.mjs` does. Parse strictly: `ok`, and `JSON.parse(stdout.trim())` has exactly one key, `policy`, whose value is `'off'` or `'refresh'`. Anything else is `unknown`.

**D2. Defer when the Box cannot be asked or the graph state is unknown.** If `container.runtime.running !== true` (for example after `ploinky stop`) or `activity.undetermined`, the step does no I/O and records `box-image-check-deferred`. The full update starts the Box, so the next update checks it.

**D3. The step** (`ploinky-box/update/boxImageRefresh.mjs`, new):

`refreshBoxImageForUpdate({ engine, container, imageRef, workspaceRoot, activity, env, stdout, stderr }, { runner, fetchDigest = fetchRemoteManifestDigest, pullImage = pullBoxImage, validateExisting = inspectAndValidateExistingImage, probeAgentLib = probeImageAgentLib })`
- `engine` is `ownership.engine` (object). `container` is `ownership.handles?.container || null`.
- It **never throws**; any unexpected error gives outcome `error`.
- It returns `{ outcome, replaceImage, refreshImageTag, digestRef, beforeId, afterId, reason }`.

Steps:
1. **Skip** (outcome `skip`; no record, no I/O) when:
   - `!container`;
   - `parseImageReference(imageRef)` is null, `pinned`, not `explicitRegistry`, or its registry is `localhost` or `localhost:<port>`;
   - `container.labels?.[BOX_LABELS.imageRef] !== imageRef`.
2. **Defer** (outcome `deferred`) per D2.
3. **Policy** per D1:
   - `off`: write one line to stderr (`[ploinky] Box image refresh is turned off for this workspace (PLOINKY_IMAGE_REFRESH=off).`) and return outcome `off` (no record).
   - `unknown`: outcome `policy-unavailable`.
4. **Local digests.**
   - `beforeId = normalizeImageId(container.runtime.imageId)`.
   - `local = repoDigestSet(JSON.parse(q.stdout), parsed)`, where `q = runner.query(engine.name, ['image', 'inspect', '--format', '{{json .RepoDigests}}', container.runtime.imageId])`.
   - Inspect by the **image ID** the Box runs, never by the tag. A failed query or unparsable output gives outcome `error`.
5. **Registry.**
   - If `nativeFetchIgnoresProxy(env)`, return `refreshImageTag: true` (outcome `tag-refresh`, reason `proxy not used by Node`).
   - Otherwise `remote = await fetchDigest(parsed)`:
     - `ok` with `local.has(remote.digest)`: outcome `current`;
     - `unavailable` (offline, DNS, timeout, 429, 5xx): outcome `unreachable`;
     - `undetermined` (auth, non-Bearer challenge, TLS-class, other 4xx, no digest): `refreshImageTag: true`, outcome `tag-refresh`;
     - `ok` with a different digest: continue.
6. **Pull by digest.** `digestRef = \`${parsed.registry}/${parsed.repository}@${remote.digest}\``, then `await pullImage(engine, digestRef, runner, { stdout, stderr })`. A throw gives outcome `pull-failed`. No tag moves.
7. **Compare IDs.** Read `rawAfterId = runner.query(engine.name, ['image', 'inspect', '--format', '{{.Id}}', digestRef]).stdout.trim()` and `afterId = normalizeImageId(rawAfterId)`. If `afterId` equals `beforeId`, the outcome is `current` (the registry index lists the same image). IDs are compared only after normalizing; engine and contract calls take the ID exactly as the engine reports it (Podman prints bare hex, and `inspectImmutableImage` compares the raw `Id`).
8. **Validate by ID.** Run `validateExisting(engine.name, rawAfterId, imageRef, runner)`, then `probeAgentLib(engine.name, rawAfterId, runner)` (the raw ID, never the `sha256:`-prefixed form). Any throw gives outcome `invalid`. The Box is kept and nothing was moved.
9. **Done.** Return `{ outcome: 'replace', replaceImage: true, digestRef, beforeId, afterId }`.

Log lines use the `[ploinky]` prefix, show digests and IDs shortened to 12 characters, and never include tokens.

**D4. Supervisor wiring in `runFullUpdate`.**
- Add a `createBoxSupervisor` option `refreshBoxImage = null`. `null` means no Box step and no record, following the precedent of `countNoWaitWorkers = null`. Only the production construction in `ploinky-box/bin/ploinky-box.mjs:414` passes `refreshBoxImage: refreshBoxImageForUpdate`. Existing tests are therefore unchanged.
- Insert the step after the `workspacePloinky` try/catch and before `updateAgentLib` (:2307):

  ```js
          const boxImage = refreshBoxImage
              ? await refreshBoxImage({
                  engine: ownership.engine, container: ownership.handles?.container || null,
                  imageRef: plan.imageRef, workspaceRoot: identity.workspaceRoot, activity, env, stdout, stderr,
              }, { runner })
              : null;
          const { selection, changed, previous } = await updateAgentLib({
              workspaceRoot: identity.workspaceRoot,
              branchPolicy: plan.branchPolicy,
              insideBox: false,
              // The digest ref names the image the replacement will run, so an
              // image-supplied AgentLib is selected from it and :727 passes.
              loadImageBundle: imageBundleLoader(ownership, boxImage?.replaceImage ? boxImage.digestRef : plan.imageRef),
          });
  ```

- In the `reconcileConfiguredGraph` options (:2313-2330), add `replaceImage: boxImage?.replaceImage === true` and `refreshImageTag: boxImage?.refreshImageTag === true`.
- After the reconcile, compute `const boxImageRecord = boxImage ? boxImageUpdateRecord(boxImage, prepared) : null;`. In `inputRecords` (:2353), insert `...(boxImageRecord ? [boxImageRecord] : [])` after the workspace-Ploinky record and before `agentLibRecord(...)`.
- On a reconcile throw, no Box record is built and the existing error and exit apply.
- No rollback hooks are added: no re-tag, no try/catch. A failed replacement leaves the tag exactly where a failed replacement leaves it today.

**D5. Transaction options** (`ploinky-box/lifecycle/transactions.mjs`).

1. **Parameters.** Add `replaceImage = false` and `refreshImageTag = false` next to `imagePolicy` (:390). Add `pullImage: seams.pullImage || pullBoxImage` to `dependencies` (:417). Export `pullBoxImage`.
2. **Guards**, right after the `IMAGE_POLICIES` check (:414), before any mutation. Each throws `transactionError` when:
   - both `replaceImage` and `refreshImageTag` are set;
   - either is set with `imagePolicy === 'preserve'`;
   - either is set with `allowReplacement !== true`;
   - either is set with `requireExistingContainerId !== null`.
3. **Tag refresh before the reuse decision.** Insert immediately before `const requiresReplacement` (:565), after `oldImage` validation (:527-535) and the data-path checks. The workspace lock is already asserted at entry (:406). A pull writes only the engine's image store, so the quiescence gate is not needed here; it still runs before any old Box is stopped (:762, :776).

   ```js
    let imageRefresh = null;
    if (refreshImageTag === true && old) {
        const beforeId = normalizeImageId(old.imageId);
        const reasonOf = (error) => String(error?.message || error).slice(0, 500);
        let pulled = null;
        try {
            await dependencies.pullImage(engine, imageRef, runner, { stdout, stderr });
        } catch (error) {
            imageRefresh = { outcome: 'pull-failed', beforeId, reason: reasonOf(error) };
        }
        if (!imageRefresh) {
            try {
                pulled = dependencies.validateImage(engine.name, imageRef, runner);
            } catch (error) {
                imageRefresh = { outcome: 'invalid', beforeId, reason: reasonOf(error) };
            }
        }
        if (!imageRefresh) {
            const afterId = normalizeImageId(pulled.immutableId);
            if (afterId === beforeId) imageRefresh = { outcome: 'current', beforeId, afterId };
            else if (desiredAgentLib.mode === 'image' && desiredAgentLib.supplyingImageId !== afterId) {
                imageRefresh = { outcome: 'pending-agentlib', beforeId, afterId };
            } else imageRefresh = { outcome: 'replace', beforeId, afterId, image: pulled };
        }
    }
   ```

   Two cases need explaining:
   - **`pending-agentlib`.** In image mode, the AgentLib was selected from the pre-pull local tag. The Box is reused, and the new tag is applied by the next `start`, `restart` or full `update` (their selection reads the moved tag). There is no second reconcile.
   - **`invalid`.** The tag now names a contract-invalid image (the "pull and compare" trade-off). After the reconcile, `runFullUpdate` logs the manual rollback for this outcome: `[ploinky] To roll back: <engine.name> tag <beforeId without sha256:> <imageRef>`.
4. **`requiresReplacement`** (:565-588). Append `|| replaceImage === true || imageRefresh?.outcome === 'replace'`.
5. **Image selection** (:706-725). Between the `preserve` branch and the pull branch, add `else if (imageRefresh?.image) { image = imageRefresh.image; }` (outcomes `replace` and `current` keep the validated image). That image was pulled and validated above under this lock, so the second counted pull is avoided, including for a replacement needed for another reason. For the other refresh outcomes (`pull-failed`, `invalid`, `pending-agentlib`) a replacement needed for another reason fails fast with `The Box image refresh did not complete (<outcome>: <reason>); nothing was replaced` instead of pulling the same tag again under the lock. With `replaceImage` (the digest path), the existing `pullBoxImage(engine, imageRef, …)` runs and moves the tag inside the transaction. The :727 check then compares the digest-image selection with the tag's image.
   - If the registry moved again in between, image mode refuses before any mutation ("run the command again"), giving a non-zero exit. Local mode uses the newer tag; the record's `after` comes from `prepared.imageId`.
6. **Results.** Add `imageRefresh: imageRefresh ? Object.freeze({ outcome, beforeId, afterId: afterId || null, reason: reason || '' }) : null` to the reuse result (:666-697) and to the `replaced`/`created` result (:881-896). Strip `image` from it.

**D6. Records** (`boxImageUpdateRecord(boxImage, prepared)` in `boxImageRefresh.mjs`, built with `createOperationRecord` from `cli/commands/updateOutcome.js`):
- `phase: 'image'`, `id: \`box:${parsed.canonical}\``, `required: false`, `details: { box: true }`, `before`/`after` `{ imageId }`.
- It returns `null` for outcomes `skip` and `off`.

| Step outcome | Transaction result | Record outcome | Code |
| --- | --- | --- | --- |
| `replace` | `prepared.action === 'replaced'` | `changed` | `box-image-refreshed` (after = `prepared.imageId`) |
| `tag-refresh` | `prepared.imageRefresh.outcome === 'replace'` and replaced | `changed` | `box-image-refreshed` |
| `tag-refresh` | `imageRefresh.outcome === 'current'` | `unchanged` | `box-image-current` |
| `current` | – | `unchanged` | `box-image-current` |
| `unreachable` | – | `skipped` | `registry-unreachable` |
| `pull-failed` (step or transaction) | – | `skipped` | `box-image-pull-failed` |
| `invalid` (step or transaction) | – | `skipped` | `box-image-invalid` |
| `tag-refresh` | `pending-agentlib` | `skipped` | `box-image-refresh-pending` |
| `deferred` | – | `skipped` | `box-image-check-deferred` |
| `policy-unavailable` | – | `skipped` | `box-image-policy-unavailable` |
| `error` | – | `skipped` | `box-image-check-error` (the id keeps `box:<canonical ref>`) |
| any replacement | the Box was rolled back (activation blocked, or the core update failed) | `skipped` | `box-image-rolled-back` (`before` and `after` are the restored image ID) |

Skips keep the update at exit 0. A replacement that started and failed keeps today's semantics: the existing restore from `old.imageId`, the existing error, and a **non-zero exit**.

**D7. Cross-workspace safety** (accepted P1-2). In `supervisor.mjs`, next to `imageBundleLoader`, add:

```js
// The engine's image store is shared by every workspace on this host. An existing
// Box selects its image-supplied AgentLib from the image it runs, so a tag moved by
// another workspace never makes a non-replacing command replace or refuse it. A
// requested reference change still selects from the new reference.
function existingBoxImageSource(ownership, imageRef) {
    const container = ownership.handles?.container;
    return container?.runtime?.imageId && container.labels?.[BOX_LABELS.imageRef] === imageRef
        ? container.runtime.imageId
        : imageRef;
}
```

Use it at three call sites:
- `prepareBoxForCommand` :978: `imageBundleLoader(ownership, existingBoxImageSource(ownership, imageRef))`;
- `runTargetedUpdate` :2568: `imageBundleLoader(ownership, existingBoxImageSource(ownership, plan.imageRef))`;
- `runStartTransaction` :1369: when `existing` (that is, `requiredId !== null`), `imageBundleLoader(ownership, existingBoxImageSource(ownership, ref))` with `ref = options.imageRef || existing.imageRef || resolveBoxImageReference(env)`. Otherwise keep the tag.

Plain `start` and `restart` keep reading the tag, so they still replace the Box and restart its graph. **Revision 3 (deviation from the original D7):** a full update reads the tag only when the Box step asks for it, that is the digest ref for `replace` and the tag for `tag-refresh` (which `pending-agentlib` needs to converge). For every other outcome (`off`, `unreachable`, `current`, `deferred`, `policy-unavailable`, a skip, an error) it uses `existingBoxImageSource`, so `PLOINKY_IMAGE_REFRESH=off`, an unreachable registry or a contract-invalid shared tag never replaces or refuses this workspace's Box because another workspace moved the tag. Without the Box step (`refreshBoxImage = null`) the tag is read as before. When a replacement is rolled back, the Box record is rebuilt as `box-image-rolled-back`; a rollback failure error carries the update records. Bind (:2860-2871) already uses the container's own selection.

**D8. Time.** The step runs on the host before the in-Box core update, so it does not use the in-Box 30 min `UPDATE_RUNNER_DEFAULTS.timeoutMs`. Host bounds, all under the host workspace lock as Box pulls are today:
- policy probe 15 s;
- RepoDigests and ID queries 10 s each;
- registry 10 s per request, at most 3 requests;
- digest pull 30 min;
- in-transaction tag pull 30 min;
- validation and replacement: the existing bounds.

A digest-path refresh costs two counted Docker Hub pulls (the digest pull, then the transaction's tag pull). A tag-path refresh costs one.

**D9. Known risks.**
1. **Persistent blocked activation causes churn.** The Box step runs before the in-Box git phase. While a required update input stays unverified, the blocked branch (:2409-2431) rolls back every replacement. Each update then replaces and restores the Box (and an active graph) for nothing, until the input is fixed or `PLOINKY_IMAGE_REFRESH off` is set.
2. **The tag path can move the shared tag to an invalid image.** Image-mode `start` and `restart` in any workspace then refuse with the contract error until the registry is fixed or the operator re-tags.
3. **Credentials.** Private Box registries that need credentials reach the tag path. The engine pulls with its own credentials.
4. **Mirrors.** A lagging registry mirror can make the digest path pull an image equal to the running one; the result is `box-image-current`.

### 8.4 Phases

1. **Policy pieces.** `secretAlias.mjs` (move only), `imageRefreshPolicy.mjs`, `resolveImageRefreshPolicy` delegating to it, and `ploinky-box/inbox/readImageRefreshPolicy.mjs`. Tests per §8.5.1.
2. **Transaction.** Export `pullBoxImage`, add the `pullImage` seam, add `replaceImage` and `refreshImageTag` with their guards (D5). Tests per §8.5.2.
3. **Step and records.** `ploinky-box/update/boxImageRefresh.mjs` (D3, D6). Tests per §8.5.1.
4. **Supervisor.** `refreshBoxImage = null` option, the `runFullUpdate` wiring (D4), and production wiring in `ploinky-box.mjs:414`. Tests per §8.5.3.
5. **Cross-workspace safety.** `existingBoxImageSource` at the three call sites (D7). Tests per §8.5.4.
6. **Help text only.** Update `cli/commands/help.js` and `publicUsageText` (`ploinky-box/bin/ploinky-box.mjs`): "`ploinky update` also refreshes the Box image when its registry tag moved; `ploinky var PLOINKY_IMAGE_REFRESH off` turns agent and Box image refresh off." No DS file is edited.

### 8.5 Tests

All new tests go in `tests/unit/ploinkyBoxImageRefresh.test.mjs`, which matches the boundary allowlist. No existing test is changed.

**1. Pure pieces and the step** (fake `runner.query`, fake deps):
- Policy rule:
  - `imageRefreshPolicyOf` handles `''`, `on`, `off`, ` off `, and `bogus` (refresh, ignored);
  - `imageRefreshPolicyFromSecrets` follows `$X` with `X=off` to `off`, and a cycle `$A`↔`$B` resolves to refresh.
- `readImageRefreshPolicyFile`:
  - a missing file gives refresh; an empty file gives refresh and is not written;
  - `off` gives off; a decrypt throw gives `unknown`; an `EACCES` read gives `unknown`.
- Step skips with no runner call when: there is no container; the ref is pinned, unqualified or `localhost:5000/x`; or the label differs from `plan.imageRef`.
- Step defers when the Box is stopped or `activity.undetermined`; no runner call.
- Policy: `off` gives no record. `unknown`, a non-zero exit, `{"policy":"refresh","x":1}` or garbage give `box-image-policy-unavailable`.
- Registry:
  - the digest is in the RepoDigests of `container.runtime.imageId` (assert the inspect argument is the ID, not the tag) → `current`, no pull;
  - `unavailable` and 429 → `unreachable`, no pull;
  - `undetermined`, the proxy env and a TLS-class error → `refreshImageTag: true`, no pull in the step.
- Digest differs:
  - `pullImage` is called once with the engine **object** and `docker.io/x/box@sha256:…`;
  - an equal `afterId` → `current`;
  - `validateExisting` or `probeAgentLib` throws → `invalid`, `replaceImage: false`;
  - success → `replaceImage: true`, with `digestRef`.
- Robustness: any dependency throwing an unexpected error gives outcome `error`, and the step never rejects. A spy shows no token in logs.
- `boxImageUpdateRecord`: every row of the D6 table.

**2. Transaction** (seam pattern of `ploinkyBoxTransactions.test.mjs`):
- `replaceImage` on a reusable Box gives `replaced` with one tag pull.
- `refreshImageTag`:
  - same ID → `reused`, `imageRefresh.outcome: 'current'`, one pull;
  - a new ID in local mode → `replaced` with no second pull, and `prepared.imageId` is the new ID;
  - image mode with a selection that differs from the new ID → `reused` and `pending-agentlib`;
  - pull throws → `reused` and `pull-failed`;
  - validation throws → `reused` and `invalid`.
- Guards (each throws before any discover or stop call):
  - both options together;
  - either option with `preserve`;
  - either option with `allowReplacement: false`;
  - either option with `requireExistingContainerId`.

**3. Supervisor** (fake `refreshBoxImage`):
- `replaceImage` reaches the reconcile, and the AgentLib loader receives `digestRef`.
- `refreshImageTag` reaches the reconcile.
- The record sits between the workspace-Ploinky and AgentLib records.
- A targeted update never calls `refreshBoxImage`.
- With the default `refreshBoxImage = null`: no call, no record.
- A source assertion that `ploinky-box/bin/ploinky-box.mjs` constructs the supervisor with `refreshBoxImage: refreshBoxImageForUpdate`.

**4. Cross-workspace.** Setup: image mode, an existing Box running O, the local tag moved to N. Expectations:
- a generic command (`prepareBoxForCommand`) loads O and reuses the Box (same container ID);
- `update repo x` is not refused;
- a guarded start reuses the Box;
- a changed `PLOINKY_BOX_IMAGE` still loads the new reference.

`H2` in `ploinkyBoxImageAgentLibSupervisor.test.mjs` asserts only absent keys and keeps passing.

**Manual recipe** (real Podman host; probe images must pass `ploinky diagnose`):
1. Image A is the current `docker.io/assistos/ploinky-box:latest` tagged and pushed as `docker.io/<you>/ploinky-box-probe:latest`. Image B is `FROM` A plus one harmless file.
2. **Digest path.**
   1. In workspace W1, run `PLOINKY_BOX_IMAGE=docker.io/<you>/ploinky-box-probe:latest ploinky start <agent>`.
   2. Push B, then run `ploinky update`. Expect a digest pull, a replaced Box whose `.Image` is B, the graph restarted, `box-image-refreshed`, and exit 0.
   3. Run `ploinky update` again. Expect `box-image-current`.
3. **Tag path.** Run W1 with `HTTPS_PROXY` set and no `NODE_USE_ENV_PROXY`, push C, then run `ploinky update`. Expect the in-transaction pull and `box-image-refreshed`. On a repeat run, expect `box-image-current`.
4. **Cross-workspace.** Workspace W2 runs the same reference in image mode (no local `achillesAgentLib`). After step 2 moves the tag:
   - `ploinky var X y` in W2 keeps W2's Box container ID;
   - `ploinky update repo <r>` in W2 is not refused;
   - `ploinky update` in W2 refreshes it.
5. **Opt-outs and partial forms:**
   - after `ploinky var PLOINKY_IMAGE_REFRESH off` and pushing D, `ploinky update` makes no registry traffic;
   - `ploinky update repo <r>` makes no Box check;
   - `ploinky stop` then `ploinky update` gives `box-image-check-deferred`;
   - with the registry blocked, `ploinky update` gives `registry-unreachable` and exit 0;
   - a digest-pinned `PLOINKY_BOX_IMAGE` gives no check.
6. **Invalid image.** Push E with `USER root`, then run `ploinky update`. Expect `box-image-invalid`, the Box kept, the tag unmoved (digest path), and exit 0.

### 8.6 Decisions on the former open questions

1. A replacement that started and failed exits non-zero, with the existing restore.
2. A stopped Box, or undetermined graph activity, defers the check (`box-image-check-deferred`).
3. Folder-scoped full updates are included.
4. An unprovable digest with a reachable registry is the in-transaction tag refresh (D5), replacing only when the tag now names another image. An unreachable registry or a 429 keeps the Box (`registry-unreachable`).

## 9. Addendum: agent image phase must count only live no-wait workers

Status: proposed fix from live testing. It is independent of §8.

**Problem.** `refreshUpdateImages` (`cli/commands/updateImagePhase.js:157-162`) skips the agent image phase (`image-refresh-workers-active`) when `inspectInFlightNoWaitWorkers()` returns any worker. The classification (`noWaitWorkerLiveness.js:70-160`) keeps some runs "live" on file state alone:
- A run-scoped status without a published `pid` (a queued status: `workerPid` is `null`, `noWaitProtocol.js:244`) makes `proveWorkerProcessIdentity` throw "not one positive integer" (`processIdentity.js:185-186`). That error is neither stale nor foreign, so the run is reported as `running (unproven)` and can progress until its run-scoped deadline, which can be tens of minutes.
- A marker without a status counts as live for the 60 s startup grace.

Stale status files whose processes are dead therefore block the image refresh.

**Fix (one phase).** In `refreshUpdateImages`, replace the dependency on `inspectInFlightNoWaitWorkers` with the liveness list plus a process check. A worker blocks the phase only if it can still progress **and** its published pid names a running process.

```js
    const inspectLive = deps.inspectLiveNoWaitWorkers
        || (await import('./noWaitRunSettlement.js')).inspectLiveNoWaitWorkers;
    const isAlive = deps.isProcessAlive || (await import('../sandbox/processIdentity.js')).isProcessAlive;
    // A status file alone never blocks the refresh: only a worker whose published
    // pid is a running process can still pull or create from an image tag.
    const active = inspectLive().filter((worker) => worker.canProgress
        && Number.isSafeInteger(worker.pid) && worker.pid > 0 && isAlive(worker.pid));
    if (active.length) { /* unchanged log line and image-refresh-workers-active record */ }
```

`inspectLiveNoWaitWorkers` (`noWaitRunSettlement.js:116`) returns `{ containerName, runId, pid, identity, canProgress }`, and `isProcessAlive` is exported from `cli/sandbox/processIdentity.js:30`.

One residual window remains: a worker spawned less than 60 s ago that has not published its pid. It is acceptable, because the agent phase pulls by digest and moves tags only under the lease with a compare check.

**Tests** (`tests/unit/updateImagePhase.test.mjs`):
- The three existing injections of `inspectInFlightNoWaitWorkers` (≈:188, :197, :368) become `inspectLiveNoWaitWorkers` plus `isProcessAlive`.
- New cases:
  - a live entry with `pid: null` does not skip;
  - a pid with `isProcessAlive` returning `false` does not skip;
  - `canProgress: false` does not skip;
  - a proven-alive pid with `canProgress` gives `image-refresh-workers-active`.
- A fixture test with real `noWaitRunSettlement` files (pattern of `noWaitRunSettlement.test.mjs:180-262`): a queued status without a pid and a dead marker run does not skip the phase.
