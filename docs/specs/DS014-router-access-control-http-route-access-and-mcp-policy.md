---
id: DS014
title: Router Access Control - HTTP Route Access and MCP Tool Policy
status: implemented
owner: ploinky-team
summary: Defines HTTP route access and MCP tool policy, their fail-closed evaluation, administrative commands, runtime manifest composition, and corrupt-state handling.
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
| Persisted `httpRoutes` | Operator/admin policy in `policy-state.json` | Written by `http.route.set`; listed by `http.route.list`. |
| Manifest `routerAccess.httpRoutes` | Agent self-declaration | Evaluated at runtime from enabled manifests; never written to policy state. Omitted `access` is `authenticated`; explicit values must be `public`, `guest`, or `authenticated`. |
| Manifest `httpServices` | Agent service declaration | Converted to route access for the external service prefix. |
| Route default | Router fallback for ordinary transparent routes | Preserves static-agent deference: `auth.mode: "none"` behind a user-authenticated static agent becomes `authenticated`; otherwise it becomes `guest`. Defaults never produce `public`. |

When entries overlap, the router chooses the most restrictive access: `authenticated` over `guest` over `public`. `public` allows only `GET` and `HEAD`; write methods receive `403 PUBLIC_ROUTE_WRITE_DENIED` before proxying. `guest` accepts an existing local or SSO user session first; only requests without a user session mint or reuse `ploinky_guest`. `authenticated` requires a real user session and rejects guest-session JWTs even if they arrive in the `ploinky_jwt` cookie.

`HttpRouteAccessPath` normalizes route paths. It requires a leading slash; strips query and fragment data; rejects NUL bytes, URL schemes, backslashes, double slashes, encoded slash or backslash bytes, dot segments, root-only paths, non-trailing wildcards, and router-owned internal paths. A trailing `/*` is a prefix match; other `*` usage is invalid. Literal and percent-encoded `__agent` segments are internal and denied at write time, policy evaluation time, the `RoutingServer` request front door, and the synthesized-upstream guard for HTTP services.

### Why Manifest Routes Are Never Persisted

Manifest `routerAccess.httpRoutes` are runtime declarations, evaluated fresh from the enabled agent manifest using the provider cache. They are never written into `policy-state.json`, because persisting them would:

- mix operator policy with agent-owned declarations in one collection;
- leave stale copies after an agent redeploy or manifest edit;
- make removal ambiguous when an agent or declaration disappears.

Persisted `httpRoutes` are exclusively operator/admin policy written through `POST /policy/command`. Manifest and service declarations compose in memory with persisted entries on every decision, and the restrictive merge rule lets an operator entry tighten any agent declaration without letting an agent weaken operator policy.

### HTTP Services

Declared HTTP services use the same evaluator as ordinary routes. A valid service declaration must provide an external prefix, an internal upstream prefix, and `access` with one of `public`, `guest`, or `authenticated`. Invalid service declarations are logged and only that service is left unmounted; collection never throws into the request path.

The manifest-route omitted-access default does not apply to HTTP services. A service without explicit `access` is invalid and is not mounted.

`public` services run without router identity. `guest` services use an existing local or SSO user session when present, otherwise they mint or reuse a scoped guest session. `authenticated` services require user authentication using the owning route policy first and the static route policy as fallback. Only authenticated services may receive user delegation grants. Authenticated and guest services receive scoped `__http_service__` invocation metadata unless the manifest disables invocation minting.

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

`POST /policy/command` is the authenticated administrative endpoint. It is router-owned and cannot be opened through HTTP route access. Agents cannot present a browser session cookie and are rejected.

| Command | Caller | Effect |
| --- | --- | --- |
| `http.route.set` | admin, or a normal user approved by the owning agent's share authorizer | Add or update a persisted route entry. |
| `http.route.remove` | admin, or share-authorized user | Remove a persisted route entry. |
| `http.route.check` | authenticated browser user | Return the effective decision for one path and method using the same singleton evaluator and providers as dispatch. |
| `http.route.list` | authenticated browser user | Return only persisted operator entries. |
| `mcp.policy.set` | admin only | Set access for an agent tool. |
| `mcp.policy.get` | admin only | Read one tool policy entry. |
| `mcp.policy.list` | admin only | List tool policy entries. |

