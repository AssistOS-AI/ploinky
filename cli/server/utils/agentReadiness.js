import crypto from 'node:crypto';
import http from 'node:http';

import { sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { deriveAgentRequestSecret } from '../../utils/security/masterKey.js';
import { RelayRequestMinter } from '../runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../runtimeRelay/RuntimeRelayManager.js';
import { compileProxyLimits } from '../proxy/limits.js';
import { createRelayHttpAgent, RelayDuplex } from '../proxy/executeHttpPlan.js';
import { getActiveGenerationRoutes } from '../generation/runtimeContext.js';

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function resolveAgentRoute(agentName) {
    if (!agentName || typeof agentName !== 'string') return null;
    return getActiveGenerationRoutes()[agentName] || null;
}

export function resolveAgentPrimaryService(agentOrRoute) {
    const route = typeof agentOrRoute === 'string' ? resolveAgentRoute(agentOrRoute) : agentOrRoute;
    if (!route?.relay || !Number.isInteger(route?.primaryService?.port)) return null;
    return route;
}

function readinessPlan(route, protocol) {
    const generationDigest = crypto.createHash('sha256').update(JSON.stringify(route)).digest('base64url');
    return Object.freeze({
        relay: route.relay,
        owner: Object.freeze({ effectiveInstanceId: route.effectiveInstanceId }),
        deniedPorts: Object.freeze([...(route.deniedPorts || [])]),
        generationDigest,
        limits: compileProxyLimits(),
        method: protocol === 'tcp' ? 'GET' : 'POST',
        port: route.primaryService.port,
        targetPath: protocol === 'tcp' ? '/' : '/mcp',
        query: '',
        transport: 'http',
    });
}

async function probeRelay(route, protocol, timeoutMs) {
    const plan = readinessPlan(route, protocol);
    const minter = new RelayRequestMinter({ resolveAgentSecret: deriveAgentRequestSecret });
    const manager = new RuntimeRelayManager({ minter, limits: plan.limits });
    const lease = { commit: () => true, release() {} };
    const channel = await manager.checkout({ plan, lease, authorized: true });
    let relayAgent;
    try {
        if (protocol === 'tcp') {
            const stream = await channel.openRequest({
                plan,
                bodyMode: 'none-v1',
                bodyHash: sha256RawBodyHash(),
                headers: {},
            });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('readiness connect timeout')), timeoutMs);
                timer.unref?.();
                stream.once('ready', () => { clearTimeout(timer); resolve(); });
                stream.once('error', error => { clearTimeout(timer); reject(error); });
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
                clientInfo: { name: 'ploinky-readiness', version: '1.0.0' },
            },
        }));
        const stream = await channel.openRequest({
            plan,
            bodyMode: 'buffered-v1',
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
                    if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) return resolve(false);
                    try {
                        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        resolve(parsed?.jsonrpc === '2.0' && Boolean(parsed?.result?.protocolVersion));
                    } catch (_) { resolve(false); }
                });
            });
            request.setTimeout(timeoutMs, () => request.destroy());
            request.on('error', () => resolve(false));
            request.end(body);
        });
    } finally {
        relayAgent?.destroy();
        channel.close();
    }
}

export async function waitForAgentReady(agentOrRoute, {
    timeoutMs = 5000,
    intervalMs = 125,
    probeTimeoutMs = 250,
    protocol = 'mcp',
    onProgress = null,
    probe = probeRelay,
} = {}) {
    const route = resolveAgentPrimaryService(agentOrRoute);
    if (!route) return false;
    const normalizedProtocol = String(protocol || 'mcp').trim().toLowerCase();
    if (!['tcp', 'mcp'].includes(normalizedProtocol)) return false;
    const startedAt = Date.now();
    let attempt = 0;
    while (Date.now() - startedAt <= timeoutMs) {
        attempt += 1;
        let ready = false;
        let lastError = '';
        try { ready = await probe(route, normalizedProtocol, Math.max(500, probeTimeoutMs)); } catch (error) {
            lastError = error?.code || error?.message || 'error';
        }
        onProgress?.({
            protocol: normalizedProtocol,
            elapsedMs: Date.now() - startedAt,
            timeoutMs,
            attempt,
            ready,
            stage: ready ? 'ready' : 'waiting_for_relay',
            lastError,
        });
        if (ready) return true;
        await wait(intervalMs);
    }
    return false;
}

export default waitForAgentReady;
