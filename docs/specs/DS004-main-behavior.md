---
title: DS004-main-behavior
summary: Defines how Ploinky finds a workspace, starts and operates agents, mounts files, prepares dependencies, applies profiles, updates repositories, and exposes Router-owned interfaces and browser libraries.
---

# DS004 Main Behavior

## Introduction

Ploinky must let an operator run repository-described agents from a workspace without managing container addresses, dependency installations, or route wiring by hand. The public `ploinky` command must bind one managed outer Box to the selected host workspace, and the in-Box `ploinky-local` runtime must prepare the declared agent graph, start its processes, and expose the commands and Router paths used by operators, browsers, and agent integrations. The following components define the concrete outcomes that those actors depend on.

## Core Content

### Main Behavior Components

| Name | Explanation |
| --- | --- |
| Workspace initialization and CLI execution | Ploinky finds one workspace, starts its declared agent graph, records the launch folder, and sends agent CLI and SSO input to the selected agent. |
| Container mounts | Ploinky gives the Box and each agent runtime the exact source, workspace, code, dependencies, shared storage, skills, topology, and declared data mounts they are allowed to use. |
| Dependency installation | Ploinky prepares runtime-specific dependency caches before an agent starts and exposes the resulting modules read-only to container and host-sandbox agents. |
| Agent dependency overrides | An agent may replace a global dependency specification in its own prepared cache without modifying either the global package file or the agent's source package file. |
| Agent lifecycle commands | Start, restart, reinstall, stop, shutdown, and destroy produce distinct, bounded effects on the Box, Router, agent runtimes, caches, and durable workspace data. |
| Manifest profiles | The selected profile controls environment values, hooks, secrets, mount access, ports, networking, startup configuration providers, and runtime selection for each agent. |
| Workspace update | `ploinky update` refreshes the host checkout, runtime AgentLib, managed repositories, project repositories, and installed skills, and invalidates prepared caches when moving Git dependencies advance. |
| Built-in Router routes | The Router owns health, authentication, administration, MCP, agent discovery, browser application, upload, storage, and workspace-file routes and admits them through the active route-and-policy generation. |
| Built-in browser libraries | Browsers and agent applications may load WebSkel, the MCP browser client, and QR support from stable Router-owned URLs. |

### Workspace initialization and CLI execution

The operator initiates this behavior by running the public `ploinky` command from a workspace folder or one of its descendants. Ploinky must use an existing directory named by `PLOINKY_WORKSPACE_ROOT` when supplied; otherwise it must walk upward from the launch directory to the first parent containing `.ploinky`, falling back to the launch directory when no marker exists. Workspace resolution must not create `.ploinky`; environment initialization performs that mutation later. The host entrypoint must derive one immutable workspace identity from the canonical root and must refuse foreign, split, or incompatible Box state before mutation.

`ploinky start <staticAgent> [port]` must prepare required repositories, resolve the static agent and its recursive manifest dependencies, admit the complete runtime graph, and start blocking dependency waves in topological order. The first core start must identify a static agent and persist its Router configuration; later starts may reuse that configuration. Startup must publish no agent target until the inactive generation, profile inputs, host hooks, startup configuration providers, runtime identities, and required readiness checks have been completed. A declared no-wait dependency may finish asynchronously only through its bounded run-specific status path.

`ploinky cli <agentName> <params>` must resolve the enabled record or enable the named agent globally when needed, ensure that its runtime is ready, and execute the manifest's `cli` command. Arguments beginning with `--sso-` must not be appended to the agent command. Ploinky must convert `--sso-name=value` to an `SSO_NAME=value` environment assignment and must pass all remaining arguments to the manifest command. `ploinky cli` without an agent must open the managed Box shell at the host-selected absolute workspace root.

| Variable | Required value |
| --- | --- |
| `PLOINKY_WORKSPACE_ROOT` | The selected workspace root: the valid explicit directory, the first parent containing `.ploinky`, or the launch directory when neither source selects another root. |
| `PLOINKY_CWD` | The resolved directory from which the core command was launched; it may differ from the workspace root when the operator starts inside a descendant folder. |

