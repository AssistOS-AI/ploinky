# Ploinky Box Invariant Alignment Implementation Plan

Date: 2026-07-11
Status: implementation and authorized publication in progress (D1-D12 and R1-R6 approved); final published-image and local-deployment gates pending

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

This plan spans three repositories:

| Repository | Responsibility |
| --- | --- |
| container-image-builds | Build, validate, and publish the contract-2 runtime image |
| ploinky | Supervise the outer runtime, plan publications, forward commands, and run nested agents |
| AssistOSExplorer | Replace OnlyOffice's unsupported ephemeral openPorts claim with the approved `127.0.0.1:17002:7000` mapping in every profile, leaving LiveKit on `17000` |

## Review and Execution Boundary

This document began as the approved plan. The owner subsequently authorized
implementation, repository pushes, the image publication workflow, and the
local acceptance deployment. It remains the execution and verification record.

- D1 through D12 and R1-R6 are approved. No design approvals remain.
- Image publication is authorized, but dispatch occurs only after the exact
  implementation commits are pushed and all pre-publication checks pass.
- Publish and verify the contract-2 image before releasing Ploinky code that
  requires it.
- Preserve the existing modified ploinky/node_modules/achillesAgentLib
  submodule. It is outside this plan and must not be reset, staged, or edited.
- Preserve unrelated changes in all three repositories.

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
| Host engine environment override | Remove PLOINKY_BOX_ENGINE; setting it has no effect on public engine resolution |
| Unreachable host engine | Treat any installed engine that cannot answer as unknown; allow help and partial nonzero status only, and block every other public command before action |
| Start-tail port flags | Accept prefix --port and positional start AGENT PORT only; reject start-tail --port VALUE and --port=VALUE before outer reconciliation or core mutation |
| OnlyOffice control port | Keep general port-zero rejection and use 127.0.0.1:17002:7000 in default, dev, and prod; LiveKit remains on 17000, editor mappings remain 8082/18082 to 8080, and storage 9100 remains unpublished |
| Cross-engine retained resources | Treat the deterministic box and labelled named volumes as one engine-owned set; sole resource owner wins, split or foreign ownership fails closed, and Podman-first applies only to an empty identity |
| Bare static-agent resolution | From an empty workspace, prepare default boot repositories without enabling or starting agents, then resolve a unique bare root exactly like its qualified forms; require qualification only for genuine ambiguity |
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

| ID | Decision | Approved behavior |
| --- | --- | --- |
| D1 | Outer argument boundary | Parse outer options only before the core command, support an explicit double-dash boundary, and preserve downstream argv exactly |
| D2 | Instance and host-engine selectors | Remove public --name and --engine; derive identity from exact-cwd realpath and discover the owning engine automatically |
| D3 | Parser migration | Apply the new grammar as a hard cut without a warning release |
| D4 | Destroy sequence | After confirmation, directly force-remove the outer box without in-box core stop or a separate outer stop |
| D5 | Destroy volume cleanup | Remove attached anonymous volumes while retaining every explicitly named volume |
| D6 | Contract-1 transition | Make a hard cut with no migration, copying, adoption, or mapping; contract 2 uses fresh path-hashed volumes |
| D7 | openPorts command boundary | Pre-plan every one-shot host path that can start agents; REPL starts proceed only with sufficient existing publication coverage |
| D8 | Effective started set | Plan the requested active graph plus enabled agents core will actually launch; exclude merely installed agents |
| D9 | Manifest host port zero | Reject openPorts box-side port zero before outer mutation or agent startup |
| D10 | Publication provenance | Require supported contract-2 boxes to carry versioned explicit/generated publication provenance; never infer missing provenance |
| D11 | Profile conflicts | Retain profiles, but reject conflicting profiles for the same canonical-or-alias effective instance before mutation |
| D12 | Nested storage cleanup on box boot | Replace blanket podman rm -af with exact-label removal of Ploinky-managed nested containers; preserve unrelated/manual containers, images, and named volumes |

D1 through D12 were approved before execution authorization; implementation and
publication are now separately authorized under the boundary above.

## Completed Post-Review Decision Record

| ID | Decision | Approved behavior |
| --- | --- | --- |
| R1 | PLOINKY_BOX_ENGINE | Remove the environment override completely; public commands always use automatic engine discovery, unit tests inject engines through internal seams, and real smoke tests exercise public discovery |
| R2 | Unreachable installed engine | Classify each installed engine as owns, absent, or unknown; if either is unknown, help remains local, status reports partial state and exits nonzero, and every other public command fails before pull, start, exec, stop, destroy, or other mutation |
| R3 | Start-tail --port | Keep prefix `ploinky --port PORT start AGENT` and positional `ploinky start AGENT PORT`; reject both `start AGENT --port PORT` and `start AGENT --port=PORT` in the host planner and in-box core before reconciliation or mutation, while forwarding post-command --port unchanged for non-start commands |
| R4 | OnlyOffice port zero | Retain D9's general rejection of box-side port zero; replace all three OnlyOffice profile claims with `127.0.0.1:17002:7000`, preserve loopback-only binding, leave LiveKit on `17000`, leave editor/storage topology unchanged, and reject any 17002 conflict before mutation |
| R5 | Cross-engine retained resources | Inventory the exact box and three explicitly labelled volumes on every answering engine; use the sole resource owner, create missing roles only on a later permitted creation path, fail on split/foreign resources, and use Podman-first only when neither engine has any identity resource |
| R6 | Empty-workspace bare root | `ploinky start explorer --branch=ploinky-box` must prepare the default boot repositories without enable/start mutation, resolve to the same canonical root, selected commit, graph, claims, and publications as `AchillesIDE/explorer` and `AchillesIDE:explorer`, and require qualification only when bare lookup is genuinely ambiguous |

All design decisions, implementation, and image publication are authorized.
Publication still follows the ordered gates in this plan.

