# Ploinky Box Storage Separation Implementation Plan

Date: 2026-08-07

Audience: Claude Code implementing the change across `ploinky` and `container-image-builds`

Status: Ready for implementation

## 1. Outcome

Change the Ploinky Box storage contract so that only reusable nested Podman images persist across outer Box replacement. Nested container records, writable layers, networks, and inner Podman named volumes must belong to one outer Box and disappear when that Box is destroyed.

The completed change must make this sequence reliable:

```text
ploinky start explorer
ploinky stop
ploinky destroy
ploinky start explorer
```

The second `start` must not encounter retained managed nested containers. The host workspace, pinned dependency cache, and nested image cache must survive. Inner containers and inner named volumes must not survive.

This is a storage-contract migration, not a cleanup workaround. Do not automatically remove ambiguous Podman state or silently reuse the old mixed storage volume.

## 2. Why the Current Design Fails

The current outer named volume `${instance}-containers` is mounted at `/home/podman/.local/share/containers`. That directory is the parent of the inner rootless Podman graphroot. It contains both reusable image content and Box-generation-specific runtime content.

When `ploinky destroy` removes the outer Box but retains named volumes, the next Box mounts the same inner Podman store. Podman therefore still knows about containers created by the previous Box. The startup self-check correctly rejects those retained Ploinky-managed containers because their lifecycle ownership belongs to the previous Box generation.

The failure is not caused by the workspace bind or the dependency volume. It is caused by persisting the entire inner Podman store when only the image cache is intended to persist.

## 3. Required Invariants

| Area | Required behavior |
|---|---|
| Privilege | Preserve the rootless, unprivileged nested Podman runtime. |
| Ownership | Preserve exact workspace identity, exact resource labels, and fail-closed discovery. |
| Lifecycle | The host continues to own the outer Box; the in-Box runtime continues to own nested agents. |
| Identity | Keep versionless semantic Box identity. Do not add generation numbers or schema versions to volume names. |
| Workspace | Never delete the host workspace as part of storage migration or cache cleanup. |
| Persistence | Persist only the host workspace, dependency cache, and image cache. |
| Disposal | Dispose of inner container metadata, writable layers, networks, named volumes, and transient runtime metadata with the outer Box. |
| Safety | Do not import, mount, convert, or automatically delete the old mixed `-containers` volume. |
| Scope | Do not change the legacy `container/` runtime path unless an active failing test proves it is still on the public Box call path. |
| Deployment | Do not deploy Explorer, run Playwright, publish an image, promote a digest, or push a release without explicit approval. |

## 4. Target Storage and Mount Contract

The new outer Box still has exactly four mounts.

| Mount | Host-side source | Box target | Mode | Lifetime and purpose |
|---|---|---|---|---|
| Ploinky source | Source bind | `/opt/ploinky` | Read-only | Supplies the selected Ploinky implementation. |
| Workspace | Workspace bind | `/workspace` | Read-write | Durable user and agent data. |
| Nested image cache | Named volume `${instance}-images` | `/home/podman/.local/share/ploinky-images` | Read-write | Durable downloaded image content only. |
| Dependencies | Named volume `${instance}-dependencies` | `/opt/ploinky/node_modules` | Read-write | Durable pinned Node dependency cache. |

The following paths are deliberately not mounts:

| Path | Location | Lifetime |
|---|---|---|
| `/home/podman/.local/share/containers/storage` | Outer Box writable layer | Discarded when the outer Box is removed. |
| `/tmp/storage-run-1000` | Outer Box temporary filesystem | Reset on every Box startup. |
| `/home/podman/.local/share/containers/storage/volumes` | Under the ephemeral graphroot | Inner named volumes are discarded with the outer Box. |
| Container writable layers and metadata | Under the ephemeral graphroot and runroot | Discarded with the outer Box. |

Persistent agent data must continue to use explicit `/workspace` bind mounts. The nested launcher already uses `--image-volume=ignore` and explicit code, shared-data, current-directory, and home binds; preserve that behavior.

## 5. Inner Podman Storage Configuration

Create `/home/podman/.config/containers/storage.conf` at Box startup before the first inner Podman invocation. Use this exact intended configuration:

