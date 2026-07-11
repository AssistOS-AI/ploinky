# Managed Ploinky Runtime

Ploinky uses one automatically managed outer container to isolate a workspace
and host nested agent containers. The host requires Node.js 20 or newer and
either Podman (preferred) or Docker. Git is optional on the host: it is useful
for cloning and enables automatic source-branch inference. The outer runtime
mounts the local Ploinky checkout read-only at `/opt/ploinky`; it does not rely
on baked Ploinky source or dependencies.

The public entrypoints are `bin/ploinky` and its `p-cli` alias. Host invocations
delegate to the runtime supervisor. Invocations already inside the managed
runtime execute Ploinky core directly, preventing recursive outer startup.

## Quick start

```bash
git clone https://github.com/AssistOS-AI/ploinky ~/work/ploinky
cd ~/work/myProject
~/work/ploinky/bin/ploinky start explorer
open http://127.0.0.1:8080/status
```

On first use, the supervisor reports
`Ploinky dependencies are not installed. Install them now? [y/N]`. A confirmed
install writes to the named dependency volume; a declined or non-interactive
install exits nonzero. Scripts may set `PLOINKY_BOX_INSTALL_DEPS=1`, or an
operator may invoke `/opt/ploinky/bin/ploinky-install-deps` inside the running
outer runtime.

## Public invocation contract

| Invocation | Documented effect |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start outer runtime; open Ploinky REPL |
| `ploinky cli` | Reconcile/start outer runtime; open `/bin/bash` as `podman` in `/workspace` |
| `ploinky cli <agent>` | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| `ploinky start ...` | Reconcile/start outer runtime; preserve graph publishes and router readiness |
| `ploinky status` | Inspect outer contract/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm exact instance and directly remove its outer container; retain all named volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

Host lifecycle commands and same-named REPL commands intentionally have
different scopes. Exit the REPL before operating on the outer runtime.

## Runtime image contract and reconciliation

The required multi-architecture release channel is the mutable reference
`docker.io/assistos/ploinky-box:runtime`. Its image must satisfy runtime
contract 2, including the exact label:

```text
io.assistos.ploinky.runtime-contract=2
```

The contract also requires user `podman`, working directory `/workspace`, the
`/usr/local/bin/ploinky-box-entrypoint` entrypoint, the exact runtime
environment validated by `runtime-contract.mjs`, and no default command or
image-declared volumes. The image is source-free; the selected Ploinky checkout
is mounted read-only at `/opt/ploinky`.

Creating a missing box or intentionally replacing one unconditionally pulls
the selected reference, validates its complete contract, resolves its local
image ID, and creates the box from that ID rather than from the mutable tag.
Pull failure never falls back to a cached tag. A running compatible box is
reused, and a stopped compatible box is started, without registry traffic.
Consequently, publishing a new `:runtime` manifest does not roll existing
boxes forward. Explicitly destroy the outer box and run an ordinary command to
pull a refreshed image while reusing its retained named state.

Before a configuration replacement, the supervisor validates the new image
without stopping the old box. It then captures the old image ID and normalized
creation configuration, gracefully stops core services, and replaces only the
outer container. A replacement creation or health failure reconstructs the
prior container. Workspace, nested-container-storage, and dependency volumes
are never removed by reconciliation.

When creation flags are omitted, reconciliation preserves inspected settings
except for authoritative generated publications. Explicit `--port`,
`--publish`/`--expose`, `--image`, `--mount`, or `--listen-lan` values
intentionally change their corresponding desired settings.

Contract 2 is a hard cut. A contract-1, malformed, or provenance-free box is
not migrated, copied, adopted, or transactionally upgraded; ordinary commands
fail before pulling or mutating it and require an explicit destroy. Legacy
basename-only boxes and volumes are not discoverable through the new identity
and remain untouched for manual inspection or removal.

## Instances, engines, and state

Every non-help host command canonicalizes the current directory with `realpath` and
derives exactly one identity:

```text
ploinky-box-<sanitized-directory-basename>-<first-12-hex-of-SHA256(canonical-path)>
```

The readable basename component replaces characters outside
`[a-zA-Z0-9_.-]` with `_`, falls back to `workspace`, and is capped at 48
characters. The path hash distinguishes same-named directories. There is no
public `--name`, `--engine`, or `PLOINKY_BOX_ENGINE` override.

Each instance owns exactly three persistent volumes:

| Suffix | Purpose |
| --- | --- |
| `-workspace` | Ploinky workspace and core state |
| `-containers` | Nested agent image and container storage |
| `-ploinky-deps` | Dependencies mounted at `/opt/ploinky/node_modules` |

