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
4. **Locks.** Pulls run outside the workspace mutation lease, the restart locks and the network lock. The update image phase runs after the lease is released and only when no no-wait worker is in flight.
5. **Failure handling:**
   - Registry unreachable: warn and keep the cached image.
   - Registry reachable but the digest cannot be proven: run `<runtime> pull`.
   - Pull failure: warn and keep the cached image.
   - Nothing in the refresh fails `update`. In `update`, a failure becomes a `skipped` record and the exit code stays 0.
6. **Policy.** `PLOINKY_IMAGE_REFRESH` = `check` (default) | `always` | `off`. It is read from the workspace variable (`ploinky var PLOINKY_IMAGE_REFRESH off`) first, then from the process environment.
   - `off` disables registry checks and refresh pulls.
   - `imageChanged` recreation (contract item 2) stays active under every policy, because it reacts only to local state.
   - `start`, `restart` and the no-wait worker do not read the variable.
   - An invalid value fails `update` before any repository mutation (`PLOINKY_UPDATE_IMAGE_REFRESH_INVALID`).
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

**Proxy.** `nativeFetchIgnoresProxy(env = process.env, execArgv = process.execArgv)` returns true when any of `HTTPS_PROXY`, `https_proxy`, `ALL_PROXY` or `all_proxy` is non-empty **and** none of these is present:
- `env.NODE_USE_ENV_PROXY === '1'`;
- `--use-env-proxy` in `execArgv`;
- `--use-env-proxy` in `NODE_OPTIONS`.

(Node 24 and recent 22.x support `--use-env-proxy`.) When it returns true, the session skips the `HEAD` and delegates to the engine. `NO_PROXY` is not interpreted. In-Box processes have no proxy variables today.

**Rate limits.** Docker documents that a manifest `HEAD` does not count as a pull; the live probe returned `ratelimit-limit: 100;w=3600`. Delegated pulls and policy `always` do count, because the engine fetches the manifest with `GET`.

### D3. Policy (`cli/sandbox/docker/imageRefresh.mjs`)

```js
export const IMAGE_REFRESH_VAR = 'PLOINKY_IMAGE_REFRESH';
const IMAGE_REFRESH_POLICIES = new Set(['check', 'always', 'off']);

// Workspace variable first (`ploinky var PLOINKY_IMAGE_REFRESH off`, visible
// inside the Box), then the process environment, then 'check'.
export function resolveImageRefreshPolicy({ env = process.env, readVar = resolveVarValue } = {}) {
    let raw = '';
    try {
        raw = String(readVar(IMAGE_REFRESH_VAR) || '').trim();
    } catch (error) {
        debugLog(`[pull] ${IMAGE_REFRESH_VAR}: workspace variables unreadable (${error?.message || error}); using the environment`);
    }
    if (!raw) raw = String(env?.[IMAGE_REFRESH_VAR] || '').trim();
    if (!raw) return 'check';
    if (!IMAGE_REFRESH_POLICIES.has(raw)) {
        const error = new Error(`${IMAGE_REFRESH_VAR} must be 'check', 'always' or 'off', not '${raw}'`);
        error.code = 'PLOINKY_IMAGE_REFRESH_INVALID';
        throw error;
    }
    return raw;
}
```

The variable is read inside the in-Box process, so no host-to-Box environment forwarding is needed and nothing changes in `ploinky-box/`. A manifest-level policy is not provided (decision Q2).

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
3. If the policy is `always`, or `nativeFetchIgnoresProxy()` is true, then pull.
4. Otherwise `remote = await fetchRemoteManifestDigest(parsed, { unreachableHosts })` (one `Set` per session):
   - `ok` and `local.has(remote.digest)`: `current`.
   - `ok` and not present: log, then pull.
   - `unavailable`: warn, keep cached.
   - `undetermined`: log `asking <rt> to pull`, then pull.
