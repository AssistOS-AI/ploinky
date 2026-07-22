# Ploinky Box Container Invariants

Date: 2026-07-21

Status: superseded on 2026-07-21 — `2026-07-21-ploinky-box-invariants.md` is
the sole normative input for the ploinky-box implementation plan; this file is
retained for provenance only. The register absorbed this document's
multi-architecture release gate, per-identity mutation locking, base-box
secret hygiene, and graceful bounded-timeout stop. Its `ploinky box *`
lifecycle namespace (BOX-CLI-005), in-box marker prohibition (BOX-CLI-004),
and in-repo image-file requirement (BOX-ARCH-003) were rejected by owner
decision (register N3, N6, N7).

Scope: only the additional Ploinky Box layer, including its command boundary,
outer container, persistence, lifecycle, security boundary, and physical-host
port publications

## 1. Purpose

This document defines the invariants for adding Ploinky Box around the existing
Ploinky CLI. It is self-contained and was intended to be the sole requirements
input for a new implementation plan; that role has passed to
`2026-07-21-ploinky-box-invariants.md` (see Status above).

Ploinky Box is an additional execution layer. It is not a refactor, fork, or
replacement of Ploinky core. The implementation plan must describe how to add
that layer without changing existing core behavior.

The word **must** denotes a required invariant. **Must not** denotes a
prohibited implementation or state.

## 2. Terminology

- **Ploinky core**: the existing CLI, command registry, workspace discovery,
  agent lifecycle, Router, policy, WebChat, sandbox, and runtime code.
- **Direct CLI**: `ploinky-local`, which executes Ploinky core on the host.
- **Boxed CLI**: `ploinky`, which executes Ploinky core inside Ploinky Box.
- **Box**: the managed outer container created for one host workspace.
- **Inner containers**: containers started by Ploinky core from inside the Box.
- **Physical host**: the machine running the outer container engine.
- **Outer publication**: a physical-host-to-Box port mapping configured on the
  Box container.

## 3. Additive architecture boundary

### BOX-ARCH-001 — Ploinky Box is an adapter

Ploinky Box must wrap the existing Ploinky CLI as an external process. It must
not reimplement Ploinky commands, import Ploinky core internals, or become a
required runtime layer for direct operation.

The dependency direction is one way:

```text
ploinky -> ploinky-box layer -> ploinky-local -> existing Ploinky core
```

Ploinky core must not import, discover, or depend on Ploinky Box.

### BOX-ARCH-002 — No Ploinky core changes

Implementing Ploinky Box must not require behavioral changes under existing
core directories, including:

- `cli/`;
- `Agent/`;
- existing sandbox and container-runtime modules;
- existing Router, policy, WebChat, generation, relay, and lifecycle modules;
- existing core command implementations.

The Box must adapt to core through its existing executable, environment,
working-directory, filesystem, and container-runtime contracts.

If an implementation discovers that one of those contracts is insufficient,
the implementation plan must identify the missing boundary explicitly. It must
not silently add box-aware branches to core.

### BOX-ARCH-003 — Dedicated implementation root

All Ploinky Box implementation code and Box-specific tests must live under the
top-level `ploinky-box/` directory.

This includes:

- host-side argument parsing;
- outer-engine discovery;
- deterministic identity;
- locks and lifecycle operations;
- image inspection and runtime-contract validation;
- container reconciliation;
- volume reconciliation;
- port publication construction;
- process and TTY forwarding;
- Box status and diagnostics;
- Box image files, entrypoints, and integration scripts;
- optional connector supervision;
- Box unit, fixture, and real-engine tests.

No Box implementation module may be placed under `cli/`, `Agent/`, or another
existing Ploinky core directory.

### BOX-ARCH-004 — Wiring is not Box implementation logic

Only the following narrow repository wiring may change outside `ploinky-box/`:

- add the `ploinky-local` launcher that preserves the existing direct launcher;
- turn the public `ploinky` launcher into a thin delegate to the entrypoint
  under `ploinky-box/`;
