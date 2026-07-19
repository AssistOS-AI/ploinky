---
id: DS013
title: Per-Agent Identity and Request-Signed JWT Families
status: implemented
owner: ploinky-team
supersedes: DS011 (partial - shared-HMAC invocation model), DS006 (partial - secure wire)
summary: Defines per-agent secrets and direction-typed request-bound JWTs, including exact instance/enable-generation private assertions that never substitute for user or admin identity.
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

The master key never enters an agent. At startup the runtime managers inject only `PLOINKY_AGENT_ID` (the principal) and `PLOINKY_AGENT_SECRET` (hex), plus the retained principal alias `PLOINKY_AGENT_PRINCIPAL`; the shared `PLOINKY_DERIVED_MASTER_KEY` is no longer injected. Injection sites: `cli/services/docker/agentServiceManager.js`, `cli/services/bwrap/bwrapServiceManager.js`, and `cli/services/lifecycleHooks.js` (host lifecycle hooks act as the owning agent and receive that agent's id + secret).

### The Three JWT Families

All three are JWS with HS256; the verifier fixes the algorithm and never reads it from the token. The base JWS primitives (`signHmacJwt`, `verifyJws`, `createMemoryReplayCache`) are upstream achillesAgentLib functions, re-exported through the `Agent/lib/jwtSign.mjs` and `Agent/lib/jwtVerify.mjs` shims. The request-bound verifiers `verifyRouterRequestToken` and `verifyAgentAssertionToken` live in `Agent/lib/requestSignedTokens.mjs`, not in achillesAgentLib: the whole `Agent/` tree is mounted into every agent container, whereas the container's achillesAgentLib is an independently npm-installed upstream copy, so anything an agent needs beyond the upstream primitives must live under `Agent/`. Those verifiers depend only on `verifyJws`, which the upstream copy provides, so router and agent run the identical verification.

| Family | Direction | Signed by (key) | Verified by (key) | `typ` / `aud` |
| --- | --- | --- | --- | --- |
| User Session | client → router | router (`session` subkey) | router | `user-session` / `ploinky-router` |
| Agent Assertion | source agent → router | source agent (own secret) | router (derives source secret) | `agent-assertion` / `ploinky-router` |
| Router Request | router → target agent | router (target agent's secret) | target agent (own secret) | `router-request` / `agent:<repo>/<agent>` |

**User Session** (`cli/server/auth/localService.js`): claims `typ:user-session`, `iss:ploinky-router`, `aud:ploinky-router`, `sub:<user id>`, `sid` (stable per login), `usr{id,username,name,email,roles}`, `uvar`, `rev`, `iat`, `exp` (4h), `jti`. Guest sessions are `typ:guest-session` with the same `aud` and a `gsess_<id>` `sid`. Verification (`verifySessionJwt`): signature with the `session` subkey, `aud == ploinky-router`, `typ ∈ {user-session, guest-session}`, `iss == ploinky-router`; then `getSession` checks the persistent revocation list (`sid`/`jti`) and, when a `uvar` is supplied, the `rev` binding. The raw User Session JWT terminates at the router and is never forwarded to an agent.

**Agent Assertion** (`Agent/lib/agentAssertion.mjs` signer; `verifyAgentAssertion` in `cli/server/mcp-proxy/invocationMinter.js` verifier): claims `typ:agent-assertion`, `iss == sub == agent:<repo>/<agent>`, `aud:ploinky-router`, `method`, `path`, `targetAgent`, `tool`, `rch`, `iat`, `exp` (≤60s), `jti`. The router parses `iss` UNTRUSTED, requires it to match `agent:<repo>/<agent>`, derives that agent's secret, and verifies HS256 with it — so an agent that holds only its own secret cannot forge an assertion for another agent. It then requires `typ`, `aud:ploinky-router`, `sub == iss`, `method`/`path`/`tool`/`rch` to match the actual request, `targetAgent` to match the addressed route, time validity, and `jti` single-use. Identity ≠ authorization: MCP policy (DS014) is applied after the assertion verifies.

Private HTTP-service assertions are a distinct private-Router assertion variant
with their own `typ`, audience, header, and per-instance/per-enable-generation
derived secret. Their authoritative identity tuple is the canonical
`agent:<repo>/<agent>` id, the exact effective runtime instance id, and the
current enable generation. The route key or alias selects the enabled record and
service ACL but never substitutes for any tuple member. The common prelaunch
batch assigns and activates this tuple before process creation; runtime launch
must preserve it exactly. Re-enable, replacement, or rebinding assigns a new
tuple, so a stable per-agent secret or stale route alias is insufficient for a
private call. Assertions bind the exact effective instance id and current enable
generation, method, canonical path, query, body hash, target service, expiry,
and replay id. Verification on listener `8081` requires the compiled service
policy to admit `authenticated`, the caller ACL to name that exact current
instance/generation, and the route-and-policy authorization-generation lease to
remain current immediately before dial. Omitted or wildcard identity, a
re-enabled/stale generation, replay, wrong type/audience/path/method/body, or
presentation on the public listener fails. The assertion header is stripped
before upstream connection creation. A private assertion is not a User Session,
User Delegation Grant, Router Request, LiveKit JWT, or admin credential and never
mints a user/guest identity.

**Router Request** (`buildRouterRequest` in `cli/server/mcp-proxy/invocationMinter.js`; `verifyRouterRequestFromHeaders` in `Agent/lib/invocationAuth.mjs`): claims `typ:router-request`, `iss:ploinky-router`, `aud:agent:<repo>/<agent>`, `sub`, `actor{kind,id,roles}`, `method`, `path`, optional `tool`, `rch`, `iat`, `exp` (≤30s), `jti`, optional singular `delegation`, and optional plural `delegations`. The singular `delegation` claim describes the delegation this request is running under after the router has verified a User Delegation Grant. The plural `delegations` claim carries router-minted downstream grants that the target agent may present back to the router later. These two claims are intentionally independent and must not be normalized into each other. The router signs with the TARGET agent's secret. The target agent verifies with its own `PLOINKY_AGENT_SECRET` and `PLOINKY_AGENT_ID` audience: signature, `typ:router-request`, `iss:ploinky-router`, `aud == PLOINKY_AGENT_ID`, `method`/`path`/`tool` match, recompute and match `rch`, time validity, `jti` single-use. A valid HMAC with the wrong type, audience, method, path, tool, or `rch` is not valid for execution.

### Router-Issued User Delegation Grant

Some authenticated HTTP-service routes and user-initiated MCP tools need the router to preserve the authenticated acting user across a subsequent agent-to-agent tool call. For those flows the router mints a fourth token type for router verification only: a compact HS256 User Delegation Grant with `typ:user-delegation`, `iss:ploinky-router`, `aud:ploinky-router`, `sub:<user id>`, `usr{...}`, `sourceAgentId`, `allowedTargets`, `allowedTools`, `scope`, `iat`, `exp`, and `jti`. The grant is signed with a router-held delegation subkey and is never verified by target agents. A source HTTP service receives it only through verified `x-ploinky-auth-info` on an `httpServices` declaration with `access: "authenticated"`; public and guest services cannot receive delegation grants. A source MCP tool receives it only in the target-audience Router Request's plural `delegations` claim, after the router has verified the user's session, checked MCP policy for the user call, read the source tool's `mcp-config.json` delegation entries, and minted entries for a non-guest user. The source agent may present the grant back to the router together with its own Agent Assertion. HTTP-service manifest delegation entries may additionally declare a `when` condition with a `queryParam` and `pathRoots`; the router evaluates that condition against the authenticated HTTP-service request before minting, so a route can limit grants to a boundary-aware request path such as `/Confidential`. MCP delegation entries are tool-scoped by the source tool name and declare explicit target agent, target tools, scopes, key, and TTL in `mcp-config.json`. The router verifies the Agent Assertion first, then verifies that the grant's source agent, target agent, tool, scope, and expiry all match the live call before minting the target-audience Router Request with the original acting user in `usr`. A User Delegation Grant is a short-lived scoped lease for the authenticated service session or MCP tool execution, not a per-call replay token; per-call replay protection remains on Agent Assertions and Router Requests.

The grant is reusable within its TTL: `verifyUserDelegationGrant` performs no per-`jti` replay check. A grant that leaks (for example via a log line) is therefore replayable by any holder for the scoped `{source, target, tool, scope}` as the original user until `exp`. Mitigations: grants are minted only inside verified `x-ploinky-auth-info` for authenticated HTTP-service routes whose delegation `when` condition matches or inside verified user-originated MCP calls with configured source-tool delegations, are never returned to the browser, and MUST NOT be logged in whole or part by router or agent. The ceiling on HTTP-service leases is `PLOINKY_USER_DELEGATION_MAX_TTL_SECONDS` (default 28800, range 30..86400); raising it widens the leak window proportionally, and the 28800-second default intentionally matches the current OnlyOffice workspace editing window. MCP tool delegations use their configured `ttlSeconds`, which is still capped by `PLOINKY_USER_DELEGATION_MAX_TTL_SECONDS`; short-lived secret operations such as GitHub token storage should use a narrow value such as 120 seconds because their scopes are operation-scoped, not key-scoped.

### Request Content Hash (`rch`)

`rch` binds a token to one operation so it cannot be replayed against another. `Agent/lib/requestHash.mjs` is the single implementation both router and agent import; it is self-contained (only `node:crypto`) and lives under the mounted `Agent/` tree so router and agent hash identically without depending on the container's achillesAgentLib copy. Its `canonicalJson` is stricter than the one in `jwtSign.mjs`: object keys are sorted lexicographically, array order is preserved, and `undefined`, functions, symbols, bigints, and non-finite numbers throw rather than being coerced — an unambiguous hash. `rch = base64url(sha256(canonicalJson(input)))`. The HTTP canonical input is `{method, path, query, bodyHash}` (`computeRchHttp`); the MCP tool-call canonical input is `{method, path, tool, arguments}` (`computeRchTool`). For MCP the transport is always `POST /mcp`; the proxy canonicalizes `arguments` against the advertised `inputSchema` before signing the Router Request, so the signed surface equals exactly what the agent executes. The receiver recomputes `rch` and rejects any mismatch.

### Authenticated User Flow

User → router (User Session cookie) → router verifies the session, resolves the caller class, checks MCP policy (DS014), computes `rch`, and mints a Router Request signed with the target agent's secret → AgentServer verifies and executes. The raw User Session JWT is never forwarded; only the freshly minted, target-scoped Router Request reaches the agent. The same mint path serves the aggregate `/mcp`, per-agent `/<agent>/mcp`, and the scoped `__http_service__` token. For user-originated MCP calls, the same mint path may also attach plural `delegations` for configured tool delegations in the source agent's `mcp-config.json`; guests and agent-originated calls do not receive those downstream grants. For HTTP-service requests, the router computes `bodyHash` from the exact bytes it forwards upstream, includes that value in `x-ploinky-auth-info.invocationBody`, and signs `rch` with `computeRchHttp` over the rewritten upstream path the service actually receives. A token for one request body or rewritten service path is rejected for another body or path. `invocationBody.path` is the signed internal path; `invocationBody.externalPath` is router-facing route context. Downstream HTTP services use `verifyHttpServiceAuthInfoFromHeaders()` with their actual method, path, query string, and received body bytes to verify the header carrier before trusting forwarded identity. The helper uses a bounded in-memory replay cache by default, and services that run multiple instances may pass a shared replay cache.

### Agent-to-Agent Flow

Direct agent-to-agent calls are forbidden. The source agent signs an Agent Assertion with its own secret (`Agent/client/AgentMcpClient.mjs`) and posts a direct `tools/call` to the router at `/<target>/mcp` with `Authorization: Bearer <assertion>`. The router verifies the source identity and `rch`, applies MCP policy for `(source agent, target agent, tool)` — agents may invoke only `internal`-classed tools — and mints a Router Request for the target. The same assertion pattern is used for async MCP task polling: the source signs `GET /task` or `GET /getTaskStatus` with pseudo-tool `__task_status__` and `{ taskId }`, and the router mints a matching target-scoped Router Request before proxying the status read. The target AgentServer verifies and executes. The legacy `/auth/agent-token` client-credentials exchange and the shared-key `x-ploinky-caller-jwt` carrier are retired; the carrier is now `Authorization: Bearer`.

`AgentMcpClient` exposes separate blocking and non-blocking tool-call methods. `callTool` waits for AgentServer task metadata to reach a terminal state and may report intermediate status through `onTaskUpdate`; it never applies the process-local task observer. `callToolWithoutWait` returns the initial task response without client-owned polling and offers that task to the process-local observer, which may claim it and attach background-task metadata while retaining a router-mediated status callback. If no observer claims the task, the initial response is returned unchanged. The observer does not alter assertion signing, policy evaluation, target identity, or task-status request binding.

### Secret Boundaries and Injected Environment

Every agent container receives the following reserved environment variables from the Ploinky launcher. Manifest-declared values with these names are stripped before injection:

| Variable | Description |
| --- | --- |
| `PLOINKY_AGENT_ID` | Canonical agent principal: `agent:<repo>/<agentName>` |
| `PLOINKY_AGENT_PRINCIPAL` | Alias for `PLOINKY_AGENT_ID` |
| `PLOINKY_AGENT_SECRET` | Per-agent HMAC signing secret (hex) derived from master via HKDF |
| `PLOINKY_AGENT_INSTANCE_ID` | Exact effective runtime instance bound into private Router assertions |
| `PLOINKY_AGENT_ENABLE_GENERATION` | Exact enable generation bound into private Router assertions and caller ACLs |
| `PLOINKY_AGENT_PRIVATE_SECRET` | 32-byte hex assertion secret derived for this exact agent/instance/enable-generation tuple |
| `PLOINKY_AGENT_API_KEY` | Signed-subject identity key: `<subjectId>|<base64url-ed25519-sig>` |
| `PLOINKY_AGENT_API_PUBLIC_KEY` | Ed25519 public key for verifying signed-subject identity keys |
| `PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_KEY` | Always `generated` (provenance marker) |
| `PLOINKY_ENV_SOURCE_PLOINKY_AGENT_API_PUBLIC_KEY` | Always `generated` (provenance marker) |

`PLOINKY_MASTER_KEY` and `PLOINKY_DERIVED_MASTER_KEY` are never injected into an agent (asserted by `tests/unit/agentEnvInjection.test.mjs`). Ordinary Agent Assertions and Router Requests use only `PLOINKY_AGENT_SECRET`; private service calls use only the exact tuple's `PLOINKY_AGENT_PRIVATE_SECRET`. Neither path falls back to the master, the other assertion secret, or a shared key. Router and agent logs must not record secrets or whole JWTs.

This injection contract is identical for container, bwrap, and Seatbelt
runtimes. Identity construction is mandatory and fail-closed. Container labels
and sandbox PID records persist the exact instance/enable-generation tuple so a
name or mutable registry entry cannot reuse credentials for an older process.

This remains true even for delegated-user flows. Agents do not receive the router's session key or delegation-signing key and cannot mint User Delegation Grants themselves; they still receive only their own per-agent secret.

### Router Discovery Endpoint and Delegated OpenAI Route

**Discovery endpoint:** `GET /api/router/openai-agent-discovery` is an agent-only endpoint. To call it, an agent signs an HTTP Agent Assertion bound to the request surface with `computeRchHttp()` (NOT `computeRchTool()`), declaring tool `__openai_agent_discovery__`, target `ploinky-router`, and a single-use `jti`. The router returns:

```json
{
  "complete": true,
  "agents": [
    {
      "subjectId": "agent:<repo>/<agent>",
      "routeKey": "...",
      "repo": "...",
      "agent": "...",
      "name": "...",
      "routerPath": "/<routeKey>",
      "chatCompletionsPath": "/<routeKey>/v1/chat/completions",
      "supportsStreaming": false,
      "usesDefaultOpenAiResponder": true,
      "manifest": {}
    }
  ]
}
```

No container-internal `127.0.0.1` URLs appear in the response; all paths are router-relative.

**Delegated OpenAI route:** Agent-to-agent calls to `POST /<routeKey>/v1/chat/completions` are router-mediated. The source agent presents a delegated HTTP Agent Assertion (bound via `computeRchHttp()` over the buffered body). The router verifies the assertion, strips `x-ploinky-auth-info`, mints a Router Request token bound to the exact body, and proxies to the target AgentServer. The target verifies the Router Request before running its `/v1/chat/completions` handler.

**Delegated OpenAI models route:** Agent-to-agent model catalog reads use `GET /<routeKey>/v1/models`. The source agent signs an HTTP Agent Assertion for method `GET`, path `/v1/models`, empty query, empty body hash, tool `__openai_models__`, and target equal to the addressed route key. The router verifies the assertion, strips caller-supplied `x-ploinky-auth-info`, mints a Router Request token for the target agent with the same `rch`, and proxies to the target AgentServer. The target verifies the Router Request before running its `/v1/models` handler. `endpoints.models` is the manifest hook for custom model catalogs; without it, AgentServer returns one fallback `default` model.

**Default AgentServer OpenAI responder:** Every agent answers `POST /v1/chat/completions`. When a manifest has no `endpoints.chatCompletions`, AgentServer uses a DEFAULT capability/listability responder: it describes the agent and its MCP tools in an OpenAI-compatible message, does NOT invoke tools, and rejects `stream: true`. Manifest `endpoints.chatCompletions` is the only way to provide real chat behavior; it replaces the default responder for that agent.

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

### Question #3: Why a clean cutover with no dual-stack window?
Response: Migration is a non-goal: the workspace is operator-controlled and restarts as a unit, and the old agent-to-agent path was already non-functional. The shared `derived-master` invocation mint/verify was deleted in the same change that landed per-agent signing, with no dual-stack and no old-token acceptance, so there is no window in which a forgeable shared key remains valid.

### Question #4: Why does an agent's own secret derive from the master while the agent never sees the master?
Response: HKDF is one-way, so the router/launcher derive and inject only the per-agent result; an agent cannot recover the master or another agent's secret from its own. This keeps a single configured root key while giving every agent an isolated, non-repudiable signing identity.

### Question #5: Why was the service-specific credential alias removed?
Response: Decision 2026-06-24: the signed-subject API credential is router-owned subject identity material, not a service-specific credential. Agents receive `PLOINKY_AGENT_API_KEY` and `PLOINKY_AGENT_API_PUBLIC_KEY` only; the temporary explicit-override bridge is removed. The identity signing keypair name changed with this hard cut, so first router start after the change creates a new identity signing keypair and a coordinated restart is required for consumers to receive the matching public key.

### Question #6: Why is a private assertion not a user or administrator credential?
Response: The assertion proves that one exact effective instance at one enable
generation originated one request-bound service call. It carries no human
identity, consent, or administrative role, so treating it as a session would let
an agent convert launch capability into browser or control-plane authority. The
private listener therefore verifies the separately derived tuple secret and
composes the assertion with authenticated service policy plus an exact caller
ACL without minting a user or guest. Re-enable rotates both the tuple and its
secret, making a previously valid runtime unable to call as its replacement.

### Question #7: Why bind launcher ownership records as well as assertion claims?

Response:
A correctly signed assertion is current only if the process holding its derived
secret is the process selected by the immutable generation. Engine labels or a
sandbox PID/start-identity record bind that physical launch to the same tuple;
without that independent evidence, mutable state or name reuse could make an
older runtime appear current.

## Conclusion

Ploinky replaces the shared-HMAC invocation model with a unique per-agent secret and three direction-typed, request-bound JWT families. The result keeps the simple single-root-key operations of the local workspace model while closing the DS011 non-repudiation gap: one agent reading its own environment can no longer mint tokens for another principal, and every internal token is bound to exactly one operation.