5. Pull:
   1. `beforeId = readImageId(ref)`.
   2. `await beforePull?.()`.
   3. `pull(ref, { runtime, log })`. On a throw: `pull-failed`, warn, keep cached.
   4. `afterId = readImageId(ref)`.
   5. If `beforeId && afterId && beforeId !== afterId`, the result is `refreshed` and the rollback hint (D7) is printed. Otherwise the result is `current`, because the delegated pull found nothing new.
6. Any unexpected internal error: `unavailable`, with a warning.

Checks are sequential; there are 1-3 mutable refs in practice. There is no concurrency, no phase budget, and no redirect cap. Pulls use the existing `PLOINKY_IMAGE_PULL_TIMEOUT_MS`.

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

Add this to `agentServiceManager.js`, next to `inspectContainerImageId` (:1400), and reuse that helper for the desired side. Change the import at :146 to `import { containerToolchainIdentity, normalizeImageId } from '../../utils/dependencies/store/installContract.mjs';`.

```js
// The immutable ID an existing container runs, or null when it cannot be read.
function readRuntimeContainerImageId(runtime, containerName, spawn = spawnSync) {
    try {
        const result = spawn(runtime, ['container', 'inspect', '--format', '{{.Image}}', containerName], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
        });
        if (result.error || result.status !== 0) return null;
        return normalizeImageId(String(result.stdout || '').trim().split('\n')[0]);
    } catch (_) {
        return null;
    }
}

/**
 * Whether an existing managed container runs a different image than its
 * reference resolves to locally now (a re-pulled tag). Null when equal or
 * when either side is unknown: uncertainty never forces a replacement.
 */
export function containerImageChange({ runtime, containerName, imageRef }, {
    readContainerImageId = readRuntimeContainerImageId,
    readImageId = inspectContainerImageId,
} = {}) {
    const ref = String(imageRef || '').trim();
    if (!ref || !containerName || (runtime !== 'podman' && runtime !== 'docker')) return null;
    const observed = readContainerImageId(runtime, containerName);
    const desired = observed ? readImageId(runtime, ref) : null;
    if (!observed || !desired || observed === desired) return null;
    return Object.freeze({ observed, desired });
}
```

**Hook 1, in `ensureAgentService`.** Insert this after the AgentLib block (after :4289) and before the dependency comment (:4291). It runs before the managed adoption and the host/none early return, so a re-pulled tag yields a clean replacement instead of an adoption-attestation mismatch (`:2467`, `:2548`).

```js
    // A re-pulled mutable tag resolves to a new image ID. Replace the runtime even
    // when no dependency generation would notice (a start command without
    // package.json). LLM agents run their catalog image, not the manifest image.
    if (existingRuntimeAtEntry && !recreateReason) {
        const imageChange = containerImageChange({
            runtime,
            containerName,
            imageRef: serviceLlmAdmissionContext.catalogIdentity?.imageRef || image,
        });
        if (imageChange) {
            debugLog(`[ensureAgentService] ${agentName}: image changed, recreating container`);
            recreateDetail = hashMismatchDetail('image',
                imageChange.observed.replace(/^sha256:/, ''), imageChange.desired.replace(/^sha256:/, ''));
            recreateReason = 'imageChanged';
        }
    }
```

The existing `logRuntimeReplacement` (:4499) then prints `[start] repo/agent: replacing its runtime (imageChanged: image 0a1b2c3d4e5f -> bc7c8956426d)`.

- **GPU-share (MPS) clients need no special case.** MPS coordination runs `ensureImagePresent` and inspects the same ref under the same locks before it creates the container by ID (`mpsLifecycle.mjs:151-154, 352-354`).
- **No graph-level check and no new registry-record fields.** This mirrors `dependencyGenerationChanged`, which also lives only in `ensureAgentService`.

**Hook 2, in the no-wait worker's ready reuse** (`noWaitWorker.js`, inside `capture(lifecycle)`, before `const adopted = …` at :1978). Change the import at :25 to `import { admittedRuntimeDependencyProblem, containerImageChange } from '../sandbox/docker/agentServiceManager.js';`.

