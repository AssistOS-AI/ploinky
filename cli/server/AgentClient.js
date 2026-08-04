// AgentClient: minimal MCP client wrapper used by RoutingServer.
// Not a class; exposes factory returning concrete methods for MCP interactions.

import { client as mcpClient, StreamableHTTPClientTransport } from 'mcp-sdk';
import { createLeaseCommittedAgent, createRootAgentFetch } from './rootAgentDial.js';
const { Client } = mcpClient;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_TOOL_CALL_TIMEOUT_MS = parsePositiveInt(
  process.env.PLOINKY_MCP_TOOL_CALL_TIMEOUT_MS,
  600000
);
const DEFAULT_REQUEST_TIMEOUT_MS = parsePositiveInt(
  process.env.PLOINKY_MCP_REQUEST_TIMEOUT_MS,
  5000
);

function createAgentClient(baseUrl, options = {}) {
  if (!options?.dialContext || typeof options.dialContext.commit !== 'function') {
    throw new TypeError('router AgentClient requires a captured root AgentServer dial context');
  }
  let client = null;
  let transport = null;
  let connected = false;
  const requestHeaders = options && typeof options === 'object' && options.requestHeaders && typeof options.requestHeaders === 'object'
    ? options.requestHeaders
    : null;
  // Streamable HTTP keeps an independently guarded SSE socket open while MCP
  // requests may run concurrently. A single-socket Agent deadlocks requests
  // behind the stream; every admitted socket still passes the same guard.
  const guardedAgent = createLeaseCommittedAgent(options.dialContext, { maxSockets: Infinity });
  const guardedFetch = createRootAgentFetch(guardedAgent);
  const requestTimeoutMs = parsePositiveInt(options?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);

  async function connect() {
    if (connected && client && transport) return;
    transport = new StreamableHTTPClientTransport(new URL(baseUrl), requestHeaders
      ? { requestInit: { headers: requestHeaders }, fetch: guardedFetch }
      : { fetch: guardedFetch });
    client = new Client({ name: 'ploinky-router', version: '1.0.0' });
    await client.connect(transport, { timeout: requestTimeoutMs });
    connected = true;
  }

  async function listTools() {
    await connect();
    const { tools } = await client.listTools({}, { timeout: requestTimeoutMs });
    return tools || [];
  }

  async function callTool(name, args, callOptions = {}) {
    await connect();
    const timeout = parsePositiveInt(callOptions.timeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS);
    const result = await client.callTool(
      { name, arguments: args || {} },
      undefined,
      { timeout }
    );
    return result;
  }

  async function listResources() {
    await connect();
    const { resources } = await client.listResources({}, { timeout: requestTimeoutMs });
    return resources || [];
  }

  async function readResource(uri) {
    await connect();
    const res = await client.readResource({ uri }, { timeout: requestTimeoutMs });
    return res?.resource ?? res;
  }

  async function ping() {
    await connect();
    return await client.ping({ timeout: requestTimeoutMs });
  }

  async function close() {
    try { if (transport?.terminateSession) await transport.terminateSession(); } catch (_) {}
    try { if (client) await client.close(); } catch (_) {}
    try { if (transport) await transport.close?.(); } catch (_) {}
    try { guardedAgent?.destroy(); } catch (_) {}
    connected = false; client = null; transport = null;
  }

  return { connect, listTools, callTool, listResources, readResource, ping, close };
}

export { createAgentClient };