The observable result must be one ready workspace whose agent commands and Router surfaces refer to the same registry and active generation. The host `ploinky` process must remain the sole owner of outer Box lifecycle, while `ploinky-local` must own only the Router and nested agent graph. Workspace identity, repository ownership, and branch selection are specified in [DS003-workspace-and-repository-model](specsLoader.html?spec=DS003-workspace-and-repository-model.md), and graph readiness is specified in [DS009-dependency-caches-and-startup-readiness](specsLoader.html?spec=DS009-dependency-caches-and-startup-readiness.md).

### Container mounts

The operator receives a workspace whose host files remain visible to the Box and to admitted agent runtimes. Ploinky must create the outer Box with the Ploinky checkout mounted read-only at `/opt/ploinky`, the selected workspace mounted read-write at its original host absolute path, the workspace dependency cache mounted at `/opt/ploinky/node_modules`, and the nested image cache mounted at `/home/podman/.local/share/ploinky-images`. The Box must use a fresh `/tmp` tmpfs and must not create or depend on outer named volumes.

Before starting a Docker or Podman agent, Ploinky must build the complete mount set from the agent registry mode, active profile, prepared dependency cache, manifest, and runtime resources. The exact runtime may stage source trees to satisfy nested Podman semantics, but the paths visible to the agent must retain the following contract.

| Runtime path | Source and access contract |
| --- | --- |
| `/Agent` | Ploinky's shared `Agent/` library, read-only. |
| `/code` | The selected agent code, read-write for the `default` and `dev` profile defaults and read-only for other profile defaults unless an explicit valid mount mode overrides that default. |
| `/code/node_modules` and `/Agent/node_modules` | The same prepared agent dependency cache, exposed read-only as direct mounts or staged symlink targets. |
| `/shared` | `.ploinky/shared`, read-write. |
| `/root` | The persistent per-agent home for global and development modes; isolated mode uses the per-agent data folder as its working directory and persistent home contract. |
| `/code/skills` | The agent skills tree when it exists outside the mounted code tree, with the active profile's skills access mode. |
| `/run/ploinky-edge-topology` | The Box-owned topology projection, read-only and prepared before the consumer starts. |
| Manifest volume target | A host path resolved from the workspace root or accepted as an absolute source, subject to the managed Box capability policy and any declared generated, required, read-only, or permission options. |
| Declared persistent-storage target | A directory rooted under `.ploinky/data/<key>` and mounted at the manifest's `runtime.resources.persistentStorage.containerPath`. |
| `/models`, `/runtime`, and `/Agent/llm-runtime` | Identity-specific model storage, runtime state, and shared LLM runtime code when the manifest enables a supported LLM runtime. |

Manifest relative volume sources must resolve from `PLOINKY_WORKSPACE_ROOT`. Inside the managed Box, Ploinky must reject a manifest volume source outside the managed workspace. A manifest must not replace reserved dependency targets such as `/code/node_modules`, and agent or profile input must not weaken the read-only Agent library, topology, or dependency-cache boundaries. Detailed runtime and isolation requirements are specified in [DS006-runtime-execution-and-isolation](specsLoader.html?spec=DS006-runtime-execution-and-isolation.md).

### Dependency installation

Agent authors may declare Node dependencies without arranging an installation inside the long-running agent process. Ploinky must take its global dependency set from `globalDeps/package.json`, whose required packages are `achillesAgentLib` and `mcp-sdk`, and must combine that set with the agent package when one exists. Ploinky must fail when the global package file is missing instead of substituting a hardcoded dependency list.

Ploinky must prepare a dependency cache before runtime launch when the agent needs core dependencies. Docker and Podman targets must run `npm install` through a short-lived installer container that matches the target runtime image and runtime key. Bubblewrap and Seatbelt targets must prepare their host-runtime cache outside the confined agent process. Long-running agent runtimes must consume the resulting `node_modules` read-only and must not perform dependency installation into the source tree.

| Cache level | Path and purpose |
| --- | --- |
| Global | `.ploinky/deps/global/<runtime-key>` stores the global dependency set for one runtime family, platform, architecture, Node major, and applicable libc variant. |
| Per agent | `.ploinky/deps/agents/<repo>/<agent>/<runtime-key>` stores the merged global and agent dependency set and the validity stamp used by that agent. |

Ploinky must reuse a cache only when its runtime key, merged-package hash, moving-dependency evidence, and installer metadata remain valid. A missing, stale, or incompatible cache must be prepared before the agent is reported ready. Cache preparation and readiness sequencing are specified in [DS009-dependency-caches-and-startup-readiness](specsLoader.html?spec=DS009-dependency-caches-and-startup-readiness.md).

