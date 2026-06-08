# Design: Command-pattern + SOLID class refactor of the router policy layer

- Date: 2026-06-05
- Status: approved design (pre-implementation)
- Scope: `ploinky/cli/server/policy/` and its three consumers (`RoutingServer.js`, `mcp-proxy/index.js`, `routerHandlers.js`) and the policy unit tests
- Relates to: DS013 (per-agent identity & request-signed JWTs), DS014 (router access control: HTTP whitelist + MCP tool policy)

## 1. Goal & non-goals

**Goal.** Re-express the router access-control policy layer — today a set of module-level functions — as a small object-oriented collection wired with SOLID principles, with the `POST /whitelist/command` administrative surface implemented via the **Command design pattern**. This is a **pure structural refactor**: every externally observable behavior and the DS013/DS014 contract stay identical.

**Non-goals.** No behavior change, no new commands, no new routes, no change to the JWT families, persistence format (`policy-state.json` schema `router-policy`), fail-closed semantics, error codes, or audit content. No refactor of code outside `cli/server/policy/` beyond the minimal call-site updates in the three consumers.

## 2. Locked decisions

1. The command bus covers **all 7 commands** on the endpoint: `http.whitelist.{add,remove,check,list}` and `mcp.policy.{set,get,list}`.
2. **Fully OOP policy layer**: the MCP enforcement hot path (`evaluate`, `filterTools`, `bootstrap`, caller resolution) also becomes a class; the three consumers instantiate/inject the services from a composition root.
3. A single composition root (`policy/index.js`) builds and exports the wired singletons; nothing outside `policy/` constructs the classes.

## 3. Architecture

```
HTTP POST /whitelist/command
        │
        ▼
PolicyCommandInvoker            (the Command-pattern "invoker" + HTTP adapter)
  • authenticate (session cookie) → resolve Caller
  • build CommandContext {command, body, user, isAdmin, caller}
  • registry.get(command)  → authorize(ctx) → execute(ctx) → CommandResult
  • map CommandResult → HTTP response; write one PolicyAuditLog line
        │
        ▼
PolicyCommandRegistry  ── name → one of 7 ──►  WhitelistCommand (concrete)
                                                   │ constructor-injected receivers
        ┌──────────────────── receivers ──────────┴───────────────────────┐
        PolicyStateRepository   HttpRouteWhitelist   McpToolPolicy
        PolicyAuditLog          ShareAuthorizer (interface) ─ HttpShareAuthorizer
        └──────────────────────────────────────────────────────────────────┘

Other consumers (no command bus, just the services):
  RoutingServer.guest gate     → HttpRouteWhitelist.isReachableByGuest(path, method)
  RoutingServer.boot           → McpToolPolicy.bootstrap(routes)
  mcp-proxy / routerHandlers   → resolveCaller(req) + McpToolPolicy.evaluate / filterTools
```

The composition root instantiates one `PolicyStateRepository` (process singleton, preserving the current mtime-keyed cache), one `PolicyAuditLog`, one `HttpRouteWhitelist`, one `McpToolPolicy`, one `HttpShareAuthorizer`, the 7 command instances, the `PolicyCommandRegistry`, and the `PolicyCommandInvoker`, then exports them as `policy`.

## 4. Class catalog

