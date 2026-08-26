import fs from 'fs';
import crypto from 'node:crypto';
import http from 'http';
import net from 'net';
import { sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { resolveAgentReadinessPort } from '../../utils/runtime/startupReadiness.js';
import { ROUTING_FILE } from '../../utils/config.js';
import { createRelayHttpAgent, RelayDuplex } from '../proxy/executeHttpPlan.js';
import { compileProxyLimits } from '../proxy/limits.js';
import { RuntimeRelayManager } from '../runtimeRelay/RuntimeRelayManager.js';
import { RelayRequestMinter } from '../runtimeRelay/relayRequestMinter.js';

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

export function buildRelayReadinessRoute({
    route = {},
    manifest = {},
    runtimeResult = {},
    networkMode = '',
    generationDigest = '',
} = {}) {
    const port = resolveAgentReadinessPort(manifest);
    if (!port) return route;
    const record = runtimeResult?.registryRecord || {};
    const runtime = String(record.runtime || '').trim();
    const containerId = String(runtimeResult?.containerId || record.containerId || '').trim().toLowerCase();
    const containerName = String(runtimeResult?.containerName || route?.container || '').trim();
    const effectiveInstanceId = String(record.instanceId || '').trim();
    const enableGeneration = String(record.enableGeneration || '').trim();
    const repoName = String(record.repoName || '').trim();
    const agentName = String(record.agentName || '').trim();
    if (!['docker', 'podman'].includes(runtime)
        || !/^[a-f0-9]{64}$/.test(containerId)
        || !containerName
        || !effectiveInstanceId
        || !enableGeneration
        || !repoName
        || !agentName) {
        return route;
    }
    const targetAgentId = deriveAgentPrincipalId(repoName, agentName);
    const digest = String(generationDigest || '').trim() || crypto.createHash('sha256')
        .update(JSON.stringify([
            targetAgentId,
            effectiveInstanceId,
            enableGeneration,
            containerId,
            port,
        ]))
        .digest('hex');
    const hostNetwork = String(networkMode || '').trim().toLowerCase() === 'host';
    return {
        ...route,
        relay: {
            kind: 'container-control-socket',
            runtime,
            containerId,
            containerName,
            targetAgentId,
            effectiveInstanceId,
            enableGeneration,
            networkMode: hostNetwork ? 'host' : '',
        },
        owner: {
            effectiveInstanceId,
            enableGeneration,
        },
        primaryService: { port },
        deniedPorts: hostNetwork ? [8080, 8081] : [],
        generationDigest: digest,
    };
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

function resolveRelayReadinessRoute(agentOrRoute) {
    const route = typeof agentOrRoute === 'string'
        ? resolveAgentRoute(agentOrRoute)
        : agentOrRoute;
    if (!route?.relay
        || !route?.owner?.effectiveInstanceId
        || !route?.owner?.enableGeneration
        || !Number.isInteger(route?.primaryService?.port)
        || !String(route?.generationDigest || '')) {
        return null;
    }
    return route;
}

function relayReadinessPlan(route, protocol) {
    return Object.freeze({
        relay: route.relay,
        owner: Object.freeze({
            effectiveInstanceId: route.owner.effectiveInstanceId,
            enableGeneration: route.owner.enableGeneration,
        }),
        deniedPorts: Object.freeze([...(route.deniedPorts || [])]),
        generationDigest: route.generationDigest,
        limits: compileProxyLimits(),
        method: protocol === 'tcp' ? 'GET' : 'POST',
        port: route.primaryService.port,
        targetPath: protocol === 'tcp' ? '/' : '/mcp',
        query: '',
        transport: 'http',
    });
}

async function probeRelay(route, protocol, timeoutMs) {
    const plan = relayReadinessPlan(route, protocol);
    const minter = new RelayRequestMinter({ resolveAgentSecret: deriveAgentRequestSecret });
    const manager = new RuntimeRelayManager({ minter, limits: plan.limits });
    const lease = { commit: () => true, release() {} };
    const channel = await manager.checkout({ plan, lease, authorized: true });
    let relayAgent;
    try {
        if (protocol === 'tcp') {
            const stream = await channel.openRequest({
                plan,
                bodyMode: 'none',
                bodyHash: sha256RawBodyHash(),
                headers: {},
            });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error('readiness connect timeout')),
                    timeoutMs,
                );
                timer.unref?.();
                stream.once('ready', () => {
                    clearTimeout(timer);
                    resolve();
                });
                stream.once('error', error => {
                    clearTimeout(timer);
                    reject(error);
                });
            });
            stream.cancel();
            return true;
        }
        const body = Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: 'agent-readiness',
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: {
                    name: 'ploinky-readiness',
                    version: '1.0.0',
                },
            },
        }));
        const stream = await channel.openRequest({
            plan,
            bodyMode: 'buffered',
            bodyHash: sha256RawBodyHash(body),
            headers: {},
        });
        const connection = new RelayDuplex(stream);
        relayAgent = createRelayHttpAgent(connection);
        return await new Promise((resolve) => {
            const request = http.request({
                method: 'POST',
                path: '/mcp',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    'content-length': String(body.length),
                    host: `127.0.0.1:${plan.port}`,
                },
                agent: relayAgent,
            }, response => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
                        resolve(false);
                        return;
                    }
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        resolve(parsed?.jsonrpc === '2.0' && Boolean(parsed?.result?.protocolVersion));
                    } catch (_) {
                        resolve(false);
                    }
                });
            });
            request.setTimeout(timeoutMs, () => request.destroy());
            request.on('error', () => resolve(false));
            request.end(body);
        });
    } finally {
        relayAgent?.destroy();
        channel.close();
        manager.close();
    }
}

export async function waitForAgentReady(agentOrRoute, {
    timeoutMs = 5000,
    intervalMs = 125,
    probeTimeoutMs = 250,
    protocol = 'mcp',
    onProgress = null,
    beforeProbe = null,
    relayProbe = probeRelay,
} = {}) {
    const relayRoute = resolveRelayReadinessRoute(agentOrRoute);
    const port = resolveAgentPort(agentOrRoute);
    if (!relayRoute && !port) {
        return false;
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const normalizedProtocol = String(protocol || 'mcp').trim().toLowerCase();
    if (!['tcp', 'mcp'].includes(normalizedProtocol)) return false;
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
        attempt += 1;
        if (beforeProbe && beforeProbe() !== true) return false;
        if (relayRoute) {
            let ready = false;
            let lastError = '';
            try {
                ready = await relayProbe(
                    relayRoute,
                    normalizedProtocol,
                    Math.max(500, probeTimeoutMs),
                );
            } catch (error) {
                lastError = error?.code || error?.message || 'error';
            }
            onProgress?.({
                port: relayRoute.primaryService.port,
                protocol: normalizedProtocol,
                elapsedMs: Date.now() - startedAt,
                timeoutMs,
                attempt,
                portOpen: ready,
                ready,
                stage: ready ? 'ready' : 'waiting_for_relay',
                lastError,
            });
            if (ready) return true;
            if (Date.now() >= deadline) return false;
            await wait(intervalMs);
            continue;
        }
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
            if (beforeProbe && beforeProbe() !== true) return false;
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