- update package binary declarations;
- update shared documentation and test dispatch metadata.

Those files must contain no engine, image, lifecycle, volume, identity,
publication, or reconciliation logic.

The launcher rewiring is necessary only because the public command names have
new meanings. It is not a Ploinky core change.

### BOX-ARCH-005 — Core remains independently usable

Ploinky core must remain usable and distributable without the `ploinky-box/`
directory. Removing the Box layer from a distribution may remove `ploinky`,
but it must not prevent `ploinky-local` from executing core directly.

### BOX-ARCH-006 — Generic layer

The Box must not hardcode optional agent ids, provider tags, agent-owned tool
names, product repositories, application routes, or product-specific port
lists. Its outer runtime contract must be independent of the enabled agent
graph.

## 4. Binary and command boundary

### BOX-CLI-001 — Two first-class commands

The repository must expose two commands with distinct meanings:

| Command | Required behavior |
| --- | --- |
| `ploinky-local` | Execute the existing Ploinky CLI directly on the host. |
| `ploinky` | Execute the existing Ploinky CLI through the managed Box. |

The direct implementation currently reached through `bin/ploinky` must be
preserved by `ploinky-local`; it must not be copied into the Box layer.

### BOX-CLI-002 — Direct means direct

`ploinky-local [arguments...]` must invoke the existing core entrypoint
directly. It must not inspect, create, start, enter, stop, or require a Box.

It must preserve existing behavior for:

- interactive mode;
- all core commands and aliases;
- workspace and launch-directory discovery;
- host sandbox and container-runtime selection;
- stdout, stderr, stdin, TTY, signals, and exit status;
- Router, policy, WebChat, and agent behavior.

Engine-independent direct commands must remain usable when no outer container
engine is installed.

### BOX-CLI-003 — Boxed means boxed

`ploinky [core arguments...]` must ensure or reuse the Box selected for the
invocation workspace and execute:

```text
ploinky-local [core arguments...]
```

inside that Box.

It must never execute core directly on the host. A missing, incompatible, or
broken Box must produce an explicit failure, not a direct-core fallback.

Bare `ploinky` must start the existing interactive CLI inside the Box.

### BOX-CLI-004 — No dual-personality executable

`ploinky` must not inspect an environment variable, marker file, hostname,
installation path, or container identity to decide whether it should execute
core directly.

The Box must invoke `ploinky-local` explicitly. This prevents recursion without
making Ploinky core box-aware.

### BOX-CLI-005 — Box lifecycle has a separate namespace

Host-side Box lifecycle commands must use this namespace:

```text
ploinky box start
ploinky box status
ploinky box stop
ploinky box destroy
```

All other `ploinky` commands are core commands and must be forwarded into the
Box. Existing core commands named `start`, `status`, `stop`, or `destroy` must
retain their existing meaning.

For example:

- `ploinky status` runs core `status` inside the Box;
- `ploinky box status` inspects the outer Box without running core `status`.

### BOX-CLI-006 — Exact command forwarding

Core arguments must retain their exact order, spelling, values, empty values,
and `--` separators. Box parsing must not consume a core option merely because
its name resembles a Box option.

Unknown Box options must fail before any engine mutation.

### BOX-CLI-007 — Process fidelity

Box execution must preserve:

- TTY allocation only when the caller has a TTY;
- piped stdin without manufacturing a TTY;
- stdout and stderr separation;
- terminal size and resize propagation where supported;
- interrupt and termination behavior;
- the inner command's exit status;
- working-directory intent inside the selected Box workspace.

No wrapper may convert a nonzero core exit to success.

### BOX-CLI-008 — Existing aliases remain thin

Existing aliases may follow the public `ploinky` launcher and therefore become
boxed, or may be assigned explicitly to `ploinky-local`. The implementation
plan must state and test each assignment. An alias must not duplicate Box or
core logic.

## 5. Box identity and persistence

### BOX-ID-001 — Deterministic per-workspace identity

The host layer must derive exactly one Box identity from the canonical physical
path of the invocation workspace.

