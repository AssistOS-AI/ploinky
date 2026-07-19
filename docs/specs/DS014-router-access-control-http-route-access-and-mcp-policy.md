---
id: DS014
title: Router Access Control - HTTP Route Access and MCP Tool Policy
status: implemented
owner: ploinky-team
summary: Defines fail-closed HTTP/MCP policy compilation into exact-byte immutable generations, pathname-complete partitions, private policy composition, and coordinated administration.
---

# DS014 Router Access Control: HTTP Route Access and MCP Tool Policy

## Introduction

The router is the only public control point. It owns two fail-closed policy domains:

| Domain | Values | Scope |
| --- | --- | --- |
| HTTP route access | `public`, `guest`, `authenticated` | Browser HTTP routes and declared HTTP services. |
| MCP tool policy | `authenticated`, `internal`, `admin` | Agent tools and resources invoked through router MCP surfaces. |

HTTP route access answers whether a browser HTTP request may be proxied and which router identity is required before proxying. MCP tool policy answers whether a router-authenticated user, verified agent, or admin user may invoke a tool or read a resource. The domains share persistence and administrative plumbing, but their value sets remain separate.

## Core Content

### The Five Access Classes

This model still accounts for the five caller classes Ploinky cares about:

| Class | Carrier | Where it lives now |
| --- | --- | --- |
| Fully public | No user, no agent | HTTP route access `public`: allowed only when an enabled `public` declaration matches and the method is `GET` or `HEAD`. Route defaults never produce `public`; anonymous read access is always explicit. |
| Protected public | Anonymous temporary token or limited API key; identity never becomes a user | The browser half is HTTP route access `guest`: the router mints a `guest-session` JWT, a temporary anonymous identity that never satisfies `authenticated`, never receives delegation grants, and never becomes a user. Operator-issued limited API keys for cookie-less technical integrations remain deferred as a separate credential checked before route access; they are not route-access values. |
| Authenticated | User Session JWT | HTTP route access `authenticated`, plus MCP tool policy `authenticated` for tool calls. Guest sessions do not satisfy this class. |
| Internal MCP | Agent Assertion JWT | MCP tool policy `internal`: only verified agent callers satisfy it. Sessions and admin roles do not. |
| Admin MCP | Admin user session | MCP tool policy `admin`: requires an admin user. Guests are never admin. |

### HTTP Route Access

The only valid HTTP route access values are `public`, `guest`, and `authenticated`. Manifest `routerAccess.httpRoutes` entries that omit `access` default to `authenticated`; this is a manifest-route default only. Persisted `httpRoutes`, declared `httpServices`, retired values, unknown values, disabled entries, corrupt state, and invalid paths deny when access is missing or invalid.

An HTTP route decision may come from four sources:

| Source | Ownership | Notes |
| --- | --- | --- |
| Persisted `httpRoutes` | Operator/admin policy in `policy-state.json` | Staged by `http.route.set`; effective only after coordinated generation apply. |
| Manifest `routerAccess.httpRoutes` | Agent self-declaration | Captured from exact manifest bytes during coordinated apply; omitted `access` is `authenticated`. |
| Manifest `httpServices` | Agent service declaration | The Host-selected service is canonicalized to its external prefix before its provider is compiled. |
| Route default | Router fallback for ordinary transparent routes | Preserves static-agent deference: `auth.mode: "none"` behind a user-authenticated static agent becomes `authenticated`; otherwise it becomes `guest`. Defaults never produce `public`. |

When entries overlap, the router chooses the most restrictive access: `authenticated` over `guest` over `public`. `public` allows only `GET` and `HEAD`; write methods receive `403 PUBLIC_ROUTE_WRITE_DENIED` before proxying. `guest` accepts an existing local or SSO user session first; only requests without a user session mint or reuse `ploinky_guest`. `authenticated` requires a real user session and rejects guest-session JWTs even if they arrive in the `ploinky_jwt` cookie.

`HttpRouteAccessPath` normalizes route paths. It requires a leading slash; strips query and fragment data; rejects NUL bytes, URL schemes, backslashes, double slashes, encoded slash or backslash bytes, dot segments, root-only paths, non-trailing wildcards, and router-owned internal paths. A trailing `/*` is a prefix match; other `*` usage is invalid. Literal and percent-encoded `__agent` segments are internal and denied at write time, policy evaluation time, the `RoutingServer` request front door, and the synthesized-upstream guard for HTTP services.

### Why Manifest Routes Are Never Copied Into Operator Policy

Manifest `routerAccess.httpRoutes` are generation inputs captured from exact
enabled-manifest bytes. They are never copied into `policy-state.json`, because
doing so would:

- mix operator policy with agent-owned declarations in one collection;
- leave stale copies after an agent redeploy or manifest edit;
- make removal ambiguous when an agent or declaration disappears.

Persisted `httpRoutes` remain exclusively operator/admin policy staged through
`POST /policy/command`. Manifest, service, route-default, and persisted inputs
compose during coordinated compilation. The installed immutable route-and-policy
authorization generation—not a timestamp cache, topology publication counter,
or raw file read—is the only authorization state.

