import fs from 'fs';
import crypto from 'node:crypto';
import http from 'http';
import net from 'net';
import {
    computeRchTool,
    sha256RawBodyHash,
} from '../../../Agent/lib/requestHash.mjs';
import { assertExactServiceOwner } from '../../sandbox/bwrap/bwrapFleet.js';
import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import { resolveAgentReadinessPort } from '../../utils/runtime/startupReadiness.js';
import { ROUTING_FILE } from '../../utils/config.js';
import { buildRouterRequest } from '../mcp-proxy/invocationMinter.js';
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

const SANDBOX_SERVICE_RUNTIMES = new Set(['bwrap', 'seatbelt']);

function sandboxReadinessError(message, code = 'SANDBOX_AGENT_READINESS_INVALID') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function exactNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim()
        ? value
        : '';
}

function exactServicePort(value) {
    return Number.isSafeInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function readinessRuntimeError(runtime) {
    const error = new Error(`agent readiness requires an exact selected runtime; received ${JSON.stringify(runtime)}`);
    error.code = 'PLOINKY_AGENT_READINESS_RUNTIME_INVALID';
    return error;
}

function exactSandboxReadinessRoute({ route, manifest, runtimeResult, record }) {
    const runtime = record.runtime;
    const containerName = exactNonEmptyString(runtimeResult?.containerName || route?.container);
    const routeDeclaresContainer = route?.container !== undefined;
    const routeContainer = routeDeclaresContainer ? exactNonEmptyString(route.container) : '';
    const effectiveInstanceId = exactNonEmptyString(record.instanceId);
    const enableGeneration = exactNonEmptyString(record.enableGeneration);
    const repoName = exactNonEmptyString(record.repoName);
    const agentName = exactNonEmptyString(record.agentName);
    const owner = record.bwrapOwner;
    const runtimeHostPort = exactServicePort(runtimeResult?.hostPort);
    const routeHostPort = exactServicePort(route?.hostPort);
    const ownerHostPort = exactServicePort(owner?.rootPort);
    const explicitReadinessPort = resolveAgentReadinessPort(manifest);

    if (!SANDBOX_SERVICE_RUNTIMES.has(runtime)
        || !containerName
        || (routeDeclaresContainer && !routeContainer)
        || (routeContainer && routeContainer !== containerName)
        || !effectiveInstanceId
        || !enableGeneration
        || !repoName
        || !agentName
        || !owner
        || typeof owner !== 'object'
        || Array.isArray(owner)
        || owner.role !== 'service'
        || owner.runtimeKey !== containerName
        || typeof owner.routeKey !== 'string'
        || !owner.routeKey
        || owner.instanceId !== effectiveInstanceId
        || owner.enableGeneration !== enableGeneration
        || !runtimeHostPort
        || !routeHostPort
        || !ownerHostPort
        || runtimeHostPort !== routeHostPort
        || runtimeHostPort !== ownerHostPort) {
        throw sandboxReadinessError('sandbox readiness requires one exact owner-bound principal, generation, route, and root port');
    }
    if (explicitReadinessPort && explicitReadinessPort !== runtimeHostPort) {
        throw sandboxReadinessError(
            'sandbox readiness supports only the authenticated root MCP port',
            'BWRAP_AGENT_PORT_UNSUPPORTED',
        );
    }

    let targetAgentId;
    try {
        targetAgentId = deriveAgentPrincipalId(repoName, agentName);
    } catch (cause) {
        throw sandboxReadinessError(`sandbox readiness principal is invalid: ${cause?.message || cause}`);
    }
    const sandboxOwner = Object.freeze({ ...owner });
    return {
        ...route,
        container: containerName,
        hostPort: runtimeHostPort,
        sandboxReadiness: Object.freeze({
            kind: 'sandbox-root-mcp',
            runtime,
            targetAgentId,
            effectiveInstanceId,
            enableGeneration,
            hostPort: runtimeHostPort,
            sandboxOwner,
        }),
    };
}

export function buildRelayReadinessRoute({
    route = {},
    manifest = {},
    runtimeResult = {},
    networkMode = '',
    generationDigest = '',
} = {}) {
    const record = runtimeResult?.registryRecord;
    const runtime = record?.runtime;
    if (SANDBOX_SERVICE_RUNTIMES.has(runtime)) {
        return exactSandboxReadinessRoute({ route, manifest, runtimeResult, record });
    }
    if (!['docker', 'podman'].includes(runtime)) throw readinessRuntimeError(runtime);
    const port = resolveAgentReadinessPort(manifest);
    const resultContainerId = runtimeResult?.containerId;
    const recordContainerId = record.containerId;
    const containerId = resultContainerId;
    const containerName = exactNonEmptyString(runtimeResult?.containerName || route?.container);
    const routeDeclaresContainer = route?.container !== undefined;
    const routeContainer = routeDeclaresContainer ? exactNonEmptyString(route.container) : '';
    const effectiveInstanceId = exactNonEmptyString(record.instanceId);
    const enableGeneration = exactNonEmptyString(record.enableGeneration);
    const repoName = exactNonEmptyString(record.repoName);
    const agentName = exactNonEmptyString(record.agentName);
    if (typeof containerId !== 'string'
        || !/^[a-f0-9]{64}$/.test(containerId)
        || typeof recordContainerId !== 'string'
        || recordContainerId !== containerId
        || !containerName
        || (routeDeclaresContainer && !routeContainer)
        || (routeContainer && routeContainer !== containerName)
        || !effectiveInstanceId
        || !enableGeneration
        || !repoName
        || !agentName) {
        throw readinessRuntimeError(runtime);
    }
    if (!port) return { ...route, container: containerName };
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
            kind: 'container-exec-stdio',
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

function resolveSandboxReadinessRoute(agentOrRoute) {
    const route = typeof agentOrRoute === 'string'
        ? resolveAgentRoute(agentOrRoute)
        : agentOrRoute;
    const readiness = route?.sandboxReadiness;
    if (readiness?.kind !== 'sandbox-root-mcp'
        || !SANDBOX_SERVICE_RUNTIMES.has(readiness.runtime)
        || !exactNonEmptyString(readiness.targetAgentId)
        || !exactNonEmptyString(readiness.effectiveInstanceId)
        || !exactNonEmptyString(readiness.enableGeneration)
        || !Number.isInteger(readiness.hostPort)
        || readiness.hostPort < 1
        || readiness.hostPort > 65535
        || readiness.hostPort !== exactServicePort(route?.hostPort)
        || !readiness.sandboxOwner
        || typeof readiness.sandboxOwner !== 'object'
        || Array.isArray(readiness.sandboxOwner)) {
        return null;
    }
    return route;
}

function hasSandboxReadinessMarker(agentOrRoute) {
    const route = typeof agentOrRoute === 'string'
        ? resolveAgentRoute(agentOrRoute)
        : agentOrRoute;
    return Boolean(route && Object.prototype.hasOwnProperty.call(route, 'sandboxReadiness'));
}

function verifySandboxReadinessOwner(route) {
    assertExactServiceOwner(route.sandboxReadiness.sandboxOwner);
    return true;
}

const BWRAP_READINESS_TOOL = '__ploinky_readiness__';

function bwrapInitializeParams() {
    return {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {
            name: 'ploinky-readiness',
            version: '1.0.0',
        },
    };
}

async function probeSandboxMcp(route, timeoutMs, {
    beforeDial = verifySandboxReadinessOwner,
    createConnection = net.createConnection,
    mintRouterRequest = buildRouterRequest,
} = {}) {
    const readiness = route.sandboxReadiness;
    const params = bwrapInitializeParams();
    const payload = {
        jsonrpc: '2.0',
        id: 'agent-readiness',
        method: 'initialize',
        params,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const rch = computeRchTool({
        method: 'POST',
        path: '/mcp',
        tool: BWRAP_READINESS_TOOL,
        arguments: params,
    });
    const minted = await mintRouterRequest({
        targetAgentId: readiness.targetAgentId,
        sub: 'ploinky-router',
        actor: { kind: 'agent', id: 'ploinky-router', roles: [] },
        method: 'POST',
        path: '/mcp',
        tool: BWRAP_READINESS_TOOL,
        rch,
    });
    const token = typeof minted === 'string' ? minted : minted?.token;
    if (typeof token !== 'string' || !token) {
        throw sandboxReadinessError('sandbox readiness minter returned no router-request token');
    }

    const ownerCheckedAgent = new http.Agent({ keepAlive: false });
    ownerCheckedAgent.createConnection = (options, callback) => {
        if (beforeDial(route) !== true) {
            throw sandboxReadinessError(
                'sandbox readiness owner verification rejected the socket',
                'SANDBOX_AGENT_OWNER_INVALID',
            );
        }
        return createConnection(options, callback);
    };

    try {
        return await new Promise((resolve) => {
            const request = http.request({
                host: '127.0.0.1',
                port: readiness.hostPort,
                path: '/mcp',
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'x-ploinky-readiness-probe': 'v1',
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    'content-length': String(body.length),
                },
                timeout: timeoutMs,
                agent: ownerCheckedAgent,
            }, (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
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
            request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
            request.on('error', () => resolve(false));
            request.end(body);
        });
    } finally {
        ownerCheckedAgent.destroy();
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
    sandboxProbe = probeSandboxMcp,
    sandboxBeforeDial = verifySandboxReadinessOwner,
    sandboxCreateConnection = net.createConnection,
    sandboxMintRouterRequest = buildRouterRequest,
} = {}) {
    const readinessTarget = typeof agentOrRoute === 'string'
        && !/^\d+$/.test(agentOrRoute.trim())
        ? resolveAgentRoute(agentOrRoute.trim())
        : agentOrRoute;
    const sandboxRoute = resolveSandboxReadinessRoute(readinessTarget);
    if (hasSandboxReadinessMarker(readinessTarget) && !sandboxRoute) return false;
    const relayRoute = resolveRelayReadinessRoute(readinessTarget);
    const port = resolveAgentPort(readinessTarget);
    if (!sandboxRoute && !relayRoute && !port) {
        return false;
    }
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const normalizedProtocol = String(protocol || 'mcp').trim().toLowerCase();
    if (!['tcp', 'mcp'].includes(normalizedProtocol)) return false;
    if (sandboxRoute && normalizedProtocol !== 'mcp') return false;
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
        attempt += 1;
        if (beforeProbe && beforeProbe() !== true) return false;
        if (sandboxRoute) {
            let ready = false;
            let lastError = '';
            try {
                ready = await sandboxProbe(
                    sandboxRoute,
                    Math.max(500, probeTimeoutMs * 2),
                    {
                        beforeDial: sandboxBeforeDial,
                        createConnection: sandboxCreateConnection,
                        mintRouterRequest: sandboxMintRouterRequest,
                    },
                );
            } catch (error) {
                lastError = error?.code || error?.message || 'error';
            }
            onProgress?.({
                port: sandboxRoute.sandboxReadiness.hostPort,
                protocol: normalizedProtocol,
                elapsedMs: Date.now() - startedAt,
                timeoutMs,
                attempt,
                portOpen: ready,
                ready,
                stage: ready ? 'ready' : 'waiting_for_authenticated_mcp',
                lastError,
            });
            if (ready) return true;
            if (Date.now() >= deadline) return false;
            await wait(intervalMs);
            continue;
        }
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
