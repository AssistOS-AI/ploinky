---
id: DS004
title: Runtime Execution and Isolation
status: implemented
owner: ploinky-team
summary: Defines execution backends, outer Box contract 6, core runtime v5, exact outer publications, private target mappings, topology mounts, and generation-scoped isolation capabilities.
---

# DS004 Runtime Execution and Isolation

## Introduction

Ploinky runs agents through multiple backend styles, but it must present one coherent runtime contract to the workspace. This document defines the backend, mount, and service-supervision rules that the implementation currently enforces.

## Core Content

Container execution is the default backend. The public host supervisor automatically selects the sole Podman or Docker engine that owns the exact-directory outer runtime identity; when no identity resources exist it selects Podman first. Inside that outer box, every Ploinky-managed agent and helper path is forced through nested Podman and Docker fallback is forbidden. Agent container names must be derived from the repository name, the agent or alias name, and a workspace hash so that multiple workspaces can run the same agent names without collisions.

The managed public-entrypoint boundary is:

| Invocation | Documented effect |
| --- | --- |
| `ploinky` or `p-cli` | Reconcile/start outer runtime; open Ploinky REPL |
| `ploinky cli` | Reconcile/start outer runtime; open `/bin/bash` as `podman` in `/workspace` |
| `ploinky cli <agent>` | Reconcile/start outer runtime; attach to that agent's manifest CLI |
| `ploinky start ...` | Reconcile/start outer runtime; start the selected graph behind the fixed boundary |
| `ploinky status` | Inspect outer contract/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm and directly remove the outer container; retain its three named volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

The outer runtime uses the mutable `docker.io/assistos/ploinky-box:runtime`
reference carrying exact label `io.assistos.ploinky.runtime-contract=6`. A
missing-box create pulls the selected logical reference, validates its complete
metadata, captures its image ID, and runs that ID. Reuse, stopped-box start,
status, stop, and destroy do not pull. Every non-contract-6 box is unsupported,
including contract 4, malformed, and identity-incomplete state. It fails before
pulling, volume creation, restart, upgrade, or replacement. No automatic
restart, upgrade, relabel, adoption, cleanup, migration, or replacement is
allowed. The operator must run `ploinky destroy` explicitly and then recreate
contract 6; all three named volumes are retained.

Direct/core installations must cut over before the new release is invoked.
From the old checkout, use the explicit core entry rather than the public outer
wrapper:

```sh
node cli/index.js destroy
node cli/index.js network prune
```

Outside a managed box, `ploinky` dispatches to the outer supervisor and is not
equivalent to these core commands. Inspect or resolve any foreign resources
reported by the core prune. After proving no container references them,
one-time cleanup may remove only `.ploinky/run/router.sock`,
`.ploinky/run/managed-hosts`, and the cached exact image
`docker.io/assistos/ploinky-network-gateway:1@sha256:68c47ce93d16ea1a2d03944f7b50ce82e6f2f9a26b183d2c9c7fbabcc828fb7e`.
Before v5 activation the operator must also revoke the retired publication
connector/API tokens and remove its plaintext retained state. Contract 5 has no
reader, importer, compatibility alias, or cleanup routine for that state. A
broad container, image, volume, or network prune is not part of the cutover.

The outer container and its workspace, nested-container-storage, and dependency
volumes are deterministically named from the canonical absolute host directory.
Every answering installed engine is inventoried before selection; unreachable,
split, or foreign ownership fails before mutation. Public `--name`, `--engine`,
and `PLOINKY_BOX_ENGINE` selectors do not exist. Contract mismatch is never
repaired transactionally: the existing box remains untouched until an explicit
destroy. All three named volumes survive direct host destroy.

Runtime inspection is canonicalized before it is compared with the desired
contract. In particular, Podman's normalized security-option spelling and
ordering are equivalent to the requested values, and device requests are
recovered from the inspected create command when `HostConfig.Devices` is empty.
The outer container must also run with an engine-provided init process so PID 1
reaps orphaned in-box children. This normalization is comparison-only: creation
still emits the exact contract-6 init, devices, security options, and fixed
publications. An actually missing or different request is recreate-required
drift: reconciliation fails before pull, stop, rename, removal, or creation and
tells the operator to run `ploinky destroy` explicitly before recreating the
box. Repeating an unchanged host command must therefore reuse the same compliant
outer container without pulling or replacing it.

