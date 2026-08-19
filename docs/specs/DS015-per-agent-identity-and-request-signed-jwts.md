---
title: DS015-per-agent-identity-and-request-signed-jwts
summary: Defines identity actors, per-agent secrets, runtime tuples, request-bound token families, delegation, replay protection, and confined relay credentials.
---

# DS015 Per-Agent Identity and Request-Signed JWTs

## Introduction

Every enabled agent must have a distinct principal and runtime tuple, and every executable cross-agent authorization must describe one exact request. Ploinky uses direction-specific signed token families so a compromised agent cannot impersonate another agent, reuse a stale generation, convert an agent proof into a user session, or replay authorization against different content.

## Core Content

### Identity actors

| Actor | Identity responsibility |
| --- | --- |
| Workspace core | Derives purpose-separated keys from the workspace master, creates instance ids and enable generations, and stores only non-secret identity metadata in the registry. |
| Source agent | Holds only its eligible request secret and signs an Agent Assertion for the target and exact operation it wants the Router to mediate. |
| Router | Resolves the active source and target tuples, verifies the source assertion and optional user delegation, applies policy, consumes replay state, and mints a target-specific Router Request. |
| Target agent | Holds only its own request secret, recomputes the request-content hash from the received operation, verifies the Router Request, consumes replay state, and exposes only validated invocation metadata to its command. |
| Authenticated user | May initiate a Router-mediated tool call through a browser session. The Router converts the admitted call into a Router Request; it never forwards the raw user session to the target. |
| Delegating user | Grants separately signed, bounded consent for a declared source agent, target agent, tool, and scope. The grant adds human consent but does not replace the Agent Assertion. |
| Private-service caller | Uses the tuple-specific private agent secret for a request to Router listener `8081`, binding its principal, instance, generation, method, path, query, and body. |
| Confined relay peer | Receives a fresh generation-bound channel credential only after exact runtime, container, lease, and target verification. |

### Canonical identity

The canonical agent principal is `agent:<repo>/<agent>`. Every enabled instance must additionally have a random effective instance id and enable generation. The three values form the active tuple used by routing and private assertions. Disable and re-enable, replacement, alias-instance recreation, or another identity-changing lifecycle operation must rotate the tuple so predecessor credentials and assertions cannot act for the successor.

Credential-capable confined runtimes may receive `PLOINKY_AGENT_SECRET` only after Router authority, immutable container ownership, exact registry tuple, current preparation generation, and the generated local descriptor are attested in the same launch transaction. Private-listener callers additionally receive the tuple-derived private secret. Host, `none`, Bubblewrap, Seatbelt, and lifecycle-hook execution remain principal-only unless a dedicated confined channel explicitly grants a fresh credential.

### Token and credential families

| Family | Issuer, recipient, and proof |
| --- | --- |
| User Session | Is issued by the Router authentication service to a browser and proves a local, SSO, or guest identity within its route/session scope. It is not accepted as an Agent Assertion or Router Request. |
| Agent Assertion | Is signed by the source agent with its agent request secret, has type `agent-assertion`, targets audience `ploinky-router`, and proves one source-to-target MCP or HTTP request. |
| Private Agent Assertion | Is signed with the tuple-derived private secret, has its own type, and proves one current agent call to the private Router listener. It additionally binds effective instance and enable generation. |
| Router Request | Is minted only by the Router, has type `router-request`, is signed with the target agent's secret, and authorizes exactly one target operation after route and policy admission. |
| User Delegation Grant | Is signed by the Router's separate delegation key, has type `user-delegation`, and carries bounded user identity and consent for declared source, target, tool, and scopes. |
| Runtime capability | Authorizes one lifecycle, placement, network, or resource operation for an exact workspace generation. It is not an application JWT and cannot be sent to an agent route as caller identity. |
| Relay session/request credential | Is minted for one confined host-network relay channel and target. It is short-lived, generation-bound, single-use where required, and absent from persistent environment and routing state. |
| LiveKit, TURN, SSO, and publication token | Belongs to its named external protocol only. No request-signed JWT verifier may accept it as internal authority. |

<figure class="diagram">
<pre class="mermaid">flowchart TB
    S[Source agent signs the exact request] --> R[Router verifies the assertion and policy, then authorizes the target]
    R --> T[Target agent verifies the Router Request, executes, and returns the result]
    classDef source fill:#e3f2fd,stroke:#1565c0,color:#0d2b45,font-weight:600
    classDef mediator fill:#fff3e0,stroke:#ef6c00,color:#4a2700,font-weight:600
    classDef target fill:#e8f5e9,stroke:#2e7d32,color:#163a18,font-weight:600
    class S source
    class R mediator
    class T target</pre>
<figcaption><em>Agent-to-agent request authorization flow</em></figcaption>
</figure>

The source agent canonicalizes the operation, computes `rch`, and signs an Agent Assertion bound to the resolved target. The Router verifies the source tuple, signature, request hash, replay state, caller ACL, and HTTP or MCP policy, removes untrusted identity headers, and mints a target-bound Router Request. The target agent recomputes `rch`, verifies its own token and replay state, executes only the admitted operation, and returns the result through the Router to the source.

For a browser tool call, the Router begins with the authenticated user context and mints the same target-specific Router Request without forwarding the raw session. For delegated agent work, the source still presents its Agent Assertion and additionally presents the declared User Delegation Grant. The Router must verify both proofs independently and carry only the normalized bounded delegation into the Router Request.

### Request binding

| Bound value | Verification requirement |
| --- | --- |
| Token type, issuer, and audience | Must match the single direction and verifier for that token family. A valid signature with another type or audience fails. |
| Subject and source principal | Must equal the canonical authenticated source. An agent cannot choose another issuer or a user-form subject. |
| Target agent | Must equal the Router-resolved canonical target and its current runtime tuple where applicable. |
| Method and normalized path | Must equal the received HTTP or MCP transport operation after canonical normalization. |
| Query | Must equal the canonical query for HTTP and private requests; a token for another query cannot be reused. |
| Tool and arguments | Must equal the canonical MCP tool name and arguments used to compute the request-content hash. |
| Body hash | Must bind the exact buffered HTTP bytes for delegated HTTP and private requests. |
| `rch` request-content hash | Must be computed from the canonical method, path, query, tool, arguments, or body hash appropriate to the surface and recomputed by each verifier. |
| Instance and enable generation | Must match the active source or target tuple where the token family carries runtime identity. Stale predecessor tuples fail. |
| Issue time and expiry | Must fall inside the short accepted lifetime and bounded clock skew. Expired and implausible tokens fail. |
| Nonce or `jti` | Must be present where required and consumed by the verifier's bounded replay cache. A second use fails even when all other claims match. |
| Delegation scope | Must match the declared source, target, tool, user, and required scopes. It cannot broaden route or MCP policy. |

The Router must strip caller-supplied identity, authorization-info, forwarding, and invocation headers before attaching trusted target context. AgentServer must accept invocation metadata only after Router Request verification and must never trust an identity copied from an ordinary request header or tool argument.

Compromise of one agent's request secret must permit neither forging a Router Request for another target nor deriving the workspace master or another agent's key. Rotation of the runtime tuple must invalidate private assertions and route leases from the predecessor. Relay credentials must remain private to their exact confined channel and must be destroyed with it. Raw secrets and tokens must not appear in URLs, logs, registry records, persisted routing state, selected runtime state, or test evidence.