- Symlink aliases of the same path must select the same Box.
- Same-named directories at different paths must select different Boxes.
- Names must be bounded and engine-safe.
- Cleartext absolute workspace paths must not be stored in labels.

The identity must contain a readable slug and a content-derived path hash.

### BOX-ID-002 — No casual identity override

Ordinary users must not be able to redirect a command to an unrelated Box with
a raw container name or engine environment override. Test-only injection must
use an internal seam.

### BOX-STATE-001 — Boxed and direct state are separate

The default Box must use a dedicated workspace volume. `ploinky` and
`ploinky-local` therefore operate on separate physical state even when invoked
from the same host directory.

The Box must not mount the host workspace read-write by default or merge host
and boxed `.ploinky/` or `.data/` state implicitly.

Any future host-workspace mount is a separate opt-in filesystem grant. It must
be visible in status and must not be introduced as an implementation shortcut.

### BOX-STATE-002 — Stable in-box workspace

Core must run from a stable in-box workspace, conventionally `/workspace`.
Repeated boxed invocations for the same host workspace identity must observe
the same boxed `.ploinky/` and `.data/` state.

### BOX-STATE-003 — Separate persistent roles

The Box must keep separate persistent storage roles for:

- the Ploinky workspace and core state;
- nested container images, records, and named volumes;
- Ploinky JavaScript dependencies.

Each managed volume must have exact ownership, workspace-hash, contract, and
role labels. A same-named volume with missing or mismatched labels is foreign
and must not be attached, adopted, relabelled, or deleted automatically.

### BOX-STATE-004 — Source is read-only

The selected Ploinky source must be mounted read-only at a stable in-box path,
conventionally `/opt/ploinky`. Writable dependencies must use their dedicated
persistent volume rather than making the source writable.

Development source edits must not require rebuilding the Box image.

### BOX-STATE-005 — Normal lifecycle preserves state

Stop, container recreation, image replacement, and `ploinky box destroy` must
preserve all managed named volumes by default.

Deleting managed volumes must be a separate destructive reset with exact
targets and a data-loss warning. Normal lifecycle must never run a broad engine
prune.

## 6. Outer runtime and image contract

### BOX-RUN-001 — Supported outer engine

The host layer may use a supported Podman or Docker engine for the outer Box.
Engine discovery and selection belong entirely to `ploinky-box/`.

Engine selection must be deterministic and visible in status. The layer must
not mutate resources when ownership is ambiguous across multiple engines.

### BOX-RUN-002 — Rootless nested runtime

The Box must run as a non-root user and provide a functional rootless Podman
runtime for inner containers.

The host engine socket must not be mounted into the Box. Ploinky core and
ordinary inner agents must not be able to control sibling host containers.

### BOX-RUN-003 — Minimum outer privilege

The Box must not run privileged or receive blanket capabilities. Devices,
capabilities, mounts, and security options must be an exact validated allowlist
required by the nested rootless runtime.

Runtime drift from the allowlist makes the Box incompatible.

### BOX-RUN-004 — Versioned image contract

The Box image must declare a versioned runtime-contract label and exact
security-relevant metadata, including:

- image identity;
- user;
- working directory;
- entrypoint and command shape;
- required environment;
- declared persistent-volume roles;
- supported architecture.

The host layer must inspect and validate that contract before first execution.

### BOX-RUN-005 — Immutable execution identity

A mutable release-channel tag may be resolved before Box creation, but the
container must be created from the validated immutable image id or digest.

Pull or validation failure must not fall back silently to an unvalidated cached
tag. A compatible existing Box remains pinned until an explicit replacement.

### BOX-RUN-006 — Hard-cut compatibility

An absent, malformed, old-contract, foreign, or drifted Box must not be
silently adopted, migrated, relabelled, or destructively replaced.

Status must report the incompatibility. Replacement requires an explicit Box
lifecycle action and must preserve managed named volumes.

### BOX-RUN-007 — Multi-architecture contract

The same runtime and security contract must pass native amd64 and arm64 smoke
tests. Architecture support must not be inferred from a successful image build
alone; nested rootless Podman and the exact port boundary must work on each
supported architecture.