### Agent dependency overrides

An agent author initiates this behavior by declaring a dependency or development dependency whose name also appears in the global package. Ploinky must create a new merged package object in which the agent's `dependencies`, `devDependencies`, `scripts`, and `name` take precedence where supplied. It must write that merged package only into the per-agent cache and run the applicable installer there.

Ploinky must not modify `globalDeps/package.json` or the agent's source `package.json` while applying an override. An operator may set `PLOINKY_AGENTLIB_REF`, or use the supported start branch policy that derives it, to replace only the deployed `achillesAgentLib` source for that run. The selected value must participate in cache identity so a cache prepared from another AgentLib source cannot be reused as if it matched.

The observable result is that one agent may use a required package version or AgentLib branch without changing another agent's source contract. Branch fallback and exact deployed-revision requirements must continue to obey [DS003-workspace-and-repository-model](specsLoader.html?spec=DS003-workspace-and-repository-model.md).

### Agent lifecycle commands

Operators must be able to control the outer Box and the in-Box workspace without conflating their ownership boundaries. The public wrapper owns the Box; the core REPL owns the Router and registered agent runtimes. Every destructive or replacement action must act only on resources whose exact workspace ownership and immutable runtime identity have been proven.

| Action | Required result |
| --- | --- |
| Public `ploinky start ...` | Reconcile or create the validated rootless Box, then start the Router and complete manifest graph behind the fixed Box boundary. |
| Core `start` | Prepare repositories, profile inputs, dependencies, identities, inactive routing state, dependency waves, readiness, and final coordinated route publication. |
| `restart <agent>` | Stop and recreate the selected sandbox runtime or perform the admitted managed-container restart path, which drains a routed container under the targeted drain acknowledgement contract below, then require readiness and coordinated route activation before success. |
| `restart <agent> --accept-failed-drain <container-id>` | Replace the exact stopped predecessor whose targeted drain was refused, accepting the loss of data it did not persist, and reopen its route only after the successor is ready. |
| `restart router` | Inactivate routing, replace only the Router process, and rebuild the configured workspace routing state without treating agent containers as newly created runtimes. |
| Workspace `restart` | Stop the Router and configured agents, then execute the complete configured startup path again. |
| `reinstall <agent>` | Remove the exact selected runtime and recreate it with `forceRecreate`, while reusing a dependency cache only when it remains valid. A route left draining by a refused targeted drain refuses the reinstall before any rebuild request or removal. |
| Core `stop` | Stop the Router and configured agents without removing their owned runtimes or durable workspace data. |
| Core `shutdown` | Stop the Router and remove exact workspace agent containers while retaining registry, caches, and per-agent data. |
| Core `destroy` or `clean` | Stop the Router, remove exact workspace agent runtimes, clear `.ploinky/deps`, and preserve `.data`. |
| Public `ploinky stop` | Stop core services and then stop the outer Box while preserving workspace data and Box caches. |
| Public `ploinky destroy` | Remove the exact owned outer Box, then this workspace's host GPU-grant and hardware-limits records (`~/.ploinky-box/gpu-grants/<instance>{.json,/}` and `~/.ploinky-box/hardware-limits/<instance>{.json,/}`), and preserve the workspace, the `.ploinky/box` caches and the saved Router binding. A refused record removal keeps the records, exits 1 with a message that names the fix (supervisor error code `PLOINKY_BOX_DESTROY_RECORDS_KEPT`), and is finished by running destroy again. |
| Public `ploinky destroy --delete-cache` | Remove the exact owned outer Box and those records, and then delete only `.ploinky/box/dependencies` and `.ploinky/box/images`; the cache of a gone Box is deleted even when the records are kept. |

The outer Box must publish exactly one Router TCP mapping to in-Box `8080/tcp` and one wildcard media UDP mapping to in-Box `7882/udp`. Router TCP must remain loopback-only unless the operator explicitly selects an admitted IPv4 host binding through `ploinky bind`; unknown Host headers must remain rejected. A lifecycle action must not expose an agent listener, the private Router listener, or a third publication. A failed transactional Box replacement must restore the prior validated Box or report failure without adopting ambiguous state.

