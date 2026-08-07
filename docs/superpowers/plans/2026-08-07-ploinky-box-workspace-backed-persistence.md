# Ploinky Box Workspace-Backed Persistence Implementation Plan

Date: 2026-08-07

Audience: A new Claude Code session implementing the change in the `ploinky` repository

Status: Ready for implementation

## 1. Start Here

Before editing anything:

1. Read `AGENTS.md` and the complete `CLAUDE.md` in the repository root.
2. Inspect the current implementation and tests named in this plan. Code and tests are the source of truth if this plan has drifted.
3. Work in the existing repository and preserve unrelated user changes. Do not reset, revert, or clean a dirty worktree.
4. Establish a focused test baseline before editing.
5. Implement this as a hard cut. Do not add migration, compatibility, adoption, or automatic cleanup for old named volumes.

The user-approved requirement is:

> Remove Ploinky Box's persistent named volumes entirely. Every payload that previously persisted in an outer named volume must instead persist under the workspace's `.ploinky` directory. Backward compatibility and migration are not required.

This plan uses “outer named volume” to mean volumes created and managed by the host-side Ploinky Box supervisor. Nested agents may still use inner Podman named volumes, but those remain generation-local under the disposable inner graphroot and must not survive destruction of the outer Box.

## 2. Required Outcome

The completed implementation must persist the former dependency-volume and image-volume payloads here:

```text
<workspace>/.ploinky/box/
├── dependencies/
└── images/
```

The outer Box must use these exact bind mounts:

| Host source | Box destination | Mode | Purpose |
|---|---|---|---|
| `<workspace>/.ploinky/box/dependencies` | `/opt/ploinky/node_modules` | Read-write | Pinned Box dependencies |
| `<workspace>/.ploinky/box/images` | `/home/podman/.local/share/ploinky-images` | Read-write | Reusable inner Podman image content |

The existing mounts remain:

| Host source | Box destination | Mode |
|---|---|---|
| Ploinky repository root | `/opt/ploinky` | Read-only |
| Canonical workspace root | `/workspace` | Read-write |

The resulting outer container still has exactly four mounts, but all four are bind mounts. It has zero named or anonymous persistent mounts.

The inner Podman graphroot must remain on the outer Box writable layer:

```text
/home/podman/.local/share/containers/storage
```

Do not move the graphroot, inner container records, inner writable layers, inner networks, or inner named volumes into `.ploinky`. They remain disposable with the outer Box.

## 3. Non-Negotiable Decisions

1. Use `.ploinky/box/dependencies` and `.ploinky/box/images` as the canonical host paths.
2. Preserve the existing in-container dependency and imagestore paths. Do not change Node resolution or the runtime's internal path contract.
3. Do not create, inspect, list, mount, label, revalidate, remove, or otherwise manage outer named volumes anywhere in the Ploinky Box production path.
4. Remove old volume names and handles from workspace identity.
5. Ignore old named volumes. Do not migrate their data, adopt them, copy from them, or automatically delete them.
6. Keep versionless path-derived Box identity and the existing outer container ownership labels.
7. Keep the outer Box rootless, unprivileged, and mounted with read-only Ploinky source.
8. Keep the current inner Podman `storage.conf` separation: disposable graphroot and runroot, workspace-backed imagestore.
9. Default `destroy` retains `.ploinky/box`.
10. Replace the obsolete `destroy --delete-volumes` interface with `destroy --delete-cache`; the old flag is rejected.
11. `destroy --delete-cache` removes only `.ploinky/box/images` and `.ploinky/box/dependencies` after the outer Box is stopped and removed. It never deletes the workspace, `.ploinky/master-key`, repositories, agents, routing state, secrets, or other `.ploinky` data.
12. Do not weaken the native Linux or macOS Podman Machine acceptance criteria if the direct host-backed imagestore exposes a filesystem problem. Fix the implementation without reintroducing named volumes, or report a genuine blocker.

