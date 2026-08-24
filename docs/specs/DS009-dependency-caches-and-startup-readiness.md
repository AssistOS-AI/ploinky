---
title: DS009-dependency-caches-and-startup-readiness
summary: Defines dependency cache construction, graph-ordered startup, readiness and liveness protocols, route activation, and bounded no-wait execution.
---

# DS009 Dependency Caches and Startup Readiness

## Introduction

Ploinky must prepare each agent's dependencies for the runtime that will execute them and must prove the complete dependency graph ready before it reports startup success. A running process, created container, open port, or written route candidate is not sufficient readiness evidence.

## Core Content

### Dependency actors and artifacts

| Actor or artifact | Responsibility |
| --- | --- |
| Manifest graph resolver | Loads the static agent and recursive dependency manifests, applies profile and alias rules, resolves repositories, rejects unresolved edges, and produces dependency order. |
| Runtime-key detector | Determines the effective runtime family, operating-system platform, architecture, Node major version, and runtime variant from the actual host or container image. A Node-less image receives the dedicated no-Node key and skips Node dependency installation. |
| Global cache | Stores the shared Ploinky and Achilles dependency baseline for one runtime key and global package hash. |
| Per-agent cache | Stores the merged global and agent `package.json` dependencies for one repository, agent, and runtime key. |
| Cache stamp | Records the stamp version, runtime key, package hash, installer runtime, image, platform, architecture, Node version, and variant needed to prove reuse is safe. |
| Moving-git marker | Records resolved commits for moving git dependencies so `ploinky update` can invalidate caches even when dependency spec strings remain unchanged. |
| Startup coordinator | Holds the workspace and network lifecycle locks, prepares inactive routing generations, runs hooks and providers, starts dependency waves, waits for readiness, and atomically activates admitted targets. |
| Health probe runner | Executes bounded readiness and liveness scripts inside the exact managed container and proves process-tree cleanup after timeouts or control-plane failures. |
| Watchdog | Rechecks recurring health after startup, inactivates a failed target, and restarts only the still-enabled exact runtime identity with bounded backoff. |

### Dependency cache flow

<figure class="diagram">
<pre class="mermaid">flowchart TD
    A[Resolve cache identity] --> B{Validated cache exists?}
    B -->|Yes| D[Mount cache into runtime]
    B -->|No| C[Lock, rebuild, validate, and publish cache]
    C --> D</pre>
<figcaption><em>Dependency cache flow</em></figcaption>
</figure>

The runtime key must distinguish host and container execution and include the effective platform, architecture, Node major version, and supported variant. The global cache key must include the resolved global dependency manifest. The agent cache key must include the merged global and agent dependency manifest. Installer metadata must bind the runtime used to perform installation and the selected image so a cache built by an incompatible environment cannot be mounted.

Cache preparation must use a bounded ownership lock and a temporary replacement path. A missing stamp, malformed stamp, changed package hash, changed runtime key, changed installer metadata, missing core marker, partial installation, or advanced tracked git commit makes the cache invalid. Box cache seeding must copy bytes safely across shared host mounts and must not rely on hard links.

### Coordinated startup flow

<figure class="diagram">
<pre class="mermaid">flowchart TD
    A[Prepare graph, caches, inactive state, hooks, and providers] --> B[Start blocking waves and verify readiness]
    B -->|Ready| C[Publish graph, spawn no-wait workers, and return]
    B -->|Failure| E[Keep targets inactive and clean exact candidates]
    C -. asynchronous .-> D[Verify no-wait readiness and activate ready routes]</pre>
<figcaption><em>Coordinated startup flow</em></figcaption>
</figure>

Ploinky must resolve and admit the complete recursive manifest graph before any graph runtime starts. The early generation must contain the final logical identities but no usable target. The static preinstall hook runs before startup config providers. After providers write accepted values, Ploinky must reload the registry, recompute runtime hashes, rotate stale retained tuples, abort the early lease, and capture the final inactive targetless generation used by launch.

Blocking nodes must start in topological waves. Nodes in one wave may start concurrently, but the next wave cannot start until every required node in the previous wave has passed readiness and its target has been applied through the coordinated route generation. A malformed graph, unresolved dependency, unsafe cycle, changed admission, failed hook, invalid provider output, expired lease, or readiness failure must stop startup and remove only the exact candidates created by that transaction.