### Targeted drain acknowledgement

A targeted drain replaces one running managed container (Docker or Podman) while the rest of the graph keeps serving. `restart <agent>` uses it when the agent has a published route without a hardware-unavailability mark; hardware Apply and the GPU/MPS cohort drain their clients through the same primitive. Bubblewrap and Seatbelt runtimes have no targeted drain. The drain withdraws the route by marking `routes.<key>.draining: true` in `.ploinky/routing.json` through a coordinated routing apply, so the Router refuses new traffic (`404 AGENT_OWNER_INACTIVE` on the agent selector, `503 HOST_SELECTOR_INACTIVE` on a bound host) while the predecessor keeps its exact registered `instanceId` and `enableGeneration`. Ploinky then proves the affected selectors (`agent-root:<key>`, `agent-port:<key>` and every `host:<name>` bound to the route) inactive, retires the predecessor's relay control socket and sends SIGTERM once.

The application acknowledges that its own drain and persistence completed by exiting with status 0 within 35 seconds. The bound is fixed and callers cannot extend it. Ploinky never sends SIGKILL during a drain.

| Predecessor outcome | Result |
| --- | --- |
| Exit status 0 after SIGTERM, or already stopped with status 0 | Acknowledged. The predecessor is removed without force (the managed-network transaction keeps it stopped for diagnostics), the successor starts under the same instance identity, readiness passes, the registry records the successor's container ID and the route is republished without `draining`. |
| Any other exit status (including 143, the default SIGTERM termination), an OOM kill or a runtime error, while draining or already stopped | Refused with `TARGETED_DRAIN_FAILED`. Signal termination is never an acknowledgement. |
| Still running after 35 seconds | Refused with `TARGETED_DRAIN_TIMEOUT`. The container keeps running and is not signalled again. |
| Absent | Nothing is left to drain or acknowledge, so the restart proceeds. Callers that remove runtimes must therefore refuse a draining route first. |

A refusal fails the restart and changes nothing further: the route stays `draining`, the registry record keeps the predecessor's identity and container ID, and the refused container stays where it is (stopped, or running after a timeout). Every other admission of that runtime is refused with `PLOINKY_AGENT_DRAINING` until a targeted restart publishes a successor. The container monitor's recreates fail this way, retry with backoff and then trip its circuit breaker. Agent and workspace `start` and workspace `restart` are refused when they reach that agent. `reinstall` is refused before it issues a rebuild request or removes anything. A workspace start never rotates or removes that runtime, because removing the predecessor would let a later restart replace it without any acknowledgement. When the agent is a no-wait dependency or its hardware admission is refused, the start keeps the predecessor under its exact identity, logs one line naming the recovery command and starts the rest of the graph: the agent's no-wait worker fails at the admission gate, and a hardware-refused agent is not launched and its draining route is also marked hardware-unavailable. When the start would replace any other agent in this state, or the draining agent has a superseded no-wait run or a GPU/MPS cohort transition, the whole graph is refused before anything is logged, revoked, rotated or removed. Repeating `restart <agent>` evaluates the same stopped container and refuses again.

The operator recovers with `ploinky restart <agent> --accept-failed-drain <container-id>`, naming the full 64-hex `containerId` of the agent's record in `.ploinky/agents.json`. The command never signals anything. Every precondition below must hold, or the restart is refused without replacing the predecessor:

| Precondition | Checked by |
| --- | --- |
| The agent runs as a managed container with a route; GPU/MPS clients are excluded | `restart` argument handling and the exact-instance reconcile |
| The container is not running when the command starts | `restart`, before any routing change |
| The route is already `draining` and the ID equals the registered predecessor's `containerId` | The targeted-restart preparation, atomically inside its routing mutation |
| The affected selectors are proved inactive | The drain primitive |
| A predecessor that still exists is stopped and its inspected immutable ID equals the accepted ID | The drain primitive (a running or different container is refused with `TARGETED_DRAIN_ACCEPTANCE_REFUSED`; an absent one has nothing left to accept) |

