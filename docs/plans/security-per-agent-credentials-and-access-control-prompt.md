# Implementing-Agent Prompt: Per-Agent Credentials, Request-Signed JWTs, and Router Access Control

You are working in `/Users/danielsava/work/file-parser`. Implement the plan in:

```text
ploinky/docs/plans/security-per-agent-credentials-and-access-control-implementation-plan.md
```

The goal is to replace Ploinky's shared-HMAC single-key invocation model with per-agent secrets and three direction-typed HS256 JWT families (User Session, Agent Assertion, Router Request) bound by a request-content-hash, plus two fail-closed router access-control collections (`httpRoutes` whitelist, `mcpTools` policy) administered through `POST /whitelist/command`. This closes the gap DS011 names in its Questions #2 and #5.

## Scope and decisions (locked — do not relitigate)

- **In scope:** plan Phases 0–7 and 9 (per-agent secrets, three JWT families, agent-to-agent, MCP tool policy, HTTP whitelist, admin endpoint + share authorizer, spec resync).
- **Deferred (do NOT build):** Phase 8 — protected-public anonymous tokens and limited API keys, and the full normal-user share-authorizer UX beyond the deny-by-default bridge.
- **Clean cutover, migration is a non-goal.** Delete the shared `derived-master` invocation path (`buildFirstPartyInvocation`/`buildDelegatedInvocation`, the agent's `typ:"invocation"` verify, and `PLOINKY_DERIVED_MASTER_KEY` injection) in the same change that lands per-agent signing. No `PLOINKY_SECUREWIRE_COMPAT`, no dual-stack, no legacy-token acceptance.
- **Specs:** finalize the drafted `DS013` and `DS014`, and update `DS011`/`DS005`/`DS006`.

## Read first

```text
CLAUDE.md
ploinky/CLAUDE.md
ploinky/docs/plans/security-per-agent-credentials-and-access-control-implementation-plan.md   # the plan + Appendices A–E
ploinky/docs/specs/DS011-security-model.md
ploinky/docs/specs/DS005-routing-and-web-surfaces.md
ploinky/docs/specs/DS006-auth-capabilities-and-secure-wire.md
ploinky/docs/specs/DS013-per-agent-identity-and-request-signed-jwts.md          # draft skeleton to finalize
ploinky/docs/specs/DS014-router-access-control-http-whitelist-and-mcp-policy.md # draft skeleton to finalize
ploinky/cli/services/masterKey.js
ploinky/cli/services/agentIdentity.js
ploinky/cli/server/mcp-proxy/invocationMinter.js
ploinky/cli/server/mcp-proxy/index.js
ploinky/Agent/lib/invocationAuth.mjs
ploinky/Agent/server/AgentServer.mjs
ploinky/node_modules/achillesAgentLib/jwt/jwtSign.mjs
ploinky/node_modules/achillesAgentLib/jwt/jwtVerify.mjs
ploinky/cli/services/docker/agentServiceManager.js
ploinky/cli/services/bwrap/bwrapServiceManager.js
ploinky/cli/services/lifecycleHooks.js
ploinky/cli/server/authHandlers.js
ploinky/cli/server/auth/localService.js
ploinky/cli/server/httpServiceRoutes.js
ploinky/cli/server/routerHandlers.js
ploinky/cli/server/RoutingServer.js
```

First invoke the **`manage-ploinky-agents`** skill — every change here is security-sensitive (JWT logic, request hashes, policy, whitelist, auth headers, agent-to-agent). Treat the DS specs as the source of truth.

## Invariants to preserve

- Router is the only public entrypoint for agent **application surfaces** (HTTP, `/<agent>/mcp`, tools, resources, task-status, chat-completions); those agent ports are never exposed directly.
- **Media/data-plane exception:** a declared transport the HTTP router cannot proxy (e.g. a LiveKit WebRTC SFU) may be reached directly, but only with a credential the router-mediated control plane minted and the plane verifies — a separate app-owned token, not a Ploinky JWT family (see plan §3.7). Default stays router-only.
- `PLOINKY_MASTER_KEY` never enters an agent; each agent gets only its own `PLOINKY_AGENT_ID` + `PLOINKY_AGENT_SECRET`; no agent ever holds another agent's secret or a workspace-shared signing key.
- User Session JWT terminates at the router; never forward a raw user session token to an AgentServer.
- Every internal JWT binds `typ`/`iss`/`aud`/`method`/`path`/`tool`/`rch`; a valid HMAC with the wrong type, audience, method, path, tool, or `rch` is **not** valid for execution.
- Agent-to-agent only through the router; direct agent-to-agent calls are forbidden.
- MCP policy is fail-closed: missing/unknown/ambiguous = deny; persisted policy wins over `mcp-config` tags; `internal+admin` is invalid.
- HTTP whitelist is read-only and path-based: only `GET`/`HEAD`, query never decides, wildcard only as trailing `/*`, internal routes never whitelistable (at write and at match).
- `/v1/chat/completions` stays non-privileged — no implicit `admin`/`internal` tool access.
- Do not hardcode optional agent ids, backend tags, or agent-owned MCP tool names in router/WebChat core (`ploinky/CLAUDE.md`).
- Never put raw secrets or whole JWTs in code, config, logs, tests, or examples.
- Commits carry no AI attribution and no `Co-Authored-By`/tool footers (workspace policy).

## Execution

Work phase by phase in the order in plan §10: 0 → 1 → 2 → 4 → 5 → 6 → 7 → 3 → 9. Each task in Appendix A is one reviewable unit with an acceptance signal. After each phase:

```bash
cd ploinky
node --test tests/unit/<the-phase-suites>.test.mjs
node --test tests/unit/agentApiRouting.test.mjs   # routing lock — must stay green
```

Before merging any phase that touches startup, routing, or shell behavior, run the required harness:

```bash
cd ploinky
tests/fast/test_all.sh
tests/smoke/test_all.sh
```

For each touched agent directory, run the bundled validator:

```bash
node ploinky/.claude/skills/manage-ploinky-agents/scripts/validate-ploinky-agent.mjs --agent-dir <agent-dir> --policy-state <policy-state.json>
```

Final gate: `cd ploinky && npm test`.

## Close-out (Phase 9, mandatory)

Finalize `DS013` and `DS014` (fill the `_(to fill)_` sections to match the shipped code, flip `status: planned` → `implemented`), update `DS011` (replace the shared-HMAC sections at lines ~26 and ~89–99, revise Questions #2/#5), update `DS005` (new internal/router-owned routes + `/whitelist/command` + whitelist-gated guest `GET`), and extend the `DS006` supersession note. Then invoke the **`gamp-specs`** skill against `ploinky/` to regenerate `docs/specs/matrix.md` and run the repository's documentation link verification. The change is not done while the specs still describe the shared-HMAC model.

## Report at the end

State which files changed, which tests you ran and their results (named command + pass/fail), the spec-resync status, and any assumption made because runtime state was unavailable. Do not claim completion without `tests/fast` + `tests/smoke` + `npm test` output.
