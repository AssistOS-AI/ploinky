// AgentMcpClient: MCP client helper for agents to call other agents via RoutingServer.
// Uses mcp-sdk Client and StreamableHTTPClientTransport, similar to cli/server/AgentClient.js.
// Includes OAuth token management for agent-to-agent authentication.

import { client as mcpClient, StreamableHTTPClientTransport } from 'mcp-sdk';
import http from 'http';
import https from 'https';

const { Client } = mcpClient;

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get router URL from environment variables
 */
export function getRouterUrl() {
    const routerUrl = process.env.PLOINKY_ROUTER_URL;
    if (routerUrl && typeof routerUrl === 'string' && routerUrl.trim()) {
        return routerUrl.trim();
    }
    const routerPort = process.env.PLOINKY_ROUTER_PORT || '8080';
    return `http://127.0.0.1:${routerPort}`;
}

/**
 * Get agent MCP endpoint URL for a target agent
 */
export function getAgentMcpUrl(agentName) {
    const routerUrl = getRouterUrl();
    return `${routerUrl}/${agentName}/mcp`;
}

/**
 * Get OAuth access token for agent authentication
 * Caches token and refreshes when expired
 */
export async function getAgentAccessToken() {
    const now = Date.now();
    
    // Return cached token if still valid (with 60 second buffer)
    if (cachedToken && tokenExpiresAt > now + 60000) {
        return cachedToken;
    }
    
    const clientId = process.env.PLOINKY_AGENT_CLIENT_ID;
    const clientSecret = process.env.PLOINKY_AGENT_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
        throw new Error('PLOINKY_AGENT_CLIENT_ID and PLOINKY_AGENT_CLIENT_SECRET must be set');
    }
    
    const routerUrl = getRouterUrl();
    const tokenUrl = `${routerUrl}/auth/agent-token`;
    
    // Request token from router
    const tokenData = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ client_id: clientId, client_secret: clientSecret });
        const url = new URL(tokenUrl);
        const httpModule = url.protocol === 'https:' ? https : http;
        const pathWithQuery = `${url.pathname}${url.search || ''}`;
        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: pathWithQuery,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        
        const req = httpModule.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const responseText = Buffer.concat(chunks).toString('utf8');
                try {
                    const parsed = JSON.parse(responseText);
                    if (!parsed.ok) {
                        reject(new Error(parsed.error || 'Token request failed'));
                        return;
                    }
                    resolve(parsed);
                } catch (err) {
                    reject(new Error(`Invalid token response: ${responseText}`));
                }
            });
        });
        
        req.on('error', reject);
        req.write(body);
        req.end();
    });
    
    cachedToken = tokenData.access_token;
    const expiresIn = tokenData.expires_in || 3600;
    tokenExpiresAt = now + (expiresIn * 1000);
    
    return cachedToken;
}

/**
 * Create MCP client for calling another agent via router
 */
export async function createAgentClient(agentName) {
    const agentUrl = getAgentMcpUrl(agentName);
    let client = null;
    let transport = null;
    let connected = false;
    
    // Get OAuth token
    const accessToken = await getAgentAccessToken();
    
    async function connect() {
        if (connected && client && transport) return;
        
        // Create transport with Authorization header in requestInit
        const url = new URL(agentUrl);
        transport = new StreamableHTTPClientTransport(url, {
            requestInit: {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        });
        
        client = new Client({ name: 'ploinky-agent-client', version: '1.0.0' });
        await client.connect(transport);
        connected = true;
    }
    
    async function listTools() {
        await connect();
        const { tools } = await client.listTools({});
        return tools || [];
    }
    
    async function callTool(name, args) {
        await connect();
        const result = await client.callTool({ name, arguments: args || {} });
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
        try {
            if (client) await client.close();
        } catch (_) {}
        try {
            if (transport) await transport.close?.();
        } catch (_) {}
        connected = false;
        client = null;
        transport = null;
    }
    
    return { connect, listTools, callTool, listResources, readResource, ping, close };
}

// Test helper to reset cached token state (used by automated tests)
export function __resetAgentClientTestState() {
    cachedToken = null;
    tokenExpiresAt = 0;
}
