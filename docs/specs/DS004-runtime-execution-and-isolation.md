---
id: DS004
title: Runtime Execution and Isolation
status: implemented
owner: ploinky-team
summary: Defines how Ploinky selects execution backends, mounts code and skills, supervises agent services, and applies runtime resources.
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
| `ploinky start ...` | Reconcile/start outer runtime; preserve graph publishes and router readiness |
| `ploinky status` | Inspect outer contract/publishes/health and running core status without mutation |
| `ploinky stop` | Stop core services, then stop outer runtime; keep volumes |
| `ploinky destroy` | Confirm and directly remove the outer container; retain its three named volumes |
| REPL `status`/`stop`/`destroy` | Core workspace/router/agent scope; outer runtime remains |

The outer runtime uses the mutable `docker.io/assistos/ploinky-box:runtime`
reference carrying exact label `io.assistos.ploinky.runtime-contract=3`. A
missing-box create or intentional configuration replacement pulls the selected
logical reference, validates its complete metadata, captures its image ID, and
runs that ID. Reuse, stopped-box start, status, stop, and destroy do not pull.
Existing contract-1 and contract-2 boxes are unsupported; the hard cut has no
migration or adoption path.

The outer container and its workspace, nested-container-storage, and dependency
volumes are deterministically named from the canonical absolute host directory.
Every answering installed engine is inventoried before selection; unreachable,
split, or foreign ownership fails before mutation. Public `--name`, `--engine`,
and `PLOINKY_BOX_ENGINE` selectors do not exist. Replacement is transactional:
pull, image validation, publication planning, and conflict checks precede old-box
shutdown, while any later failure restores the previous image ID and full
inspected creation configuration. All three named volumes survive replacement
and direct host destroy.

Runtime inspection is canonicalized before it is compared with the desired
contract. In particular, Podman's normalized security-option spelling and
ordering are equivalent to the requested values, and device requests are
recovered from the inspected create command when `HostConfig.Devices` is empty.
This normalization is comparison-only: creation still emits the exact
contract-3 devices and security options, while an actually missing or different
request remains replacement drift. Repeating an unchanged host command must
therefore reuse the same compliant outer container without pulling or replacing
it.

Nested Podman belongs to this outer runtime only. Ordinary agent images
intentionally contain neither Podman nor Docker and do not receive authority
over sibling containers. The exact `io.assistos.ploinky.managed=1` label marks
Ploinky-owned nested containers so box boot removes only those running or stopped
records while preserving manual containers, nested images, and named volumes.
Before opening the retained graph root, boot also clears only the outer
container filesystem's transient rootless-Podman run directories under `/tmp`;
those paths contain stale process/lock state, not the retained container graph,
and cleanup failure stops boot.

The container's network namespace is selected from the manifest. The default is a workspace-defined bridge by name; agents that opt into `network.mode: "host"` run with `--network host` and share the host's network namespace directly. The runtime must not emit `-p` port publishes for host-network agents, must not register bridge aliases for them, and must not create a named bridge on their behalf. Sibling agents on a bridge that need to reach a host-network agent must route through the host gateway entry the runtime exposes (`host.containers.internal` on podman with netavark, or the bridge gateway IP); manifest defaults that previously assumed a bridge alias must be either re-pointed or made overridable through operator-supplied vars when the dependency moves to host networking.

Every Ploinky-managed nested Podman bridge must be created with the exact
`isolate=true` bridge option. Existing managed bridges are reusable only when
inspection proves that exact option and the rest of the managed driver, DNS,
IPv4 IPAM, subnet, and ownership-label contract. This blocks direct IP routing
between different managed bridges while preserving connectivity among agents
that intentionally share a logical network and preserving ordinary outbound
NAT. Ploinky must fail closed instead of adopting or silently weakening an
unisolated managed bridge.

Managed agent containers disable engine-generated hosts entries and bind the
workspace's generated localhost-only hosts file read-only at `/etc/hosts`.
Container reuse proves that exact mount and create policy. The network-contract
hash includes this runtime policy revision so containers created with the older
engine-augmented hosts behavior are recreated deliberately instead of retaining
`host.containers.internal` or equivalent broad box-loopback aliases.

