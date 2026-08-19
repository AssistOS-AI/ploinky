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
| Local user | Authenticates against the encrypted local user store selected by the route. Its signed session carries the user id, username, roles, store revision, and session id and is rejected after expiry, revocation, or a relevant user-store change. |
| Local administrator | Is a local user with the canonical `admin` role or local administrator identity. Administrative control additionally requires an exact local control origin and the Router-issued mutation proof; the role alone is insufficient for a forwarded or remote request. |
| SSO user | Authenticates through the manifest-selected external provider using pending state and a validated callback. The Router normalizes the resulting external identity into a server-side session. An SSO session is not local administrative authority. |
| Source agent | Uses its own request secret to sign an Agent Assertion for one exact operation. It may claim only its canonical principal, instance, and enable generation and receives no human identity automatically. |
| Target agent | Accepts a Router Request only after recomputing the request-content hash and verifying the target-specific signature, type, audience, expiry, active tuple, and replay state. |
| Router | Terminates browser authentication, resolves route policy, verifies source assertions and delegation grants, removes untrusted identity headers, and mints the target-bound proof accepted by an agent. |
| Runtime supervisor | Uses narrowly scoped lifecycle or placement capabilities for runtime operations. Those capabilities are not HTTP sessions and cannot authorize application requests. |

### Human identity types

| Identity type | Resulting authority |
| --- | --- |
| Unauthenticated | No identity is attached. Only explicitly public or authentication-bootstrap surfaces may proceed. |
| Guest | A unique `guest:<uuid>` user with the `guest` role, bound to the selected route and optional validated guest-scope parameter. |
| Local user | A `local:<username>` identity with normalized roles from the route's encrypted local-user variable. The base role is `user`. |
| Local administrator | A local identity whose normalized roles include `admin`, or the canonical `local:admin` identity. It may request admin control only from the admitted local control origin. |
| SSO user | An externally authenticated identity stored in the Router's bounded session store with its provider and token lifetime. Provider roles do not become local administrator authority. |

The route-selected authentication mode is `none`, `guest`, `local`, or `sso`. Mode `none` does not invent a user, although an already valid local session may still be recognized where the route permits it. Mode `guest` prefers an existing valid local or SSO user session before minting a guest session. Mode `local` uses the configured encrypted user store. Mode `sso` requires a configured external provider and a valid callback flow.

### Authentication routes

| Route | Authentication behavior |
| --- | --- |
| `GET /auth/logged-out` | Displays the signed-out result and a bounded return link. No active session is required. |
| `GET /auth/login` | Displays local login or starts the configured SSO authorization flow for the host-selected authentication context. |
| `POST /auth/login` | Verifies local credentials, creates the signed local session, binds it to the selected route and active edge generation, and sets the secure session cookie. |
| `GET /auth/callback` | Validates the pending SSO state and callback response, creates the normalized external session, and redirects only to an admitted return path. |
| `GET /auth/account` | Displays the authenticated local or external account. External accounts are read-only on this surface. |
| `POST /auth/account` | Lets a local user change their own username or password after session, Origin, and mutation-proof validation. |
| `GET /auth/logout` | Displays logout confirmation for the active authentication context. |
| `POST /auth/logout` | Revokes or deletes the active session, clears the cookie, and requires the browser mutation proof. |
| `GET /auth/token` | Returns bounded session metadata and the browser mutation proof. A qualifying local administrator on the local control origin also receives a separately bound admin-control proof. |
| `POST /auth/token` | Performs the same authenticated token response and may refresh an SSO session after Origin and CSRF validation. |
| `/auth/local-users`, `/auth/github/*`, and `POST /auth/agent-token` | Are removed compatibility surfaces and must return `410` or `404`. User administration and agent assertions use their dedicated Router paths. |

Session cookies must be HTTP-only, use the route-appropriate lifetime, and remain bound to the authentication mode and active edge context. Local and guest sessions are signed JWTs with persistent revocation support. SSO sessions remain server-side and may be refreshed only through the configured provider flow.

### Route authentication requirements

| Route or operation | Required proof |
| --- | --- |
| Login pages, SSO callback, logged-out page, and browser application assets | No established user session; each handler still validates its exact method, path, state, and safe return target. |
| An HTTP route compiled as `public` | No user session for supported safe methods. Public access must not imply anonymous mutation. |
| An HTTP route compiled as `guest` | A valid local or SSO session, or a Router-minted guest session bound to that exact route and guest scope. |
| An HTTP route compiled as `authenticated` | A valid local or SSO user session selected by the route's authentication context. A guest session is insufficient. |
| WebChat, aggregate MCP, account data, workspace files, uploads, and blobs | A valid route-selected browser session. Every state-changing browser request additionally requires exact Origin and mutation-proof validation. |
| `/api/agents/*`, Marketplace mutation, `/policy/command`, `/status/data`, and Router control health | A local administrator session plus local admin-control proof; mutations also require the exact browser mutation proof. |
| `/api/router/openai-agent-discovery` and private `8081` agent services | A current request-bound Agent Assertion. Browser sessions and administrator cookies are not substitutes. |
| `/<agentName>/mcp`, delegated OpenAI calls, and protected agent HTTP routes from another agent | A current Agent Assertion, exact caller ACL, route or MCP policy approval, and a Router Request minted for the resolved target. A declared user delegation grant is additionally required when human consent must cross the agent boundary. |
| AgentServer invocation, task status, task cancellation, or protected target service | A target-specific Router Request whose request-content hash matches the received method, path, query, tool, arguments, or body. |
| Host networking, confined relay creation, runtime replacement, and protected lifecycle action | A non-replayable runtime capability bound to the exact workspace, operation, resource, and generation. It never authenticates an HTTP caller. |

### Proof separation and secure forwarding

The Router must remove caller-supplied Ploinky identity and forwarding headers before it creates trusted context. A browser session proves a human identity, an admin-control proof proves local administrative use, an Agent Assertion proves one source agent operation, a delegation grant proves bounded human consent, a Router Request proves the Router admitted one target operation, and a runtime capability proves one lifecycle action. No verifier may accept a different proof family because its signature is otherwise valid.

Authentication failure must be indistinguishable from an unavailable private target wherever a detailed error would disclose protected state. Session ids, cookies, bearer tokens, CSRF values, agent secrets, assertions, Router Requests, delegation grants, and runtime capabilities must not enter logs, routing state, URLs, provider metadata, or evidence artifacts. The protocol may expose only the opaque short-lived value required by the intended recipient.