## 4. Current Implementation Map

The current design is spread across these boundaries:

| Area | Current files | Current responsibility |
|---|---|---|
| Identity | `ploinky-box/constants.mjs`, `ploinky-box/identity.mjs` | Defines the two volume roles, names, and workspace identity |
| Volume ownership | `ploinky-box/volumes.mjs` | Creates, labels, mounts, revalidates, rolls back, and removes named volumes |
| Outer create/remove | `ploinky-box/lifecycle/container.mjs` | Renders mount arguments and revalidates volumes before mutation |
| Transaction flow | `ploinky-box/lifecycle/transactions.mjs` | Prepares volumes, uses handles during create/replacement, and rolls back newly created volumes |
| Runtime contract | `ploinky-box/contract/container.mjs` | Requires two binds plus two named-volume mounts |
| Discovery | `ploinky-box/engine/discovery.mjs` | Inventories container and volume ownership across supported engines |
| Supervisor | `ploinky-box/supervisor.mjs` | Implements retained-volume states and destructive volume cleanup |
| Public CLI | `ploinky-box/command/route.mjs`, `ploinky-box/bin/ploinky-box.mjs`, `cli/commands/help.js` | Exposes and documents `destroy --delete-volumes` |
| Entrypoint | `ploinky-box/entrypoint/entrypoint.mjs`, `ploinky-box/entrypoint/storage.mjs`, `ploinky-box/entrypoint/install-dependencies.mjs` | Validates the mounted paths and configures the inner imagestore |
| Tests | `tests/unit/ploinkyBox*.test.mjs`, `tests/integration/ploinkyBox*.test.mjs`, `tests/e2e/ploinkyBox/**` | Encode exact mount, ownership, rollback, persistence, and cleanup behavior |

Important current facts to preserve:

- `/opt/ploinky` is read-only, so dependencies must still be mounted over `/opt/ploinky/node_modules`.
- The inner storage configuration already points `imagestore` at `/home/podman/.local/share/ploinky-images` and keeps the graphroot elsewhere.
- The Box dependency installer already installs and repairs the exact pinned dependencies transactionally.
- Inner Podman named volumes must remain under the disposable graphroot, never under the image store.
- `.gitignore` already ignores `.ploinky/*`; no new repository ignore rule should be necessary.

## 5. Target Runtime Flow

The desired create/reuse flow is:

```text
resolve canonical workspace identity
discover the outer container only
acquire the workspace mutation lock
re-resolve and verify workspace identity
materialize the .ploinky anchor
run engine/publication preflight
pull and validate the Box image when creation or replacement requires it
create/validate .ploinky/box/dependencies and .ploinky/box/images
create the outer Box with four exact bind mounts
start the Box and wait for readiness
validate the created outer container contract
verify/install pinned dependencies
release the workspace lock
```

The desired destroy flow is:

```text
discover and validate the exact outer container
acquire the workspace mutation lock
stop nested services through ploinky-local when required
stop the outer Box
revalidate the exact outer container ID and ownership
remove the outer Box without a volume flag
retain .ploinky/box by default
if --delete-cache was explicit, delete only the two Box cache directories
release the workspace lock
```

The workspace-backed directories are durable state. A failed container creation or replacement must not roll them back.

## 6. Implementation Tasks

### Task 0: Establish the Baseline

Run and record:

```sh
git status --short --branch
node --test \
  tests/unit/ploinkyBoxIdentity.test.mjs \
  tests/unit/ploinkyBoxVolumes.test.mjs \
  tests/unit/ploinkyBoxDiscovery.test.mjs \
  tests/unit/ploinkyBoxTransactions.test.mjs \
  tests/unit/ploinkyBoxSupervisor.test.mjs \
  tests/unit/ploinkyBoxArguments.test.mjs \
  tests/unit/ploinkyBoxCli.test.mjs \
  tests/unit/ploinkyBoxEntrypoint.test.mjs \
  tests/unit/ploinkyBoxStorage.test.mjs \
  tests/unit/ploinkyBoxDependencies.test.mjs \
  tests/unit/dependencyCache.test.mjs
```

