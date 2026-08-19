# Ploinky HTTP Route Access Security Model

This document explains the current Ploinky router security model after the
HTTP route access and token-service refactor. It is a readable architecture
guide for reviewers, operators, and implementers. The normative contracts
remain the DS specs:

| Spec | Scope |
| --- | --- |
| `docs/specs/DS007-routing-and-web-surfaces.md` | Router surfaces, route table behavior, transparent agent proxying, HTTP services, and browser endpoints. |
| `docs/specs/DS013-security-model.md` | Workspace trust model, sessions, storage keys, local/SSO/guest auth, runtime isolation, and deployment limits. |
| `docs/specs/DS015-per-agent-identity-and-request-signed-jwts.md` | Per-agent identity, Agent Assertions, Router Requests, User Sessions, request-content hashes, and delegation grants. |
| `docs/specs/DS016-router-access-control-http-route-access-and-mcp-policy.md` | HTTP route access, MCP policy, administrative policy commands, fail-closed state handling, and removed vocabulary. |

## Executive Summary

Ploinky now has one HTTP route access model for browser HTTP paths and
declared HTTP services. That model recognizes exactly three access values:

| Value | Meaning | Anonymous? | Session Outcome |
| --- | --- | --- | --- |
| `public` | Read-only anonymous HTTP access. | Yes, for `GET` and `HEAD` only. | No session is minted or required. |
| `guest` | Browser access with a router-issued anonymous guest identity unless the caller is already a user. | Yes, but with an expiring guest session. | Existing local/SSO user wins; otherwise `ploinky_guest` is minted or reused. |
| `authenticated` | Browser access requiring a real local or SSO user session. | No. | `ploinky_jwt` must resolve to a user session; guest sessions never satisfy it. |

Every other value is invalid. Manifest `routerAccess.httpRoutes` entries that
omit `access` default to `authenticated`. Persisted policy routes and
`httpServices` still require explicit `access`; missing values there, retired
values, unknown values, disabled routes, invalid paths, unbound providers, and
corrupt policy state all deny. Route defaults never produce `public`;
anonymous access is always an explicit declaration.

The model replaces the old split between HTTP allowlists, guest route logic,
protected route aliases, manifest-specific route handling, and HTTP-service
auth branches. The router now evaluates one policy decision and enforces it
through one executor before proxying.

The managed runtime compiles that decision together with its route target into
one immutable, exact-byte route-and-policy generation. Raw routing, manifest,
or policy candidate edits have no live authorization effect. A coordinated
apply first inactivates the affected selectors and installs a fully validated
replacement atomically; failure leaves them inactive and never restores an old
generation. Exact listener/interface class and exact `Host` are resolved before
pathname dispatch, and HTTP, SSE, and WebSocket transports capture and
revalidate the same generation lease immediately before creating an upstream
connection.

## Trust Boundaries

Ploinky is still a local workspace runtime. The trusted assets are the operator
account, the host filesystem, `PLOINKY_MASTER_KEY` or `.ploinky/master-key`, the
`.ploinky/` workspace state directory, and the router process. Agents are operator-enabled code, not
mutually hostile tenants.

| Boundary | What It Protects | Current Rule |
| --- | --- | --- |
| Router public/control listener `8080` | Browser routes, public HTTP services, first-party surfaces, policy commands, MCP entry points. | Exact control, agent-root, and dedicated-service Hosts select closed route surfaces before path dispatch. The outer wrapper publishes this listener only through the selected physical-host loopback port; cloudflared, when explicitly configured, always dials in-box `127.0.0.1:8080`. |
| Router private listener `8081` | Current-generation agent-to-service HTTP, SSE, and WebSocket calls. | It is never an outer publication. Effective authenticated policy and an exact caller instance/enable-generation ACL plus request-bound replay-protected private assertion are all required. |
| Workspace master key | Session signing, encrypted stores, per-agent request secrets, generated secrets. | The resolved master seed is high trust; explicit `PLOINKY_MASTER_KEY` / `.env` values and the generated `.ploinky/master-key` fallback all root the same HKDF tree. |
| Agent environment | Agent identity and per-agent signing. | Every runtime receives only its canonical principal and exact runtime tuple before attestation. Reusable per-agent/private/API credentials are added only to managed default/bridge Podman launches after generated-local Router attestation; host/none, bwrap, Seatbelt, and host-hook paths remain principal-only. No runtime receives the master or shared derived-master request key. |
| Policy state | Operator/admin HTTP and MCP policy. | Corrupt or old schema state fails the whole document closed. |
| Manifest declarations | Candidate agent-owned routing/service intent. | Manifests may declare route access and slim HTTP services in the new vocabulary. Exact bytes are effective only after coordinated generation apply; invalid candidate state installs nothing and leaves affected selectors inactive. |