```toml
[storage]
driver = "overlay"
graphroot = "/home/podman/.local/share/containers/storage"
runroot = "/tmp/storage-run-1000"
imagestore = "/home/podman/.local/share/ploinky-images"
transient_store = true

[storage.options.overlay]
mount_program = "/usr/bin/fuse-overlayfs"
```

The runtime writer must create the file atomically with mode `0600`, reject symlink or non-regular-file targets, and preserve the existing private-file safety model. Keep this writer independent from the atomic `box-transport.json` and `containers.conf` pair; storage configuration is not part of transport rollback.

After writing the file, query `podman info --format json` and validate at least the following effective properties against the pinned Podman version:

| Property | Expected value |
|---|---|
| Configuration file | `/home/podman/.config/containers/storage.conf` |
| Graph driver | `overlay` |
| Graphroot | `/home/podman/.local/share/containers/storage` |
| Runroot | `/tmp/storage-run-1000` |
| Transient store | `true` |
| Volume path | A path under the ephemeral graphroot, not under the image cache |
| Overlay imagestore | `/home/podman/.local/share/ploinky-images` |

Do not guess the exact JSON field containing the effective imagestore. Capture real output from the pinned Podman 5.8.2 candidate, add a representative fixture, and make the parser fail closed if the effective value cannot be proven.

