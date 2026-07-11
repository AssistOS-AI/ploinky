# Ploinky Box Invariant Alignment Implementation Plan

Date: 2026-07-11
Status: approved implementation plan; implementation has not started and image publication requires separate approval

## Goal

Align the Ploinky box branch, its nested agent runtime, and the separately
published Ploinky box image with the agreed invariants:

- Ploinky runs through one managed outer box with host-mounted Ploinky core.
- Ordinary agents run as nested Podman containers inside that box.
- Bare Ploinky opens the in-box REPL, while parameterless Ploinky cli opens
  Bash in the box.
- Help, status, stop, and destroy retain their host-special behavior.
- Destroy removes the outer box while retaining persistent named volumes.
- Manifest openPorts are enforced generically rather than only for Explorer.
- A contract-2 mutable runtime image is pulled before create or replacement,
  but not for reuse or a compatible stopped start.
- Core and agent command arguments are never accidentally consumed as outer
  runtime flags.
- Box boot removes only explicitly labelled Ploinky-managed nested containers;
  unrelated/manual nested containers, images, and named volumes are retained.

This plan spans two repositories:

| Repository | Responsibility |
| --- | --- |
| container-image-builds | Build, validate, and publish the contract-2 runtime image |
| ploinky | Supervise the outer runtime, plan publications, forward commands, and run nested agents |

## Review and Execution Boundary

This document is the approved plan, not authorization to implement or publish.

- D1 through D12 are approved. Do not modify runtime code until the owner gives
  a separate explicit instruction to start implementation.
- Do not dispatch the image publication workflow without separate explicit
  authorization.
- Publish and verify the contract-2 image before releasing Ploinky code that
  requires it.
- Preserve the existing modified ploinky/node_modules/achillesAgentLib
  submodule. It is outside this plan and must not be reset, staged, or edited.
- Preserve unrelated changes in both repositories.

## Confirmed Decisions

| Topic | Confirmed behavior |
| --- | --- |
| Bare ploinky and p-cli | Reconcile/start the box and open the in-box Ploinky REPL |
| Parameterless ploinky cli | Open Bash as podman in /workspace |
| Agent CLI | ploinky cli AGENT ARGS continues attaching to the selected nested agent CLI |
| Host-special commands | Keep help, status, stop, and destroy |
| Stop | Keep current behavior: core stop followed by outer box stop |
| Destroy persistence | Remove the outer box without deleting its three managed named volumes |
| openPorts | Generalize to arbitrary agents and their effective dependency/runtime set |
| Agent runtime | Force nested Podman in the box for now, including lite-sandbox manifests |
| Pull timing | Pull only before missing-box create or intentional replacement |
| Runtime image | Use contract 2 through docker.io/assistos/ploinky-box:runtime |
| Branch behavior | Keep current source-branch inference and injection |
| Outer argument grammar | Parse outer options only before the core command; support an explicit double-dash boundary |
| Instance identity | Remove public --name; derive the box and volume identity from the canonical realpath of the exact current directory |
| Host engine | Remove public --engine; find an existing box across Podman/Docker, otherwise prefer functional Podman and fall back to functional Docker |
| Parser migration | Apply the new grammar directly with no warning release |
| Destroy sequence | After confirmation, directly force-remove the outer box without invoking in-box core stop or a separate outer stop |
| Destroy volume cleanup | Remove anonymous volumes attached to the box while preserving all explicitly named volumes |
| Contract-1 transition | Hard cut with no automatic migration, copying, adoption, or mapping; contract 2 starts with fresh path-hashed volumes |
| openPorts command scope | Pre-plan every one-shot host path that can start agents; allow REPL starts only when existing coverage is sufficient and otherwise fail before mutation |
| Effective started set | Plan the requested active graph plus previously enabled agents that core will actually launch; exclude merely installed agents |
| openPorts host port zero | Reject before box mutation or agent startup; boundary publications require a stable box-side port from 1 to 65535 |
| Publication provenance | Require versioned provenance labels on every supported contract-2 box; reject unlabelled boxes rather than guessing or migrating ports |
| Profile conflicts | Retain the current profile system, but reject incompatible profiles for the same effective agent instance before mutation |
| Nested boot cleanup | Label every Ploinky-managed nested container and remove only those labelled containers on box boot; preserve unrelated/manual containers, images, and named volumes |

## Completed Decision Record

All design decisions are approved. D12 is retained here because it was the
final decision and directly changes the image entrypoint contract.

| ID | Decision | Approved behavior | Consequence |
| --- | --- | --- | --- |
| D12 | Nested storage cleanup on box boot | Replace blanket podman rm -af with label-selective removal of Ploinky-managed nested containers | Managed agent containers are recreated; unrelated/manual containers, images, and named volumes remain untouched |

D1 through D12 are approved. No implementation or publication is authorized by
that approval alone.

## Target Public Behavior

### Command Routing

| Invocation | Host behavior |
| --- | --- |
| ploinky or p-cli | Reconcile/start compatible box; exec the Ploinky REPL |
| ploinky cli | Reconcile/start compatible box; exec Bash interactively |
| ploinky cli AGENT ARGS | Ensure required outer publications; forward the exact agent CLI argv |
| ploinky start ... | Plan authoritative active publications; reconcile; forward core start; probe router |
| ploinky enable ... | Pre-plan any agent start caused by enable; reconcile before forwarding |
| ploinky restart ... | Pre-plan agents that can be restarted; reconcile before forwarding |
| ploinky reinstall ... | Pre-plan the selected agent; reconcile before forwarding |
| ploinky status | Remain read-only and never pull or reconcile |
| ploinky stop | Keep current two-phase core and outer stop; never pull |
| ploinky destroy | Confirm and remove only the outer box; never pull or remove named volumes |
| ploinky help ... | Render host-aware help without starting the box |

### Argument Grammar

Approved grammar:

~~~text
ploinky [OUTER_OPTION ...] [--] [CORE_COMMAND [CORE_ARGUMENT ...]]
~~~