The router is the trust broker. Browser cookies stop at the router. Agents do
not receive user session JWTs, guest session JWTs, or router policy state.
When an agent must receive identity context, the router mints a fresh,
request-bound Router Request JWT or an HTTP service auth-info header with a
signed invocation token.

## Request Flow

HTTP request handling follows the same high-level sequence for transparent
agent routes and declared HTTP services:

| Step | Component | Responsibility |
| --- | --- | --- |
| 1 | Listener classifier and `RoutingServer.js` | Resolve public/control versus private listener and validate the exact `Host`; select only that host class's closed route surface. |
| 2 | Installed `edgeRoutePlan` generation | Capture one immutable route target and policy generation lease; raw candidate files are not consulted as authorization. |
| 3 | `internalAgentPath.js` plus `HttpRouteAccessPath` | Reject literal or encoded internal `__agent` paths and unroutable path shapes. |
| 4 | `HttpRouteAccessPolicy.evaluate()` | Compose the installed operator policy, manifest routes, HTTP service entry, and route defaults. |
| 5 | `ensureHttpRouteAccess()` | Enforce `public`, `guest`, or `authenticated`; private calls additionally prove the exact current caller ACL and assertion. |
| 6 | Router dispatch | Serve only the selected host surface: first-party control, declared service, agent-root static/proxy, or MCP route. |
| 7 | Dial boundary | Strip caller-supplied identity/source headers, regenerate router-owned metadata, and revalidate the captured generation immediately before each HTTP/SSE/WebSocket upstream connection. Guest ingestion receives only an opaque route-scoped transport-source HMAC for per-source rate accounting. |

The policy evaluator is intentionally separate from sessions and JWTs. It
decides what access class applies to a path and method. The executor then
performs the session work for that class. This keeps policy decisions
auditable and prevents session mechanics from creating hidden access classes.

## Path Normalization and Internal Paths

`HttpRouteAccessPath` is the gate for persisted and manifest route paths, and
the same internal-path predicate is used at request time. Its role is to make
route matching boring and closed.

| Path Shape | Result |
| --- | --- |
| Leading slash path such as `/agent/public/readme` | Valid concrete route path. |
| Trailing wildcard such as `/agent/public/*` | Valid prefix route path, matched by path boundary. |
| Root-only `/` or root wildcard `/*` | Rejected for route access declarations. |
| `*` anywhere except final `/*` | Rejected. |
| `//`, backslash, `%2f`, `%5c`, dot segments, NUL bytes, URL schemes | Rejected as unroutable or invalid. |
| Any raw, encoded, or double-encoded `__agent` segment | Rejected as internal. |
| Router-owned first segments such as auth/admin/policy internals | Not policy-routable at router root. |

Unroutable request paths produce a deny decision, normally surfaced as
`404 UNROUTABLE_PATH`, and are never treated as "no policy, continue
unauthenticated." Internal `__agent` paths are refused both before dispatch and
before synthesized upstream service dispatch.

## Access Classes

### Public

`public` is the only class that allows no session. It is deliberately narrow:

| Rule | Detail |
| --- | --- |
| Methods | Only `GET` and `HEAD` pass. |
| Write methods | `POST`, `PUT`, `PATCH`, `DELETE`, and other writes return `403 PUBLIC_ROUTE_WRITE_DENIED`. |
| Cookies | The router does not mint `ploinky_guest` and does not require `ploinky_jwt`. |
| Defaults | Route defaults never produce `public`. |
| Overlap | If a more restrictive declaration overlaps a public one, the more restrictive declaration wins. |

Public is for read-only agent-owned HTTP content or service endpoints that are
safe to expose without identity. It is never implied from old auth mode `none`
or from a missing policy row.

### Guest

`guest` is the identity-bearing anonymous class. It exists so anonymous browser
users can be represented consistently downstream without being mistaken for
real users.