Nested Podman belongs to this outer runtime only. Contract-6 self-check requires
rootless Podman 5.4 or newer, Netavark, and an operational `pasta`; managed
networking has no `slirp4netns` fallback. Ordinary agent images
intentionally contain neither Podman nor Docker and do not receive authority
over sibling containers. The exact `io.assistos.ploinky.managed=1` label marks
Ploinky-owned nested containers. Contract-6 boot rejects retained exact-label
records, including old managed gateway and agent records, without deleting or
importing them. The operator removes managed records in the old box before the
explicit destroy/recreate boundary; manual containers, nested images, named
volumes, and schema-2 networks remain untouched by v5 startup.
Before opening the retained graph root, boot also clears only the outer
container filesystem's transient rootless-Podman run directories under `/tmp`;
those paths contain stale process/lock state, not the retained container graph,
and cleanup failure stops boot.

The container's network namespace is selected from the strict manifest modes
`default`, `bridge`, `host`, and `none`. `default` creates a private logical
bridge for the effective instance. `bridge` requires explicit attachments and
exactly one primary; same-network peers communicate by derived alias. `host`
uses the outer-box namespace without managed bridges, aliases, or inner `-p`
publishes. Host mode additionally requires a box-granted capability for the
exact effective instance and current enable generation. `none` has no network
or router endpoint and rejects AgentServer, network-dependent readiness,
`openPorts`, and HTTP-service targets. Legacy
`network.name` and `network.aliases` forms are not adopted.

Every Ploinky-managed nested Podman bridge must be created with the exact
`isolate=true` bridge option. Existing managed bridges are reusable only when
inspection proves that exact option and the rest of the managed driver, DNS,
IPv4 IPAM, subnet, and ownership-label contract. This blocks direct IP routing
between different managed bridges while preserving connectivity among agents
that intentionally share a logical network and preserving ordinary outbound
NAT. Ploinky must fail closed instead of adopting or silently weakening an
unisolated managed bridge. The schema-2 network labels and inspect result are
validated before reuse, and router restart must not recreate or mutate these
networks.

Managed `default` and `bridge` containers use exactly `--hosts-file=none
--add-host host.containers.internal:host-gateway`. This is a fixed name/address
transport contract, not a generation capability and not authorization. Their validated router
endpoint is injected through `PLOINKY_ROUTER_HOST`, `PLOINKY_ROUTER_PORT`, and
`PLOINKY_ROUTER_URL`. Before a consumer starts, Ploinky also mounts the
box-owned non-secret snapshot named by `PLOINKY_EDGE_TOPOLOGY_FILE` and injects
`PLOINKY_INTERNAL_ROUTER_URL`. `host` uses `127.0.0.1`; `none` receives no
endpoint.

Before a managed-network launch can receive Router authority, Ploinky resolves
the agent image reference to one immutable image ID and reads only the bounded
`Config.User` projection from that image. The image must declare an exact
numeric, non-root `UID:GID`; an empty, symbolic, root, or out-of-range identity
fails closed. The confined authority helper runs the immutable image as that
same user. The real nested Podman container then uses
`--userns=keep-id:uid=<UID>,gid=<GID>` so its attested non-root identity maps to
the outer rootless owner of writable bind mounts such as `/root`. Creation,
adoption, and final inspection must agree on the immutable image, `Config.User`,
and exact Podman user-namespace annotation.

Container reuse proves the exact hosts arguments, attachments, aliases, labels,
versioned network-contract hash, and immutable `instanceId` plus
`enableGeneration` ownership labels. A mutable registry record cannot make an
older process current: reuse and capability-effectiveness checks compare the
engine-inspected launch tuple to the selected generation. A container carrying an older contract
hash remains foreign and is neither adopted nor recreated. Only an exact-owned
current-hash container whose mutable runtime configuration drifted may be
recreated; Ploinky must never weaken the hash to retain prior behavior.

Outside a marked box, bwrap and Seatbelt use the same exact tuple. Their durable
PID record includes the runtime key, PID/process-start identity, `instanceId`,
and `enableGeneration`; liveness and reuse reject any missing or stale field.
Every managed backend injects the matching private assertion secret and fails
startup if identity derivation fails. A PID, container name, mutable registry
entry, or localhost provenance alone is never proof of current ownership.

