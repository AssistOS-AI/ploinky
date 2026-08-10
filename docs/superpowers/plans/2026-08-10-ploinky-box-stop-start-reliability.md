# Ploinky Box Stop/Start Reliability Hard-Cut Implementation Plan

Date: 2026-08-10

Audience: Codex or an engineer implementing the change in `/Users/danielsava/work/file-parser/ploinky`

Status: Ready for implementation

## 1. Start Here

Before editing production code:

1. Read the repository-root `AGENTS.md` and the complete canonical `CLAUDE.md`.
2. Treat current executable code and tests as the source of truth. Historical specifications, earlier plans, and generated HTML are background only and must not be updated as part of this change.
3. Preserve unrelated user changes. The worktree currently contains an unrelated untracked `output/` directory; do not remove, overwrite, stage, or otherwise modify it.
4. Establish the focused unit-test baseline described in Task 0 before editing.
5. Implement the storage contract and readiness correction as one change. Shipping either half independently leaves a known failure mode.
6. Make a hard cut. Backward compatibility, migration, dual contract support, and automatic legacy repair are not required.
7. Do not weaken the rootless and unprivileged Box contract. Do not add root startup, `--privileged`, SUID/setuid, file capabilities, `chown`-based ownership repair, or relaxed confinement.
8. Do not deploy Explorer, recreate `~/work/testExplorerFresh`, run the cross-repository Playwright gates, publish an image, push a release, commit, or open a pull request unless the user requests that action separately.

The user-approved direction is:

> Fix stopped-Box restart permanently. Existing Box layouts do not need backward compatibility.

## 2. Required Outcome

The implementation must make this lifecycle reliable:

```text
ploinky start explorer
ploinky stop
ploinky start explorer
```

The second `start` must reuse the same compatible outer container, complete the current boot's self-checks, install or verify Box dependencies, start the requested graph, and report success.

The completed implementation must satisfy all of these outcomes:

| Area | Required outcome |
|---|---|
| Transient runtime state | `/tmp` is a real tmpfs in every newly created outer Box. Its contents do not survive outer container stop/start. |
| Inner Podman runroot | `/tmp/storage-run-1000` starts from a clean tmpfs on every outer Box boot. A root-owned path from a previous boot cannot block entrypoint preparation. |
| Durable state | The repository, workspace, dependency cache, and nested image cache keep their existing four bind mounts and persistence behavior. |
| Readiness | Only the exact `PLOINKY_BOX_READY` line emitted by the current start attempt can satisfy readiness. |
| Container state | Readiness succeeds only while inspection proves the outer container is running. |
| Failure diagnostics | A current-boot self-check failure is reported directly. It must not be hidden behind a later `container exec` status 125 error. |
| Reuse | A stopped compatible Box is restarted without pulling an image or replacing the outer container. |
| Security | The Box remains rootless, unprivileged, keep-id mapped, and limited to the existing devices, publications, and durable binds. |
| Hard cut | Old outer Boxes that lack the new tmpfs contract are not accepted, migrated, repaired, or automatically replaced. |

## 3. Observed Current Behavior

The following facts come from the current implementation, tests, and the reproduced failed Box:

| Observation | Evidence and consequence |
|---|---|
| A stopped compatible Box is restarted in place. | `reconcileBoxContainer()` runs `container start` for `runtime.running === false`, then waits for readiness. |
| The outer Box currently has no tmpfs mount. | `containerCreateArgs()` renders four `--volume` arguments but no `--tmpfs`; inspection of the failed Box reported an empty `HostConfig.Tmpfs`. |
| `/tmp/storage-run-1000` lives in the outer writable layer. | The inner storage configuration uses it as `runroot`, while the outer runtime supplies no transient filesystem at `/tmp`. |
| The failed stopped Box retained a root-owned `0700` runroot. | Exported metadata showed `/tmp/storage-run-1000` owned by UID/GID 0/0. The entrypoint runs as the unprivileged `podman` user and could not remove it. |
| Entrypoint preparation removes the fixed transient paths before configuring storage. | `resetTransientNestedRuntime()` calls recursive `rmSync()` for `storage-run-1000` and `podman-run-1000`. |
| The new restart failed before readiness. | The current-boot log contained `SELF-CHECK FAILED: EACCES, Permission denied: /tmp/storage-run-1000`. |
| Podman container logs are cumulative across starts. | The failed Box log still contained a historical `PLOINKY_BOX_READY` from its first successful boot. |
| Readiness checks logs before checking state. | `waitForReadyLine()` returns immediately when any stdout line equals the ready marker, then skips the state inspection. |
| Dependency installation happens after reconciliation. | The historical ready marker allowed reconciliation to return, after which dependency installation attempted `container exec` against an exited container and produced status 125. |
| `podman ps` omitted the Box because it was stopped. | `podman ps -a` is required to see exited containers. This is expected Podman behavior, not another lifecycle defect. |