Managed container transactions wait for the workspace network lifecycle lock
with a bounded timeout. Parallel dependency waves therefore serialize their
network, gateway, replacement, and start mutations instead of failing on a live
owner. Gateway preflight validates every attachment that currently exists;
under the same acquired transaction, reconciliation may then add and verify a
missing desired attachment left by an outer-runtime replacement or another
serialized launch.

Inside the managed outer runtime, profile `openPorts` is the reviewed crossing between an agent container and that runtime and is also eligible for host publication. The inner runtime widens loopback publish binds to its interfaces so the supervisor can reach the runtime-side socket; the graph planner retains the manifest's outer bind policy when it creates the host publish. Host-network agents do not need an inner `-p` flag, but their declared runtime-side sockets remain subject to the same outer eligibility and conflict rules. Private service listeners must instead stay on named service networks or use private router/readiness mechanisms.

The supervisor passes a versioned, bounded publication-coverage contract into core. Core command boundaries validate it before profile, registry, hook, router, or nested-runtime mutation, and the shared agent transition validates it again before create, start, restart, or recreate. REPL, Marketplace, and monitor paths that cannot reconcile their own outer container fail closed with a host one-shot command; monitor denial is nonfatal and remains under restart backoff.

Existing container reuse must compare both the resolved runtime environment and the effective manifest network (`profiles.<profile>.network` when present, otherwise root `manifest.network`). If the effective network changes, the runtime must recreate the container instead of returning an instance attached to the old namespace.

The runtime may also execute agents through host sandbox backends when the manifest sets `lite-sandbox: true`, but host sandboxes are disabled by default per workspace. Operators must explicitly run `ploinky sandbox enable` to opt into host sandboxes; until then, manifests requesting `lite-sandbox: true` use the container runtime. Once enabled, Linux hosts must select `bwrap`; macOS hosts must select `seatbelt`; unsupported or misconfigured hosts must fail with operator guidance. Ploinky must not silently fall back from a requested host sandbox to containers when the operator has opted in. The environment variable `PLOINKY_DISABLE_HOST_SANDBOX=1` forces the disabled state regardless of workspace configuration.

Inside a Ploinky box, the box marker overrides that host policy: every managed agent path uses nested Podman, including manifests that request a lite sandbox, and Docker fallback is forbidden. Every persistent agent container and ephemeral helper/probe/install container created by Ploinky carries the exact ownership label `io.assistos.ploinky.managed=1`; selective boot cleanup matches that exact label and therefore preserves manual containers, images, and named volumes.

Host sandbox teardown must be batch-oriented when multiple sandboxed agents are stopped or destroyed. The runtime must send the graceful signal to every selected sandbox process group first, wait once against the shared deadline, and only then force-kill the remaining process groups before clearing their PID records. A slow or stuck sandboxed agent must not delay graceful signal delivery to the other sandboxed agents in the same stop or destroy operation.

A core `destroy` entered in the REPL must remove workspace agent runtimes and regenerated runtime caches, including `.ploinky/deps`, but it must not remove agent homes under `.data/<agent-or-alias>/` or the containing outer runtime. Starting the workspace afterward must recreate agent runtimes and dependency caches while remounting the preserved `.data` directory at `/root` for each agent. Host `ploinky destroy` is a separate supervisor operation: after exact-instance confirmation it directly removes only the outer container and its attached anonymous volumes; the workspace, nested-container-storage, and outer dependency named volumes remain for recreation.

Each agent execution environment must expose the shared `Agent/` payload at `/Agent` for container backends or the equivalent runtime location for sandbox backends. If a manifest does not provide an explicit agent command, the runtime must fall back to `Agent/server/AgentServer.sh`, which supervises `AgentServer.mjs` and restarts it after exit.

Code and skills mounts must be profile-aware. The persisted active profile defaults to `default`; both `default` and `dev` make code and skills writable unless overridden. In `qa` and `prod`, code and skills default to read-only unless the profile explicitly relaxes them. The profile merge order is `profiles.default` plus the selected profile overlay. Workspace-root write access must not bypass read-only code, dependency-cache, staged Agent library, or protected Ploinky state paths. The managed host start path always forwards an explicit selection—`default` when omitted—while a core start entered inside the REPL without `--profile` may retain the persisted profile.

