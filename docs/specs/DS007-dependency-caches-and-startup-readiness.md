---
id: DS007
title: Dependency Caches and Startup Readiness
status: partially implemented (rootless private-router reachability blocked)
owner: ploinky-team
summary: Defines runtime-keyed dependency caches, publication-independent startup, private-target readiness, topology ordering, and coordinated generation apply across dependency waves.
---

# DS007 Dependency Caches and Startup Readiness

## Introduction

Ploinky no longer treats dependency installation as an incidental side effect of startup. Dependency caches and readiness gating are explicit parts of the runtime contract and of the test surface.

## Core Content

Global Node dependencies must be prepared from `globalDeps/package.json` into `.ploinky/deps/global/<runtime-key>/`. Per-agent Node dependencies must be prepared into `.ploinky/deps/agents/<repo>/<agent>/<runtime-key>/` using a merged package definition in which agent dependencies override the global baseline for conflicts.

The managed public-entrypoint boundary is:

| Invocation | Documented effect |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start outer runtime; open Ploinky REPL |
| `ploinky cli` | Reconcile/start outer runtime; open `/bin/bash` as `podman` in `/workspace` |
| `ploinky cli <agent>` | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| `ploinky start ...` | Reconcile/start outer runtime; start the graph behind the fixed boundary |
| `ploinky status` | Inspect outer contract/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm exact instance and directly remove its outer container; retain named volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

The host supervisor constructs contract 5 before invoking core startup and
without reading a workspace, graph, profile, manifest, readiness result, or
persisted publication state. Every one-shot command that can start an agent
preserves dependency-graph ordering and core readiness behavior, but it cannot
change the outer arguments. Only after core start succeeds may the host layer
probe the authenticated summary through
`http://127.0.0.1:<selected-host-port>/`; detailed readiness remains on the
supervisor Unix socket.

The outer identity is derived from the exact canonical current directory as a
readable basename plus a 12-character path hash; there is no public name or
engine override. The supervisor requires every installed Podman/Docker engine
to answer and inventories the exact box plus all three exact identity-labelled
volumes before selecting the sole resource owner. Unknown probes, split
resources, and foreign exact-name volumes fail without mutation. With no
identity resources, answering Podman is preferred; a non-installed engine
cannot participate in inventory. The mutable
`docker.io/assistos/ploinky-box:runtime` channel is pulled only for create,
validated as contract 5, and pinned by image ID for execution. Every
non-contract-5 box, including contract 4, fails before pulling, volume creation,
restart, upgrade, or replacement. It is never read as compatible state,
migrated, relabelled, adopted, cleaned, or automatically replaced. The operator
must run `ploinky destroy` explicitly before recreation; the workspace,
nested-container-storage, and dependency named volumes remain retained.
Creation-configuration drift in a contract-5 box follows the same explicit
boundary: reconciliation reports the exact drift and performs no pull, stop,
rename, removal, replacement, or rollback. Only an exactly compatible stopped
box may be started in place.

A cache is valid only when the runtime key, the relevant package hash, the stamp version, the installer metadata, and the core marker module all match the current workspace inputs. Cache preparation must use the correct installation backend for the target runtime family. Container-family runtime keys must install inside an install container for the target image, and the prepared stamp must record that image so a manifest image change refreshes the cache even when Node major, platform, libc, and package hashes are otherwise unchanged. Sandbox-family runtime keys must install on the host and must reject preparation for a foreign host runtime key.

The `deps prepare`, `deps status`, and `deps clean` commands form the operator-facing contract for cache maintenance. When no explicit target is provided to `deps prepare`, the command must prepare caches for every enabled agent that actually requires a Node dependency cache. Startup must also prepare or refresh missing and stale caches before runtime launch rather than letting agents run `npm install` inside their service runtime. Cache installs must avoid nonessential startup-time network work such as npm audit/funding checks, use noninteractive package-manager settings inside install containers, and keep long cold installs visibly alive with progress output. Operators should expect cold startup to require npm, git, network access, and native build tools when caches are absent.