Rules:

| Rule | Behavior |
| --- | --- |
| Before command | Recognize --port, --publish/--expose, --image, --mount, --listen-lan, --dry-run, and help flags |
| First command token | End generic outer parsing |
| Double dash before command | End outer parsing explicitly and remove the delimiter |
| After ordinary command | Preserve every token, spelling, and ordering |
| Lifecycle commands | Derive the target from the exact current directory and discover its host engine automatically |
| Invalid lifecycle tails | Reject creation flags and unknown trailing values |
| Start router port | Preserve positional start AGENT PORT and canonical prefix --port |
| Start branches/profiles | Preserve current parsing, forwarding, and automatic branch injection |

Canonical examples:

~~~bash
cd /home/user/projects/qa
ploinky client tool create --name bob --port 9000

ploinky --image box:v2 -- \
  cli codexAgent --image model --name session

ploinky --publish 127.0.0.1:8082:8082 start explorer

ploinky --port 9192 start explorer

ploinky start explorer 9192

ploinky destroy
~~~

The current post-command hoisting is unsafe because --name, --image, --mount,
--port, --engine, --publish, --expose, and --listen-lan are all valid generic
agent or MCP payload names. The approved contract deletes public --name and
--engine and makes unmarked downstream arguments win for the remaining outer
options.

### Deterministic Instance Identity

Every command computes the same instance identity independently:

~~~text
canonicalPath = realpath(exact current working directory)
pathHash      = first 12 lowercase hexadecimal characters of SHA-256(canonicalPath)
slug          = sanitized basename(canonicalPath), truncated to keep the engine name bounded
instance      = ploinky-box-SLUG-PATHHASH
~~~

The workspace, nested-container-storage, and dependency volume names are
derived from that exact instance string.

| Situation | Behavior |
| --- | --- |
| Same physical folder through a symlink | realpath resolves to the same instance |
| Same basename at two absolute paths | Path hashes produce different instances |
| Repeated command from the same folder | Resolves the same box and volumes |
| Command from a child directory | Resolves a different instance |
| Folder moved or renamed | Resolves a new instance; old box/volumes remain under the old identity |

Store only the path hash and identity-schema version in supervisor-owned
container labels. Do not store the cleartext absolute path in container
metadata.

### Automatic Host-Engine Resolution

Public --engine is removed. After deriving the instance name:

1. Probe installed Podman and Docker engines for that exact container name.
2. If exactly one engine owns it, use that engine even if the other engine is
   now preferred or was installed later.
3. If both engines own the same deterministic name, fail with an ambiguity
   error and mutate neither.
4. If neither owns it, select the first functional engine: Podman first, then
   Docker.
5. If neither engine is functional, fail before mutation.

This rule applies equally to ordinary commands, status, stop, and destroy, so a
later host-engine installation cannot make an existing box undiscoverable.

## Contract-2 Runtime Image

### Required Image Metadata

| Field | Required value |
| --- | --- |
| Reference | docker.io/assistos/ploinky-box:runtime |
| Contract label | io.assistos.ploinky.runtime-contract=2 |
| Config.User | podman |
| USER | podman |
| HOME | /home/podman |
| PLOINKY_WORKSPACE_ROOT | /workspace |
| PLOINKY_DISABLE_HOST_SANDBOX | 1 |
| container | oci |
| BUILDAH_ISOLATION | chroot |
| WorkingDir | /workspace |
| Entrypoint | /usr/local/bin/ploinky-box-entrypoint |
| Command | absent |
| Config.Volumes | absent or empty |

The existing Podman base declares rootful storage metadata that cannot be
removed by a normal child Dockerfile. The image must therefore prepare its
filesystem in an intermediate stage and copy the complete filesystem into a
clean FROM scratch final stage. The final stage explicitly restores every
required configuration field.

### Image Runtime Checks

The entrypoint and publication workflow must prove:

| Boundary | Required proof |
| --- | --- |
| Identity | id -un is podman, USER is podman, HOME is /home/podman |
| Filesystem | /workspace is writable; mounted /opt/ploinky source is executable |
| Dependencies | /opt/ploinky/node_modules is a mounted writable volume |
| Tools | Bash, Node 24, npm, npx, Git, and Podman exist |
| Devices | /dev/fuse and /dev/net/tun are present |
| Podman | podman version and podman info succeed |
| Nested execution | Nested Alpine runs successfully |
| Boot cleanup | Running and stopped containers with the exact managed=1 label are removed; unlabelled, managed=0, and near-name controls remain |
| OCI metadata | Contract, user, environment, workdir, entrypoint, and empty volumes match exactly |
| Platforms | The same gates pass natively for linux/amd64 and linux/arm64 |

### Selective Nested-Container Cleanup

Every nested container created and owned by Ploinky must carry this stable
ownership label:

~~~text
io.assistos.ploinky.managed=1
~~~

On each outer box boot, the image entrypoint lists nested container IDs in all
states with that exact key/value label and force-removes only those IDs before
starting core. It must not use an all-containers selector such as podman rm -a,
key-existence-only matching, or prefix matching. Failure to enumerate or remove
a selected managed container fails the entrypoint clearly instead of
continuing with ambiguous stale state.

This cleanup treats Ploinky-managed agent container records and their writable
layers as disposable. Their persistent state must live in the mounted
workspace or declared named volumes. Nested image/layer cache and named volumes
remain in the retained nested-storage volume. Unlabelled containers are outside
Ploinky lifecycle ownership and are never silently deleted; Ploinky does not
promise to restart or repair those manual containers after an unclean outer
shutdown.

The contract-1 hard cut means there is no legacy-label adoption path. Every
contract-2 Ploinky nested-container creation path, including agent helpers and
sidecars, must set the ownership label from its first release.

### Mutable Publication

Each architecture job builds and pushes an image by digest. Candidate digests
may exist in the registry, but the public runtime tag must not move until both
architectures pass every gate. The merge job then creates the multiarchitecture
runtime manifest and prints its final digest.