## 7. Physical-host port boundary

### BOX-PORT-001 — Exactly two outer publications by default

Every standard Box must publish exactly these two mappings:

| Mapping | Physical bind | Purpose |
| --- | --- | --- |
| `127.0.0.1:<routerHostPort>:8080/tcp` | Host loopback only | HTTP Router |
| `0.0.0.0:7882:7882/udp` | Host IPv4 wildcard | Reserved UDP transport |

`routerHostPort` defaults to `8080` and may be selected explicitly before Box
creation. The in-box Router port remains `8080`.

The UDP host and container port is fixed at `7882` and must not auto-remap.

"Exactly two" refers to outer engine publication entries. It does not prohibit
private listeners inside the Box or its inner containers.

### BOX-PORT-002 — Publications are Box-owned constants

The Box layer must construct both outer mappings before reading or invoking any
Ploinky workspace, profile, manifest, enabled-agent graph, route generation,
readiness state, or runtime state.

No core or agent state may add, remove, or alter an outer publication.

### BOX-PORT-003 — No arbitrary publication escape hatch

The standard Box command surface must reject raw publish, expose, LAN-listen,
and arbitrary extra-port options. Environment variables and persisted state
must not add a third mapping.

A future additional outer port requires a separately reviewed runtime-contract
change. It is not a per-invocation override.

### BOX-PORT-004 — Router bind preserves physical loopback

Inside the Box, the existing Router must be configured through its supported
environment so the outer port forward can reach it:

```text
PORT=8080
PLOINKY_PUBLIC_BIND=0.0.0.0
PLOINKY_PUBLIC_AUTHORITY=127.0.0.1:<routerHostPort>
```

The wildcard in-box bind must never produce a wildcard physical-host TCP bind.
The outer TCP mapping remains on `127.0.0.1`.

The default authority is `127.0.0.1:8080`. A non-default physical host port
must be reflected in the authority while the in-box listen port remains `8080`.

### BOX-PORT-005 — The private Router remains private

The core private Router listener at `127.0.0.1:8081` must not appear in outer
port bindings. The Box must not add a forwarding bridge to it or bypass its
existing admission checks.

### BOX-PORT-006 — Inner TCP services remain unpublished

Agent HTTP services, readiness listeners, databases, storage services, health
listeners, WebSocket services, SSE services, and other inner TCP listeners must
not create physical-host Box publications.

All host HTTP, WebSocket, and SSE ingress must use the Router TCP publication
and the existing core routing and policy path.

### BOX-PORT-007 — Preserve the existing confined relay

The Box must not reintroduce TCP publication for inner agent containers. It
must preserve the existing authenticated container-exec/stdio relay and
immutable route-selection behavior as an opaque core contract.

### BOX-PORT-008 — UDP reservation is unconditional

The UDP `7882` mapping must exist even when no inner process currently consumes
it. The Box layer must not inspect agents or routes to decide whether to publish
it.

If physical-host UDP `7882` is unavailable, Box creation must fail with a clear
diagnostic. It must not choose another port, omit UDP, or continue partially.

### BOX-PORT-009 — No additional inbound Internet socket

The Box must not publish an HTTPS port, a second Router port, or an additional
TURN socket. Any optional public-edge connector must reach the Router through
an outbound connection and must not add an outer inbound publication.

## 8. Security boundary

### BOX-SEC-001 — Core security remains authoritative

The Box must not modify, replace, or bypass existing Router authentication,
request-bound identity, route policy, workspace confinement, private-listener
admission, generation activation, header sanitation, or relay signing.

Box health is not authorization to bypass core policy.

### BOX-SEC-002 — No routing synthesis

The Box may start core and check its health, but it must not synthesize route
generations, rewrite policy, declare agent readiness, choose inner service
ports, or commit core runtime leases.

### BOX-SEC-003 — No trusted-header bypass

The Box and optional connectors must not make inbound client-supplied
`x-ploinky-*`, forwarded identity, or authorization headers authoritative.
Requests must enter through the existing Router sanitation and authentication
path.

