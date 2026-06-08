import crypto from "node:crypto";

function base64url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function stableStringify(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => {
      const v = value[key];
      if (typeof v === "undefined") throw new Error("undefined is not canonical JSON");
      return `${JSON.stringify(key)}:${stableStringify(v)}`;
    }).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Base64Url(value) {
  return base64url(crypto.createHash("sha256").update(value).digest());
}

function signJwt(claims, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = crypto.createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64url(signature)}`;
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function callAgentTool({ routerBaseUrl, targetAgent, targetRoute, tool, args }) {
  const agentId = process.env.PLOINKY_AGENT_ID;
  const secret = process.env.PLOINKY_AGENT_SECRET;
  if (!agentId || !secret) throw new Error("Missing PLOINKY_AGENT_ID or PLOINKY_AGENT_SECRET");

  const body = {
    jsonrpc: "2.0",
    id: newId("rpc"),
    method: "tools/call",
    params: {
      agent: targetRoute,
      name: tool,
      arguments: args
    }
  };

  // Keep this canonical input exactly aligned with the RouterServer implementation.
  const rch = sha256Base64Url(stableStringify({
    method: "POST",
    path: "/mcp",
    tool,
    arguments: args
  }));

  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({
    typ: "agent-assertion",
    iss: agentId,
    sub: agentId,
    aud: "ploinky-router",
    method: "POST",
    path: "/mcp",
    targetAgent,
    tool,
    rch,
    iat: now,
    exp: now + 60,
    jti: newId("agt")
  }, secret);

  const res = await fetch(new URL("/mcp", routerBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Router denied request: ${res.status} ${await res.text()}`);
  return res.json();
}
