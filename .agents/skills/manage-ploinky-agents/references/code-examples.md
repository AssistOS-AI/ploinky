# Which code patterns should Ploinky agents use?

These examples are intentionally small and conservative. They are written in Node.js because Ploinky tool commands commonly run as process commands that read JSON from standard input and write a result to standard output.

## How should an MCP tool command read input?

A tool command receives JSON on standard input. The payload includes the tool name, the input object, and metadata about the caller. A handler should validate the expected tool name, validate every input field, avoid reading raw tokens directly, and write deterministic output.

```js
import process from "node:process";

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const payload = JSON.parse(await readStdin());

if (payload.tool !== "docs_search") {
  fail("Unexpected tool name");
}

const input = payload.input ?? {};

if (typeof input.query !== "string" || input.query.trim() === "") {
  fail("query is required");
}

const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 20) : 10;
const caller = payload.metadata?.caller ?? payload.metadata?.user ?? "unknown";

const results = [
  {
    title: "Example result",
    snippet: `Matched ${JSON.stringify(input.query)}`,
    caller
  }
].slice(0, limit);

process.stdout.write(JSON.stringify({ ok: true, results }, null, 2));
```

## How should canonical request hashes be computed?

The request hash must be deterministic. Object keys are sorted lexicographically. Array order is preserved. `undefined` is rejected because it is not canonical JSON. Non-JSON bodies should be hashed as bytes and represented as `bodyHash` in the canonical object.

```js
import crypto from "node:crypto";

export function base64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function stableStringify(value) {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => {
      const v = value[key];
      if (typeof v === "undefined") throw new Error("undefined is not canonical JSON");
      return `${JSON.stringify(key)}:${stableStringify(v)}`;
    }).join(",")}}`;
  }

  return JSON.stringify(value);
}

export function sha256Base64Url(value) {
  return base64url(crypto.createHash("sha256").update(value).digest());
}

export function mcpToolRequestHash({ tool, args }) {
  return sha256Base64Url(stableStringify({
    method: "POST",
    path: "/mcp",
    tool,
    arguments: args
  }));
}
```

## How should an Agent Assertion JWT be signed?

A source agent signs an Agent Assertion JWT with its own `PLOINKY_AGENT_SECRET`. The token is sent to the router and proves only source-agent identity. The router still applies MCP policy before proxying the request.

```js
import crypto from "node:crypto";
import { base64url, mcpToolRequestHash } from "./request-hash.mjs";

function signJwtHS256(claims, secretBase64Url) {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto
    .createHmac("sha256", Buffer.from(secretBase64Url, "base64url"))
    .update(signingInput)
    .digest();

  return `${signingInput}.${base64url(signature)}`;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createAgentAssertion({ targetAgent, tool, args }) {
  const agentId = process.env.PLOINKY_AGENT_ID;
  const secret = process.env.PLOINKY_AGENT_SECRET;

  if (!agentId || !secret) {
    throw new Error("Missing PLOINKY_AGENT_ID or PLOINKY_AGENT_SECRET");
  }

  const now = Math.floor(Date.now() / 1000);

  return signJwtHS256({
    typ: "agent-assertion",
    iss: agentId,
    sub: agentId,
    aud: "ploinky-router",
    method: "POST",
    path: "/mcp",
    targetAgent,
    tool,
    rch: mcpToolRequestHash({ tool, args }),
    iat: now,
    exp: now + 60,
    jti: newId("agt")
  }, secret);
}
```

## How should an agent call another agent through the router?

A source agent sends the request to aggregate `/mcp` on the router. It should not call the target agent's local port. The request body identifies the target route or agent, tool name, and arguments. The authorization header carries the source agent's assertion.

```js
import { createAgentAssertion } from "./agent-assertion.mjs";

export async function callAgentTool({ routerBaseUrl, targetAgent, targetRoute, tool, args }) {
  const body = {
    jsonrpc: "2.0",
    id: `rpc_${crypto.randomUUID().replace(/-/g, "")}`,
    method: "tools/call",
    params: {
      agent: targetRoute,
      name: tool,
      arguments: args
    }
  };

  const token = createAgentAssertion({ targetAgent, tool, args });

  const res = await fetch(new URL("/mcp", routerBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Router denied request: ${res.status} ${await res.text()}`);
  }

  return res.json();
}
```

The import of `crypto` must be added when this snippet is used as a standalone module. The example is intentionally focused on the Ploinky flow rather than packaging details.

## How should a Router Request JWT be verified by an AgentServer?

An AgentServer should verify only Router Request JWTs for protected execution. A raw user session token should not be accepted. The concrete implementation should use the repository's JWT utilities when they exist, but the checks should preserve this shape.

```js
export function verifyRouterRequestClaims({ claims, actual, agentId }) {
  if (claims.typ !== "router-request") throw new Error("invalid token type");
  if (claims.iss !== "ploinky-router") throw new Error("invalid issuer");
  if (claims.aud !== agentId) throw new Error("invalid audience");
  if (claims.method !== actual.method) throw new Error("method mismatch");
  if (claims.path !== actual.path) throw new Error("path mismatch");

  if (claims.tool && claims.tool !== actual.tool) {
    throw new Error("tool mismatch");
  }

  if (claims.rch !== actual.rch) {
    throw new Error("request hash mismatch");
  }

  return true;
}
```

## How should an HTTP service handler treat router auth info?

A protected HTTP service may receive `x-ploinky-auth-info` when the router intentionally injects it. The handler should parse it defensively, avoid trusting client-supplied copies on generic passthrough routes, and avoid logging complete tokens.

```js
export function readRouterAuthInfo(req) {
  const raw = req.headers["x-ploinky-auth-info"];

  if (!raw) {
    return { kind: "missing" };
  }

  try {
    const parsed = JSON.parse(String(raw));
    return {
      kind: "present",
      user: parsed.user?.id,
      caller: parsed.agent?.id,
      hasInvocationToken: Boolean(parsed.invocationToken)
    };
  } catch {
    return { kind: "invalid" };
  }
}
```

The handler may record user id, agent id, route, tool, request id, and decision result. It should not log raw passwords, raw keys, raw JWTs, invocation tokens, or complete secrets.