Workflow concurrency remains serialized so two dispatches cannot race to move
the mutable channel.

## Runtime Contract and Reconciliation

### Image Selection and Pulling

| Existing state | Required action |
| --- | --- |
| No box | Pull selected reference unconditionally, validate it, plan ports, create from validated image ID |
| Running compatible box, no config change | Reuse without registry traffic |
| Stopped compatible box, no config change | Start without registry traffic |
| Compatible box requiring config replacement | Pull and validate before stopping the current box |
| Contract-1 or malformed box | Block without pulling or mutation; instruct explicit destroy |
| status, stop, destroy | Never pull |

Pull failure never falls back to a cached tag. Custom --image values must also
be registry-pullable and satisfy contract 2.

The mutable tag is a release channel, not automatic rolling update behavior.
An existing compatible box stays pinned to its inspected image ID. Refresh is
explicit: destroy the box, then run any ordinary command to pull and recreate.

### Image-ID Pinning

After a successful pull, the supervisor validates the local image inspection
and executes the resolved image ID rather than the mutable tag. This closes the
race in which another process moves the local tag between validation and run.

The outer container records the requested logical reference in a
supervisor-owned label, tentatively:

~~~text
io.assistos.ploinky.requested-image
~~~

Inspect normalization uses the label for desired-configuration comparison and
uses the container image ID for deployed identity and rollback.

### Contract Validation

Validation must report field-specific failures for:

- missing or wrong contract label;
- empty image ID;
- wrong process user;
- missing or wrong USER, HOME, workspace, or sandbox environment;
- wrong working directory;
- wrong or malformed entrypoint;
- any declared image volume.

An existing container is compatible only when its image ID still resolves to a
complete contract-2 image inspection.

### Transactional Replacement

Replacement order:

1. Resolve desired configuration without mutating the existing box.
2. Pull the selected mutable/custom reference.
3. Validate complete image contract and capture its ID.
4. Complete publication planning and conflict checks.
5. Gracefully stop core for ordinary configuration replacement.
6. Stop and remove only the old outer container.
7. Create the replacement from the validated ID with the same named volumes.
8. Validate health and dependencies.
9. On failure, remove the failed replacement and restore the prior contract-2
   image ID and full inspected creation configuration.

Contract-1 boxes are not transactionally upgraded. No old basename-only volume
is copied, renamed, adopted, mapped, or attached to the new path-hashed
identity. Old named volumes remain untouched for manual inspection/recovery;
contract 2 creates fresh deterministic volumes.

## Volume-Preserving Destroy

The three managed named volumes are:

| Destination | Volume suffix |
| --- | --- |
| /workspace | -workspace |
| /home/podman/.local/share/containers | -containers |
| /opt/ploinky/node_modules | -ploinky-deps |

Approved destroy behavior:

| State | Result |
| --- | --- |
| Box absent, volumes absent | Idempotent success |
| Box absent, named volumes present | Report box already absent; leave volumes untouched and do not prompt |
| Box present, confirmation declined | No mutation |
| Box present, confirmation accepted | Directly remove selected outer box and its anonymous volumes; retain all named volumes |
| Next ordinary invocation for a destroyed contract-2 identity | Pull contract 2, plan, and recreate using the same path-hashed named volumes |
| First contract-2 invocation with legacy basename-only resources present | Create fresh path-hashed volumes; do not attach or mutate legacy volumes |

The prompt must identify the box and explicitly state that the three named
volumes will be retained. It must not imply a clean-data reset.

Explicit destroy and failed-container cleanup both remove only anonymous
volumes associated with the selected container. Docker and Podman preserve
explicitly named mounts when the container is removed with the volume-cleanup
flag. Tests must audit the before/after inventory and prove the three managed
names remain. Contract 2 prevents new instances of the legacy inherited
/var/lib/containers anonymous-volume defect.

## Forced Nested Podman

Inside a marked Ploinky box:

- Podman is the only permitted agent container runtime.
- Docker fallback is not permitted.
- lite-sandbox manifests resolve to nested Podman even if workspace state
  previously enabled bwrap/Seatbelt.
- sandbox status reports the effective forced state.
- sandbox enable must either fail clearly or report that it is ineffective
  inside the box; it must not persist a misleading effective setting.
- Outside the box, existing master-compatible runtime selection remains
  unchanged.

Enforcement is defense in depth:

| Layer | Enforcement |
| --- | --- |
| Image | PLOINKY_DISABLE_HOST_SANDBOX=1 and functional Podman self-check |
| Image contract | Supervisor validates the forced-sandbox environment |
| Core runtime selection | Marker-aware code requires Podman and rejects Docker fallback |
| CLI | sandbox commands report the forced box policy accurately |

## General openPorts Planning

### Why the Current Planner Is Insufficient

The current planner is intentionally limited to three Explorer spellings. It
also reads sibling host checkouts relative to the Ploinky source directory.
That is not a valid general source of truth because:

- the active repository may exist only in the workspace named volume;
- logical repository names can differ from host directory names;
- the active workspace checkout can be on another branch;
- bare-agent resolution depends on enabled and installed workspace repos;
- profile and alias selection can depend on workspace registry state.

Removing only the Explorer guard would create incorrect publications for
nontrivial workspaces.

### Authoritative Planner

Add a side-effect-limited internal planner that operates against:

~~~text
/workspace/.ploinky/repos
/workspace/.ploinky/agents.json
/workspace/.ploinky/profile
~~~

The planner shares core services for:

- bare, slash-qualified, and colon-qualified agent resolution;
- enabled-repo precedence and ambiguity errors;
- root and edge-local profiles;
- default-profile fallback;
- aliases as distinct effective instances;
- SSO-provider conditional dependencies;
- branch and per-repository branch policy;
- enable directive parsing;
- dependency cycle and missing-manifest diagnostics.