Managed container transactions wait for the workspace network lifecycle lock
with a bounded timeout. Parallel dependency waves therefore serialize their
network, replacement, and start mutations instead of failing on a live owner.
Preflight validates every desired attachment before mutation; under the same
transaction, reconciliation may create and verify missing managed bridges or
attach the new container. Foreign or unsupported network state remains
fail-closed and is never replaced or adopted.

`RoutingServer.js` owns a public/control listener on box port `8080` and an
unpublished private listener on `8081`. The first
is reachable through the fixed loopback physical-host publication and from
in-box cloudflared; the second must never be an outer publication.
Inside a marked Box, the private listener binds the Box namespace wildcard so
nested rootless Podman can reach it through Podman's `host-gateway`; outside a
Box it retains the exact loopback/managed-gateway listener set. The wildcard is
not a publication or an authorization grant: outer contract 6 never publishes
TCP 8081, and every private request still requires its exact generation-bound,
method/path/body-bound, replay-protected agent assertion. Detailed health is supervisor-only on an
unmounted Unix socket. Listener/interface class and exact
Host are resolved before pathname dispatch. Routed calls retain JWT
issuer/audience validation, policy, request binding, expiry, and replay
protection; TCP control/status still requires a real admin session, and
mutations require Origin/CSRF even when a caller can reach box loopback.

Every contract-6 outer box has exactly two engine publications, constructed by
the outer wrapper without reading graph state:
`127.0.0.1:<selectedRouterHostPort>:8080/tcp` and
`0.0.0.0:7882:7882/udp`. The first is the sole TCP boundary; the second is an
unconditional reserved UDP slot and may be idle. `--port` changes only the
physical Router port. `--publish`, `--expose`, and `--listen-lan` are rejected.
Profiles, manifests, readiness, environment, labels, and retained state cannot
produce a third mapping.

Inside the box, `openPorts` remains private inner-runtime metadata. A bridged
TCP claim overlapping `8080` or `8081`, or a UDP claim overlapping `7882`, is
rejected before launch. Other reviewed mappings may connect a private target to
a Router-reachable box socket but never cross the physical-host boundary.
Host-network agents emit no inner publish; only the exact capability-owning
generation may bind reserved UDP `7882`, and readiness verifies the expected
socket owner.

Existing container reuse must compare both the resolved runtime environment and the effective manifest network (`profiles.<profile>.network` when present, otherwise root `manifest.network`). If the effective network changes, the runtime must recreate the container instead of returning an instance attached to the old namespace.

A coordinated configuration apply may request one targeted, drain-aware
runtime restart through an internal runtime option; this is not a manifest
field and does not alter ordinary `stop`, `shutdown`, or `destroy`. Before
Ploinky signals that runtime, the coordinator must prove the exact affected
selector identifiers inactive. The process must exit `0` within the fixed
35-second ceiling only after its application persistence/drain acknowledgement
has completed. Exit `143`, another nonzero exit, OOM, a runtime error, or a
timeout is not an acknowledgement: Ploinky performs no `SIGKILL`, removal, or
replacement and the coordinator must leave the affected selectors inactive.
For a managed-network replacement, only the acknowledged stopped predecessor
may be preserved for diagnostics; failure cannot restart it as an authorization
fallback.

The runtime may also execute agents through host sandbox backends when the manifest sets `lite-sandbox: true`, but host sandboxes are disabled by default per workspace. Operators must explicitly run `ploinky sandbox enable` to opt into host sandboxes; until then, manifests requesting `lite-sandbox: true` use the container runtime. Once enabled, Linux hosts must select `bwrap`; macOS hosts must select `seatbelt`; unsupported or misconfigured hosts must fail with operator guidance. Ploinky must not silently fall back from a requested host sandbox to containers when the operator has opted in. The environment variable `PLOINKY_DISABLE_HOST_SANDBOX=1` forces the disabled state regardless of workspace configuration.