`http.route.list` is not the effective view because manifest, service, and route-default decisions are runtime inputs. `http.route.check` is the diagnostic path for the effective decision and includes the source that won.

### Tag Bootstrap and Persistence

`mcp-config.json` tool tags seed defaults only. Empty or absent tags seed `authenticated`; `internal` seeds `internal`; `admin` seeds `admin`; mixed or unknown access tags seed no entry, so enforcement denies until an admin sets policy. Persisted operator entries always win and are never overwritten by bootstrap.

`data/router-security/policy-state.json` uses schema `router-policy` under the workspace `.ploinky/` directory. Reads are cached by the store version. Writes are atomic. A corrupt or schema-invalid document fails closed: HTTP route access and MCP tool policy both deny, and mutation refuses to overwrite the document.

Old state documents with missing or retired HTTP access vocabulary fail the whole document closed. Remediation is to delete `.ploinky/data/router-security/policy-state.json`, restart the router so MCP defaults bootstrap from `mcp-config.json`, and re-add HTTP route entries through `http.route.set`.

### Internal Paths

Router-owned surfaces are never controlled by HTTP route access. This includes `/policy/command`, `/auth`, `/auth/*`, `/admin`, `/admin/*`, `/metrics`, `/health/internal`, the bare root, root wildcards, and any path containing an `__agent` segment in raw, encoded, or double-encoded form. The `RoutingServer` front-door guard and the routerHandlers synthesized-upstream guard both enforce the same segment rule as `HttpRouteAccessPath`.

Transparent agent proxying strips caller-supplied identity headers and regenerates router-owned headers only after the access decision has been satisfied.

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

Guest-facing errors stay generic and never confirm that a private resource exists. Audit records may keep the exact deny code but never tokens or secrets.

## Decisions & Questions

### Question #1: Why keep HTTP route access and MCP tool policy separate?
Response: They answer different questions over different identifiers. A browser path says nothing about tool execution, and an agent tool policy says nothing about browser reachability. Keeping the domains separate keeps the evaluator small and auditable while still sharing persistence and admin plumbing.

### Question #2: Why are only three HTTP route access values allowed?
Response: The router needs one closed vocabulary for HTTP decisions. `public` means anonymous `GET`/`HEAD`, `guest` means an anonymous expiring guest identity or an existing user session, and `authenticated` means a real user session. Any other value is ambiguous and therefore denied.

### Question #3: Why do defaults never produce `public`?
Response: Anonymous access must be explicit. Defaults exist only to preserve ordinary route behavior: user-authenticated static agents stay user-authenticated, and open or guest-auth routes become guest identity routes rather than no-session pass-through.

### Question #4: Why are manifest route declarations runtime-only?
Response: Agent manifests are the agent's source of truth and may change independently from operator policy. Runtime composition removes stale rows automatically when the manifest or agent disappears, while persisted policy remains an operator-owned audit trail.

### Question #5: Why does an old policy-state file fail the whole document closed?
Response: HTTP and MCP policy share one persisted security document. If validation cannot prove every entry uses the current schema, the router refuses to reason from partial data. Operators recover by deleting the file, restarting, and re-adding the intended route entries.

## Conclusion

Ploinky now has one HTTP route access evaluator for browser routes and HTTP services, with exactly `public`, `guest`, and `authenticated` as HTTP values. MCP tool policy keeps its own `authenticated`, `internal`, and `admin` vocabulary. Both domains fail closed on corrupt state, unknown values, invalid paths, unbound providers, and internal routes; both are administered through `/policy/command`; and both compose with DS013's per-agent token model without granting guests user delegation or internal/admin MCP authority.