Each named volume carries these ownership labels; no absolute path is stored:

| Label | Value |
| --- | --- |
| `io.assistos.ploinky.identity-schema` | `1` |
| `io.assistos.ploinky.path-hash` | The identity's 12-character path hash |
| `io.assistos.ploinky.volume-role` | `workspace`, `containers`, or `ploinky-deps`, matching the exact volume name |

Existing exact-named volumes without matching labels are foreign and are never
attached, rewritten, or removed automatically.

Ploinky discovers every Podman or Docker executable on `PATH` and requires
each installed engine to answer before mutation. It inventories the exact box
and all three labelled volumes on every answering engine, then selects the sole
resource owner. A partial valid set remains on that engine and missing roles
are created only on a later permitted create path. Split ownership, duplicate
boxes, foreign volumes, or an engine whose health/inspection result is unknown
fail closed. Only when neither engine owns any identity resource does Ploinky
prefer Podman over Docker. An engine whose executable is not installed cannot
be inventoried; reinstalling it can expose a split on the next command.

`ploinky help` remains host-local and performs no engine discovery. `ploinky
status` reports partial discovery and exits nonzero when ownership is
unresolved; other commands make no change.
`ploinky stop` preserves the box and all three volumes. `ploinky destroy`
confirms and directly removes only the box, using engine volume cleanup to
remove attached anonymous volumes while retaining all explicitly named
volumes. If the box is absent, destroy reports any retained named volumes and
succeeds without prompting or deleting them.

## Ports and graph-aware start

The selected host router port maps to container port 8080. Core always receives
`ploinky start <agent> 8080`; after that command succeeds, the supervisor probes
`http://127.0.0.1:<selected-host-port>/status`. A failed core start does not run
the router probe.

### Authoritative active-graph publishes

Before every one-shot host command that can start an agent (`start`, `enable agent`,
`cli <agent>`, `shell <agent>`, `restart`, or `reinstall`), an in-box planner
resolves the requested root, its active transitive dependencies, and any
additional enabled agents core will start. It reads authoritative repositories,
registry state, saved profile, branch policy, aliases, and manifest `openPorts`
from the named workspace. The same generic resolution rules apply to bare,
slash-qualified, and colon-qualified agent references. For example, in an
unambiguous boot workspace, `explorer`, `AchillesIDE/explorer`, and
`AchillesIDE:explorer` resolve to the same canonical root; other agents use the
same mechanism.

A child that lacks the workspace profile uses its `default` profile; an
explicit edge-local profile must exist. Selecting different profiles for the
same effective canonical or aliased instance fails before operational
mutation. Branch flags are forwarded unchanged, and an inferred source branch
is appended exactly once only when no explicit branch flag is present.

The planner executes in the running box, or in a unique short-lived container
from the stopped box's inspected image ID. For a missing box, Ploinky first
pulls and validates the image, creates the labelled workspace volume, plans in
a temporary container, and creates the final box from that same image ID.
Temporary containers and their anonymous volumes are removed on success or
failure. Repository preparation and the deterministic workspace volume remain
available for retry when a first plan fails.

Generated TCP and UDP examples include `8081:8081`, `3478:3478`,
`3478:3478/udp`, `7882-7892:7882-7892/udp`, and
`20000-20010:20000-20010/udp`. Internal databases, MCP/control surfaces,
private health and signaling endpoints, identity providers, LLM APIs, direct
document-server ports, and router-mediated HTTP services do not belong in
default `openPorts`. LiveKit/TURN media traffic is a reviewed exception because
nginx cannot proxy it.

Explicit publish values remain byte-for-byte engine syntax in their original
order. Ploinky canonicalizes only the terminal target interval and protocol for
conflict detection and subtracts explicit target coverage from generated
claims. An explicit `0.0.0.0:3478:3478/udp`, for example, suppresses the
covered generated UDP socket while leaving TCP and uncovered generated
subranges intact. Generated wildcard/specific-bind overlaps and other
same-protocol interval conflicts fail before runtime mutation. Box-side port
zero is invalid. Runtime-generated ephemeral mappings for an implicit
AgentServer or `additionalServerPort` remain separate private routes and are not
declared through `openPorts`.

Every supported box records versioned explicit and generated publication
provenance in supervisor-owned labels. A later plan preserves explicit
publishes when they were not restated, removes stale generated publishes, and
transactionally replaces the box when required. Missing or malformed
provenance makes the box unsupported instead of guessing which ports an
operator requested.

The supervisor passes the planned publication coverage into core. A one-shot
host command may reconcile the outer box before core mutation. A command
entered inside the REPL, a Marketplace request, or another already-in-box path
cannot replace its own outer container: it proceeds only when current coverage
is sufficient, otherwise it fails before registry, profile, hook, router, or
agent-container mutation and prints a one-shot host command to run.