### BOX-SEC-004 — Secrets remain out of engine metadata

Secrets must not appear in:

- outer-engine argv;
- inspectable container environment;
- labels;
- image metadata;
- status output;
- dry-run output;
- routine logs.

Secrets required inside the Box must use a narrowly scoped runtime secret
transport and must be cleaned up on failure.

### BOX-SEC-005 — Fail closed

Engine ambiguity, incompatible image metadata, ownership mismatch, malformed
state, port conflict, nested-runtime failure, or Router-health failure must not
produce a less isolated mode, different port, or host-core fallback.

## 9. Optional outbound connector boundary

### BOX-CONN-001 — Connector support is optional

The Box must operate correctly without public-edge credentials or a connector.
Connector absence must not change the exact two-port outer publication set.

### BOX-CONN-002 — Connector belongs to the Box layer

If an outbound public-edge connector is included, its supervision and
configuration must live under `ploinky-box/`. Ploinky core and agent manifests
must not depend on it.

### BOX-CONN-003 — Fixed local origin

The connector must use the Box Router as its origin through
`http://127.0.0.1:8080` or an equivalent fixed in-box address. It must not use
an agent port or private Router port as an origin.

### BOX-CONN-004 — Complete credentials or no connector

No credentials means local-only Box operation. A complete valid credential set
may enable the connector. Partial, malformed, unauthorized, or unhealthy
credentials must fail connector startup without widening the physical-host
port boundary or exposing secrets.

## 10. Lifecycle and reconciliation

### BOX-LIFE-001 — Ensure then invoke

For a core command, `ploinky` must:

1. resolve the canonical workspace identity;
2. acquire the identity lock;
3. discover the selected outer engine;
4. inspect exact-named Box resources;
5. validate ownership and image contract;
6. create or start a compatible Box when required;
7. verify nested-runtime and Router readiness;
8. release the mutation lock;
9. invoke `ploinky-local` inside the Box.

The Box layer must not inspect the Ploinky agent graph to complete these steps.

### BOX-LIFE-002 — Status is read-only

`ploinky box status` must not pull, create, start, stop, replace, relabel, or
delete anything. It must report engine, identity, compatibility, state, image,
volumes, exact port bindings, nested-runtime health, Router health, and optional
connector health.

### BOX-LIFE-003 — Mutations are serialized

Create, start, stop, destroy, replace, and reconciliation for one Box identity
must be serialized with a host-side lock. Stale-lock recovery must prove that
the recorded owner is gone before removing the lock.

### BOX-LIFE-004 — Stop is graceful and idempotent

`ploinky box stop` must be safe to repeat. It must request graceful shutdown of
in-box services before stopping the outer container, subject to a bounded
timeout. It must preserve all managed volumes.

### BOX-LIFE-005 — Destroy is narrow and idempotent

`ploinky box destroy` must remove only the selected managed outer container and
its transient resources. It must not remove managed named volumes, inner state
volumes, foreign resources, or resources belonging to another workspace.

### BOX-LIFE-006 — Foreign ownership fails closed

If exact-named containers or volumes have missing or mismatched ownership
labels, mutation must stop. The Box layer must report the conflict and must not
adopt, relabel, copy, merge, or delete the resource automatically.

### BOX-LIFE-007 — Split-engine ownership fails closed

If multiple answering engines own resources for the same deterministic Box
identity, the layer must report both inventories and refuse mutation. It must
not guess which engine is authoritative.

## 11. Required verification

### BOX-VER-001 — Source boundary

Automated checks must prove:

- all Box implementation modules and Box-specific tests are under
  `ploinky-box/`;
- existing core modules do not import from `ploinky-box/`;
- Box modules execute the public direct CLI instead of importing core internals;
- files outside the approved launcher, package, documentation, and test-dispatch
  wiring contain no Box logic.

### BOX-VER-002 — Direct CLI preservation

The existing core test suites must pass unchanged through `ploinky-local`.
Engine-independent direct commands must pass with no outer engine available.