Profiles may declare `additionalServerPort` for an agent-owned browser service, usually as a bare port such as `3000`; `127.0.0.1:3000` is also accepted. The active profile overlay replaces the default profile's additional server declaration as one selected upstream. Container runtimes must record the declaration as a container-local upstream unless the effective network is `network.mode: "host"`; host sandbox runtimes must record it as host-local because they share the host network. This declaration must not imply an `openPorts` publish or host-publication eligibility. For a start-only service, its resolved private route may be the TCP startup-readiness target. For execution modes that include AgentServer, `additionalServerPort` remains a second browser-service route and does not replace the port-7000 MCP, agent-card, or readiness route.

Web Publishing nginx is the HTTP/WebSocket consolidation boundary. It must bind port 8081 and install a default server that returns 404 even when no routes have been configured. OnlyOffice and LiveKit deployment probes must use their generated external Web Publishing URLs; direct host access to private service ports 8082, 17000, and 17002 is not part of the public deployment contract. A graph-aware Explorer start adds the selected profile's eligible publishes to the desired outer configuration and reconciles an existing mismatch before core startup; operators must still use the configured publish reported by read-only status rather than assuming a host port.

Manifest volume declarations from the root manifest and active profile must create missing host directories before startup. Relative host paths are resolved against the workspace root, absolute host paths are honored as declared, and manifest volumes are not limited to `.ploinky/`. A manifest volume with `volumeOptions.<containerPath>.readOnly: true` must be enforced as read-only by every runtime backend: Podman uses a read-only relabelled bind, Docker uses a read-only bind, bwrap uses `--ro-bind`, and Seatbelt grants read access while overlaying an explicit write deny. The explicit deny must protect the read-only volume even when its path is beneath a broader writable workspace path. Writable Podman manifest volumes under `.ploinky/data/` are mounted with the Podman `:U` option so non-root images can write their private runtime state; external manifest volumes keep normal ownership unless the volume option explicitly opts into Podman chowning. Runtime resources declared under `runtime.resources` may create persistent storage under `.ploinky/data/<key>/` and may materialize environment variables from workspace paths, persisted secrets, and variable references.

The static agent’s preinstall host hook must be allowed to run before dependency startup begins. This is part of the current startup contract because dependent services may require variables or files that the static agent’s preinstall hook creates before the dependency graph is expanded into startup waves.

Manifest env entries marked `runtime: false` remain available to host lifecycle and startup-provider execution but must be excluded from the environment of Docker, Podman, bwrap, and Seatbelt agents. Container backends must omit them from OCI `Config.Env`, not merely scrub the entrypoint process after creation, so later readiness probes and operator executions do not inherit the credential from container metadata.

After static preinstall, Ploinky prepares the manifest repository graph without enabling its agents, then runs startup config providers as a host-side preflight over the discovered dependency graph. This provider phase must finish before manifest enable directives can start dependent agents, before dependent env maps are built, before missing graph nodes are enabled, and before blocking/no-wait dependency waves start. It may persist validated output into the encrypted workspace var store, so the ordinary runtime env resolution path sees provider-written values on the dependent agent's first launch during the same `ploinky start`.

Hardware-aware LLM agents opt in through `manifest.llmRuntime.enabled = true`. When opted in, Ploinky resolves the architecture catalog, runs allowlisted accelerator probes with short timeouts (`nvidia-smi -L`, `nvidia-ctk cdi list`, `/dev/kfd`, `/dev/dri`, `/dev/accel`, `rocminfo`, `amd-smi`, `lspci -nn`, `vulkaninfo --summary`), inspects the container daemon's OCI platform via `docker info`/`docker version`/`podman info --format json`, and selects a compatible architecture record before dependency-cache preparation. Accelerator families require confirmation signals, not just device-file presence: ROCm requires a ROCm tool, Vulkan requires a renderer from `vulkaninfo`, and Intel/OpenVINO requires an Intel device confirmation.