### Readiness and liveness

| Check | Required behavior |
| --- | --- |
| `readiness.protocol: "mcp"` | Waits for the private port, completes MCP `initialize`, sends `notifications/initialized`, and verifies `tools/list`. This is the default for an explicit agent command or the implicit AgentServer. |
| `readiness.protocol: "tcp"` | Requires a successful TCP connection to the resolved private service port. It is the fallback for a start-only service without a readiness script. |
| `health.readiness.script` | Runs the named root-level script inside the exact container with interval, timeout, success threshold, failure threshold, and cleanup enforcement. A start-only service selects this protocol automatically when no explicit protocol is set. |
| `readiness.protocol: "none"` | Declares that the process has no serving readiness surface. Ploinky may mark it ready without a port probe, but this must be an explicit manifest decision. |
| `health.readiness.continuous: true` | Uses the readiness script for activation and recurring health observation. This is the default when a readiness script exists. |
| `health.readiness.continuous: false` | Uses the readiness script only for activation and requires a separate recurring `health.liveness.script`. |
| `health.liveness.script` | Repeats after activation to decide whether the exact runtime remains healthy. Exhausting its failure threshold inactivates the route and requests a managed restart. |
| Required external health | Runs after internal graph readiness for services declared outside the direct agent probe path. Startup is not complete until these checks pass. |

Readiness answers whether a newly started runtime may receive traffic. Liveness answers whether an already activated runtime should remain available. Probe scripts must live in the agent root, use a safe filename, return exit code `0` for success, obey their hard deadline, and leave no unproved child process behind. A readiness failure prevents route activation; a liveness failure removes the stale route before recovery.

The Watchdog may restart only an enabled agent whose registry tuple and runtime ownership still match and whose startup coordination has ended. Recovery must repeat semantic readiness before route activation. Repeated liveness failures use bounded exponential backoff; a manual stop, restart, refresh, or a stable runtime resets the backoff state.

### No-wait dependencies

A dependency marked `noWait` may continue in a detached worker only after the main transaction has resolved its identity, graph position, direct dependencies, and final preparation generation. Each worker must use a run-specific id, status file, log file, wave index, immutable registry binding, and bounded deadline. It may wait only for its declared direct dependency barriers and must never infer readiness from an unrelated worker.

A no-wait worker must publish a terminal ready, failed, or superseded state. It must not activate a raw route candidate, overlap a blocking generation mutation, adopt a changed runtime, hide readiness failure, or survive the disablement of its exact registry identity. The synchronous `start` command may return after every blocking graph node and additional synchronous agent is ready and each no-wait worker has been spawned or has published its spawn failure. No-wait launch, readiness, route activation, and terminal status continue asynchronously and remain observable through their run-scoped status and log records. A higher-level managed Box readiness gate may additionally require declared external health checks before it reports the complete Box ready.

### Cache and startup rationale

| Decision | Reason |
| --- | --- |
| Build dependencies in a bounded shared cache and mount prepared results read-only | Long-running agents do not need package-manager mutation rights, and identical runtime inputs can reuse verified work without installing packages on the host. |
| Acquire a cache lock, install into a temporary location, and promote atomically | Concurrent starts cannot observe or publish a partially installed dependency tree, and a failed installer leaves the previous complete cache entry intact. |
| Derive cache identity from the actual runtime inputs | Reuse is safe only when the package manager, lock data, platform, runtime, and other installation inputs match; repository names alone do not prove equivalence. |
| Admit the complete dependency graph before starting any node | Missing dependencies, unsafe cycles, invalid manifests, and provider failures are rejected before a partially usable graph can be exposed. |
| Start blocking dependencies in topological waves | Consumers become eligible only after their required producers are ready, while independent nodes can still start concurrently. |
| Treat readiness and liveness as separate contracts | Readiness decides when a route may first become active; liveness detects failure after activation and drives recovery without redefining initial admission. |
| Make `no-wait` explicitly asynchronous | Optional or slow work need not block the command, but it still receives run-scoped status, readiness checks, and route activation instead of being silently considered ready. |