| Rule | Detail |
| --- | --- |
| Existing user precedence | A valid local or SSO user session takes precedence over guest minting. |
| Guest cookie | If no user session exists, the router mints or reuses `ploinky_guest`. |
| JWT type | Guest sessions are `typ: "guest-session"`. |
| Scope | Guest sessions may carry a `gscope` that limits reuse to the route or service that minted them. |
| MCP role | Browser guest MCP callers have actor kind `guest`; they may satisfy MCP `authenticated`, but never `internal` or `admin`. |
| Delegation | Guests never receive User Delegation Grants. |
| Ingestion rate source | Guest session ids are not source identity. After host/policy validation, the Router replaces every spoofable source header with `x-ploinky-rate-source`, a 64-hex route-scoped HMAC over the canonical Cloudflare source address or local TCP peer. It contains no raw address or user/session identity and cannot authorize access. |

Guest identity is not a compatibility alias for unauthenticated pass-through.
It is a router-issued, expiring identity with limited authority.

### Authenticated

`authenticated` requires a real user session. It excludes guest sessions even
if a guest JWT is presented in the `ploinky_jwt` cookie.

| Rule | Detail |
| --- | --- |
| Accepted sessions | Local user sessions and SSO user sessions. |
| Rejected sessions | Guest sessions, missing cookies, wrong `typ`, revoked sessions, wrong route binding, expired sessions. |
| Route auth source | Prefer the owning route's user-auth policy; fall back to the static route's user-auth policy when allowed by the route-default rules. |
| Failure mode | If no user-auth policy can authenticate the route, fail closed with an auth-required response. |
| Services | Only authenticated HTTP services may request user delegation grants. |

The important invariant is type separation: a JWT that verifies as
`guest-session` is not a user session. The token layer enforces this before the
route executor decides whether a caller satisfies an authenticated path.

## Decision Sources

Effective HTTP route access is composed from four sources. They all flow into
the same evaluator.

| Source | Owner | File / Module | Notes |
| --- | --- | --- | --- |
| Persisted `httpRoutes` | Operator/admin candidate policy | `.ploinky/data/router-security/policy-state.json`, `PolicyStateRepository.js` | Staged by `http.route.set`; effective only after coordinated generation apply. |
| Manifest `routerAccess.httpRoutes` | Enabled agent manifest candidate | `HttpRouteProviders.js`, `HttpRoutePolicyCompiler.js` | Exact bytes are captured, digested, validated, and expanded during coordinated apply. |
| Manifest `httpServices` | Enabled agent manifest candidate | `httpServiceRoutes.js`, `HttpRouteProviders.js` | Validated service target and route policy are installed in the same immutable generation. |
| Route default | Router fallback | `authHandlers.js` | Preserves static-agent deference and otherwise defaults to guest. |

When multiple sources match, the most restrictive access wins:

```text
authenticated > guest > public
```

This lets an operator tighten an agent manifest declaration without allowing an
agent to weaken operator policy.

## Route Defaults

Route defaults exist only for ordinary transparent routes that do not match a
persisted route, manifest route, or HTTP service declaration.

| Route Situation | Default Access |
| --- | --- |
| Route has user-authenticated static agent deference | `authenticated` |
| Route has `auth.mode: "none"` and no user-auth static agent | `guest` |
| Route has guest mode | `guest` |
| Route has local or SSO user auth | `authenticated` |
| Route cannot be resolved safely | Deny |

The subtle rule is static-agent deference. A route configured as auth mode
`none` behind a user-authenticated static agent remains user-authenticated.
This preserves the previous browser-surface behavior without creating a
public/no-session default.

## Manifest Route Access

Agents declare route access with `routerAccess.httpRoutes`. Declarations are
agent-relative and expand under the active route key or alias.

```json
{
  "routerAccess": {
    "httpRoutes": [
      { "path": "/public/*", "access": "public" },
      { "path": "/guest/*", "access": "guest" },
      { "path": "/account/*", "access": "authenticated" },
      { "path": "/settings/*" }
    ]
  }
}
```

| Manifest Rule | Detail |
| --- | --- |
| Required field | `path` is required. Use `access`, not old aliases, when declaring a value. |
| Valid values | If present, exactly `public`, `guest`, `authenticated`. Omitted `access` defaults to `authenticated`. |
| Path base | Paths are agent-relative before expansion. |
| Root | `/` and `/*` are rejected. |
| Internal paths | Raw and encoded `__agent` are rejected. |
| Router-looking names | Agent-relative `/auth/...`, `/admin/...`, and `/metrics` expand under `/<routeKey>/...`; they are not router-root internals. |
| Persistence | Manifest declarations are not copied into policy-state. |