### HTTP Services

Declared HTTP services use the same evaluator as ordinary routes. A valid
service declaration must provide a validated slug, external prefix, internal
upstream prefix, optional integer target port, and `access` with one of
`public`, `guest`, or `authenticated`. A dedicated Host selects one declared
service and canonicalizes the request to that service's external prefix before
`createHttpServiceProvider` is evaluated. Invalid, ambiguous, or unresolved
declarations keep every affected selector inactive.

The manifest-route omitted-access default does not apply to HTTP services. A service without explicit `access` is invalid and is not mounted.

`public` services run without router identity. `guest` services use an existing local or SSO user session when present, otherwise they mint or reuse a scoped guest session. `authenticated` services require user authentication using the owning route policy first and the static route policy as fallback. Only authenticated services may receive user delegation grants. Authenticated and guest services receive scoped `__http_service__` invocation metadata unless the manifest disables invocation minting.

After a guest service's host and effective policy are validated, HTTP, SSE, and
WebSocket execution also receives one Router-owned
`x-ploinky-rate-source: <64 lowercase hex>` abuse-control partition. It is a
route-scoped HMAC of the canonical Cloudflare source address for an active
public host, or of the Router-observed TCP peer for a local alias. It is stable
across guest-cookie replacement for the same transport source, contains no raw
address/session/user value, and is not an authorization input. Missing or
malformed public-host source metadata fails before dial. Caller-supplied
partitions and raw source headers are stripped, and the narrow ingestion proxy
must remove the Router partition before its application upstream.

Private service execution on listener `8081` does not bypass this evaluator. Its
canonical POST partitions must have an effective `authenticated` decision and
the caller must separately match the exact current-instance/current-enable-
generation ACL with a request-bound replay-protected assertion. A valid user
session without the ACL, or a valid assertion without authenticated policy,
fails before dial.

Compilation is pathname-complete. For every selected host namespace it builds
representatives for every match-set partition formed by intersecting exact and
wildcard provider paths, records the winning provider, route key, effective
guest scope, and GET/HEAD/write outcome, and rejects access-relevant equal-rank
ambiguity only when execution metadata differs. Equivalent public ties carry no
execution metadata; guest ties compare effective scope; authenticated ties
compare route key.

### MCP Tool Policy

The MCP policy identifier is `agent + tool`. Valid access values are `authenticated`, `internal`, and `admin`. Missing policy, disabled entries, unknown values, invalid tag defaults, or corrupt state deny.

| MCP access | User | Admin user | Guest | Agent |
| --- | --- | --- | --- | --- |
| `authenticated` | allow | allow | allow | deny |
| `admin` | deny | allow | deny | deny |
| `internal` | deny | deny | deny | allow |

There is one delegated-user path: a verified source agent may call an `authenticated` target tool only when it also presents a router-issued User Delegation Grant bound to that source agent, target agent, target tool, scope, and expiry. Guests never receive User Delegation Grants and never satisfy `internal` or `admin`.

`tools/list` and aggregate list operations filter out tools the caller cannot invoke. Resources remain an authenticated-class capability: user, admin, and guest sessions may read through the resource gate, while agents and anonymous callers are denied.

### Administrative Surface

`POST /policy/command` is the authenticated administrative endpoint. It is
router-owned, local-control-host-only, and cannot be opened through HTTP route
access. It requires a real admin/share-authorized user session as specified
below plus exact Origin/CSRF for mutations. Agent Assertions, Router Requests,
delegations, private assertions, and LiveKit JWTs are rejected as admin
credentials.

| Command | Caller | Effect |
| --- | --- | --- |
| `http.route.set` | admin, or a normal user approved by the owning agent's share authorizer | Inactivate affected selectors, stage the entry, compile and atomically install a valid generation before acknowledgement. |
| `http.route.remove` | admin, or share-authorized user | Inactivate affected selectors, stage removal, and atomically install the valid replacement generation before acknowledgement. |
| `http.route.check` | authenticated browser user | Return the effective decision for one path and method using the same singleton evaluator and providers as dispatch. |
| `http.route.list` | authenticated browser user | Return only persisted operator entries. |
| `mcp.policy.set` | admin only | Set access for an agent tool. |
| `mcp.policy.get` | admin only | Read one tool policy entry. |
| `mcp.policy.list` | admin only | List tool policy entries. |

`http.route.list` is not the effective view because manifest, service, and route-default decisions are runtime inputs. `http.route.check` is the diagnostic path for the effective decision and includes the source that won.

The router-owned Marketplace API under `/api/marketplace` is not administered through MCP policy and is not controlled by HTTP route access. `GET /api/marketplace` must require an authenticated local or SSO user. `POST /api/marketplace` is an administrative surface and must require an authenticated local admin user before mutating repository and agent marketplace state. The POST action body may install and uninstall repositories through `install_repo` and `uninstall_repo`, enable agents through the standard registry path, and perform marketplace-specific agent deactivation as defined by DS005.

### Tag Bootstrap and Persistence