Dependency caches are regenerated state, not agent data. A core `destroy`
entered in the REPL must clear `.ploinky/deps/` so the next core startup rebuilds
missing caches, while `.data/<agent-or-alias>/` and the containing outer runtime
remain untouched. Host `ploinky stop` preserves the outer dependency volume;
confirmed host `ploinky destroy` directly removes only the selected outer
container and its attached anonymous volumes. The dependency, workspace, and
nested-container-storage named volumes remain labelled and available to the
next permitted recreation. Removing them for a full reset is a separate,
explicit engine-level data-cleanup action.

Workspace startup must expand the static agent into a dependency graph using manifest enable directives. The graph must be grouped topologically into waves. A later wave must not start until the earlier wave has been started and all of its members have passed readiness checks.

After dependency waves, startup processes enabled agents outside the graph according to the manifest `startup` policy defined in DS003. `automatic` agents and manifests without the field start as before. Stopped `manual` agents remain stopped and lose stale routes; already running `manual` agents are retained. Graph membership takes precedence, so a static agent or explicit dependency marked `manual` still starts and participates in normal readiness gating.

Startup readiness follows an explicit precedence. A declared `readiness.protocol`
of `mcp`, `tcp`, or `none` wins over every inferred choice, including a
`health.readiness.script`. Without an explicit protocol, a start-only container
with `health.readiness.script` uses blocking script readiness; a start-only
service with a resolved `httpServices[].port` target may use TCP readiness;
other start-only services default to TCP only when they have a reachable private
target. Execution modes that include AgentServer default to MCP. Dependency
cache preparation happens before these checks, so readiness timeouts must
describe service startup, not post-start dependency installation inside the
agent home.

For blocking script readiness, Ploinky executes the declared plain-filename script inside the service container from `/code`, applying its interval, per-attempt timeout, success threshold, and failure threshold. A missing script, exhausted failure threshold, or execution error fails the dependency wave and blocks the caller. The watchdog then reruns the same semantic health contract at a bounded recurring interval; a prior success is not permanent. A later failure inactivates routing before scheduling a fresh exact-identity replacement, and failed replacement readiness cannot reactivate the selector. LiveKit's recurring script must continue to prove ownership of the reserved UDP socket, not merely process liveness.

`openPorts` is private inner-runtime metadata, not a generic readiness annotation
and never physical-host publication permission. A start-only container with no
`openPorts` does not receive a fabricated port-7000 AgentServer mapping: it must
provide a blocking script, a private HTTP-service target, another explicit
private TCP target, or `readiness.protocol: "none"`. AgentServer execution modes
may still receive an engine-assigned private mapping to port 7000. The launcher
rejects reserved Router TCP `8080`/`8081` and LiveKit UDP `7882` overlaps before
mutation.

The outer box has no publication provenance or graph coverage contract. Its
sole `-p` emission always creates loopback Router TCP and wildcard UDP `7882`,
independent of startup state. Private readiness can advance only the topology
publication generation; it cannot change the route-and-policy authorization
generation, change stable configuration, create a host mapping, or restart
unrelated consumers.

Inside a marked outer box, all Ploinky-managed agents and dependency-install containers use nested Podman. Persisted bwrap/Seatbelt enablement and Docker fallback are ineffective there. Every Ploinky-created nested agent, helper, and sidecar container carries `io.assistos.ploinky.managed=1`; contract-v5 boot rejects retained exact matches without deleting or importing them. The old box must be made quiescent and its managed containers removed before explicit destroy/recreate. Enumeration failure fails the box self-check. Because the outer `-containers` volume survives destroy, unrecoverable state requires inspect/backup followed by explicit removal of that one named volume after the box is absent and data loss is accepted; v5 performs no cleanup path.