## Target Public Behavior

### Command Routing

| Invocation | Host behavior |
| --- | --- |
| ploinky or p-cli | Reconcile/start compatible box; exec the Ploinky REPL |
| ploinky cli | Reconcile/start compatible box; exec Bash interactively |
| ploinky cli AGENT ARGS | Ensure required outer publications; forward the exact agent CLI argv |
| ploinky start ... | Plan authoritative active publications; reconcile; forward core start; probe router |
| ploinky enable ... | Pre-plan any agent start caused by enable; reconcile before forwarding |
| ploinky shell AGENT | Pre-plan the selected agent before attaching; reconcile before forwarding |
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
| Invalid lifecycle tails | For status, stop, and destroy, reject creation flags and unknown trailing values |
| Start router port | Accept canonical prefix --port and positional start AGENT PORT; reject start-tail --port VALUE and --port=VALUE before reconciliation or mutation |
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

For start only, both the host planner and in-box core parser reject
`--port VALUE` and `--port=VALUE` after the command. The host form fails before
box reconciliation; the REPL form fails before profile, registry, hook, router,
or agent mutation. The diagnostic gives both accepted replacements:

~~~text
start: --port must precede 'start'.
Use: ploinky --port 9192 start explorer
  or: ploinky start explorer 9192
~~~

Post-command --port remains an ordinary downstream token for every non-start
command, including agent CLI and client tool payloads.

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

PLOINKY_BOX_ENGINE is also removed. The supervisor never reads it, and setting
it has no effect. Tests may select an engine only through injected internal
dependencies; public smoke tests exercise automatic discovery.

An engine is installed when its executable is found on PATH. Probe every
installed engine independently and do not stop after finding one owner. Each
probe has exactly one result:

| Result | Required evidence |
| --- | --- |
| owns | Engine health succeeds and exact-name container inspection succeeds |
| absent | Engine health succeeds and inspection conclusively reports that the exact name is not found |
| unknown | Health or inspection times out, the daemon/machine is offline, access is denied, output is malformed, or the failure is not a recognized not-found result |

A missing executable is not installed and therefore is not unknown. Ploinky
does not start engines automatically and does not reinterpret unknown as
absent.

Approved R2 handling is exact:

| Observed state | Behavior |
| --- | --- |
| Either installed engine is unknown | help remains local; status reports every available result and exits nonzero; every other public command fails before pull, start, exec, stop, destroy, or other mutation |
| Both engines own the exact name | Fail with an ambiguity error and mutate neither |
| Exactly one engine owns it and neither is unknown | Do not select yet; complete the R5 container-and-volume inventory on both engines, then select or fail from the complete resource set |
| Neither owns it and neither is unknown | Complete the R5 deterministic-resource inventory below |
| Neither engine is installed | Fail because no host engine is available |

The failure names the unknown engine, its probe error, the exact box identity,
and the command needed to make that engine answer. This strict rule means an
installed but stopped, otherwise unused Docker daemon or Podman machine blocks
all public commands except help and partial status until it becomes reachable.

### Deterministic Resource Ownership

Approved R5 treats the exact box and its three named volumes as one engine-owned
identity. Contract 2 explicitly creates volumes instead of relying on implicit
`-v NAME` creation. Each volume carries only these labels:

| Label | Required value |
| --- | --- |
| io.assistos.ploinky.identity-schema | 1 |
| io.assistos.ploinky.path-hash | The approved 12-character lowercase path hash |
| io.assistos.ploinky.volume-role | workspace, containers, or ploinky-deps, matching the exact volume name |

No absolute path is stored. An exact-named volume with a missing, malformed, or
mismatched ownership label is foreign/unsupported and is never attached,
renamed, migrated, or deleted automatically.

Here, `owns` means only that exact-name container inspection succeeded; it does
not imply that the container has passed contract or provenance validation. After
R2 proves every installed engine can answer, inventory the exact container and
all three exact volume names on both engines before selecting an engine:

| Inventory | Behavior |
| --- | --- |
| Identity resources exist on exactly one engine | Select that engine, regardless of Podman preference |
| An exact-name box exists on one engine and any same-identity resource exists on the other | Fail as split ownership and mutate neither; validate the selected box contract only after ownership is unambiguous |
| Labelled identity volumes exist on both engines, with or without a box | Fail as split ownership and mutate neither |
| No box and only a partial valid volume set exists on one engine | Select that engine without creating anything during inventory; status reports the incomplete set and exits nonzero, while a later permitted planner/create path creates each missing role there with the required labels before attachment |
| No container or volume exists on either engine | Select answering Podman first; if Podman is not installed, select answering Docker |
| Any exact-named volume is foreign/unsupported | Fail closed with both inventories and manual recovery instructions |

With no box and a sole valid volume owner, stop reports already stopped and
destroy reports the box absent while preserving the volumes. Split or foreign
ownership makes status report both inventories and exit nonzero; local help
remains available, and every other public command fails before mutation. Ploinky
never merges resource sets or offers a selector override.

An engine whose executable is not installed cannot be inventoried under R2. If
it is reinstalled later, any resulting cross-engine resource split is detected
and fails closed on the next command.

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
| _CONTAINERS_USERNS_CONFIGURED | empty string |
| BUILDAH_ISOLATION | chroot |
| PATH | /opt/ploinky/bin:/usr/local/bin:/usr/bin |
| WorkingDir | /workspace |
| Entrypoint | /usr/local/bin/ploinky-box-entrypoint |
| Command | absent or empty |
| Config.Volumes | absent or empty |