```js
                // A ready runtime is adopted only while it still runs the image its
                // reference resolves to; a re-pulled tag goes through ensure.
                let imageChange = null;
                if (lifecycle.targetState === 'ready') {
                    let desiredImageRef = String(llmAdmissionContext.catalogIdentity?.imageRef || '');
                    if (!desiredImageRef) {
                        try {
                            desiredImageRef = resolveManifestImage(manifest, profileResolution.profileConfig, {
                                agentName: shortAgent, repoName,
                            });
                        } catch (_) {
                            desiredImageRef = '';
                        }
                    }
                    imageChange = containerImageChange({ runtime: admittedRuntime, containerName, imageRef: desiredImageRef });
                }
                const adopted = lifecycle.targetState === 'ready'
                    && !dependencyProblem
                    && !imageChange
                    && !manifest['link-install']?.length
                    && !['default', 'bridge'].includes(profileResolution.network.mode);
```

### D6. Where refresh runs: `ploinky update` only

`ploinky update` is the only command that contacts a registry or pulls a changed tag. `ploinky start`, `ploinky restart` (every form, including `restart router`) and the no-wait worker never do: their image handling stays exactly as it is today (a missing image is pulled by the worker prefetch or the in-lease `ensureImagePresent`; a present image is used as is). They do pick up an image that `update` already pulled, through the local, network-free `imageChanged` reason (D5), whether it runs as the update's activation restart or as the operator's next start or restart.

`refreshWorkspaceGraphImages(session, { includeNoWait = true, filter = null })` is added to `workspaceUtil.js`. It resolves `preflightWorkspaceStartRuntimeCapabilities()` (a failure logs a `[pull] Warning: image refresh skipped; ...` line and returns `[]`), then calls `refreshAdmittedGraphImages(admitted, session, { includeNoWait, filter })`. Only the update image phase (D8) calls it. `startWorkspace`, `cli.js` and `prefetchNoWaitRuntimeImage` are unchanged.


### D7. Logging and rollback

The prefix is `[pull]`, as in `common.js`. Per-ref "current" lines go to `debugLog`. Reasons pass through `sanitizeReason`, and tokens never appear.

- **Changed:** `[pull] docker.io/assistos/roboteam-agent:runtime: registry digest differs (local sha256:0a1b2c3d4e5f, registry sha256:bc7c8956426d); pulling...` After this come the existing `pullImage` lines.
- **Delegated:** `[pull] <ref>: registry digest not readable (<reason>); asking podman to pull`.
- **Refreshed:** `[pull] <ref> refreshed for repo/agent[, …]; previous image <64-hex old ID>. To roll back: <runtime> tag <64-hex old ID> <ref>, then ploinky restart.`
- **Warnings:**
  - `[pull] Warning: registry <host> unreachable for <ref> (<reason>); using the cached image.`
  - `[pull] Warning: pull of <ref> failed (<message>); using the cached image.`
- **Summary:** `[pull] Image refresh: 1 refreshed, 2 current, 0 unavailable, 0 failed.`, printed only when at least one ref was checked.

There is **no automatic pruning** in this change. The previous image stays on disk without a tag, and that is what the rollback hint relies on. The Box's automatic graph rollback (`restorePriorGraph`, `supervisor.mjs:1131-1146`) cannot restore it, because the tag has already moved; recovery is the manual `tag` command. Dangling images accumulate in the workspace-backed `.ploinky/box/images` until `destroy --delete-cache`. This is a known follow-up (section 7).

### D8. Update phase and records

- **Phase.** Add `'image'` to `UPDATE_PHASES` (`updateOutcome.js:14`, before `'activation'`).
- **Policy parse.** In `runUpdate`, directly after `const request = parseUpdateRequest(args);` (:120):

  ```js
          let imageRefreshPolicy;
          try {
              imageRefreshPolicy = resolveImageRefreshPolicy({ env });
          } catch (error) {
              error.code = 'PLOINKY_UPDATE_IMAGE_REFRESH_INVALID';   // thrownRecord: failed, before any mutation
              throw error;
          }
  ```

