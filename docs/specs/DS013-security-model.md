---
title: DS013-security-model
summary: Defines Ploinky's trust model, principal actors, isolation boundaries, protected assets, request boundaries, and fail-closed security outcomes.
---

# DS013 Security Model

## Introduction

Ploinky protects a physical host by running repositories and agents inside a rootless managed Box, then applies a second isolation and authorization boundary around each enabled agent. The workspace operator and Ploinky core are trusted control-plane principals. Agent code, browser input, network requests, repository contents, manifests, provider output, and stale runtime state are untrusted until the responsible boundary validates them. Ploinky is not a hostile multi-tenant hosting platform.

## Core Content

### Principal actors

| Actor | Trust and responsibility |
| --- | --- |
| Workspace operator | Owns the workspace, chooses repositories and agents, supplies configuration, and performs local administration. Operator input is still validated before it becomes a path, route, runtime option, or credential. |
| Host `ploinky` process | Owns creation, validation, start, stop, and removal of the outer Box. It must resolve one exact workspace and must never adopt a foreign Box or nested agent runtime. |
| In-Box `ploinky-local` process | Owns nested agent lifecycle, dependency preparation, route generation, and Router supervision for the workspace mounted into its Box. It must never create another outer Box. |
| Router | Is the only Ploinky-owned network mediator. It selects a closed surface from listener and exact Host, authenticates the caller, applies route and MCP policy, revalidates the active generation, and forwards only admitted traffic. |
| Agent runtime | Executes repository-controlled code with only its selected mounts, environment, private network access, runtime limits, and agent-specific credentials. It is not trusted with another agent's secret or core-owned master material. |
| Browser user | Supplies untrusted paths, uploads, messages, credentials, and mutations. The Router must authenticate the session and validate Origin, mutation proof, path confinement, and content limits as applicable. |
| Source agent | May request another service only through a request-bound assertion for its current identity tuple. It cannot claim a user, administrator, another agent, or a future generation. |
| External identity or publication provider | Supplies SSO or public-edge connectivity under core-owned configuration. Its tokens and callbacks must remain scoped, validated, and separate from agent environments. |
| Container engine | Provides rootless Box and nested-runtime isolation. Engine discovery and labels are evidence, not authority; exact ids, mounts, image identity, ownership labels, and runtime state must agree. |

### Isolation and request path

<figure class="diagram">
<pre class="mermaid">flowchart TD
    A[Physical host and workspace operator] --> B[Rootless Ploinky Box]
    B --> C[Router control plane]
    C --> D[Validated route and identity boundary]
    D --> E[Isolated agent runtime]
    E --> F[Agent-owned code, data, and private services]
    C -. only admitted browser or agent request .-> E</pre>
<figcaption><em>Ploinky security boundaries</em></figcaption>
</figure>

The managed Box must run rootless and unprivileged with the expected immutable image identity, read-only Ploinky source, explicit workspace and cache binds, an init/reaper, and no privileged mode, SUID/setuid binaries, file capabilities, or relaxed confinement. The outer engine may publish only Router TCP on loopback and one LiveKit UDP mapping. Router private port `8081`, agent port `7000`, and agent-owned listeners must remain inside the Box.

Nested agents must receive a read-only source mount unless the selected profile explicitly allows development writes, a persistent per-instance home under `.data`, the validated dependency cache, and only declared workspace or data volumes. One runtime must not gain another agent's persistent home, secret, identity tuple, or undeclared host path. Host-network placement is exceptional and must use an exact current capability plus a confined relay for protected loopback traffic.

### Security boundaries