When the preconditions hold, the recorded refusal is accepted: the stopped predecessor is replaced exactly as after an acknowledgement, the successor keeps the instance identity, and the route reopens only after readiness. Whatever the predecessor had not persisted before it exited may be lost; the command logs one line naming the predecessor's short ID and exit status. Publishing the successor changes the registry record, which resets the container monitor's restart state and circuit breaker. Only the CLI restart of one agent can accept a refusal; hardware Apply never carries an acceptance. A draining route that a start also marked hardware-unavailable takes the same accepted restart once the agent's hardware admission succeeds, and its commit clears both marks. While the hardware admission is still refused, every restart of that agent fails with the hardware outcome, and that refusal retires the predecessor as it does for any hardware-refused instance; the accepted restart later finds no predecessor and proceeds.

The acceptance never stops a predecessor that is still running after a timeout; it applies once the container has exited. Core `stop` and workspace `restart` stop every configured agent container, including a timed-out predecessor, with SIGTERM and then SIGKILL after 5 seconds; the workspace restart then refuses its graph while the route is draining, and `--accept-failed-drain` applies to the stopped container. Core `shutdown`, `destroy` and `clean` remove workspace containers explicitly, including a refused predecessor, which leaves an absent predecessor that the next targeted restart replaces without an acknowledgement.

### Manifest profiles

An operator selects a profile through the supported start or profile command, and Ploinky persists the active name in `.ploinky/profile`. `default` must always be valid; other valid names must come from installed agent manifests. When a requested profile is absent from a manifest, runtime admission must apply the manifest's supported fallback rules without inventing profile fields.

| Field | Composition rule |
| --- | --- |
| `env` | Merge default and active values by variable name, with the active value taking precedence. |
| Lifecycle hooks | Keep the default hook unless the active profile supplies the same hook, in which case the active hook replaces it. |
| `secrets` | Concatenate default secrets followed by active-profile secrets. |
| `mounts` | Merge mount settings by key, with active-profile values replacing matching defaults. |
| `volumes` and `volumeOptions` | Merge manifest and active-profile entries by key, with the profile entry taking precedence. |
| `openPorts` | Replace the default profile's complete value when the active profile declares it. |
| `network` | Replace the default network selection as one unit when the active profile declares it. |
| `startupConfigProviders` | Replace the default provider list when the active profile declares one. |
| Runtime selection | Use the admitted manifest/profile runtime fields as one validated selection; a profile must not bypass Box runtime capability policy. |

The default access for `/code` and `/code/skills` must be read-write in `default` and `dev` and read-only in other profiles. Explicit `mounts.code` and `mounts.skills` values may replace those defaults only with `ro` or `rw`. Profile secrets and generated identity values must remain subject to [DS010-secrets-and-variable-resolution](specsLoader.html?spec=DS010-secrets-and-variable-resolution.md), and startup configuration providers must obey [DS017-startup-config-providers](specsLoader.html?spec=DS017-startup-config-providers.md).

### Workspace update

The operator initiates the complete refresh with `ploinky update`, `ploinky update all`, or an explicit project folder. Ploinky must update the host checkout when it is writable and non-interactive. An interactive session with a pending self-update must defer that self-update and tell the operator to rerun it from a shell. Inside the managed Box, the read-only Ploinky source must not be mutated; writable runtime dependencies, managed repositories, project repositories, and skills must still be processed.

Ploinky must refresh the runtime `node_modules/achillesAgentLib`, update repositories registered under `.ploinky/repos`, refresh AgentLib packages found in managed repositories, and update reachable Git repositories discovered beneath the selected project root. An unreachable discovered project remote may be reported and skipped, while failures in managed Ploinky repositories must fail the update result.

For each discovered `ploinky-skills-manifest.json`, Ploinky must require an array of repository objects with explicit selected skills, update or install each source repository, rebuild the target `.agents/skills` directory from those selections, and maintain the `.claude` compatibility link and managed ignore block. When multiple manifest entries select the same skill name, the later selected source must win. Hidden directories, `.git`, `node_modules`, `globalDeps`, and `.ploinky` must not be traversed during manifest discovery.

Ploinky must resolve the upstream commits of moving Git dependencies used by the global package and invalidate `.ploinky/deps/global` and `.ploinky/deps/agents` only when the recorded moving-dependency evidence changes. An unresolved remote ref must not cause destructive cache invalidation. Update invalidates stale caches; it does not claim an agent is ready until the normal startup path prepares and validates the replacement cache.

### Built-in Router routes