## Source, dependencies, and isolation

`PLOINKY_BOX_SOURCE=/path/to/checkout` can select a different valid Ploinky
checkout for tests or development. The selected source is mounted read-only at
`/opt/ploinky`, while the dependency volume shadows its host `node_modules`.
Core edits in the selected host checkout are therefore visible without an
outer-image rebuild.

The outer runtime runs as `podman` and contains Bash, Node 24, npm/npx, Git,
and functional rootless nested Podman. It receives the devices and security
configuration required by that nested runtime. An explicit `--mount DIR` is a
writable host grant at `/workspace/mounted`; published ports are loopback-only
unless `--listen-lan` is explicit.

Ordinary agent images intentionally contain neither Podman nor Docker and are
not granted control of sibling containers. Inside a marked box, every
Ploinky-managed agent, helper, and sidecar container is forced through nested
Podman; Docker fallback and bwrap/Seatbelt host-sandbox selection are disabled
even if older workspace state enabled them. Outside a box, existing runtime
selection behavior remains unchanged.

Every Ploinky-owned nested container carries the exact label
`io.assistos.ploinky.managed=1`. On each outer-box boot, the entrypoint removes
running and stopped nested containers matching that exact key/value before
core starts. It preserves unlabelled containers, other values or near-name
labels, nested images, and nested named volumes. Enumeration or removal failure
fails the box self-check instead of continuing with ambiguous state. Manual
containers are outside Ploinky lifecycle ownership and are not promised
automatic restart or repair.

Before Podman opens the retained graph root, the entrypoint removes only its
transient `/tmp/storage-run-<uid>` and `/tmp/podman-run-<uid>` process/lock
state from the outer container filesystem. These paths are not the named
nested-storage volume; container records, images, and nested named volumes stay
retained. Failure to clear stale run state aborts boot.

## Status, shutdown, and destruction

`ploinky status` is strictly read-only. It reports missing, stopped, compatible,
unsupported, and unhealthy outer state, configured publishes, the observed image
contract, and core status only when the outer runtime is already running. It
does not pull, create, start, stop, remove, or reconcile.

`ploinky stop` skips reconciliation. It attempts core shutdown first and then
stops the outer runtime even when core shutdown fails, reporting both phases.
Repeated stop is an idempotent success. `ploinky destroy` also skips
reconciliation, directly removes the selected outer container and its attached
anonymous volumes, and retains the three managed named volumes.

Commands entered in the Ploinky REPL stay at core workspace/router/agent scope.
REPL `stop` leaves outer runtime state and volumes in place; REPL `destroy`
clears workspace agent runtimes and regenerated core dependency caches while
the outer runtime remains alive.

For a deliberate complete reset, first destroy the box, then remove the named
volumes from their owning engine after accepting data loss:

```bash
ENGINE=podman # or docker, as reported by status
INSTANCE=ploinky-box-WORKSPACE-PATHHASH
$ENGINE volume rm "$INSTANCE-workspace" "$INSTANCE-containers" "$INSTANCE-ploinky-deps"
```

A failed first-start plan may leave only the labelled workspace volume. Remove
that exact volume with the same engine command only when its prepared checkout
state is not needed. If boot cleanup repeatedly fails because nested storage is
corrupt, inspect and back up `$INSTANCE-containers`, remove the outer box, and
remove only that volume when its cached images, container records, and nested
volumes may be lost; ordinary destroy/recreate deliberately preserves it and
can repeat the failure.

The path-hashed supervisor does not target a legacy basename-only box. To
release its ports while preserving its volumes, identify its owning engine and
remove that exact old container directly without a volume-cleanup flag:

```bash
ENGINE=podman # or docker
LEGACY_INSTANCE=ploinky-box-OLDNAME
$ENGINE rm -f "$LEGACY_INSTANCE"
```

## Smoke and release ordering

`node container/smoke-runtime.mjs` is the real engine-backed public-entrypoint
smoke. It checks that help creates nothing, an ordinary command starts the
runtime, nested `podman version` and `podman info` work, combined status works,
stop is idempotent, confirmed destruction retains labelled volumes, and a
recreated box observes the retained workspace marker. The script accepts
`SMOKE_IMAGE` and `SMOKE_PORT` overrides; engine selection remains automatic.

The publication workflow moves the mutable `:runtime` channel only after
native amd64 and arm64 candidates both pass contract and nested-Podman gates.
The supervisor consults that channel only for create or replacement and keeps
existing boxes pinned to their inspected IDs.