The planner may install or switch repository checkouts required to resolve the
requested graph. It must not enable an agent, create a nested container, run a
hook, or start the router.

Proposed versioned result:

~~~json
{
  "schemaVersion": 1,
  "operation": "start",
  "root": "repo/agent",
  "profile": "default",
  "nodes": [],
  "claims": [],
  "publishes": []
}
~~~

### Planning Execution Modes

| Outer state | Planner execution |
| --- | --- |
| Running compatible box | Exec the internal planner inside it under a workspace lock |
| Stopped compatible box | Start it without pulling, then exec the planner |
| Missing box | Pull and validate image; run a short-lived planner container with the same named workspace/source mounts; then create final box from the same image ID |
| Incompatible box | Refuse before planning and require explicit destroy |

The temporary planner container has no published ports and never becomes the
managed outer instance. Its output is machine-readable and versioned.

### Claim Rules

Use container/publish-spec.mjs as the canonical parser.

| Rule | Behavior |
| --- | --- |
| Root | Include the root agent’s effective openPorts |
| Dependencies | Include every active transitive dependency |
| Extra enabled agents | Include agents core will start outside the selected graph under approved D8 |
| Profile override | Selected profile openPorts replace default openPorts |
| Missing selected profile | Workspace profile may fall back to manifest default; explicit edge profile must exist |
| Aliases | Treat aliases as distinct effective runtime instances |
| Exact repeat | Dedupe only for the same effective node and identical claim |
| Overlap | Fail when different effective nodes claim the same box-side socket |
| Protocol | TCP and UDP at the same number are independent |
| Ranges | Require valid equal-length host/container ranges |
| Port zero | Reject under approved D9 |
| Router 8080/tcp | Reserve it and report a clear conflict |
| Explicit publish | Preserve spelling/order and suppress overlapping generated target claims |

### Publication Provenance

Current inspect data cannot distinguish generated publications from explicit
user publications. Without provenance, changing graph/profile can leave stale
ports forever or accidentally delete user intent.

Add versioned supervisor-owned labels, tentatively:

~~~text
io.assistos.ploinky.publish-plan-version
io.assistos.ploinky.generated-publishes
io.assistos.ploinky.explicit-publishes
~~~

On each planned command:

1. Preserve explicit publications.
2. Replace the previous generated set with the newly planned generated set.
3. Validate the combined router, explicit, and generated claims.
4. Reconcile transactionally if the combined set changed.
5. Reject a box whose required configuration/provenance label is absent or
   unsupported; never guess whether an inspected port was explicit or generated.

The complete prior label/configuration set participates in rollback.

### REPL and Non-Start Paths

One-shot host commands can plan and replace before forwarding. Commands entered
inside the REPL cannot safely recreate their own outer container.

Under approved D7:

- host start, enable, cli AGENT, restart, and reinstall pre-plan;
- core agent startup verifies that the outer publication contract covers the
  agent’s effective openPorts;
- a REPL command whose required publications are already present proceeds;
- a REPL command requiring new/changed publications fails before agent start
  and instructs the operator to exit and run the one-shot host form;
- no host engine socket is mounted into the box.

## File Map

### container-image-builds

| File | Planned change |
| --- | --- |
| images/ploinky-box/Dockerfile | Clean contract-2 final image and exact metadata |
| images/ploinky-box/entrypoint.sh | Identity, mount, device, Podman, and nested-runtime checks |
| .github/workflows/publish-ploinky-box-image.yml | Per-architecture digest build/test and gated mutable manifest |
| tests/image-definitions.test.mjs | Contract-2 Dockerfile/workflow static assertions |
| README.md | Runtime tag, contract, verification, and release ordering |

### ploinky

| File | Planned change |
| --- | --- |
| container/runtime-contract.mjs | Contract-2 inspect normalization, validation, ID pinning, labels, config diff |
| container/runtime-supervisor.mjs | Pull policy, legacy hard cut, argument grammar, planning, reconcile, destroy |
| container/runtime-engine.mjs | Only if planner execution needs a narrowly scoped engine-client capability |
| container/box-publish-planner.mjs | Generic claim validation over authoritative graph output |
| container/publish-spec.mjs | Retain as canonical parser; extend only for explicit diagnostics if necessary |
| container/smoke-runtime.mjs | Contract-2, real mount audit, preserved-volume destroy/recreate |
| cli/services/bootstrapManifest.js | Split repo preparation from enable/start side effects |
| cli/services/workspaceDependencyGraph.js | Explicit profile/root/alias inputs and deterministic serializable nodes |
| cli/services/boxStartPublishPlan.js | New authoritative side-effect-limited plan service |
| container/box-start-publish-plan.mjs | New small internal JSON entrypoint |
| cli/services/docker/common.js | Marker-aware forced Podman and publication coverage helpers |
| cli/services/docker/agentServiceManager.js | Managed-container ownership labels and fail-closed outer publication coverage before agent start |
| cli/services/sandboxRuntime.js | Effective forced state inside box |
| cli/commands/sandboxCommands.js | Accurate status/enable behavior |
| tests/helpers/runtimeSupervisorHarness.mjs | Contract-2 images, mutable pulls, planner calls, labels, volume semantics |
| container/runtime-supervisor-tests.mjs | Full supervisor, parser, lifecycle, planning, and rollback matrix |
| tests/unit/boxPublishPlanner.test.mjs | Generic graph/claim tests |
| tests/unit/workspaceDependencyGraph.test.mjs | Profile, alias, auth, ambiguity, branch alignment |
| tests/unit/sandboxRuntime.test.mjs | Forced Podman behavior |
| tests/unit/helpLayers.test.mjs | Updated destroy and argument help |
| README.md and container/README.md | Public runtime contract |
| docs/code-derived-agent-lifecycle.md | Generic boxed lifecycle |
| docs/specs/DS003-agent-manifest-and-registry.md | openPorts and graph semantics |
| docs/specs/DS004-runtime-execution-and-isolation.md | Outer/nested runtime contract |
| docs/specs/DS007-dependency-caches-and-startup-readiness.md | Planner and retained dependency volume |
| docs/superpowers/specs/2026-07-11-mutable-runtime-image-hard-cut-design.md | Reconcile design with approved contract-2 persistence, legacy hard cut, and other decisions |

