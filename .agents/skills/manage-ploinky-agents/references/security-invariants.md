# Which security invariants must never be weakened?

Ploinky security relies on a strict router boundary, separate JWT families, explicit policy, and fail-closed behavior. A coding agent must preserve these invariants even when the requested change appears to be a simple config edit.

## The router is the public control point.

`RoutingServer` is the only public HTTP entrypoint for agent application surfaces — HTTP endpoints, `/<agent>/mcp`, tools, resources, task-status, and chat-completions. Agents run in isolated containers, listen on local ports, and their application surfaces should not be reachable directly from outside. A public application request must pass through the router before it reaches an agent. The router authenticates the caller, applies policy, rate-limits where appropriate, strips unsafe internal headers supplied by clients, and proxies only after access is allowed.

A declared media or data plane is the only sanctioned exception. A real-time transport the HTTP router cannot proxy (for example a WebRTC SFU such as LiveKit) may be reached by clients directly, but only when the router-mediated control plane mints the scoped, short-lived access credential, the plane verifies that credential itself, and the exposure is an explicit manifest or spec decision. The media plane carries no Ploinky session or internal JWT; its credential is a separate, app-owned token family, not one of the three Ploinky families, and the per-agent secret rule does not apply to it.

`AgentServer` does not decide global external policy. It performs defensive checks, verifies router-signed internal tokens, and executes only the concrete operation that the router authorized.

## The model has user, agent, and guest callers.

A user is a person authenticated to the router. A user may have the role `user` or `admin`. Admin is a role of a user, not a separate identity and not unrestricted power.

An agent is a Ploinky runtime process started by Ploinky. It receives a canonical agent id and one secret at startup. An agent authenticates to the router with an Agent Assertion JWT.

A guest is the absence of a valid user identity and the absence of a valid agent identity. Guest access is allowed only when a readonly HTTP route is explicitly whitelisted or when a route is intentionally configured as anonymous or public protected.

## Secrets stay separated.

The router or launcher owns `PLOINKY_MASTER_KEY`. The master key must not enter an agent. A per-agent secret is derived from the master key using the agent id as context. The recommended derivation uses HKDF with SHA-256, the master key as input key material, info string `ploinky/agent-secret/<agentId>`, and output length of thirty-two bytes.

```text
PLOINKY_AGENT_SECRET = HKDF_SHA256(PLOINKY_MASTER_KEY, "ploinky/agent-secret/" + agentId, 32 bytes)
```

At startup, an agent receives its own agent id and secret.

```text
PLOINKY_AGENT_ID=agent:repo/name
PLOINKY_AGENT_SECRET=<secret-unique-to-this-agent>
```

An agent must not receive `PLOINKY_MASTER_KEY`, another agent's secret, raw user session tokens, or long-lived router credentials. Raw passwords, raw keys, raw JWTs, and complete secrets must not be logged.

## JWT families are direction-specific.

All JWTs in this model are JWS tokens using HS256. The application fixes the algorithm and must not accept an algorithm chosen by the token. The header should be standard.