The existing Podman base declares rootful storage metadata that cannot be
removed by a normal child Dockerfile. The image must therefore prepare its
filesystem in an intermediate stage and copy the complete filesystem into a
clean FROM scratch final stage. The final stage explicitly restores every
required configuration field. This table is the authoritative contract for
both the official and custom contract-2 images; supervisor validation must
check every field rather than treating the label as sufficient.

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
| Rootless mapping | Both helpers are root-owned; newuidmap has cap_setuid=ep or setuid-root, newgidmap has cap_setgid=ep or setuid-root, and Podman receives the configured subordinate UID/GID ranges |
| Nested execution | Nested Alpine runs successfully |
| Boot cleanup | Running and stopped containers with the exact managed=1 label are removed; unlabelled, managed=0, and near-name controls remain |
| OCI metadata | Contract, user, environment, workdir, entrypoint, command, and volumes match exactly |
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
- missing or wrong USER, HOME, workspace, sandbox, container, user-namespace,
  Buildah-isolation, or PATH environment;
- wrong working directory;
- wrong or malformed entrypoint;
- any nonempty default command;
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

Approved destroy behavior applies only after R2/R5 discovery has completed and
identified a supported empty or sole-engine-owned identity. An unknown installed
engine, split ownership, or any foreign exact-name resource blocks destroy before
the confirmation prompt and before mutation; local help remains independent of
discovery.

| State | Result |
| --- | --- |
| Box absent, volumes absent | Idempotent success |
| Box absent, named volumes present | Report box already absent; leave volumes untouched and do not prompt |
| Box present, confirmation declined | No mutation |
| Box present, confirmation accepted | Directly remove selected outer box and its anonymous volumes; retain all named volumes |
| Next ordinary invocation for a destroyed contract-2 identity | Select the sole labelled resource-owning engine, pull contract 2, plan, and recreate with the retained volumes |
| First contract-2 invocation with legacy basename-only resources present | Create fresh path-hashed volumes; do not attach or mutate legacy volumes |

The prompt must identify the box and explicitly state that the three named
volumes will be retained. It must not imply a clean-data reset.

Explicit destroy and failed-container cleanup both remove only anonymous
volumes associated with the selected container. Docker and Podman preserve
explicitly named mounts when the container is removed with the volume-cleanup
flag. Tests must audit the before/after inventory and prove the three managed
names remain. Contract 2 prevents new instances of the legacy inherited
/var/lib/containers anonymous-volume defect.

Volume ownership labels survive destroy and are verified before every reuse.
Destroy never removes or rewrites those labels.

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
Bare and slash-qualified Explorer forms therefore enter product-specific
planning, while colon-qualified forms bypass it entirely. A spelling must never
decide whether publication planning runs. The host-sibling traversal also fails
before core repository preparation when a manifest-declared dependency checkout
is missing or incomplete.
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

For D11, an effective-instance key is canonical repo/agent plus either the
canonical instance or the normalized alias; profile is deliberately not part of
that key. Repeated paths selecting the same profile dedupe. Paths selecting
different profiles for the same key fail with both dependency paths and profile
names. Distinct aliases are distinct keys and may select different profiles.

The planner may install or switch repository checkouts required to resolve the
requested graph. It must not enable an agent, create a nested container, run a
hook, or start the router.

Repository installation and branch switching are the planner's only permitted
preparation mutations. In this section, failure "before operational mutation"
means before profile persistence, agent registry/config writes, hooks, router or
nested-container lifecycle, or outer-box reconciliation. Planner-created or
changed checkouts must be included in diagnostics and remain available for retry.

Approved R6 makes first-use bare resolution explicit. In an empty workspace, the
planner first reuses a side-effect-limited form of core boot-repository
preparation, including the predefined logical `AchillesIDE` mapping to the
AssistOSExplorer repository. It then resolves `explorer` through the normal
enabled/installed precedence and applies the requested branch policy to the
resolved owner. `explorer`, `AchillesIDE/explorer`, and
`AchillesIDE:explorer` must produce the same canonical `AchillesIDE/explorer`
root, selected checkout commit, graph, claims, and publications. If more than one
eligible repository exposes `explorer`, the bare form fails after allowed
repository preparation but before operational mutation, with qualified
alternatives; an explicit qualified form continues to select only its named
repository. The planner never silently prefers `AchillesIDE` merely because it is
a boot repository. Qualification is not required merely because the workspace
started empty.

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
| Stopped compatible box | Keep the managed box stopped; run a short-lived planner container from its inspected image ID and named workspace/source mounts |
| Missing box | Pull and validate image; run a short-lived planner container with the deterministic named workspace and source mount; then create the final box from the same image ID |
| Incompatible box | Refuse before planning and require explicit destroy |

The temporary planner container has no published ports and never becomes the
managed outer instance. It overrides the normal image entrypoint and invokes
`node /opt/ploinky/container/box-start-publish-plan.mjs` directly, never
`bin/ploinky`. The planner import graph must work with an empty node_modules,
must never prompt, and must reserve stdout exclusively for one versioned JSON
document.

Temporary planner names are unique. Success, failure, signal, and timeout paths
remove the temporary container and its anonymous volumes in a finally path,
while retaining deterministic named mounts. Any deterministic workspace volume
created before a first-start planning failure remains for reuse on retry; public
destroy does not delete it, so the operator documentation must give the exact
engine-level cleanup command.

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
| Explicit publish | Preserve spelling/order; subtract explicit target intervals from generated claims and emit deterministic uncovered subranges so only fully covered sockets disappear |

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

1. When no publish/expose option is present, retain the prior ordered explicit
   set. When either option is present, replace it with the invocation's exact
   ordered explicit set.
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

- host start, enable, cli AGENT, shell AGENT, restart, and reinstall pre-plan;
- core command handlers perform publication preflight before profile, config,
  registry, hook, router, or nested-runtime mutation;
- core agent startup verifies that the outer publication contract covers the
  agent’s effective openPorts as defense in depth before create, start, restart,
  or recreate;