Manifest entries are candidate input. Coordinated apply captures and digests
their exact bytes; neither mtime/size changes nor a same-size replacement can
authorize a live request. Invalid input prevents the affected generation from
installing and leaves its selectors inactive. Omitted manifest-route `access`
still defaults to `authenticated`; persisted `httpRoutes` and `httpServices`
require explicit valid access.

## HTTP Services

HTTP services are agent-declared routes with an external prefix and an
internal upstream prefix. They use the same `access` vocabulary and the same
evaluator/executor path as transparent routes.

The slim service shape retains current fields and adds only optional integer
`port`. Omitted `port` targets the agent's primary listener. A present port must
be a validated TCP port; Ploinky creates or reuses one private inner mapping per
distinct explicit target and records it in the immutable generation. A
validated unique `slug` is required only when a dedicated service Host or mount
needs a service name. No service field can add a physical-host publication.

| Service Access | Identity Forwarded | Delegation Grants | Notes |
| --- | --- | --- | --- |
| `public` | None. | Never. | Anonymous read/write depends on the service declaration and method handling, but no user identity is provided. |
| `guest` | Existing user or scoped guest identity. | Never. | The router may mint `ploinky_guest`; auth-info carries guest/user context, not delegation. |
| `authenticated` | User identity. | Optional, if explicitly configured and condition matches. | Requires a user session and may receive scoped User Delegation Grants. |

Removed service fields such as `auth`, `mode`, `forceGuest`, and
`additionalServerPort` invalidate the candidate. There is no profile-server
special path or compatibility proxy. Invalid candidate input cannot install an
authorization generation.

For services that receive router identity, the router strips caller-supplied
identity headers and regenerates its own `x-ploinky-auth-info`. When invocation
minting is enabled, the router signs the actual upstream method, internal path,
query, and exact forwarded body hash. Oversized buffered bodies fail closed
before proxying.

## Administrative Policy Surface

`POST /policy/command` is the single router policy command endpoint. It is
router-owned, authenticated, and never route-policy-controlled.

| Command | Authority | Purpose |
| --- | --- | --- |
| `http.route.set` | Admin, or a normal user approved by the owning agent share authorizer. | Add or update a persisted HTTP route entry. |
| `http.route.remove` | Admin, or share-authorized user. | Remove a persisted HTTP route entry. |
| `http.route.check` | Authenticated browser user. | Return the effective decision using the same singleton evaluator and providers as dispatch. |
| `http.route.list` | Authenticated browser user. | List persisted operator entries only. |
| `mcp.policy.set` | Admin only. | Set a tool policy entry. |
| `mcp.policy.get` | Admin only. | Read one tool policy entry. |
| `mcp.policy.list` | Admin only. | List tool policy entries. |

`http.route.list` is intentionally not the effective view, because the
effective view also includes manifests, services, and defaults. Use
`http.route.check` to inspect the decision a request would receive.

## Policy State

Policy state lives at:

```text
.ploinky/data/router-security/policy-state.json
```

Its schema is `router-policy` and it contains two collections:

| Collection | Domain |
| --- | --- |
| `httpRoutes` | Persisted operator HTTP route access entries. |
| `mcpTools` | Persisted operator MCP tool policy entries. |

The state file is one security document. If it is corrupt, has the wrong
schema, or contains invalid entries, both HTTP route access and MCP tool policy
fail closed. Mutations refuse to overwrite corrupt state.

Old documents using removed HTTP vocabulary are invalid. Remediation is:

| Step | Action |
| --- | --- |
| 1 | Stop the router. |
| 2 | Back up and inspect the invalid file without changing the selected generation. |
| 3 | Replace it atomically with one complete, schema-valid policy document and restore every other required routing/agent/desired/manifest source. Do not leave the file missing or delete only this source. |
| 4 | Invoke coordinated apply, verify the new active digest, then re-add any intended policy through the authenticated admin commands. |

There is no entry-level tolerance for old rows, because partial acceptance of a
security document is harder to audit than a closed failure. Restart does not
interpret a missing document as empty and does not reconstruct or roll back old
state automatically.

## MCP Policy and Guest Actors

HTTP route access and MCP policy are separate domains even though both use the
word `authenticated`.