## Task-by-Task Implementation Plan

### Task 1: Freeze the Reviewed Contract

**Files**

- Modify: docs/superpowers/specs/2026-07-11-mutable-runtime-image-hard-cut-design.md
- Modify: this plan only if review changes the task sequence

**Steps**

- [x] Record approved D1-D12.
- [ ] Remove statements that explicit destroy deletes named volumes.
- [ ] Retain the contract-1 no-migration rule and clarify that old named volumes
      remain untouched for manual recovery while contract 2 uses fresh
      path-hashed volumes.
- [ ] Record the mutable-tag refresh model: create/replacement only.
- [ ] Record generic openPorts scope and the REPL fail-closed boundary.
- [ ] Record the final outer argument grammar.
- [ ] Re-review the specification before runtime edits.

### Task 2: Write Failing Contract-2 Image Tests

**Files**

- Modify: ../container-image-builds/tests/image-definitions.test.mjs

**Steps**

- [ ] Replace immutable v1 assertions with contract-2 runtime assertions.
- [ ] Require a clean final FROM scratch stage.
- [ ] Require USER, HOME, workspace, sandbox, Podman, PATH, workdir, entrypoint,
      and no VOLUME/CMD metadata.
- [ ] Require runtime as the only public publication tag.
- [ ] Require separate amd64 and arm64 build jobs.
- [ ] Require both architecture jobs before manifest merge.
- [ ] Require metadata, entrypoint, Podman, and nested Alpine gates per digest.
- [ ] Reject blanket all-container cleanup and require the exact managed-label
      selection contract.
- [ ] Require running and stopped managed=1 cleanup targets to be removed while
      unlabelled, managed=0, and near-name control containers survive.
- [ ] Require injected enumeration and removal failures to exit nonzero with a
      clear diagnostic.
- [ ] Require manifest platform verification and final digest output.
- [ ] Run the image-definition test and confirm it fails for the expected
      contract-1 assumptions before implementation.

### Task 3: Build the Contract-2 Image

**Files**

- Modify: ../container-image-builds/images/ploinky-box/Dockerfile
- Modify: ../container-image-builds/images/ploinky-box/entrypoint.sh

**Steps**

- [ ] Prepare Node, npm/npx, Git, slirp4netns, directories, marker, ownership,
      and entrypoint in an intermediate Podman filesystem stage.
- [ ] Copy the complete prepared root filesystem into a clean scratch stage.
- [ ] Restore only the approved contract-2 metadata.
- [ ] Add no VOLUME and no CMD.
- [ ] Add identity and forced-sandbox entrypoint assertions.
- [ ] Preserve mounted-source and dependency-volume assertions.
- [ ] Preserve Podman information and nested-container readiness checks.
- [ ] Replace blanket podman rm -af with all-state, exact-key/value label
      enumeration and removal.
- [ ] Fail clearly if managed-container enumeration or removal fails.
- [ ] Preserve unlabelled/manual nested containers, nested images, and named
      volumes.
- [ ] Confirm file ownership, setuid helpers, and Podman behavior survive the
      filesystem copy.
- [ ] Run static tests and a local native build where available.

### Task 4: Gate the Mutable Multiarchitecture Workflow

**Files**

- Modify: ../container-image-builds/.github/workflows/publish-ploinky-box-image.yml
- Modify: ../container-image-builds/README.md

**Steps**

- [ ] Delete the immutable-tag-unused registry guard.
- [ ] Keep workflow-level concurrency serialization.
- [ ] Build amd64 on a native amd64 runner and arm64 on a native arm64 runner.
- [ ] Push candidates by digest without moving the runtime tag.
- [ ] Inspect complete metadata on each digest.
- [ ] Verify mounted Ploinky source and dependency installation flow.
- [ ] Verify entrypoint health, outer identity, Podman information, and nested
      Alpine on each architecture.
- [ ] Verify running and stopped managed=1 targets are removed while unlabelled,
      managed=0, and near-name controls remain on each architecture.
- [ ] Seed a nested image and a named-volume sentinel before restart and verify
      both remain afterward.
- [ ] Upload digest artifacts only after all per-architecture checks pass.
- [ ] Merge both digests into docker.io/assistos/ploinky-box:runtime.
- [ ] Inspect and print the final manifest digest and both platforms.
- [ ] Do not dispatch the workflow during implementation without separate
      authorization.

### Task 5: Write Failing Contract-2 Supervisor Tests

**Files**

- Modify: tests/helpers/runtimeSupervisorHarness.mjs
- Modify: container/runtime-supervisor-tests.mjs
- Modify: tests/unit/runtimeSupervisor.test.mjs only if discovery changes

**Steps**

- [ ] Model complete contract-2 image metadata.
- [ ] Model a mutable pull changing tag-to-ID resolution.
- [ ] Model image-declared anonymous volumes so inherited-volume regressions
      fail tests.
- [ ] Model named-volume preservation and anonymous-volume cleanup separately.
- [ ] Require pull even when the create tag already exists locally.
- [ ] Require no pull for compatible reuse or stopped start.
- [ ] Require pull/validation before current-contract replacement shutdown.
- [ ] Require run by validated image ID and requested-reference label.
- [ ] Require field-specific contract errors.
- [ ] Require contract-1 ordinary commands to fail without mutation.
- [ ] Require no legacy volume copying, adoption, mapping, or attachment.
- [ ] Require status/stop/destroy to remain usable and pull-free.
- [ ] Require named volumes to survive destroy and subsequent recreation.
- [ ] Require rollback to restore prior ID, labels, configuration, and volumes.
- [ ] Confirm these tests fail against the contract-1 implementation.

