---
title: DS008-auth-capabilities-and-secure-wire
summary: Defines authentication actors, human identity types, authentication routes, route requirements, administrative proof, and non-user capability boundaries.
---

# DS008 Authentication, Capabilities, and Secure Wire

## Introduction

Ploinky must identify the actor making a request before it applies route or tool policy. A human session, guest session, agent identity, delegated user grant, and runtime capability prove different facts and must never be interchangeable.

## Core Content

### Authentication actors

| Actor | Authentication role and boundary |
| --- | --- |
| Anonymous browser | May open login, callback, logged-out, and public static assets. It has no user, guest, agent, or administrative authority until the Router creates or verifies the required session. |
| Guest browser | Receives a short-lived, route-scoped guest session only when the selected HTTP policy is `guest`. It may use that admitted route but cannot administer the workspace, act as an agent, or access another guest scope. |
| CLI operator | Uses a Router-signed `user-session` with the exact `cli` channel and `local:admin` subject and user id. It is a runtime control credential, not a browser password login or an application auth setting. |
| Provider administrator | Has the provider-authenticated `admin` role. Runtime mutation additionally requires exact control Origin and Router-issued mutation proof. A chosen username or id does not grant this role. |
| SSO user | Authenticates through the manifest-selected external provider using pending state and a validated callback. The Router normalizes the resulting external identity into a server-side session. Ordinary SSO authentication does not imply administrator authority; each control requires its role or capability. |
| Source agent | Uses its own request secret to sign an Agent Assertion for one exact operation. It may claim only its canonical principal, instance, and enable generation and receives no human identity automatically. |
| Target agent | Accepts a Router Request only after recomputing the request-content hash and verifying the target-specific signature, type, audience, expiry, active tuple, and replay state. |
| Router | Terminates browser authentication, resolves route policy, verifies source assertions and delegation grants, removes untrusted identity headers, and mints the target-bound proof accepted by an agent. |
| Runtime supervisor | Uses narrowly scoped lifecycle or placement capabilities for runtime operations. Those capabilities are not HTTP sessions and cannot authorize application requests. |

### Human identity types

| Identity type | Resulting authority |
| --- | --- |
| Unauthenticated | No identity is attached. Only explicitly public or authentication-bootstrap surfaces may proceed. |
| Guest | A unique `guest:<uuid>` user with the `guest` role, bound to the selected route and optional validated guest-scope parameter. |
| CLI operator | The canonical `local:admin` identity carried by an independently verified Router signature and `cli` channel. No password or local-user database establishes this identity. |
| Provider administrator | A currently authenticated provider identity with the `admin` role for runtime controls, or the exact capability required by provider administration. |
| SSO user | An externally authenticated identity stored in the Router's bounded session store with its provider and token lifetime. Roles and capabilities are supplied by the provider and checked independently at each protected surface. |

The route-selected authentication mode is `none`, `guest`, or `sso`. Mode `none` does not invent a browser user. Mode `guest` prefers an existing valid provider session before minting a guest session. Mode `sso` requires a configured external provider and a valid callback flow. The signed CLI operator is recognized separately from these application policies.

An explicit manifest `sso enable` requirement overrides saved authentication settings and cannot be weakened by `--auth`. It cannot be combined with guest authentication. Local browser password authentication is removed: local/pwd modes, password seeding, password storage, and local-role capability mappings are unsupported. Old local browser JWTs are rejected even when their signatures are valid. No existing-account migration or fallback login is provided; unavailable SSO fails closed.

### Authentication routes

| Route | Authentication behavior |
| --- | --- |
| `GET /auth/logged-out` | Displays the signed-out result and a bounded return link. No active session is required. |
| `GET /auth/login` | Starts the configured SSO authorization flow for the host-selected authentication context. |
| `POST /auth/login` | Returns `405`; the Router does not receive or verify browser passwords. |
| `GET /auth/callback` | Validates the pending SSO state and callback response, creates the normalized external session, and redirects only to an admitted return path. |
| `GET /auth/account` | Returns `404 local_auth_disabled`; account management is provided by the identity provider. |
| `POST /auth/account` | Returns `404 local_auth_disabled`; password changes belong to the provider. |
| `GET /auth/logout` | Displays logout confirmation for the active authentication context. |
| `POST /auth/logout` | Revokes or deletes the active session, clears the cookie, and requires the browser mutation proof. |
| `GET /auth/token` | Returns bounded session metadata and the browser mutation proof. A provider administrator on the admitted control origin also receives a separately bound admin-control proof. |
| `POST /auth/token` | Performs the same authenticated token response and may refresh an SSO session after Origin and CSRF validation. |
| `/auth/local-users`, `/auth/github/*`, and `POST /auth/agent-token` | Are removed compatibility surfaces and must return `410` or `404`. User administration and agent assertions use their dedicated Router paths. |