Inside a Ploinky box, the box marker overrides that host policy: every managed agent path uses nested Podman, including manifests that request a lite sandbox, and Docker fallback is forbidden. Every persistent agent container and ephemeral helper/probe/install container created by Ploinky carries the exact ownership label `io.assistos.ploinky.managed=1`; the contract-v5 boot guard rejects retained exact-label records without cleanup and therefore never mutates manual containers, images, or named volumes.

Host sandbox teardown must be batch-oriented when multiple sandboxed agents are stopped or destroyed. The runtime must send the graceful signal to every selected sandbox process group first, wait once against the shared deadline, and only then force-kill the remaining process groups before clearing their PID records. A slow or stuck sandboxed agent must not delay graceful signal delivery to the other sandboxed agents in the same stop or destroy operation.

A core `destroy` entered in the REPL must remove workspace agent runtimes and regenerated runtime caches, including `.ploinky/deps`, but it must not remove agent homes under `.data/<agent-or-alias>/` or the containing outer runtime. Starting the workspace afterward must recreate agent runtimes and dependency caches while remounting the preserved `.data` directory at `/root` for each agent. Host `ploinky destroy` is a separate supervisor operation: after exact-instance confirmation it directly removes only the outer container and its attached anonymous volumes; the workspace, nested-container-storage, and outer dependency named volumes remain for recreation.

Runtime lifecycle checks must dispatch by the actual backend recorded in `.ploinky/agents.json`. Enable-time verification checks container liveness only for Docker or Podman and checks the tracked agent PID for Bubblewrap or Seatbelt. Disable-time teardown may remove registry entries first to prevent watchdog resurrection, but it must carry a snapshot of those records into the fleet remover so backend identity remains available after the registry write.

Runtime reporting must use the same backend-aware state model. Marketplace and CLI status surfaces must report every enabled agent from `.ploinky/agents.json`, identify its recorded runtime, and determine liveness from the tracked process PID for Bubblewrap or Seatbelt and from OCI inspection for Docker or Podman. An enabled runtime with no live process or container must remain visible as `stopped`; host-sandbox agents must not be classified as stopped merely because no OCI container exists.

The Linux Bubblewrap backend must keep the selected project path separate from the persistent agent home. It must bind `.data/<agent-or-alias>/` read-write at `/root`, set `HOME=/root`, and use the alias when one identifies the enabled instance. Isolated mode must use `/root` for both the project mount and `WORKSPACE_PATH`; global and development modes must bind their selected project independently and keep `WORKSPACE_PATH` at that project path. Daemon startup and interactive CLI or shell attachment must use the same home and project mapping.

Before Bubblewrap mounts the shared Agent runtime read-only at `/Agent`, Ploinky must stage a regenerated copy under `.ploinky/deps/bwrap-runtime/<agent-or-alias>/`. The staged copy must exclude source `Agent/node_modules` content and must contain an empty `node_modules` directory that exists before sandbox construction. The prepared dependency cache must then be mounted read-only at both `/code/node_modules` and `/Agent/node_modules`. Bubblewrap startup must not depend on modifying the installed Ploinky source tree to create this nested mount point.

The Linux Bubblewrap backend must execute the agent with the same Node.js distribution that launched Ploinky and determined the sandbox dependency-cache runtime key. It must expose that distribution read-only at `/opt/ploinky-node`, place `/opt/ploinky-node/bin` first in `PATH`, and keep the system Node installation as a lower-priority fallback. Manifest install hooks may use the mounted `npm`, but neither the Node distribution nor the prepared dependency cache may become writable inside the sandbox.

Each agent execution environment must expose the shared `Agent/` payload at `/Agent` for container backends or the equivalent runtime location for sandbox backends. If a manifest does not provide an explicit agent command, the runtime must fall back to `Agent/server/AgentServer.sh`, which supervises `AgentServer.mjs` and restarts it after exit.

Non-TTY `ploinky cli` launchers used by WebChat must remain attached only while their inner container or host-sandbox CLI process is alive. The selected backend's interactive exit status must propagate through `runCli`, and the one-shot Ploinky wrapper must terminate after attach returns. This lets the supervising WebChat TTY observe the real lifecycle instead of retaining a live wrapper with no agent process behind it.