### Task 6: Implement Contract-2 Supervisor Semantics

**Files**

- Modify: container/runtime-contract.mjs
- Modify: container/runtime-supervisor.mjs
- Modify: container/runtime-engine.mjs only if required

**Steps**

- [ ] Change default reference and required contract.
- [ ] Remove legacy official image aliases and automatic legacy replacement.
- [ ] Normalize all required image fields for Docker and Podman inspect shapes.
- [ ] Add complete validation with field-specific errors.
- [ ] Store requested reference separately from deployed image ID.
- [ ] Add requested-image and configuration/provenance labels.
- [ ] Run new containers from validated IDs.
- [ ] Pull unconditionally for create and intentional current-contract
      replacement.
- [ ] Preserve no-registry behavior for reuse/stopped start.
- [ ] Reject incompatible existing boxes before planner or mutation.
- [ ] Keep transactional replacement and rollback for contract-2 boxes.
- [ ] Preserve engine parity.

### Task 7: Implement Volume-Preserving Destroy

**Files**

- Modify: container/runtime-supervisor.mjs
- Modify: container/runtime-supervisor-tests.mjs
- Modify: tests/unit/helpLayers.test.mjs
- Modify: container/smoke-runtime.mjs

**Steps**

- [ ] Update confirmation to name the box and state that named volumes remain.
- [ ] Directly force-remove the confirmed outer box without invoking core stop
      or a separate outer stop.
- [ ] Remove anonymous volumes attached to the selected box while preserving
      every explicitly named volume.
- [ ] Stop treating existing volumes without a box as something destroy removes.
- [ ] Make missing-box destroy idempotent even when retained volumes exist.
- [ ] Verify refusal mutates nothing.
- [ ] Verify only the selected box is removed.
- [ ] Verify all three named volumes remain inspectable.
- [ ] Recreate the box and prove retained state is mounted.
- [ ] Clean smoke-test volumes explicitly in a test-only finally path.

### Task 8: Force Nested Podman

**Files**

- Modify: cli/services/docker/common.js
- Modify: cli/services/docker/agentServiceManager.js
- Modify: cli/services/sandboxRuntime.js
- Modify: cli/commands/sandboxCommands.js
- Modify: tests/unit/sandboxRuntime.test.mjs
- Modify: relevant container runtime tests

**Steps**

- [ ] Detect the managed box marker and require Podman.
- [ ] Reject Docker fallback inside the box.
- [ ] Make the forced environment override workspace sandbox configuration.
- [ ] Make lite-sandbox manifests resolve to Podman in the box.
- [ ] Centralize the io.assistos.ploinky.managed=1 run argument for every
      Ploinky-owned nested container creation path.
- [ ] Audit main agents, helper/sidecar containers, retries, and recreation
      paths so none can omit or override the ownership label.
- [ ] Inspect one container from every real Ploinky creation variant and assert
      the exact ownership label, including main agents and each helper/sidecar
      kind.
- [ ] Prove user-created or otherwise unlabelled nested containers are never
      selected by Ploinky cleanup.
- [ ] Make sandbox status report forced Podman.
- [ ] Make sandbox enable fail or report ineffective as approved.
- [ ] Preserve master-compatible bwrap/Seatbelt/container selection outside the
      box.
- [ ] Prove ordinary agent images remain unprivileged and contain no container
      engine.

### Task 9: Implement the Argument Boundary and Deterministic Identity

**Files**

- Modify: container/runtime-supervisor.mjs
- Modify: container/runtime-supervisor-tests.mjs
- Modify: container/README.md
- Modify: README.md

**Steps**

- [ ] Refactor host parsing around D1 and D2.
- [ ] Support a pre-command double-dash boundary.
- [ ] Preserve every post-command ordinary token exactly.
- [ ] Preserve bare REPL and parameterless cli routing.
- [ ] Preserve start positional port, profile, branch, and inferred branch.
- [ ] Remove public --name and --engine parsing and help.
- [ ] Derive an engine-safe readable name from exact-cwd realpath plus a
      12-character SHA-256 suffix.
- [ ] Derive all three volume names from the same instance identity.
- [ ] Add non-sensitive identity-schema and path-hash labels.
- [ ] Search both installed engines for an existing deterministic box.
- [ ] Use the sole owning engine, fail when both own it, and prefer functional
      Podman then functional Docker for a missing box.
- [ ] Reject invalid lifecycle tails.
- [ ] Add a collision matrix for every outer option through agent CLI.
- [ ] Add the same matrix through client tool arbitrary fields.
- [ ] Test flag=value, flag value, repeated values, ordering, and double dash.
- [ ] Test symlink equivalence, same-basename separation, child-directory
      separation, move/rename behavior, engine installation changes, and
      cross-engine ambiguity.
- [ ] Update canonical examples to put outer options before commands.
- [ ] Remove the old parser behavior directly without a transition warning.

### Task 10: Extract Side-Effect-Limited Graph Preparation

**Files**

- Modify: cli/services/bootstrapManifest.js
- Modify: cli/services/workspaceDependencyGraph.js
- Add: cli/services/boxStartPublishPlan.js
- Add: container/box-start-publish-plan.mjs
- Modify: tests/unit/workspaceDependencyGraph.test.mjs
- Add: focused tests for boxStartPublishPlan

**Steps**

- [ ] Separate repository installation/branch preparation from enableAgent and
      nested-container startup.
- [ ] Accept an explicit workspace/root profile without prematurely persisting
      it.
- [ ] Reuse core bare/qualified lookup and enabled-repository precedence.
- [ ] Reuse SSO gating and directive parsing.
- [ ] Serialize deterministic node, edge, alias, and profile data.
- [ ] Reject incompatible profile selection for one effective instance under
      D11.
- [ ] Emit versioned JSON without unrelated stdout contamination.
- [ ] Prove planning can clone/switch repos but cannot enable/start agents.
- [ ] Prove a conflicting sibling host checkout never affects the plan.
- [ ] Prove branch policy selects the same manifest core start will use.