`mcp-config.json` tool tags seed defaults only. Empty or absent tags seed `authenticated`; `internal` seeds `internal`; `admin` seeds `admin`; mixed or unknown access tags seed no entry, so enforcement denies until an admin sets policy. Persisted operator entries always win and are never overwritten by bootstrap.

`data/router-security/policy-state.json` uses schema `router-policy` under the
workspace `.ploinky/` directory, but it is staging state rather than live
authorization. Coordinated apply captures every input's exact bytes, computes a
content digest, inactivates affected selectors before acknowledgement, validates
all source-health and pathname partitions, and installs the immutable
route-and-policy authorization generation atomically. Same-size/same-mtime replacement has no live
effect before apply. HTTP, SSE, and WebSocket hold an authorization-to-dial
lease and revalidate it immediately before upstream connection creation.

An unreadable candidate, a corrupt active digest on restart, schema-invalid
input, or a crash between inactivation and installation leaves no selector
active. Contract 5 never translates, skips, repairs, imports, deletes, or falls
back to old state. The operator repairs the staged source and invokes the normal
coordinated apply; the invalid generation is not resurrected.

### Internal Paths

Router-owned surfaces are never controlled by HTTP route access. This includes
`/policy/command`, `/api/marketplace`, `/auth`, `/auth/*`, `/admin`, `/admin/*`,
`/metrics`, the bare root, root wildcards, and any path containing an `__agent`
segment in raw, encoded, or double-encoded form. Detailed health is absent from
TCP. Before any path check, the listener/interface plus exact Host selects a
closed surface: service hosts receive only their service and exact auth
transactions; agent-root hosts receive only explicitly selected named
`routerSurfaces`; managed/private traffic receives only private handlers.

Transparent agent proxying strips caller-supplied identity and source headers and regenerates router-owned headers only after the access decision has been satisfied. Guest ingestion receives a route-scoped transport-source partition for rate limiting; it is not user identity and cannot authorize a request.

### Errors

| Situation | HTTP | Code |
| --- | --- | --- |
| Missing session, guest on an authenticated route, or no route identity available | 401 | `AUTH_REQUIRED` |
| Public write method | 403 | `PUBLIC_ROUTE_WRITE_DENIED` |
| Unroutable request path | 404 | `UNROUTABLE_PATH` |
| Internal route entry | 400 | `INTERNAL_ROUTE_NOT_ALLOWED` |
| Invalid path or wildcard | 400 | `INVALID_PATH` / `INVALID_WILDCARD` |
| Unknown command | 400 | `UNKNOWN_COMMAND` |
| Missing policy entry | 404 | `POLICY_ENTRY_NOT_FOUND` |
| Non-admin caller on admin-only command or tool | 403 | `ADMIN_REQUIRED` |
| Agent lacks policy for a tool | 403 | `AGENT_POLICY_DENIED` |
| Persistence failure or corrupt state | 500 | `POLICY_PERSISTENCE_ERROR` |
| Inactive or superseded generation lease | 503 | `ROUTING_GENERATION_INACTIVE` |

Guest-facing errors stay generic and never confirm that a private resource exists. Audit records may keep the exact deny code but never tokens or secrets.

## Decisions & Questions

### Question #1: Why keep HTTP route access and MCP tool policy separate?
Response: They answer different questions over different identifiers. A browser path says nothing about tool execution, and an agent tool policy says nothing about browser reachability. Keeping the domains separate keeps the evaluator small and auditable while still sharing persistence and admin plumbing.

### Question #2: Why are only three HTTP route access values allowed?
Response: The router needs one closed vocabulary for HTTP decisions. `public` means anonymous `GET`/`HEAD`, `guest` means an anonymous expiring guest identity or an existing user session, and `authenticated` means a real user session. Any other value is ambiguous and therefore denied.

### Question #3: Why do defaults never produce `public`?
Response: Anonymous access must be explicit. Defaults exist only to preserve ordinary route behavior: user-authenticated static agents stay user-authenticated, and open or guest-auth routes become guest identity routes rather than no-session pass-through.

### Question #4: Why are raw manifest route edits not runtime authorization?
Response: A path decision is safe only when route target, host selector, all
policy providers, caller ACLs, and source health were validated together. Raw
edits can represent a partial or same-timestamp replacement, so they remain
candidate input until coordinated apply installs one exact-byte generation.

### Question #5: Why does corrupt generation state recover inactive?
Response: If validation cannot prove every route, target, policy entry, and
digest belongs to the same installed generation, using any subset could remove a
restrictive rule or dial a stale target. Contract 5 therefore installs no
selector until repaired candidate bytes pass a new coordinated apply; deletion,
translation, or an older-generation fallback is not a recovery path.

## Conclusion

Ploinky now has one HTTP route access evaluator for browser routes and HTTP services, with exactly `public`, `guest`, and `authenticated` as HTTP values. MCP tool policy keeps its own `authenticated`, `internal`, and `admin` vocabulary. Both domains fail closed on corrupt state, unknown values, invalid paths, unbound providers, and internal routes; both are administered through `/policy/command`; and both compose with DS013's per-agent token model without granting guests user delegation or internal/admin MCP authority.
