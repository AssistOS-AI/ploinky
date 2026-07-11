---
id: DS007
title: Dependency Caches and Startup Readiness
status: implemented
owner: ploinky-team
summary: Defines runtime-keyed dependency caches, manifest-aware startup preparation, and readiness gating across dependency waves.
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
| `ploinky start ...` | Reconcile/start outer runtime; preserve graph publishes and router readiness |
| `ploinky status` | Inspect outer contract/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm exact instance and directly remove its outer container; retain named volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

The host supervisor must complete authoritative publication planning and outer
reconciliation before invoking core startup. Every one-shot command that can
start an agent must preserve dependency-graph ordering, effective-profile
publishes, and core readiness behavior. Only after core start succeeds may the
host layer probe
`http://127.0.0.1:<selected-host-port>/status`; a failed core start must produce
no host router probe.

Publication planning is generic. It resolves the requested root, active
transitive dependency graph, aliases, profiles, branches, and any additional
enabled agents core will start from the named workspace rather than from a
product-specific host checkout. A running box plans through `exec`; a stopped
box remains stopped while a temporary container uses its inspected image ID.
For a missing box, the supervisor pulls and validates contract 2, creates the
labelled workspace volume, plans in a temporary container, and creates the
final box from the same image ID. Temporary containers and anonymous volumes
are removed on every planner exit path. A failed first plan may retain prepared
repositories and the named workspace volume for retry; deliberate cleanup is a
direct volume removal on the sole owning engine after accepting data loss.

The outer identity is derived from the exact canonical current directory as a
readable basename plus a 12-character path hash; there is no public name or
engine override. The supervisor requires every installed Podman/Docker engine
to answer and inventories the exact box plus all three exact identity-labelled
volumes before selecting the sole resource owner. Unknown probes, split
resources, and foreign exact-name volumes fail without mutation. With no
identity resources, answering Podman is preferred; a non-installed engine
cannot participate in inventory. The mutable
`docker.io/assistos/ploinky-box:runtime` channel is pulled only for create or
replacement, validated as contract 2, and pinned by image ID for execution.
Contract-1 state is never migrated or adopted.

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

Startup readiness follows an explicit precedence. A declared `readiness.protocol` of `mcp`, `tcp`, or `none` wins over every inferred choice, including a `health.readiness.script`. Without an explicit protocol, a start-only container with `health.readiness.script` uses blocking script readiness; a start-only service with a resolved private `additionalServerPort` uses TCP readiness; other start-only services default to TCP only when they have a reachable route. Execution modes that include AgentServer default to MCP. Dependency cache preparation happens before these checks, so readiness timeouts must describe service startup, not post-start dependency installation inside the agent home.

For blocking script readiness, Ploinky executes the declared plain-filename script inside the service container from `/code`, applying its interval, per-attempt timeout, success threshold, and failure threshold. A missing script, exhausted failure threshold, or execution error fails the dependency wave and blocks the caller. The same manifest `health.readiness` configuration may later be used by the watchdog as a warning-oriented health probe, but that later behavior does not weaken its blocking role during start-only container startup.

`openPorts` is publication metadata, not a generic readiness annotation. It exposes an agent socket into the managed outer runtime and makes that runtime-side socket eligible for host publication for any agent-starting command. The planner rejects zero box-side ports, invalid ranges, same-protocol claim conflicts, and incompatible profiles before outer or agent mutation. A start-only container with no `openPorts` does not receive a fabricated port-7000 AgentServer mapping: it must provide a blocking container script, a private `additionalServerPort` route, an intentional published TCP route, or explicit `readiness.protocol: "none"`. AgentServer execution modes may still receive the random localhost-to-7000 mapping when no port is declared. A host-network service that intentionally uses TCP readiness can name its reachable runtime-side port through `openPorts`, but doing so also accepts outer-boundary eligibility; a private host-network service should use a private readiness contract instead.

The outer box persists versioned, separate explicit/generated publication provenance. Replanning preserves ordered explicit values that were not restated and replaces stale generated values. Missing or malformed provenance is unsupported and must not be inferred from inspected port bindings. The supervisor passes the authoritative socket coverage to core. A one-shot host command can reconcile the box before startup; a REPL, Marketplace, monitor, or other already-in-box path proceeds only when existing coverage is sufficient and otherwise fails before profile, registry, hook, router, cache preparation, or agent-container mutation with a one-shot host instruction.