## 4. Inferred Root Cause

Two independent defects combine into the reported symptom:

```text
outer Box first boot succeeds
    -> inner Podman creates transient runroot state under writable-layer /tmp
    -> outer Box stops
    -> writable-layer /tmp survives
    -> outer Box starts as unprivileged podman
    -> entrypoint cannot remove retained root-owned runroot
    -> current boot exits with EACCES
    -> cumulative logs still contain the previous PLOINKY_BOX_READY
    -> readiness accepts the historical marker
    -> dependency installation executes against the exited Box
    -> user sees status 125 instead of the EACCES cause
```

The storage fix prevents the restart failure. The readiness fix ensures that a different future self-check failure cannot be concealed in the same way.

## 5. Non-Negotiable Design Decisions

| Decision | Required implementation |
|---|---|
| Mount the full `/tmp` path | Add one outer tmpfs at `/tmp`; do not mount `/tmp/storage-run-1000` directly. The existing entrypoint must remain able to remove child paths without attempting to remove a live mountpoint. |
| Use one exact tmpfs contract | Start with `/tmp:rw,exec,nosuid,nodev,mode=1777,notmpcopyup`. Canonicalize option ordering during validation. Do not add an arbitrary size cap. |
| Preserve executable `/tmp` behavior | Include `exec` so the hard cut does not accidentally turn temporary script or tool execution into a separate compatibility problem. |
| Start with an empty tmpfs | Use `notmpcopyup` so image-layer `/tmp` content cannot be copied into the transient mount. |
| Keep entrypoint cleanup | Retain `resetTransientNestedRuntime()` as defense-in-depth for preparation within a boot. Do not turn it into an ownership-repair mechanism. |
| Fence readiness with a log baseline | Capture stdout and stderr immediately before every `container start`. Only bytes appended after that snapshot belong to the current boot. |
| Fail closed on ambiguous logs | If current cumulative logs no longer have the captured snapshot as an exact prefix, report log-history drift. Do not search the ambiguous content for a ready marker. |
| Prove running state before success | A fresh ready marker is necessary but insufficient. The same poll must prove `.State.Status` is `running`, and final rediscovery must still report `runtime.running === true`. |
| Preserve the exact ready marker | Keep `PLOINKY_BOX_READY` versionless and exact. Do not add schema versions, contract numbers, timestamps, or public generation suffixes. |
| Centralize start-and-wait | New-container startup and stopped-container reuse must call the same helper so neither path can omit the log baseline or state proof. |
| Hard cut existing Boxes | The new contract accepts only newly created Boxes with the exact tmpfs. Do not add legacy tmpfs defaults, migration classification, automatic recreation, or compatibility fallbacks. |
| Destroy before upgrade | Release instructions require existing outer Boxes to be destroyed before installing the hard-cut runtime. Ordinary destroy retains workspace-backed dependency and image caches. |

The proposed tmpfs option string must be proven against every supported host configuration in Task 8. If current Podman canonicalizes the same options differently, normalize the proven representation; do not weaken the semantic option set.

## 6. Current Implementation Map

| Boundary | Current file | Responsibility relevant to this change |
|---|---|---|
| Constants | `ploinky-box/constants.mjs` | Ready marker, runtime UID/GID, keep-id user namespace, data mount destinations |
| Container creation | `ploinky-box/lifecycle/container.mjs` | Exact outer create arguments, start readiness polling, final created-container validation |
| Container contract | `ploinky-box/contract/container.mjs` | Normalizes Podman inspection and validates user, image, labels, environment, publications, devices, security options, and mounts |
| Lifecycle transaction | `ploinky-box/lifecycle/transactions.mjs` | Creates and starts new Boxes, restarts stopped Boxes, restores replacements, and rediscoveries final state |
| Supervisor | `ploinky-box/supervisor.mjs` | Runs the locked start transaction and then verifies/installs dependencies and starts core |
| Entrypoint | `ploinky-box/entrypoint/entrypoint.mjs` | Removes transient runroot paths, writes inner storage configuration, and prepares the Box |
| Entrypoint shell | `ploinky-box/entrypoint/ploinky-box-entrypoint` | Runs preparation and self-checks, prints the exact ready marker, then remains alive |
| Unit contract tests | `tests/unit/ploinkyBoxTransactions.test.mjs` | Exact create argv, normalized runtime fixtures, stopped reuse, rollback, readiness diagnostics |
| Unit entrypoint tests | `tests/unit/ploinkyBoxEntrypoint.test.mjs` | Preparation order, transient cleanup, retained-container policy, mount validation |
| Safety tests | `tests/unit/ploinkyBoxSafetyMatrix.test.mjs` | Public lifecycle lock and mutation boundaries |
| Discovery tests | `tests/unit/ploinkyBoxDiscovery.test.mjs` | Raw Podman inspection normalization and owned/incompatible classification |
| Native integration | `tests/integration/ploinkyBoxNative.test.mjs` | Real Podman outer Box lifecycle, storage, mounts, replacement, health, and cleanup |
| Public package E2E | `tests/e2e/ploinkyBox/publicCli.test.mjs` | Packed public shims and a real candidate Box/graph |
| Native helpers | `tests/e2e/ploinkyBox/nativeHelpers.mjs` | Candidate digest enforcement, harness construction, and exact cleanup |
| Active documentation | `README.md`, `container/README.md`, `docs/code-derived-agent-lifecycle.md` | Current Box mount, persistence, and restart behavior |

