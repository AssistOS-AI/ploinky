// AgentClient: minimal MCP client wrapper used by RoutingServer.
// Not a class; exposes factory returning concrete methods for MCP interactions.

import { client as mcpClient, StreamableHTTPClientTransport } from 'mcp-sdk';
import { relayHttpCall } from './proxy/relayHttpCall.js';
const { Client } = mcpClient;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_TOOL_CALL_TIMEOUT_MS = parsePositiveInt(
  process.env.PLOINKY_MCP_TOOL_CALL_TIMEOUT_MS,
  600000
);

function createAgentClient(baseUrl, options = {}) {
  let client = null;
  let transport = null;
  let connected = false;
  const requestHeaders = options && typeof options === 'object' && options.requestHeaders && typeof options.requestHeaders === 'object'
    ? options.requestHeaders
    : null;

  async function connect() {
    if (connected && client && transport) return;
    transport = new StreamableHTTPClientTransport(new URL(baseUrl), requestHeaders
      ? { requestInit: { headers: requestHeaders } }
      : undefined);
    client = new Client({ name: 'ploinky-router', version: '1.0.0' });
    await client.connect(transport);
    connected = true;
  }

  async function listTools() {
    await connect();
    const { tools } = await client.listTools({});
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
    const { resources } = await client.listResources({});
    return resources || [];
  }

  async function readResource(uri) {
    await connect();
    const res = await client.readResource({ uri });
    return res?.resource ?? res;
  }

  async function ping() {
    await connect();
    return await client.ping();
  }

  async function close() {
    try { if (transport?.terminateSession) await transport.terminateSession(); } catch (_) {}
    try { if (client) await client.close(); } catch (_) {}
    try { if (transport) await transport.close?.(); } catch (_) {}
    connected = false; client = null; transport = null;
  }

  return { connect, listTools, callTool, listResources, readResource, ping, close };
}

function readSessionHeader(headers = {}) {
  const value = headers['mcp-session-id'];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function createAgentRelayClient(routeKey, options = {}) {
  let sessionId = '';
  let initialized = false;
  let nextId = 1;
  const requestHeaders = options?.requestHeaders && typeof options.requestHeaders === 'object'
    ? options.requestHeaders
    : {};

  async function send(payload, { notification = false, method = 'POST' } = {}) {
    const body = method === 'POST' ? Buffer.from(JSON.stringify(payload), 'utf8') : null;
    const response = await relayHttpCall({
      routeKey,
      method,
      target: '/mcp',
      body,
      timeoutMs: options.timeoutMs,
      headers: {
        accept: 'application/json, text/event-stream',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...requestHeaders,
      },
    });
    const responseSession = readSessionHeader(response.headers);
    if (responseSession) sessionId = responseSession;
    if (notification || response.statusCode === 204) return null;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`agent relay MCP request failed (${response.statusCode})`);
    }
    let parsed;
    try { parsed = JSON.parse(response.body.toString('utf8') || '{}'); } catch (_) {
      throw new Error('agent relay MCP response is not JSON');
    }
    if (parsed?.error) throw new Error(parsed.error.message || 'agent relay MCP error');
    return parsed?.result;
  }

  async function connect() {
    if (initialized) return;
    await send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ploinky-router', version: '1.0.0' },
      },
    });
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { notification: true });
    initialized = true;
  }

  async function request(method, params = {}) {
    await connect();
    return send({ jsonrpc: '2.0', id: nextId++, method, params });
  }

  async function close() {
    if (!sessionId) return;
    try {
      await relayHttpCall({ routeKey, method: 'DELETE', target: '/mcp', headers: { 'mcp-session-id': sessionId } });
    } catch (_) {}
    sessionId = '';
    initialized = false;
  }

  return {
    connect,
    listTools: async () => (await request('tools/list'))?.tools || [],
    callTool: async (name, args) => request('tools/call', { name, arguments: args || {} }),
    listResources: async () => (await request('resources/list'))?.resources || [],
    readResource: async uri => (await request('resources/read', { uri }))?.resource,
    ping: async () => request('ping'),
    close,
  };
}

export { createAgentClient, createAgentRelayClient };