Tests must prove that `ploinky-local` never performs Box engine discovery or
mutation.

### BOX-VER-003 — Boxed command forwarding

Tests must cover bare interactive mode and every registered core command.
Forwarded argv, stdin, stdout, stderr, TTY behavior, signals, and exit codes must
match direct execution except for the intended container boundary.

A recursion test must prove the Box invokes `ploinky-local`, never `ploinky`.
A failure test must prove Box failure never falls back to direct execution.

### BOX-VER-004 — Exact two-port boundary

Normalized engine inspection must show exactly:

```text
127.0.0.1:<routerHostPort>:8080/tcp
0.0.0.0:7882:7882/udp
```

The same set must be observed with:

- an empty Box workspace;
- ordinary agents enabled;
- full-stack fixtures enabled;
- no UDP consumer running;
- a non-default Router host port;
- malformed core workspace or routing state.

Tests must also prove:

- physical LAN TCP access fails;
- host-loopback Router access succeeds;
- private `8081` is absent;
- no inner TCP listener appears as a third publication;
- raw publication options fail before engine mutation;
- an existing UDP `7882` owner blocks creation without remapping.

### BOX-VER-005 — Persistence and ownership

Workspace, nested-runtime, and dependency sentinels must survive stop, destroy,
and explicit compatible recreation. Foreign or mislabeled volume controls must
never be attached or removed.

### BOX-VER-006 — Security

Tests must prove that ordinary inner agents cannot access a host engine socket
or control siblings, Router policy remains authoritative, and exact secret
canaries do not appear in engine metadata, status, dry runs, or logs.

### BOX-VER-007 — Lifecycle states

Tests must cover missing, stopped, running-compatible, malformed,
old-contract, foreign, drifted, and split-engine states. They must prove status
is read-only, mutations serialize, stop and destroy are idempotent, and managed
volumes survive normal lifecycle.

### BOX-VER-008 — Real-engine release gate

Native amd64 and arm64 smoke tests must prove:

- the exact image contract;
- non-root outer execution;
- functional nested rootless Podman;
- no host engine socket;
- the exact two outer publications;
- loopback Router health;
- direct invocation of `ploinky-local` inside the Box;
- persistent state after recreation.

## 12. Inputs for the new implementation plan

The new implementation plan must be organized around these deliverables:

1. preserve the existing direct launcher as `ploinky-local`;
2. add the thin `ploinky` delegate and explicit `ploinky box` lifecycle grammar;
3. create the isolated `ploinky-box/` module and test boundary;
4. implement deterministic identity, ownership, locks, and lifecycle;
5. implement the versioned image and rootless nested-runtime contract;
6. implement separate persistent workspace, nested-runtime, and dependency
   volumes;
7. implement the exact two-publication outer contract;
8. implement exact process and command forwarding;
9. prove that existing core behavior is unchanged;
10. implement optional outbound connector supervision only if it is included in
    the new plan's scope;
11. run unit, regression, real-engine, and multi-architecture release gates;
12. update the relevant DS and HTML documentation with the implementation.

The plan must not contain Ploinky core refactors or box-aware changes to core.
Any proposed exception must be identified as a separate prerequisite decision,
not hidden inside a Box implementation task.

## 13. Final invariant summary

Ploinky Box is a new external layer around an unchanged Ploinky core.
`ploinky-local` runs core directly. `ploinky` always runs `ploinky-local` inside
the managed Box. All Box implementation logic and tests live under
`ploinky-box/`; only thin command-name and package wiring lives outside it.

The physical-host boundary contains exactly two default outer publications:
one loopback-only HTTP Router mapping to in-box TCP `8080`, and one fixed
wildcard UDP mapping on `7882`. The private Router, inner agents, databases,
readiness services, and every other TCP listener remain unpublished.

The Box never modifies Ploinky routing or policy, exposes the host engine
socket, falls back to host-core execution, auto-remaps a required port, adopts
foreign resources, or destroys persistent volumes during normal lifecycle.