Contract-5 managed-network startup additionally requires rootless Podman 5.4
or newer, Netavark, and operational `pasta`. Router public/control `8080` starts
before consumers, private `8081` is intended to be reachable only from allowed
managed interfaces, and detailed health uses the unmounted supervisor Unix
socket. Managed `default` and `bridge` agents receive the private endpoint only
through the exact `host.containers.internal:host-gateway` mapping;
capability-approved host agents use box loopback, and `none` agents receive no
Router endpoint. On the currently observed rootless Podman topology that
host-gateway terminates on the box outer-facing interface, so the bridge lane is
blocked and remains fail-closed pending DS004 Question #8. Startup must not
widen the listener or install a compatibility forwarder.

After recursive repository preparation, Ploinky resolves a provider planning
graph and stages an early inactive generation before static preinstall and
startup config providers run. That generation assigns exact tuples to missing
or changed nodes and strips resolved targets from every retained graph route.
After providers finish, Ploinky reloads the registry, aborts the early lease,
re-evaluates retained predecessor hashes, rotates newly stale tuples, and
captures the final inactive targetless generation. Only then does it start the
topological waves. Runtime backends must preserve the staged identity, and only
the final preparation lease may authorize targets. Each blocking wave records its resolved private targets through a
coordinated apply before readiness can authorize dependents; detached no-wait
workers use the same prepared identity and the same apply path when their target
exists. Additional already-enabled agents outside the graph start after all
blocking waves. No-wait helpers are spawned only after those additional starts,
so an independent background apply cannot transiently inactivate an exact
host-generation capability while a blocking runtime is being created.

Some agents are workers rather than servers — they do not bind a port and have no readiness signal beyond "the process is running." Such agents must set `readiness.protocol: "none"`. The runtime treats them as immediately ready and does not probe a port; the dependency wave still tracks them so dependents wait for the container to start, but it does not require a port-open or MCP-handshake response. Use this only for true workers (renewal loops, batch jobs); serving agents must keep a real probe.

A manifest `enable[]` entry tagged with `no-wait` (see DS003) opts that dependency out of wave-by-wave gating. The runtime still enables and registers it during the common prelaunch phase, but defers its detached launch until the complete blocking graph and any additional already-enabled agents have started. Once the helper is spawned, the main command does not block on that node's dependency-cache preparation, container creation, runtime startup, or readiness checks. A node is treated as no-wait when every path from the static agent to that node traverses at least one no-wait edge; a node with any blocking path remains in the blocking set and is gated normally. Static-agent startup must still wait on its full blocking dependency chain.

For each no-wait node, startup spawns a detached helper that calls the standard `ensureAgentService` path in the background and writes durable progress records:

- a log stream at `.ploinky/logs/no-wait/<container>.log`, capturing stdout and stderr of the worker
- a status JSON at `.ploinky/running/no-wait/<container>.json` with at minimum `state` (`starting`, `running`, or `failed`), `startedAt`, `finishedAt`, `pid`, the resolved container name, the host port when assigned, and any captured error message and stack

The main `ploinky start <staticAgent>` command must succeed even when a no-wait
launch is still in progress or has failed. A no-wait failure surfaces through
durable log and status records, never as a non-zero exit from the main command.
When its targets become ready, the helper submits them to the same coordinated
exact-byte generation apply as the foreground path; writing candidate
`routing.json` alone cannot activate the selector. Watchdog monitoring defers
restart attempts while a no-wait status is `starting` or `failed`. A failed
candidate remains inactive until an operator reruns startup. Blocking
dependencies remain fail-closed.

## Decisions & Questions

### Question #1: Why are dependency caches keyed by runtime and merged package hash?

Response:
The same JavaScript dependency tree is not safe to reuse across incompatible runtimes or across different merged dependency sets. Keying caches by runtime plus merged package hash prevents silent reuse of an install prepared for a different ABI, platform, or dependency definition.

### Question #2: Why does startup wait wave by wave instead of starting all dependencies concurrently?

