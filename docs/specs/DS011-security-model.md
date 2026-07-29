---
id: DS011
title: Security Model
status: implemented
owner: ploinky-team
supersedes: DS006 (partial - auth wire protocol)
summary: Defines Ploinky trust boundaries for Cloudflare edge publication, closed Router surfaces, immutable generations, private service assertions, topology, TURN custody, and runtime isolation.
---

# DS011 Security Model

## Introduction

Ploinky is a workspace-local runtime. Its security model is designed for a single operator or a trusted team running agents on a controlled host, not for hostile multi-tenant execution or arbitrary third-party agent hosting. The router, workspace state, runtime backends, and enabled agents form one local trust domain.

This document is the system-level security contract. DS006 defines the older authentication and provider-selection framing, including the secure-wire design that this specification supersedes where current behavior differs. This document combines the current branch behavior across storage, authentication, routing, agent invocation, sandboxing, static file serving, uploads, and operational gaps. This document is the current authority: workspace master key material is resolved from `PLOINKY_MASTER_KEY`, a walked-up `.env`, or Ploinky's generated fallback seed, and every per-purpose secret is derived from that material through HKDF-SHA256 with a domain-separated `info` label rather than being a copy of the master or a random persistent value. Per DS013, each agent now receives only its own `PLOINKY_AGENT_ID` + `PLOINKY_AGENT_SECRET` for request signing; the `derived-master` subkey (formerly injected as `PLOINKY_DERIVED_MASTER_KEY`) is retained only as the root for agent-owned generated secrets.

## Core Content

### Security Scope and Trust Assumptions

