// AgentClient: minimal MCP client wrapper used by RoutingServer.
// Not a class; exposes factory returning concrete methods for MCP interactions.

import { client as mcpClient, StreamableHTTPClientTransport } from 'mcp-sdk';
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
// Bound for the direct DELETE that releases an allocated upstream session.
const SESSION_RELEASE_TIMEOUT_MS = 1000;

// The upstream session a transport was allocated, read through the SDK's
// public accessors only.
function allocatedSession(transport) {
  const sessionId = transport?.sessionId;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const protocolVersion = transport?.protocolVersion;
  return { sessionId, protocolVersion: typeof protocolVersion === 'string' ? protocolVersion : '' };
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.cause?.name === 'AbortError';
}

function createAgentClient(baseUrl, options = {}) {
  let client = null;
  let transport = null;
  let connected = false;
  let connecting = null;
  // Upstream session ids this client already released (one DELETE each).
  const releasedSessionIds = new Set();
  const requestHeaders = options && typeof options === 'object' && options.requestHeaders && typeof options.requestHeaders === 'object'
    ? options.requestHeaders
    : null;
  const beforeConnect = typeof options?.beforeConnect === 'function' ? options.beforeConnect : null;
  const beforeDispatch = typeof options?.beforeDispatch === 'function' ? options.beforeDispatch : null;
  const requestTimeoutMs = parsePositiveInt(options?.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);

  // Release an allocated upstream session with a plain DELETE carrying the
  // headers the SDK would send. Used when the SDK's own transport was already
  // aborted (for example after a failed connect), so its terminateSession()
  // could not reach the agent. Never runs the dispatch guard: this only ends
  // this client's private upstream session.
  async function releaseSession(session) {
    if (!session || releasedSessionIds.has(session.sessionId)) return;
    releasedSessionIds.add(session.sessionId);
    const headers = { ...(requestHeaders || {}), 'mcp-session-id': session.sessionId };
    if (session.protocolVersion) headers['mcp-protocol-version'] = session.protocolVersion;
    try {
      const response = await fetch(new URL(baseUrl), {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(SESSION_RELEASE_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => {});
    } catch (_) {}
  }

  async function openConnection() {
    if (beforeConnect && beforeConnect() !== true) {
      const error = new Error('edge routing generation changed before upstream connection');
      error.code = 'EDGE_GENERATION_CHANGED';
      throw error;
    }
    const nextTransport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      ...(requestHeaders ? { requestInit: { headers: requestHeaders } } : {}),
      ...(beforeDispatch ? { fetch: (url, init) => {
        // Run after SDK connection/header awaits, immediately before transport
        // dispatch. DELETE only releases this client's private upstream session.
        if (init?.method !== 'DELETE') beforeDispatch();
        return fetch(url, init);
      } } : {}),
    });
    const nextClient = new Client({ name: 'ploinky-router', version: '1.0.0' });
    transport = nextTransport;
    client = nextClient;
    try {
      await nextClient.connect(nextTransport, { timeout: requestTimeoutMs });
    } catch (error) {
      // The SDK closes (aborts) the transport when connect fails, so a session
      // the agent already allocated is released here, directly, before the
      // error is reported.
      if (transport === nextTransport) {
        transport = null;
        client = null;
      }
      await releaseSession(allocatedSession(nextTransport));
      throw error;
    }
    connected = true;
  }

  async function connect() {
    if (connected && client && transport) return;
    if (!connecting) {
      connecting = openConnection().finally(() => { connecting = null; });
    }
    await connecting;
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
    const session = allocatedSession(transport);
    if (session && !releasedSessionIds.has(session.sessionId)) {
      try {
        if (transport?.terminateSession) await transport.terminateSession();
        releasedSessionIds.add(session.sessionId);
      } catch (error) {
        // An aborted transport never sent its DELETE; release directly. Any
        // other failure means the DELETE was already sent, so do not repeat it.
        if (isAbortError(error)) await releaseSession(session);
        else releasedSessionIds.add(session.sessionId);
      }
    }
    try { if (client) await client.close(); } catch (_) {}
    try { if (transport) await transport.close?.(); } catch (_) {}
    connected = false; client = null; transport = null;
  }

  return { connect, listTools, callTool, listResources, readResource, ping, close };
}

export { createAgentClient };