- a REPL command whose required publications are already present proceeds;
- a non-reconciling in-box path, including REPL and Marketplace enable, that
  requires new/changed publications fails before any command mutation and
  returns an actionable host one-shot instruction;
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
| cli/services/ploinkyboot.js | Share side-effect-limited default boot-repository preparation with the planner |
| cli/services/workspaceDependencyGraph.js | Explicit profile/root/alias inputs and deterministic serializable nodes |
| cli/services/boxStartPublishPlan.js | New authoritative side-effect-limited plan service |
| container/box-start-publish-plan.mjs | New small internal JSON entrypoint |
| cli/services/docker/common.js | Marker-aware forced Podman and publication coverage helpers |
| cli/services/docker/agentServiceManager.js | Managed-container ownership labels and fail-closed outer publication coverage before agent start |
| cli/services/docker/interactive.js | Ownership labels on both persistent interactive create variants |
| cli/services/docker/shellDetection.js | Ownership label on ephemeral shell-probe containers |
| cli/services/dependencyRuntimeKey.js | Ownership label on ephemeral runtime-key probe containers |
| cli/services/dependencyCache.js | Ownership label on ephemeral dependency-install containers |
| cli/server/containerMonitor.js | Monitor restart coverage guard and nonfatal denial behavior |
| cli/commands/cli.js | Command-boundary coverage for direct restart and other REPL lifecycle paths |
| cli/services/workspaceUtil.js | Command-boundary coverage for start, CLI, shell, and reinstall paths |
| cli/services/agents.js | Pre-mutation coverage before enable persists registry/workspace state |
| cli/server/authHandlers/marketplaceRoutes.js | Actionable non-mutating coverage denial for Marketplace enable |
| cli/services/sandboxRuntime.js | Effective forced state inside box |
| cli/commands/sandboxCommands.js | Accurate status/enable behavior |
| tests/helpers/runtimeSupervisorHarness.mjs | Contract-2 images, mutable pulls, planner calls, labels, volume semantics |
| container/runtime-supervisor-tests.mjs | Full supervisor, parser, lifecycle, planning, and rollback matrix |
| tests/unit/boxPublishPlanner.test.mjs | Generic graph/claim tests |
| tests/unit/workspaceDependencyGraph.test.mjs | Profile, alias, auth, ambiguity, branch alignment |
| tests/unit/branchAwareStart.test.mjs | Empty-workspace bare/qualified boot and branch equivalence |
| tests/unit/sandboxRuntime.test.mjs | Forced Podman behavior |
| tests/unit/helpLayers.test.mjs | Updated destroy and argument help |
| README.md and container/README.md | Public runtime contract |
| docs/code-derived-agent-lifecycle.md | Generic boxed lifecycle |
| docs/specs/DS003-agent-manifest-and-registry.md | openPorts and graph semantics |
| docs/specs/DS004-runtime-execution-and-isolation.md | Outer/nested runtime contract |
| docs/specs/DS007-dependency-caches-and-startup-readiness.md | Planner and retained dependency volume |
| docs/superpowers/specs/2026-07-11-mutable-runtime-image-hard-cut-design.md | Reconcile design with approved contract-2 persistence, legacy hard cut, and other decisions |

### AssistOSExplorer

| File | Planned change |
| --- | --- |
| onlyOffice/manifest.json | Replace unsupported box-side port zero with 127.0.0.1:17002:7000 in all profiles; retain LiveKit's existing 17000 claim |
| onlyOffice/docs/specs/DS01-ploinky-agent-invariant.md | Replace the dynamic-control-port contract with the approved stable box-side mapping |
| docs/specs/DS04-onlyoffice-integration.md | Synchronize the OnlyOffice control-port topology |
| docs/specs/DS06-ploinky-runtime-invariants.md | Record the stable openPorts boundary requirement where applicable |
| Relevant OnlyOffice/Explorer manifest tests | Use real-shaped profiles and prove the active Explorer graph contains no box-side port zero |

## Task-by-Task Implementation Plan

### Task 1: Freeze the Reviewed Contract

**Files**

- Modify: docs/superpowers/specs/2026-07-11-mutable-runtime-image-hard-cut-design.md
- Modify: this plan to record R1-R6 outcomes, update status/contract text, and
  adjust task sequence if required

**Steps**

- [x] Record approved D1-D12.
- [x] Record approved R1 removal of PLOINKY_BOX_ENGINE.
- [x] Record approved R2 strict unknown-engine handling.
- [x] Record approved R3 start-tail port rejection.
- [x] Record approved R4 fixed OnlyOffice control port 17002, leaving LiveKit on 17000.
- [x] Record approved R5 deterministic cross-engine resource ownership.
- [x] Record approved R6 empty-workspace bare-root equivalence.
- [x] Remove statements that explicit destroy deletes named volumes.
- [x] Retain the contract-1 no-migration rule and clarify that old named volumes
      remain untouched for manual recovery while contract 2 uses fresh
      path-hashed volumes.
- [x] Record the mutable-tag refresh model: create/replacement only.
- [x] Record generic openPorts scope and the REPL fail-closed boundary.
- [x] Record the final outer argument grammar.
- [x] Reconcile one authoritative image metadata/environment list, including
      container, BUILDAH_ISOLATION, _CONTAINERS_USERNS_CONFIGURED, exact PATH,
      and PLOINKY_DISABLE_HOST_SANDBOX.
- [x] Re-review the specification before runtime edits.

### Task 2: Write Failing Contract-2 Image Tests

**Files**

- Modify: ../container-image-builds/tests/image-definitions.test.mjs

**Steps**

- [ ] Replace immutable v1 assertions with contract-2 runtime assertions.
- [ ] Require a clean final FROM scratch stage.
- [ ] Require every row of the authoritative metadata table, including the full
      Podman environment and exact PATH, plus no VOLUME/CMD instruction.