| Domain | Values | Meaning of `authenticated` |
| --- | --- | --- |
| HTTP route access | `public`, `guest`, `authenticated` | Requires a real user session and excludes guests. |
| MCP tool policy | `authenticated`, `internal`, `admin` | Allows user, admin, and guest browser sessions; denies anonymous callers and plain agents. |

MCP policy is keyed by `agent + tool`.

| MCP Access | User | Admin User | Guest | Agent |
| --- | --- | --- | --- | --- |
| `authenticated` | Allow | Allow | Allow | Deny |
| `admin` | Deny | Allow | Deny | Deny |
| `internal` | Deny | Deny | Deny | Allow |

Agents do not satisfy `authenticated` directly. A verified source agent can
call an authenticated target tool only through a User Delegation Grant that the
router minted for a real user and scoped to the source agent, target agent,
target tool, allowed scopes, and expiry. Guests never receive such grants.

## Token Families and Services

The refactor separates token handling into explicit token-family services.
There is no generic `JwtService` and no polymorphic `mintJwt(type, payload)`
API.

| Service | Responsibility |
| --- | --- |
| `JwsCodec` | Thin injectable wrapper over JWS signing and verification primitives. |
| `SessionTokenService` | User/guest session lookup and `typ` separation. It is policy-free. |
| `RouterRequestTokenService` | Router Request payload construction, 30-second TTL clamp, target-agent signing. |
| `AgentAssertionService` | Source Agent Assertion verification against the source agent secret and request binding. |
| `UserDelegationGrantService` | Router-issued delegation grant minting and verification; rejects guests. |

### User Session and Guest Session

| Session | Cookie | `typ` | Audience | Satisfies HTTP `authenticated`? |
| --- | --- | --- | --- | --- |
| User Session | `ploinky_jwt` | `user-session` | `ploinky-router` | Yes, if valid for the route. |
| Guest Session | `ploinky_guest` | `guest-session` | `ploinky-router` | No. |

The token verifier may parse both user and guest session JWTs, but
`SessionTokenService.getUserSession()` returns only `user-session`, and
`getGuestSession()` returns only `guest-session`. This structural separation is
what prevents a guest JWT placed in `ploinky_jwt` from satisfying an
authenticated route.

### Agent Assertion

An Agent Assertion is signed by a source agent with its own
`PLOINKY_AGENT_SECRET` and sent to the router when the source agent wants to
call another agent through MCP.

| Claim / Property | Rule |
| --- | --- |
| `typ` | `agent-assertion` |
| `iss` / `sub` | Source agent id, such as `agent:repo/name`. |
| `aud` | `ploinky-router` |
| Request binding | Method, path, target agent, tool, and request-content hash must match the live request. |
| Replay | `jti` is single-use within the replay window. |

Identity is not authorization. After verifying the assertion, the router still
applies MCP policy before minting a target Router Request.

### Router Request

A Router Request is signed by the router with the target agent's own secret and
verified by the target agent.

| Claim / Property | Rule |
| --- | --- |
| `typ` | `router-request` |
| `iss` | `ploinky-router` |
| `aud` | Target agent id. |
| TTL | Clamped to at most 30 seconds. |
| Request binding | Method, path, optional tool, and request-content hash must match the received operation. |
| Optional fields | Omitted when absent to preserve byte-compatible payload shape. |
| Delegation fields | Singular `delegation` and plural `delegations` remain distinct. |

Router Requests are the only tokens agents trust for executing router-mediated
MCP tools, resource reads, task status operations, and scoped HTTP-service
invocations.

### Confined Agent-Port Relay

An admitted agent-port route may need to reach a service bound to the target
container's loopback, including a host-networked service. After an initial
current authorization-generation lease commit and exact immutable container,
owner, generation, label, and network-mode inspection, the Router starts
`/Agent/server/RuntimeHttpRelay.mjs` through private exec stdio. A fresh random
32-byte key exists only for that relay channel: it is carried in the framed
`HELLO`, never injected into the runtime environment or argv, never echoed in
`READY` or logs, and cleared on channel close.

Inspection, helper setup, channel pooling, and token minting do not extend the
captured authorization lease. The Router re-commits that same lease after
request-token minting and immediately before every `OPEN`, which is the final
Router-controlled operation before the helper can create the target socket. A
generation that changes during setup or while a channel is idle therefore
fails with no upstream connection.