- **Image phase.** After the `if (releaseFailed) { … }` block and before `} catch (error) {` (:152):

  ```js
          if (!isCancelledResult(result)) {
              result = await appendImageRefreshPhase(result, {
                  request, policy: imageRefreshPolicy, cancellation, hostActivates: Boolean(reportRequest), log, refreshImages,
              });
          }
  ```

  Add `refreshImages = refreshUpdateImages` to the `runUpdate` options.
- **`appendImageRefreshPhase`** (local to `updateCommand.js`):
  - It returns `result` unchanged when the policy is `off` or `request.kind === 'repos'`.
  - It creates the session with `beforePull: () => cancellation.checkpoint('image', result.records)`. The resulting `UpdateCancelledError` keeps the git records and reaches the existing `catch` as a `cancelled` record.
  - It appends `imageRefreshUpdateRecords(results)`.
  - A throw from `refreshImages` other than `UpdateCancelledError` is logged as `[pull] Warning: image refresh skipped (...)` and leaves the result unchanged.
  - When something was refreshed and `!hostActivates`, it logs `[update] Refreshed images take effect after \`ploinky restart\` (or \`ploinky restart <agent>\`).` In the Box flow with an active graph, the host's follow-up restart activates them.
- **`refreshUpdateImages({ request, session, log })`** uses lazy imports, so existing update tests do not load `workspaceUtil.js`:
  1. Return `[]` when `getConfig()?.static?.agent` is unset. A never-started workspace is checked at its first start.
  2. Return `[]` with one log line when `inspectInFlightNoWaitWorkers().length` is non-zero (this avoids the race in section 7).
  3. Otherwise call `refreshWorkspaceGraphImages(session, { includeNoWait: true, filter })`. The filter is `target.repoName === request.repoName` for `kind: 'repo'`, `target.manifestPath` inside `request.folderPath` for a folder-scoped `all`, and `null` for bare `update`.
- **Records.** One per mutable ref: `id` = canonical ref, `required: false`, `details.agents`, `before`/`after` = `{ imageId }`. Skipped refs (pinned, unqualified, missing, policy `off`) emit **no** record.

| Result | Outcome | Code | Notes |
| --- | --- | --- | --- |
| `refreshed` | `changed` | `image-refreshed` | |
| `current` | `unchanged` | `image-current` | |
| `unavailable` | `skipped` | `registry-unreachable` | |
| `pull-failed` | `skipped` | `image-pull-failed` | `attempted: true`; exit 0 (`complete-with-skips`) |

## 4. Module layout

All new modules are `.mjs`, have no import-time side effects, and stay under 300 lines.

- `cli/sandbox/docker/imageReference.mjs`: `parseImageReference`, `repoDigestSet` (D1).
- `cli/sandbox/docker/registryDigest.mjs`: `fetchRemoteManifestDigest`, `nativeFetchIgnoresProxy`, `isTlsClassError` (D2).
- `cli/sandbox/docker/imageRefresh.mjs`:
  - `IMAGE_REFRESH_VAR`, `resolveImageRefreshPolicy`;
  - `createImageRefreshSession`;
  - `collectAdmittedImageTargets`, `refreshAdmittedGraphImages`;
  - `imageRefreshUpdateRecords`.

  It imports:
  - `probeContainerRuntime` and `pullImage` from `common.js`;
  - `containerToolchainIdentity` from `installContract.mjs`;
  - `resolveVarValue` and `resolveManifestImage` from `secretVars.js`;
  - `resolveManifestRuntimeProfile` from `profileService.js`;
  - `classifyDependencyGraphWaitMode` from `workspaceDependencyGraph.js`;
  - `createOperationRecord` from `updateOutcome.js`;
  - `debugLog` from `utils.js`.

  None of these imports it back, so there is no cycle.
- Modified files:
  - `agentServiceManager.js`: D5;
  - `noWaitWorker.js`: D5 hook 2 only (no refresh, no prefetch change);
  - `workspaceUtil.js`: `refreshWorkspaceGraphImages` only (no change to `startWorkspace`);
  - `updateCommand.js` and `updateOutcome.js`: D8;
  - the docs and help text.

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