Record pre-existing failures separately. Do not hide them by changing unrelated behavior.

### Task 1: Replace Volume Identity With Workspace Data Paths

Update `ploinky-box/constants.mjs`:

- Remove `BOX_VOLUME_KEYS`.
- Remove the `images` and `dependencies` entries from `BOX_ROLES`; only the outer container role remains.
- Add constants for the workspace-relative data layout and in-container mount destinations if centralizing them improves consistency.
- Use terminology such as `BOX_DATA_KEYS`, `BOX_DATA_RELATIVE_PATHS`, or `BOX_PERSISTED_PATHS`; do not retain “volume” terminology for host persistence.

Update `ploinky-box/identity.mjs`:

- Remove `identity.volumes`.
- Add:

```js
boxDataRoot: path.join(anchorPath, 'box')
dataPaths: {
    dependencies: path.join(anchorPath, 'box', 'dependencies'),
    images: path.join(anchorPath, 'box', 'images'),
}
```

- Keep `workspaceRoot`, `anchorPath`, `pathHash`, `slug`, `instance`, and root fingerprint behavior unchanged.
- Keep all returned identity objects immutable.

Update `tests/unit/ploinkyBoxIdentity.test.mjs` first so it asserts the exact new paths and the absence of volume names.

### Task 2: Replace `volumes.mjs` With Workspace Data Management

Delete `ploinky-box/volumes.mjs` after all callers have moved to a new module, recommended as:

```text
ploinky-box/workspace-data.mjs
```

The new module should expose focused operations such as:

```js
ensureWorkspaceDataPaths({ identity, lock, fsApi })
revalidateWorkspaceDataPaths({ identity, lock, fsApi })
workspaceDataMountArgs(identity)
removeWorkspaceDataPaths({ identity, lock, fsApi })
```

Required behavior:

- Require the exact workspace mutation lock for creation, revalidation, or deletion.
- Create `.ploinky/box`, then the two data directories.
- Treat existing real directories as reusable.
- Reject files or unusable paths where directories are required.
- Confirm both directories are writable by the invoking process.
- Render exact host-path bind mounts to the two unchanged in-container targets.
- Do not use Podman/Docker operations.
- Do not use `:U`; ownership must come from normal host directory creation and the existing keep-id user namespace.
- Do not delete newly created directories during transaction rollback.
- For explicit cache deletion, remove only `images` and `dependencies`; remove `.ploinky/box` afterward only if it is empty.

Replace `tests/unit/ploinkyBoxVolumes.test.mjs` with `tests/unit/ploinkyBoxWorkspaceData.test.mjs`. Cover:

- Exact data paths and mount arguments.
- First creation and idempotent reuse.
- Partial pre-existence.
- Invalid file paths.
- Non-writable directories where that can be tested portably.
- Lock requirement.
- Revalidation immediately before container creation.
- Exact cache deletion and idempotent deletion.
- Proof that unrelated `.ploinky` content remains untouched.
- Proof that no engine runner is involved.

### Task 3: Change the Outer Container Contract to Four Bind Mounts

Update `ploinky-box/lifecycle/container.mjs`:

- Import the workspace-data mount renderer instead of volume helpers.
- Keep the repository bind and workspace bind unchanged.
- Append the exact dependency and image bind mounts.
- Preserve mount ordering so inspection and tests remain deterministic.
- Replace `revalidateAllVolumes` with workspace-data path revalidation.
- Remove volume handles from all function parameters.
- Change outer removal from:

```text
container rm -f --volumes <id>
```

to:

```text
container rm -f <id>
```

Update `ploinky-box/contract/container.mjs`:

- Continue requiring exactly four mounts.
- Require all four mounts to be `type: bind`.
- Require the exact canonical host source for each mount.
- Keep `/opt/ploinky` read-only and the other three mounts read-write.
- Remove volume-name comparisons and legacy `--delete-volumes` guidance.
- Treat an old container with named-volume mounts as incompatible; do not adopt it.

Update transaction and container tests to assert:

- Exactly four `--volume` arguments, all using host paths.
- No `:U` suffix.
- No named-volume source names.
- No `--volumes` removal argument.
- Old mount layouts are incompatible.

### Task 4: Remove Volume State From Lifecycle Transactions

Update `ploinky-box/lifecycle/transactions.mjs`:

- Remove imports of `ensureNamedVolumes` and `rollbackCreatedVolumes`.
- Remove `volumeHandles`, `ensureVolumes`, `rollbackVolumes`, and `revalidateVolumes` seams.
- After successful preflight and image pull/validation, call `ensureWorkspaceDataPaths`.
- Revalidate the data directories immediately before each container create.
- Do not treat directory creation as rollback-owned state.
- Keep candidate-container rollback, old-container restoration, CID-file cleanup, readiness diagnostics, and dependency verification intact.
- Ensure reuse and replacement use the same workspace data paths.
- Preserve the rule that failed replacement restores the old validated Box where current behavior requires it.

Update `tests/unit/ploinkyBoxTransactions.test.mjs`:

- Replace volume event ordering with workspace-data preparation ordering.
- Assert that preflight and pull failures do not create `.ploinky/box` data directories beyond any anchor behavior already required by the lock transaction.
- Assert that a container-create or readiness failure retains workspace data directories.
- Assert zero engine volume commands in initial create, reuse, failed create, replacement, rollback, and restore flows.

### Task 5: Make Discovery Container-Only

Update `ploinky-box/engine/discovery.mjs`:

- Delete volume inventory, exact-volume inspection, volume fingerprints, volume handle construction, and volume handle matching.
- Stop invoking `volume ls` or `volume inspect` on every supported engine.
- Keep engine support validation and outer container inventory intact.
- Keep exact container name, path-hash label, role label, immutable ID, and cross-engine ambiguity checks intact.
- Ownership handles should contain only the outer container.
- Remove partial-volume, retained-volume, and malformed-volume classifications.
- Ignore old labelled named volumes completely. Their existence must neither establish ownership nor block a new Box.

Update `tests/unit/ploinkyBoxDiscovery.test.mjs`:

- Remove volume fixtures and expectations.
- Preserve supported-host, rootless-engine, exact-container, foreign-container, label-drift, Docker/Podman ambiguity, and unreachable-engine tests.
- Add an assertion that discovery never issues a volume command.
- Add a hard-cut test demonstrating that old volume records are irrelevant to current ownership.

Update `tests/unit/ploinkyBoxSafetyMatrix.test.mjs` and native cleanup helpers to remove volume ownership states and fingerprints.

### Task 6: Simplify Supervisor State and Destroy Semantics

Update `ploinky-box/supervisor.mjs`:

- Remove `BOX_VOLUME_KEYS`, `removeOwnedNamedVolumes`, and `destroyNamedVolumes` dependencies.
- Remove the `absent-retained-volumes` state.
- Status is based on the outer container and existing in-Box status only; cache-directory existence does not create a separate Box ownership state.
- Default destroy removes the outer container and retains `.ploinky/box`.
- Add `deleteCache` behavior that removes the exact workspace-backed data paths after successful outer removal.
- Permit `deleteCache` when the container is already absent.
- Keep the existing failure-safe nested stop and exact outer-container revalidation behavior.
- Never delete cache data after a failed nested stop or failed outer removal.

Recommended result shapes:

```js
{ action: 'destroyed', deletedCache: false }
{ action: 'destroyed', deletedCache: true }
{ action: 'deleted-cache', deletedCache: true }
```