- [ ] Require runtime as the only public publication tag.
- [ ] Require separate amd64 and arm64 build jobs.
- [ ] Require both architecture jobs before manifest merge.
- [ ] Require metadata, entrypoint, Podman, rootless-helper/mapping, and nested
      Alpine gates per digest.
- [ ] Reject blanket all-container cleanup and require the exact managed-label
      selection contract.
- [ ] Require static evidence that the workflow contains runtime gates for
      running/stopped managed=1 targets and unlabelled, managed=0, and near-name
      controls; Tasks 4 and 16 prove the behavior.
- [ ] Require static evidence that entrypoint/workflow failure paths make
      enumeration or removal errors nonzero and diagnostic; Tasks 4 and 16
      prove the behavior.
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
- [ ] Confirm file ownership, helper privilege metadata, and Podman behavior
      survive the filesystem copy.
- [ ] Assert both helpers are root-owned; newuidmap must have cap_setuid=ep or
      setuid-root, newgidmap must have cap_setgid=ep or setuid-root, and Podman's
      UID/GID maps must cover the configured subordinate ranges rather than a
      degraded single mapping.
- [ ] Run static tests and a local native build where available.

### Task 4: Gate the Mutable Multiarchitecture Workflow

**Files**

- Modify: ../container-image-builds/.github/workflows/publish-ploinky-box-image.yml
- Modify: ../container-image-builds/README.md

**Steps**

- [ ] Delete the immutable-tag-unused registry guard.
- [ ] Keep workflow-level concurrency serialization.
- [ ] Build amd64 on a native amd64 runner and arm64 on a native arm64 runner.
- [ ] Resolve source_ref once to an immutable Ploinky commit SHA and pass that
      exact SHA to both native jobs.
- [ ] Push candidates by digest without moving the runtime tag.
- [ ] Inspect complete metadata on each digest.
- [ ] Verify mounted Ploinky source and dependency installation flow.
- [ ] Verify entrypoint health, outer identity, Podman information, and nested
      Alpine on each architecture.
- [ ] Verify newuidmap/newgidmap capabilities or setuid fallback plus full
      subordinate UID/GID mappings on each architecture.
- [ ] Verify running and stopped managed=1 targets are removed while unlabelled,
      managed=0, and near-name controls remain on each architecture.
- [ ] Inject managed-container enumeration and selected-container removal
      failures on each architecture and require nonzero actionable diagnostics
      before a candidate can pass.
- [ ] Seed a nested image and a named-volume sentinel before restart and verify
      both remain afterward.
- [ ] Before artifact upload, verify each candidate descriptor is the expected
      linux architecture.
- [ ] Upload one nonempty digest artifact only after all per-architecture checks
      pass.
- [ ] In the merge job, download exactly two artifacts and require two nonempty,
      distinct candidate digests before moving the tag.
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
- [ ] Model explicit volume creation and inspect labels for identity schema,
      path hash, and role, including partial, split, foreign, and missing sets on
      both engines.
- [ ] Require pull even when the create tag already exists locally.
- [ ] Require no pull for compatible reuse or stopped start.
- [ ] Require pull/validation before current-contract replacement shutdown.
- [ ] Require run by validated image ID and requested-reference label.
- [ ] Require field-specific contract errors.
- [ ] Require every official/custom contract-2 metadata field, exact required
      environment, absent/empty command, and absent/empty volumes.
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
- [ ] Explicitly create each named volume with complete R5 ownership labels
      before that volume's first attachment; a planner may create only the
      workspace role, and final box creation creates any missing roles. Reject
      foreign or mismatched exact-name volumes.
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
- [ ] Verify their identity-schema, path-hash, and role labels remain unchanged.
- [ ] Recreate the box and prove retained state is mounted.
- [ ] Clean smoke-test volumes explicitly in a test-only finally path.

### Task 8: Force Nested Podman

**Files**

- Modify: cli/services/docker/common.js
- Modify: cli/services/docker/agentServiceManager.js
- Modify: cli/services/docker/interactive.js
- Modify: cli/services/docker/shellDetection.js
- Modify: cli/services/dependencyRuntimeKey.js
- Modify: cli/services/dependencyCache.js
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
- [ ] Audit main agents, both interactive create variants, ephemeral probes,
      retries, and recreation paths so none can omit or override the ownership
      label.
- [ ] Inspect one container from every persistent creation variant. Assert
      managed-label injection at argument-construction level for self-removing
      shell-detection, runtime-key, and dependency-install probe containers.
- [ ] Confirm launchAgentSidecar uses exec inside the already-labelled main
      container rather than treating it as a separate container creation path.
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
- Modify: container/runtime-engine.mjs
- Modify: container/runtime-supervisor-tests.mjs
- Modify: container/smoke-runtime.mjs
- Modify: cli/services/repos.js
- Modify: tests/unit/branchAwareStart.test.mjs
- Modify: container/README.md
- Modify: README.md

**Steps**

- [ ] Refactor host parsing around D1 and D2.
- [ ] Support a pre-command double-dash boundary.
- [ ] Preserve every post-command ordinary token exactly.
- [ ] Preserve bare REPL and parameterless cli routing.
- [ ] Preserve start positional port, profile, branch, and inferred branch.
- [ ] Remove public --name and --engine parsing and help.
- [ ] Remove PLOINKY_BOX_ENGINE parsing, documentation, and compatibility tests;
      prove environment state cannot bypass cross-engine ownership checks.
- [ ] Update the real smoke to use automatic public engine discovery and
      exact-cwd identity without --engine/--name; engine pinning is allowed only
      through injected unit-test seams.
- [ ] Derive an engine-safe readable name from exact-cwd realpath plus a
      12-character SHA-256 suffix.
- [ ] Derive all three volume names from the same instance identity.
- [ ] Add non-sensitive identity-schema and path-hash labels.
- [ ] Search both installed engines for an existing deterministic box.
- [ ] Never select from container ownership alone: after all R2 probes answer,
      inventory the exact container and three volume names on both engines, then
      select from or reject the complete R5 resource set.