Code and skills mounts must be profile-aware. The persisted active profile defaults to `default`; both `default` and `dev` make code and skills writable unless overridden. In `qa` and `prod`, code and skills default to read-only unless the profile explicitly relaxes them. The profile merge order is `profiles.default` plus the selected profile overlay. Workspace-root write access must not bypass read-only code, dependency-cache, staged Agent library, or protected Ploinky state paths. The managed host start path always forwards an explicit selection—`default` when omitted—while a core start entered inside the REPL without `--profile` may retain the persisted profile.

Agent-owned browser/protocol listeners are declared through
`httpServices[].port`. The optional integer is a private container target;
omitting it preserves the owning route's primary AgentServer target. The
launcher creates one engine-assigned private mapping per distinct explicit TCP
target and installs all targets into one immutable route-and-policy
authorization generation. HTTP, SSE, and WebSocket requests use the same
captured route plan and revalidate its generation immediately before opening
the upstream connection. No secondary-target proxy or separate publication
component exists.

Manifest volume declarations from the root manifest and active profile must create missing host directories before startup. Relative host paths are resolved against the workspace root, absolute host paths are honored as declared, and manifest volumes are not limited to `.ploinky/`. A manifest volume with `volumeOptions.<containerPath>.readOnly: true` must be enforced as read-only by every runtime backend: Podman uses a read-only relabelled bind, Docker uses a read-only bind, bwrap uses `--ro-bind`, and Seatbelt grants read access while overlaying an explicit write deny. The explicit deny must protect the read-only volume even when its path is beneath a broader writable workspace path. Writable Podman manifest volumes under `.ploinky/data/` are mounted with the Podman `:U` option so non-root images can write their private runtime state; external manifest volumes keep normal ownership unless the volume option explicitly opts into Podman chowning. Runtime resources declared under `runtime.resources` may create persistent storage under `.ploinky/data/<key>/` and may materialize environment variables from workspace paths, persisted secrets, and variable references.

The static agent’s preinstall host hook must be allowed to run before dependency startup begins. This is part of the current startup contract because dependent services may require variables or files that the static agent’s preinstall hook creates before the dependency graph is expanded into startup waves.

Manifest env entries marked `runtime: false` remain available to host lifecycle and startup-provider execution but must be excluded from the environment of Docker, Podman, bwrap, and Seatbelt agents. Container backends must omit them from OCI `Config.Env`, not merely scrub the entrypoint process after creation, so later readiness probes and operator executions do not inherit the credential from container metadata.

Ploinky first prepares the complete recursive manifest repository graph without starting its agents and resolves the planning dependency graph. Before any static preinstall or startup-provider hook runs, an early inactive generation assigns exact tuples to missing or changed nodes and strips every retained graph route of `hostPort` and `serviceTargets`, including healthy reusable blocking runtimes. Hooks therefore read only a validated, targetless topology generation. Static preinstall failure is fatal and aborts startup before providers run. Startup config providers then execute as a host-side preflight over that graph. After providers complete, Ploinky aborts the early preparation lease, reloads the registry, and re-evaluates every retained predecessor against the provider-populated effective environment. Any newly detected runtime drift mints a replacement instance/enable-generation tuple; records already minted during the early preparation retain that fresh, never-launched tuple. A final inactive targetless generation and lease are captured before any runtime starts, and only that final lease may authorize resolved targets. Blocking waves subsequently create runtimes, apply their targets through the coordinator, and pass readiness in topological order. Additional already-enabled agents outside the graph start after those blocking waves. Detached no-wait helpers are spawned last, using the accumulated prepared identities and coordinated target-apply path; the main start does not wait for those helpers' cache preparation, runtime startup, or readiness after spawning them. This ordering prevents an independent no-wait apply from transiently inactivating an exact host-generation capability while a blocking runtime is being created. Provider output is persisted through the encrypted workspace var store before any dependent env map is built, so it participates in the first launch during the same `ploinky start` without reusing a predecessor's authorization tuple.

Hardware-aware LLM agents opt in through `manifest.llmRuntime.enabled = true`. When opted in, Ploinky resolves the architecture catalog, runs allowlisted accelerator probes with short timeouts (`nvidia-smi -L`, `nvidia-ctk cdi list`, `/dev/kfd`, `/dev/dri`, `/dev/accel`, `rocminfo`, `amd-smi`, `lspci -nn`, `vulkaninfo --summary`), inspects the container daemon's OCI platform via `docker info`/`docker version`/`podman info --format json`, and selects a compatible architecture record before dependency-cache preparation. Accelerator families require confirmation signals, not just device-file presence: ROCm requires a ROCm tool, Vulkan requires a renderer from `vulkaninfo`, and Intel/OpenVINO requires an Intel device confirmation.