### Task 11: Generalize Claim Collection

**Files**

- Modify: container/box-publish-planner.mjs
- Modify: container/publish-spec.mjs only if needed
- Modify: tests/unit/boxPublishPlanner.test.mjs

**Steps**

- [ ] Delete Explorer constants, spellings, and host directory aliases.
- [ ] Consume authoritative resolved nodes rather than discovering host files.
- [ ] Include root, dependency, alias, and approved extra-enabled-agent claims.
- [ ] Preserve current TCP/UDP/range parsing and explicit override semantics.
- [ ] Add reserved router conflict diagnostics.
- [ ] Implement D9 port-zero policy.
- [ ] Add generic bare, slash, and colon root tests.
- [ ] Add ambiguity, missing manifest, cycle, alias, profile fallback, explicit
      edge profile, SSO, protocol, range, and overlap tests.

### Task 12: Integrate Planning with Reconciliation

**Files**

- Modify: container/runtime-supervisor.mjs
- Modify: container/runtime-contract.mjs
- Modify: tests/helpers/runtimeSupervisorHarness.mjs
- Modify: container/runtime-supervisor-tests.mjs

**Steps**

- [ ] Add a scoped workspace planning lock.
- [ ] Execute planner in the existing compatible box when possible.
- [ ] Add short-lived planner-container execution for a missing box.
- [ ] Ensure pull/validation precedes a missing-box planner container.
- [ ] Ensure planner failure starts no agent/router and does not replace the
      current outer box.
- [ ] Merge router, explicit, and generated publications.
- [ ] Persist and inspect publication provenance labels.
- [ ] Replace stale generated claims while preserving explicit claims.
- [ ] Treat missing/unsupported publication provenance as an incompatible box
      configuration and require explicit destroy/recreate.
- [ ] Reconcile before forwarding core lifecycle commands.
- [ ] Prove add/remove/profile/branch publication changes trigger one
      transactional replacement.
- [ ] Prove replacement rollback restores prior publications and labels.
- [ ] Prove named volumes survive every path.

### Task 13: Cover Every Agent-Starting Path

**Files**

- Modify: container/runtime-supervisor.mjs
- Modify: cli/services/docker/agentServiceManager.js
- Modify: cli/services/docker/common.js
- Modify: relevant CLI/runtime tests

**Steps**

- [ ] Define planner requests for start with and without a root.
- [ ] Define planner requests for enable, cli AGENT, restart, and reinstall.
- [ ] Include agents core will actually launch under D8.
- [ ] Pass the approved outer publication contract into core.
- [ ] Check publication coverage immediately before nested agent creation.
- [ ] Allow REPL starts when coverage is already sufficient.
- [ ] Fail closed before REPL agent start when an outer replacement is needed.
- [ ] Print an actionable one-shot host command in that error.
- [ ] Never mount the host engine socket or grant agent containers sibling
      control.

### Task 14: Synchronize Documentation

**Files**

- Modify: README.md
- Modify: container/README.md
- Modify: docs/code-derived-agent-lifecycle.md
- Modify: docs/specs/DS003-agent-manifest-and-registry.md
- Modify: docs/specs/DS004-runtime-execution-and-isolation.md
- Modify: docs/specs/DS007-dependency-caches-and-startup-readiness.md
- Modify: ../container-image-builds/README.md

**Steps**

- [ ] Replace “Graph-driven Explorer publishes” with generic active runtime
      publication semantics.
- [ ] Document authoritative workspace planning.
- [ ] Document the one-shot versus REPL boundary.
- [ ] Document prefix outer arguments and exact downstream forwarding.
- [ ] Document contract 2, mutable tag, ID pinning, and refresh behavior.
- [ ] Document the hard-cut contract-1 transition: old volumes remain manual,
      while contract 2 starts with fresh path-hashed volumes.
- [ ] Document destroy as container removal, not data cleanup.
- [ ] Document manual named-volume cleanup for operators who want a full reset.
- [ ] Document forced nested Podman.
- [ ] Document selective managed-container boot cleanup, the ownership label,
      and the lack of lifecycle guarantees for unlabelled/manual containers.
- [ ] Update help/documentation assertions.

### Task 15: Full Verification and Release Gates

**Steps**

- [ ] Run all focused image-definition tests.
- [ ] Run all focused supervisor, planner, graph, sandbox, help, and runtime
      tests.
- [ ] Run the complete Ploinky repository test suite.
- [ ] Run the complete container-image-builds test suite.
- [ ] Build the image locally on available native architecture.
- [ ] After separate approval, publish contract 2 through the GitHub workflow.
- [ ] Record the resulting runtime manifest digest.
- [ ] Inspect both published platforms and complete contract metadata.
- [ ] Run the public Ploinky smoke against the published image on real Podman.
- [ ] Audit that creation adds exactly three named mounts and no anonymous
      mounts.
- [ ] Prove nested Podman can pull/run Alpine.
- [ ] Prove box restart removes labelled Ploinky-managed nested containers and
      preserves an unlabelled manual control container.
- [ ] Prove both running and stopped managed=1 records are removed while
      unlabelled, managed=0, and near-name controls remain.
- [ ] Prove a preloaded nested image and named-volume sentinel survive restart.
- [ ] Inject managed-container enumeration and removal failures and prove the
      entrypoint exits nonzero with actionable diagnostics.
- [ ] Prove generic non-Explorer openPorts cross both nested and outer
      boundaries.
- [ ] Prove destroy removes the box but retains all named volumes.
- [ ] Prove recreation uses retained workspace, dependency, and nested storage.
- [ ] Release Ploinky only after the published-image smoke passes.

## Verification Commands

Run from the multi-repository workspace unless a task says otherwise.

~~~bash
cd /home/skutner/work/file-parser/container-image-builds
node --test tests/image-definitions.test.mjs