**Phase 3: the update image phase (D8).** Add `'image'` to `UPDATE_PHASES`, the policy parse, `appendImageRefreshPhase`, `refreshUpdateImages`, and `refreshWorkspaceGraphImages` in `workspaceUtil.js`.

**Phase 4: docs and the cross-repository step.**
7. Docs: `DS006` (the policy, update as the only refreshing command, the `imageChanged` reason, the rollback command, the digest-pinning recommendation, lagging mirrors), `DS009` (a new image ID creates a new dependency generation), `DS004` (one sentence), and `cli/commands/help.js` (`ploinky var PLOINKY_IMAGE_REFRESH off|check|always`). Run `fileSizesCheck.sh`.
8. In `/home/user/container-image-builds/scripts/install-roboteam-local-in-box.sh`, as a separate commit in that repository, insert after the target `case` block and before any build:

    ```bash
    # Local builds reuse the published tags; stop Ploinky from refreshing them from the registry.
    if /opt/ploinky/bin/ploinky-local var PLOINKY_IMAGE_REFRESH off; then
        echo "[local-images] image refresh is off for this workspace; 'ploinky var PLOINKY_IMAGE_REFRESH check' follows the registry again"
    else
        echo "[local-images] could not set PLOINKY_IMAGE_REFRESH; run 'ploinky var PLOINKY_IMAGE_REFRESH off' before the next update" >&2
    fi
    ```

    This applies to every target. Refreshing the agent tag would recreate `roboTeamAgent`, which is the container the desktop and browser images were loaded into.


## 6. Testing

**New unit tests** (`tests/unit/*.test.mjs`, `node:test` plus `node:assert/strict`, style of `manifestImageResolution.test.mjs`). The seams are `fetchImpl`, `spawn`, `env`, `pull` and `readImageId`; there is no network and no engine.

- `imageReference.test.mjs`: reference parsing (`docker.io/...`, `node:18-alpine`, `docker.io/node`, `localhost:5000/a/b:t`, `ghcr.io/o/r:t`, digest pinning, malformed refs) and `repoDigestSet`.
- `registryDigest.test.mjs`: anonymous `200`; `401` Bearer to token to `200` (Accept header, `service`/`scope` query, exactly one retry, `access_token`, odd quoting); the `undetermined` and `unavailable` classes; the unreachable-host memo; `nativeFetchIgnoresProxy`; the token never appears in logs or results.
- `imageRefresh.test.mjs`: policy precedence and validation; the session (one `HEAD` and one pull for two agents, pinned/unqualified/`localhost`/missing images make no calls, equal digest, different digest with rollback hint, empty RepoDigests, `undetermined`, `unavailable`, `pull-failed`, `always`, `off`, `beforePull` propagation, unknown runtime); `collectAdmittedImageTargets`; `refreshAdmittedGraphImages`; `imageRefreshUpdateRecords` and the D8 table (`decideUpdateStatus` gives `complete-with-skips`, exit 0, activation allowed for `image-pull-failed`).
- `agentImageChange.test.mjs`: `containerImageChange` through injected readers.
- `updateImageRefreshPhase.test.mjs`: an invalid policy fails the update before any mutation; image records follow the git records; `off` and `update repos` skip the phase; a workspace without a static agent has nothing to refresh; a throwing refresh is a warning; cancellation during the image phase keeps the git records and ends with a `cancelled` record.
- `updateReportProtocol.test.mjs`: an `image` record round-trips through the published report.
- Behavioral regression in `tests/unit/dependencyStoreRuntimeWiring.test.mjs`, with `wiringWorkspace(t, { packageJson: null })` (a start command and no `package.json`): a first start; then the engine resolves the tag to another image ID (`FAKE_ENGINE_IMAGE_HEX`, standing in for the pull `ploinky update` performed) and the next start recreates the container (`createdByThisLaunch === true`); a third start with the same ID reuses it.