| Class | Responsibility (SRP) | Public surface | Depends on (DIP) |
|---|---|---|---|
| `PolicyStateRepository` | Persist `policy-state.json`: load (mtime/size-cached), validate, atomic write (temp→rename→reindex), fail closed on corrupt | `loadState()`, `isCorrupt()`, `getMcpToolEntry(agent,tool)`, `listMcpTools()`, `listHttpRoutes()`, `getHttpRouteEntry(path)`, `mutate(updaterFn)`, `invalidate()` | fs/path + a path resolver |
| `PolicyAuditLog` | Append-only JSONL audit (ids + decision only) | `record(entry)` | fs/path |
| `WhitelistPath` (value object) | Normalize/validate a path; internal-route predicate; readonly-method predicate | `static normalize(raw,{allowWildcard})`, `static isInternal(path)`, `static isReadonlyMethod(m)` | none (pure) |
| `HttpRouteWhitelist` | Decide guest read-only reachability over repo entries | `isReachableByGuest(requestPath, method)` | `PolicyStateRepository`, `WhitelistPath` |
| `Caller` (value object) + `resolveCaller(req)` | Classify caller as user/guest/agent/none + admin flag | `Caller{kind,id,roles,isAdmin}`; `resolveCaller(req) → Caller` | none |
| `McpToolPolicy` | MCP access decisions | `accessFromTags(tags)`, `evaluate({agent,tool,caller})`, `filterTools(agent,tools,caller)`, `bootstrap(routes)`, `collectDefaults(routes)` | `PolicyStateRepository` |
| `ShareAuthorizer` (abstract) | Contract: may a normal user publish a route? | `authorize({agentName,normalizedPath,user}) → {allowed,reason}` | — |
| `HttpShareAuthorizer` | Deny-by-default router→agent authorize call | implements `ShareAuthorizer` | minter + requestHash + routing.json reader |
| `WhitelistCommand` (abstract base) | One admin command | `name`; `authorize(ctx) → {ok,error?}`; `execute(ctx) → CommandResult` | injected receivers per command |
| 7 concrete commands | `HttpWhitelistAddCommand`, `HttpWhitelistRemoveCommand`, `HttpWhitelistCheckCommand`, `HttpWhitelistListCommand`, `McpPolicySetCommand`, `McpPolicyGetCommand`, `McpPolicyListCommand` | as base | repository / whitelist / authorizer as needed |
| `PolicyCommandRegistry` | name → command instance (OCP) | `register(cmd)`, `get(name)` | — |
| `PolicyCommandInvoker` | HTTP adapter + orchestration (auth → context → authorize → execute → respond → audit) | `handle(req,res)` | registry, audit, session/cookie helpers |

### Core contracts

- `CommandContext` (value object): `{ command, body, user, isAdmin, caller }`.
- `CommandResult` (value object): `{ ok, status, data?, error?{code,message}, audit?{...} }`. The invoker writes `PolicyAuditLog.record({ user, command, ...audit, ok, code })`, so audit has exactly one write site.
- `authorize(ctx)` is separate from `execute(ctx)` per command: e.g. `McpPolicySetCommand.authorize` requires admin (`ADMIN_REQUIRED`); `HttpWhitelistAddCommand.authorize` allows admin or, for a normal user, calls `ShareAuthorizer.authorize(...)` (deny by default → `FORBIDDEN`).
- All current error codes are preserved verbatim (`AUTH_REQUIRED`, `ADMIN_REQUIRED`, `FORBIDDEN`, `AGENT_POLICY_DENIED`, `INVALID_PATH`, `INVALID_WILDCARD`, `INTERNAL_ROUTE_NOT_ALLOWED`, `UNKNOWN_COMMAND`, `POLICY_ENTRY_EXISTS`, `POLICY_ENTRY_NOT_FOUND`, `POLICY_PERSISTENCE_ERROR`).

## 5. File layout (`cli/server/policy/`)

```
PolicyStateRepository.js     PolicyAuditLog.js
WhitelistPath.js             HttpRouteWhitelist.js
Caller.js                    McpToolPolicy.js
ShareAuthorizer.js           HttpShareAuthorizer.js
commands/WhitelistCommand.js (base)
commands/HttpWhitelistAddCommand.js  commands/HttpWhitelistRemoveCommand.js
commands/HttpWhitelistCheckCommand.js commands/HttpWhitelistListCommand.js
commands/McpPolicySetCommand.js commands/McpPolicyGetCommand.js commands/McpPolicyListCommand.js
PolicyCommandRegistry.js     PolicyCommandInvoker.js
index.js                     (composition root → exports `policy`)
```