Response:
The graph contains explicit dependency edges, and tests on this branch validate that dependents wait until their prerequisites are ready. Wave-based gating preserves that contract and avoids exposing partially booted dependency chains that appear “started” but are not yet able to serve requests.

### Question #3: Why is `openPorts` not the default readiness signal for every private service?

Response:
An `openPorts` entry is an inner-runtime exposure decision. It is never eligible
to cross the physical-host boundary, so making it the default readiness signal
would still create unnecessary box-level sockets for databases, identity
providers, or health endpoints. Blocking scripts and private
`httpServices[].port` targets let start-only services prove semantic readiness
without broadening their in-box reachability.

### Question #4: Why should dependency cache installs print progress?

Response:
Some agent dependencies pull large native runtime packages, and the package manager may legitimately spend minutes resolving, downloading, or unpacking them without producing useful npm output. Startup must make that state visible so operators can distinguish an active cold install from a stalled dependency process.

### Question #5: Why does the no-wait path still write durable log and status files?

Response:
The blocking wave path produces visible startup output: the wave list, the readiness summary, and any failure message. A no-wait dependency runs after the CLI has already moved on, so an operator who only watches stdout cannot tell whether the worker eventually came up or quietly crashed. Writing the launch into `.ploinky/logs/no-wait/<container>.log` and the lifecycle into `.ploinky/running/no-wait/<container>.json` gives the same level of inspectability without forcing the main start command to block. It also keeps `ploinky start` idempotent: re-running it after a no-wait failure overwrites the previous status with the new run instead of hiding the prior failure inside ephemeral console output.

### Question #6: Why does the cache stamp include installer image metadata?

Response:
Container runtime keys intentionally group compatible images by Node major, platform, architecture, and libc so cache directories stay understandable and reusable across patch updates. That grouping alone is not enough when a manifest moves to a different image that preinstalls different system libraries or native build prerequisites. Recording the installer image in the stamp lets startup invalidate the cache on an image switch without broadening the runtime-key format.

### Question #7: Why are core cache destruction and outer-runtime destruction separate?

Response:
Core `destroy` is a workspace operation: it removes workspace agent runtimes and regenerated dependency caches while preserving isolated agent data, the outer container, and its named volumes. Host `ploinky destroy` is an explicitly confirmed system-boundary operation that directly removes the selected outer container and its anonymous volumes while retaining all three named instance volumes. Deliberate named-volume deletion is a separate engine-level reset. Keeping those scopes separate prevents a core command from gaining control of, or accidentally removing, the runtime that contains it and prevents the explicit outer destroy/recreate boundary from becoming implicit data deletion.

### Question #8: Why does dependency startup stage every graph identity before launching the first wave?

Response:
Private assertions and host-mode grants are current-generation capabilities, so
there can be no bootstrap interval in which a process runs under an identity
that the selected generation has not validated. The early batch makes hooks see
one complete targetless graph; after provider output, its lease is aborted and
retained predecessors are re-evaluated before one final targetless generation
and launch lease are captured. No runtime starts between those stages. Target
addresses remain absent until their runtimes exist and are added later by the
normal coordinated route apply; that sequencing does not weaken the final exact
identity contract.

### Question #9: Why does the watchdog repeat semantic readiness after startup?

Response:
Process liveness does not prove continued socket ownership or service semantics.
In particular, another process or a degraded composite media runtime can leave
the container running after the expected UDP owner disappears. A bounded
recurring probe turns that drift into an authorization failure and exact
replacement instead of treating one historical success as permanent evidence.

### Question #10: Why does dependency graph membership override manual startup?

Response:
An `enable` edge is an explicit statement that the parent requires the child for correct operation. Treating `startup: manual` as stronger than that edge would let a manifest silently break its dependents. Manual policy therefore applies only to enabled agents outside the resolved graph.

## Conclusion

Dependency preparation and readiness gating are operationally visible guarantees in Ploinky. The runtime must keep caches runtime-aware and must preserve dependency-wave startup ordering as part of the supported behavior.
