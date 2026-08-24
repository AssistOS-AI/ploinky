---
title: DS006-runtime-execution-and-isolation
summary: Defines the managed outer Box, exact network boundary, rootless nested runtimes, mount policy, persistent caches, and lifecycle recovery.
---

# DS006 Runtime Execution and Isolation

## Introduction

Ploinky uses one managed outer Box to give all supported hosts a consistent, unprivileged environment. Agent runtimes execute inside that boundary and must not widen its physical-host publications or filesystem grants.

## Core Content

The public command must use the configured `PLOINKY_BOX_IMAGE` reference or the default `docker.io/assistos/ploinky-box:latest`. Before launch, Ploinky must validate the image's exact immutable identity, empty label set, `/etc/ploinky-box` marker, entrypoint, user, capabilities, and complete image configuration against the source-owned allowlist, then run the captured image ID. Branch or tag fallback and unverified mutable-reference execution are prohibited.

The outer Box must remain rootless and unprivileged, use an init or reaper, and satisfy the exact confinement profile. It must mount the Ploinky source read-only at `/opt/ploinky`, the canonical workspace read-write at `/workspace`, `.ploinky/box/dependencies` at the Box dependency path, and `.ploinky/box/images` at the nested image-cache path. It must use a fresh executable tmpfs for `/tmp`, keep transient sockets in the Box-private `/run/ploinky`, and create no outer named volume.

The Box must publish exactly two engine mappings: `127.0.0.1:<selected-router-port>:8080/tcp` and `0.0.0.0:<selected-media-port>:7882/udp`. The in-Box targets are fixed even when the physical-host ports change. Agent `openPorts`, graph topology, profiles, readiness, retained runtime state, and HTTP-service declarations must not create a third publication or expose private Router port `8081`, agent port `7000`, or any agent-owned listener directly.

Managed agent and helper containers must run through nested rootless Podman with the required Netavark and `pasta` behavior. They must run without privileged mode, SUID or setuid escalation, file capabilities, broad host devices, or relaxed confinement. Default and bridge agents receive only the reviewed host-gateway mapping and private Router topology. Runtime mounts must equal the Ploinky-generated and manifest-authorized set; read-only mounts must remain read-only in every backend, and OCI image `VOLUME` declarations must not introduce unreviewed anonymous storage.

The host process owns the Box. A compatible running Box is reused, a compatible stopped Box is started in place, and a requested image or port change may use a transactional validated replacement. Other creation drift and any foreign ownership fail before mutation and require explicit destruction. `stop` must quiesce core services before stopping the Box. `destroy` must remove only the exact owned Box and must preserve the workspace, agent homes, dependency cache, and nested image cache unless `--delete-cache` explicitly selects the two cache paths.

Nested container records, writable layers, networks, and inner Podman named volumes live in the Box writable layer and do not survive Box destruction. Durable agent or service data must therefore use explicit workspace-backed binds. Stop and start may reuse the same Box writable layer, but `/tmp` and its transient inner runtime metadata are recreated on each outer boot.

The runtime contract provides reproducible agent execution while keeping the physical-host boundary fixed, rootless, attributable to one workspace, and recoverable without broad cleanup.

### Architectural rationale

| Decision | Reason |
| --- | --- |
| Install and run agent dependencies inside the managed Box | Prototyping must not install unreviewed libraries, package-manager scripts, or vulnerable transitive dependencies on the physical host. Compromise is contained by the rootless boundary and explicit mounts. |
| Use one workspace-owned Box with nested per-agent runtimes | The Box gives every supported host one consistent execution base, while nested runtimes isolate agents from one another. A single ownership layer also avoids recursive Box management and ambiguous cleanup. |
| Mount Ploinky source read-only and validate the exact image before launch | Runtime behavior remains attributable to reviewed source and an immutable image identity; an in-Box process cannot silently rewrite the supervisor it depends on. |
| Publish exactly the Router TCP endpoint and the LiveKit UDP endpoint | The physical-host boundary is known before untrusted manifests are read and remains stable as agents are enabled or disabled. An agent graph cannot widen host exposure. |
| Use reviewed port-scoped rootless forwarding instead of address-wide loopback exposure | Required TCP ports remain reachable inside the Box while the private Router listener stays confined; granting an entire host-loopback address would expose unrelated services. |
| Keep durable data in explicit workspace-backed binds | Nested container metadata and writable layers belong to one Box generation and are safely disposable. Explicit binds preserve only the data whose lifecycle is intentionally longer. |
| Refuse foreign or incompatible runtime state instead of adopting it | Automatic adoption could mutate or delete resources owned by another workspace or created under a different security contract. Exact ownership evidence makes recovery bounded. |