The key signs replay-protected `relay-session` and `relay-request` transport
tokens that bind the exact principal/instance/generation/container and denied
port set; each request also binds method, port, path, query, body mode, and body
hash. Replay ids remain recorded through the accepted clock-skew interval, and
cache saturation fails closed rather than evicting a live id. These tokens
establish transport integrity only. They are not a fourth
identity family, cannot authenticate to Router APIs or other agents, and do not
restore `PLOINKY_AGENT_SECRET` to an unattested host/none runtime.

### User Delegation Grant

A User Delegation Grant is a router-issued token that allows a verified source
agent to act as a real user for a narrow downstream MCP call.

| Rule | Detail |
| --- | --- |
| Issuer and audience | Router-issued and router-verified. Agents do not verify it directly. |
| Subject | Real user only. Guests are rejected at mint time and verify time. |
| Scope | Bound to source agent, target agent, target tool set, scopes, and expiry. |
| Reuse | Reusable within TTL; not a per-call replay token. |
| Carrier | Included only inside verified authenticated service auth-info or plural Router Request `delegations`. |

Because grants are reusable within their TTL, they must not be logged. The
short TTL and tight source/target/tool binding are the primary leak mitigations.

## Removed Surfaces and Non-Compatibility

The refactor intentionally removes old vocabulary and endpoints instead of
translating them.

| Removed Item | New Model |
| --- | --- |
| `/whitelist/command` | Gone; returns `404 not_found`. Use `/policy/command`. |
| `http.whitelist.*` commands | Gone. Use `http.route.*`. |
| Whitelist modules and path helpers | Gone. Use `HttpRouteAccessPath`, `HttpRouteAccessPolicy`, and `HttpRouteProviders`. |
| `protected` route/service access | Gone. Use `authenticated`. |
| Manifest/service `mode` for route access | Invalid. Use `access`. |
| Service `auth` field | Invalid. Use `access`. |
| `forceGuest` | Invalid. Use `access: "guest"` and let user sessions take precedence. |
| `publicServices` | Gone. Use `httpServices` with explicit `access`. |
| HTTP-service auth branch in `resolveAuthContext` | Gone. Services go through route access evaluator plus executor. |
| `additionalServerPort` and profile-server proxy | Gone. Use optional `httpServices[].port` for a private explicit TCP target. |
| Raw manifest/policy hot reload | Gone. Candidate bytes require coordinated generation apply. |
| Host or path fallback routing | Gone. Unknown, malformed, stale, or suffix-confusable Hosts and paths fail before dial. |

The router does not provide aliases, migration translation, or compatibility
shims for these names. Old persisted policy-state documents fail closed.

## Error Model

| Situation | Status | Error |
| --- | --- | --- |
| Public route write method | 403 | `PUBLIC_ROUTE_WRITE_DENIED` |
| Unroutable request path | 404 | `UNROUTABLE_PATH` |
| Internal route declaration | 400 | `INTERNAL_ROUTE_NOT_ALLOWED` |
| Invalid route path or wildcard | 400 | `INVALID_PATH` / `INVALID_WILDCARD` |
| Missing user session on authenticated route | 401 or login redirect | `AUTH_REQUIRED` |
| Guest session on authenticated route | 401 or login redirect | `AUTH_REQUIRED` |
| Removed `/whitelist/command` endpoint | 404 | `not_found` |
| Missing policy command auth | 401 | `AUTH_REQUIRED` |
| Unknown policy command | 400 | `UNKNOWN_COMMAND` |
| Corrupt policy state | Fail closed | `POLICY_PERSISTENCE_ERROR` or deny decision depending on caller. |

Guest-facing responses stay generic and do not confirm private resource
existence. Audit logs may retain structured deny codes but must not log tokens,
cookies, grants, or raw secrets.

## Operator Examples

### Declare Agent-Owned Routes

An agent manifest can expose read-only public documentation, guest workspace
preview pages, and authenticated account pages:

```json
{
  "routerAccess": {
    "httpRoutes": [
      { "path": "/docs/*", "access": "public" },
      { "path": "/preview/*", "access": "guest" },
      { "path": "/account/*", "access": "authenticated" },
      { "path": "/settings/*" }
    ]
  }
}
```

If the enabled route key is `writer`, these expand to:

| Manifest Path | Effective Route |
| --- | --- |
| `/docs/*` | `/writer/docs/*` |
| `/preview/*` | `/writer/preview/*` |
| `/account/*` | `/writer/account/*` |
| `/settings/*` | `/writer/settings/*` |