**Existing tests that were updated:**
1. `tests/unit/dependencyStoreRuntimeIntegration.test.mjs`: assert that `containerImageChange(` precedes both `adoptManagedRuntimeOnly = !managedReconciliationPreparationLease` and the host/none early-return `debugLog`, that `recreateReason = 'imageChanged'` is present, and that the no-wait `capture` contains `/&& !imageChange/`.
2. `tests/unit/dependencyStoreFakeEngine.mjs`: add the container-inspect `{{.Image}}` format.
3. `tests/unit/hardwareLimitsInstallerImage.test.mjs:60` must keep passing unchanged (guard against renaming `inspectContainerImageId`).
4. The update tests (`updateResultPolicy`, `updateReportProtocol`, `updateCancellation`, `workspaceLeaseOperationOwnership`, `ploinkyBoxHostExclusionsInterrupt`) must stay green: the default image phase returns early in workspaces without `static.agent`.

**Manual verification recipe.**
1. Push a multi-arch image A to a scratch repo `docker.io/<you>/refresh-probe:runtime`.
2. Point a test agent at that ref, with a `start` command and no `package.json`. Run `ploinky start`.
3. Push image B under the same tag, then run `ploinky start`. Expect no `[pull]` lines and no replacement: start never contacts the registry.
4. Run `ploinky update`. Expect `registry digest differs`, the rollback hint and an `image` record `image-refreshed`. With an active Box graph, the host restart activates it; otherwise run `ploinky restart` and expect `replacing its runtime (imageChanged: ...)`.
5. Run `ploinky update` again. Expect `1 current` and no pull.
6. Run `ploinky var PLOINKY_IMAGE_REFRESH off`, push again, and run `ploinky update`: no registry traffic. Run `ploinky var PLOINKY_IMAGE_REFRESH bogus`, then `ploinky update`: it fails before any repository update.
7. Offline (block the registry host): `ploinky update` succeeds with one warning and a `registry-unreachable` record. Roll back with the printed `podman tag ...` and `ploinky restart`.
8. In-Box local build: run `install-roboteam-local-in-box.sh agent`, then `ploinky update`. The local build is kept, and the variable reads `off`.


## 7. Decisions, risks and known follow-ups

**Decisions on the former open questions:**
- **Q1.** A failed pull during `update` is a `skipped` record with code `image-pull-failed`. Exit 0.
- **Q2.** There is no per-manifest pull policy. Digest pinning is the per-agent opt-out, and the workspace variable is the global one.
- **Q3.** LLM catalog entries that declare `digest` count as pinned and are not refreshed.
- **Q4.** `reinstall` and `enable` are out of scope. They keep missing-only pulls; `imageChanged` still applies when they go through `ensureAgentService`.

**Retag race (accepted, documented).** A pull outside the locks can move a tag while a no-wait worker of an earlier start creates or attests a container from that tag. The attestation then fails closed (`routerAuthorityAttestation.js:752` against `agentServiceManager.js:2467`): the candidate is cleaned up, and the superseding command heals it. The window is reduced because the update image phase skips itself while any no-wait worker is in flight. Creating containers from image IDs is **not** part of this change.

**Operational risks:**
- A broken re-push reaches every workspace at its next start, restart or update. Mitigations: the rollback hint, the DS006 recommendation to pin digests in production, and `PLOINKY_IMAGE_REFRESH off`.
- A lagging registry mirror can report "changed" on every command until it catches up.
- A delegated pull, or the `always` policy, counts against the Docker Hub pull quota.
- The pull timeout is the existing 30-minute default, which equals the host's in-Box command bound; cold pulls have this exposure today.

**Known follow-ups:**
- Superseded-image cleanup, which would remove dangling images from `.ploinky/box/images`. A future change could run `<rt> image rm <oldId>` without `--force`, only after the replacement passed readiness. It is not in this change, so that rollback remains possible.
- An AssistOSExplorer change: `roboWorkAgent/server/environment.mjs:63` has its own missing-only `podman pull` for `roboteam-desktop:runtime` and `roboteam-browser:runtime`.
- The Box image policy (`ploinky-box/lifecycle/transactions.mjs`) is out of scope.