- [ ] Implement R2 with explicit owns/absent/unknown results, probe every
      installed engine, keep help local, make partial status nonzero, and block
      every other route when any installed engine is unknown.
- [ ] Test unknown paired with owns, absent, unknown, and not-installed states;
      prove no pull, start, exec, stop, destroy, volume, or other mutation occurs.
- [ ] Inventory the exact container and labelled volumes on every answering
      engine; select the sole resource owner without mutating during inventory,
      create missing roles only on a later permitted planner/create path, fail on
      split/foreign state, and use Podman-first only for an empty identity.
- [ ] Test box/complete-volume/partial-volume/foreign-resource permutations on
      both engines, including nonzero partial status and mutation-free failure.
- [ ] Reject invalid lifecycle tails.
- [ ] Add a collision matrix for every outer option through agent CLI.
- [ ] Add the same matrix through client tool arbitrary fields.
- [ ] Test flag=value, flag value, repeated values, ordering, and double dash.
- [ ] Reject start-tail --port VALUE and --port=VALUE in host planning before
      reconciliation and in core parsing before mutation, with both accepted
      replacement forms in the diagnostic.
- [ ] Prove non-start post-command --port tokens remain byte-for-byte downstream
      arguments.
- [ ] Test symlink equivalence, same-basename separation, child-directory
      separation, move/rename behavior, engine installation changes, and
      cross-engine ambiguity.
- [ ] Update canonical examples to put outer options before commands.
- [ ] Remove the old parser behavior directly without a transition warning.

### Task 10: Extract Side-Effect-Limited Graph Preparation

**Files**

- Modify: cli/services/bootstrapManifest.js
- Modify: cli/services/ploinkyboot.js
- Modify: cli/services/workspaceDependencyGraph.js
- Add: cli/services/boxStartPublishPlan.js
- Add: container/box-start-publish-plan.mjs
- Modify: tests/unit/workspaceDependencyGraph.test.mjs
- Modify: tests/unit/branchAwareStart.test.mjs
- Add: focused tests for boxStartPublishPlan

**Steps**

- [ ] Separate repository installation/branch preparation from enableAgent and
      nested-container startup.
- [ ] Extract and reuse side-effect-limited default boot-repository preparation
      so a direct-node planner can populate an empty workspace before resolving
      a bare root without enabling or starting any agent.
- [ ] Accept an explicit workspace/root profile without prematurely persisting
      it.
- [ ] Reuse core bare/qualified lookup and enabled-repository precedence.
- [ ] Reuse SSO gating and directive parsing.
- [ ] Serialize deterministic node, edge, alias, and profile data.
- [ ] Reject incompatible profile selection for one effective instance under
      D11.
- [ ] Emit versioned JSON without unrelated stdout contamination.
- [ ] Invoke the planner entry with node directly, bypass the public dependency
      gate, and prove it imports with an empty node_modules and never prompts.
- [ ] Prove planning can clone/switch repos but cannot enable/start agents.
- [ ] From independent genuinely empty workspaces backed by equivalent local
      fixture remotes, prove the bare, slash-qualified, and colon-qualified
      Explorer requests with `--branch=ploinky-box` resolve the same canonical
      root, checkout commit, graph, claims, and publications.
- [ ] In a separate empty-workspace-derived fixture with two eligible
      `explorer` manifests, inventory the allowed repository preparation and
      prove bare lookup fails before operational mutation with both qualified
      alternatives instead of preferring the boot repository.
- [ ] Prove a conflicting sibling host checkout never affects the plan.
- [ ] Prove branch policy selects the same manifest core start will use.
- [ ] Prove effective-instance identity ignores profile, identical paths dedupe,
      conflicting diamond paths report both profiles/paths, and distinct aliases
      may select different profiles.

### Task 11: Generalize Claim Collection

**Files**

- Modify: container/box-publish-planner.mjs
- Modify: container/publish-spec.mjs only if needed
- Modify: tests/unit/boxPublishPlanner.test.mjs

**Steps**

- [ ] Delete Explorer constants, spellings, and host directory aliases.
- [ ] Consume authoritative resolved nodes rather than discovering host files.
- [ ] Include root, dependency, alias, and approved extra-enabled-agent claims.
- [ ] Preserve current TCP/UDP/range parsing and exact explicit spelling/order.
- [ ] Subtract the union of explicit target intervals from generated intervals
      and deterministically emit every uncovered prefix, middle, and suffix
      subrange instead of dropping a partially covered manifest range.
- [ ] Test multiple overlaps, full coverage, leading/trailing coverage, and
      protocol independence while preserving explicit spelling and ordering.
- [ ] Add reserved router conflict diagnostics.
- [ ] Implement D9 port-zero policy.
- [ ] Exercise a real-shaped Explorer/OnlyOffice graph so fixtures cannot omit
      an active dependency's invalid port-zero claim.
- [ ] Add generic bare, slash, and colon root tests and prove every spelling
      traverses identical planner/claim validation rather than allowing the
      colon form to bypass planning.
- [ ] Add ambiguity, missing manifest, cycle, alias, profile fallback, explicit
      edge profile, SSO, protocol, range, and overlap tests.

### Task 12: Replace OnlyOffice's Unsupported Port Zero

**Files**

- Modify: ../AssistOSExplorer/onlyOffice/manifest.json
- Modify: ../AssistOSExplorer/onlyOffice/docs/specs/DS01-ploinky-agent-invariant.md
- Modify: ../AssistOSExplorer/docs/specs/DS04-onlyoffice-integration.md
- Modify: ../AssistOSExplorer/docs/specs/DS06-ploinky-runtime-invariants.md
- Modify: relevant OnlyOffice/Explorer manifest tests

**Steps**