Architecture selection produces a typed runtime policy (platform, memory, cpus, pids-limit, shm-size, ulimit memlock, allowlisted CDI/host devices, allowlisted `securityOpt`, `ipc`, `--gpus`). Ploinky emits those arguments into the `docker run` / `podman run` command and labels the container with `ploinky.llm.architecture`, `ploinky.llm.catalog`, `ploinky.llm.catalogref`, `ploinky.llm.policyhash`, `ploinky.llm.imagedigest`, and `ploinky.reusehash`. Container reuse for LLM agents compares both `ploinky.envhash` and `ploinky.reusehash` against the desired values; the reuse hash includes architecture id, image ref, image digest, OCI platform, runtime policy hash, catalog id, and catalog ref. The single architecture override (`PLOINKY_LLM_ARCHITECTURE_ID`), forced platform (`PLOINKY_LLM_FORCE_PLATFORM`), forced accelerator family (`PLOINKY_LLM_ACCELERATOR`), and explicit image override (`PLOINKY_LLM_AGENT_IMAGE` / `PLOINKY_<AGENT>_IMAGE`) are validated against the same typed contract — runtime policy validation is never bypassed. There is no per-agent architecture override because architecture selection is host/runtime policy, not agent-owned model policy. Non-LLM agents are untouched.

For LLM runtime agents, Ploinky mounts alias-specific runtime state at `/runtime`, alias-specific model storage at `/models`, and the shared LLM runtime support files at `/Agent/llm-runtime` when those files are present in the workspace. The runtime startup wrapper runs three internal services: the public proxy on port `9000`, the shared AgentServer MCP sidecar on port `9001`, and the runtime control service on port `9002`. Public `/mcp` traffic uses the shared AgentServer path; `/runtime/*` remains a transitional diagnostic/control surface behind the proxy; `/v1/chat/completions` continues to proxy to the active model engine after launcher selection.

## Decisions & Questions

### Question #1: Why does the static agent’s preinstall hook run before dependency startup?

Response:
The implementation explicitly runs the static agent’s preinstall hook before manifest directives and dependency waves are applied. This ordering allows the static agent to seed workspace variables or files that dependent agents consume during their own startup and matches the current behavior in `startWorkspace()`.

### Question #2: Why do startup config providers run after graph discovery but before dependency startup?

Response:
Provider declarations belong to the static/profile manifest, but provider agents can be installed or enabled by the same recursive manifest directive pass as other dependencies. Running after graph discovery lets Ploinky resolve those provider agents and protect generated-secret names across the full graph; running before dependency startup lets provider output participate in normal manifest env resolution for consumers.

### Question #3: Why are mount permissions profile-driven instead of being hardcoded per runtime?

Response:
The repository already supports multiple deployment stances through `dev`, `qa`, and `prod`. Mount policy is therefore an operational concern, not a property of one backend. Keeping it profile-driven allows the same agent manifest to run with writable development mounts and read-only higher-assurance mounts without forking the runtime implementation.

### Question #4: Why is host networking handled at the manifest layer rather than as a runtime flag?

Response:
Host networking changes the agent's port surface, its DNS resolution, and the way siblings address it; that affects manifest content (no `-p` flags, no bridge aliases, sibling URL configuration) more than it affects the implementation. Modeling it as `network.mode: "host"` in the manifest keeps the choice declarative, visible to operators, reflected in the manifest registry, and reproducible across `podman` and `docker` runtimes without bespoke flags at the call site.

### Question #5: Why does host sandbox teardown signal every process before waiting?

Response:
`stop`, `shutdown`, and `destroy` are workspace-level lifecycle operations. If Ploinky waited for each `bwrap` or Seatbelt process before signaling the next one, one stuck agent could keep the rest of the workspace running for the full timeout. Batch signaling gives every selected sandbox the same shutdown window and keeps the total wait bounded by one shared deadline.

### Question #6: Why is outer-runtime replacement transactional?

Response:
The outer container is replaceable, but its creation configuration and three
named volumes are operator state. Prevalidating the selected image, capturing
the normalized prior configuration, and rolling back after a failed replacement
lets Ploinky advance a mutable runtime tag under an immutable metadata contract without turning an ordinary
command into destructive migration. Keeping ordinary agent images free of
container-engine tooling preserves the separate privilege boundary.

### Question #7: Why must read-only and host-hook-only declarations be enforced by every backend?

Response:
Both declarations are security boundaries in the manifest contract. Treating them as backend hints would make the same agent writable or credential-bearing when the operator switches runtimes, so Docker, Podman, bwrap, and Seatbelt must preserve the same effective restrictions without agent-specific exceptions.

## Conclusion

Ploinky’s runtime layer must continue to provide predictable service startup across container and sandbox backends, preserve the shared `Agent/` payload, avoid implicit backend fallbacks, and apply profile-aware isolation rules that are visible to operators and tests.
