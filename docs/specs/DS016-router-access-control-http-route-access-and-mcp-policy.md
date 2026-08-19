---
title: DS016-router-access-control-http-route-access-and-mcp-policy
summary: Defines fail-closed HTTP route access, MCP tool policy, caller ACL composition, coordinated administration, and immutable policy generations.
---

# DS016 Router Access Control

## Introduction

Ploinky applies separate policy domains to browser and service routes and to MCP tool execution. Both domains share coordinated state and audit infrastructure but answer different authorization questions.

## Core Content

HTTP route access has the closed values `public`, `guest`, and `authenticated`. Public access permits only the explicitly supported safe methods and must not imply anonymous mutation. Guest access accepts a valid user session or mints a bounded route-scoped guest identity. Authenticated access requires a real user session under the selected route authentication policy. Unknown, missing, malformed, or inapplicable values deny access.

MCP tool policy has the closed values `authenticated`, `internal`, and `admin`. Authenticated user execution requires a Router-mediated user context. Internal execution requires an active authenticated agent principal and any required exact caller ACL. Admin execution requires a local administrator and must not accept an agent, SSO, guest, delegation, or network-placement proof as a substitute.

Manifest routes, HTTP-service declarations, route defaults, caller ACLs, operator route entries, and MCP entries are distinct policy inputs. Operator-list commands may expose only persisted operator entries; an effective check must evaluate the same complete provider set used by dispatch and must identify the winning source without exposing secrets.

Policy mutation must occur through the Router-owned authenticated administrative command surface. Set and remove operations must inactivate affected selectors, stage the candidate, validate the complete host and pathname partition plus source health, and atomically install a new immutable route-and-policy generation before acknowledgement. Raw file edits, partial input, or matching size and timestamp do not become live policy.

HTTP, SSE, WebSocket, and MCP dispatch must use the active generation and exact lease and must revalidate immediately before dialing or executing the target. A corrupt digest, unreadable source, invalid schema, crash during apply, missing target, superseded lease, or incomplete partition leaves the affected selectors inactive. Recovery requires repairing candidate input and performing a new coordinated apply; translation, deletion, skipping, and fallback to an older generation are prohibited.

Router-owned internal paths, authentication, administration, metrics, Marketplace, bare control roots, and paths containing reserved internal agent segments must not be controlled by ordinary route policy. Audit records may preserve bounded decision evidence but must never contain tokens, cookies, secrets, or raw sensitive values.

Route access and MCP policy must remain separate, closed vocabularies compiled into one exact active generation so every transport makes the same fail-closed decision.

### Policy architecture rationale

| Decision | Reason |
| --- | --- |
| Keep HTTP route access and MCP tool policy as separate vocabularies | Route policy answers who may reach a web surface; MCP policy answers who may invoke a tool. Combining them would make transport-specific intent ambiguous. |
| Compile all policy providers into one immutable route-and-policy generation | HTTP, SSE, WebSocket, and MCP dispatch observe the same admitted snapshot instead of reading files at different times and reaching contradictory decisions. |
| Inactivate affected selectors before applying a replacement | A partially written, invalid, or crashed update cannot leave the old target reachable under policy that the operator intended to change. |
| Revalidate the exact lease immediately before dispatch | Authorization can become stale between initial routing and the upstream connection. Final generation and target checks close that race. |
| Reserve Router-owned namespaces outside ordinary route policy | An agent or operator route must not shadow authentication, administration, metrics, Marketplace, or other control-plane endpoints. |
| Never fall back to raw files or an older generation | Fallback would make corrupt or rejected configuration silently restore obsolete authority instead of failing visibly and safely. |
