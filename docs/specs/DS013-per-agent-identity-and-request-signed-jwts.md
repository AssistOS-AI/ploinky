---
id: DS013
title: Per-Agent Identity and Request-Signed JWT Families
status: implemented
owner: ploinky-team
supersedes: DS011 (partial - shared-HMAC invocation model), DS006 (partial - secure wire)
summary: Defines per-agent secret derivation and the three direction-typed HS256 JWT families (User Session, Agent Assertion, Router Request) with request-content-hash binding that replace the shared-HMAC single-key invocation model.
---

# DS013 Per-Agent Identity and Request-Signed JWT Families

## Introduction

DS011 §Security Scope and Questions #2/#5 recorded that the shared-HMAC invocation model — one `derived-master` key injected identically into every agent, one `typ:"invocation"` token family, agent identity carried only by the `aud` claim — provides no non-repudiation between agents and was the workspace's primary unresolved hardening item. This document defines the implemented replacement: a unique per-agent secret derived from the workspace master, and three direction-typed JWT families that bind every token to one concrete request. It supersedes the secure-wire portions of DS011 and DS006 where behavior differs. The trust model remains the local, operator-controlled workspace of DS011; the change is that one agent reading its own environment can no longer forge tokens for another agent.

## Core Content

### Identity Types

The model has exactly two authenticated identity types — `user` and `agent` — plus `guest` (a router-issued session without user or agent privileges). A user authenticates to the router and holds the base role `user` and, when applicable, `admin`. The legacy base role `local` is mapped to `user` on read by `normalizeRoles` in `cli/server/auth/localService.js`; user records, stored ids (`local:<username>`), and `isLocalAdminUser` are unchanged. Admin is resolved by `isLocalAdminUser` (role `admin`, username `admin`, or id `local:admin`); a guest is never admin. An agent is a Ploinky runtime process that receives a canonical id `agent:<repo>/<agent>` and one secret at startup.

### Per-Agent Secret Derivation

Each agent's signing/verification secret is derived from the workspace master key material with the agent id as domain separation:

```text
PLOINKY_AGENT_SECRET = HKDF_SHA256(ikm = master, salt = "", info = "ploinky/agent-secret/" + "agent:<repo>/<agent>" + "/v1", len = 32)
```

`deriveAgentRequestSecret(agentId, { encoding })` in `cli/services/masterKey.js` implements this by delegating to `deriveSubkey('agent-secret/' + agentId)`, keeping the workspace's single derivation story; it is router/launcher-only. It is distinct from the pre-existing `deriveAgentSecret` (which derives agent-OWNED generated secrets from the `derived-master` subkey and a per-secret name) and from `deriveDerivedMasterKey`, which remains in use only for agent-owned generated secrets (`generatedSecret`/`sharedGeneratedSecret`), never for invocation signing.