Browsers, operators, and agents initiate this behavior by sending HTTP, SSE, WebSocket, or MCP traffic to the Router. The Router must classify the listener and exact Host, resolve the path against one active immutable route-and-policy generation, apply the required user or agent authentication, and revalidate the captured generation lease immediately before any upstream dial. Unknown, stale, malformed, superseded, or unauthorized paths must fail closed without revealing private target details.

| Path | Behavior and access boundary |
| --- | --- |
| `/health` | Return public liveness information; detailed internal health remains confined to the protected Unix socket and private surfaces. |
| `/MCPBrowserClient.js` and `/web-libs/*` | Serve the Router-owned browser client and approved browser libraries as public static resources. |
| `/agent-card[/]` | Aggregate cards from active agents through generation-revalidated fan-out without forwarding caller credentials or identity headers. |
| `/mcp[/]` | Expose the Router-level MCP endpoint only after the required user authentication. |
| `/<agent>/mcp`, `/<agent>/task`, `/<agent>/agent-card`, and declared agent paths | Proxy only to an active admitted target whose route, caller ACL, policy, generation, and lease remain valid. |
| `/auth/*` | Handle login, logout, session, invitation, and token flows under the selected authentication mode. |
| `/api/agents/*` | Perform selected-agent user and settings administration only for an authenticated administrator with the required browser mutation proofs. |
| `/policy/command` | Execute the Router-owned policy command surface for an authorized administrator or an explicitly admitted agent request. |
| `/api/router/openai-agent-discovery` | Return enabled OpenAI-compatible backends only to a request carrying a valid HTTP Agent Assertion. |
| `/api/router/*` | Serve Router-owned integration endpoints, including identity-bound gateway support, under each endpoint's specific authentication contract. |
| `/api/marketplace/*` | Serve Marketplace discovery and enablement flows only when that surface belongs to the selected active route plan. |
| `/webchat/*` and `/status/*` | Serve Router-owned browser applications under the selected route's authentication and administration rules. |
| `/upload`, `/blobs/*`, and `/workspace-files/*` | Admit authenticated upload and workspace-file operations through Router-owned confinement, quota, and path checks. |
| `/` and `/index.html` | Resolve the configured static agent through the active Host and route plan and apply its authentication boundary before serving or proxying content. |

The Router must reserve its control-plane prefixes so an agent cannot claim or policy-route them. Caller-supplied identity and forwarding headers must be stripped, and Router-generated identity context may be attached only after admission. The outer Box must expose only the Router's public listener; the private Router listener, AgentServer endpoints, and agent ports must remain inside the Box. Routing surfaces are specified in [DS007-routing-and-web-surfaces](specsLoader.html?spec=DS007-routing-and-web-surfaces.md), authentication in [DS008-auth-capabilities-and-secure-wire](specsLoader.html?spec=DS008-auth-capabilities-and-secure-wire.md), and route policy in [DS016-router-access-control-http-route-access-and-mcp-policy](specsLoader.html?spec=DS016-router-access-control-http-route-access-and-mcp-policy.md).

### Built-in browser libraries

An agent application may load the standard browser helpers from Router-owned paths instead of copying them into every repository. The Router must serve only files beneath the approved `webLibs/` root and must reject traversal outside that root.

| Library | Stable public URL and result |
| --- | --- |
| WebSkel ESM | `/web-libs/webskel/webskel.mjs` loads the ES-module build of the WebSkel web-component library. |
| WebSkel UMD | `/web-libs/webskel/webskel.umd.js` loads the UMD build and exposes its browser global. |
| `paulmillr-qr` | `/web-libs/qrLib/qr.min.js` loads the bundled QR-code generator and reader. |
| MCP browser client | `/MCPBrowserClient.js` loads Ploinky's browser-side MCP client from the shared Agent library. |

These URLs must remain Router-owned public resources even when the surrounding agent application requires authentication. They must not grant access to arbitrary repository files, workspace files, private Router state, or another route generation.

Ploinky fulfills its primary purpose when one workspace command produces one validated Box, a readiness-gated agent graph, predictable mounts and dependencies, profile-controlled runtimes, bounded lifecycle and update effects, and stable Router-owned interfaces. Future changes must preserve the concrete commands, paths, data boundaries, and observable results defined by these nine components; a change to one of those outcomes requires this specification and its specialized DS contract to be updated together.