Inside a marked outer box, all Ploinky-managed agents and dependency-install containers use nested Podman. Persisted bwrap/Seatbelt enablement and Docker fallback are ineffective there. Every Ploinky-created nested agent, helper, and sidecar container carries `io.assistos.ploinky.managed=1`; outer boot removes running and stopped exact matches while retaining manual/unlabelled containers, nested images, and nested named volumes. Cleanup enumeration or removal failure fails the box self-check. Because the outer `-containers` volume survives destroy, recovery from corrupt nested state requires inspect/backup followed by explicit removal of that one named volume after the box is absent and data loss is accepted.

Some agents are workers rather than servers — they do not bind a port and have no readiness signal beyond "the process is running." Such agents must set `readiness.protocol: "none"`. The runtime treats them as immediately ready and does not probe a port; the dependency wave still tracks them so dependents wait for the container to start, but it does not require a port-open or MCP-handshake response. Use this only for true workers (renewal loops, batch jobs); serving agents must keep a real probe.

A manifest `enable[]` entry tagged with `no-wait` (see DS003) opts that dependency out of wave-by-wave gating. The runtime must still enable the dependency, register it in the workspace registry, and launch it, but it must do so without blocking on dependency-cache preparation, container creation, runtime startup, or readiness checks. A node is treated as no-wait when every path from the static agent to that node traverses at least one no-wait edge; a node with any blocking path remains in the blocking set and is gated normally. Static-agent startup must still wait on its full blocking dependency chain.

For each no-wait node, startup spawns a detached helper that calls the standard `ensureAgentService` path in the background and writes durable progress records:

- a log stream at `.ploinky/logs/no-wait/<container>.log`, capturing stdout and stderr of the worker
- a status JSON at `.ploinky/running/no-wait/<container>.json` with at minimum `state` (`starting`, `running`, or `failed`), `startedAt`, `finishedAt`, `pid`, the resolved container name, the host port when assigned, and any captured error message and stack

The main `ploinky start <staticAgent>` command must succeed even when a no-wait launch is still in progress or has failed. A no-wait failure must surface only through the durable log and status records, never as a non-zero exit from the main command. The helper is responsible for updating `routing.json` with its own route entry when its container exposes a host port, so the router can discover the background dependency once it is up without forcing the main start to wait. Runtime route writes from the foreground start path and no-wait helper must use a serialized merge so a background route cannot be overwritten by a later blocking dependency wave. Watchdog container monitoring must defer restart attempts while a no-wait status file is `starting` or `failed`; the helper owns startup until it records `running`, and a failed no-wait dependency should remain visible until the operator reruns startup. Blocking dependencies remain fail-closed as before.

## Decisions & Questions

### Question #1: Why are dependency caches keyed by runtime and merged package hash?

Response:
The same JavaScript dependency tree is not safe to reuse across incompatible runtimes or across different merged dependency sets. Keying caches by runtime plus merged package hash prevents silent reuse of an install prepared for a different ABI, platform, or dependency definition.

### Question #2: Why does startup wait wave by wave instead of starting all dependencies concurrently?

Response:
The graph contains explicit dependency edges, and tests on this branch validate that dependents wait until their prerequisites are ready. Wave-based gating preserves that contract and avoids exposing partially booted dependency chains that appear “started” but are not yet able to serve requests.

### Question #3: Why is `openPorts` not the default readiness signal for every private service?

Response:
An `openPorts` entry is an exposure decision: inside the managed outer runtime it names the agent socket eligible to cross the host boundary. Requiring it merely to make a database, identity provider, LLM runtime, or private health endpoint startable would accidentally turn readiness metadata into publication permission. Blocking `health.readiness.script` and private `additionalServerPort` routes let those start-only services prove readiness without broadening their boundary. A service should use `openPorts` for TCP readiness only when the same socket is intentionally eligible for publication.

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
Core `destroy` is a workspace operation: it removes workspace agent runtimes and regenerated dependency caches while preserving isolated agent data, the outer container, and its named volumes. Host `ploinky destroy` is an explicitly confirmed system-boundary operation that directly removes the selected outer container and its anonymous volumes while retaining all three named instance volumes. Deliberate named-volume deletion is a separate engine-level reset. Keeping those scopes separate prevents a core command from gaining control of, or accidentally removing, the runtime that contains it and prevents ordinary outer replacement from becoming data deletion.

## Conclusion

Dependency preparation and readiness gating are operationally visible guarantees in Ploinky. The runtime must keep caches runtime-aware and must preserve dependency-wave startup ordering as part of the supported behavior.