The master key never enters an agent. At startup the runtime managers inject only `PLOINKY_AGENT_ID` (the principal) and `PLOINKY_AGENT_SECRET` (hex), plus the retained compatibility var `PLOINKY_AGENT_PRINCIPAL`; the shared `PLOINKY_DERIVED_MASTER_KEY` is no longer injected. Injection sites: `cli/services/docker/agentServiceManager.js`, `cli/services/bwrap/bwrapServiceManager.js`, and `cli/services/lifecycleHooks.js` (host lifecycle hooks act as the owning agent and receive that agent's id + secret).

### The Three JWT Families

All three are JWS with HS256; the verifier fixes the algorithm and never reads it from the token. The base JWS primitives (`signHmacJwt`, `verifyJws`, `createMemoryReplayCache`) are upstream achillesAgentLib functions, re-exported through the `Agent/lib/jwtSign.mjs` and `Agent/lib/jwtVerify.mjs` shims. The request-bound verifiers `verifyRouterRequestToken` and `verifyAgentAssertionToken` live in `Agent/lib/requestSignedTokens.mjs`, not in achillesAgentLib: the whole `Agent/` tree is mounted into every agent container, whereas the container's achillesAgentLib is an independently npm-installed upstream copy, so anything an agent needs beyond the upstream primitives must live under `Agent/`. Those verifiers depend only on `verifyJws`, which the upstream copy provides, so router and agent run the identical verification.

| Family | Direction | Signed by (key) | Verified by (key) | `typ` / `aud` |
| --- | --- | --- | --- | --- |
| User Session | client → router | router (`session` subkey) | router | `user-session` / `ploinky-router` |
| Agent Assertion | source agent → router | source agent (own secret) | router (derives source secret) | `agent-assertion` / `ploinky-router` |
| Router Request | router → target agent | router (target agent's secret) | target agent (own secret) | `router-request` / `agent:<repo>/<agent>` |

**User Session** (`cli/server/auth/localService.js`): claims `typ:user-session`, `iss:ploinky-router`, `aud:ploinky-router`, `sub:<user id>`, `sid` (stable per login), `usr{id,username,name,email,roles}`, `uvar`, `rev`, `iat`, `exp` (4h), `jti`. Guest sessions are `typ:guest-session` with the same `aud` and a `gsess_<id>` `sid`. Verification (`verifySessionJwt`): signature with the `session` subkey, `aud == ploinky-router`, `typ ∈ {user-session, guest-session}`, `iss == ploinky-router`; then `getSession` checks the persistent revocation list (`sid`/`jti`) and, when a `uvar` is supplied, the `rev` binding. The raw User Session JWT terminates at the router and is never forwarded to an agent.

**Agent Assertion** (`Agent/lib/agentAssertion.mjs` signer; `verifyAgentAssertion` in `cli/server/mcp-proxy/invocationMinter.js` verifier): claims `typ:agent-assertion`, `iss == sub == agent:<repo>/<agent>`, `aud:ploinky-router`, `method`, `path`, `targetAgent`, `tool`, `rch`, `iat`, `exp` (≤60s), `jti`. The router parses `iss` UNTRUSTED, requires it to match `agent:<repo>/<agent>`, derives that agent's secret, and verifies HS256 with it — so an agent that holds only its own secret cannot forge an assertion for another agent. It then requires `typ`, `aud:ploinky-router`, `sub == iss`, `method`/`path`/`tool`/`rch` to match the actual request, `targetAgent` to match the addressed route, time validity, and `jti` single-use. Identity ≠ authorization: MCP policy (DS014) is applied after the assertion verifies.

**Router Request** (`buildRouterRequest` in `cli/server/mcp-proxy/invocationMinter.js`; `verifyRouterRequestFromHeaders` in `Agent/lib/invocationAuth.mjs`): claims `typ:router-request`, `iss:ploinky-router`, `aud:agent:<repo>/<agent>`, `sub`, `actor{kind,id,roles}`, `method`, `path`, optional `tool`, `rch`, `iat`, `exp` (≤30s), `jti`. The router signs with the TARGET agent's secret. The target agent verifies with its own `PLOINKY_AGENT_SECRET` and `PLOINKY_AGENT_ID` audience: signature, `typ:router-request`, `iss:ploinky-router`, `aud == PLOINKY_AGENT_ID`, `method`/`path`/`tool` match, recompute and match `rch`, time validity, `jti` single-use. A valid HMAC with the wrong type, audience, method, path, tool, or `rch` is not valid for execution.

### Request Content Hash (`rch`)

`rch` binds a token to one operation so it cannot be replayed against another. `Agent/lib/requestHash.mjs` is the single implementation both router and agent import; it is self-contained (only `node:crypto`) and lives under the mounted `Agent/` tree so router and agent hash identically without depending on the container's achillesAgentLib copy. Its `canonicalJson` is stricter than the one in `jwtSign.mjs`: object keys are sorted lexicographically, array order is preserved, and `undefined`, functions, symbols, bigints, and non-finite numbers throw rather than being coerced — an unambiguous hash. `rch = base64url(sha256(canonicalJson(input)))`. The HTTP canonical input is `{method, path, query, bodyHash}` (`computeRchHttp`); the MCP tool-call canonical input is `{method, path, tool, arguments}` (`computeRchTool`). For MCP the transport is always `POST /mcp`; the proxy canonicalizes `arguments` against the advertised `inputSchema` before signing the Router Request, so the signed surface equals exactly what the agent executes. The receiver recomputes `rch` and rejects any mismatch.

### Authenticated User Flow

User → router (User Session cookie) → router verifies the session, resolves the caller class, checks MCP policy (DS014), computes `rch`, and mints a Router Request signed with the target agent's secret → AgentServer verifies and executes. The raw User Session JWT is never forwarded; only the freshly minted, target-scoped Router Request reaches the agent. The same mint path serves the aggregate `/mcp`, per-agent `/<agent>/mcp`, and the scoped `__http_service__` token. For HTTP-service requests, the router computes `bodyHash` from the exact bytes it forwards upstream, includes that value in `x-ploinky-auth-info.invocationBody`, and signs `rch` with `computeRchHttp` over the rewritten upstream path the service actually receives. A token for one request body or rewritten service path is rejected for another body or path. `invocationBody.path` is the signed internal path; `invocationBody.externalPath` is router-facing route context. Downstream HTTP services use `verifyHttpServiceAuthInfoFromHeaders()` with their actual method, path, query string, and received body bytes to verify the header carrier before trusting forwarded identity. The helper uses a bounded in-memory replay cache by default, and services that run multiple instances may pass a shared replay cache.

### Agent-to-Agent Flow

Direct agent-to-agent calls are forbidden. The source agent signs an Agent Assertion with its own secret (`Agent/client/AgentMcpClient.mjs`) and posts a direct `tools/call` to the router at `/<target>/mcp` with `Authorization: Bearer <assertion>`. The router verifies the source identity and `rch`, applies MCP policy for `(source agent, target agent, tool)` — agents may invoke only `internal`-classed tools — and mints a Router Request for the target. The target AgentServer verifies and executes. The legacy `/auth/agent-token` client-credentials exchange and the shared-key `x-ploinky-caller-jwt` carrier are retired; the carrier is now `Authorization: Bearer`.

### Secret Boundaries and Injected Environment

Each agent receives only `PLOINKY_AGENT_ID` + `PLOINKY_AGENT_SECRET` (+ compatibility `PLOINKY_AGENT_PRINCIPAL`). `PLOINKY_MASTER_KEY` and `PLOINKY_DERIVED_MASTER_KEY` are never injected into an agent (asserted by `tests/unit/agentEnvInjection.test.mjs`). The agent verifier reads only `PLOINKY_AGENT_SECRET` and intentionally has no fallback to the master or a shared key. Router and agent logs must not record secrets or whole JWTs.

### Errors

| Situation | Status | Code |
| --- | --- | --- |
| Missing token / guest on an authed route | 401 | `AUTH_REQUIRED` |
| Invalid / expired / wrong-typ / wrong-aud token | 401 | `INVALID_TOKEN` / `TOKEN_EXPIRED` / `INVALID_TOKEN_TYPE` / `INVALID_AUDIENCE` |
| `rch` mismatch on an internal request | 401 | `REQUEST_HASH_MISMATCH` |
| AgentServer reached without a Router Request | 401 | `ROUTER_REQUEST_REQUIRED` |

Internal verification failures surface to clients as generic JSON-RPC errors (MCP) or 401s; precise reasons are kept server-side. Guest-facing messages never confirm a private resource exists.

## Decisions & Questions

### Question #1: Why per-agent HMAC rather than asymmetric signatures?
Response: Per-agent HMAC gives inter-agent isolation with no key-distribution or PKI cost in the local model: the router derives each agent's secret on demand from the master and injects only that agent's value. Asymmetric signatures remain the path if non-repudiation against the router itself is ever required, but the threat model here is one operator-controlled workspace where the router is the trusted issuer.

### Question #2: Why does `rch` cover method, path, and tool rather than only the body?
Response: The old `bh` covered only `{tool, arguments}`, so a token was reusable for any request with the same body shape. Binding method, path, and tool (and, for HTTP, query + body hash) ties a token to one operation, preventing a signed token from being moved across operations or surfaces.

### Question #3: Why a clean cutover with no compatibility window?
Response: Migration is a non-goal: the workspace is operator-controlled and restarts as a unit, and the old agent-to-agent path was already non-functional. The shared `derived-master` invocation mint/verify was deleted in the same change that landed per-agent signing — no `PLOINKY_SECUREWIRE_COMPAT`, no dual-stack, no legacy-token acceptance — so there is no window in which a forgeable shared key remains valid.

### Question #4: Why does an agent's own secret derive from the master while the agent never sees the master?
Response: HKDF is one-way, so the router/launcher derive and inject only the per-agent result; an agent cannot recover the master or another agent's secret from its own. This keeps a single configured root key while giving every agent an isolated, non-repudiable signing identity.

## Conclusion

Ploinky replaces the shared-HMAC invocation model with a unique per-agent secret and three direction-typed, request-bound JWT families. The result keeps the simple single-root-key operations of the local workspace model while closing the DS011 non-repudiation gap: one agent reading its own environment can no longer mint tokens for another principal, and every internal token is bound to exactly one operation.