### Tighten a Manifest Route as an Operator

If an agent declares `/docs/*` as public but the operator wants one subtree
authenticated, set a persisted route:

```json
{
  "command": "http.route.set",
  "path": "/writer/docs/private/*",
  "access": "authenticated"
}
```

The restrictive merge rule makes the private subtree authenticated while
leaving the rest of `/writer/docs/*` public.

### Check Effective Access

`http.route.check` is the diagnostic command for effective access. It uses the
same singleton evaluator and providers as live request enforcement.

```json
{
  "command": "http.route.check",
  "path": "/writer/docs/private/readme",
  "method": "GET"
}
```

The response should identify the winning access class and source. This is more
useful than `http.route.list`, which intentionally lists only persisted
operator rows.

### Declare an Authenticated HTTP Service

An authenticated service can receive user identity and optional scoped
delegation:

```json
{
  "httpServices": [
    {
      "slug": "editor",
      "externalPrefix": "/services/editor",
      "upstreamPrefix": "/internal/editor",
      "port": 7000,
      "access": "authenticated",
      "delegations": [
        {
          "targetAgent": "repo/storage",
          "tools": ["read_file"],
          "scopes": ["workspace:read"],
          "ttlSeconds": 120
        }
      ]
    }
  ]
}
```

Delegations are valid only on authenticated services. A guest or public service
with delegation settings is invalid.

## Implementation Map

| Concern | Main Files |
| --- | --- |
| Path normalization and matching | `cli/server/policy/HttpRouteAccessPath.js` |
| Decision values and helpers | `cli/server/policy/HttpRouteAccessDecision.js` |
| Effective HTTP route evaluation | `cli/server/policy/HttpRouteAccessPolicy.js` |
| Manifest and HTTP service providers | `cli/server/policy/HttpRouteProviders.js` |
| Exact-byte policy compilation | `cli/server/policy/HttpRoutePolicyCompiler.js` |
| Immutable route plan and dial lease | `cli/server/edgeRoutePlan.js`, `cli/services/edgeGeneration.js`, `cli/services/coordinatedEdgeApply.js` |
| Host and listener classification | `cli/server/listenerInterfaceClassifier.js`, `cli/server/RoutingServer.js` |
| Private service assertions | `cli/server/privateRouter.js`, `Agent/lib/agentAssertion.mjs` |
| Persistent policy state | `cli/server/policy/PolicyStateRepository.js`, `FileSystemPolicyStateStore.js` |
| Policy commands | `cli/server/policy/commands/httpRouteCommands.js`, `mcpPolicyCommands.js`, `PolicyCommandInvoker.js` |
| HTTP executor and sessions | `cli/server/authHandlers.js`, `cli/server/auth/localService.js`, `cli/server/auth/genericAuthBridge.js` |
| Router dispatch | `cli/server/RoutingServer.js`, `cli/server/routerHandlers.js` |
| HTTP service specs and dispatch | `cli/server/httpServiceRoutes.js` |
| MCP caller classification | `cli/server/policy/Caller.js`, `McpToolPolicy.js` |
| Token services | `cli/server/security/tokens/*.js` |
| Agent-side verification | `Agent/lib/requestSignedTokens.mjs`, `Agent/lib/invocationAuth.mjs`, `Agent/lib/agentAssertion.mjs` |

## Verification Checklist

Use this checklist when reviewing changes to route access, HTTP services,
sessions, MCP policy, or token services.

| Check | Expected Result |
| --- | --- |
| HTTP vocabulary | Only `public`, `guest`, and `authenticated` are accepted. |
| Fail closed | Missing, `none`, `deny`, unknown, corrupt, and unbound-provider decisions deny. |
| Public writes | Non-`GET`/`HEAD` public requests return `PUBLIC_ROUTE_WRITE_DENIED`. |
| Guest precedence | Local and SSO user sessions take precedence over guest minting. |
| Guest separation | `guest-session` JWT in `ploinky_jwt` never satisfies authenticated route access. |
| Route defaults | Static user-auth deference yields `authenticated`; otherwise no-auth routes default to `guest`, never public. |
| Internal paths | Literal and encoded `__agent` are blocked in path normalization, front-door dispatch, and synthesized upstream handling. |
| HTTP services | Services use the same evaluator and executor path; an invalid service candidate prevents the affected generation from installing. |
| Candidate isolation | Raw routing, manifest, and policy edits have no runtime effect before coordinated apply. |
| Transport parity | HTTP, SSE, and WebSocket select and revalidate the same route-and-policy generation before dial. |
| Host-first closure | Unknown, malformed, stale, and suffix-confusable Hosts fail before pathname dispatch or upstream connection. |
| Private calls | Effective authenticated admission, exact current caller ACL, and request/body/replay-bound assertion are all required. |
| Policy state | Old or corrupt `policy-state.json` fails the whole document closed. |
| MCP guests | Guests never satisfy `internal` or `admin` and never receive User Delegation Grants. |
| Router Requests | `typ: "router-request"`, 30-second TTL clamp, optional fields omitted when absent. |
| Token boundary | No generic `JwtService`; no generic `mintJwt(type, payload)`. |
| Removed surface | `/whitelist/command` returns 404; old command namespaces and modules are absent. |

