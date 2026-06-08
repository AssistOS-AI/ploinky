# Implementation Plan: Per-Agent Credentials, Request-Signed JWTs, and Router Access Control

## 1. Purpose

This plan implements the security model described in three documents:

| Doc | Defines |
| --- | --- |
| `RoutingServer Authenticated JWT and Request Signing` | The three JWT families (User Session, Agent Assertion, Router Request), per-agent secret derivation, request-content-hash (`rch`) binding, and the authenticated user / agent-to-agent flows. |
| `RouterServer Access Control, HTTP Whitelist, and MCP Tool Policy` | The five access types, the `httpRoutes` whitelist, the `mcpTools` policy, the single `POST /whitelist/command` admin endpoint, and policy persistence. |
| `Ploinky Agents and Runtime Surfaces` | The current as-built architecture (runtime, router-owned paths, MCP proxy, HTTP services) that this work evolves. |

This is **not greenfield work**. `docs/specs/DS011-security-model.md` already names this work as its single biggest open gap:

- DS011 §Security Scope (line 26): *"Ploinky must not claim tenant isolation or non-repudiation between agents without replacing the shared-HMAC invocation model with per-agent or asymmetric credentials."*
- DS011 Q#2 and Q#5: per-agent credential isolation is the unresolved hardening item.
- DS011 §Residual (line 165): *"a replacement for shared-HMAC agent credentials."*

The two security documents are the concrete design that closes that gap. This plan turns them into ordered, verifiable engineering work.

## 2. Current state (verified against code)

| Concern | Current implementation | File:line evidence |
| --- | --- | --- |
| Root secret | `PLOINKY_MASTER_KEY` → SHA-256 → 32B IKM; per-purpose `deriveSubkey(purpose)` HKDF-SHA256, info `ploinky/<purpose>/v1` | `cli/services/masterKey.js:71-101` |
| Agent key | **One** `derived-master` subkey injected into **every** agent as `PLOINKY_DERIVED_MASTER_KEY` (identical value workspace-wide) | `cli/services/masterKey.js:109-111`; `cli/services/docker/agentServiceManager.js:800-803`; `cli/services/bwrap/bwrapServiceManager.js:364-370`; `cli/services/lifecycleHooks.js:56-60` |
| Per-agent helper | `deriveAgentSecret({repoName,agentName,name})` exists but is **unused** for invocation signing | `cli/services/masterKey.js:113-144` |
| Agent principal | `deriveAgentPrincipalId(repo,agent)` → `agent:<repo>/<agent>` | `cli/services/agentIdentity.js:18-20` |
| Invocation token | **One** family `typ:"invocation"`, signed with the shared derived key; agent identity = `aud` claim; body-only hash `bh` | `cli/server/mcp-proxy/invocationMinter.js:69-153` |
| Agent verify | Verifies with shared `PLOINKY_DERIVED_MASTER_KEY`; checks typ/iss/aud/tool/`bh`/exp/jti | `Agent/lib/invocationAuth.mjs:17-65`; `Agent/server/AgentServer.mjs:772-784` |
| JWT primitives | Custom HS256 HMAC (`signHmacJwt`, `verifyJws`, `bodyHashForRequest`), no third-party lib | `node_modules/achillesAgentLib/jwt/jwtSign.mjs`, `jwtVerify.mjs`; re-exported via `Agent/lib/jwtSign.mjs`, `Agent/lib/jwtVerify.mjs` |
| User session | HS256 `typ:"session"` JWT (`ploinky_jwt`/`ploinky_guest`), signed with `deriveSubkey('session')`; **no `aud`, no `sid`**; SSO = opaque id in in-memory Map | `cli/server/auth/localService.js:18-79`; `cli/server/auth/sessionStore.js:44-61` |
| Roles / admin | Roles array per user; admin via `isLocalAdminUser` (role `admin` OR username/id `admin`); base role is `local` not `user` | `cli/server/auth/localService.js:112-136` |
| Revocation | **None** as a list; only per-user `rev` bump + in-memory SSO Map delete | `cli/server/auth/localService.js:279-303`; `cli/server/authHandlers.js:935-943` |
| Agent-to-agent | **Broken**: `AgentMcpClient.mjs` posts to `/auth/agent-token` which the router 410s; `x-ploinky-caller-jwt` is verified router-side but no agent produces it | `Agent/client/AgentMcpClient.mjs:54-95`; `cli/server/authHandlers.js:1524-1536`; `cli/server/mcp-proxy/index.js:15,57-59,362-376` |
| HTTP whitelist | **Does not exist** (`rg whitelist|httpRoutes|policy-state|router-policy` → 0 hits in `cli/`,`Agent/`) | n/a |
| MCP tool policy | **Does not exist**; `tags` in mcp-config is agent-card metadata only | `Agent/server/AgentServer.mjs:319-329,1081-1089` |
| Admin endpoint | **Does not exist** (`/whitelist/command` unreserved) | `cli/server/RoutingServer.js:134-149` |
| Router-owned paths | `/agent-card`, `/mcp`, `/auth/*`, `/api/agents/*`, `/webtty`, `/webchat`, `/dashboard`, `/status`, `/upload`, `/blobs`, `/workspace-files` | `cli/server/RoutingServer.js:134-149` |
| HTTP services | `httpServices`/`publicServices` normalized to none/guest/protected; `x-ploinky-auth-info` + scoped `__http_service__` invocation token; identity headers stripped + regenerated | `cli/server/httpServiceRoutes.js:76-140`; `cli/server/routerHandlers.js:128-251` |

## 3. Target model (from the two security documents)

### 3.1 Three JWT families (all HS256; algorithm fixed by the verifier, never read from the token)