No change is expected in `container-image-builds`. The host-side create contract supplies the tmpfs, and the current Box image already runs the canonical mounted entrypoint as `podman`. Add image-repository work only if the native gate proves a real image prerequisite is missing.

## 7. Target Outer Storage Contract

The outer Box must have four durable host binds and one transient tmpfs.

### 7.1 Durable binds

| Host source | Box destination | Mode | Lifetime |
|---|---|---|---|
| Ploinky repository root | `/opt/ploinky` | Read-only | Host checkout lifetime |
| Canonical workspace root | `/workspace` | Read-write | Workspace lifetime |
| `<workspace>/.ploinky/box/dependencies` | `/opt/ploinky/node_modules` | Read-write | Retained across outer destroy |
| `<workspace>/.ploinky/box/images` | `/home/podman/.local/share/ploinky-images` | Read-write | Retained across outer destroy |

### 7.2 Transient mount

| Type | Destination | Required options | Lifetime |
|---|---|---|---|
| tmpfs | `/tmp` | `rw,exec,nosuid,nodev,mode=1777,notmpcopyup` | One outer container boot |

The tmpfs is not a named volume, anonymous volume, host bind, or workspace-owned resource. It must disappear when the outer container stops and be recreated empty when the same outer container starts again.

### 7.3 State lifetime after the change

| State | Survives outer stop/start? | Survives outer destroy? |
|---|---|---|
| Host workspace | Yes | Yes |
| Dependency cache | Yes | Yes, unless explicitly deleted by the existing cache-deletion interface |
| Nested image cache | Yes | Yes, unless explicitly deleted by the existing cache-deletion interface |
| Inner graphroot in the outer writable layer | Yes | No |
| Inner named volumes under the graphroot | Yes | No |
| `/tmp/storage-run-1000` runtime metadata | No | No |
| Other `/tmp` files | No | No |

## 8. Target Start and Readiness Flow

Both new creation and stopped reuse must follow this sequence:

```text
validate exact workspace identity and lock
validate or create the exact outer container contract
capture cumulative stdout/stderr as the pre-start baseline
start the immutable outer container ID
poll cumulative logs and container state
    reject log history that is not prefixed by the baseline
    stream only current-boot log deltas
    if state is terminal, report current-boot final diagnostics
    if state is running and current-boot stdout contains the exact ready line, continue
    otherwise wait within the bounded timeout
rediscover exact ownership
validate the complete container contract
require the same immutable ID and runtime.running === true
verify/install Box dependencies
start the requested core graph
run health checks
release the workspace mutation lock
```

Dependency installation must remain unreachable unless current-boot readiness and final running-state validation both succeed.

## 9. Detailed Implementation Tasks

### Task 0: Establish Baseline and Capture the Real Tmpfs Inspection Shape

Record the worktree without modifying unrelated state:

```sh
cd /Users/danielsava/work/file-parser/ploinky
git status --short --branch
```

Run the focused baseline:

```sh
node --test \
  tests/unit/ploinkyBoxTransactions.test.mjs \
  tests/unit/ploinkyBoxEntrypoint.test.mjs \
  tests/unit/ploinkyBoxSupervisor.test.mjs \
  tests/unit/ploinkyBoxSafetyMatrix.test.mjs \
  tests/unit/ploinkyBoxDiscovery.test.mjs \
  tests/unit/runtimeDocumentation.test.mjs \
  tests/unit/runtimeSourceAbsence.test.mjs
```

Record any pre-existing failure separately. Do not change unrelated code to force a green baseline.

Before finalizing the contract normalizer, capture raw `podman container inspect` records for a disposable container created with the exact proposed tmpfs on:

| Host | Required captured fields |
|---|---|
| macOS Podman Machine | `Config.CreateCommand`, `HostConfig.Tmpfs`, and `Mounts` |
| Native Linux | `Config.CreateCommand`, `HostConfig.Tmpfs`, and `Mounts` |

The installed development Podman 6.0.1 advertises `--tmpfs` and the proposed Linux mount flags. The probe must determine whether Podman includes tmpfs in `Mounts`, reports it only in `HostConfig.Tmpfs`, and how it orders or canonicalizes options.

Use a uniquely named disposable resource and register exact cleanup before creation. Do not reuse, inspect, stop, or remove a workspace-owned Box for this probe.

### Task 1: Define the Exact Tmpfs Contract

Update `ploinky-box/constants.mjs` and add one immutable source of truth for the outer tmpfs. A recommended shape is:

```js
export const BOX_TMPFS = Object.freeze({
    destination: '/tmp',
    options: Object.freeze([
        'rw',
        'exec',
        'nosuid',
        'nodev',
        'mode=1777',
        'notmpcopyup',
    ]),
});
```

Required properties:

| Requirement | Detail |
|---|---|
| One source | Lifecycle rendering, contract normalization, validation, tests, and active documentation derive expectations from the same destination and semantic option set where practical. |
| Immutable | Freeze the object and option array like the existing runtime constants. |
| Versionless | Do not add a runtime-contract number, schema label, or versioned Box name. |
| No size cap | Do not limit tmpfs capacity without measured native evidence and an explicit resource decision. |
| Exact destination | Reject alternate destinations such as `/var/tmp` or the runroot child. |

Add focused constant assertions to the existing transaction or runtime-documentation tests rather than creating a broad new constants test.

### Task 2: Render the Tmpfs During Outer Container Creation

Update `containerCreateArgs()` in `ploinky-box/lifecycle/container.mjs`.

Add exactly one pair before the durable bind arguments:

```text
--tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,notmpcopyup
```

Preserve all existing creation invariants:

| Invariant | Required behavior |
|---|---|
| User | `--user podman` |
| User namespace | Exact `keep-id:uid=1000,gid=1000` |
| Init | One `--init` |
| Devices | Exactly `/dev/fuse` and `/dev/net/tun` |
| Security | Existing `unmask=ALL` and `label=disable`; no privilege expansion |
| Publications | Existing loopback Router TCP and wildcard media UDP only |
| Durable mounts | Exactly the existing four host binds with their current modes |
| Image | Immutable validated image ID remains the final argument |
| Named volumes | None |

Update the exact argv test in `tests/unit/ploinkyBoxTransactions.test.mjs` first. It must separately assert:

| Assertion | Expected value |
|---|---|
| `--volume` count | Four |
| `--tmpfs` count | One |
| tmpfs destination | `/tmp` |
| tmpfs semantic options | Exact required set |
| `:U` suffixes | None |
| privileged/socket mounts | None |

Do not describe the new runtime as having “five persistent mounts.” It has four durable binds and one transient tmpfs.

### Task 3: Normalize and Validate the Tmpfs Fail-Closed

Update `normalizeContainerRuntime()` and `validateContainerConfiguration()` in `ploinky-box/contract/container.mjs`.

Add a pure tmpfs normalizer with these properties:

| Input concern | Required handling |
|---|---|
| Missing `HostConfig.Tmpfs` | Normalize to an empty current set, which validation rejects. |
| Non-object or malformed data | Normalize as incomplete and reject. |
| Option order | Parse comma-separated options and compare a canonical semantic representation. |
| Duplicate options | Reject rather than silently collapse ambiguous input. |
| Duplicate destinations | Reject. |
| Unknown destination | Reject. |
| Extra option | Reject, even if apparently harmless. |
| Missing required option | Reject. |
| `Config.CreateCommand` | Validate the exact recorded `--tmpfs` argument when current Podman inspection proves it is reliably present. |
| `Mounts` representation | Follow the captured native evidence. Permit only the exact four binds plus the proven representation of the one `/tmp` tmpfs. |

Keep durable bind validation independent from tmpfs validation. The contract should be able to say whether the durable bind set or transient tmpfs set is incompatible without confusing tmpfs with a named or anonymous volume.

The validation result must still be versionless. A missing tmpfs is simply incompatible current configuration; do not classify it as `legacy-v1`, add a migration state, or attempt to repair it.

Update test fixtures that construct `containerHandle.runtime` so they include the exact normalized tmpfs representation. Add a table-driven validation test covering:

| Case | Expected result |
|---|---|
| Exact four binds and exact `/tmp` tmpfs | Accepted |
| No tmpfs | Rejected |
| `/tmp` with default `noexec` semantics | Rejected |
| `/tmp` missing `mode=1777` | Rejected |
| `/tmp` missing `notmpcopyup` | Rejected |
| `/tmp` with an extra option | Rejected |
| Tmpfs at the runroot child | Rejected |
| Exact `/tmp` plus a second tmpfs | Rejected |
| Four binds plus a named or anonymous volume | Rejected |
| Create-command record disagrees with inspected tmpfs | Rejected |

Update `tests/unit/ploinkyBoxDiscovery.test.mjs` if the normalized runtime object gains a required `tmpfs` field. Raw inspection fixtures must match the proven Podman representation, not a guessed Docker shape.

### Task 4: Add a Pre-Start Log Baseline Primitive

Update `ploinky-box/lifecycle/container.mjs` with a small, testable primitive that reads the cumulative logs before a start attempt. A recommended interface is:

```js
export function captureContainerLogBaseline(engine, containerId, runner) {
    // Return an immutable { stdout, stderr } snapshot or fail closed.
}
```

Required behavior:

| Condition | Required result |
|---|---|
| Valid immutable container ID and successful log query | Return exact stdout and stderr strings, including empty strings. |
| Log query failure before start | Fail before mutating the stopped container. |
| Invalid container ID | Reject through the existing lifecycle error pattern. |
| Snapshot mutability | Return an immutable value or copy strings so later runner changes cannot alter the baseline. |

Do not use wall-clock timestamps or `logs --since` as the primary generation boundary. Timestamp resolution and boundary inclusion can vary; exact cumulative-prefix comparison is deterministic and directly testable.

### Task 5: Make `waitForReadyLine()` Generation-Aware

Extend `waitForReadyLine()` with an explicit `logBaseline` option. Do not silently infer an empty baseline for stopped-container reuse. The central start helper added in Task 6 must always pass one.

Per poll, implement this decision order:

```text
read cumulative logs
verify stdout starts with baseline.stdout
verify stderr starts with baseline.stderr
compute and stream only current-boot deltas
inspect current container state
if state is terminal:
    reread final logs
    verify the same baseline relationship
    throw with current-boot bounded diagnostics
if state is running and fresh stdout contains exact PLOINKY_BOX_READY:
    return success
otherwise continue until timeout
```

Required details:

| Concern | Required behavior |
|---|---|
| Historical marker | A ready line entirely inside `baseline.stdout` never qualifies. |
| Exact matching | Split only fresh stdout on line boundaries and require one line equal to `BOX_READY_LINE`. Substring matches do not qualify. |
| Output streaming | Write only bytes added after the baseline, and write every fresh byte at most once. |
| stderr | Stream current-boot stderr deltas but never treat stderr as readiness. |
| State proof | Never return if state inspection does not prove `running`. |
| Terminal state | `exited`, `dead`, `stopped`, and other non-`created`/non-`running` states fail immediately with current-boot diagnostics. |
| Created state | May continue waiting within the existing timeout. |
| Failed log query | Cannot produce success. Retry only within the existing bounded wait policy, then report a diagnostic. |
| Failed state query | Cannot produce success. Fail closed or remain bounded; do not accept the marker without a running proof. |
| Log truncation/rotation | If cumulative text is not prefixed by the baseline, fail with a dedicated lifecycle diagnostic. Do not reset the baseline. |
| Timeout | Include only current-boot bounded diagnostics when they can be proven. |

Preserve the existing `/dev/net/tun` and `/dev/fuse` diagnostic hints. Apply them to the current-boot final log view.

Add unit tests in `tests/unit/ploinkyBoxTransactions.test.mjs` for:

| Regression | Test arrangement | Expected result |
|---|---|---|
| Reported production failure | Baseline contains old ready marker; fresh stderr contains the runroot `EACCES`; state is exited | Reject with `EACCES`; never return success |
| Historical marker while new boot is running | Baseline contains ready; no fresh ready yet; state running | Continue waiting |
| Fresh marker | Baseline has historical logs; current logs append exact ready; state running | Succeed and stream only fresh bytes |
| Ready then exited | Fresh logs contain ready; same poll reports exited | Reject |
| Prefix drift | Current stdout or stderr does not begin with its captured baseline | Reject as ambiguous log history |
| Duplicate polling | Repeated cumulative reads append one line at a time | Each line is emitted once |
| Empty new-container history | Empty baseline followed by normal boot logs | Succeed normally |
| Current device failure | Fresh terminal logs contain TUN or FUSE failure | Preserve the targeted access hint |

Do not change `BOX_READY_LINE` and do not add a versioned or nonce-suffixed public marker. Existing source-absence tests intentionally enforce the versionless marker.

### Task 6: Centralize Container Start, Wait, and Final Running Validation

Add one lifecycle helper, recommended in `ploinky-box/lifecycle/container.mjs`:

```js
export async function startContainerAndWaitReady(
    engine,
    containerId,
    runner,
    { stdout, stderr, ...waitOptions } = {},
) {
    const logBaseline = captureContainerLogBaseline(engine, containerId, runner);
    runner.run(engine.name, ['container', 'start', containerId]);
    await waitForReadyLine(engine, containerId, runner, {
        ...waitOptions,
        logBaseline,
        stdout,
        stderr,
    });
}
```

Use the existing immutable-ID validation and lifecycle error types. The exact signature may vary, but the helper must own the ordering so callers cannot start first and capture the baseline afterward.

Update both paths in `ploinky-box/lifecycle/transactions.mjs`:

| Path | Required change |
|---|---|
| `createAndStart()` | Replace direct `container start` plus `waitReady` with the central helper/seam. |
| Stopped compatible reuse | Replace direct `container start` plus `waitReady` with the same helper/seam. |
| Replacement restoration | Continue using `createAndStart()`, which therefore inherits the same behavior. |

Preserve dependency injection used by transaction and native tests. Prefer one injectable `startAndWaitReady` seam over separate seams that allow production ordering to drift.

After readiness, strengthen final validation:

| Check | Required outcome |
|---|---|
| Ownership | Rediscovery remains exactly owned by the same workspace identity. |
| Immutable ID | The final handle ID equals the ID that was started. |
| Full configuration | Existing image, labels, environment, devices, publications, security, binds, and new tmpfs all validate. |
| Running state | `handle.runtime.running` is exactly true. Otherwise throw before returning reconciliation success. |

Update transaction tests to prove:

| Scenario | Required call order |
|---|---|
| New Box | create → capture logs → start → wait → discover → validate running |
| Stopped reuse | revalidate bind sources → capture logs → start → wait → discover → validate running |
| Already running reuse | No log capture and no `container start`; final validation still succeeds |
| Baseline capture failure | No `container start`, dependency exec, removal, or pull |
| Readiness failure | No dependency installation or core startup |
| Final stopped rediscovery | Reconciliation fails even if readiness previously returned |

### Task 7: Keep Entrypoint Cleanup Narrow and Document the New Boundary

`resetTransientNestedRuntime()` in `ploinky-box/entrypoint/entrypoint.mjs` should keep removing only:

```text
/tmp/storage-run-1000
/tmp/podman-run-1000
```

Do not add permission repair, owner switching, shell fallback, broad `/tmp` deletion, or privileged cleanup.

Update the nearby comment to state that `/tmp` is supplied as a fresh outer tmpfs on each boot and the child cleanup protects repeated preparation within the same boot.

Strengthen `tests/unit/ploinkyBoxEntrypoint.test.mjs` only where useful:

| Test | Required proof |
|---|---|
| Exact cleanup scope | Only the two UID-keyed child paths are removed. |
| Tmp parent retained | The helper never attempts to remove `paths.tmp` itself. |
| Preparation order | Cleanup remains before storage configuration or any inner Podman query. |
| No ownership workaround | Production source does not introduce `chown`, sudo, setuid, or root relaunch logic. |

No Box image change is expected for this task.

### Task 8: Add the Native Stop/Start Regression

Extend `tests/integration/ploinkyBoxNative.test.mjs` with a candidate-gated test that reproduces the real lifecycle against one immutable image digest.

Required test sequence:

```text
create and start a candidate Box
capture its immutable outer container ID
run inner `podman info` so the configured runroot is materialized
create a uniquely named canary under /tmp as the Box user
verify the canary exists before stop
stop the outer Box through the real supervisor transaction
confirm the same outer container exists and is stopped
restart through normal reconciliation
assert action is reuse, not replacement
assert the outer immutable container ID is unchanged
assert the /tmp canary is absent
assert inner `podman info` succeeds and reports /tmp/storage-run-1000
assert the outer container contract has four binds and the exact /tmp tmpfs
assert dependency verification succeeds
assert health and the requested graph can start
```

Add or rename the native mount helper so it asserts the complete storage boundary, not only bind mounts. It must prove:

| Contract part | Native assertion |
|---|---|
| Durable binds | Exact four sources, destinations, and read/write modes |
| Tmpfs | Exact `/tmp` destination and semantic option set from raw inspection |
| Named outer volumes | None |
| Privilege | False |
| User/userns | Existing `podman` and keep-id proof |

Run this candidate gate on both supported host forms:

```sh
PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<immutable-digest> \
node --test tests/integration/ploinkyBoxNative.test.mjs
```

One passing macOS Podman Machine run is not a substitute for native Linux, and vice versa. Do not waive option or inspection differences. Normalize only differences proven to describe the same exact tmpfs semantics.

