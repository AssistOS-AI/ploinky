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

A cache is valid only when the runtime key, the relevant package hash, the stamp version, the installer metadata, and the core marker module all match the current workspace inputs. Cache preparation must use the correct installation backend for the target runtime family. Container-family runtime keys must install inside an install container for the target image, and the prepared stamp must record that image so a manifest image change refreshes the cache even when Node major, platform, libc, and package hashes are otherwise unchanged. Sandbox-family runtime keys must install on the host and must reject preparation for a foreign host runtime key.

The `deps prepare`, `deps status`, and `deps clean` commands form the operator-facing contract for cache maintenance. When no explicit target is provided to `deps prepare`, the command must prepare caches for every enabled agent that actually requires a Node dependency cache. Startup must also prepare or refresh missing and stale caches before runtime launch rather than letting agents run `npm install` inside their service runtime. Cache installs must avoid nonessential startup-time network work such as npm audit/funding checks, use noninteractive package-manager settings inside install containers, and keep long cold installs visibly alive with progress output. Operators should expect cold startup to require npm, git, network access, and native build tools when caches are absent.

Workspace startup must expand the static agent into a dependency graph using manifest enable directives. The graph must be grouped topologically into waves. A later wave must not start until the earlier wave has been started and all of its members have passed readiness checks.

Readiness must probe TCP or MCP according to the manifest-derived protocol. Manifests with only a `start` command default to TCP readiness. Other agent modes default to MCP readiness unless the manifest explicitly sets `readiness.protocol`. Cold-cache or invalid-cache scenarios may use an extended readiness timeout because installation and warm-up can materially delay the first healthy response.

Readiness probes target a host-side port, derived from the manifest's `ports` declarations. Agents using `network.mode: "host"` must still declare `ports` even though the runtime does not emit `-p` flags for them; the declarations are probe metadata only and let the runtime know which port to reach on `127.0.0.1`. A manifest with no `ports` and no AgentServer-style command falls back to a randomly allocated AgentServer mapping, which is unreachable for a server that binds a different port and will appear as an `ECONNREFUSED` readiness loop. Manifests for service agents that bind a known port must declare it.

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

### Question #3: Why does the runtime require explicit `ports` for host-network agents to probe readiness?

Response:
With bridge networking, the runtime uses the manifest's port mappings to learn which host port the agent listens on. With host networking it strips `-p` emission, so the only structured signal of the agent's port is the manifest declaration itself. Without it, the runtime cannot distinguish a service agent that binds `:7880` from a quiet AgentServer wrapper, and falls back to a random `127.0.0.1:<random>:7000` AgentServer mapping. Keeping `ports` declared for host-mode service agents preserves the readiness contract without re-introducing port publishing.

### Question #4: Why should dependency cache installs print progress?

Response:
Some agent dependencies pull large native runtime packages, and the package manager may legitimately spend minutes resolving, downloading, or unpacking them without producing useful npm output. Startup must make that state visible so operators can distinguish an active cold install from a stalled dependency process.

### Question #5: Why does the no-wait path still write durable log and status files?

Response:
The blocking wave path produces visible startup output: the wave list, the readiness summary, and any failure message. A no-wait dependency runs after the CLI has already moved on, so an operator who only watches stdout cannot tell whether the worker eventually came up or quietly crashed. Writing the launch into `.ploinky/logs/no-wait/<container>.log` and the lifecycle into `.ploinky/running/no-wait/<container>.json` gives the same level of inspectability without forcing the main start command to block. It also keeps `ploinky start` idempotent: re-running it after a no-wait failure overwrites the previous status with the new run instead of hiding the prior failure inside ephemeral console output.

### Question #6: Why does the cache stamp include installer image metadata?

Response:
Container runtime keys intentionally group compatible images by Node major, platform, architecture, and libc so cache directories stay understandable and reusable across patch updates. That grouping alone is not enough when a manifest moves to a different image that preinstalls different system libraries or native build prerequisites. Recording the installer image in the stamp lets startup invalidate the cache on an image switch without broadening the runtime-key format.

## Conclusion

Dependency preparation and readiness gating are operationally visible guarantees in Ploinky. The runtime must keep caches runtime-aware and must preserve dependency-wave startup ordering as part of the supported behavior.
