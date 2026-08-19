# Ploinky Box Implementation Handoff

Date: 2026-07-11

Status: implementation published and local Explorer deployment running; known
follow-up items are recorded in this document

Primary branch: `AssistOS-AI/ploinky:ploinky-box`

Related implementation plan:
[`2026-07-11-ploinky-box-invariant-alignment.md`](./2026-07-11-ploinky-box-invariant-alignment.md)

## Purpose and Authority

This is the continuation record for the Ploinky Box work completed on
2026-07-11. Future sessions should read this document before changing the box
supervisor, publication planner, nested runtime, Ploinky image, Explorer graph,
or OnlyOffice startup.

The approved implementation plan remains the design record. Its status line and
checkboxes were not maintained as an execution ledger and are therefore stale.
This handoff is the authoritative record of what was actually implemented,
published, tested, deployed, and left unresolved.

Do not treat a behavior as complete merely because it appears as an approved
plan item. In particular, read [Known Follow-up Work](#known-follow-up-work)
before touching individual-agent lifecycle commands or RabbitMQ memory
accounting.

## Outcome at Handoff

| Area | State at handoff |
| --- | --- |
| Ploinky core | Contract-2 implementation committed and pushed to `ploinky-box` |
| Explorer/OnlyOffice | Stable port and nested-rootless startup fixes committed and pushed to `ploinky-box` |
| Ploinky box image | Contract-2 multiarchitecture image published at `docker.io/assistos/ploinky-box:runtime` |
| Local acceptance command | `ploinky start explorer --branch=ploinky-box` exits successfully from `/home/skutner/work/file-parser` |
| Outer box | `ploinky-box-file-parser-c4a17cbfee69`, running and intentionally left running |
| Nested suite | 22 of 22 Ploinky-managed containers running |
| Background launch receipts | 16 of 16 report `running` |
| Router and UI | Protected router/status/dashboard/Explorer/root requests redirect to login and reach HTTP 200 after following it; WebTTY returns HTTP 200 directly |
| OnlyOffice | Document Server and editor asset endpoint return HTTP 200 |
| Remaining work | Individual-agent publication reconciliation defect; OnlyOffice readiness false positive; optional RabbitMQ `allocated` evaluation; full-suite environmental gap |

## Original Invariants and Final Evidence

| Original invariant | Implemented behavior | Evidence |
| --- | --- | --- |
| A standalone outer image contains Podman and mounts Ploinky core | Contract-2 source-free image contains Podman/Node/tooling; host Ploinky source is mounted read-only at `/opt/ploinky` | Published native amd64/arm64 gates; current outer mount inventory |
| Agents retain master-era behavior but run inside nested Podman | Box marker forces Podman and disables Docker/bwrap/Seatbelt fallback; managed creation paths carry the ownership label | Runtime unit tests, image smoke, current 22 nested containers |
| Ordinary commands run in the box; destroy removes the outer box directly | Supervisor routes ordinary commands through `exec`; confirmed destroy removes only the outer box and retains named volumes | Supervisor tests and real smoke |
| Bare `ploinky` opens the in-box REPL | Preserved by the host routing boundary | Runtime shell/supervisor tests |
| Parameterless `ploinky cli` opens Bash inside the box | Preserved as an interactive shell in `/workspace` as `podman` | Runtime shell tests |
| Active manifest `openPorts` also exist at the outer boundary | Full `start` graphs are published correctly; targeted commands have the recorded topology-shrink defect | Planner/coverage tests, current full Explorer publications, and targeted `reinstall` reproduction |
| A missing or intentionally replaced box pulls the custom image | Supervisor pulls and validates on create/replacement, then runs by image ID; reuse/stopped-compatible start does not pull | Pull matrix tests, real create/replacement output, current inspected image ID |

## Repository and Commit Ledger

### Ploinky

| Commit | Branch | Purpose | Push state |
| --- | --- | --- | --- |
| `f5c822d2031b75ad7269454b828a9467a914ae8d` | `ploinky-box` | Add the approved implementation plan | Pushed |
| `8363e6c65c98d4c073afc5c63ff8f7bf862b023f` | `ploinky-box` | Apply the read-only plan review and record R1-R6 | Pushed |
| `9b1b46689819f562705d1a8a95c8df35a71e477d` | `ploinky-box` | Implement contract-2 supervisor, graph planning, nested runtime, tests, and docs | Pushed |

The implementation commit changes 56 files with 8,565 insertions and 6,199
deletions. The executable bits on `container/runtime-supervisor.mjs` and
`container/smoke-runtime.mjs` were restored before that commit was pushed.

At handoff, `ploinky-box` is 66 commits ahead of and one commit behind local
`master`. The master-only commit is `97b2338` (`added support for /v1/models in
agent server`). A future integration must account for it explicitly without
rewriting or resetting the box branch. The full branch contains substantial
pre-plan foundations; do not attribute the entire branch diff to `9b1b466`.

### AssistOSExplorer

| Commit | Branch | Purpose | Push state |
| --- | --- | --- | --- |
| `f074338022e1596debcee083a08952ec09421728` | `ploinky-box` | Replace OnlyOffice control host port zero with stable port 17002 and update contracts/tests | Pushed |
| `f677660bc30f077fac92ab63d59afe995bbe2fea` | `ploinky-box` | Make bundled RabbitMQ boot under nested rootless Podman | Pushed |
| `a11271a77d3f9d69de02f3a0d5d57e20ddc4c694` | `ploinky-box` | Bypass RabbitMQ's incompatible inner-PID startup wait while retaining TCP readiness | Pushed |

### container-image-builds

| Commit | Branch | Purpose | Push state |
| --- | --- | --- | --- |
| `2dc6dadad7edda80c44a0c33f695a3207f577a77` | `main` | Build, gate, document, and publish the contract-2 Ploinky box image | Pushed |

### Repositories with no implementation commit

| Repository or component | Result |
| --- | --- |
| `basic` | No source change required; existing `ploinky-box` branch retained |
| `webmeetInfra` | No source change required |
| `proxies` | No source change required |
| Other Explorer dependencies | No source change required |
| Explorer deployment workflows | Investigated, then deliberately left unchanged when the owner narrowed the goal to local deployment |
| OnlyOffice image definition/workflow | Deliberately left unchanged; the durable local fix lives in the mounted OnlyOffice agent wrapper |
| `ploinky unset` | Explicitly deferred when the owner narrowed scope to local deployment; no behavior change was implemented or approved in this work |

## Complete Approved Decision Record

### D1-D12

| ID | Decision | Approved contract |
| --- | --- | --- |
| D1 | Outer argument boundary | Parse outer options only before the core command, support a pre-command `--` boundary, and preserve downstream argv spelling/order exactly |
| D2 | Instance and engine selectors | Remove public `--name` and `--engine`; derive identity from exact-cwd realpath and discover the owning host engine automatically |
| D3 | Parser migration | Apply the new grammar as a hard cut without a warning release |
| D4 | Destroy sequence | After confirmation, force-remove the outer box directly; do not invoke in-box core stop or an intermediate outer stop |
| D5 | Destroy volume cleanup | Remove attached anonymous volumes while preserving every explicitly named volume |
| D6 | Contract-1 transition | Hard cut with no migration, adoption, copying, relabelling, or mapping; contract 2 uses new path-hashed identities |
| D7 | `openPorts` command boundary | Pre-plan every one-shot command capable of starting agents; in-box non-reconciling paths fail closed if outer coverage is insufficient |
| D8 | Effective started set | Plan the requested active graph plus enabled effective instances that remain active; merely installed agents do not create claims |
| D9 | Host port zero | Reject box-side port zero before outer reconciliation or nested mutation |
| D10 | Publication provenance | Require versioned explicit/generated publication labels; never infer missing provenance |
| D11 | Profile conflicts | Retain profiles but reject different profiles for the same effective canonical-or-alias instance before mutation |
| D12 | Nested boot cleanup | Remove only containers labelled exactly `io.assistos.ploinky.managed=1`; retain manual containers, images, and named volumes |

### R1-R6 from the plan review

| ID | Decision | Approved contract |
| --- | --- | --- |
| R1 | `PLOINKY_BOX_ENGINE` | Remove the public environment override completely; public resolution is always automatic |
| R2 | Unreachable installed engine | Classify probes as owns/absent/unknown; help remains local, status is partial/nonzero, and every other command fails before mutation when any installed engine is unknown |
| R3 | Start-tail `--port` | Keep prefix `ploinky --port PORT start AGENT` and positional `ploinky start AGENT PORT`; reject tail `--port` and `--port=` for `start` before mutation |
| R4 | OnlyOffice port zero | Use `127.0.0.1:17002:7000` in default/dev/prod; keep LiveKit on 17000, editor mappings on 8082/18082, and storage 9100 unpublished |
| R5 | Cross-engine resources | Inventory the exact box and three labelled volumes across all answering engines; sole owner wins, split/foreign state fails closed, Podman-first applies only to an empty identity |
| R6 | Empty-workspace bare root | Prepare default repositories without enabling/starting, then make `explorer`, `AchillesIDE/explorer`, and `AchillesIDE:explorer` resolve identically unless bare lookup is genuinely ambiguous |

### Decision implementation status

| Decision | Status at handoff |
| --- | --- |
| D1-D6 | Implemented and covered by focused supervisor tests |
| D7 | Incomplete for targeted commands because a narrow authoritative plan can replace the full active topology |
| D8 | Implemented for full `start`; contradicted by `includeEnabled: false` on targeted commands |
| D9-D12 | Implemented; D12 also passed both native image gates |
| R1-R5 | Implemented and covered by focused tests/smoke |
| R6 | Fixture-equivalence implemented; the real local deployment exercised only the bare spelling |

### Additional owner decisions made during implementation

| Topic | Final decision |
| --- | --- |
| Bare command | Bare `ploinky` remains the Ploinky REPL, not Bash |
| Parameterless `cli` | `ploinky cli` opens Bash inside the outer box |
| Agent CLI | `ploinky cli AGENT ...` keeps the existing nested-agent attachment behavior |
| Host-special commands | Keep `help`, `status`, `stop`, and `destroy` host-special |
| Stop | Keep current two-phase behavior: stop core workspace services, then stop the outer box |
| Destroy persistence | Remove the box without deleting named volumes |
| Destroy confirmation path | Direct removal after confirmation |
| Agent runtime | Force nested Podman for every Ploinky-managed agent path for now, including lite-sandbox manifests |
| Host engine | Automatic discovery only; no public selector and no environment override |
| Pull policy | Pull only before create or intentional replacement |
| Runtime tag | Use contract 2 through mutable `docker.io/assistos/ploinky-box:runtime` |
| Mutable tag behavior | Existing compatible boxes stay pinned to their inspected image ID; the tag is consulted only for create/replacement |
| Profiles | Retain profile support in code for now; the intended future model is one `default` profile |
| Port zero | Reject it instead of interpreting it as an ephemeral outer publication |
| Agent lookup | Bare agent names such as `explorer` must work generically; qualification is required only for real ambiguity |
| Migration | No contract-1 migration or compatibility adoption |
| Publication authorization | The owner authorized triggering the Ploinky box publication workflow |
| Final repository policy | Source repositories use `ploinky-box`; `container-image-builds` uses its default `main`; no empty commits |
| Local acceptance | The required command is exactly `ploinky start explorer --branch=ploinky-box` from `/home/skutner/work/file-parser` |
| Final deployment | Leave the successful local deployment running |
| Final scope narrowing | Prioritize local deployment; do not add or publish an OnlyOffice image change merely to solve the nested startup issue |
| Deferred CLI/workflow work | Ignore `ploinky unset` and deployment-workflow topology for this implementation; Explorer workflow edits were reverted |

## Public Command Contract

| Invocation | Behavior |
| --- | --- |
| `ploinky` or `p-cli` | Discover/reconcile the exact-cwd box and open the in-box Ploinky REPL |
| `ploinky cli` | Discover/reconcile the box and open interactive Bash as `podman` in `/workspace` |
| `ploinky cli AGENT ARGS...` | Plan the target's required publications and forward the exact agent argv |
| `ploinky start ...` | Plan the authoritative graph, reconcile publications, forward start, and probe the router |
| `ploinky enable ...` | Pre-plan any nested start caused by enable |
| `ploinky shell AGENT` | Pre-plan the target before attaching |
| `ploinky restart ...` | Pre-plan the relevant target or configured graph before transition |
| `ploinky reinstall AGENT` | Pre-plan before recreation; see the known active-publication defect below |
| `ploinky status` | Read-only; never pulls or reconciles |
| `ploinky stop` | Stop core services and then the outer box; never pulls |
| `ploinky destroy` | Confirm and directly remove the outer box; retain named volumes; never pulls |
| `ploinky help ...` | Render locally without starting the box |

The public grammar is:

```text
ploinky [OUTER_OPTION ...] [--] [CORE_COMMAND [CORE_ARGUMENT ...]]
```

Recognized outer options include `--port`, `--publish`/`--expose`, `--image`,
`--mount`, `--listen-lan`, `--dry-run`, and help flags. Recognition ends at the
first core command token. Post-command tokens are downstream tokens, except the
explicitly rejected `start` tail-port spellings.

Accepted router-port forms are:

```bash
ploinky --port 9192 start explorer
ploinky start explorer 9192
```

Both `ploinky start explorer --port 9192` and
`ploinky start explorer --port=9192` fail before reconciliation and print both
accepted replacements. Post-command `--port` remains an ordinary downstream
token for non-`start` commands.

## Deterministic Identity and Host Engine

The identity algorithm is:

```text
canonicalPath = realpath(exact current working directory)
pathHash      = first 12 lowercase hexadecimal characters of SHA-256(canonicalPath)
slug          = sanitized and bounded basename(canonicalPath)
instance      = ploinky-box-SLUG-PATHHASH
```

For `/home/skutner/work/file-parser`, the current identity is:

```text
ploinky-box-file-parser-c4a17cbfee69
```

The exact current directory matters. A child directory gets a different box;
a symlink to the same physical directory gets the same box; moving the folder
creates a new identity and leaves the old resources for manual recovery.

Host discovery probes installed Podman and Docker implementations. Any
installed-but-unreachable engine is `unknown`, not absent. An exact box or any
of its three labelled volumes establishes ownership. Split or foreign state is
reported and not mutated.

Each deterministic volume carries only non-sensitive ownership metadata:

| Label | Value |
| --- | --- |
| `io.assistos.ploinky.identity-schema` | `1` |
| `io.assistos.ploinky.path-hash` | The 12-character exact-cwd hash; `c4a17cbfee69` for the current workspace |
| `io.assistos.ploinky.volume-role` | Exactly `workspace`, `containers`, or `ploinky-deps`, matching the name |

The outer container carries the identity schema and path hash but never the
cleartext absolute path. An exact-named volume with missing or mismatched labels
is foreign and is never automatically attached, relabelled, or deleted.

## Contract-2 Image and Outer Runtime

### Exact image contract

| Field | Required value |
| --- | --- |
| Logical reference | `docker.io/assistos/ploinky-box:runtime` |
| Contract label | `io.assistos.ploinky.runtime-contract=2` |
| Image user | `podman` |
| `USER` | `podman` |
| `HOME` | `/home/podman` |
| `PLOINKY_WORKSPACE_ROOT` | `/workspace` |
| Sandbox marker | `PLOINKY_DISABLE_HOST_SANDBOX=1` |
| Container marker | `container=oci` |
| User namespace marker | `_CONTAINERS_USERNS_CONFIGURED=` |
| Buildah isolation | `BUILDAH_ISOLATION=chroot` |
| `PATH` | `/opt/ploinky/bin:/usr/local/bin:/usr/bin` |
| Workdir | `/workspace` |
| Entrypoint | `/usr/local/bin/ploinky-box-entrypoint` |
| Default command | Absent or empty |
| Declared image volumes | Absent or empty |

`Config.Env` contains exactly the eight entries shown above (`PATH` plus the
seven remaining environment rows), with no inherited extras.

The Dockerfile prepares the Podman filesystem in an intermediate stage and
copies it into a clean `FROM scratch` final stage. This is required to remove
inherited volume and command metadata that a normal child Dockerfile cannot
unset reliably. The final stage reapplies `shadow-utils` capabilities and
restates every contract field.

### Entrypoint behavior

The entrypoint validates Bash, Node availability, npm, npx, Git, Podman, the
`podman` identity, exact environment, marker file, an executable Ploinky tree at
`/opt/ploinky`, writable dependency volume, writable workspace, `/dev/fuse`,
`/dev/net/tun`, helper privilege, full subordinate UID/GID mappings, and
functional rootless Podman. The native publication workflow separately proves
Node major version 24 and that Ploinky source is supplied through the intended
read-only bind rather than baked into the image.

It removes stale ephemeral Podman run directories, then enumerates nested
containers in all states using the exact filter:

```text
label=io.assistos.ploinky.managed=1
```

Only returned IDs are force-removed. Enumeration or removal failure aborts the
entrypoint. Unlabelled containers, `managed=0`, `managed=10`,
`managed-extra=1`, nested images, and named volumes are retained.

### Outer mounts

| Destination | Source at current deployment | Mode |
| --- | --- | --- |
| `/workspace` | `ploinky-box-file-parser-c4a17cbfee69-workspace` | Named volume, read/write |
| `/home/podman/.local/share/containers` | `ploinky-box-file-parser-c4a17cbfee69-containers` | Named volume, read/write |
| `/opt/ploinky/node_modules` | `ploinky-box-file-parser-c4a17cbfee69-ploinky-deps` | Named volume, read/write |
| `/opt/ploinky` | `/home/skutner/work/file-parser/ploinky` | Host bind, read-only |

There are exactly three named outer volumes and no anonymous outer mounts in
the accepted deployment.

### Outer privilege boundary

The outer box intentionally runs with `--privileged` while its configured
process user remains `podman`. The desired runtime also passes `/dev/fuse` and
`/dev/net/tun` and sets `seccomp=unconfined`; the live host-Podman container
inspection reports `Privileged=true` with `seccomp=unconfined` and
`unmask=all`. These grants are required by the current nested rootless Podman
design and are part of the outer runtime configuration/rollback contract.

This is not a hostile multi-tenant isolation boundary. Under rootless host
Podman, `--privileged` remains bounded by the invoking host user's user
namespace and permissions, although it is broad inside that boundary. Under a
rootful Docker daemon, the same flag has materially broader host device and
capability implications and requires separate real-host security validation.
The accepted local deployment used rootless host Podman; a real Docker-host
smoke is still missing.

No host Docker or Podman socket is mounted into the box. Ordinary nested agent
containers remain separately unprivileged and receive no sibling-control
socket; only the trusted outer runtime owns nested Podman lifecycle.

### Pulling, validation, and replacement

| Existing state | Action |
| --- | --- |
| Box missing | Pull reference, validate complete image contract, plan, run by resolved image ID |
| Running compatible box with unchanged config | Reuse without registry traffic |
| Stopped compatible box with unchanged config | Start without registry traffic |
| Compatible box requiring replacement | Pull and validate before stopping the old box; replace transactionally |
| Contract-1 or malformed box | Refuse ordinary mutation and require explicit destroy |
| Status/stop/destroy | Never pull |

Replacement preserves the prior inspected image ID and complete run
configuration for rollback. A failed replacement is removed and the prior
contract-2 configuration is restored. Contract 1 is never upgraded in place.

## Generic `openPorts` Planning

### Planner architecture

The side-effect-limited planner reads authoritative workspace state from the
workspace volume rather than sibling host checkouts. Its allowed preparation
side effects are repository installation and branch switching. It must not
enable an agent, run hooks, start the router, or create nested agents.

The host invokes `node /opt/ploinky/container/box-start-publish-plan.mjs`
directly. A temporary planner container receives the JSON request through
stdin, so its engine invocation must retain `-i`. Omitting `-i` was the critical
implementation-review finding and was fixed before commit `9b1b466`.

| Planner operation | Supported |
| --- | --- |
| `start` | Yes |
| `enable` | Yes |
| `cli` | Yes |
| `shell` | Yes |
| `restart` | Yes |
| `reinstall` | Yes |
| `monitor` | Yes |
| `marketplace-enable` | Yes |

The planner resolves bare/slash/colon names, default boot repositories, branch
policy, workspace and edge profiles, aliases, conditional dependencies,
enabled instances, cycles, missing manifests, and profile conflicts. Its stdout
is reserved for one schema-versioned JSON result.

### Claim and publication rules

| Rule | Implemented behavior |
| --- | --- |
| Root and dependencies | Include active resolved nodes |
| Enabled instances | Include effective enabled instances requested by the operation |
| Profiles | Selected profile replaces default `openPorts`; explicit missing profiles fail |
| Aliases | Distinct aliases are distinct instances |
| Duplicate claim | Deduplicate only identical claims for the same effective instance |
| Conflict | Overlapping box-side sockets for different effective instances fail |
| Protocol | TCP and UDP sockets are independent |
| Ranges | Require equal valid host/container range lengths |
| Port zero | Reject before mutation |
| Router port | Reserve 8080/tcp and reject conflicts |
| Explicit publication | Preserve exact spelling/order; subtract covered target intervals from generated intervals |
| Partial range override | Emit every uncovered prefix, middle, and suffix range deterministically |

### Publication provenance

Supported boxes record:

```text
io.assistos.ploinky.publish-plan-version=1
io.assistos.ploinky.generated-publishes=<normalized JSON array>
io.assistos.ploinky.explicit-publishes=<normalized JSON array>
```

New generated claims replace old generated claims. If an invocation provides
no explicit publish flags, the prior ordered explicit set remains. If it
provides explicit flags, that exact ordered set replaces the prior set. Missing
or unsupported provenance is not guessed; the box is treated as unsupported.

### Locks and failure behavior

The implementation has a host runtime lock and an in-workspace publication
planning lock. Both include owner metadata, stale-owner recovery, signal-safe
cleanup, bounded wait behavior, and tests for abandoned reapers. Temporary
planner containers use unique names and are removed with anonymous volumes in
finally paths. Deterministic named volumes are retained for retry.

## Forced Nested Podman and Managed Ownership

Inside a marked Ploinky box, Podman is mandatory. Docker fallback and host
sandbox runtimes are not effective. Lite-sandbox manifests resolve to Podman;
sandbox status reports the forced state; attempts to enable an ineffective
sandbox mode do not silently persist a false effective state.

Every Ploinky-owned nested creation path uses:

```text
--label io.assistos.ploinky.managed=1
```

Production argument builders and tests cover persistent agents, both
interactive create/retry families, shell detection, runtime-key probes, and
dependency-install helpers. `launchAgentSidecar` execs inside an already
labelled main container rather than creating a separate unlabelled container.

Explicitly selected dependency modes (`isolated`, `global`, and `devel`)
reconcile stale retained registry records before blocking/no-wait launch.
Static agents and dependencies without an explicit mode retain their existing
mode. A failed safe removal leaves registry state unchanged; workspace and
named data are preserved.

## Destroy and Persistence

After confirmation, destroy directly force-removes the selected outer
container with anonymous-volume cleanup. It does not call core destroy and does
not delete the three named volumes. Volume ownership labels remain and anchor
future cross-engine discovery.

| State | Result |
| --- | --- |
| No box and no volumes | Idempotent success |
| No box but labelled named volumes exist | Report box absent and retain volumes |
| Confirmation declined | No mutation |
| Confirmation accepted | Remove selected outer box and anonymous mounts; retain all named volumes |
| Contract-1 resources | Do not discover, migrate, attach, rename, or remove them automatically |

## Complete Ploinky File Inventory

### Runtime and CLI production files

| File | Change |
| --- | --- |
| `cli/commands/cli.js` | Integrate pre-mutation publication planning into agent-starting commands; retain shell/REPL command semantics |
| `cli/commands/sandboxCommands.js` | Report/enforce forced nested Podman policy |
| `cli/server/authHandlers/marketplaceRoutes.js` | Deny Marketplace enable before mutation when outer publications are insufficient |
| `cli/server/containerMonitor.js` | Route monitor recovery through publication coverage, log denial, and back off without terminating the router |
| `cli/services/agents.js` | Validate effective profile/`openPorts` before registry mutation and preserve safe registry behavior |
| `cli/services/bootstrapManifest.js` | Extract side-effect-limited manifest repository preparation |
| `cli/services/boxPublicationCoverage.js` | Add shared in-box command preflight and actionable host retry guidance |
| `cli/services/boxStartPublishPlan.js` | Add authoritative workspace graph planner, request validation, serialization, and planning lock |
| `cli/services/dependencyCache.js` | Use forced nested runtime and managed helper creation |
| `cli/services/dependencyRuntimeKey.js` | Make runtime-key probes use the effective nested Podman policy and managed label |
| `cli/services/docker/agentServiceManager.js` | Centralize managed run arguments, publication guards, and nested agent creation/recreation behavior |
| `cli/services/docker/common.js` | Add box marker/runtime policy, managed label builders, canonical `openPorts`/coverage checks, and widen nested loopback binds only inside the isolated outer namespace |
| `cli/services/docker/index.js` | Export the new shared runtime helpers |
| `cli/services/docker/interactive.js` | Apply nested Podman and the managed label to interactive creation/retry paths |
| `cli/services/docker/shellDetection.js` | Label ephemeral shell-detection containers |
| `cli/services/help.js` | Document the new public grammar and box behavior |
| `cli/services/ploinkyboot.js` | Expose default boot-repository preparation without enable/start mutation |
| `cli/services/repos.js` | Support planner branch preparation and start parsing contracts |
| `cli/services/sandboxRuntime.js` | Resolve the effective forced runtime inside the box |
| `cli/services/updateService.js` | Keep Ploinky self-update safe when core is host-mounted into the box |
| `cli/services/workspaceDependencyGraph.js` | Add effective-instance/profile conflict handling and deterministic graph data |
| `cli/services/workspaceUtil.js` | Integrate planner coverage, dependency-mode reconciliation, readiness, and lifecycle paths |

### Outer runtime production files

| File | Change |
| --- | --- |
| `container/box-publish-planner.mjs` | Replace Explorer-specific discovery with generic claim validation and interval subtraction |
| `container/box-start-publish-plan.mjs` | Add direct-node, stdin/stdout-bounded planner entrypoint |
| `container/runtime-contract.mjs` | Define exact contract-2 image/container/volume metadata, publication provenance, merge/diff/run arguments, and socket validation |
| `container/runtime-engine.mjs` | Add bounded capture/stream behavior and normalized engine failures |
| `container/runtime-supervisor.mjs` | Implement grammar, identity, cross-engine discovery, locking, pull/validation, planning, replacement, forwarding, status, stop, and volume-preserving destroy |
| `container/smoke-runtime.mjs` | Exercise public automatic discovery, deterministic identities, contract 2, nested Podman, cleanup, ports, and persistence |

### Documentation files

| File | Change |
| --- | --- |
| `README.md` | Document public Ploinky Box commands and exact-cwd behavior |
| `container/README.md` | Document the supervisor, contract 2, engine ownership, volumes, publications, cleanup, and recovery |
| `docs/cli-reference.html` | Align CLI surface wording |
| `docs/code-derived-agent-lifecycle.md` | Document nested lifecycle and publication checks |
| `docs/ploinky-overview.md` | Align overview terminology |
| `docs/specs/DS004-agent-manifest-and-registry.md` | Define `openPorts`, registry, profile, and effective-instance contracts |
| `docs/specs/DS005-runtime-execution-and-isolation.md` | Define forced nested Podman and ownership labeling |
| `docs/specs/DS008-dependency-caches-and-startup-readiness.md` | Define nested dependency cache/runtime and readiness behavior |
| `docs/superpowers/plans/2026-07-11-ploinky-box-invariant-alignment.md` | Record final approved decisions and implementation sequencing |
| `docs/superpowers/specs/2026-07-11-mutable-runtime-image-hard-cut-design.md` | Align the hard-cut design with contract 2 |

### Tests and fixtures

| File | Coverage added or changed |
| --- | --- |
| `container/runtime-supervisor-tests.mjs` | Grammar, identity, engine states, resources, pull/reuse, provenance, replacement, status/stop/destroy, rollback, and forwarding |
| `tests/helpers/runtimeSupervisorHarness.mjs` | Deterministic fake engines, images, volumes, process results, and supervisor mutation audit |
| `tests/fixtures/onlyoffice-openports.json` | Real-shaped stable OnlyOffice claim fixture with provenance comment |
| `tests/unit/boxPublishPlanner.test.mjs` | Generic claims, conflicts, protocols, ranges, port zero, router reservation, and partial override subtraction |
| `tests/unit/boxStartPublishPlan.test.mjs` | Bare/qualified resolution, branches, profiles, aliases, dependencies, enabled nodes, and clean JSON |
| `tests/unit/boxStartPublishPlanLock.test.mjs` | Concurrent lock ownership, stale recovery, signals, timeouts, and reapers |
| `tests/unit/branchAwareStart.test.mjs` | Branch-policy and empty-workspace spelling equivalence |
| `tests/unit/containerMonitorPublication.test.mjs` | Monitor fail-closed behavior without router termination |
| `tests/unit/containerRuntime.test.mjs` | Managed creation and effective nested runtime behavior |
| `tests/unit/enableAgentStartup.test.mjs` | Enable preflight and launch ordering |
| `tests/unit/helpLayers.test.mjs` | Public help and removed flag behavior |
| `tests/unit/managedContainerLabels.test.mjs` | Exact managed label on persistent and ephemeral creation builders |
| `tests/unit/marketplacePublication.test.mjs` | Marketplace denial before registry/filesystem mutation |
| `tests/unit/outerPublicationCoverage.test.mjs` | Operation request mapping, coverage, actionable errors, and REPL denial |
| `tests/unit/runtimeShell.test.mjs` | Parameterless `cli` Bash and shell marker behavior |
| `tests/unit/sandboxRuntime.test.mjs` | Forced Podman and outside-box compatibility |
| `tests/unit/updateService.test.mjs` | Safe host-mounted self-update behavior |
| `tests/unit/workspaceDependencyGraph.test.mjs` | Effective instances, profiles, aliases, modes, conflicts, cycles, and selection paths |

## AssistOSExplorer and OnlyOffice Changes

### Stable ports

Every OnlyOffice profile now publishes:

| Plane | Default/prod | Dev | Notes |
| --- | --- | --- | --- |
| Control | `127.0.0.1:17002:7000` | `127.0.0.1:17002:7000` | Router-facing protected control service |
| Editor | `127.0.0.1:8082:8080` | `127.0.0.1:18082:8080` | Browser editor assets/WebSockets |
| Storage | Not published | Not published | Loopback-only port 9100 |

LiveKit remains on 17000. Port zero is not treated as an ephemeral outer
publication because the outer boundary must be known before nested mutation.
As observed topology context, WebMeet's prod manifest already claims
`127.0.0.1:17001:7000`, so 17002 also avoids that existing socket; this was not
the retroactive basis for the approved stable-port policy.

Files changed by `f074338`:

| File | Change |
| --- | --- |
| `onlyOffice/manifest.json` | Replace `127.0.0.1:0:7000` in default/dev/prod with stable 17002 |
| `onlyOffice/tests/manifest-env.test.mjs` | Assert stable mappings and plane separation |
| `onlyOffice/docs/specs/DS01-ploinky-agent-invariant.md` | Define control/editor/storage topology |
| `docs/specs/DS04-onlyoffice-integration.md` | Update Explorer-facing integration contract |
| `docs/specs/DS06-ploinky-runtime-invariants.md` | Record stable outer publication requirement |

### RabbitMQ nested-rootless failure and correction

OnlyOffice uses RabbitMQ internally as the Document Server task broker between
DocService and conversion workers. Ploinky, Explorer, and other workspace
agents do not connect to RabbitMQ directly. Port 5672 is internal and is not
published through the box.

The clean first deployment exposed two procfs incompatibilities:

| Failure | Concrete evidence | Fix |
| --- | --- | --- |
| RabbitMQ broker boot | Default `rss` calculation called `vm_memory_monitor:read_proc_file` and failed with `{error,enoent}` because the inner PID was absent from the outer procfs view | Normalize `/etc/rabbitmq/rabbitmq.conf` to one `vm_memory_calculation_strategy = erlang` line before startup |
| Debian service startup wait | The broker listened on 5672, but `/etc/init.d/rabbitmq-server` waited up to 600 seconds in `rabbitmqctl wait` for the inner PID file to reference a PID visible through procfs | Start only the local bundled broker with the init script's underlying `start-stop-daemon` command; retain the upstream AMQP TCP wait on the configured broker host/port as the RabbitMQ startup gate |

The wrapper preserves unrelated RabbitMQ configuration, removes duplicate or
conflicting strategy entries, preserves existing owner/mode, and creates a new
file as `root:rabbitmq` mode `0640`. It fails closed if the expected upstream
`service $i start` anchor no longer appears exactly once.

Remote AMQP behavior remains upstream-compatible: when the configured AMQP host
is not local, `rabbitmq-server` is not added to `LOCAL_SERVICES`, so the direct
local start branch is never executed.

Files changed by `f677660` and `a11271a`:

| File | Change |
| --- | --- |
| `onlyOffice/scripts/run-document-server-with-autoassembly.sh` | Add RabbitMQ config normalization and direct local daemon start before the existing auto-assembly patch |
| `onlyOffice/tests/document-server-wrapper.test.mjs` | Prove unrelated config preservation, duplicate replacement, PostgreSQL upstream service path, direct Rabbit start, supervisor continuation, and auto-assembly |
| `onlyOffice/docs/specs/DS01-ploinky-agent-invariant.md` | Specify nested-rootless memory and PID-wait behavior |
| `onlyOffice/docs/index.html` | Add operator-facing runtime explanation |

No OnlyOffice image was rebuilt or published for this fix. The mounted branch
source performs the correction each time the agent container is created.

## container-image-builds Changes

| File | Change in `2dc6dad` |
| --- | --- |
| `images/ploinky-box/Dockerfile` | Build Node tooling into a prepared Podman rootfs, reconstruct a clean contract-2 final stage, reapply helper capabilities, and state exact metadata |
| `images/ploinky-box/entrypoint.sh` | Add runtime self-checks, full ID mapping checks, ephemeral runtime reset, and exact-label nested cleanup with failure diagnostics |
| `.github/workflows/publish-ploinky-box-image.yml` | Resolve one immutable source SHA, build/gate native amd64 and arm64 candidates by digest, then atomically move `:runtime` only after both succeed |
| `tests/image-definitions.test.mjs` | Assert contract metadata, clean final stage, source-free image, native gates, exact cleanup filters, failure injection, and two-digest merge structure |
| `README.md` | Document contract 2, mounts, mutable publication, cleanup/recovery, workflow authorization, and manual dispatch |

### Publication record

| Field | Value |
| --- | --- |
| Workflow | `Publish ploinky-box image` |
| Run | `https://github.com/AssistOS-AI/container-image-builds/actions/runs/29159377548` |
| Trigger | `workflow_dispatch` |
| Workflow commit | `2dc6dadad7edda80c44a0c33f695a3207f577a77` |
| Immutable Ploinky source | `9b1b46689819f562705d1a8a95c8df35a71e477d` |
| Started | `2026-07-11T16:13:05Z` |
| Finished | `2026-07-11T16:16:05Z` |
| Result | Success |
| Final manifest | `sha256:f39d59638d75b7720dff65e3cde85be7fbfe3e8c127f67d347b15780683ca235` |
| amd64 child | `sha256:c545f400cace8725be07456570606d49b1211fa2333aeaad2d30587ce7cbeb3a` |
| amd64 config/image ID | `sha256:f9b39981b14e0f56ea445d2af6cec9e3186953647fe987f4e028b5369a5b91e1` |
| arm64 child | `sha256:31213d6af686df6908c7ce45b4dffa56ef9ab1b797e4caa1b7de1a111afdd746` |
| arm64 config/image ID | `sha256:f00b4aa52fba32fe9d31f9f4bc5b3d5fce14c46f3d50dab022a7bd5388245691` |

The run had four successful jobs: immutable source resolution, native amd64
build/gate, native arm64 build/gate, and mutable multiarchitecture publication.
Each native job passed exact metadata, source-free filesystem, mounted source
and dependency volume, nested Podman, selective cleanup, injected enumeration
and removal failure, and platform checks before exporting its digest. The merge
job required exactly two nonempty distinct candidates before moving the tag.

The workflow is manually dispatched; `source_ref` defaults to `master`, and
there is no public image-tag input because `runtime` is the sole channel. It
uses `ubuntu-24.04` for amd64 and `ubuntu-24.04-arm` for arm64 rather than QEMU.
Workflow concurrency is serialized with `cancel-in-progress: false`. BuildKit
provenance attestations are disabled; the workflow's verified SHA and digest
record is the intended provenance.

The image inputs remain tag-based (`quay.io/podman/stable` and
`node:24-bookworm-slim`), not digest-pinned. A future publication can therefore
change base content even when repository source is unchanged; native gates are
the mandatory safety boundary. Architecture digest artifacts have one-day
retention, so this handoff, the workflow log, and registry digests are the
durable publication record.

| Job | GitHub job ID | Result |
| --- | ---: | --- |
| Resolve Ploinky source | `86561695932` | Success |
| Build and gate linux/amd64 | `86561703695` | Success |
| Build and gate linux/arm64 | `86561703717` | Success |
| Publish mutable multiarchitecture runtime | `86561911692` | Success |

## Review Record

### Read-only plan review

The plan review at `f5c822d` returned `APPROVE WITH CHANGES`. It validated the
current-code claims and identified missing decision traceability, the engine
environment override, unreachable engine semantics, helper capability/mapping
proofs, monitor/helper creation paths, start-tail port behavior, direct-node
planner requirements, and recovery documentation. The owner approved the
recommendations one at a time. D1-D12 remained approved; R1-R6 and the review
corrections were incorporated in `8363e6c`.

The untracked review artifacts are intentionally preserved and were never
staged:

```text
docs/superpowers/plans/2026-07-11-ploinky-box-invariant-alignment-review.md
docs/superpowers/plans/2026-07-11-ploinky-box-invariant-alignment-review-prompt.md
```

### Implementation reviews

A read-only Claude Code review was run with the requested `fable` model and
maximum effort. No review transcript was committed.

| Review finding | Resolution before `9b1b466` |
| --- | --- |
| Critical: temporary planner `run` lacked stdin retention | Added `-i`; planner request JSON now reaches the direct-node entrypoint |
| Documentation omitted the new 17002 control publication in one place | Added the missing port documentation |
| `cli`/`shell`/`reinstall` could perform duplicate planning receipt work | Consolidated the relevant planning boundary |
| Dead permissive port-parser helpers remained | Removed them so canonical parsing is unambiguous |
| The real-shaped OnlyOffice fixture lacked source context | Added the fixture source comment |

The final implementation review returned `APPROVE WITH CHANGES` with only the
four low-severity items above; all were corrected. A third Claude review was not
run after those mechanical fixes.

The later OnlyOffice source fix received an independent read-only review with
verdict `APPROVE`. It found no concrete defect in commits `f677660` or
`a11271a`, confirmed local/remote AMQP separation, config permissions, fail-
closed transform anchoring, and live 5672/80 readiness.

## Test and Verification Ledger

### Static and unit tests

| Area | Result |
| --- | --- |
| `container-image-builds/tests/image-definitions.test.mjs` | 13 passed |
| Focused Ploinky planner/runtime batch | 182 passed |
| Runtime supervisor suite | 140 passed |
| Branch-aware repository-fixture suite | 40 passed; fixture test containers were cleaned |
| Final focused regression subset | 67 passed |
| Final supervisor rerun | 140 passed |
| OnlyOffice complete default suite | 64 passed, 6 expected live-runtime skips |
| OnlyOffice wrapper focused test | 1 passed |
| JavaScript syntax checks | Passed for changed JS/MJS files |
| Shell syntax | Entrypoint and wrapper passed `bash -n` |
| Workflow YAML | Parsed successfully |
| Embedded workflow scripts | All 12 `run` blocks passed `bash -n` |
| Whitespace validation | `git diff --check` passed in every modified repository |

A final handoff regression audit reran a broader selected Ploinky set. Some
branch-aware tests launched synthetic host containers; all 30 leaked fixture
containers were subsequently removed without deleting volumes, and no test
container remains:

| Handoff-audit group | Result |
| --- | --- |
| Supervisor suite | 140 passed, 0 failed |
| Planner, planner lock, claim planner, and outer coverage | 36 passed, 0 failed |
| Branch-aware start | 40 passed, 0 failed |
| Help, managed labels, sandbox, container runtime, runtime shell, Marketplace, and monitor | 56 passed, 0 failed |
| Primary combined focused command | 272 passed, 0 failed |
| Supplemental workspace graph, update, and enable tests | 48 passed, 0 failed |
| Unique selected assertions across the audit | 320 passed, 0 failed |
| Syntax check over changed JavaScript/MJS files | 45 files passed |
| Post-audit artifact cleanup | Removed 30 exact synthetic branch-fixture host containers without `--volumes`; retained the outer box and all 22 nested agents |

The complete raw Ploinky `npm test` command was not accepted as a green release
signal in this environment because unrelated host test lanes require an absent
MCP SDK/dependency setup. Focused suites plus real runtime acceptance were used.
A future session should close this environmental gap rather than describing the
entire raw suite as passing.

### Image smokes

| Smoke | Result and proof |
| --- | --- |
| Local registry smoke | Passed with a process-scoped insecure localhost registry configuration; test resources were removed |
| Published image smoke | Passed against `docker.io/assistos/ploinky-box:runtime` |
| Contract metadata | Exact user/env/workdir/entrypoint/empty-command/empty-volumes contract observed |
| Mounted source/deps | Read-only `/opt/ploinky` and writable `/opt/ploinky/node_modules` verified |
| Nested Podman | Functional rootless nested execution verified |
| Managed cleanup | Exact-label running/stopped cleanup and manual-container preservation verified |
| Persistence | Nested image and named-volume sentinels survived boot cleanup |
| Failure paths | Cleanup enumeration/removal failures exited nonzero with diagnostics |

### Local Explorer acceptance

The exact command was run from `/home/skutner/work/file-parser` without public
engine/name overrides:

```bash
ploinky start explorer --branch=ploinky-box
```

The first-use dependency prompt was answered `y`. The command exited zero and
the router responded on `http://127.0.0.1:8080/status`. The command was repeated
during recovery and retained the deterministic outer identity.

| Acceptance check | Result |
| --- | --- |
| `ploinky status` | Exit 0; contract compatible and healthy |
| Outer mounts | Exactly three named volumes plus read-only Ploinky bind |
| Nested managed containers | 22 running, 22 total, every one labelled `io.assistos.ploinky.managed=1` |
| No-wait receipts | 16 total, 16 `running`, zero failed |
| Router `/status` | Protected request redirects to login; following redirect returns HTTP 200; `ploinky status` still reports healthy |
| Router `/dashboard` | Protected request redirects to login; following redirect returns HTTP 200 |
| Router `/explorer/` | Protected request redirects to login; following redirect returns HTTP 200 |
| Router `/` | Protected request redirects to login; following redirect returns HTTP 200 |
| WebTTY `:7681/` | HTTP 200 |
| OnlyOffice `:8082/web-apps/apps/api/documents/api.js` | HTTP 200, 64,320 bytes |
| OnlyOffice internal `/healthcheck` | HTTP 200 |
| Public OnlyOffice `/healthcheck` | HTTP 404, intentionally blocked |
| Public command/convert/internal routes | HTTP 404, intentionally blocked |
| RabbitMQ | Ping succeeds; effective strategy reports `erlang`; internal 5672 open |
| Document Server supervisor | `ds:converter` and `ds:docservice` report `RUNNING` through `supervisorctl` |
| Nginx | Configuration valid and service reachable on internal port 80 |

The six expected OnlyOffice skips are the live authenticated workspace session,
authenticated Confidential session through `dpuAgent`, cross-user Confidential
ACL denial, internet isolation of the internal document route, router-prefix
non-reexposure of that internal route, and the live editor/WebSocket allowlist
scenario. Final curl checks covered `api.js` and blocked HTTP endpoints, but did
not exercise an authenticated browser edit/save, WebSocket handshake, callback
persistence, or Confidential DPU flow. Do not claim those end-to-end contracts
were proven by this deployment session.

### Current nested suite

| Repository | Running agents |
| --- | --- |
| `AchillesIDE` | `explorer`, `dpuAgent`, `gitAgent`, `tasksAgent`, `soplangAgent`, `multimedia`, `webAssist`, `webmeetStt`, `webmeetAgent`, `onlyOffice` |
| `AchillesCLI` | `achilles-cli`, `codexAgent`, `opencodeAgent`, `piAgent`, `GPTResearcher` |
| `proxies` | `searchAgent`, `soul-gateway`, `default-local-llm` |
| `webmeetInfra` | `liveKitServerAgent` |
| `basic` | `web-publishing`, `webtty` |
| `UmamiAgent` | `umamiAgent` |

### Current outer publications

| Bind | Purpose/group |
| --- | --- |
| `127.0.0.1:8080/tcp` | Ploinky router |
| `127.0.0.1:17000/tcp` | LiveKit control publication |
| `127.0.0.1:17002/tcp` | OnlyOffice control publication |
| `127.0.0.1:19000/tcp` | WebMeet STT |
| `0.0.0.0:20000-20010/udp` | LiveKit media range |
| `0.0.0.0:3478/tcp` and `0.0.0.0:3478/udp` | TURN |
| `127.0.0.1:6379/tcp` | LiveKit Redis publication |
| `127.0.0.1:7681/tcp` | WebTTY |
| `0.0.0.0:7880/tcp` and `0.0.0.0:7881/tcp` | LiveKit TCP services |
| `0.0.0.0:7882-7892/udp` | LiveKit UDP services |
| `127.0.0.1:7980/tcp` | LiveKit agent service |
| `127.0.0.1:8081/tcp` | Web Publishing |
| `127.0.0.1:8082/tcp` | OnlyOffice editor proxy |

## Current Deployment Identifiers

These values describe the live local deployment at handoff and will naturally
change after a deliberate replacement:

| Item | Value |
| --- | --- |
| Outer name | `ploinky-box-file-parser-c4a17cbfee69` |
| Outer container ID | `501b84789937ca028c53beffefaf4fff1d8f6f62c83f1f803b6351d0412fc6b6` |
| Outer logical image | `docker.io/assistos/ploinky-box:runtime` |
| Outer local image ID | `f9b39981b14e0f56ea445d2af6cec9e3186953647fe987f4e028b5369a5b91e1` |
| OnlyOffice nested ID at final inspection | `b39666328fb9e652ce3c1bcee2beffd80e92848d93b7b2ce823ada27a41d3010` |
| OnlyOffice image | `docker.io/assistos/onlyoffice-agent:9.3.1` |
| OnlyOffice local image ID | `bba44041a898a25ec84407ebac7fbe60a5324040801066443204b3aca2d52f98` |
| Available host disk at final check | Approximately 18 GiB |

Do not destroy this deployment during a documentation or review-only task. The
owner explicitly asked that the successful local deployment remain available.

## Known Follow-up Work

### 1. Individual-agent planning can shrink the active outer publication set

Severity: high implementation defect; reproducible; not fixed in this session
after the owner narrowed the goal to successful local deployment.

Reproduction observed:

```bash
ploinky update AchillesIDE
ploinky reinstall onlyOffice
```

The `reinstall` preflight planned only OnlyOffice because
`plannerRequestForCommand('reinstall', ...)` currently sets
`includeEnabled: false`. It replaced a full Explorer outer box with a box that
published only `127.0.0.1:17002:17002` and `127.0.0.1:8082:8082`. Contract-2
boot cleanup then correctly removed all stale managed nested containers. Core
received `reinstall onlyOffice` after replacement and reported that the agent
was not running.

Observed transition:

| Stage | Outer ID | Publication state |
| --- | --- | --- |
| Original full deployment | `72d7688f389b...` | Full Explorer suite |
| Narrow reinstall replacement | `1d8abafe76e8...` | OnlyOffice control/editor only |
| Recovered full deployment | `501b84789937...` | Full Explorer suite |

Recovery used the required full-graph `start` path to restore publications.
After the second OnlyOffice wrapper commit was pulled into the managed
`AchillesIDE` checkout, `ploinky disable onlyOffice` removed only that nested
record/container and the next exact Explorer start re-enabled and cleanly
created it from the updated source. The outer ID remained `501b84789937...` and
the other nested agents were retained. `ploinky stop onlyOffice` is not an
individual-agent command; `stop` is workspace-wide and correctly rejected the
trailing argument during diagnosis.

The defect is broader than OnlyOffice: `cli`, `shell`, targeted `restart`,
`reinstall`, and `enable` requests currently use narrow target plans. A future
fix must retain publications for every currently active/running managed
instance while adding the requested target graph. It must not blindly include
merely installed agents. Add a real running-suite regression that proves an
individual-agent operation cannot remove unrelated active publications or
trigger their cleanup.

The relevant implementation chain is:

| Stage | Current defective behavior |
| --- | --- |
| Request mapping | `cli/services/boxPublicationCoverage.js` sets `includeEnabled: false` for targeted `cli`, `shell`, `reinstall`, `enable`, and targeted `restart` |
| Graph serialization | `cli/services/boxStartPublishPlan.js` serializes only the target for non-graph operations |
| Provenance | `container/runtime-supervisor.mjs` correctly treats every planner result as the complete new generated set |
| Reconciliation | `container/runtime-contract.mjs` sees the smaller set as a configuration change and requests replacement |
| Existing tests | Target-only expectations in `outerPublicationCoverage.test.mjs` and `boxStartPublishPlan.test.mjs` encode the defect instead of detecting it |

Smallest intended correction:

| Change | Required result |
| --- | --- |
| Request mapping | Include enabled effective instances for every targeted agent-starting operation |
| Planner | Compute target plus enabled registry records; do not merely retain old provenance because disabled/stale instances must disappear |
| Unit tests | With enabled A/B and target C, prove every targeted operation plans A+B+C |
| Supervisor tests | Start from A+B publications, run each targeted command, and prove A+B remain while C is added; unchanged plans reuse the box |
| In-box tests | Prove the complete enabled set is checked and insufficient coverage fails before mutation |

Do not paper over this by suppressing replacement or disabling provenance.
Correct the authoritative effective-active set and retain transactional
reconciliation.

### 2. OnlyOffice readiness currently has a false-positive window

Severity: medium acceptance gap; current deployment was verified explicitly.

The OnlyOffice manifest declares explicit TCP readiness for the decorator's
control listener. That listener opens before the bundled Document Server is
healthy. During the first deployment, `ploinky start explorer` exited zero and
the control/editor proxy sockets were open while Document Server port 80 was
absent and public `api.js` returned 500.

A future design should make blocking readiness prove the inner Document Server.
First replace or remove the explicit `readiness.protocol: tcp`; under current
precedence it would override a newly added `health.readiness.script` and retain
the false positive. Then add a blocking script that checks internal
`/healthcheck` and/or `api.js`. It must preserve the public allowlist and avoid
exposing a generic health endpoint. Add a regression in which the decorator is
listening but port 80 is down and prove startup does not report ready. This was
not changed after the owner narrowed the immediate goal to a successful local
deployment.

### 3. RabbitMQ `erlang` versus `allocated` memory accounting

Current committed and deployed value:

```text
vm_memory_calculation_strategy = erlang
```

This is RabbitMQ's legacy VM-reported active-memory calculation. It avoids the
unusable `/proc/<inner-pid>` lookup but can underreport unused/preallocated or
native memory. RabbitMQ's `allocated` strategy also avoids OS RSS lookup and is
generally closer to RSS because it uses Erlang allocator statistics.

The owner asked what this setting means. The recommendation was to test
`allocated` in the same nested deployment and prefer it if broker startup,
Document Server readiness, and memory alarms behave correctly. The owner has
not approved or requested that switch. Do not silently change it. If work
resumes, test it first in a disposable OnlyOffice container, then request an
explicit decision with the measured result.

### 4. Full Ploinky test-suite environment

Focused tests and real acceptance are green, but the complete raw `npm test`
lane has unrelated missing host MCP SDK/dependency requirements. A future
session should make the environment reproducible or isolate those lanes, then
record a genuinely complete result. Do not claim full-suite success from the
focused counts in this handoff.

### 5. Local public-topology warning

The Explorer start logs:

```text
Config provider warning: A base domain or explicit public host settings are needed before public topology can be generated.
```

This is expected for the current local workspace. Web Publishing passes TCP
readiness and is published on 8081, but public-host HTTP behavior is not fully
configured. It does not block the local router, Explorer, WebTTY, LiveKit, or
OnlyOffice acceptance. Do not treat it as a box failure; configure a base
domain only when public topology is explicitly in scope.

### 6. Nested procfs makes some SysV `service status` commands misleading

Inside the nested OnlyOffice container, `service supervisor status` can report
not running because it relies on PID lookup through the mismatched procfs view.
Use protocol readiness and `supervisorctl status`; both converter and
docservice were confirmed running. RabbitMQ `ping` works, while commands that
request RSS-rich status fields may still encounter procfs limitations.

### 7. OnlyOffice wrapper maintenance risks

The AWK transform is intentionally pinned to the OnlyOffice 9.3.1 upstream
script shape and exits with code 42 unless exactly one `service $i start` line
matches. Every `ONLYOFFICE_VERSION` upgrade must revalidate the upstream script.
The current unit test covers the one-match healthy path but not zero/multiple
matches, absent config creation/ownership, or remote-AMQP execution.

The direct daemon start omits the SysV init script's status precheck,
`/etc/default/rabbitmq-server` sourcing, PID wait, and cleanup-on-failure. In
particular, the init script would source its generated `ulimit -n` line. The
current nested runtime and retained AMQP TCP gate work, but future maintenance
should either prove the inherited limit is sufficient or source only the
required defaults while continuing to avoid `rabbitmqctl` PID lookup.

### 8. Additional Ploinky acceptance gaps

| Gap | Required future proof |
| --- | --- |
| Real Docker host | Unit harness covers parity, but the accepted deployment used host Podman |
| Real three-spelling equivalence | Fixtures prove bare/slash/colon equivalence; the real deployment exercised bare `explorer` only |
| Per-command denial snapshots | Shared guards exist, but only `start` has a full registry/config/hooks/router/container no-mutation snapshot |
| Provenance size limit | Runtime enforces 64 KiB; add a dedicated oversized explicit/generated provenance test |
| Running-box preparation ordering | Planner may prepare/switch repositories before replacement-image pull validation; outer shutdown still occurs only after successful pull/validation |

### 9. Approved plan execution markers are stale

The plan still says implementation/publication gates are pending and many task
checkboxes remain unchecked. Do not redo completed work from those markers.
Use the commit ledger, publication record, and test ledger in this handoff.

## Workspace Preservation Rules

The following Ploinky worktree state predates or is outside this handoff and
must remain untouched unless the owner explicitly changes scope:

```text
 M node_modules/achillesAgentLib
?? docs/superpowers/plans/2026-07-11-ploinky-box-invariant-alignment-review-prompt.md
?? docs/superpowers/plans/2026-07-11-ploinky-box-invariant-alignment-review.md
```

Never reset, stage, clean, or amend the `node_modules/achillesAgentLib` gitlink.
Do not stage the two review artifacts with this handoff. Preserve unrelated
dirty state in every sibling repository.

The root commit policy forbids co-author, generated-by, model, or tool
attribution in commits and documentation metadata.

## Safe Next-Session Checklist

| Order | Action |
| --- | --- |
| 1 | Read the workspace `CLAUDE.md`, repository instructions, this handoff, and the approved plan |
| 2 | Run `git status --short --branch` separately in `ploinky`, `AssistOSExplorer`, and `container-image-builds` |
| 3 | Confirm the known Ploinky gitlink/untracked artifacts are unchanged |
| 4 | Run `ploinky status` from `/home/skutner/work/file-parser` before any lifecycle command |
| 5 | If only inspecting, leave the live outer box and all nested containers running |
| 6 | If fixing individual-agent planning, add a regression before changing reconciliation |
| 7 | If evaluating RabbitMQ `allocated`, use a disposable test first and ask for approval before committing the strategy change |
| 8 | Keep source changes on `ploinky-box`; keep container image changes on `container-image-builds/main` |
| 9 | Run focused tests first, then real acceptance with the exact command |
| 10 | Commit only scoped files, push the required branch, and report exact SHAs |

Useful read-only checks:

```bash
cd /home/skutner/work/file-parser
ploinky status

podman inspect ploinky-box-file-parser-c4a17cbfee69 \
  --format '{{.Id}} {{.ImageName}} {{.State.Status}}'

podman exec ploinky-box-file-parser-c4a17cbfee69 \
  podman ps --filter label=io.assistos.ploinky.managed=1 \
  --format '{{.Names}} {{.Status}}'

curl -fsSL http://127.0.0.1:8080/status
curl -fsS -o /dev/null \
  http://127.0.0.1:8082/web-apps/apps/api/documents/api.js
```

The required local acceptance command remains:

```bash
cd /home/skutner/work/file-parser
ploinky start explorer --branch=ploinky-box
```

Because of the known narrow-planning defect, avoid targeted agent lifecycle
commands on the active suite until that issue is fixed or the full publication
set has been independently verified.

## Security and Secret Handling

No secret values were written to source, tests, logs quoted in this handoff, or
commit metadata. Docker Hub authentication remained in GitHub secrets. The
Cloudflare tunnel environment was not copied into the repository. OnlyOffice
JWT values and Ploinky master/derived secrets were never printed during
acceptance.

The box architecture does not mount a host Docker/Podman socket and does not
grant ordinary agent containers control over sibling containers. Nested
Podman remains the only in-box agent container engine.
