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

Container execution is the default backend. The runtime must prefer `podman` when it is available and fall back to `docker` otherwise. Agent container names must be derived from the repository name, the agent or alias name, and a workspace hash so that multiple workspaces can run the same agent names without collisions.

The container's network namespace is selected from the manifest. The default is a workspace-defined bridge by name; agents that opt into `network.mode: "host"` run with `--network host` and share the host's network namespace directly. The runtime must not emit `-p` port publishes for host-network agents, must not register bridge aliases for them, and must not create a named bridge on their behalf. Sibling agents on a bridge that need to reach a host-network agent must route through the host gateway entry the runtime exposes (`host.containers.internal` on podman with netavark, or the bridge gateway IP); manifest defaults that previously assumed a bridge alias must be either re-pointed or made overridable through operator-supplied vars when the dependency moves to host networking.

Existing container reuse must compare both the resolved runtime environment and the effective manifest network (`profiles.<profile>.network` when present, otherwise root `manifest.network`). If the effective network changes, the runtime must recreate the container instead of returning an instance attached to the old namespace.

The runtime may also execute agents through host sandbox backends when the manifest sets `lite-sandbox: true`, but host sandboxes are disabled by default per workspace. Operators must explicitly run `ploinky sandbox enable` to opt into host sandboxes; until then, manifests requesting `lite-sandbox: true` use the container runtime. Once enabled, Linux hosts must select `bwrap`; macOS hosts must select `seatbelt`; unsupported or misconfigured hosts must fail with operator guidance. Ploinky must not silently fall back from a requested host sandbox to containers when the operator has opted in. The environment variable `PLOINKY_DISABLE_HOST_SANDBOX=1` forces the disabled state regardless of workspace configuration.

Host sandbox teardown must be batch-oriented when multiple sandboxed agents are stopped or destroyed. The runtime must send the graceful signal to every selected sandbox process group first, wait once against the shared deadline, and only then force-kill the remaining process groups before clearing their PID records. A slow or stuck sandboxed agent must not delay graceful signal delivery to the other sandboxed agents in the same stop or destroy operation.

`destroy` must remove workspace runtimes and regenerated runtime caches, including `.ploinky/deps`, but it must not remove agent homes under `.data/<agent-or-alias>/`. Starting the workspace after destroy must recreate runtimes and dependency caches while remounting the preserved `.data` directory at `/root` for each agent.

Each agent execution environment must expose the shared `Agent/` payload at `/Agent` for container backends or the equivalent runtime location for sandbox backends. If a manifest does not provide an explicit agent command, the runtime must fall back to `Agent/server/AgentServer.sh`, which supervises `AgentServer.mjs` and restarts it after exit.

Code and skills mounts must be profile-aware. The active profile defaults to `dev`, where code and skills are writable unless overridden. In `qa` and `prod`, code and skills default to read-only unless the profile explicitly relaxes them. The profile merge order is `profiles.default` plus the selected profile overlay. Workspace-root write access must not bypass read-only code, dependency-cache, staged Agent library, or protected Ploinky state paths.

Profiles may declare `additionalServerPort` for an agent-owned browser service, usually as a bare port such as `3000`; `127.0.0.1:3000` is also accepted. The active profile overlay replaces the default profile's additional server declaration as one selected upstream. Container runtimes must record the declaration as a container-local upstream unless the effective network is `network.mode: "host"`; host sandbox runtimes must record it as host-local because they share the host network. This declaration must not imply an `openPorts` publish and must not replace the default AgentServer route used for MCP, agent-card, and readiness.

Manifest volume declarations must create missing host directories before startup. Relative host paths are resolved against the workspace root, absolute host paths are honored as declared, and manifest volumes are not limited to `.ploinky/`. Runtime resources declared under `runtime.resources` may create persistent storage under `.ploinky/data/<key>/` and may materialize environment variables from workspace paths, persisted secrets, and variable references.

The static agent’s preinstall host hook must be allowed to run before dependency startup begins. This is part of the current startup contract because dependent services may require variables or files that the static agent’s preinstall hook creates before the dependency graph is expanded into startup waves.