Update `tests/unit/ploinkyBoxSupervisor.test.mjs` to cover:

- Running and stopped destroy retain cache data by default.
- Explicit cache deletion occurs only after successful container removal.
- Cache deletion works with no container.
- Nested-stop failure stops but does not remove the outer Box and does not delete cache data.
- Outer removal failure retains cache data.
- No volume command occurs in any path.

### Task 7: Replace `--delete-volumes` With `--delete-cache`

Update `ploinky-box/command/route.mjs`:

- `destroy` returns `deleteCache: false`.
- Accept exactly one `--delete-cache` argument and return `deleteCache: true`.
- Reject `--delete-volumes` as an unexpected argument.
- Preserve rejection of unsupported ports, dry-run, duplicate flags, and trailing arguments.

Update `ploinky-box/bin/ploinky-box.mjs`:

- Remove checks for retained volume handles.
- Default confirmation should say that the outer Box will be destroyed while `.ploinky/box` cache data is retained.
- `destroy --delete-cache` should skip the default confirmation because cache deletion is explicit, matching the old explicit destructive-flow behavior.
- Report exact cache deletion rather than named-volume deletion.
- Allow `destroy --delete-cache` when the outer container is absent.

Update `cli/commands/help.js` and `README.md`:

- Replace all active named-volume descriptions with `.ploinky/box` paths.
- Document that dependencies and images survive normal destroy/recreate.
- Document that nested container records and inner named volumes do not survive.
- Document `destroy --delete-cache` and the exact data it deletes.
- Remove active recovery guidance referring to `destroy --delete-volumes`.
- Do not rewrite historical plans or specifications merely because they describe the old design.

If boundary tests require it, add `cli/commands/help.js` and this active plan to `ploinky-box/boundary/ploinky-allowlist.json` narrowly rather than broadening the allowlist.

Update `tests/unit/ploinkyBoxArguments.test.mjs`, `tests/unit/ploinkyBoxCli.test.mjs`, and active help/documentation tests.

### Task 8: Preserve Entrypoint Paths and Update Terminology

The functional in-container paths in `ploinky-box/entrypoint/entrypoint.mjs` should remain:

```text
dependencies = /opt/ploinky/node_modules
imageStore  = /home/podman/.local/share/ploinky-images
graphRoot   = /home/podman/.local/share/containers/storage
runRoot     = /tmp/storage-run-1000
```

Keep `ploinky-box/entrypoint/storage.mjs` functionally unchanged unless native validation exposes a host-bind-specific requirement. It must still prove:

- Overlay with `fuse-overlayfs` is effective.
- The configured graphroot is disposable.
- The imagestore is the intended mounted directory.
- Podman's inner volume path is under graphroot and not under imagestore.
- The image-store marker is written and observed on the intended filesystem.

Update comments and diagnostics:

- “dependency volume” becomes “dependency directory” or “dependency cache”.
- “durable named volume” becomes “workspace-backed image store”.
- Mount validation should describe required writable directories rather than named volumes.

Keep the dependency installer target unchanged at `/opt/ploinky/node_modules`.

### Task 9: Rewrite Native and Public Lifecycle Acceptance

Update:

- `tests/integration/ploinkyBoxNative.test.mjs`
- `tests/integration/ploinkyBoxSmokeGraph.test.mjs`
- `tests/e2e/ploinkyBox/publicCli.test.mjs`
- `tests/e2e/ploinkyBox/nativeHelpers.mjs`
- `tests/unit/ploinkyBoxNativeCleanup.test.mjs`

The authoritative recreate scenario must:

1. Create a fresh workspace and Box.
2. Confirm `.ploinky/box/dependencies` and `.ploinky/box/images` exist on the physical host.
3. Inspect the outer Box and prove both are exact bind mounts.
4. Prove no outer named volume was created for the workspace identity.
5. Install dependencies and record a dependency marker/tree hash.
6. Pull or build a nested image and record its immutable image ID.
7. Create a nested managed container and an inner Podman named volume with canaries.
8. Stop and destroy the outer Box without deleting cache data.
9. Confirm both `.ploinky/box` data directories remain on the host.
10. Recreate the outer Box.
11. Confirm dependency data remains and dependency verification succeeds.
12. Confirm the prior nested image is still inspectable without a new image pull.
13. Confirm the prior nested container record and inner named volume are absent.
14. Run `destroy --delete-cache`.
15. Confirm only the two Box cache directories were removed and unrelated `.ploinky` state remains.
16. Start again and prove both cache directories and dependencies are rebuilt cleanly.

Fix the stale `ploinkyBoxSmokeGraph` assertion that currently expects an inner named volume to survive outer recreation. The intended contract is that images and Box dependencies survive, while inner container and volume state does not.

The candidate-engine proxy trace should assert that the outer supervisor issued no `volume create`, `volume inspect`, `volume ls`, or `volume rm` commands.

## 7. Test Strategy

### Focused unit/static gate

Run the complete Ploinky Box unit surface after each logical phase:

```sh
node --test tests/unit/ploinkyBox*.test.mjs tests/unit/dependencyCache.test.mjs
```

Run source searches that must return no active production hits:

```sh
rg -n "BOX_VOLUME_KEYS|identity\.volumes|ensureNamedVolumes|rollbackCreatedVolumes|removeOwnedNamedVolumes|revalidateAllVolumes" ploinky-box
rg -n "destroy --delete-volumes|named volumes?" ploinky-box cli/commands/help.js README.md
```

Historical documents under `docs/superpowers/` are exempt from wording searches unless active documentation tests intentionally include them.

### Full repository gate

Run:

```sh
npm test
```

Do not dismiss failures as unrelated without reproducing them against the pre-change baseline.

### Native candidate gate

Use one immutable candidate image digest:

```sh
PLOINKY_BOX_REQUIRE_PODMAN=1 \
PLOINKY_BOX_CANDIDATE_DIGEST=sha256:<immutable-candidate-digest> \
node --test \
  tests/integration/ploinkyBoxNative.test.mjs \
  tests/integration/ploinkyBoxSmokeGraph.test.mjs \
  tests/e2e/ploinkyBox/publicCli.test.mjs
```

Run the candidate gate on:

1. Rootless native Linux Podman.
2. macOS Podman Machine with the workspace under the real macOS host mount.

The macOS run must exercise the actual `.ploinky/box/images` bind, not a VM-local substitute. A passing unit mock or Linux-only run is insufficient evidence for the host-backed imagestore requirement.

The repository's special cross-repository `ploinky-proxy` deployment/Playwright gate is out of scope unless the user explicitly requests it in the implementation session.

## 8. Expected File Changes

Production files expected to change:

```text
ploinky-box/constants.mjs
ploinky-box/identity.mjs
ploinky-box/workspace-data.mjs              # new
ploinky-box/volumes.mjs                     # delete
ploinky-box/lifecycle/container.mjs
ploinky-box/lifecycle/transactions.mjs
ploinky-box/contract/container.mjs
ploinky-box/engine/discovery.mjs
ploinky-box/supervisor.mjs
ploinky-box/command/route.mjs
ploinky-box/bin/ploinky-box.mjs
ploinky-box/entrypoint/entrypoint.mjs        # terminology/minimal validation changes
ploinky-box/entrypoint/storage.mjs           # terminology unless runtime fix is needed
ploinky-box/entrypoint/install-dependencies.mjs
cli/commands/help.js
README.md
ploinky-box/boundary/ploinky-allowlist.json  # only if required by boundary tests
```

Tests expected to change:

```text
tests/unit/ploinkyBoxIdentity.test.mjs
tests/unit/ploinkyBoxWorkspaceData.test.mjs  # new
tests/unit/ploinkyBoxVolumes.test.mjs        # delete
tests/unit/ploinkyBoxDiscovery.test.mjs
tests/unit/ploinkyBoxTransactions.test.mjs
tests/unit/ploinkyBoxSupervisor.test.mjs
tests/unit/ploinkyBoxArguments.test.mjs
tests/unit/ploinkyBoxCli.test.mjs
tests/unit/ploinkyBoxEntrypoint.test.mjs
tests/unit/ploinkyBoxStorage.test.mjs
tests/unit/ploinkyBoxDependencies.test.mjs
tests/unit/ploinkyBoxNativeCleanup.test.mjs
tests/unit/ploinkyBoxSafetyMatrix.test.mjs
tests/unit/ploinkyBoxPackaging.test.mjs
tests/integration/ploinkyBoxNative.test.mjs
tests/integration/ploinkyBoxSmokeGraph.test.mjs
tests/e2e/ploinkyBox/nativeHelpers.mjs
tests/e2e/ploinkyBox/publicCli.test.mjs
```

This is an expected map, not permission to edit unrelated files. Follow actual call paths and test failures.

## 9. Definition of Done

Implementation is complete only when all of the following are true:

- [ ] Newly created outer Boxes use exactly four bind mounts and no named volumes.
- [ ] `.ploinky/box/dependencies` backs `/opt/ploinky/node_modules`.
- [ ] `.ploinky/box/images` backs `/home/podman/.local/share/ploinky-images`.
- [ ] Dependencies survive outer destroy/recreate.
- [ ] Nested image content survives outer destroy/recreate.
- [ ] Inner container records, writable layers, and inner named volumes do not survive outer destroy/recreate.
- [ ] No production path invokes an outer engine `volume` command.
- [ ] Workspace identity contains no volume names or handles.
- [ ] Discovery and supervisor state contain no retained-volume concepts.
- [ ] Failed create/replacement retains workspace-backed cache data.
- [ ] Default destroy retains `.ploinky/box`.
- [ ] `destroy --delete-cache` deletes only the two Box cache directories.
- [ ] `destroy --delete-volumes` is rejected.
- [ ] Old named volumes are ignored and neither migrated nor automatically deleted.
- [ ] Focused unit/static tests pass.
- [ ] The full repository test suite passes.
- [ ] The immutable native candidate gate passes on rootless Linux Podman.
- [ ] The immutable native candidate gate passes on macOS Podman Machine using the real host workspace bind.
- [ ] Active README and CLI help describe the new behavior accurately.
- [ ] `git diff --check` passes and the final diff contains no unrelated edits.

## 10. Implementation Guidance for the New Session

Use a test-first sequence per subsystem:

1. Change identity tests, then identity.
2. Add workspace-data tests, then the new module.
3. Change mount-contract tests, then container construction and validation.
4. Change transaction tests, then transaction flow.
5. Change discovery tests, then delete volume discovery.
6. Change supervisor/CLI tests, then destroy and cache reset.
7. Change native lifecycle assertions last, once unit contracts are stable.
8. Run adversarial verification after the implementation: inspect the final diff, search for stale volume behavior, run focused/full tests, and attempt the native recreate sequence.

Do not solve failures by:

- Reintroducing a differently named outer volume.
- Persisting the complete inner graphroot under `.ploinky`.
- Making the outer Box privileged.
- Making `/opt/ploinky` writable.
- Disabling storage validation.
- Silently accepting an old named-volume container contract.
- Weakening macOS acceptance to a VM-local path.
- Deleting unrelated `.ploinky` state during cache reset.

At handoff, report:

- The final `.ploinky` layout.
- The exact outer mount inspection.
- Confirmation that no outer volume commands remain.
- Focused and full test results.
- Linux and macOS candidate results, or the precise unexecuted-gate reason.
- Any remaining known limitation, without calling the work complete if a required gate failed.