Relevant upstream contracts are the [Podman `--imagestore` documentation](https://docs.podman.io/en/v5.4.0/markdown/podman.1.html#imagestore-path), the [Podman transient-store documentation](https://docs.podman.io/en/v5.4.0/markdown/podman.1.html#transient-store), and the [containers/storage `storage.conf` reference](https://github.com/containers/storage/blob/main/docs/containers-storage.conf.5.md).

## 6. Legacy Storage Migration Contract

This must be a fail-closed, explicit migration. The old `${instance}-containers` volume combines safe image cache data with unsafe generation-bound state, so the implementation must not attempt an in-place split.

Introduce a pure storage-layout classifier. `legacy-workspace` is an independently recognized historical resource and does not affect the active cache-layout classification.

| Exact owned volumes observed | Layout | Behavior |
|---|---|---|
| Neither active volume and no old `containers` volume | `empty` | `start` may create `images` and `dependencies`. |
| `images` and `dependencies`, with no old `containers` volume | `current` | Normal current lifecycle. |
| Old `containers` and `dependencies`, with no `images` volume | `legacy-storage` | `status`, `stop`, and `destroy` work; `start` is blocked with migration guidance. |
| Any partial or mixed combination | `incompatible` | Fail closed. Permit explicit cleanup only when every target has exact Ploinky ownership and no conflicting resource exists. |

For `legacy-storage`, `status` must report `migration-required` and show this recovery sequence:

```text
1. Back up any manually created inner Podman named-volume data if it is needed.
2. ploinky stop
3. ploinky destroy --delete-volumes
4. Run ploinky start again.
```

The `start` guard must run before image pulls, preflight checks, volume creation, or any other host mutation. A rejected legacy start must have no side effects.

`destroy` without `--delete-volumes` must retain named volumes and clearly explain that a legacy layout will remain migration-required. `destroy --delete-volumes` must delete exactly owned current and legacy Ploinky volumes, including the old mixed store and historical legacy workspace volume, but never the host workspace bind.

## 7. Implementation Sequence

### Task 0: Establish the Baseline

Work from clean trees and record the existing unit/static results before editing. Do not run the orchestration-wide `tests/run-all.sh` command.

```sh
cd /Users/danielsava/work/file-parser/ploinky
git status --short --branch
node --test tests/unit/*.test.mjs

cd /Users/danielsava/work/file-parser/container-image-builds
git status --short --branch
node --test tests/image-definitions.test.mjs
```

If a baseline test is already failing, record it separately and do not conceal it with the storage change.

### Task 1: Add Storage Layout Identity and Classification

Write the storage-layout tests first, then change the identity model.

| File | Required change |
|---|---|
| `tests/unit/ploinkyBoxStorageLayout.test.mjs` | Add a pure truth-table test for `empty`, `current`, `legacy-storage`, partial, mixed, unexpected, and independently present legacy-workspace cases. |
| `ploinky-box/storage-layout.mjs` | Add the pure classifier and stable migration diagnostic. Keep it independent of Podman calls. |
| `ploinky-box/constants.mjs` | Add the current `images` role, move `containers` to a legacy role, set `BOX_VOLUME_KEYS` to `['images', 'dependencies']`, and expose legacy keys separately. |
| `ploinky-box/identity.mjs` | Expose `volumes.images` and `volumes.dependencies`; expose old `containers` and historical `workspace` under `legacyVolumes`. |
| `tests/unit/ploinkyBoxIdentity.test.mjs` | Assert exact current and legacy names, labels, and versionless semantic identity. |
| `ploinky-box/engine/discovery.mjs` | Discover current and legacy resources, attach `storageLayout`, continue rejecting label conflicts and unexpected owned resources, and avoid treating a recognized legacy layout as foreign ownership. |
| `tests/unit/ploinkyBoxDiscovery.test.mjs` | Cover exact current, exact legacy, partial, mixed, conflicts, and unexpected labeled resources. |

Use `images` consistently as the role/key/name suffix. Do not introduce `v2`, generation identifiers, or numeric storage schema names.

### Task 2: Replace the Broad Store Mount With the Image Cache Mount

Change all current mount construction and validation to use the new image volume.

| File | Required change |
|---|---|
| `ploinky-box/volumes.mjs` | Create, label, validate, roll back, and remove the `images` and `dependencies` active set. Retain explicit helpers for exactly owned legacy cleanup. |
| `ploinky-box/contract/container.mjs` | Replace the old broad-store mount with `${instance}-images` at `/home/podman/.local/share/ploinky-images`; keep the exact four-mount contract. |
| `ploinky-box/lifecycle/container.mjs` | Revalidate current volume ownership before container creation and destructive operations. Ensure `container rm -f --volumes` does not imply deletion of host named volumes. |
| `tests/unit/ploinkyBoxVolumes.test.mjs` | Update creation, validation, rollback, deletion, label-conflict, and partial-set expectations. |
| `tests/unit/ploinkyBoxTransactions.test.mjs` | Update exact create arguments and add a legacy-start rejection test proving no pull, preflight, creation, stop, or removal call occurs. |
| `tests/unit/ploinkyBoxNativeCleanup.test.mjs` | Cover cleanup of current volumes, recognized legacy volumes, and exact-owned incomplete layouts without broad deletion. |
| `cli/sandbox/docker/agentServiceManager.js` and `tests/unit/managedContainerLabels.test.mjs` | Preserve the existing Podman `--image-volume=ignore` and workspace-bind contract. No production change is expected; retain or strengthen the test as evidence that durable agent data does not move into inner named volumes. |

Search for every production reference to `nestedStore`, the old target `/home/podman/.local/share/containers`, the `containers` volume key, and wording such as “two named storage volumes.” Classify each hit as current runtime, current test, active documentation, or historical material before changing it.

### Task 3: Configure and Validate the Ephemeral Inner Store

Add a focused storage module rather than expanding transport configuration.

| File | Required change |
|---|---|
| `ploinky-box/entrypoint/storage.mjs` | Render and atomically write the exact `storage.conf`; validate target safety; parse and validate effective `podman info --format json` storage settings. |
| `ploinky-box/entrypoint/entrypoint.mjs` | Rename `nestedStore` to `imageStore`; add `storageConf`, `graphRoot`, `storageRunRoot`, and any validated inner-volume path; validate mounts; reset runtime; write storage configuration; validate Podman storage before any other Podman query. |
| `ploinky-box/entrypoint/transport.mjs` | Keep the existing transport pair behavior. Change only what is necessary to respect the new preparation order. |
| `ploinky-box/entrypoint/ploinky-box-entrypoint` | Preserve rootless/device/network checks. Keep the final retained-managed-container rejection as a defense, but update its diagnostic to say that retained records indicate storage isolation failed unexpectedly. |
| `tests/unit/ploinkyBoxEntrypoint.test.mjs` | Replace broad-store canaries with image-cache and ephemeral-root assertions; add exact TOML, mode `0600`, symlink, non-regular target, atomic failure, call ordering, valid Podman-info, and every mismatch case. |

Use this preparation order:

```text
verify marker and required mounts
reset the transient runroot
write storage.conf
validate effective Podman storage
initialize the workspace key
configure transport
retire retained managed containers defensively
install pinned dependencies
return preparation result
```

The first command that can initialize or query inner Podman storage must occur only after `storage.conf` exists. The image-cache mount and private graphroot must be real writable directories, not symlinks. The volume path reported by Podman must remain under the ephemeral graphroot.

Keep `retireStoppedManagedContainers()` as a narrow defense with its existing exact ownership checks. Under the new contract it should normally observe no retained containers; do not broaden it into a generic Podman cleanup operation.

### Task 4: Make Destroy Graceful and Migration-Aware

Fix the lifecycle path that originally allowed a running outer Box to be removed without first stopping nested agents.

| File | Required change |
|---|---|
| `ploinky-box/lifecycle/transactions.mjs` | Reject legacy/incompatible starts before mutation. Preserve current replacement rollback behavior. |
| `ploinky-box/supervisor.mjs` | Report `migration-required`; keep legacy `stop` and `destroy` available; make running destroy invoke the in-Box `ploinky-local stop` before outer removal. |
| `ploinky-box/bin/ploinky-box.mjs` | Make delete-volume detection include recognized current and legacy volumes; update status, help, confirmation, and recovery output. |
| `tests/unit/ploinkyBoxSupervisor.test.mjs` | Add current and legacy status cases, idempotent stop, graceful destroy ordering, inner-stop failure, outer-stop failure, and explicit current/legacy volume deletion. |
| `tests/unit/ploinkyBoxCli.test.mjs` | Verify exact migration guidance, no-side-effect start refusal, confirmation wording, and `destroy --delete-volumes` when only legacy volumes remain. |
| `tests/unit/ploinkyBoxSafetyMatrix.test.mjs` | Extend the safety matrix with current, legacy, partial, mixed, stop-failure, and exact-owned cleanup outcomes. Preserve fail-closed behavior for ambiguous ownership. |

For a running outer Box, use this failure-safe destroy order:

```text
run /opt/ploinky/bin/ploinky-local stop inside the Box
stop the outer Box
revalidate exact ownership
remove the outer Box
optionally remove exactly owned named volumes
```

If the inner stop fails, still stop the outer Box to prevent further mutation, then fail the transaction. Leave the stopped outer Box and all named volumes intact for inspection and retry. Do not remove the Box and do not delete volumes after an inner-stop failure.

If the outer Box is already stopped, removal may proceed after exact ownership revalidation. With the new layout, removing it discards all generation-specific nested state.

### Task 5: Update the Box Image Definition

Implement the image-side prerequisites in the sibling repository after the Ploinky runtime contract is in place.

| File | Required change |
|---|---|
| `/Users/danielsava/work/file-parser/container-image-builds/images/ploinky-box/Dockerfile` | Remove any inherited `/home/podman/.config/containers/storage.conf`; create and chown `/home/podman/.local/share/ploinky-images`; keep the private graphroot path writable by `podman`; preserve the rootless tool and device contract. |
| `/Users/danielsava/work/file-parser/container-image-builds/tests/image-definitions.test.mjs` | Assert inherited storage config removal, image-cache directory setup, graphroot setup, ownership, and continued use of the canonical Ploinky entrypoint source. |
| `/Users/danielsava/work/file-parser/container-image-builds/README.md` | Document the image cache as persistent and the graphroot/runroot as disposable. |

Do not add a second local entrypoint implementation to `container-image-builds`. The image build must continue copying the canonical entrypoint from an exact Ploinky source commit.

### Task 6: Update Active Help, Documentation, and Boundary Declarations

Update only current, code-derived documentation. Historical specifications, prior plans, and generated HTML are background evidence and must not be rewritten as behavior work.

| File | Required change |
|---|---|
| `README.md` | Replace the mixed-store explanation with the target persistence table and migration command. |
| `container/README.md` | Align current runtime documentation without reviving the legacy runtime implementation. |
| `docs/code-derived-agent-lifecycle.md` | Explain which state survives stop, destroy, and recreate. |
| `cli/commands/help.js` | Replace “two named storage volumes” and nested-container-storage wording with dependency cache, image cache, and legacy migration behavior. |
| `ploinky-box/bin/ploinky-box.mjs` | Keep public Box help consistent with CLI help and confirmation text. |
| `ploinky-box/boundary/ploinky-allowlist.json` | Add only active files that the Box change legitimately touches. Do not broadly relax the boundary. |
| `tests/unit/helpLayers.test.mjs` | Assert the new public wording. |
| `tests/unit/runtimeDocumentation.test.mjs` | Assert the persistence/disposal and migration contract in active docs. |

Do not edit `docs/*.html`, `docs/superpowers/specs/*`, or historical plans. Do not add retired numeric runtime/schema terminology that violates source-absence tests.

### Task 7: Update Native and Public Lifecycle Tests

Reverse the old assertion that an inner named volume survives outer Box destruction. The new tests must distinguish intended caches from generation-specific state.

| File | Required change |
|---|---|
| `tests/integration/ploinkyBoxNative.test.mjs` | Verify workspace and dependency canaries survive; the nested image remains inspectable after recreate; the old inner container ID and inner named volume are absent; effective graphroot, runroot, imagestore, volume path, and transient-store values are exact. |
| `tests/e2e/ploinkyBox/publicCli.test.mjs` | Exercise the same contract through the public CLI, including direct destroy of a running Box followed by successful recreate. |
| `tests/e2e/ploinkyBox/nativeHelpers.mjs` | Update exact current/legacy cleanup helpers and fixtures. |

Change any state hash that currently includes the whole `/home/podman/.local/share/containers` tree. Hash only intended persistent roots, or replace the broad hash with direct assertions for the workspace, dependency cache, and image cache.

The lifecycle proof must cover both of these cases:

| Case | Required result |
|---|---|
| Stop then start the same outer Box | Startup succeeds; transient runtime metadata is fresh; intended caches remain. |
| Destroy then recreate the outer Box | Startup succeeds; intended caches remain; old nested container and inner-volume state is absent. |

## 8. Verification Commands

Run focused unit/static checks during implementation:

```sh
cd /Users/danielsava/work/file-parser/ploinky
node --test \
  tests/unit/ploinkyBoxIdentity.test.mjs \
  tests/unit/ploinkyBoxStorageLayout.test.mjs \
  tests/unit/ploinkyBoxVolumes.test.mjs \
  tests/unit/ploinkyBoxDiscovery.test.mjs \
  tests/unit/ploinkyBoxEntrypoint.test.mjs \
  tests/unit/ploinkyBoxTransactions.test.mjs \
  tests/unit/ploinkyBoxSupervisor.test.mjs \
  tests/unit/ploinkyBoxSafetyMatrix.test.mjs \
  tests/unit/ploinkyBoxCli.test.mjs \
  tests/unit/ploinkyBoxNativeCleanup.test.mjs \
  tests/unit/managedContainerLabels.test.mjs \
  tests/unit/helpLayers.test.mjs \
  tests/unit/runtimeDocumentation.test.mjs

node --test tests/unit/*.test.mjs

cd /Users/danielsava/work/file-parser/container-image-builds
node --test tests/image-definitions.test.mjs
```

Run formatting and diff hygiene in both repositories:

```sh
git -C /Users/danielsava/work/file-parser/ploinky diff --check
git -C /Users/danielsava/work/file-parser/container-image-builds diff --check
```

The native candidate gates require a built candidate digest and rootless Podman. Do not run them until the user explicitly approves that environment-level test:

```sh
cd /Users/danielsava/work/file-parser/ploinky
PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<digest> \
node --test tests/integration/ploinkyBoxNative.test.mjs

PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<digest> \
node --test tests/e2e/ploinkyBox/publicCli.test.mjs
```

Do not use `./tests/run-all.sh` as a shortcut. It is the full orchestration suite and exceeds the scope of a local implementation check.

## 9. Release and Rollback Sequence

| Phase | Gate |
|---|---|
| Implement | Both repositories pass focused and full local unit/static checks. |
| Build candidate | Build the Box image from the exact Ploinky source commit containing the new runtime contract. |
| Validate candidate | Run the native and public CLI candidate tests against an immutable digest. Capture real Podman 5.8.2 storage-info evidence. |
| Promote | Promote the tested digest only after explicit approval. Do not automatically deploy Explorer. |
| Observe | Confirm a real stop/destroy/recreate cycle preserves images and caches but not inner runtime state. |

A downgrade to the old CLI after the new `-images` volume exists may fail closed because the old discovery code does not recognize that resource. The rollback runbook is therefore explicit: retain access to the new CLI, use it to stop and run `destroy --delete-volumes`, verify the host workspace remains, then restore the old CLI/image and recreate caches. Do not automate this destructive rollback.

## 10. Acceptance Criteria

| Criterion | Evidence |
|---|---|
| Exactly four outer mounts | Container contract unit test and native inspection. |
| No broad Podman store volume | No current volume targets `/home/podman/.local/share/containers`. |
| Images persist | Image ID remains inspectable after outer Box destroy/recreate. |
| Dependencies persist | Dependency canary survives outer Box destroy/recreate. |
| Workspace persists | Workspace canary survives and no destroy path removes the host bind. |
| Inner state is disposable | Old nested container ID and inner named volume are absent after recreate. |
| Second run succeeds | Public CLI and native lifecycle tests reach `PLOINKY_BOX_READY` after recreate. |
| Legacy storage is safe | Legacy `start` is side-effect-free and returns exact migration guidance. |
| Cleanup is explicit | Only `destroy --delete-volumes` removes exactly owned cache/legacy volumes. |
| Destroy is graceful | In-Box stop precedes outer removal; failures leave a stopped, inspectable Box and retained volumes. |
| Podman uses intended paths | Effective `podman info` values prove ephemeral graphroot/runroot/volumes and persistent imagestore. |
| Rootless contract remains | Existing UID/GID, subordinate-ID, fuse-overlayfs, device, network, and capability checks pass. |
| Boundaries remain narrow | Boundary and source-absence tests pass without generated/historical doc edits. |

## 11. Evidence Classification and Open Checks

### Observed

| Evidence | Conclusion |
|---|---|
| `${instance}-containers` is mounted at `/home/podman/.local/share/containers`. | The complete inner Podman graphroot currently persists. |
| Startup rejects any retained container labeled `io.assistos.ploinky.managed=1`. | Old nested container records directly produce the reported second-run failure. |
| `ploinky destroy` currently removes the outer Box without first invoking the inner stop path. | Running nested-agent state can be left in the retained store. |
| The nested launcher uses workspace binds and `--image-volume=ignore`. | Agent data does not require persistent inner Podman named volumes. |
| Native and public tests currently require an inner named-volume canary to survive recreate. | Tests encode the mixed-store behavior and must be intentionally reversed. |

### Inferred

| Inference | Basis |
|---|---|
| A separate Podman imagestore is the narrow reusable cache boundary. | Podman documents imagestore as image storage distinct from graphroot. |
| An ephemeral graphroot plus transient store removes generation-bound records from the next Box. | Graphroot remains in the removed outer writable layer, while transient metadata uses the reset runroot. |
| Automatic migration of the old store is unsafe. | The old volume contains both reusable and generation-bound data with no trustworthy separation contract. |

### Unknown Until Candidate Validation

| Unknown | Required check |
|---|---|
| Exact `podman info --format json` field for the effective imagestore in pinned Podman 5.8.2 | Capture candidate output, add a fixture, and validate the proven field. |
| Image lookup behavior after repeated transient-store resets | Pull/inspect an image, stop/start and destroy/recreate, then confirm no re-pull is required and the same immutable image is usable. |
| Disk reclamation behavior during many stop/start cycles of one outer Box | Inspect graphroot size; confirm outer destroy reclaims it. Add documentation only if operationally material. |

### Next Checks Before Merge

| Check | Pass condition |
|---|---|
| Search for old mount/name references | Every active production/test/doc reference is updated or explicitly justified as legacy/historical. |
| Fault injection | Storage write, Podman-info mismatch, inner stop, outer stop, remove, and volume-delete failures all fail closed with recoverable state. |
| Candidate lifecycle | Both native and public CLI tests pass against one immutable candidate digest. |
| Manual migration rehearsal | An exactly labeled old layout reports `migration-required`, rejects start without mutation, and is recoverable with the documented explicit delete command. |