| Boundary | Required controls and protected result |
| --- | --- |
| Workspace ownership | Resolve one canonical workspace identity, acquire the workspace lock, compare immutable labels and paths, and revalidate immediately before mutation. Foreign, ambiguous, partial, or changed resources fail closed. |
| Outer Box | Verify engine, image digest, rootless/unprivileged configuration, mounts, init, and exactly two allowed publications. A mismatched Box is not repaired by adopting its state. |
| Agent runtime | Validate manifest, profile, runtime placement, image, resources, mounts, ports, identity tuple, and generation before creation. Exact ids authorize cleanup; names alone do not. |
| Filesystem | Normalize repository names, manifest paths, upload destinations, static paths, workspace-file paths, provider metadata names, and blob ids before access. Traversal, symlink escape, unresolved roots, and broad deletion are prohibited. |
| Browser session | Require the host-selected local, SSO, or guest context. Mutations require exact Origin and a session-, route-, Host-, and generation-bound proof. Administrative actions additionally require local administrator control. |
| Public Router | Select listener and exact Host before path, compile a closed surface, deny unavailable reserved namespaces, enforce limits, and revalidate the immutable route lease immediately before file read or upstream dial. |
| Agent-to-agent request | Verify source Agent Assertion, active tuple, request hash, replay state, caller ACL, and HTTP or MCP policy; then mint a target-specific Router Request. The target recomputes and verifies the same operation binding. |
| Private Router | Accept only current private Agent Assertions bound to method, path, query, body hash, principal, instance, and enable generation. Network reachability to `8081` provides no authority. |
| Secrets and keys | Root all managed secrets in `.ploinky/master-key`, derive protocol keys with separate purposes, inject only the eligible agent's request secret, and exclude master, publication, TURN, and unrelated agent credentials. |
| Edge publication | Keep Cloudflare configuration, ingress, DNS, connector token, ownership evidence, replacement, and teardown under core control and the same coordinated generation. Local-only mode creates no connector. |
| Observability | Record bounded actor, selector, action, generation, and decision evidence while redacting credentials, cookies, request bodies with secrets, raw provider values, and reusable channel material. Read-only observation must not mutate lifecycle state. |

### Protected assets and failure behavior

| Protected asset | Security requirement |
| --- | --- |
| Host filesystem and processes | Agent code must remain inside the rootless Box and its declared nested sandbox. No implicit host path, process namespace, engine socket, or privileged device may be exposed. |
| Workspace repositories and `.data` | Mutations and cleanup must target an exact resolved path and owner. Disablement and runtime replacement preserve persistent agent data unless the operator explicitly requests its removal through a separate safe operation. |
| `.ploinky/master-key` and encrypted stores | Must remain core-owned, private, purpose-separated, and absent from agent environments, logs, evidence, and provider subprocesses. |
| Agent identities and request secrets | Must be distinct per canonical agent, with private assertions additionally bound to instance and enable generation. Replacement and re-enable operations invalidate stale tuples. |
| Active routing and policy generation | Must be immutable after installation. Partial, corrupt, unreadable, stale, or superseded candidates remain inactive; dispatch cannot fall back to raw files or an older generation. |
| Browser and API data | Must obey method, size, media-type, path, rate, authentication, Origin, and mutation-proof limits before persistence or forwarding. |
| Publication and media credentials | Must remain in core. Agents receive only short-lived, allowlisted, generation-bound brokered credentials where a declared service requires them. |

Every security decision must fail before the privileged action, file read, route publication, or upstream connection when its inputs are missing, malformed, stale, ambiguous, or changed. Cleanup must be bounded to exact proven resources and must not use broad engine pruning or recursive deletion from an unresolved root. Error responses must avoid distinguishing an unauthorized private target from a missing target when that distinction would disclose workspace state.

The detailed authentication model is specified in [DS008-auth-capabilities-and-secure-wire](specsLoader.html?spec=DS008-auth-capabilities-and-secure-wire.md), secret ownership in [DS010-secrets-and-variable-resolution](specsLoader.html?spec=DS010-secrets-and-variable-resolution.md), request-signed identities in [DS015-per-agent-identity-and-request-signed-jwts](specsLoader.html?spec=DS015-per-agent-identity-and-request-signed-jwts.md), and Router policy in [DS016-router-access-control-http-route-access-and-mcp-policy](specsLoader.html?spec=DS016-router-access-control-http-route-access-and-mcp-policy.md).

### Security architecture rationale

| Decision | Reason |
| --- | --- |
| Treat agent workloads and their dependency trees as untrusted even when the operator selected them | Package-manager hooks, transitive packages, generated code, and prototype services can contain vulnerabilities. Trusting the operator's intent does not make every executed byte safe. |
| Layer rootless containers, explicit mounts, Router mediation, purpose-bound credentials, and immutable generations | No single boundary covers filesystem, network, identity, and stale-state attacks. Independent controls reduce the authority available after one layer is compromised. |
| Keep Ploinky itself inside a controlled Box boundary | The supervisor needs stable tools and runtime behavior without installing its complete dependency set on the physical host. Its authority is still limited by rootless execution and exact host grants. |
| Prefer fixed external publications and brokered capabilities | The exposed host surface is auditable and workload code receives only the narrow operation it needs, not a container-engine socket, publication credentials, or general host access. |
| Fail closed on missing, ambiguous, foreign, or stale evidence | Guessing ownership or falling back to raw configuration can turn recovery into cross-workspace mutation or revive an authorization decision from an obsolete generation. |
