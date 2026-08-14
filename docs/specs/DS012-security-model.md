---
title: DS012-security-model
summary: Defines workspace, Box, runtime, routing, credential, storage, browser, and edge-publication trust boundaries.
---

# DS012 Security Model

## Introduction

Ploinky is a workspace-local system for an operator or trusted team. It must isolate agents from the physical host and from one another's reusable credentials while treating the Router and workspace owner as trusted control-plane principals. It is not a hostile multi-tenant hosting boundary.

## Core Content

Every mutation must resolve one exact workspace, acquire the workspace lock, and revalidate identity before acting. Foreign, split, incomplete, ambiguous, changed, or incompatible engine resources must fail closed. Cleanup must use exact proven ids and paths and must never use broad engine pruning or recursive deletion from an unresolved root.

The managed Box must run rootless and unprivileged with the exact source-owned image and container contract. The source mount is read-only, the workspace and two caches are explicit binds, transient runtime state is isolated, and only Router TCP and LiveKit UDP are published as defined by DS005. Agent and private Router ports must remain unexposed.

The managed workspace master key must be the sole private regular file `.ploinky/master-key`, owned by the Box user, containing exactly one 64-character lowercase hexadecimal key, and protected with mode `0600`. Managed execution must ignore host environment and `.env` overrides. Ploinky must derive storage, session, identity, generated-secret, and request-signing keys with distinct HKDF purposes and must never inject the master key or derived-master key into agents.

Credential-bearing agent runtimes may receive only their own post-attestation reusable secret and public verification material. Host, `none`, Bubblewrap, Seatbelt, and lifecycle-hook paths remain principal-only unless an explicit confined protocol grants a fresh channel-bound credential. Relay material must be generation-bound, delivered only through a private confined channel, excluded from persisted state and logs, and destroyed with its channel.

Routing must fail closed across HTTP, SSE, WebSocket, MCP, and private service traffic. Listener class and exact Host select a closed surface; route and policy inputs become live only through one validated immutable generation; the caller, target instance, enable generation, lease, method, path, query, body binding, expiry, and replay state must be checked where applicable. Authorization must be revalidated immediately before the upstream connection.

Browser mutations require an authenticated session with Origin and CSRF or mutation-proof validation. Administrative actions require local administrator authority. Uploaded names, workspace paths, static paths, repository names, and manifest paths must be normalized and confined before filesystem access. Content and header limits must be enforced before forwarding or persistence, and error responses must not reveal private target existence.

Cloudflare publication must be core-owned and generation-coordinated. Local-only mode must create no connector. Managed tunnel creation, ingress, DNS, token custody, ownership evidence, replacement, and teardown must remain explicit and fail closed. Connector tokens and TURN credentials must stay out of agent environments, logs, topology projections, and evidence artifacts. Public publication must not alter the two outer engine mappings.

Security telemetry may record bounded actor, selector, action, generation, and decision evidence but must redact secrets, tokens, cookies, raw provider values, request bodies that may contain credentials, and reusable channel material. Release evidence must prove loaded runtime bytes and actual repository revisions when a branch-specific deployment gate is requested.

## Conclusion

Ploinky security depends on exact workspace ownership, rootless isolation, purpose-separated credentials, atomic route generations, and strict separation among user, admin, agent, and runtime capabilities.