cd /home/skutner/work/file-parser/ploinky
node --test \
  tests/unit/runtimeSupervisor.test.mjs \
  tests/unit/boxPublishPlanner.test.mjs \
  tests/unit/workspaceDependencyGraph.test.mjs \
  tests/unit/sandboxRuntime.test.mjs \
  tests/unit/helpLayers.test.mjs

npm test
~~~

Real engine and published-image smoke commands must use isolated temporary
working directories and test-only ports. Test cleanup may explicitly remove
its own named volumes in a finally path even though public destroy preserves
them.

## Acceptance Matrix

| Invariant | Required proof |
| --- | --- |
| Outer box | Contract-2 image runs with Podman, mounted Ploinky source, and exactly three named mounts |
| Nested agents | Every box agent runtime resolves to nested Podman; no Docker/bwrap/Seatbelt path remains effective |
| Nested boot cleanup | Restart removes running/stopped containers only for exact io.assistos.ploinky.managed=1; real Ploinky creation variants carry it, controls do not match, and nested images/named volumes remain |
| Command surface | Bare REPL and parameterless cli Bash remain unchanged |
| Special lifecycle | Help/status/stop/destroy keep approved host behavior |
| Destroy | Removes only selected box and retains all named volumes |
| Pull policy | Pull on create/replacement; no pull on reuse/stopped start/status/stop/destroy |
| Mutable safety | Run by validated ID and retain requested tag as metadata |
| Legacy | Contract 1 is never migrated; old named volumes remain untouched and contract 2 uses fresh path-hashed volumes |
| openPorts | Arbitrary active agents, profiles, aliases, branches, and dependencies receive matching outer publications |
| Dynamic safety | Port conflicts and unsupported port zero fail before agent/router start |
| Stale ports | Generated ports disappear when graph/profile changes; explicit ports survive |
| Provenance | Every supported contract-2 box has versioned publication labels; unlabelled boxes fail closed |
| Argument safety | Agent CLI and MCP payload flags are forwarded exactly and never mutate the box accidentally |
| Instance identity | Exact-cwd realpath deterministically selects one readable path-hashed box without a public override |
| Engine discovery | Existing boxes remain discoverable across Podman/Docker availability changes; cross-engine duplicates fail closed |
| Rollback | Failed replacement restores prior ID/config/labels and retains volumes |
| Platforms | Published runtime contains verified linux/amd64 and linux/arm64 images |

## Rollout Order

| Order | Release action | Gate |
| --- | --- | --- |
| 1 | Merge container-image-builds implementation | Static and local image checks pass |
| 2 | Dispatch image publication after explicit approval | Both architecture gates pass |
| 3 | Record and independently inspect runtime manifest digest | Contract-2 metadata and nested Podman verified |
| 4 | Merge Ploinky implementation | Focused and complete tests pass |
| 5 | Run Ploinky public-image smoke | Real create, nested runtime, ports, destroy, and retained state pass |
| 6 | Release Ploinky | All preceding gates complete |

Existing released Ploinky versions remain pinned to the immutable contract-1
image. The runtime tag is introduced only for the new contract-2 supervisor.

## Rollback

| Failure | Recovery |
| --- | --- |
| Bad runtime tag before Ploinky release | Move runtime back to a previously verified contract-2 digest |
| Bad runtime tag after boxes exist | Existing boxes retain their current IDs; publish a fixed digest, then explicitly destroy/recreate |
| New Ploinky encounters contract 1 | Keep ordinary commands blocked; never copy/adopt its volumes; leave old named volumes for manual recovery |
| Contract-2 replacement fails | Restore prior contract-2 ID and complete creation configuration |
| Ploinky code rollback after contract 2 | Prefer a forward fix; old contract-1 supervisor compatibility is not guaranteed |
| Planner defect | Fail before core start/replacement where possible; retain prior box and named volumes |

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Planner and core resolve different graphs | Reuse core services and authoritative workspace repos; test branch/profile equivalence |
| Planner mutates repos before final create | Limit side effects to required repo preparation and use workspace locking |
| Outer ports cannot change live | Plan before agent start and replace transactionally |
| REPL cannot replace its own box | Fail closed with a one-shot host instruction |
| Mutable tag changes between validation and run | Run validated image ID |
| A nested creation path omits the ownership label | Centralize label injection, audit every helper/sidecar path, and test all creation variants |
| Selective cleanup accidentally reaches manual containers | Match the exact ownership label and keep an unlabelled control container in runtime gates |
| A manual container is stale after an unclean outer shutdown | Leave it untouched, make no automatic-recovery promise, and document manual inspection/removal |
| Destroy leaves stale workspace process files | Test direct destroy/recreate recovery and adjust startup cleanup without deleting user data |
| Anonymous-volume cleanup accidentally affects persistent data | Inspect mounts and test that Docker/Podman retain every explicitly named volume |
| Publication labels exceed practical size | Keep versioned compact normalized publish records and add size/error tests |
| Existing unlabelled port provenance is unknowable | Treat the box configuration as unsupported and require explicit destroy/recreate |
| Native arm64 nested Podman differs from amd64 | Require native per-architecture runtime gates before manifest merge |
| Moving or renaming a workspace leaves retained resources at the old identity | Document the behavior and provide manual engine cleanup instructions |
| The same identity exists in Podman and Docker | Fail read-only with both locations; never guess or mutate |

## Out of Scope

- Automatic registry polling or rolling replacement of compatible running boxes.
- Mounting the host Docker/Podman socket into the box.
- Granting ordinary agent containers control of sibling containers.
- A new public box lifecycle namespace.
- Automatic deletion of retained named volumes.
- General host networking for the outer box.
- Silently treating openPorts host port zero as private.
- Public instance-name or host-engine override flags.
- Automatic contract-1 container or volume migration/adoption.
- Removing the current profile system or collapsing it to one default profile.
- Automatic restart, repair, or deletion of unlabelled/manual nested
  containers.
- Changes to AchillesAgentLib.