## Runtime Matrix

A started workspace on port 8080 should satisfy the following probes:

| Request | Expected Result |
| --- | --- |
| `GET /<agent>/public/readme` where route is `public` | `200`, no `Set-Cookie`. |
| `POST /<agent>/public/readme` where route is `public` | `403 PUBLIC_ROUTE_WRITE_DENIED`. |
| `GET /<agent>/guest/page` where route is `guest` and no cookies | `200`, `Set-Cookie: ploinky_guest=...`. |
| `GET /<agent>/index.html` where route auth is `none` behind a local-auth static agent | Login redirect or `401`; never anonymous pass-through. |
| `GET /<agent>/auth/x` with `Cookie: ploinky_jwt=<guest-session>` | Login redirect or `401`; never `200`. |
| `GET /<agent>/a//b` | `404 UNROUTABLE_PATH`. |
| `GET /<agent>/a%2Fb` | `404 UNROUTABLE_PATH`. |
| `GET /<agent>/__agent/x` | `404 not_found`. |
| `GET /%5F%5Fagent/x` | `404 not_found`. |
| `POST /whitelist/command` | `404 not_found`. |
| `POST /policy/command` with no cookie | `401 AUTH_REQUIRED`. |

## Deployment Limits

The managed runtime supports an explicitly configured Cloudflare edge while
remaining an operator-controlled workspace runtime rather than a hostile
multi-tenant platform. Local-only mode has no connector and no public HTTP
hostname. An existing tunnel uses separate connector-token and least-privilege
API-token handles. A connector-only declaration leaves ingress and DNS under
external operator control. A Ploinky-managed declaration instead supplies
account, zone, requested tunnel name, and an API-token handle. Ploinky records a
unique ownership intent before creation, fetches the resulting connector token
only into memory, and manages ingress and DNS. Managed tunnel deletion is
disabled by default and, when explicitly enabled, requires an exact ownership
registry match. A name change allocates a new tunnel but does not delete the old
allocation; the old requested name must receive its own explicit empty-host
teardown. Invalid or incomplete configuration fails closed; quick tunnels are
never created.

| Limit | Impact |
| --- | --- |
| Router network exposure | The physical-host Router mapping is loopback-only. Public HTTP, when configured, reaches fixed in-box `127.0.0.1:8080` through the supervised outbound cloudflared connector; private `8081` is never published. |
| CSRF/origin checks | Every TCP admin/control/status handler requires a real admin session; every mutation also requires exact Origin and session-bound CSRF. Product services still need their own narrow Origin/body contracts. |
| Login rate limiting | Local/SSO auth flows need deployment-level protection for untrusted networks. |
| Upload quotas | Blob and upload routes need quota controls before broad exposure. |
| Dashboard command execution | Dashboard command routes remain trusted-operator surfaces. |
| Limited technical API keys | Deferred; they are not folded into `public` or `guest`. |

## Summary

The new security model reduces HTTP reachability to one route access decision:
`public`, `guest`, or `authenticated`. It composes operator policy, manifest
routes, HTTP services, and route defaults into one exact-byte immutable route
and policy generation, then enforces and revalidates that captured generation
before any HTTP, SSE, or WebSocket dial. Exact listener and Host select a closed
surface before path dispatch. Guests are first-class anonymous identities, not users.
Authenticated routes structurally reject guest JWTs. MCP tool policy remains a
separate domain with its own values. Token handling is split into explicit
services so User Sessions, Agent Assertions, Router Requests, and User
Delegation Grants cannot blur into a generic JWT mechanism.