```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

A User Session JWT goes from a client to the router. It is signed by the router and verified by the router. Its audience is `ploinky-router`, and its type is `user-session`. It must not be sent onward to an AgentServer.

An Agent Assertion JWT goes from a source agent to the router. It is signed by the source agent using its own `PLOINKY_AGENT_SECRET`. The router derives the source agent's secret from the master key, verifies the HMAC, verifies the request hash, and then applies policy. The token proves identity only. It does not grant access by itself.

A Router Request JWT goes from the router to the target AgentServer. It is signed by the router using the target agent's secret. The target AgentServer verifies it using its own `PLOINKY_AGENT_SECRET`. This token is a short-lived authorization for one concrete internal request. It is not a login session.

## User Session JWTs terminate at the router.

A User Session JWT should identify the user, session, roles, revision, issued time, expiration, and token id. The router verifies the token, checks revocation and user state, and then applies route or tool policy.

```json
{
  "typ": "user-session",
  "iss": "ploinky-router",
  "aud": "ploinky-router",
  "sub": "user:daniel",
  "sid": "sess_01HZK3V2QZ7B4G9P6EJ0M4P4RA",
  "user": {
    "id": "daniel",
    "username": "daniel",
    "roles": ["user"]
  },
  "rev": 12,
  "iat": 1780480800,
  "exp": 1780495200,
  "jti": "jwt_01HZK3V5VW2K8N3J4DC9T1R6TQ"
}
```

If a downstream AgentServer receives a raw user session token, it should ignore or reject it. Protected agent execution should require a Router Request JWT.

## Agent Assertion JWTs prove source-agent identity.

An Agent Assertion JWT should use type `agent-assertion`, issuer equal to the source agent id, subject equal to the same source agent id, audience `ploinky-router`, request method, request path, optional target agent, optional tool, request content hash, issued time, expiration, and token id. The recommended lifetime is no more than sixty seconds.

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

The router must parse `iss` without trusting it, require the agent id form `agent:<repo>/<agent>`, derive the source secret, verify the HS256 signature, require `typ: "agent-assertion"`, require `aud: "ploinky-router"`, require `sub === iss`, verify time claims, recompute `rch`, and apply MCP policy. A valid assertion from a real agent still does not imply that the agent may call every tool.

## Router Request JWTs authorize one internal request.

A Router Request JWT should use type `router-request`, issuer `ploinky-router`, audience equal to the target agent id, subject equal to the user or source agent that caused the operation, request method, request path, optional tool, request content hash, issued time, expiration, and token id.

```json
{
  "typ": "router-request",
  "iss": "ploinky-router",
  "aud": "agent:dpu/dpu-agent",
  "sub": "agent:explorer/docs-agent",
  "agent": {
    "id": "agent:explorer/docs-agent"
  },
  "method": "POST",
  "path": "/mcp",
  "tool": "dpu_agent_policy_get",
  "rch": "sha256-base64url-canonical-request",
  "iat": 1780480800,
  "exp": 1780480830,
  "jti": "rrq_01HZK3V5VW2K8N3J4DC9T1R6TQ"
}
```

The target AgentServer must accept only HS256, verify the signature with its own secret, require `typ: "router-request"`, require `iss: "ploinky-router"`, require `aud` equal to `PLOINKY_AGENT_ID`, verify expiration, compare method, path, and optional tool against the real request, recompute `rch`, and reject any mismatch.

## Request hashes bind tokens to operations.

`rch` means request content hash. It prevents a token for one operation from being replayed against another operation. Canonicalization must be deterministic. Object keys should be sorted lexicographically. Array order should be preserved. `undefined` should be rejected. Non-JSON bodies should be represented by a byte hash.

For an HTTP request, the canonical input should include method, path, query, and body hash.

```json
{
  "method": "POST",
  "path": "/v1/chat/completions",
  "query": {},
  "bodyHash": "sha256-base64url-body"
}
```

For an MCP tool call, the canonical input should include method, path, tool, and arguments.

```json
{
  "method": "POST",
  "path": "/mcp",
  "tool": "docs_search",
  "arguments": {
    "q": "contract"
  }
}
```

The JWT signs claims, and the claims include the canonical hash. The JWT should not contain the full body unless the implementation deliberately chooses that shape for small payloads.

## Agent-to-agent direct calls are forbidden.

A source agent must call the router, not a target agent's local port. The source agent signs an Agent Assertion JWT. The router verifies the source identity and request hash. The router applies MCP policy for source agent, target agent, and tool. The router signs a Router Request JWT for the target AgentServer. The target AgentServer verifies the router token and request hash before execution.

An agent that knows its own secret can authenticate as itself. That is expected. It must not be able to authenticate as another agent because each agent has a unique secret.

## MCP policy is separate from HTTP whitelist.

HTTP whitelist uses normalized paths and readonly methods to decide whether a guest may reach an existing HTTP route. MCP policy uses `agent + tool` to decide whether a user or agent may invoke a tool. A route being publicly readable does not imply that any MCP tool is callable. A tool being authenticated does not imply that any HTTP path is public.

Missing MCP policy denies access. Unknown access classes deny access. Unknown tags deny access. Ambiguous tag combinations deny access. Corrupt policy state denies access until repaired.

## MCP access classes are intentionally narrow.

`authenticated` means authenticated users, including admin users when policy permits. It does not mean anonymous clients and does not mean agents. `internal` means authenticated Ploinky agents through the router-mediated internal flow. It does not mean users and does not mean admins. `admin` means authenticated users with the admin role. It does not mean agents.

This separation is deliberate. Admin users do not automatically receive internal access. Agents do not receive admin access. A tool that needs two different audiences should usually be split into two tools with different names, different descriptions, and different policy entries.

## HTTP public access is readonly and path-based.

A completely public route must be declared explicitly in `httpRoutes`, must be readonly, and must use a normalized path. Only `GET` and `HEAD` should be accepted for completely public guest access. Query strings do not decide public access. Wildcards are suffix-only in the form `/*`. Internal routes are not publicable.

A public protected route may use an anonymous temporary token or a limited API key. That token is a technical identity for rate limiting, expiration, revocation, blocking, or basic abuse control. It is not a user login and does not replace infrastructure-level anti-DDoS protection.

## Administrative policy changes go through one controlled endpoint.

Administrative operations should go through `POST /whitelist/command`. This endpoint is authenticated and must not be whitelisted. HTTP whitelist commands use the `http.whitelist` namespace. MCP policy commands use the `mcp.policy` namespace. Admin users may manage MCP policy. Agents must not modify policy.

```json
{
  "command": "mcp.policy.set",
  "agent": "dpu",
  "tool": "dpu_agent_policy_get",
  "access": "admin"
}
```

A normal user may be allowed to publish a file or folder only when a safe share authorizer confirms the user owns or may publish that route. Without such an authorizer, deny the request.

## Error behavior must avoid disclosure.

Guest-facing errors should be generic. The router should not confirm whether a private resource exists, whether an agent exists, or whether a private path is valid. Internal audit logs may record exact reasons with identifiers such as `jti`, user id, agent id, route, tool, and decision result.

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication is required."
  }
}
```

## Chat completions must stay non-privileged.

The `/v1/chat/completions` endpoint can expose an OpenAI-compatible surface, but it does not receive implicit permission to invoke admin or internal tools. External gateway compatibility must not become a shortcut around router policy. Privileged operations belong behind properly tagged MCP tools and router-enforced authorization.