The legacy function modules (`policyStore.js`, `mcpPolicy.js`, `httpWhitelist.js`, `whitelistCommand.js`, `shareAuthorizer.js`) are removed; their logic moves into the classes above. (`CommandContext`/`CommandResult` are plain shapes documented in the base command, not separate files, to limit sprawl — adjustable.)

## 6. Consumer wiring (exact)

- `RoutingServer.js`: replace the three policy imports with `import { policy } from './policy/index.js';`
  - guest gate: `isPathWhitelistedForGuest(pathname, req.method)` → `policy.httpWhitelist.isReachableByGuest(pathname, req.method)`
  - `POST /whitelist/command`: `handleWhitelistCommand(req,res)` → `policy.commandInvoker.handle(req,res)`
  - boot bootstrap: `bootstrapMcpPolicy(collectMcpToolDefaults(loadApiRoutes()))` → `policy.mcpToolPolicy.bootstrap(loadApiRoutes())`
  - `isRouterOwnedPath` internal-route list is unchanged.
- `mcp-proxy/index.js` & `routerHandlers.js`: `callerFromRequest(req)` → `policy.resolveCaller(req)`; `evaluateMcpAccess({...})` → `policy.mcpToolPolicy.evaluate({...})`; `filterToolsForCaller(...)` → `policy.mcpToolPolicy.filterTools(...)`.

## 7. Behavior preservation (invariants kept)

Fail-closed everywhere (missing/disabled/corrupt = deny); persisted policy wins over tags; `internal+admin`/unknown tag invalid; whitelist is readonly + path-based, query never decides, `/*` suffix only, internal routes never whitelistable at write AND match; `/whitelist/command` authenticated + never whitelistable; agents cannot present a session cookie to the command endpoint; audit records ids + decision only, never tokens. All identical to DS014.

## 8. Testing strategy

Demonstrate the SOLID payoff (isolation) and preserve every existing assertion:

| Suite (new/renamed) | What it covers | Isolation technique |
|---|---|---|
| `tests/unit/policyStateRepository.test.mjs` | atomic write, mtime cache, corrupt fail-closed, refuse-overwrite | temp workspace |
| `tests/unit/httpRouteWhitelist.test.mjs` | normalize accept/reject table, internal-route block at match, wildcard/exact match, query ignored, POST-not-public | **fake repository** returning fixed entries |
| `tests/unit/mcpToolPolicy.test.mjs` | tag→default, persisted-wins bootstrap, full class/caller matrix, corrupt fail-closed, tools/list filter, caller classification | fake or real repository |
| `tests/unit/whitelistCommands.test.mjs` | each of the 7 commands' authorize+execute, all error codes, audit content (no tokens) | **fake repository + fake ShareAuthorizer** (no temp files, no network) |
| `tests/unit/policyCommandInvoker.test.mjs` | end-to-end command HTTP flow incl. auth + admin gating | temp workspace (mirrors today's `whitelistCommand.test`) |

The current suites' assertions (the matrix, accept/reject table, persisted-wins, internal-route-blocked, error codes, corrupt-not-overwritten, audit-has-no-tokens) are carried over verbatim into the class-based suites.

## 9. Verification (runnable)

```
cd ploinky
node --test tests/unit/policyStateRepository.test.mjs tests/unit/httpRouteWhitelist.test.mjs tests/unit/mcpToolPolicy.test.mjs tests/unit/whitelistCommands.test.mjs tests/unit/policyCommandInvoker.test.mjs
node --test tests/unit/agentApiRouting.test.mjs   # routing lock stays green
node --test tests/unit/*.test.mjs                 # full suite stays green (≥ current 527)
```

Acceptance: all listed suites pass; full suite count does not regress; `grep -rn "policyStore\|mcpPolicy\|httpWhitelist\|whitelistCommand\|shareAuthorizer" cli Agent ':!*.test.mjs'` returns no references to the removed function modules; the three consumers import only `policy/index.js`.

## 10. Out of scope

DS014 gets a one-line note that the implementation is a Command-bus class collection (the contract is unchanged). No container E2E re-run is required for a structural refactor with full unit parity, though `npm test` may be run opportunistically.