- [x] Record R4 approval for `127.0.0.1:17002:7000` in every profile, leaving LiveKit on `17000`.
- [ ] Replace 127.0.0.1:0:7000 in default, dev, and prod with
      127.0.0.1:17002:7000.
- [ ] Keep the control listener, editor proxy, and loopback-only storage listener
      as three distinct topology contracts.
- [ ] Update the specifications that currently require an ephemeral control
      host port.
- [ ] Add a real-shaped Explorer dependency-graph fixture and prove every active
      openPorts claim has a stable box-side port and no socket conflict.
- [ ] Run the relevant OnlyOffice and Explorer manifest/spec tests.

### Task 13: Integrate Planning with Reconciliation

**Files**

- Modify: container/runtime-supervisor.mjs
- Modify: container/runtime-contract.mjs
- Modify: tests/helpers/runtimeSupervisorHarness.mjs
- Modify: container/runtime-supervisor-tests.mjs

**Steps**

- [ ] Add a scoped workspace planning lock.
- [ ] Execute planner in the existing compatible box when possible.
- [ ] Use a short-lived direct-node planner container for stopped and missing
      boxes without starting the stopped managed box.
- [ ] Ensure pull/validation precedes a missing-box planner container.
- [ ] Give temporary planners unique names and remove them plus anonymous
      volumes in a finally path on success, failure, signal, and timeout.
- [ ] Prove planner success/failure leaves no temporary container and preserves
      every deterministic named mount.
- [ ] Ensure a first planner-created workspace volume carries the complete R5
      ownership labels and anchors later engine selection.
- [ ] Ensure planner failure starts no agent/router and does not replace the
      current outer box.
- [ ] Merge router, explicit, and generated publications.
- [ ] Persist and inspect publication provenance labels.
- [ ] Replace stale generated claims while retaining the prior ordered explicit
      set when no publish option is given and replacing it exactly when one is.
- [ ] Treat missing/unsupported publication provenance as an incompatible box
      configuration and require explicit destroy/recreate.
- [ ] Reconcile before forwarding core lifecycle commands.
- [ ] Prove add/remove/profile/branch publication changes trigger one
      transactional replacement.
- [ ] Prove replacement rollback restores prior publications and labels.
- [ ] Prove named volumes survive every path.

### Task 14: Cover Every Agent-Starting Path

**Files**

- Modify: container/runtime-supervisor.mjs
- Modify: cli/services/docker/agentServiceManager.js
- Modify: cli/services/docker/common.js
- Modify: cli/commands/cli.js
- Modify: cli/services/workspaceUtil.js
- Modify: cli/services/agents.js
- Modify: cli/server/containerMonitor.js
- Modify: cli/server/authHandlers/marketplaceRoutes.js
- Modify: relevant CLI/runtime tests

**Steps**

- [ ] Define planner requests for start with and without a root.
- [ ] Define planner requests for enable, cli AGENT, shell AGENT, restart, and
      reinstall, including each restart submode that can transition a container.
- [ ] Include agents core will actually launch under D8.
- [ ] Pass the approved outer publication contract into core.
- [ ] At each core command boundary, check publication coverage before profile,
      config, registry, hook, router, or nested-runtime mutation.
- [ ] Keep a defense-in-depth guard in the shared runtime transitions before
      nested create, start, restart, and recreate.
- [ ] Allow REPL starts when coverage is already sufficient.
- [ ] Fail closed before REPL mutation when an outer replacement is needed, and
      snapshot-test that registry, config, hooks, router, and containers remain
      unchanged.
- [ ] Cover container-monitor recreation through the shared labelled/coverage
      path; publication denial must create/start nothing, log the failure, back
      off, and never terminate the router.
- [ ] Cover Marketplace enable as a non-reconciling in-box path; denial must
      precede registry/filesystem mutation and return an actionable HTTP
      conflict response rather than a generic server failure.
- [ ] Print an actionable one-shot host command in that error.
- [ ] Never mount the host engine socket or grant agent containers sibling
      control.

### Task 15: Synchronize Documentation

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
- [ ] Document the start-only tail rejection and both accepted port forms.
- [ ] Document contract 2, mutable tag, ID pinning, and refresh behavior.
- [ ] Document the hard-cut contract-1 transition: old volumes remain manual,
      while contract 2 starts with fresh path-hashed volumes.
- [ ] Document that new path-hashed destroy cannot discover a legacy
      basename-only box; give direct Docker/Podman container removal commands
      that preserve its named volumes and release any occupied host ports.
- [ ] Document destroy as container removal, not data cleanup.
- [ ] Document manual named-volume cleanup for operators who want a full reset.
- [ ] Document R5 inventory, labels, sole-owner selection, partial-set reuse,
      split/foreign failure, and the limitation when an engine executable is not
      installed.
- [ ] Document forced nested Podman.
- [ ] Document selective managed-container boot cleanup, the ownership label,
      and the lack of lifecycle guarantees for unlabelled/manual containers.
- [ ] Document that a failed first-start plan may leave deterministic named
      volumes for retry and give exact manual engine-level cleanup commands.
- [ ] Document boot-cleanup failure recovery: inspect/backup nested storage
      first, then explicitly remove and recreate only the nested-storage named
      volume when the operator accepts its data loss; ordinary destroy/recreate
      preserves that volume and may repeat the failure.
- [ ] Update help/documentation assertions.

### Task 16: Full Verification and Release Gates

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
- [ ] Prove both platforms retain full subordinate UID/GID mappings and the
      required newuidmap/newgidmap privilege mechanism.
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
- [ ] Prove a first-use `ploinky start explorer --branch=ploinky-box` and both
      `AchillesIDE` qualified spellings select the same root commit and outer
      publications, while a genuinely ambiguous bare name fails after allowed
      repository preparation but before operational mutation.
- [ ] Prove the real-shaped Explorer/OnlyOffice graph has no port-zero claim and
      publishes its approved control/editor sockets across both boundaries.
