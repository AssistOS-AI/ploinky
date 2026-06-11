---
id: DS014
title: Router Access Control - HTTP Whitelist and MCP Tool Policy
status: implemented
owner: ploinky-team
summary: Defines the router's two access-control collections - the httpRoutes read-only public whitelist and the mcpTools agent+tool policy - their fail-closed evaluation, tag bootstrap, single administrative endpoint, and persistence.
---

# DS014 Router Access Control: HTTP Whitelist and MCP Tool Policy

## Introduction

The router is the only public control point. Previously it decided access per-request from `routing.json` + manifest `auth.mode` + invocation-JWT claims, with no persisted, operator-managed access policy. This document defines two independent, fail-closed policy collections the router owns: `httpRoutes` (may a guest reach a read-only HTTP route?) and `mcpTools` (may a user or agent invoke an MCP tool?), administered through a single endpoint. It builds on the per-agent identity model of DS013 and the routing surfaces of DS005. Both collections live in `cli/server/policy/`, composed by `index.js` from focused classes: `PolicyStateRepository` (policy-state domain logic over a pluggable `PolicyStateStore`), `HttpRouteWhitelist` + `WhitelistPath` (HTTP rules), `McpToolPolicy` + `Caller` (MCP decisions), `HttpShareAuthorizer` (the share bridge), `PolicyAuditLog` (audit, over a pluggable `PolicyAuditSink`), and a Command bus (`PolicyCommandInvoker`, `PolicyCommandRegistry`, `commands/`) behind the admin endpoint.

## Core Content

### Five Access Types