Session cookies must be HTTP-only, use the route-appropriate lifetime, and remain bound to the authentication mode and active edge context. Guest sessions and CLI operator credentials are signed JWTs with persistent revocation support. The Router issues no local browser user session. SSO sessions remain server-side and may be refreshed only through the configured provider flow.

### Route authentication requirements

| Route or operation | Required proof |
| --- | --- |
| Login pages, SSO callback, logged-out page, and browser application assets | No established user session; each handler still validates its exact method, path, state, and safe return target. |
| An HTTP route compiled as `public` | No user session for supported safe methods. Public access must not imply anonymous mutation. |
| An HTTP route compiled as `guest` | A valid SSO session, or a Router-minted guest session bound to that exact route and guest scope. |
| An HTTP route compiled as `authenticated` | A valid SSO user session selected by the route's authentication context. A guest session is insufficient. The separately verified CLI operator may act through the runtime control channel. |
| WebChat, aggregate MCP, account data, workspace files, uploads, and blobs | A valid route-selected browser session. Every state-changing browser request additionally requires exact Origin and mutation-proof validation. |
| `/api/agents/<agent>/users` | A currently revalidated SSO session with `admin.users.manage`; the provider re-authorizes the persisted actor. Mutations require exact Origin and the applicable session-bound proof. |
| Marketplace mutation, `/policy/command`, `/status/data`, and Router control health | A provider session with the `admin` role or an independently signed CLI operator credential; mutations require exact control Origin and session-bound proof. Policy commands force current provider-session validation. |
| `/api/router/openai-agent-discovery` and private `8081` agent services | A current request-bound Agent Assertion. Browser sessions and administrator cookies are not substitutes. |
| `/<agentName>/mcp`, delegated OpenAI calls, and protected agent HTTP routes from another agent | A current Agent Assertion, exact caller ACL, route or MCP policy approval, and a Router Request minted for the resolved target. A declared user delegation grant is additionally required when human consent must cross the agent boundary. |
| AgentServer invocation, task status, task cancellation, or protected target service | A target-specific Router Request whose request-content hash matches the received method, path, query, tool, arguments, or body. |
| Host networking, confined relay creation, runtime replacement, and protected lifecycle action | A non-replayable runtime capability bound to the exact workspace, operation, resource, and generation. It never authenticates an HTTP caller. |

### Proof separation and secure forwarding

The Router must remove caller-supplied Ploinky identity and forwarding headers before it creates trusted context. A browser session proves a human identity, an admin-control proof proves local administrative use, an Agent Assertion proves one source agent operation, a delegation grant proves bounded human consent, a Router Request proves the Router admitted one target operation, and a runtime capability proves one lifecycle action. No verifier may accept a different proof family because its signature is otherwise valid.

Authentication failure must be indistinguishable from an unavailable private target wherever a detailed error would disclose protected state. Session ids, cookies, bearer tokens, CSRF values, agent secrets, assertions, Router Requests, delegation grants, and runtime capabilities must not enter logs, routing state, URLs, provider metadata, or evidence artifacts. The protocol may expose only the opaque short-lived value required by the intended recipient.

### Authentication architecture rationale

| Decision | Reason |
| --- | --- |
| Separate provider administrators, authenticated users, CLI operators, and route-scoped guests | Workspace mutation is stronger than ordinary application use, while guest access must remain limited to the route that invited it. One undifferentiated user role would over-grant at least one surface. |
| End browser sessions at the Router | Agent services need normalized, target-bound authorization rather than reusable cookies or identity-provider tokens. This confines account material to the component that owns authentication. |
| Bind sessions and mutation proofs to the selected route and active generation | A proof captured for one hostname or obsolete publication cannot authorize a different surface after routing changes. |
| Use distinct proof families for users, agents, delegated consent, Router requests, and lifecycle capabilities | Each proof answers a different authorization question. Direction and purpose separation prevent a valid signature from being reused at the wrong verifier. |
| Return generic failures for protected targets | Detailed authentication errors could reveal which private agents, routes, or workspace resources exist even when access is denied. |
