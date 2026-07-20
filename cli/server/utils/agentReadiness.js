import fs from 'fs';
import http from 'http';
import net from 'net';
import { ROUTING_FILE } from '../../utils/config.js';

function readRouting() {
    try {
        return JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8')) || {};
    } catch (_) {
        return {};
    }
}

function resolvePort(value) {
    const port = Number(value);
    if (!Number.isFinite(port) || port <= 0) {
        return null;
    }
    return port;
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function probeLocalPort(port, timeoutMs = 250) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let settled = false;
        const finish = (ready) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) { }
            resolve(ready);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

function probeLocalPortDetailed(port, timeoutMs = 250) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (_) { }
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish({ ok: true, reason: 'connected' }));
        socket.once('timeout', () => finish({ ok: false, reason: 'timeout' }));
        socket.once('error', (error) => finish({ ok: false, reason: error?.code || 'error' }));
    });
}

function postJson(host, port, targetPath, payload, timeoutMs = 700, extraHeaders = {}) {
    return new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
        const req = http.request({
            host,
            port,
            path: targetPath,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json, text/event-stream',
                'content-length': String(body.length),
                ...extraHeaders
            },
            timeout: timeoutMs
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers || {},
                    body: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', () => {
            resolve(null);
        });
        req.end(body);
    });
}

async function probeAgentMcp(port, timeoutMs = 700) {
    const initializeResponse = await postJson('127.0.0.1', port, '/mcp', {
        jsonrpc: '2.0',
        id: 'agent-readiness',
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {
                name: 'ploinky-readiness',
                version: '1.0.0'
            }
        }
    }, timeoutMs);
    if (!initializeResponse || initializeResponse.statusCode < 200 || initializeResponse.statusCode >= 300) {
        return false;
    }
    const sessionId = initializeResponse.headers?.['mcp-session-id'];
    try {
        const parsed = JSON.parse(initializeResponse.body || '{}');
        if (!(parsed?.jsonrpc === '2.0' && !!parsed?.result?.protocolVersion)) {
            return false;
        }
    } catch (_) {
        return false;
    }

    const normalizedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    const initAck = await postJson('127.0.0.1', port, '/mcp', {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    }, timeoutMs, normalizedSessionId ? { 'mcp-session-id': normalizedSessionId } : {});
    if (!initAck || (initAck.statusCode !== 204 && (initAck.statusCode < 200 || initAck.statusCode >= 300))) {
        return false;
    }

    const toolsResponse = await new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: 'agent-readiness-tools',
            method: 'tools/list',
            params: {}
        }), 'utf8');
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'accept': 'application/json, text/event-stream',
                'content-length': String(body.length),
                ...(normalizedSessionId ? { 'mcp-session-id': normalizedSessionId } : {})
            },
            timeout: timeoutMs
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                statusCode: res.statusCode || 0,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve(null));
        req.end(body);
    });
    if (!toolsResponse || toolsResponse.statusCode < 200 || toolsResponse.statusCode >= 300) {
        return false;
    }
    try {
        const parsed = JSON.parse(toolsResponse.body || '{}');
        return parsed?.jsonrpc === '2.0' && Array.isArray(parsed?.result?.tools);
    } catch (_) {
        return false;
    }
}

export function resolveAgentRoute(agentName) {
    if (!agentName || typeof agentName !== 'string') {
        return null;
    }
    const routing = readRouting();
    return routing?.routes?.[agentName] || null;
}

export function resolveAgentPort(agentOrRoute) {
    if (!agentOrRoute) {
        return null;
    }
    if (typeof agentOrRoute === 'number' || typeof agentOrRoute === 'string') {
        if (/^\d+$/.test(String(agentOrRoute).trim())) {
            return resolvePort(agentOrRoute);
        }
        const route = resolveAgentRoute(String(agentOrRoute).trim());
        return resolvePort(route?.hostPort);
    }
    if (typeof agentOrRoute === 'object') {
        return resolvePort(agentOrRoute.hostPort);
    }
    return null;
}

export async function waitForAgentReady(agentOrRoute, {
    timeoutMs = 5000,
    intervalMs = 125,
    probeTimeoutMs = 250,
    protocol = 'mcp',
    onProgress = null
} = {}) {
    const port = resolveAgentPort(agentOrRoute);
    if (!port) {
        return false;
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const normalizedProtocol = String(protocol || 'mcp').trim().toLowerCase();
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
        attempt += 1;
        const portProbe = await probeLocalPortDetailed(port, probeTimeoutMs);
        if (portProbe.ok) {
            if (normalizedProtocol === 'tcp') {
                if (typeof onProgress === 'function') {
                    onProgress({
                        port,
                        protocol: normalizedProtocol,
                        elapsedMs: Date.now() - startedAt,
                        timeoutMs,
                        attempt,
                        portOpen: true,
                        ready: true,
                        stage: 'ready'
                    });
                }
                return true;
            }
            const mcpReady = await probeAgentMcp(port, Math.max(500, probeTimeoutMs * 2));
            if (mcpReady) {
                if (typeof onProgress === 'function') {
                    onProgress({
                        port,
                        protocol: normalizedProtocol,
                        elapsedMs: Date.now() - startedAt,
                        timeoutMs,
                        attempt,
                        portOpen: true,
                        ready: true,
                        stage: 'ready'
                    });
                }
                return true;
            }
            if (typeof onProgress === 'function') {
                onProgress({
                    port,
                    protocol: normalizedProtocol,
                    elapsedMs: Date.now() - startedAt,
                    timeoutMs,
                    attempt,
                    portOpen: true,
                    ready: false,
                    stage: 'waiting_for_protocol'
                });
            }
        } else if (typeof onProgress === 'function') {
            onProgress({
                port,
                protocol: normalizedProtocol,
                elapsedMs: Date.now() - startedAt,
                timeoutMs,
                attempt,
                portOpen: false,
                ready: false,
                stage: 'waiting_for_port',
                lastError: portProbe.reason
            });
        }
        if (Date.now() >= deadline) {
            return false;
        }
        await wait(intervalMs);
    }
}