Ploinky must treat the operator account, the local host, `PLOINKY_MASTER_KEY`, the generated fallback seed at `.ploinky/master-key`, and the `.ploinky/` workspace directory as high-trust assets. Anyone who can read the resolved master seed can derive every per-purpose subkey and therefore can decrypt encrypted workspace stores, mint local session JWTs, and sign Router Request JWTs for any agent. The derivation hierarchy means an attacker who only obtains a single subkey (for example one agent's own `PLOINKY_AGENT_SECRET` from inside that agent process) can forge tokens for that one purpose but cannot reverse the HKDF to recover the master or compromise the other purposes. Anyone who can write critical `.ploinky/` files can alter enabled agents, routing, profiles, stored secrets, generated fallback key material, or user records.

The router is the trust broker for browser users and agent-to-agent calls. Browser surfaces and MCP calls should pass through the router so that route auth, session handling, Router Request minting, and audit hooks apply. Agent ports must be considered implementation details even when they listen on localhost. Direct access to an agent port may expose tool and resource metadata, because MCP initialization and listing do not require a Router Request token, while executable tool calls, resource reads, and task-status reads do require a valid router-minted Router Request JWT (`typ:"router-request"`, DS013).

Some authenticated HTTP-service flows also require the router to carry the verified acting user across a re-entrant agent-to-agent call. In those cases the router mints a short-lived User Delegation Grant, scoped to one source agent, one target agent, an explicit tool set, and explicit scopes, and includes it only inside verified `x-ploinky-auth-info` payloads for the authenticated service route. The source agent may present that grant back to the router together with its own per-call Agent Assertion; the router verifies the grant and its source/target/tool/scope/expiry bounds before minting the target-audience Router Request with the original acting user in signed `usr` claims. The delegation grant is therefore router-issued and router-verified, not a bearer credential agents can mint or trust on their own; within its TTL it may be reused for the scoped calls of the authenticated service session, while Agent Assertions and Router Requests remain single-use through their own `jti` replay checks.

Agents are isolated from the host by containers, bubblewrap, or macOS Seatbelt. As of the per-agent identity model (DS013), each agent receives only its own canonical id `PLOINKY_AGENT_ID` and its own derived secret `PLOINKY_AGENT_SECRET`; the shared `PLOINKY_DERIVED_MASTER_KEY` is no longer injected for invocation signing. Code running inside an agent process that can read its environment can therefore forge tokens only for that agent (its own secret) — not for another agent, because it does not hold another agent's secret — and it still cannot decrypt the workspace stores or mint session JWTs, which use distinct derived subkeys the agent never sees. This restores non-repudiation between enabled agents within the single-workspace, operator-controlled trust model. The `derived-master` subkey is retained only as the root for agent-OWNED generated secrets (`generatedSecret`/`sharedGeneratedSecret`), not for request authorization. See DS013 for per-agent secret derivation and the three request-signed JWT families that replace the shared-HMAC invocation model.

The Router public/control listener binds inside the box, and reachability alone
is never authorization. Inside a marked Box the private listener binds the Box
namespace wildcard so nested rootless Podman can reach it through the exact
`host.containers.internal:host-gateway` transport mapping. Outside a marked Box,
the listener uses exact loopback/managed addresses. The outer engine publishes
only public/control `8080` to the physical host's selected loopback port;
private `8081` is not an outer mapping. Host-mode callers require an exact
current-generation capability before launch and use box loopback, but
capability grants network placement only; it does not authorize a request.
Public HTTP reaches `8080` only through
the supervised outbound Cloudflare tunnel. Listener/interface class and exact
Host select a closed route surface before pathname dispatch, and every control
or private request must still satisfy its application credentials and policy.
The Box-only wildcard bind resolves rootless Podman host-gateway transport while
the absence of an outer `8081` publication and the exact private assertion
contract preserve the physical-host and authorization boundaries documented in
DS004 Question #8.

### Workspace Key and Encrypted Storage

The workspace master seed is the root cryptographic secret. It is consumed as 256 bits of key material. `cli/services/masterKey.js` treats any non-empty trimmed configured value as an operator-supplied seed and hashes it to 32 bytes with SHA-256; the resulting digest is the master key bytes. The seed's effective entropy is therefore bounded by the entropy of the chosen string — operators wanting full 256-bit strength should use a 64-hex-character (or otherwise high-entropy) random string. Resolution checks `process.env.PLOINKY_MASTER_KEY` first, then the nearest `.env` walked upward from the current working directory, and then a persistent generated fallback seed at `.ploinky/master-key`. The fallback is created on first use with `0600` permissions so fresh local workspaces can start agents without crashing when no operator key has been configured. Trust implication: anyone who can read the resolved `.env` file or `.ploinky/master-key` can decrypt every encrypted store that uses that seed; the file permissions therefore inherit the same trust level as `PLOINKY_MASTER_KEY` itself. If Ploinky cannot persist `.ploinky/master-key`, it logs the condition and uses a built-in last-resort seed only to keep startup from crashing; operators should replace that path with an explicit `PLOINKY_MASTER_KEY` or writable `.ploinky/` fallback before relying on encrypted local state.

The master key bytes must never be used as a cryptographic key directly. Every per-purpose secret in Ploinky is derived from the master through `deriveSubkey(purpose)` in `cli/services/masterKey.js`, which applies HKDF-SHA256 with an empty salt and a domain-separated `info` of `ploinky/<purpose>/v1`. The current purposes are:

- `agent-secret/<agentId>` — per-agent request-signing secret. `deriveAgentRequestSecret(agentId)` derives each agent's `PLOINKY_AGENT_SECRET` (DS013); the router signs Router Requests with the target agent's value and derives a source agent's value to verify its Agent Assertion. Router/launcher-only; only the per-agent result is injected.
- `private-agent-secret/<agentId>/<instanceId>/<enableGeneration>` — exact runtime-generation request-signing secret for private Router assertions. The launcher injects only that one derived value into the matching runtime; the router derives it again for verification.
- `router-admin-csrf` — session-and-Origin-bound proof used for local control mutations. Router-only; never a user or agent credential.
- `router-rate-source` — Router-only HMAC key for opaque, route-scoped guest-ingestion source partitions. The input is the canonical Cloudflare connector source address for an active public hostname or the observed TCP peer for a local alias; the raw address, session id, and user identity are never forwarded.
- `derived-master` — root for agent-OWNED generated secrets only. `deriveAgentSecret()` derives Ploinky-owned and agent-owned generated secrets from it with labels for repo, agent, and secret name. It is no longer used for request authorization and is no longer injected as `PLOINKY_DERIVED_MASTER_KEY`.
- `session` — HS256 signing/verification key for local session JWTs (`ploinky_jwt` cookie). Router-only; never injected anywhere.
- `storage/secrets` — AES-256-GCM key for `.ploinky/.secrets`.
- `storage/passwords` — AES-256-GCM key for `.ploinky/passwords.enc`.

Adding a new persistent secret requires picking a fresh purpose label rather than reusing an existing subkey or the master directly. Domain separation through `info` ensures that bumping one purpose's version segment cannot collide with another.

Agent-owned generated secrets must derive from `PLOINKY_DERIVED_MASTER_KEY`, not from `PLOINKY_MASTER_KEY` and not from random persistent storage. Manifests declare ordinary per-agent generated secrets with `generatedSecret: true`; this derives from a domain-separated label containing the current repo name, current agent name, and env name. Runtime resources use `{{generatedSecret:NAME}}` for the same per-agent behavior. Cross-agent service credentials that must be identical, such as a shared media-service API key, must use `sharedGeneratedSecret: true` so the value derives from the source env name rather than a custom logical repo/agent/name tuple. Shared generated credentials are still explicit manifest choices and should be reserved for credentials that truly must be shared. A generated env entry may set `explicitOverride: true` when an operator-provided external credential is allowed to replace the generated value, or `explicitOverrideRequires` when that external credential must travel together with companion topology. Runtime managers expose only the source class, `PLOINKY_ENV_SOURCE_<ENV_NAME>=generated|explicit`, not the secret material itself. External provider credentials and operator-supplied API keys remain explicitly configured because their values originate outside the workspace.

Startup config-provider subprocesses are host-side helper commands, not trusted
runtime key holders. After manifest env resolution, Ploinky strips the complete
shared reserved-agent environment set: workspace master material, TURN and
Cloudflare credentials, all `PLOINKY_AGENT_*` identity, instance, generation,
and signing values, plus their generated-provenance markers. It then validates
provider stdout before writing accepted values itself. Providers therefore
cannot decrypt workspace stores, mint Router credentials, or inherit box-edge
credentials. Provider output is also rejected when it targets reserved Ploinky
names or generated/shared-generated secret names owned by the dependency graph.

`.ploinky/.secrets` must be stored as an AES-256-GCM JSON envelope through `cli/services/encryptedSecretsFile.js`, encrypted with the `storage/secrets` subkey. Legacy plaintext key-value files are migrated into the encrypted envelope on first read. The envelope encrypts both variable names and values inside the ciphertext payload. Writes use a temporary file and rename, and the implementation attempts to set mode `0600`.

Local authentication users must be stored in `.ploinky/passwords.enc` through `cli/services/encryptedPasswordStore.js`, not in `.ploinky/.secrets`. The password store is an AES-256-GCM envelope encrypted with the `storage/passwords` subkey; it groups user payloads by the route-specific users variable name, such as `PLOINKY_AUTH_EXPLORER_USERS`. User password material inside that store must be password hashes, not plaintext.

Encrypted stores fail closed when the resolved key cannot decrypt the existing file. Both the `.secrets` and `passwords.enc` decryption paths use only their per-purpose derived subkeys; they do not fall back to raw master-key bytes. Decryption failures include guidance to check whether `PLOINKY_MASTER_KEY`, a walked-up `.env`, or `.ploinky/master-key` differ from the seed that originally wrote the encrypted store.

The implementation uses more than one secret resolution path, and future changes must preserve the purpose-specific precedence deliberately. The workspace root seed is resolved from process environment, `.env`, or the generated `.ploinky/master-key` fallback because `.secrets` cannot be decrypted before the key exists. `secretInjector.getSecret()` prefers process environment, then encrypted `.secrets`, then `.env`. Manifest environment resolution in `cli/services/secretVars.js` currently resolves encrypted `.secrets` before process environment and then `.env`. Security-sensitive code must not assume a universal precedence order without checking the call site.

`ensurePersistentSecret()` remains available for legacy generated workspace values that are not agent-owned secrets. Agent-owned generated secrets must use `generatedSecret: true` or `{{generatedSecret:...}}` instead of generating random persistent values.

### Passwords, Local Sessions, and User Administration

Local authentication is enabled per route when the enabled-agent record has `auth.mode: "local"`, which may come from the manifest directive `pwd enable` or from explicit enable-time auth selection. Local auth user records must contain a stable local id, username, display name, optional email, roles, password hash, and revision counter.

Password hashing must use the supported hash verifier in `cli/services/localAuthPasswords.js`. New hashes use scrypt with a random 16-byte salt and a 64-byte derived key. Legacy `sha256:` hashes can still be verified but must not be treated as the preferred storage format.

Successful local login mints a compact HS256 User Session JWT in the `ploinky_jwt` cookie. The cookie must be `HttpOnly`, `SameSite=Lax`, path `/`, and `Secure` when the request is HTTPS or forwarded as HTTPS. The session JWT has `typ: "user-session"`, issuer and audience `ploinky-router`, a stable session id `sid`, user claims in `usr` (base role `user`, mapped from the legacy `local`), a route users-variable binding in `uvar`, a revision number in `rev`, a random `jti`, and a four-hour expiry. Verification requires `aud == ploinky-router` and `typ ∈ {user-session, guest-session}`. Authenticated local requests refresh the cookie as a sliding window, reusing the same `sid`. See DS013 for the full User Session claim set.

Local session revocation has two mechanisms. Revision-based: when a password or admin-managed user record changes, the target user's `rev` increases, and `getSession()`/`ensureAuthenticated()` reject a session whose JWT `rev`/`uvar` no longer match the encrypted user store (this route binding stops a JWT issued for one local-auth route from authenticating another). Explicit: a persistent revocation list at `.ploinky/data/router-security/sessions-revocations.json` records revoked `sid`/`jti` values, checked by `getSession()` on every resolution; logout adds the session's `sid` to it so a stateless cookie cannot be replayed. The revocation list degrades to "nothing revoked" if missing or corrupt (a list that failed closed would deny every user); JWT expiry and the `rev` check remain in force regardless.

The local account page permits a user to change their own username and password only after presenting the current password. The web handler enforces new-password confirmation and a minimum length for self-service password changes. Admin user-management APIs are exposed under `/api/agents/<agent>/users` and must require a valid local session for the target agent plus a local admin role or the built-in local admin identity. Admin mutations must preserve at least one admin user.

### SSO and Guest Sessions

SSO is workspace-bound through direct SSO config. The configured `providerAgent` must point to an installed provider whose manifest sets `ssoProvider: true`. Core auth code delegates provider-specific login URL creation, callback handling, refresh, logout, and user normalization to that provider. Core owns the random pending browser state, expiry, session cookie, and in-memory session store.

SSO pending state must be short lived. The generic bridge currently keeps pending entries for five minutes and deletes them after callback consumption. SSO sessions are server-side records containing normalized user information and opaque provider session or token material. Refresh remains provider-driven.

Guest auth is enabled by `guest: true` in an agent manifest, by `routerAccess.httpRoutes` entries with `access: "guest"`, or by `httpServices` entries with `access: "guest"`. Normal guest routes first honor an existing authenticated local or SSO session when one is present; otherwise the router mints a scoped guest session. Guest session JWTs live in `ploinky_guest`, expire after one hour, carry a `guest` role and random guest id, and may carry a `gscope` value that prevents reuse outside the declaring route or service. Guest sessions are `typ: "guest-session"` (audience `ploinky-router`) and resolve through the same `getSession()` path and revocation list as user sessions. Guest identity is pseudonymous and short lived; agents enforce guest limitations from the `actor.roles` claim in the Router Request the router mints, and the MCP tool policy (DS014) denies guests any `admin` or `internal` tool.

Guest-session identity is not the source key for public-ingestion throttling: a
browser can decline cookie persistence and receive another guest session. After
an immutable guest route and policy decision succeeds, the Router strips every
caller-supplied `x-ploinky-*` and source-address header and synthesizes an
`x-ploinky-rate-source` HMAC partition from the canonical transport source plus
the route key and external prefix. Active public-host requests require one
valid `CF-Connecting-IP` supplied by the supervised Cloudflare connector; local
aliases use the Router-observed TCP peer. Services may use this opaque value
only for abuse-control accounting, never authentication, authorization, or
identity, and must remove it before their application upstream.

### Router Route Protection

The router must attach authenticated identity to `req.user`, `req.session`, `req.sessionId`, and `req.authMode` before protected browser surfaces and first-party MCP requests execute. The route auth context is resolved from the request path, explicit `agent` query parameter, route table, and static-agent configuration. For `/webchat?agent=<target>`, the target agent manifest may declare `"webchat": { "auth": "static" }` to authenticate the webchat surface with the static agent's route policy while still running the target chat agent.

`/MCPBrowserClient.js` may be reachable before route authentication only on a
host class whose closed surface explicitly includes that bootstrap asset; it
must contain no secrets. Detailed `/health` is absent from TCP and is available
only to the supervisor over an unmounted Unix socket. An authenticated TCP
summary exposes no private targets, policy source, caller ACL, or topology
inventory.

`/auth/*` handles login, logout, account, token, and callback flows. `/api/agents/<agent>/users` performs its own local-admin authorization because it must authenticate against the target agent's local-auth policy. `/mcp` is protected by normal route authentication before router-level MCP aggregation. `/<agent>/mcp` defers browser authentication or delegated-caller verification until the JSON-RPC body is available, because secure-wire tokens are body-bound. Browser clients, including WebChat slash-command discovery, obtain a mutation proof from `/auth/token?agent=<routeKey>` and send it in `x-ploinky-browser-csrf-token` on each state-changing agent-first MCP request. That proof is bound to the exact authenticated session, browser origin, immutable generation, and agent route; clients refresh it once when the router reports a stale generation or invalid proof. Local-session proof derivation uses the signed stable `sid` claim rather than the sliding JWT serialization, retaining revocation identity while allowing authenticated responses to refresh cookie expiry without breaking concurrent browser mutations.

Dashboard and Status require a real router-authenticated local-admin session on
an exact local-control Host. They do not accept a surface token, invitation,
agent credential, media credential, private assertion, or loopback provenance
as administrator identity. The Dashboard `/run` endpoint can execute allowlisted
`ploinky` commands with bounded user-supplied arguments and output; it remains a
high-trust local control action. Every mutation, including `/run`, additionally
requires the exact request Origin and the session-bound CSRF header minted by
the router. Dashboard mutations are dispatched to this stricter control guard
without attempting to commit a policy route plan, because a local control Host
miss is intentionally not an edge-routed authorization grant.

Status is a control surface, not a route-policy fallback. It requires a real
authenticated admin session on an allowed local-control host and never becomes
public because an agent route uses auth mode `none`. Agent Assertions, Router
Requests, LiveKit JWTs, delegations, and localhost provenance cannot satisfy it.

Manifest-declared route access through `routerAccess.httpRoutes` is trusted manifest power over transparent proxy paths. A public declaration can expose read-only agent HTTP content to anonymous callers, a guest declaration ensures an anonymous identity when no user session exists, and an authenticated declaration can tighten selected paths under an otherwise unauthenticated agent route. If a manifest route entry omits `access`, the router treats it as `authenticated`; explicit empty or unknown values are invalid. Public declarations never make state-changing methods anonymous; `POST`, `PUT`, `PATCH`, and `DELETE` are denied unless a more restrictive decision applies. Authenticated declarations require a user-authenticated router session for all methods, using the owning route user-auth policy when configured, falling back to the static route's user-auth policy, and failing closed with `authenticated_http_route_auth_not_configured` when neither route can authenticate a user. Guest auth mode and guest sessions are not sufficient for authenticated route access. Manifest route access cannot open root, root wildcard, raw or encoded `__agent` control-plane segments, or router-root internal paths. Agent-relative `/auth/...`, `/admin/...`, and `/metrics` declarations expand under the agent route key and are not equivalent to the router-owned paths of the same names.

HTTP service routes are declared by agent manifests through `httpServices`; the router must not encode product-specific service paths in core handlers. Each declaration uses explicit `access` with exactly `public`, `guest`, or `authenticated`; retired service fields are invalid and unmount only the offending service. A `public` declaration intentionally bypasses router identity. A `guest` declaration honors an existing local or SSO login, otherwise mints a scoped guest identity, and forwards a router-issued `__http_service__` invocation token. Authenticated service routes under `/services/...` must not become anonymous or guest-only just because the service-owning agent route is configured with `auth.mode: "none"` or `auth.mode: "guest"`; the router must prefer the owning route's user-auth policy, fall back to the static route's user-auth policy, and reject the request if no user-auth policy is available. Authenticated and guest service routes may pass a compact `x-ploinky-auth-info` header derived from `req.user`. When the downstream service may need to trust that identity or make delegated agent calls, the router includes both a router-issued invocation token and the signed invocation body in that auth-info payload. Only authenticated service delegations are allowed, and they may be conditioned with `when: { queryParam, pathRoots }`; the router evaluates the decoded query parameter with boundary-aware path matching before minting, so a service can request DPU delegation only for `/Confidential` sessions while ordinary workspace sessions receive no delegation grant. This token is scoped to `http-service:<routeKey>` and `tool: "__http_service__"`, so it is not equivalent to broad first-party provider access. If the router cannot resolve the service route to an installed-agent principal while minting that token, it must fail closed and not proxy the request. The invocation body is the canonical `__http_service__` call payload containing method, signed internal path, external path, search string, route key, and `bodyHash` for the exact request body bytes the router forwards. The signed path is the rewritten upstream path that the service receives and can independently verify; `externalPath` is route context only. To avoid unbounded memory use while signing exact body bytes, the router buffers at most `PLOINKY_HTTP_SERVICE_INVOCATION_MAX_BODY_BYTES` bytes (default 10 MiB) for authenticated and guest service routes that mint invocation tokens and returns `413 http_service_body_too_large` before proxying when the limit is exceeded. Downstream services that use router SSO must call `verifyHttpServiceAuthInfoFromHeaders()` or perform the equivalent checks: verify the Router Request JWT audience, method, signed path, tool, `rch` computed with `computeRchHttp({method, path, query, bodyHash})`, replay id, and the received body hash before trusting the header. The helper supplies a bounded in-memory replay cache by default; multi-process services that need process-wide replay resistance may pass a shared replay cache explicitly. Services can also re-enter `/<agent>/mcp` with an Agent Assertion JWT carried as `Authorization: Bearer` when making delegated calls (DS013; the legacy `X-Ploinky-Caller-JWT` carrier is retired). The identity fields in `x-ploinky-auth-info` are not a signed secure-wire grant by themselves; downstream services must trust them only after the invocation token verifies for the forwarded service request. The router strips caller-supplied Ploinky identity headers before proxying and regenerates authoritative identity headers from the authenticated request context.

Each service also retains a validated slug and may declare one optional integer
`port`; an omitted port preserves the owning agent's primary target. Slug,
prefix, target, all effective policy providers, and exact source-byte digests
are compiled into one immutable route-and-policy authorization generation. Raw
file edits have no live effect.
Apply inactivates affected selectors before acknowledgement, and HTTP, SSE, and
WebSocket revalidate the captured generation immediately before dialing. A
stale or corrupt generation returns `503` without an upstream connection.

Listener/interface class and exact Host are resolved before pathname dispatch.
Dedicated service and agent-root hosts have closed allowlists, so an accepted
service Host cannot expose admin, health, policy, discovery, aggregate MCP,
Dashboard, Status, WebChat, broker, or private-service paths. Unknown,
malformed, suffix-confusable, stale, and unauthorized host/path combinations
fail before dialing. Incoming `Forwarded`, every `X-Forwarded-*`, cookies,
`Authorization`, and `x-ploinky-*` identity/assertion headers are stripped or
handled at their exact trusted boundary; canonical forwarding and identity
values are synthesized from the selected topology and authenticated context.

The `agent-mcp` capability on an agent-root host is compiled from the selected
root and its transitive active-manifest dependency closure. Only root `/mcp`,
exact `/<routeKey>/mcp` mounts in that closure, and MCP browser support assets
may select the MCP surface. A route that is merely enabled elsewhere in the
workspace cannot become the target through that public Host, and non-MCP paths
under dependency-looking prefixes continue to target the selected root rather
than exposing dependency content.

Private services use listener `8081` and require both the compiled canonical
service policy to resolve effectively to `authenticated` and an exact
current-instance/current-enable-generation caller ACL. The private assertion is
a distinct replay-protected credential binding audience, caller, generation,
method, path, body, expiry, and nonce. It does not mint or stand in for a user,
guest, or admin session. Assertions are accepted only on the private listener,
their header is removed before proxying, and service-specific upstream
authorization may be preserved. Every TCP control/status action still requires
a real admin session; mutations additionally require exact Origin and CSRF.

### Secure-Wire Invocation Model

**This section is superseded by DS013.** Executable agent calls use router-minted HS256 Router Request JWTs (`typ:"router-request"`). The router is the sole issuer; agents verify only. Each Router Request is signed with the TARGET agent's own `PLOINKY_AGENT_SECRET` (derived per DS013), not a shared key. Agents must never receive `PLOINKY_MASTER_KEY` or `PLOINKY_DERIVED_MASTER_KEY`, and the agent verifier (`Agent/lib/invocationAuth.mjs`) reads only `PLOINKY_AGENT_SECRET` with no fallback.

A Router Request JWT binds `typ:router-request`, issuer `ploinky-router`, audience `aud == agent:<repo>/<agent>`, `sub`, `actor`, `method`, `path`, optional `tool`, the request-content-hash `rch`, issued/expiry timestamps (TTL ≤30s), and a random `jti`. Before minting and forwarding `tools/call`, the router canonicalizes arguments with the target tool's advertised input schema, then computes `rch` over `{ method, path, tool, arguments }` (HTTP surfaces use `{ method, path, query, bodyHash }`). The verifier rejects a token whose type, audience, method, path, tool, or recomputed `rch` does not match the actual request — a valid HMAC alone is not sufficient. `Agent/server/AgentServer.mjs` uses a bounded in-memory replay cache and requires a verified Router Request for tool calls, resource reads, and task-status reads.

Browser-visible agent HTTP calls go through the router as transparent proxies under `/<agent>/...`, after router-owned paths have been handled. The target agent owns routed paths such as `/agent-card`, `/v1/chat/completions`, `/task`, `/index.html`, and custom HTTP endpoints. The router strips caller-supplied Ploinky identity headers before transparent proxying and does not treat those routes as secure-wire grants. The router-level `/agent-card` endpoint is an aggregate discovery surface, not the same contract as `/<agent>/agent-card`. Per-agent MCP remains special: `/<agent>/mcp` is still router-mediated so secure-wire invocation tokens, session mediation, body hashes, and replay checks remain in force for tool and resource operations. Agent-to-agent async task-status reads on `/<agent>/task` or `/<agent>/getTaskStatus` are also router-mediated: the caller signs an Agent Assertion for pseudo-tool `__task_status__` with the exact `taskId`, and the router replaces it with a target-scoped Router Request before proxying.

The per-agent model (DS013) provides non-repudiation between enabled agents within the local trust domain: because each agent holds only its own secret, an agent cannot forge a Router Request for another agent, and an agent-to-agent call is authenticated by an Agent Assertion the source agent signs with its own secret. The security invariant remains that the router is the sole issuer and that agents receive Router Requests only through router-mediated calls. Agent-to-agent access is additionally gated by the fail-closed MCP tool policy (DS014).

### Agent Index and Domain Authorization

The installed-agent index is not an authorization system. It resolves installed agent references, deterministic agent principals, runtime resources, and SSO-provider markers. It does not grant domain permissions and does not negotiate provider scopes.

Invocation scopes are broad by default for first-party and delegated calls when no explicit scopes are supplied. Domain agents that protect sensitive resources must enforce their own authorization using `authInfo` or the derived actor. For example, a secrets provider must check operation-specific scopes, user or agent identity, per-resource ACLs, and provider-specific policy files before granting access. Ploinky core must not claim that a router session alone authorizes every provider operation.

Legacy agent client-credential auth is removed. `/auth/agent-token` returns gone, and the shared-key `x-ploinky-caller-jwt` carrier is retired. Agent-to-agent authorization uses Agent Assertion JWTs (carried as `Authorization: Bearer`) that the router verifies by deriving the source agent's secret; the router then applies MCP tool policy (DS014) and mints a Router Request for the target (DS013).

### Runtime Isolation and Mount Policy

Outside a marked Ploinky box, the default runtime backend is a container runtime, preferring Podman when available and falling back to Docker. Host sandboxes are disabled by default and are selected only when the operator opts in via `ploinky sandbox enable` *and* the manifest requests `lite-sandbox: true`: Linux uses bubblewrap, macOS uses Seatbelt, and unsupported or unavailable host sandboxes fail with operator guidance rather than silently falling back. The environment variable `PLOINKY_DISABLE_HOST_SANDBOX=1` overrides any workspace opt-in and forces the container path. Inside an outer-contract-6 marked box, every managed agent, helper, sidecar, probe, and install-container path uses nested Podman; retained sandbox preferences, Docker, bwrap, and Seatbelt are not fallbacks.

Container agents must mount `/Agent` read-only, prepared dependency caches read-only, code and skills according to the active profile, `.data/<agent-or-alias>/` at `/root` as the persistent agent home, and workspace or shared paths as required by the run mode. Every container agent receives `HOME=/root`; isolated agents use `/root` as their workspace path, while global agents keep the workspace root as their run-mode write surface. The `dev` profile defaults code and skills to read-write. `qa` and `prod` default them to read-only unless a profile explicitly relaxes them. Prepared `node_modules` caches must remain read-only in runtime containers. Podman-staged symlink trees must mount each symlink target at its real path with the same read/write policy instead of relying on a broad writable workspace mount. Root and active profile manifest volumes and runtime resources are explicit operator-granted write surfaces and must be treated as trusted manifest power. Manifest volume host paths may resolve outside `.ploinky/`; runtime-resource data should still prefer `.ploinky/data/`, while agent home data should prefer `.data/`.

The outer container has exactly two physical-host mappings: loopback selected
Router TCP to box `8080`, and wildcard `7882:7882/udp`. No manifest, profile,
`openPorts`, readiness result, environment value, label, or retained state can
add a third mapping. The wrapper rejects `--publish`, `--expose`, and
`--listen-lan`; Router private `8081` and every agent/support TCP listener remain
un-published. A pre-existing physical UDP owner makes box creation fail with an
owner-aware diagnostic instead of auto-remapping.

Within the outer runtime, every Ploinky-managed nested Podman bridge uses the
exact `isolate=true` bridge option. Direct IP traffic between different managed
bridges is denied; agents communicate privately only when their manifest graph
places them on the same logical network, while normal outbound NAT remains
available. An existing managed bridge that does not prove the exact schema-2
labels, isolation option, IPAM, DNS, driver, and ownership contract must be
rejected rather than adopted. Router restart does not recreate or mutate a
valid managed bridge.

Managed `default` and `bridge` agent containers are created with exactly
`--hosts-file=none --add-host host.containers.internal:host-gateway`. They
receive the validated router host, port, and URL through environment variables;
they also receive the box-owned non-secret topology snapshot and private Router
locator before start. `host` agents use `127.0.0.1` only after an exact
effective-instance/current-generation capability grant, and `none` agents
receive no router endpoint.
Reuse validation treats any different hosts policy, attachment, alias, label,
network-contract hash, or immutable instance/enable-generation ownership label
as drift. Engine inspection must match those launch labels to the selected
generation before reuse or capability-effectiveness can succeed; mutable
registry state alone is insufficient. An older hash remains foreign and is neither
adopted nor recreated. Only exact-owned current-hash runtime drift may trigger
recreation; the hash is never weakened. Core contract-v5 managed networking requires
rootless Podman 5.4 or newer, Netavark, and operational `pasta`; no
`slirp4netns` fallback exists.

Host sandbox ownership uses the equivalent schema-2 PID record: exact runtime
key, PID start identity, `instanceId`, and `enableGeneration`. Missing, corrupt,
schema-1, or stale-generation records fail closed before reuse. Every runtime
backend derives and injects its exact tuple-bound private secret as a mandatory
launch step; identity-store failure cannot degrade startup to an unauthenticated
process. Semantic health recurs after startup, and a socket-owner failure
inactivates routing before any replacement attempt.

Inside a marked Box the private Router listener is reachable through the Box
namespace wildcard by approved managed-network callers and through box loopback
by capability-approved host-mode callers. Outside a marked Box it retains exact
loopback/managed-address binds. Every request still requires policy plus exact
caller-generation credentials; network reachability is never sufficient. No
outer publication or forwarding fallback is permitted.
Detailed health remains Unix-socket-only. Network reachability and localhost
provenance never inherit authentication. Calls that pass through the router,
including MCP operations, retain JWT issuer/audience checks, tool policy,
request-content binding, expiry, and replay protection. The former
`ploinky-router` network-name reservation is gone, but `ploinky-router` remains
the authentication issuer/audience identity defined by DS013.

Bubblewrap agents clear the environment and then set only the constructed environment map. They bind system paths needed for execution as read-only, bind `/Agent` read-only, bind dependency caches read-only, bind code and skills according to profile policy, bind shared and workspace paths as writable where required, and apply read-only overlays to protected Ploinky state such as dependency caches, `.secrets`, profile, routing, server configuration, and staged runtime paths. Bubblewrap currently unshares PID but does not unshare network, because agents need network access and router reachability.

Seatbelt agents run with a generated deny-default SBPL profile. The profile allows system reads, network calls, process execution, temporary writes, shared/workspace writes, profile-controlled code and skills writes, declared volumes, and logs. It denies writes to guarded runtime paths, dependency caches, staged Agent libraries, `.secrets`, profile, routing, and server configuration. Because Seatbelt exposes real host paths rather than a mount namespace, its generated profile is the authoritative access-control layer.

When multiple host-sandboxed agents are stopped or destroyed, Ploinky sends the graceful signal to every selected sandbox process group before waiting on the shared timeout. Any sandbox still alive after that deadline is force-killed and its PID record is cleared. This is a lifecycle bound, not an additional security boundary.

Lifecycle hooks are trusted host or runtime code. `preinstall` runs on the host before container or sandbox creation and can seed workspace variables or files. Host lifecycle hooks are outside runtime sandbox protection. A manifest that defines hooks must therefore be trusted at the same level as a local script run by the operator.

### Files, Static Content, Uploads, and Blobs

Workspace file reads and uploads must remain confined to the workspace root. `cli/server/utils/workspacePaths.js` rejects null bytes, resolves leading slashes as workspace-relative when requested, canonicalizes paths through realpath-aware logic, and denies symlink escapes outside the workspace.

The WebChat composer autocomplete file-suggestion endpoint (`/webchat/suggestions/files`) must apply the same workspace-confinement rules as Explorer's filesystem reads. It narrows its search root to the workspace-confined current directory resolved from the WebChat launch query and rejects absolute caller paths, traversal (`..`), NUL bytes, symlink escapes outside that directory, Ploinky runtime state, dependency directories, and the reserved secret files `.secrets` and `*.secrets`. The endpoint must return only cwd-relative or workspace-relative paths and must not return host absolute paths to the browser. The endpoint provides suggestions only; downstream chat agents must still validate any structured `workspace-path` references they receive before reading file content. WebChat must sanitize references on the way out by dropping absolute paths, traversal, NUL bytes, reserved secret-file names, and any non-string path values.

WebChat direct uploads must follow the same workspace confinement rules and narrow them to the resolved WebChat working directory. Directory listing, directory creation, and upload targets must reject absolute caller paths, traversal segments, NUL bytes, Ploinky runtime state, dependency directories, reserved secret names, symlink components, and any canonical target outside that working directory. The browser may display only cwd-relative and workspace-relative paths; host absolute paths must never cross the HTTP boundary.

`POST /webchat/uploads` writes browser-selected content directly below an explicitly selected cwd-relative destination. It must not create session-scoped upload trees, hashed storage paths, persistent upload ids, or MIME metadata files. Existing files may be replaced only when the authenticated browser explicitly confirms the collision and sends `X-Overwrite: 1`; folder uploads merge rather than deleting unrelated destination content. Each request must stage bytes in a temporary sibling and commit after successful completion so an interrupted upload does not truncate the previous target. The returned download URL must use the confined authenticated `/workspace-files/...` route. Direct workspace writes remain operator-trusted power and do not introduce a multi-tenant isolation boundary.

WebChat must not expose conversation-history REST routes or write selected-CLI conversation snapshots to disk. Incoming `__webchatSession` control envelopes must use validated UUID session ids, bounded lists, validated message roles, and validated task references before their memory-only snapshot reaches the browser. They must never include cookies, JWTs, user identifiers, or agent secrets. Durable store containment and permissions belong to the session-owning CLI.

WebChat interaction responses are state-changing control traffic and must use the authenticated route session. `POST /webchat/interaction` must bind the caller to an active SSE subscriber for the same tab and runtime, compare the supplied interaction id with the runtime's current pending request, and accept only an option id declared by that request. Browser state is not authority: stale, mismatched, or replayed responses must fail before writing to the CLI TTY. Interaction envelopes and decisions must stay out of agent-owned conversation history and logs.

Browser autocomplete must not treat URL query parameters as authority to call arbitrary MCP tools. Ploinky WebChat must not expose provider tag catalogs from URL parameters; dynamic backend discovery belongs to the selected chat agent or relay during a real delegated request that carries a router-minted invocation token.

Router-owned workspace file serving sanitizes relative paths and denies `..`
traversal before resolving under the workspace root. Assistant path enhancement
in WebChat must not widen this read boundary. CLI-published
`__webchatWorkspaceFiles` snapshots and deltas are untrusted presentation hints:
Ploinky must bound their entry counts and path lengths, reject absolute,
backslash, control-character, and traversal paths, keep the resulting index only
in volatile runtime memory, and never use it as read authorization. The browser
constructs authenticated `/workspace-files/...` links only for indexed candidates
and performs the actual read only after an explicit user click; the router must
still canonicalize and validate that target independently. Supported text responses must be served inline with an
extension-derived MIME type and `X-Content-Type-Options: nosniff`; WebChat must
escape source and plain-text content, render Markdown through its existing
renderer, and sandbox workspace HTML previews. Agent application static serving
is no longer implemented by reading `static.hostPath` inside the router; the
router forwards `/<agent>/...` to the selected agent, and that agent is
responsible for static-file confinement. The shared `AgentServer` serves static
files from `PLOINKY_CODE_DIR` or `/code`, denies traversal segments and NUL bytes,
and checks resolved paths stay inside that root. Custom agent HTTP servers that
serve `index.html` or other application assets must enforce the same containment
rule. Operators must not place secrets in directories reachable by agent static
roots.

Blob upload and download paths use random hexadecimal ids and reject ids containing characters outside the allowed id set. Original filenames and MIME types are stored as metadata and must not control filesystem paths. Blob and upload handlers currently do not enforce a repository-wide content-size limit or quota. Any deployment that exposes uploads beyond a trusted local user must add request-size limits and storage quotas at the router or proxy layer.

`/upload` writes to an operator-specified workspace path after canonical path validation. `/blobs` stores shared blobs under `.ploinky/shared` or agent blobs under the enabled agent project path. Responses use `X-Content-Type-Options: nosniff` for blob data.

### Logs and Audit Data

Router logs and agent logs are diagnostic surfaces and must not intentionally record secrets, passwords, cookies, bearer tokens, JWTs, API keys, raw prompts, materialized resource content, base64 resource bodies, command stdin payloads, or internal tool payloads. `AgentServer` tool-argument and payload logging must redact prompt, message, content, base64, resource, stdin, task, and payload-shaped fields before writing to stdout/stderr. Some agent execution paths sanitize known sensitive fields before logging payloads, but `appendLog()` itself trusts the caller. New logging code must redact sensitive fields before writing to `.ploinky/logs/`.

### Browser Media and Third-Party API Keys

Ploinky WebChat does not expose first-party browser dictation, spoken-reply synthesis, or browser-facing realtime provider-token endpoints. Browser-facing routes must not return external provider API keys or direct browser media credentials from the router process. Any future browser media or provider-token surface must be owned by an explicit agent manifest/service contract and documented with the same route-auth, token-lifetime, logging, and deployment constraints as other protected browser media flows.

The SSO `/auth/token` endpoint can return provider access-token information for an authenticated SSO session. That endpoint is a browser-facing token surface and must remain gated by the active session cookie and route auth context.

### Hardware-Aware LLM Runtime

LLM agents that opt into `manifest.llmRuntime.enabled = true` go through a typed runtime policy contract. Raw container arguments are forbidden: the catalog and manifest declare a normalized policy (`platform`, `resources`, `devices`, `securityOpt`, `ipc`, `gpus`); any other field is rejected at load time. Devices must declare `type: "cdi"` with a value matching `nvidia.com/gpu=all` or `nvidia.com/gpu=<id>`, or `type: "hostDevice"` with a `hostPath` under the allowlist `/dev/kfd`, `/dev/dri`, or `/dev/accel`. Arbitrary host devices, raw flags, and implicit privileged mode are rejected. Host filesystem mounts must be declared through manifest `volumes`, where they are treated as explicit operator-granted access. `securityOpt` is currently restricted to `label=disable`. `gpus` is restricted to `all` or `device=<list>` on Docker; Podman must use a CDI device entry instead.

LLM runtime manifests still use the ordinary Ploinky MCP contract. The public container port `9000` is a proxy: `/mcp` is served by the shared AgentServer sidecar on the internal port `9001`, preserving router-minted secure-wire invocation checks, while runtime diagnostics and chat proxy endpoints are forwarded to the local runtime control service on `9002`. State-changing operations such as launcher start/stop and model-profile priority updates must be exposed as MCP tools behind the normal invocation-token flow. Direct `/runtime/*` HTTP routes are diagnostic alias surfaces and must not become a privileged public control plane.

Ploinky writes `.data/<agent-or-alias>/runtime/selected-architecture.json` before container start and mounts it at `/runtime/selected-architecture.json`. Long-lived Hugging Face and model artifacts are mounted separately at `/models` and must remain under `/models/hf-cache`, `/models/artifacts`, and `/models/derived`; `/runtime` is for selected-architecture metadata, launch configs, PIDs, state, and redacted logs. Image references cannot contain secrets — the only template token Ploinky substitutes inside catalog `image.ref` is `${AGENT_IMAGE_NAME}`, replaced with a validated agent identity (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`). `HF_TOKEN` (and other Hugging Face tokens) is treated as a manifest-declared env secret only; it must never appear in container image refs, container labels, command-line arguments, the selected-architecture state file, model-profile state, launcher configs, or runtime logs. Ploinky core does not load, execute, or interpret catalog code: catalogs are JSON data files validated with strict schema-equivalent allowlists, with path-traversal guards on every referenced architecture and image file. The published JSON Schemas are kept in parity with the runtime validators by catalog tests. See DS012 for the catalog contract.

The box image includes a pinned multi-architecture `cloudflared`, supervised by
Ploinky core. Credential absence selects the complete `local-only` operating
mode: the connector process is absent and no public HTTP hostname exists.
Cloudflare mode requires an existing tunnel connector token and a separate
least-privilege API token for DNS/ingress reconciliation. Ploinky never creates
a tunnel or quick tunnel. Partial, invalid, or unauthorized configuration fails
closed without switching modes, and the connector always targets in-box
`http://127.0.0.1:8080`. Token values stay out of argv, ordinary process env,
logs, diagnostics, status, and read APIs. Before v5 activation operators revoke
the retired connector/API tokens and delete its plaintext state; v5 contains no
reader, migration, cleanup, or fallback for it.

A coordinated edge apply already commits a credential-absent generation as
`local-ready`. The publication supervisor adopts that exact selected generation
without inactivating and applying it again. This avoids a second writer racing
agent-enable generation work and does not weaken validation: invalid or partial
Cloudflare input still fails closed, and a prior Cloudflare ownership journal
always forces the normal inactivate, remote teardown, and coordinated commit
sequence before local-only is reported.

The box-owned topology snapshot is non-secret and generation-based. It records
the immutable route-and-policy `authorizationGeneration`, a content-derived
`configurationGeneration` for stable non-secret consumer inputs, and a
monotonic `publicationGeneration` for readiness/publication state. It excludes
Cloudflare account data, private target ports, credential handles, callback
tokens, and TURN credentials. Browsers receive only one authenticated active
locator with `Cache-Control: no-store`, configuration/publication ids, and no
authorization id or inventory. TURN long-term secrets stay in core. The private
broker mints rate-limited short-lived credentials only for exact
current-generation consumers, returns expiry, and logs no credential value.
Agents never receive the long-term secret through their environment or mounted
topology.

### Residual Security Requirements

Core contract v5 supports selected internet-facing HTTP services only through the
outbound Cloudflare tunnel and exact Router host/service policy. It does not
claim hostile multi-tenant isolation. Origin/CSRF checks, login and broker rate
limits, upload/body quotas, closed host surfaces, header synthesis, immutable
generation leases, and scoped private assertions are mandatory for that public
mode. Dashboard command execution remains a high-trust local-admin surface and
must not be included on public service or agent-root hosts. Anonymous-token or
limited-API-key identities remain deferred and are not substituted by guest
sessions or agent assertions.

## Decisions & Questions

### Question #1: Why is the workspace master seed the root security secret?

Response:
The current branch uses one workspace master seed, preferably supplied through `PLOINKY_MASTER_KEY` or `.env` and otherwise generated at `.ploinky/master-key`, as the root from which every per-purpose key is derived via HKDF-SHA256. The router decrypts `.ploinky/.secrets` with the `storage/secrets` subkey, decrypts `.ploinky/passwords.enc` with `storage/passwords`, mints local session JWTs with `session`, and signs each Router Request JWT with the target agent's own `PLOINKY_AGENT_SECRET` (derived per DS013); the `derived-master` subkey is used only as the root for agent-owned generated secrets and is no longer injected into agents. Keeping a single root seed keeps operations simple while domain-separated derivation contains the blast radius: a compromise of one subkey does not yield the others or the master. The whole-workspace exposure risk now collapses to "anyone who can read the resolved master seed", so `PLOINKY_MASTER_KEY`, any `.env` carrying it, and `.ploinky/master-key` must continue to be treated as high-trust assets.

### Question #2: How does the per-agent credential model replace the shared-HMAC invocation model?

Response:
The shared-HMAC model injected one `derived-master` key into every agent, so any agent that read the shared secret could mint tokens for another principal — no non-repudiation between agents. That model is replaced (DS013): each agent receives only its own `PLOINKY_AGENT_SECRET`, derived from the master via HKDF with the agent id as domain separation. The router signs each Router Request with the target agent's secret, and agent-to-agent calls are authenticated by an Agent Assertion the source agent signs with its own secret and the router verifies by deriving that agent's secret. One agent reading its own environment can no longer forge tokens for another. This restores non-repudiation between enabled agents within the local trust domain; multi-tenant or mutually hostile hosting would still require additional issuer hardening (e.g. asymmetric signatures) but is outside the documented model.

Decision 2026-06-24: router-issued signed-subject API credentials are generic identity material. Agents receive `PLOINKY_AGENT_API_KEY` and `PLOINKY_AGENT_API_PUBLIC_KEY` only; service-specific credential aliases are not part of the security contract.

### Question #3: Why are runtime sandboxes not described as complete containment?

Response:
Containers, bubblewrap, and Seatbelt reduce host filesystem and process exposure, but Ploinky still grants agents network access, selected writable mounts, manifest-declared volumes, runtime-resource storage, and sensitive environment variables. Host lifecycle hooks run outside the sandbox. The correct contract is therefore defense in depth for operator-enabled code, not a guarantee that arbitrary hostile code can be run safely without further controls.

### Question #4: Why does the security model call out router network exposure as a deployment risk?

Response:
The public/control listener is reachable inside the box but the physical host
publishes it only on loopback. Public HTTP arrives through an outbound
cloudflared connection to fixed in-box `127.0.0.1:8080`; the private listener is
not an outer publication even though it binds the Box namespace wildcard.
Private request policy, caller ACL, and generation-bound assertions remain
mandatory; public host/interface classification, exact Host, closed
surface allowlists, and application policy therefore remain necessary even
though no physical-host TCP socket is LAN-visible.

### Question #5: What unresolved hardening work is required before internet-facing production use?

Response:
Per-agent credential isolation, fail-closed route/tool policy, Origin/CSRF for
mutations, closed host surfaces, exact generation leases, and scoped private
assertions are required by core contract v5. A hostile multi-tenant claim remains out
of scope because enabled code, lifecycle hooks, host-mode capability, writable
mounts, Dashboard command execution, and the workspace master key stay in one
operator trust domain. Anonymous-token identities and any browser provider-token
surface require a separate design rather than a fallback credential.

### Question #6: Why treat manifest-declared HTTP route access as trusted manifest power?

Response:
A manifest already controls runtime commands, env defaults, mounts, profiles, and service declarations for an enabled agent. Letting the same manifest declare public read-only or protected transparent proxy paths keeps that routing intent with the agent source, but it must be documented as trusted power because `public` changes anonymous reachability. The security boundary is preserved by limiting public to `GET`/`HEAD`, by making protected win over public on overlaps, and by reusing the router's internal-path rejection before any declaration can affect request handling.

### Question #7: Why are provider subprocesses denied master and identity secrets even though they run on the host?

Response:
Provider commands are configuration helpers that may wrap third-party APIs or route-generation logic. They need selected manifest inputs and workspace context, not the workspace master seed or router-issued agent identity. Keeping the persistence step inside Ploinky preserves the encrypted-store boundary and keeps provider authors from depending on secrets that would make later sandboxing or policy hardening impossible.

### Question #8: Why must path autocomplete remain confined to the resolved WebChat working directory?

Response:
The workspace root is the broad operator trust boundary, but a WebChat launch
may intentionally select a narrower project directory. Treating that resolved
directory as the suggestion root prevents the browser from using autocomplete
to enumerate sibling projects and ensures every returned token has the same
relative-path meaning for the launched CLI. Downstream agents must still
validate references before reading them because autocomplete is discovery, not
read authorization.

## Conclusion

Ploinky's security model is a local workspace model built around a trusted operator, a router trust broker, encrypted workspace stores, JWT-HMAC invocation tokens, and runtime isolation backends. The implementation must continue to document its real boundaries clearly: strong local controls where they exist, explicit trust in the workspace master key and enabled agents, and no claim of multi-tenant or public-internet safety without additional hardening.