Hardware-aware LLM agents opt in through `manifest.llmRuntime.enabled = true`. When opted in, Ploinky resolves the architecture catalog, runs allowlisted accelerator probes with short timeouts (`nvidia-smi -L`, `nvidia-ctk cdi list`, `/dev/kfd`, `/dev/dri`, `/dev/accel`, `rocminfo`, `amd-smi`, `lspci -nn`, `vulkaninfo --summary`), inspects the container daemon's OCI platform via `docker info`/`docker version`/`podman info --format json`, and selects a compatible architecture record before dependency-cache preparation. Accelerator families require confirmation signals, not just device-file presence: ROCm requires a ROCm tool, Vulkan requires a renderer from `vulkaninfo`, and Intel/OpenVINO requires an Intel device confirmation.

Architecture selection produces a typed runtime policy (platform, memory, cpus, pids-limit, shm-size, ulimit memlock, allowlisted CDI/host devices, allowlisted `securityOpt`, `ipc`, `--gpus`). Ploinky emits those arguments into the `docker run` / `podman run` command and labels the container with `ploinky.llm.architecture`, `ploinky.llm.catalog`, `ploinky.llm.catalogref`, `ploinky.llm.policyhash`, `ploinky.llm.imagedigest`, and `ploinky.reusehash`. Container reuse for LLM agents compares both `ploinky.envhash` and `ploinky.reusehash` against the desired values; the reuse hash includes architecture id, image ref, image digest, OCI platform, runtime policy hash, catalog id, and catalog ref. The single architecture override (`PLOINKY_LLM_ARCHITECTURE_ID`), forced platform (`PLOINKY_LLM_FORCE_PLATFORM`), forced accelerator family (`PLOINKY_LLM_ACCELERATOR`), and explicit image override (`PLOINKY_LLM_AGENT_IMAGE` / `PLOINKY_<AGENT>_IMAGE`) are validated against the same typed contract — runtime policy validation is never bypassed. There is no per-agent architecture override because architecture selection is host/runtime policy, not agent-owned model policy. Non-LLM agents are untouched.

For LLM runtime agents, Ploinky mounts alias-specific runtime state at `/runtime`, alias-specific model storage at `/models`, and the shared LLM runtime support files at `/Agent/llm-runtime` when those files are present in the workspace. The runtime startup wrapper runs three internal services: the public proxy on port `9000`, the shared AgentServer MCP sidecar on port `9001`, and the runtime control service on port `9002`. Public `/mcp` traffic uses the shared AgentServer path; `/runtime/*` remains a transitional diagnostic/control surface behind the proxy; `/v1/chat/completions` continues to proxy to the active model engine after launcher selection.

## Decisions & Questions

### Question #1: Why does the static agent’s preinstall hook run before dependency startup?

Response:
The implementation explicitly runs the static agent’s preinstall hook before manifest directives and dependency waves are applied. This ordering allows the static agent to seed workspace variables or files that dependent agents consume during their own startup and matches the current behavior in `startWorkspace()`.

### Question #2: Why are mount permissions profile-driven instead of being hardcoded per runtime?

Response:
The repository already supports multiple deployment stances through `dev`, `qa`, and `prod`. Mount policy is therefore an operational concern, not a property of one backend. Keeping it profile-driven allows the same agent manifest to run with writable development mounts and read-only higher-assurance mounts without forking the runtime implementation.

### Question #3: Why is host networking handled at the manifest layer rather than as a runtime flag?

Response:
Host networking changes the agent's port surface, its DNS resolution, and the way siblings address it; that affects manifest content (no `-p` flags, no bridge aliases, sibling URL configuration) more than it affects the implementation. Modeling it as `network.mode: "host"` in the manifest keeps the choice declarative, visible to operators, reflected in the manifest registry, and reproducible across `podman` and `docker` runtimes without bespoke flags at the call site.

### Question #4: Why does host sandbox teardown signal every process before waiting?

Response:
`stop`, `shutdown`, and `destroy` are workspace-level lifecycle operations. If Ploinky waited for each `bwrap` or Seatbelt process before signaling the next one, one stuck agent could keep the rest of the workspace running for the full timeout. Batch signaling gives every selected sandbox the same shutdown window and keeps the total wait bounded by one shared deadline.

## Conclusion

Ploinky’s runtime layer must continue to provide predictable service startup across container and sandbox backends, preserve the shared `Agent/` payload, avoid implicit backend fallbacks, and apply profile-aware isolation rules that are visible to operators and tests.