Architecture selection produces a typed runtime policy (platform, memory, cpus, pids-limit, shm-size, ulimit memlock, allowlisted CDI/host devices, allowlisted `securityOpt`, `ipc`, `--gpus`). Ploinky emits those arguments into the `docker run` / `podman run` command and labels the container with `ploinky.llm.architecture`, `ploinky.llm.catalog`, `ploinky.llm.catalogref`, `ploinky.llm.policyhash`, `ploinky.llm.imagedigest`, and `ploinky.reusehash`. Container reuse for LLM agents compares both `ploinky.envhash` and `ploinky.reusehash` against the desired values; the reuse hash includes architecture id, image ref, image digest, OCI platform, runtime policy hash, catalog id, and catalog ref. The single architecture override (`PLOINKY_LLM_ARCHITECTURE_ID`), forced platform (`PLOINKY_LLM_FORCE_PLATFORM`), forced accelerator family (`PLOINKY_LLM_ACCELERATOR`), and explicit image override (`PLOINKY_LLM_AGENT_IMAGE` / `PLOINKY_<AGENT>_IMAGE`) are validated against the same typed contract — runtime policy validation is never bypassed. There is no per-agent architecture override because architecture selection is host/runtime policy, not agent-owned model policy. Non-LLM agents are untouched.

For LLM runtime agents, Ploinky mounts alias-specific runtime state at `/runtime`, alias-specific model storage at `/models`, and the shared LLM runtime support files at `/Agent/llm-runtime` when those files are present in the workspace. The runtime startup wrapper runs three internal services: the public proxy on port `9000`, the shared AgentServer MCP sidecar on port `9001`, and the runtime control service on port `9002`. Public `/mcp` traffic uses the shared AgentServer path; `/runtime/*` remains a transitional diagnostic/control surface behind the proxy; `/v1/chat/completions` continues to proxy to the active model engine after launcher selection.

## Decisions & Questions

### Question #1: Why does the static agent’s preinstall hook run before dependency startup?

Response:
The implementation first prepares recursive repositories and the dependency graph, then captures an early inactive targetless generation before the static agent’s preinstall hook runs. Preinstall remains before provider execution and dependency runtime waves, so it can seed workspace variables or files consumed by providers and dependent agents without observing predecessor targets. Failure is fatal. Provider output is followed by retained-runtime re-evaluation and a separate final inactive generation; only that final lease can authorize startup targets.

### Question #2: Why do startup config providers run after graph discovery but before dependency startup?

Response:
Provider declarations belong to the static/profile manifest, but provider agents can be installed or enabled by the same recursive manifest directive pass as other dependencies. Running after graph discovery lets Ploinky resolve those provider agents and protect generated-secret names across the full graph; running before dependency startup lets provider output participate in normal manifest env resolution for consumers.

### Question #3: Why are mount permissions profile-driven instead of being hardcoded per runtime?

Response:
The repository already supports multiple deployment stances through `dev`, `qa`, and `prod`. Mount policy is therefore an operational concern, not a property of one backend. Keeping it profile-driven allows the same agent manifest to run with writable development mounts and read-only higher-assurance mounts without forking the runtime implementation.

### Question #4: Why is host networking handled at the manifest layer rather than as a runtime flag?

Response:
Host networking changes the agent's port surface, DNS resolution, and access to
box sockets. The manifest keeps the request reviewable, but Ploinky grants it
only to an exact effective instance and current enable generation. That split
prevents a copied manifest or stale runtime from acquiring the reserved UDP
slot and prevents localhost provenance from becoming authorization.

### Question #5: Why does host sandbox teardown signal every process before waiting?

Response:
`stop`, `shutdown`, and `destroy` are workspace-level lifecycle operations. If Ploinky waited for each `bwrap` or Seatbelt process before signaling the next one, one stuck agent could keep the rest of the workspace running for the full timeout. Batch signaling gives every selected sandbox the same shutdown window and keeps the total wait bounded by one shared deadline.