| JWT | Direction | Signed by (key) | Verified by (key) | Distinguishing claims |
| --- | --- | --- | --- | --- |
| User Session | client → router | router (`deriveSubkey('session')`) | router | `typ:user-session`, `aud:ploinky-router`, `sub:user:<id>`, `sid`, `user{roles}`, `rev`, `jti`, `iat`, `exp` |
| Agent Assertion | source agent → router | **source agent** (its own `PLOINKY_AGENT_SECRET`) | router (derives source secret) | `typ:agent-assertion`, `iss=sub=agent:<repo>/<agent>`, `aud:ploinky-router`, `method`,`path`,`targetAgent`,`tool`,`rch`, ≤60s |
| Router Request | router → target agent | router (**target agent's** `PLOINKY_AGENT_SECRET`) | target agent (its own secret) | `typ:router-request`, `iss:ploinky-router`, `aud:agent:<repo>/<agent>`, `sub:user:…|agent:…`, `method`,`path`,`tool`,`rch`, short exp |

### 3.2 Per-agent secret

```
PLOINKY_AGENT_SECRET = HKDF_SHA256(key = master-IKM, info = "ploinky/agent-secret/" + "agent:<repo>/<agent>", len = 32)
```

Each agent receives **only** `PLOINKY_AGENT_ID` + its own `PLOINKY_AGENT_SECRET`. Never the master key, never another agent's secret, never a workspace-shared signing key.

### 3.3 Request content hash (`rch`)

Deterministic canonical JSON (keys sorted lexicographically, array order preserved, `undefined` rejected, non-JSON body → byte hash), SHA-256, base64url.

| Surface | Canonical input |
| --- | --- |
| HTTP | `{ method, path, query, bodyHash }` |
| MCP tool call | `{ method, path, tool, arguments }` |

The token signs the claims; the claims include `rch`. The receiver recomputes `rch` from the actual request and rejects mismatches.

### 3.4 Two policy collections (`policy-state.json`, schema `router-policy`)

| Collection | Key | Question answered |
| --- | --- | --- |
| `httpRoutes` | normalized `path` | May a guest reach this read-only HTTP route? (GET/HEAD only, suffix `/*` wildcard) |
| `mcpTools` | `agent + tool` | May this user/agent invoke this MCP tool? Classes: `authenticated`, `internal`, `admin` |

Tags in `mcp-config.json` bootstrap defaults **only when no persisted policy exists**; persisted policy wins. Missing policy = **deny**. `internal+admin` or unknown tag = deny (fail closed).

### 3.5 Single admin endpoint

`POST /whitelist/command` (authenticated, never whitelistable). Namespaces: `http.whitelist.{add,remove,check,list}`, `mcp.policy.{set,get,list}`. Atomic writes (temp file → rename → rebuild index), append-only JSONL audit. New **internal** (non-whitelistable, identity-stripped) routes: `/whitelist/command`, `/admin/*`, `/__agent/*`, `/<agent>/__agent/*`, `/metrics`, `/health/internal`.

### 3.6 Five access types

`fully public` (whitelisted GET/HEAD) · `protected public` (anonymous token / API key) · `authenticated` (user-session) · `internal MCP` (agent assertion) · `admin MCP` (admin user-session). Access classes are narrow: admin ≠ internal; agent ≠ admin.

### 3.7 Media/data-plane exception (control plane vs. media plane)

The router-only rule governs the **control plane** — agent HTTP/MCP surfaces, auth, policy, and credential issuance. It does **not** govern a separate **media/data plane** that a transport the HTTP router cannot proxy requires. The canonical case is WebMeet/LiveKit: the browser fetches a LiveKit URL + room-scoped participant JWT from `webmeet_room_join` (a router-gated MCP call), then connects its WebRTC/UDP media **directly** to the LiveKit SFU on its own public `host:port` (often a dedicated infra agent such as `liveKitServerAgent`), bypassing the router. A generic HTTP reverse proxy cannot carry SRTP/ICE, so this is required, and it is sanctioned only when (1) the access credential is minted exclusively by a router-authenticated control-plane call, (2) the plane verifies that credential itself, and (3) the direct exposure is an explicit manifest/spec decision. Such a credential — e.g. the LiveKit participant JWT signed with `WEBMEET_LIVEKIT_API_SECRET` — is a **separate, app-owned token family**: the three Ploinky JWT families and the per-agent `PLOINKY_AGENT_SECRET` rule do not apply to it and must not try to absorb it (`WEBMEET_LIVEKIT_API_SECRET` is intentionally a `sharedGeneratedSecret` between the minting agent and the SFU). Default remains router-only / deny; the media-plane exception must be declared, never assumed.

## 4. Gap analysis → work items

| # | Gap | Work |
| --- | --- | --- |
| G1 | One shared agent key | Derive + inject per-agent `PLOINKY_AGENT_SECRET` + `PLOINKY_AGENT_ID` |
| G2 | One token family, body-only hash | Three direction-typed families + full `rch` |
| G3 | Agent identity = `aud` claim, forgeable by any agent holding the shared key | Agent-signed Agent Assertion verified by router via per-agent secret derivation |
| G4 | Agent-to-agent broken | Real flow: agent assertion → router policy → router-request to target |
| G5 | No MCP tool policy | `mcpTools` collection + boot bootstrap from tags + fail-closed enforcement |
| G6 | No HTTP whitelist | `httpRoutes` collection + normalization + suffix wildcard + internal-route block |
| G7 | No admin endpoint | `POST /whitelist/command` + namespaces + atomic persistence + audit |
| G8 | Session JWT lacks `aud`/`sid`; role vocab is `local`; no revocation list | Add `aud`/`sid`, normalize `user`/`admin`, add `sessions-revocations.json` |
| G9 | No protected-public identities | Anonymous tokens + API keys (extended scope) |
| G10 | No user share authorizer | `POST /<agent>/__agent/public-route-share/authorize` deny-by-default bridge |
| G11 | Specs describe shared-HMAC model | Update DS011/DS005/DS006, add DS013/DS014, regenerate matrix |

## 5. Design decisions

| # | Decision | Recommendation | Rationale |
| --- | --- | --- | --- |
| D1 | Derive per-agent secret from master IKM or from `derived-master` subkey? | From the **master IKM** via a dedicated `deriveSubkey('agent-secret/'+agentId)` (router-only), matching the doc's `HKDF(MASTER_KEY, "ploinky/agent-secret/"+agentId)`. Adapt, don't reuse, the existing `deriveAgentSecret` (which mixes in `derived-master` + a `name`). | Matches the written spec exactly; keeps one derivation story; the existing helper's `name` purpose is for agent-owned generated secrets, a different concern. |
| D2 | Migration: hard cutover vs. dual-stack window? | **Clean cutover — no backward-compat shim** (locked 2026-06-04: migration is a non-goal). Remove the shared `derived-master` invocation mint+verify path in the *same* change that lands per-agent Router Request signing; every enabled agent is restarted with the new env on that release. No `PLOINKY_SECUREWIRE_COMPAT`, no dual-stack window, no legacy-token acceptance. | DS011 declares the wire protocol supersedable; the workspace is operator-controlled and restarted as a unit, and the old agent-to-agent path is already broken, so nothing in production must be preserved. |
| D3 | `rch` vs. keep `bh`? | Replace `bh` with `rch` but compute it over the **already-canonicalized** `{tool, arguments}` the proxy forwards (DS011:93 already canonicalizes args against the advertised schema) plus `method`+`path`+`tool`. | Reuses the existing schema-driven canonicalization; only widens the hashed surface. |
| D4 | Spec organization | Two new specs — **DS013** (per-agent identity & request-signed JWT families) and **DS014** (router access control: HTTP whitelist + MCP policy) — plus edits to DS011 (supersede shared-HMAC sections), DS005 (new router-owned/internal routes + admin endpoint), DS006 (note further supersession). | Two distinct subsystems; matches the repo's focused-DS convention; keeps DS011 as the umbrella contract. |
| D5 | Scope of first delivery | **Core: Phases 0–7 + 9** (per-agent secrets, three families, both policy collections, admin endpoint, spec resync). Phase 8 (anonymous tokens / limited API keys) and the full share-authorizer UX are **deferred** (locked 2026-06-04). | The core closes the DS011 gap; protected-public anonymous/API-key identities are a larger surface with no current consumer, best landed separately. |
| D6 | Aggregate `/mcp` + per-agent `/<agent>/mcp` + `__http_service__` | All three must move to per-agent Router Request signing and MCP-policy enforcement; none may keep the shared key. | Single source of truth for minting; otherwise the shared key survives. |

## 6. Phased implementation

> Each phase lists files to change and a **runnable** verification. New unit tests use Node's built-in runner (`node --test`), matching `tests/unit/*.test.mjs`. Run `tests/fast/test_all.sh` + `tests/smoke/test_all.sh` before any startup/restart/shell-affecting change (per `ploinky/CLAUDE.md`).

### Phase 0 — Crypto foundations: per-agent secret + `rch`

| Item | File(s) |
| --- | --- |
| `deriveAgentRequestSecret(agentId)` (router-only, HKDF from master IKM, info `ploinky/agent-secret/<agentId>/v1`) | `cli/services/masterKey.js` (+ export) |
| Shared canonical request hash `computeRch({method,path,query,bodyHash})` / `computeRchForToolCall({method,path,tool,arguments})` with deterministic JSON (sorted keys, preserved arrays, reject `undefined`) | new `node_modules/achillesAgentLib/jwt/requestHash.mjs` + `Agent/lib/requestHash.mjs` shim (so router and agent share one implementation) |

**Verify:** new `tests/unit/perAgentSecret.test.mjs` (determinism: same `agentId` → same secret; different `agentId` → different secret; secret ≠ `derived-master`) and `tests/unit/requestHash.test.mjs` (key-order independence, array-order sensitivity, `undefined` rejection, known-vector). `node --test tests/unit/perAgentSecret.test.mjs tests/unit/requestHash.test.mjs` passes.

### Phase 1 — Inject `PLOINKY_AGENT_ID` + per-agent `PLOINKY_AGENT_SECRET`

| Item | File(s) |
| --- | --- |
| Replace `PLOINKY_DERIVED_MASTER_KEY` injection with `PLOINKY_AGENT_ID` (= principal) + `PLOINKY_AGENT_SECRET` (= `deriveAgentRequestSecret(principal)`, hex) | `cli/services/docker/agentServiceManager.js:800-803`; `cli/services/bwrap/bwrapServiceManager.js:364-370`; `cli/services/lifecycleHooks.js:56-60` |
| Keep `PLOINKY_AGENT_PRINCIPAL`/`AGENT_NAME`; **never** inject master key (assert in a test) | same files |
| **Remove** `PLOINKY_DERIVED_MASTER_KEY` injection entirely (clean cutover, D2) — no agent receives the shared key after this phase | same files |

**Verify:** new `tests/unit/agentEnvInjection.test.mjs` asserts the built env list for a sample agent contains `PLOINKY_AGENT_ID` + `PLOINKY_AGENT_SECRET`, the two agents get **different** secrets, and `PLOINKY_MASTER_KEY` is absent. `node --test tests/unit/agentEnvInjection.test.mjs`.

### Phase 2 — Router Request JWT (router → agent), replacing first-party invocation

| Item | File(s) |
| --- | --- |
| `buildRouterRequest({targetAgentId, sub, actor, method, path, tool, rch, ttl})` signing with `deriveAgentRequestSecret(targetAgentId)`; `typ:router-request`, `iss:ploinky-router`, `aud:targetAgentId` | `cli/server/mcp-proxy/invocationMinter.js` (replace `buildFirstPartyInvocation`) |
| Agent verifier: read `PLOINKY_AGENT_SECRET`+`PLOINKY_AGENT_ID`; require `typ:router-request`, `iss:ploinky-router`, `aud==PLOINKY_AGENT_ID`, method/path/tool match, recompute `rch`, exp, jti replay | `Agent/lib/invocationAuth.mjs:17-65`; verify helpers in `node_modules/achillesAgentLib/jwt/jwtVerify.mjs` |
| Update call sites: tools/call, resources/read, `__task_status__`, `__http_service__` | `Agent/server/AgentServer.mjs:772-784,934-969,1091-1106`; `cli/server/mcp-proxy/index.js:216-227`; `cli/server/routerHandlers.js:187-209` |
| **Delete** the legacy shared-key `typ:"invocation"` mint + verify paths in the same change (clean cutover, D2) | `cli/server/mcp-proxy/invocationMinter.js`; `Agent/lib/invocationAuth.mjs` |

**Verify:** `tests/unit/routerRequestJwt.test.mjs` — round-trip sign/verify with correct target secret passes; wrong target secret, wrong `typ`, wrong `aud`, mutated method/path/tool/body, expired, replayed `jti` all reject. Then `tests/smoke/test_all.sh` confirms a real `/<agent>/mcp` tools/call still succeeds end-to-end.

### Phase 3 — Agent Assertion JWT (agent → router) + real agent-to-agent

| Item | File(s) |
| --- | --- |
| Agent-side signer `signAgentAssertion({method,path,targetAgent,tool,rch})` with own `PLOINKY_AGENT_SECRET`, ≤60s | `Agent/lib/agentAssertion.mjs` (new); used by `Agent/client/AgentMcpClient.mjs` (replace the dead `/auth/agent-token` path at `:54-95`) |
| Router verify: parse `iss` (untrusted) → require `agent:<repo>/<agent>` form → derive that agent's secret → verify HS256 → `typ:agent-assertion`, `aud:ploinky-router`, `sub==iss`, exp/jti, recompute `rch` | `cli/server/mcp-proxy/index.js` (replace `verifyDelegatedToolCall` at `invocationMinter.js:131-153`); carrier header `Authorization: Bearer` (retire `x-ploinky-caller-jwt` shared-key model) |
| After assertion verify → **MCP policy check** (Phase 5) → mint Router Request for target (Phase 2) | `cli/server/mcp-proxy/index.js` |

**Verify:** `tests/unit/agentAssertion.test.mjs` — assertion signed by agent A verifies as A; A cannot forge an assertion for agent B (different secret → verify fails). New smoke `tests/smoke/` case: agent A calls agent B's `internal` tool through the router and succeeds only when policy allows.

### Phase 4 — User Session JWT alignment + revocation list

| Item | File(s) |
| --- | --- |
| Rename `typ:session` → `typ:user-session`; add `aud:ploinky-router` + `sid` (stable session id); verify `aud` + `typ`. Old cookies simply fail verification and the browser re-authenticates — no compat path (clean cutover, D2) | `cli/server/auth/localService.js:18-79`; `verifySessionJwt:41-45` |
| Normalize role vocabulary to include `user` (keep `local` alias), keep `admin`; `isLocalAdminUser` unchanged | `cli/server/auth/localService.js:112-136` |
| `data/router-security/sessions-revocations.json` (revoked `sid`/`jti`); check on `ensureAuthenticated`; logout revokes `sid` | `cli/server/auth/localService.js:301-303`; `cli/server/authHandlers.js:854-967,1431-1460` |

**Verify:** `tests/unit/userSessionJwt.test.mjs` — token with wrong `aud` rejected; revoked `sid` rejected; `rev` mismatch still rejected. Existing `tests/unit/guestAuthRoutes.test.mjs` still passes.

### Phase 5 — MCP tool policy (`mcpTools`)

| Item | File(s) |
| --- | --- |
| Policy store: load/validate `policy-state.json` (`router-policy` schema), atomic write (temp→rename→reindex), fail-closed on corrupt | new `cli/server/policy/policyStore.js` |
| Boot bootstrap: for each enabled agent's mcp-config tool, if no persisted `agent+tool` entry, create default from tags (none/empty→`authenticated`, `internal`, `admin`; reject `internal+admin`/unknown) | new `cli/server/policy/mcpPolicy.js`; reads tags via existing mcp-config load |
| Enforcement before minting Router Request: deny if missing/disabled; `authenticated`→user or admin; `admin`→admin only; `internal`→agent (assertion) only | `cli/server/mcp-proxy/index.js`; aggregate path in `cli/server/RoutingServer.js` (`handleRouterMcp`/`handleRouterJsonRpc`); also gate `tools/list` to the caller's class |

**Verify:** `tests/unit/mcpPolicy.test.mjs` — tag→default mapping; persisted wins over tag; `internal+admin` rejected; missing policy denies; class matrix (user/admin/agent × authenticated/admin/internal). `node --test tests/unit/mcpPolicy.test.mjs`.

### Phase 6 — HTTP route whitelist (`httpRoutes`)

| Item | File(s) |
| --- | --- |
| Path normalization (must start `/`, reject scheme/fragment/backslash/NUL/double-slash/encoded-slash/`..`; query ignored); suffix-only `/*` matcher | new `cli/server/policy/httpWhitelist.js` |
| Internal-route block at **write and match** (`/whitelist/command`, `/auth/*`, `/admin/*`, `/__agent/*`, `/<agent>/__agent/*`, `/metrics`, `/health/internal`) | `cli/server/policy/httpWhitelist.js` |
| Guest GET/HEAD branch consults whitelist before the auth gate; generic deny message (no resource disclosure) | `cli/server/RoutingServer.js:347-359` |

**Verify:** `tests/unit/httpWhitelist.test.mjs` — accept/reject table from the doc (`/explorer/public-view/folder/*` accept; `explorer/...`, `/.../../secret`, `/%2Fsecret`, `/explorer/*/file`, `/**`, `/*/edit` reject); internal route never whitelistable even if present in a hand-corrupted state file; POST to a whitelisted path is not public.

### Phase 7 — Admin endpoint `/whitelist/command` + internal routes + share authorizer

| Item | File(s) |
| --- | --- |
| Reserve internal routes in `isRouterOwnedPath`; strip identity headers on `/__agent/*` | `cli/server/RoutingServer.js:134-149`; `cli/server/routerHandlers.js:128-144` |
| `POST /whitelist/command`: authenticated; `http.whitelist.*` (admin or share-authorized user) + `mcp.policy.*` (admin only); never whitelistable; JSONL audit (ids + decision, never tokens) | new `cli/server/policy/whitelistCommand.js`; wired in `cli/server/authHandlers.js` or `RoutingServer.js` |
| Share authorizer bridge for normal-user publish: `POST /<agent>/__agent/public-route-share/authorize`; **deny by default** when absent | `cli/server/policy/shareAuthorizer.js` (new); agent-side optional handler contract documented |

**Verify:** `tests/unit/whitelistCommand.test.mjs` — non-admin `mcp.policy.set` → 403 `ADMIN_REQUIRED`; agent caller rejected; unknown command → 400; `http.whitelist.add` of internal route → 400 `INTERNAL_ROUTE_NOT_ALLOWED`; atomic write leaves valid JSON on simulated mid-write failure. Smoke: admin adds a whitelist entry, guest then reaches that GET route.

### Phase 8 — Protected-public: anonymous tokens + API keys *(deferred — confirm scope, D5)*

| Item | File(s) |
| --- | --- |
| Anonymous temporary token issue/verify (technical identity for rate-limit/expiry/revocation), distinct from guest | extend `cli/server/auth/*` |
| Limited API keys scoped to specific routes | new `cli/server/auth/apiKeys.js` |

**Verify:** unit tests for token issue/verify/expiry/revocation and per-route API-key scoping; the anonymous token must never resolve to a `user`.

### Phase 9 — Spec & documentation resync (mandatory close-out)

| Item | File(s) |
| --- | --- |
| Update DS011 (replace shared-HMAC sections; record per-agent + three families; revise Q#2/Q#5) | `docs/specs/DS011-security-model.md` |
| Update DS005 (new router-owned/internal routes, `/whitelist/command`, whitelist-gated guest GET) | `docs/specs/DS005-routing-and-web-surfaces.md` |
| Note further supersession in DS006 | `docs/specs/DS006-auth-capabilities-and-secure-wire.md` |
| New DS013 (Per-Agent Identity & Request-Signed JWT Families) and DS014 (Router Access Control: HTTP Whitelist + MCP Tool Policy) | `docs/specs/DS013-*.md`, `docs/specs/DS014-*.md` |
| Regenerate `matrix.md`; run repo doc link verification | via `gamp-specs` skill against `ploinky/` |

**Verify:** invoke the `gamp-specs` skill against `ploinky/`; `docs/specs/matrix.md` lists DS013/DS014; link verification passes. Per `manage-ploinky-agents`, the change is not done until specs describe the new behavior.

## 7. Test plan (aggregate)

| Layer | Command | Adds |
| --- | --- | --- |
| New unit | `node --test tests/unit/perAgentSecret.test.mjs tests/unit/requestHash.test.mjs tests/unit/agentEnvInjection.test.mjs tests/unit/routerRequestJwt.test.mjs tests/unit/agentAssertion.test.mjs tests/unit/userSessionJwt.test.mjs tests/unit/mcpPolicy.test.mjs tests/unit/httpWhitelist.test.mjs tests/unit/whitelistCommand.test.mjs` | the per-phase suites above |
| Existing routing lock | `node --test tests/unit/agentApiRouting.test.mjs` | must still pass (route extraction/prefix stripping) |
| Fast | `tests/fast/test_all.sh` | required before startup/restart/shell changes |
| Smoke | `tests/smoke/test_all.sh` | end-to-end `/<agent>/mcp`, agent-to-agent, whitelist-gated guest GET |
| Full | `npm test` (`./tests/run-all.sh`) | final gate |
| Agent validator | `node .claude/skills/manage-ploinky-agents/scripts/validate-ploinky-agent.mjs --agent-dir <dir> --policy-state <policy-state.json>` | per touched agent |

## 8. Invariants to preserve (from `manage-ploinky-agents` + project CLAUDE.md)

| Invariant |
| --- |
| Router is the only public entrypoint for agent **application surfaces** (HTTP, `/<agent>/mcp`, tools, resources, task-status, chat-completions); those agent ports are never exposed directly. |
| **Media/data-plane exception:** a declared transport the HTTP router cannot proxy (e.g. LiveKit WebRTC SFU) MAY be reached directly, but only with a credential the router-mediated control plane minted and the plane verifies; that credential is a separate app-owned token, not a Ploinky JWT family. Default stays router-only — see §3.7. |
| `PLOINKY_MASTER_KEY` never enters an agent; each agent gets only its own id + secret. |
| User Session JWT terminates at the router; never forwarded to an AgentServer. |
| Every internal JWT binds `typ`/`iss`/`aud`/`method`/`path`/`tool`/`rch`; wrong any → reject even if HMAC is valid. |
| Agent-to-agent only via router; direct calls forbidden. |
| MCP policy fail-closed; missing/unknown/ambiguous = deny; persisted wins over tags. |
| HTTP whitelist is readonly + path-based; query never decides; `/*` suffix only; internal routes never whitelistable. |
| `/v1/chat/completions` stays non-privileged (no implicit admin/internal tools). |
| No agent ids / backend tags / agent-owned tool names hardcoded in router/WebChat core (`ploinky/CLAUDE.md`). |
| No raw secrets or full JWTs in code, config, logs, tests, examples. |
| Commits carry no AI attribution (workspace policy). |

## 9. Decisions (locked 2026-06-04)

| # | Question | Decision |
| --- | --- | --- |
| Q1 | Scope of first delivery | **Core: Phases 0–7, 9.** Phase 8 (anonymous tokens / limited API keys + full share-authorizer UX) deferred. |
| Q2 | Migration strategy | **Clean cutover, no compat shim.** Migration is a non-goal; the shared `derived-master` invocation path is deleted in the same change that lands per-agent signing. |
| Q3 | Spec layout | **Two new specs** DS013 + DS014, plus edits to DS011/DS005/DS006. |
| Q4 | Next action | Refine the plan (this revision: task-level detail, DS skeletons, companion prompt), then implement from Phase 0 on go-ahead. |

## 10. Suggested execution order

Phase 0 → 1 → 2 (clean cutover of the core wire) → 4 (sessions) → 5 → 6 → 7 (policy + admin) → 3 (agent-to-agent, depends on 2+5) → 9 (specs). Phase 8 deferred. Land each phase behind its own tests; run `tests/fast` + `tests/smoke` before merging any phase that touches startup/routing.

Companion artifacts: spec skeletons `docs/specs/DS013-per-agent-identity-and-request-signed-jwts.md` and `docs/specs/DS014-router-access-control-http-whitelist-and-mcp-policy.md` (drafts, `status: planned`); implementing-agent handoff `docs/plans/security-per-agent-credentials-and-access-control-prompt.md`.

---

## Appendix A — Task-level breakdown (in-scope phases)

Each task is a single reviewable unit. `→` marks its acceptance signal.

### Phase 0 — crypto foundations
| Task | Deliverable | Accept |
| --- | --- | --- |
| T0.1 | `deriveAgentRequestSecret(agentId, {encoding='hex'})` in `cli/services/masterKey.js`: `hkdfSync('sha256', resolveMasterKey(), emptySalt, info=Buffer.from('ploinky/agent-secret/'+agentId+'/v1'), 32)`; exported; router-only | → unit: same id ⇒ same secret, different id ⇒ different, ≠ `deriveDerivedMasterKey()` |
| T0.2 | `node_modules/achillesAgentLib/jwt/requestHash.mjs`: `canonicalJson(v)` (sorted keys, arrays preserved, throw on `undefined`/function/symbol), `sha256b64url(s)`, `computeRchHttp({method,path,query,bodyHash})`, `computeRchTool({method,path,tool,arguments})` | → unit: key-order independent, array-order sensitive, `undefined` throws, known vector |
| T0.3 | `Agent/lib/requestHash.mjs` one-line re-export shim (mirrors `Agent/lib/jwtSign.mjs`) | → router & agent import the same impl |
| T0.4 | `tests/unit/perAgentSecret.test.mjs`, `tests/unit/requestHash.test.mjs` | → `node --test` green |

### Phase 1 — per-agent env injection
| Task | Deliverable | Accept |
| --- | --- | --- |
| T1.1 | Docker: at `agentServiceManager.js:800-803` set `PLOINKY_AGENT_ID=principal` + `PLOINKY_AGENT_SECRET=deriveAgentRequestSecret(principal)`; drop `PLOINKY_DERIVED_MASTER_KEY` | → env list contains id+secret, not derived key |
| T1.2 | Bwrap: same at `bwrapServiceManager.js:364-370` | → parity with docker |
| T1.3 | Lifecycle hooks: at `lifecycleHooks.js:56-60` inject the owning agent's id+secret (host hooks acting as that agent); drop derived key | → hook env has id+secret |
| T1.4 | Align agent-side env reads: `PLOINKY_DERIVED_MASTER_KEY`→`PLOINKY_AGENT_SECRET`, audience source→`PLOINKY_AGENT_ID` | `Agent/lib/invocationAuth.mjs:17-29` |
| T1.5 | `tests/unit/agentEnvInjection.test.mjs`: two agents get different secrets; `PLOINKY_MASTER_KEY` absent; no `PLOINKY_DERIVED_MASTER_KEY` | → green |

### Phase 2 — Router Request JWT (clean cutover of router→agent)
| Task | Deliverable | Accept |
| --- | --- | --- |
| T2.1 | `buildRouterRequest({targetAgentId,sub,actor,method,path,tool,argumentsObj,ttl})` in `invocationMinter.js`, signing with `deriveAgentRequestSecret(targetAgentId)`; claims = Appendix B.3 | → unit round-trip |
| T2.2 | Proxy `buildRequestHeadersForToolCall` (`mcp-proxy/index.js:216-227`) passes method/path/tool + computes `rch` over canonicalized args | → tools/call still reaches agent |
| T2.3 | HTTP-service mint (`routerHandlers.js:187-209`) `__http_service__` → router-request with `computeRchHttp` | → service route still works |
| T2.4 | Rewrite `Agent/lib/invocationAuth.mjs` verify: `typ:router-request`, `iss:ploinky-router`, `aud==PLOINKY_AGENT_ID`, method/path/tool match, recompute `rch`, exp, jti replay; key = `PLOINKY_AGENT_SECRET` | → mismatches reject |
| T2.5 | AgentServer call sites pass method/path so the verifier can recompute `rch` (`AgentServer.mjs:772-784,934-969,1091-1106`) | → tools/resources/task-status gated |
| T2.6 | **Delete** `buildFirstPartyInvocation`/`buildDelegatedInvocation` and the agent's legacy `typ:"invocation"` verify | → `rg "typ: 'invocation'"`=0 |
| T2.7 | `tests/unit/routerRequestJwt.test.mjs` + `tests/smoke/test_all.sh` | → green |

### Phase 3 — Agent Assertion + real agent-to-agent (depends on 2 & 5)
| Task | Deliverable | Accept |
| --- | --- | --- |
| T3.1 | `Agent/lib/agentAssertion.mjs`: `signAgentAssertion({method,path,targetAgent,tool,argumentsObj})` with own secret, ≤60s; claims = Appendix B.2 | → unit |
| T3.2 | `AgentMcpClient.mjs`: replace dead `/auth/agent-token` (`:54-95`) with assertion-bearing call to the router (`Authorization: Bearer <assertion>`) | → no `/auth/agent-token` call remains |
| T3.3 | Router: verify assertion (parse `iss` untrusted → require `agent:<repo>/<agent>` → derive that agent's secret → HS256 → `typ`/`aud`/`sub==iss`/exp/jti/`rch`), then MCP policy (P5), then mint router-request (P2) | replaces `verifyDelegatedToolCall` |
| T3.4 | Retire `x-ploinky-caller-jwt` shared-key model in `mcp-proxy/index.js` | → header no longer keyed to shared secret |
| T3.5 | `tests/unit/agentAssertion.test.mjs` (A verifies as A; A can't forge B) + smoke a2a internal-tool call | → green |

### Phase 4 — User Session JWT + revocation
| Task | Deliverable | Accept |
| --- | --- | --- |
| T4.1 | `mintSessionJwt`: `typ:user-session`, `aud:ploinky-router`, add `sid` (stable per login) | `localService.js:18-39` |
| T4.2 | `verifySessionJwt`: require `aud` + `typ`; keep `rev`/`uvar` checks | `localService.js:41-45` |
| T4.3 | Rename the base role `local` → `user` (map on read); keep `admin`. Clean rename, no dual-vocabulary retained | `localService.js:112-125` |
| T4.4 | `data/router-security/sessions-revocations.json` (revoked `sid`/`jti`) + check in `ensureAuthenticated` + logout revokes `sid` | `authHandlers.js:854-967,1431-1460` |
| T4.5 | `tests/unit/userSessionJwt.test.mjs`; existing `guestAuthRoutes.test.mjs` stays green | → green |

### Phase 5 — MCP tool policy
| Task | Deliverable | Accept |
| --- | --- | --- |
| T5.1 | `cli/server/policy/policyStore.js`: load+validate `policy-state.json` (Appendix D), atomic write (temp→`rename`→reindex), fail-closed on corrupt/invalid | → unit |
| T5.2 | `cli/server/policy/mcpPolicy.js`: boot bootstrap from tags (none/empty→`authenticated`, `internal`, `admin`; reject `internal+admin`/unknown); persisted wins | → unit matrix |
| T5.3 | Enforcement before minting router-request, in both `mcp-proxy/index.js` and aggregate `RoutingServer.js` (`handleRouterMcp`/`handleRouterJsonRpc`); also filter `tools/list` to caller class | → denied calls never reach agent |
| T5.4 | `tests/unit/mcpPolicy.test.mjs` | → green |

### Phase 6 — HTTP whitelist
| Task | Deliverable | Accept |
| --- | --- | --- |
| T6.1 | `cli/server/policy/httpWhitelist.js`: `normalizeWhitelistPath` (start `/`, reject scheme/fragment/backslash/NUL/`//`/`%2F`/`%5C`/`..`; query ignored) + suffix-only `/*` matcher | → unit accept/reject table |
| T6.2 | Internal-route block at write **and** match (`/whitelist/command`,`/auth/*`,`/admin/*`,`/__agent/*`,`/<agent>/__agent/*`,`/metrics`,`/health/internal`) | → corrupt-state internal route still denied |
| T6.3 | Guest GET/HEAD branch in `RoutingServer.js:347-359` consults whitelist before the auth gate; generic 401 (no disclosure) | → guest reaches whitelisted GET only |
| T6.4 | `tests/unit/httpWhitelist.test.mjs` | → green |

### Phase 7 — admin endpoint + internal routes + share authorizer
| Task | Deliverable | Accept |
| --- | --- | --- |
| T7.1 | Reserve internal routes in `isRouterOwnedPath` (`RoutingServer.js:134-149`); strip identity headers on `/__agent/*` | → internal routes not agent-routable |
| T7.2 | `cli/server/policy/whitelistCommand.js`: `POST /whitelist/command` dispatch (Appendix E), authz (admin for `mcp.policy.*`; admin or share-authorized user for `http.whitelist.*`), JSONL audit (ids + decision, never tokens) | → unit per command + error codes |
| T7.3 | `cli/server/policy/shareAuthorizer.js`: call `POST /<agent>/__agent/public-route-share/authorize`; **deny when absent/!allowed** | → user publish denied without authorizer |
| T7.4 | `tests/unit/whitelistCommand.test.mjs` + smoke (admin adds entry → guest reaches GET) | → green |

### Phase 9 — spec resync
| Task | Deliverable | Accept |
| --- | --- | --- |
| T9.1 | Finalize DS013 + DS014 from skeletons (via `review-specs`) | contract matches shipped code |
| T9.2 | DS011: replace shared-HMAC sections (lines 26, 89-99), revise Q#2/Q#5 | reads per-agent + three families |
| T9.3 | DS005: add internal/router-owned routes + `/whitelist/command` + whitelist-gated guest GET | route list current |
| T9.4 | DS006: extend supersession note | boundary explicit |
| T9.5 | `gamp-specs` against `ploinky/`: regenerate `matrix.md`, run doc link verification | matrix lists DS013/DS014; links pass |

## Appendix B — JWT claim schemas (all HS256, `{"alg":"HS256","typ":"JWT"}` header; verifier fixes alg)

### B.1 User Session JWT — client→router, signed+verified by router with `deriveSubkey('session')`
```json
{
  "typ": "user-session",
  "iss": "ploinky-router",
  "aud": "ploinky-router",
  "sub": "user:daniel",
  "sid": "sess_01HZK3V2QZ7B4G9P6EJ0M4P4RA",
  "user": { "id": "daniel", "username": "daniel", "roles": ["user"] },
  "uvar": "PLOINKY_AUTH_EXPLORER_USERS",
  "rev": 12,
  "iat": 1780480800,
  "exp": 1780495200,
  "jti": "jwt_01HZK3V5VW2K8N3J4DC9T1R6TQ"
}
```
Router rejects unless `aud==ploinky-router` && `typ==user-session`; then checks `rev`/`uvar` against the user store and `sid`/`jti` against the revocation list. Never forwarded to an agent.

### B.2 Agent Assertion JWT — source agent→router, signed by source agent with its own `PLOINKY_AGENT_SECRET`
```json
{
  "typ": "agent-assertion",
  "iss": "agent:explorer/docs-agent",
  "sub": "agent:explorer/docs-agent",
  "aud": "ploinky-router",
  "method": "POST",
  "path": "/mcp",
  "targetAgent": "agent:dpu/dpu-agent",
  "tool": "dpu_agent_policy_get",
  "rch": "sha256-base64url-canonical-request",
  "iat": 1780480800,
  "exp": 1780480860,
  "jti": "agt_01HZK3V5VW2K8N3J4DC9T1R6TQ"
}
```
Router: parse `iss` untrusted → require `agent:<repo>/<agent>` → derive that agent's secret → verify HS256 → require `typ`/`aud:ploinky-router`/`sub==iss`/time/`jti` → recompute `rch` → **then MCP policy**. Identity ≠ authorization. TTL ≤ 60s.

### B.3 Router Request JWT — router→target agent, signed by router with the **target** agent's `PLOINKY_AGENT_SECRET`
```json
{
  "typ": "router-request",
  "iss": "ploinky-router",
  "aud": "agent:dpu/dpu-agent",
  "sub": "user:daniel",
  "actor": { "kind": "user", "id": "user:daniel", "roles": ["user"] },
  "method": "POST",
  "path": "/mcp",
  "tool": "docs_search",
  "rch": "sha256-base64url-canonical-request",
  "iat": 1780480800,
  "exp": 1780480830,
  "jti": "rrq_01HZK3V5VW2K8N3J4DC9T1R6TQ"
}
```
For an agent-initiated call, `sub` is the source agent id and `actor.kind:"agent"`. Target AgentServer verifies with its own secret: `typ:router-request`, `iss:ploinky-router`, `aud==PLOINKY_AGENT_ID`, method/path/tool match the real request, recompute `rch`, exp, `jti` replay. Short TTL (≤30s).

## Appendix C — `rch` (request content hash)

```text
canonicalJson(value):
  null|number|string|boolean      -> JSON.stringify(value)
  array                           -> "[" + items.map(canonicalJson).join(",") + "]"   # order preserved
  object                          -> "{" + sortKeys(entries).map(k -> JSON.stringify(k)+":"+canonicalJson(v)).join(",") + "}"
  undefined|function|symbol       -> throw  # never silently dropped

rch = base64url( sha256( canonicalJson(input) ) )

HTTP input      = { method, path, query, bodyHash }      # bodyHash = base64url(sha256(rawBodyBytes))
MCP tool input  = { method, path, tool, arguments }      # arguments already canonicalized against the tool's advertised inputSchema
```
The proxy canonicalizes `arguments` against the advertised `inputSchema` (stripping unknown keys, as today at DS011:93) **before** computing `rch`, so the signed surface equals exactly what the agent will execute. The agent recomputes `rch` from the body it received; any divergence ⇒ `REQUEST_HASH_MISMATCH`.

## Appendix D — `policy-state.json` (schema `router-policy`)

Location: `data/router-security/policy-state.json` (source of truth) + `policy-audit.log` (append-only JSONL). Atomic write: temp file → `fs.renameSync` over active → rebuild in-memory index. Corrupt/invalid ⇒ refuse access checks (fail closed), do not overwrite.

```json
{
  "schema": "router-policy",
  "httpRoutes": [
    { "path": "/explorer/public-view/folder/*", "enabled": true,
      "createdAt": "2026-06-04T10:00:00.000Z", "createdBy": "user:admin",
      "updatedAt": "2026-06-04T10:00:00.000Z", "updatedBy": "user:admin" }
  ],
  "mcpTools": [
    { "agent": "explorer", "tool": "docs_search", "access": "authenticated", "source": "mcp-config",
      "enabled": true, "createdAt": "2026-06-04T10:00:00.000Z", "createdBy": "router:boot",
      "updatedAt": "2026-06-04T10:00:00.000Z", "updatedBy": "router:boot" },
    { "agent": "explorer", "tool": "index_refresh_internal", "access": "internal", "source": "admin",
      "enabled": true, "createdAt": "2026-06-04T10:00:00.000Z", "createdBy": "router:boot",
      "updatedAt": "2026-06-04T10:15:00.000Z", "updatedBy": "user:admin" }
  ]
}
```
`access` ∈ {`authenticated`,`internal`,`admin`}. `source` ∈ {`mcp-config`,`admin`}. Audit line: `{"ts":"…","user":"user:admin","command":"mcp.policy.set","agent":"explorer","tool":"index_refresh_internal","ok":true}`.

## Appendix E — `POST /whitelist/command` contracts + error codes

Authenticated (User Session JWT). Never whitelistable. Body must include `command`.

| Command | Caller | Effect |
| --- | --- | --- |
| `http.whitelist.add` | admin, or normal user passing the agent's share authorizer | add exact route or `…/*` |
| `http.whitelist.remove` | admin, or user with rights over the route | remove |
| `http.whitelist.check` | any authenticated user | is this path public? |
| `http.whitelist.list` | any authenticated user | list entries visible to caller |
| `mcp.policy.set` | admin only | set `access` for `agent+tool` |
| `mcp.policy.get` | admin only | read policy |
| `mcp.policy.list` | admin only | list policies |

```json
// request
{ "command": "mcp.policy.set", "agent": "dpu", "tool": "dpu_agent_policy_get", "access": "admin" }
// success
{ "ok": true }
// error
{ "ok": false, "error": { "code": "ADMIN_REQUIRED", "message": "Admin access is required." } }
```

| Situation | HTTP | Code |
| --- | --- | --- |
| Missing token / guest on authed route | 401 | `AUTH_REQUIRED` |
| Invalid / expired / wrong-typ / wrong-aud JWT | 401 | `INVALID_TOKEN` / `TOKEN_EXPIRED` / `INVALID_TOKEN_TYPE` / `INVALID_AUDIENCE` |
| `rch` mismatch (internal) | 401 | `REQUEST_HASH_MISMATCH` |
| User lacks rights | 403 | `FORBIDDEN` |
| Non-admin on admin command/tool | 403 | `ADMIN_REQUIRED` |
| Agent lacks policy for tool | 403 | `AGENT_POLICY_DENIED` |
| AgentServer called without router-request | 401 | `ROUTER_REQUEST_REQUIRED` |
| Invalid path / wildcard | 400 | `INVALID_PATH` / `INVALID_WILDCARD` |
| Internal route in whitelist | 400 | `INTERNAL_ROUTE_NOT_ALLOWED` |
| Unknown command | 400 | `UNKNOWN_COMMAND` |
| Duplicate / missing entry | 409 / 404 | `POLICY_ENTRY_EXISTS` / `POLICY_ENTRY_NOT_FOUND` |
| Persistence failure | 500 | `POLICY_PERSISTENCE_ERROR` |

Guest-facing errors stay generic (never confirm a private resource exists); audit logs may record the precise reason with `jti`/user/agent/tool/route/decision.