| Type | Caller | Rule |
| --- | --- | --- |
| Fully public | guest | path in `httpRoutes` and method is `GET`/`HEAD` |
| Protected public | anonymous token / limited API key | technical identity for rate-limit/expiry/revocation _(deferred — plan Phase 8)_ |
| Authenticated | user (or a guest that passed the agent's route auth) | valid session and `mcpTools` permits |
| Internal MCP | agent | valid Agent Assertion and `mcpTools` permits |
| Admin MCP | admin user | admin role and `mcpTools` permits |

Classes are narrow: an admin user does not get `internal`; an agent does not get `admin` or `authenticated`. The `authenticated` class admits both `user` and `guest` callers because a guest only reaches an agent's MCP surface after passing that agent's route-level guest auth (DS005); sensitive tools must be tagged `admin` or `internal`, which deny guests. `McpToolPolicy.evaluate({ agent, tool, caller })` (`McpToolPolicy.js`) is the single decision function; `Caller.fromRequest` (`Caller.js`) classifies the request as `user`/`guest`/`agent`/`none` and computes admin status (a guest is never admin).

### HTTP Route Whitelist (`httpRoutes`)

The identifier is the normalized path. `WhitelistPath.normalize` (`WhitelistPath.js`) requires a leading `/` and rejects URL schemes, fragments, backslashes, NUL bytes, double slashes, encoded slashes/backslashes (`%2f`/`%5c`), `.`/`..` segments, and the bare root `/`. The query string is stripped and never participates. A wildcard is valid only as a trailing `/*` (a prefix match), never a glob; any other `*` is `INVALID_WILDCARD`. A stored `…/*` entry matches a request path that equals the prefix or begins with `prefix + "/"`; a non-wildcard entry matches only an exact path. Whitelist checks apply only to `GET`/`HEAD`; a `POST` to a whitelisted path is not public.

Accept/reject examples: `/explorer/public-view/folder/*` accepts (and covers `/explorer/public-view/folder/readme.md`); `explorer/public-view` (no leading slash), `/explorer/../secret` (traversal), `/%2Fsecret` (encoded slash), `/explorer/*/file` and `/*/edit` and `/**` (mid/double wildcard) all reject.

### Internal (Non-Whitelistable) Routes

`/whitelist/command`, `/auth` and `/auth/*`, `/admin` and `/admin/*`, any path with an `__agent` segment (`/__agent/*` and `/<agent>/__agent/*`), `/metrics`, `/health/internal`, the bare root `/`, and the root wildcard `/*` are internal. `WhitelistPath.isInternal` enforces this both at write time (the add/remove commands return `INTERNAL_ROUTE_NOT_ALLOWED`) and at match time (`HttpRouteWhitelist.isReachableByGuest` rejects an internal request path, and ignores any internal entry in a hand-corrupted state file), so a corrupted state cannot open a private route, and a broad wildcard entry cannot expose an internal sub-route. Root forms are reserved router-owned in `RoutingServer.isRouterOwnedPath`; additionally, `hasInternalAgentSegment` (`cli/server/internalAgentPath.js`) refuses any path with an `__agent` segment — raw or percent-encoded (`%5F%5Fagent`) — at the very top of the request dispatch (before auth, http-service routing, and passthrough), and again on the synthesized upstream path of an `httpServices` route so an `internalPrefix` cannot rewrite an innocent external path into an agent control-plane path. An authenticated user therefore cannot reach `/<agent>/__agent/*` (e.g. the share-authorizer control plane); the router reaches those itself with a minted Router Request over a direct loopback call. All transparent agent proxying also strips caller-supplied identity headers.

### MCP Tool Policy (`mcpTools`) and Access Classes

The identifier is `agent + tool`. `access ∈ {authenticated, internal, admin}`. Missing policy, a disabled entry, an unknown access class, or a corrupt state file all deny (`AGENT_POLICY_DENIED`, or `POLICY_PERSISTENCE_ERROR` when corrupt). The class/caller matrix:

| `access` | user | admin user | guest | agent |
| --- | --- | --- | --- | --- |
| `authenticated` | allow | allow | allow | deny |
| `admin` | `ADMIN_REQUIRED` | allow | `ADMIN_REQUIRED` | deny |
| `internal` | deny | deny | deny | allow |

There is one narrow exception to the plain `agent` deny for `authenticated`: a verified delegated-user agent call may satisfy `authenticated` only when all of the following are true at once:

- the source agent first proves its identity with a valid Agent Assertion
- the router also verifies a router-issued User Delegation Grant bound to that same source agent
- the grant names the exact target agent and exact tool being invoked
- the tool policy for that `agent + tool` is `authenticated`

The User Delegation Grant may have reached the source agent through a protected HTTP-service `x-ploinky-auth-info` carrier or through the plural `delegations` claim on a Router Request for a user-originated MCP tool. In the MCP case the grant is minted only after the router has already accepted the user's session, allowed the source tool under `mcpTools`, and matched a configured `mcp-config.json` delegation entry for that exact source tool. Guests never receive MCP-minted delegations. This delegated-user path is intentionally narrower than a direct authenticated browser call because it is tool-scoped, source-bound, scope-bound, time-bound, and router-verified.

Enforcement runs before any Router Request is minted, on both the per-agent proxy (`cli/server/mcp-proxy/index.js`, `tools/call`) and the aggregate surface (`cli/server/routerHandlers.js`, `callEntryTool`). `tools/list` on both surfaces is filtered to the caller's class so a caller never sees a tool it cannot invoke.

MCP **resources** (`resources/read`, `resources/list`) are not part of the `agent + tool` model — per-resource `admin`/`internal` tagging is deferred (plan Phase 8). They are gated as an `authenticated`-class capability (`McpToolPolicy.evaluateResource`): a router-authenticated session caller (`user`/`guest`/admin) may read, while an `agent` (internal) caller is denied `AGENT_POLICY_DENIED` and an anonymous caller `AUTH_REQUIRED`. The gate runs before any Router Request is minted, on both surfaces: a denied `resources/read` is rejected, and `resources/list` returns an empty list (mirroring `tools/list` filtering) rather than leaking resource metadata.

### Tag Bootstrap and Persisted Precedence

`mcp-config.json` tool `tags` are defaults, not final policy. `accessFromTags` recognizes only access tags: empty/absent → `authenticated`, `internal` → internal, `admin` → admin; `internal`+`admin` is invalid, and any unknown tag is invalid (fail closed — the tool is left without a default so enforcement denies it until an admin sets explicit policy). At router startup `McpToolPolicy.bootstrap(routes)` (which runs `collectDefaults` then `bootstrapDefaults`) reads each enabled agent's mcp-config and creates a `source:"mcp-config"` entry for every `agent + tool` that has no persisted entry; a persisted entry (especially an admin-edited one) always wins and is never overwritten. Without this bootstrap, fail-closed enforcement would deny every tool call.

### Single Administrative Endpoint

`POST /whitelist/command` (`cli/server/policy/`) is authenticated (User Session cookie) and never whitelistable; agents cannot present a session cookie and are rejected. The endpoint is implemented as a Command bus — a `PolicyCommandInvoker` dispatches to one `WhitelistCommand` class per command via a `PolicyCommandRegistry`, over a `PolicyStateRepository`, `HttpRouteWhitelist`, `McpToolPolicy`, and `ShareAuthorizer` (DS contract unchanged). Namespaces and authorization:

| Command | Caller | Effect |
| --- | --- | --- |
| `http.whitelist.add` | admin, or a normal user the owning agent's share authorizer approves | add an exact route or `…/*` |
| `http.whitelist.remove` | admin, or share-authorized user | remove a route |
| `http.whitelist.check` | any authenticated user | is this path public? |
| `http.whitelist.list` | any authenticated user | list entries |
| `mcp.policy.set` | admin only | set `access` for `agent + tool` |
| `mcp.policy.get` | admin only | read a policy entry |
| `mcp.policy.list` | admin only | list policy entries |

Request `{ "command": "mcp.policy.set", "agent": "dpu", "tool": "dpu_agent_policy_get", "access": "admin" }`; success `{ "ok": true, "agent": "dpu", "tool": "dpu_agent_policy_get", "access": "admin" }`; error `{ "ok": false, "error": { "code": "ADMIN_REQUIRED", "message": "Admin access is required." } }`.

### Public Sharing by Normal Users (Share Authorizer)

The router cannot infer resource ownership from a path. For a normal-user `http.whitelist.add`/`remove`, it calls the owning agent (the first path segment) at `POST /<agent>/__agent/public-route-share/authorize` (a router-request authenticated control-plane call, `HttpShareAuthorizer.js`). Absent, unreachable, or non-affirmative ⇒ deny (`FORBIDDEN`). The full publish UX is deferred (plan Phase 8); this bridge keeps normal-user publishing closed by default while admins may always manage routes.

### Persistence and Atomic Writes

`data/router-security/policy-state.json` (schema `router-policy`, resolved under the workspace `.ploinky/`) is the source of truth; `policy-audit.log` is append-only JSONL. Reads are cached by (mtime, size). Writes are atomic: a temp file in the same directory is written then `fs.renameSync`d over the active file, and the in-memory index is rebuilt. A corrupt or schema-invalid file fails closed — readers report `corrupt` so callers deny, and `PolicyStateRepository.mutate` refuses to overwrite it (`POLICY_PERSISTENCE_ERROR`). Each decision appends an audit line recording the user, command, target identifiers, and ok/deny code — never tokens or secrets.

The persistence *mechanism* is decoupled behind two Strategy/Adapter ports so the store can later move to a database without touching policy logic. `PolicyStateRepository` keeps all schema validation, indexing, the read cache, the `mutate` read-modify-write transaction, and the fail-closed rules, and delegates only the raw document load/store to a `PolicyStateStore` — `currentVersion()` (an opaque version token, or `null` when nothing is persisted), `read()` (the deserialized document; throws on an undecodable payload so the repository fails closed), and `write(document)` (atomic replace). `PolicyAuditLog` likewise timestamps each record and delegates the durable append to a `PolicyAuditSink`. The default adapters are `FileSystemPolicyStateStore` and `FileSystemPolicyAuditSink` (the filesystem behavior described above; the (mtime, size) cache key is that adapter's version token); the composition root (`index.js`) is the single place the strategy is chosen. An `InMemoryPolicyStateStore` exercises the same contract with no filesystem and serves as the template for a database adapter.

### Errors

| Situation | HTTP | Code |
| --- | --- | --- |
| Missing token / guest on an authed route | 401 | `AUTH_REQUIRED` |
| User lacks rights | 403 | `FORBIDDEN` |
| Non-admin on an admin command/tool | 403 | `ADMIN_REQUIRED` |
| Agent lacks policy for a tool | 403 | `AGENT_POLICY_DENIED` |
| Invalid path / wildcard | 400 | `INVALID_PATH` / `INVALID_WILDCARD` |
| Internal route in whitelist | 400 | `INTERNAL_ROUTE_NOT_ALLOWED` |
| Unknown command | 400 | `UNKNOWN_COMMAND` |
| Duplicate / missing entry | 409 / 404 | `POLICY_ENTRY_EXISTS` / `POLICY_ENTRY_NOT_FOUND` |
| Persistence failure / corrupt state | 500 | `POLICY_PERSISTENCE_ERROR` |

Guest-facing errors stay generic and never confirm a private resource exists; the audit log may record the precise reason.

## Decisions & Questions

### Question #1: Why are the HTTP whitelist and MCP policy two separate collections?
Response: They answer different questions over different identifiers — `path` vs `agent + tool`. A public read-only route implies nothing about tool access, and a tool's access class implies nothing about HTTP reachability. Keeping them separate keeps each decision simple and auditable, and keeps the readonly path-based whitelist from ever being consulted for tool execution.

### Question #2: Why is missing policy a deny rather than a permissive default?
Response: Fail-closed. A newly added tool, an unknown access class, a disabled entry, or a corrupt state file must never become callable by accident. The boot bootstrap is what makes ordinary tools usable (it writes `authenticated` defaults from tags), so "missing" reliably means "unknown or deliberately withheld" and deny is safe.

### Question #3: Why do `mcp-config.json` tags only bootstrap defaults instead of being authoritative?
Response: An admin must be able to override agent-declared intent — for example to lock a tool down to `admin` or `internal` regardless of what the agent shipped. Persisted policy is the operator's source of truth; tags only seed entries that have no persisted decision yet, and an invalid tag set yields no default (deny) rather than a guessed one.

### Question #4: Why route all administration through one endpoint that cannot be whitelisted?
Response: A single authenticated, audited control surface is easy to reason about and to log. Whitelisting it would let the access policy administer itself anonymously, so `/whitelist/command` is reserved as an internal router-owned route and blocked from the whitelist at both write and match time.

### Question #5: Why is persistence split into a domain repository and a separate store/sink strategy?
Response: The filesystem is an implementation detail, not part of the access-control contract. `mutate(updater)` is already a backend-agnostic read-modify-write transaction, and the fail-closed validation/indexing/caching is security-critical logic that must exist in exactly one place. Putting the raw load/store behind a `PolicyStateStore`/`PolicyAuditSink` port (Strategy/Adapter) lets a database replace the JSON file by writing one small adapter, with zero re-implementation of the fail-closed rules and no change to `HttpRouteWhitelist`, `McpToolPolicy`, or the command bus. The alternative — making the repository itself an interface per backend — was rejected because it would duplicate the validation, indexing, cache, and `mutate` transaction into every backend, multiplying the surface where a fail-open bug could hide.

## Conclusion

The router owns two fail-closed access-control collections persisted in `policy-state.json`: a read-only path-based HTTP whitelist for guests and an `agent + tool` MCP policy for users and agents. Tags bootstrap defaults but persisted admin policy wins; a single audited endpoint administers both; internal routes can never be whitelisted; and corrupt or missing policy denies. Together with DS013's per-agent request-signed JWTs, this gives Ploinky an explicit, operator-managed, fail-closed access model.