### Task 9: Extend the Packed Public CLI E2E Lifecycle

Update `tests/e2e/ploinkyBox/publicCli.test.mjs` so its final lifecycle exercises stopped reuse before cleanup.

After the packed public CLI has started and validated the graph:

```text
capture the running outer container ID
run public `ploinky stop`
assert the same Box exists and is stopped
run the same public graph-start command again
assert success
inspect and require the same outer container ID
assert current Box and graph health
then run the existing final stop/destroy cleanup
```

The proxy trace must prove the restart path did not pull, create, or remove the outer container. Existing immutable-reference and secret-boundary assertions remain mandatory.

Run with the same immutable candidate variables:

```sh
PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<immutable-digest> \
node --test tests/e2e/ploinkyBox/publicCli.test.mjs
```

This packed CLI test is not the cross-repository Explorer Playwright gate. Do not recreate `~/work/testExplorerFresh` unless separately authorized.

### Task 10: Update Active Documentation and Static Assertions

Update only current code-derived documentation:

| File | Required change |
|---|---|
| `README.md` | Replace “exactly four mounts” with “four durable binds and one transient `/tmp` tmpfs.” Explain that transient runtime metadata does not survive outer stop/start. |
| `container/README.md` | Add the exact tmpfs to the current Box configuration and stopped-reuse description. |
| `docs/code-derived-agent-lifecycle.md` | Describe the five-part storage boundary and keep the survival table aligned with executable behavior. |
| `tests/unit/runtimeDocumentation.test.mjs` | Assert active documents distinguish four durable binds from the transient tmpfs and do not claim runroot persistence across stop. |
| `tests/unit/runtimeSourceAbsence.test.mjs` | Preserve the prohibition on versioned ready markers and contract-version strings. Add only a targeted absence assertion if production code introduces a tempting legacy/migration term. |

Do not update generated HTML, prior plans, or `docs/specs/**` to make tests pass. If active documentation tests currently read a code-derived Markdown file, update that active Markdown file only.

Run an audit before finishing:

```sh
rg -n "exactly four mounts|four mounts|storage-run-1000|PLOINKY_BOX_READY|--tmpfs|HostConfig\\.Tmpfs" \
  README.md container/README.md docs/code-derived-agent-lifecycle.md \
  ploinky-box tests/unit tests/integration tests/e2e/ploinkyBox
```

Classify every hit as current implementation, current test, active documentation, or historical material. Do not mechanically rewrite historical records.

### Task 11: Run Focused and Full Verification

Run the focused tests first:

```sh
node --test \
  tests/unit/ploinkyBoxTransactions.test.mjs \
  tests/unit/ploinkyBoxEntrypoint.test.mjs \
  tests/unit/ploinkyBoxSupervisor.test.mjs \
  tests/unit/ploinkyBoxSafetyMatrix.test.mjs \
  tests/unit/ploinkyBoxDiscovery.test.mjs \
  tests/unit/runtimeDocumentation.test.mjs \
  tests/unit/runtimeSourceAbsence.test.mjs
```

Then run the complete unit suite:

```sh
node --test tests/unit/*.test.mjs
```

Then run the immutable candidate gates from Tasks 8 and 9 on macOS Podman Machine and native Linux.

Do not use a green unit suite to waive the native restart test. The original bug depends on real outer-container writable-layer ownership, tmpfs lifecycle, cumulative Podman logs, and stop/start semantics that mocks cannot prove.

Run final static checks:

```sh
git diff --check
git status --short --branch
```

Inspect the final diff and confirm that only intended source, tests, and active documentation changed.

## 10. Hard-Cut Rollout Plan

There is no compatibility phase.

Before installing or checking out the hard-cut runtime in a workspace, destroy its existing outer Box with the currently installed runtime:

```text
ploinky stop
ploinky destroy
```

Then install or select the changed Ploinky source and recreate normally:

```text
ploinky start <agent-or-graph>
```

For the reported Explorer workspace, the eventual separately authorized acceptance sequence is:

```text
cd ~/work/testExplorerFresh
ploinky destroy
ploinky start explorer
ploinky stop
ploinky start explorer
```

Required rollout rules:

| Rule | Required behavior |
|---|---|
| Existing outer containers | Destroy before upgrade; do not teach the new runtime to adopt them. |
| Workspace files | Retain. |
| `.ploinky/box/dependencies` and `.ploinky/box/images` | Retain under ordinary destroy. |
| Old outer writable-layer state | Discard with the destroyed outer container. |
| Automatic replacement | Do not add it. |
| Automatic migration | Do not add it. |
| Fallback to the old mount contract | Forbidden. |
| Failed native candidate | Block release; do not omit the tmpfs or weaken readiness to proceed. |