### Question #6: Why is an incompatible outer runtime not replaced automatically?

Response:
An incompatible runtime may use a retired publication model or credential ownership. An
automatic replacement would be a migration and could activate a different host
boundary before the operator revoked old credentials and removed plaintext
state. The supervisor therefore rejects incompatible identity or configuration and requires
explicit destroy and recreate while retaining named volumes.

### Question #7: Why must read-only and host-hook-only declarations be enforced by every backend?

Response:
Both declarations are security boundaries in the manifest contract. Treating them as backend hints would make the same agent writable or credential-bearing when the operator switches runtimes, so Docker, Podman, bwrap, and Seatbelt must preserve the same effective restrictions without agent-specific exceptions.

### Question #8: How can a rootless managed bridge reach private Router `8081` without binding the box outer-facing interface?

Response:
Inside a marked Ploinky Box, Router `8081` binds the Box namespace wildcard so
rootless nested Podman can resolve and reach it through Podman's
`host.containers.internal:host-gateway` mapping. The outer runtime never
publishes `8081`, so this does not create a physical-host TCP edge. Reachability
is not authorization: every private request must still pass private-listener
classification, effective route policy, caller ACL, and an exact
instance-and-enable-generation assertion with method, path, body, expiry, and
replay binding. Outside a marked Box, the listener retains the exact
loopback/managed-address bind model. This resolves the rootless transport gap
without adding an outer mapping, compatibility proxy, or firewall dependency.

### Question #9: Why must a non-TTY CLI wrapper terminate when its inner attach ends?

Response:
WebChat supervises the Ploinky wrapper process and cannot otherwise observe that a nested `podman exec`, Bubblewrap, or Seatbelt CLI has ended. Propagating the attach status and terminating the one-shot wrapper turns the existing process-close signal into an accurate runtime-health signal, allowing WebChat to restart or replace the selected CLI without introducing an agent-specific heartbeat.

### Question #10: Why does Bubblewrap expose the agent home at `/root` instead of using the project path as `HOME`?

Response:
The project path determines which files an agent is allowed to work on, while the home stores per-instance authentication, provider configuration, caches, and continuation state. Keeping those paths separate gives Bubblewrap the same persistent-home contract as container runtimes, prevents global and development agents from placing CLI configuration in their project roots, and lets an aliased instance retain independent state across runtime recreation.

### Question #11: Why does Bubblewrap stage the Agent runtime before mounting it read-only?

Response:
Bubblewrap resolves nested bind destinations sequentially. Once `/Agent` is a read-only bind, it cannot create a missing `/Agent/node_modules` directory for the dependency-cache bind. A regenerated staging copy provides that empty mount point in advance without requiring the installed Ploinky source tree to be writable, while the actual dependency cache remains a separate read-only mount.

### Question #12: Why does Bubblewrap mount Ploinky's Node.js distribution instead of using `/usr/bin/node`?

Response:
The dependency cache runtime key is derived from the Node.js process that runs Ploinky. Selecting a different system Node inside Bubblewrap can execute a cache prepared for another Node major and can expose an incomplete npm installation. Mounting the same distribution read-only keeps Node, npm, and the cache ABI aligned without granting the agent write access to the host toolchain.

### Question #13: Why does disable retain a registry snapshot after deleting the live entry?

Response:
Deleting the entry first prevents the watchdog from interpreting teardown as an unexpected crash and immediately restarting the agent. The removed record still contains the only reliable backend discriminator, so passing an in-memory snapshot to teardown preserves that identity without making the agent enabled again. This lets the same disable path stop an OCI container or a host-sandbox PID correctly.

### Question #14: Why do Marketplace and CLI status share one runtime-state collector?

Response:
An enabled-agent record names the selected backend, while backend-specific mechanisms provide liveness. Sharing one collector prevents an API from treating Bubblewrap or Seatbelt as an absent container while another CLI path correctly recognizes its PID, and it preserves stopped enabled entries for operational diagnosis.

## Conclusion

Ploinky’s runtime layer must continue to provide predictable service startup across container and sandbox backends, preserve the shared `Agent/` payload, avoid implicit backend fallbacks, and apply profile-aware isolation rules that are visible to operators and tests.