- [ ] Prove a partial explicit range override emits every uncovered generated
      subrange.
- [ ] Prove host/REPL start, enable, cli AGENT, shell AGENT, every restart
      submode, reinstall, Marketplace enable, and monitor recovery obey
      pre-mutation publication coverage.
- [ ] Prove stopped/missing planner success and failure leave no temporary
      container while retaining deterministic named state.
- [ ] Prove destroy removes the box but retains all named volumes.
- [ ] Prove recreation uses retained workspace, dependency, and nested storage.
- [ ] Prove a destroyed identity follows its sole labelled volume owner even
      when the other engine is preferred, while split/foreign inventories fail
      without mutation.
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
| Outer box | Contract-2 image has exact metadata, runs with Podman and full subordinate ID maps, mounts Ploinky source, and has exactly three named mounts |
| Nested agents | Every box agent runtime resolves to nested Podman; no Docker/bwrap/Seatbelt path remains effective |
| Nested boot cleanup | Restart removes running/stopped containers only for exact io.assistos.ploinky.managed=1; real Ploinky creation variants carry it, controls do not match, and nested images/named volumes remain |
| Command surface | Bare REPL and parameterless cli Bash remain unchanged |
| Special lifecycle | Help/status/stop/destroy keep approved host behavior |
| Destroy | Removes only selected box and retains all named volumes |
| Pull policy | Pull on create/replacement; no pull on reuse/stopped start/status/stop/destroy |
| Mutable safety | Run by validated ID and retain requested tag as metadata |
| Legacy | Contract 1 is never migrated; old named volumes remain untouched and contract 2 uses fresh path-hashed volumes |
| openPorts | Arbitrary active agents, profiles, aliases, branches, dependencies, one-shot shell, and monitor recovery receive matching outer publications |
| Dynamic safety | Port conflicts and unsupported port zero fail before agent/router start |
| Partial explicit override | Explicit target intervals replace only their covered sockets; all uncovered generated subranges remain published |
| Stale ports | Generated ports disappear when graph/profile changes; explicit ports survive |
| Provenance | Every supported contract-2 box has versioned publication labels; unlabelled boxes fail closed |
| Argument safety | Agent CLI and MCP payload flags are forwarded exactly; start-tail port flags fail before mutation with prefix/positional guidance |
| Bare root resolution | Independent empty workspaces prove bare, slash-qualified, and colon-qualified Explorer forms select the same branch commit, canonical graph, claims, and publications; colon never bypasses planning, while same-precedence bare ambiguity fails after inventoried repository preparation but before operational mutation |
| Instance identity | Exact-cwd realpath deterministically selects one readable path-hashed box without a public override |
| Engine discovery | Existing boxes and labelled retained volumes select their sole owning engine; split/foreign resources and cross-engine duplicates fail closed |
| Rollback | Failed replacement restores prior ID/config/labels and retains volumes |
| Platforms | Published runtime contains verified linux/amd64 and linux/arm64 images |

## Rollout Order

| Order | Release action | Gate |
| --- | --- | --- |
| 1 | Merge container-image-builds implementation | Static and local image checks pass |
| 2 | Dispatch image publication after explicit approval | Both architecture gates pass |
| 3 | Record and independently inspect runtime manifest digest | Contract-2 metadata and nested Podman verified |
| 4 | Merge the approved AssistOSExplorer OnlyOffice manifest/spec correction | Stable control-port tests and real-shaped graph planning pass |
| 5 | Merge Ploinky implementation | Focused and complete tests pass |
| 6 | Run Ploinky public-image smoke | Real create, nested runtime, ports, destroy, and retained state pass |
| 7 | Release Ploinky | All preceding gates complete |

Existing released Ploinky versions remain pinned to the immutable contract-1
image. The runtime tag is introduced only for the new contract-2 supervisor.

## Rollback

| Failure | Recovery |
| --- | --- |
| Bad runtime tag before Ploinky release | Move runtime back to a previously verified contract-2 digest |
| Bad runtime tag after boxes exist | Existing boxes retain their current IDs; publish a fixed digest, then explicitly destroy/recreate |
| New Ploinky encounters contract 1 under its path-hashed identity | Keep ordinary commands blocked; never copy/adopt its volumes; leave old named volumes for manual recovery |
| Legacy basename-only box survives the hard cut | New destroy does not target it; follow the documented direct-engine container removal procedure and preserve its named volumes |
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
| Scratch copy loses rootless helper capabilities | Gate helper capabilities/setuid fallback and full UID/GID mappings on each native digest |
| Native jobs validate different moving source refs | Resolve one immutable Ploinky SHA before both jobs and record it with the release |
| Temporary planning leaves an orphan container | Use unique names plus finally cleanup and inventory tests on every exit path |
| Explicit publish partially hides a generated range | Subtract target intervals and test every uncovered deterministic subrange |
| An active manifest still declares port zero | Correct OnlyOffice under R4 and test the real-shaped Explorer graph before Ploinky release |
| Moving or renaming a workspace leaves retained resources at the old identity | Document the behavior and provide manual engine cleanup instructions |
| The same identity exists in Podman and Docker | Fail read-only with both locations; never guess or mutate |
| A failed planner leaves only one labelled volume | Treat the partial set as engine ownership; status remains read-only/nonzero, and only a later permitted create path creates missing roles on that engine |
| An exact-name volume is unlabelled or mismatched | Treat it as foreign, attach nothing, and provide manual inventory/recovery instructions |
| A removed engine executable hides retained storage | Document the limitation; if reinstalled later, detect and fail on any resulting split |

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
- Automatic cross-engine volume copying, merging, relabelling, or deletion.
- Removing the current profile system or collapsing it to one default profile.
- Automatic restart, repair, or deletion of unlabelled/manual nested
  containers.
- Changes to AchillesAgentLib.