If an operator upgrades without destroying an old Box first, the exact contract may report it as incompatible. That is acceptable for this hard cut. Recovery is destruction and recreation, not compatibility code.

## 11. Acceptance Matrix

| ID | Scenario | Required proof |
|---|---|---|
| A1 | New Box creation | Four exact durable binds, one exact `/tmp` tmpfs, zero named outer volumes |
| A2 | Normal first boot | Current boot emits the exact ready marker while inspection proves running |
| A3 | Stop/start reuse | Same immutable outer ID before and after restart; no pull, create, removal, or replacement |
| A4 | Tmpfs lifecycle | A pre-stop `/tmp` canary is absent after restart |
| A5 | Inner Podman restart | `podman info` succeeds after restart and reports runroot `/tmp/storage-run-1000` |
| A6 | Historical ready marker | Old marker alone never satisfies a new wait |
| A7 | Current boot failure | Fresh `EACCES` or device self-check failure is returned directly |
| A8 | Ready plus exited | Readiness rejects the attempt |
| A9 | Final state race | Final rediscovery as stopped rejects reconciliation before dependency installation |
| A10 | Log history drift | Prefix mismatch fails closed |
| A11 | Public CLI | Packed `ploinky stop` followed by the same start command succeeds on the same Box ID |
| A12 | Security | No privilege, publication, device, userns, credential, or durable-bind regression |
| A13 | Platforms | Native candidate passes on macOS Podman Machine and native Linux |
| A14 | Hard cut | No migration classifier, dual contract, legacy option path, or automatic adoption added |

## 12. Failure Handling

| Failure | Required response |
|---|---|
| Podman rejects the proposed tmpfs options | Capture the exact supported semantics on both platforms. Adjust only syntax or canonicalization while preserving the required semantic flags. |
| Podman exposes tmpfs differently in `Mounts` | Normalize the two proven current representations. Do not accept arbitrary missing tmpfs state. |
| `/tmp` `exec` behavior differs | Block and investigate. Do not silently accept `noexec` unless a separate explicit design decision changes the contract. |
| Native runroot still persists | Preserve inspection/log evidence and block release. Do not introduce root cleanup or broaden entrypoint deletion. |
| Fresh ready appears before terminal exit | Keep the state-before-success rule; report the terminal current-boot logs. |
| Log driver truncates history | Fail closed with a clear diagnostic. Do not reset the baseline and risk accepting an old marker. |
| Unit tests pass but native restart fails | Treat the native result as authoritative for runtime lifecycle. Fix the implementation rather than weakening the test. |
| Explorer deployment is requested later | Follow the repository's explicit fresh-fixture and Playwright gate instructions for that separate task. |

## 13. Unknown / Not Yet Verified

The following items must be resolved during implementation and cannot be claimed complete from unit tests alone:

| Unknown | Verification |
|---|---|
| Exact `HostConfig.Tmpfs` option string emitted by Podman | Capture raw inspect on macOS Podman Machine and native Linux. |
| Whether tmpfs appears in `record.Mounts` on both hosts | Capture and compare raw inspect records. |
| Exact option ordering and normalization | Prove with the current supported Podman versions, then encode semantic comparison. |
| Whether the candidate image has any required image-layer `/tmp` content | Prove the Box starts with `notmpcopyup`; no content is expected to be required. |
| Real same-ID stop/start behavior with a materialized rootless runroot | Prove with the native regression test. |
| Packed public CLI restart behavior | Prove with the public CLI E2E candidate gate. |

## 14. Next Checks

The implementation session should begin with these checks, in order:

| Order | Check | Output to retain |
|---|---|---|
| 1 | Worktree and focused unit baseline | Branch, dirty paths, pass/fail summary |
| 2 | Disposable tmpfs inspection on macOS Podman Machine | Raw `CreateCommand`, `HostConfig.Tmpfs`, and `Mounts` |
| 3 | Equivalent native Linux inspection | Raw fields and any semantic difference |
| 4 | Write failing exact-create and tmpfs-contract unit tests | Focused red test output |
| 5 | Write failing stale-ready/current-EACCES readiness test | Focused red test output proving the original defect |
| 6 | Implement constants, create rendering, contract normalization, and validation | Focused green storage-contract tests |
| 7 | Implement log baseline and central start/wait helper | Focused green readiness and transaction tests |
| 8 | Add native and public CLI stop/start regressions | Same-ID, canary removal, and health evidence |
| 9 | Update active documentation and run all verification | Final unit/native/E2E summaries and clean diff check |

Implementation is complete only when every acceptance item is proven and the exact original failure chain is impossible: stale runroot state cannot survive a stop/start, and stale readiness output cannot authorize dependency execution.
