import http from 'node:http';

import { sha256RawBodyHash } from '../../../Agent/lib/requestHash.mjs';
import { getRoutingRuntime } from '../generation/runtimeContext.js';
import { finalizePlanAfterAdmission } from './RoutePlan.js';
import { createRelayHttpAgent, RelayDuplex } from './executeHttpPlan.js';
import { measureHeaderBytes } from './sanitizeRequestHeaders.js';

function splitTarget(target) {
    const value = String(target || '/');
    const index = value.indexOf('?');
    const targetPath = index < 0 ? value : value.slice(0, index);
    const query = index < 0 ? '' : value.slice(index + 1);
    if (!targetPath.startsWith('/')) throw new Error('relayHttpCall: absolute target path required');
    return { targetPath, query };
}

function normalizedHeaders(headers, body) {
    const result = {};
    for (const [name, value] of Object.entries(headers || {})) {
        const lower = String(name).toLowerCase();
        if (lower === 'host' || lower === 'connection' || lower === 'transfer-encoding' || lower === 'content-length') continue;
        result[lower] = value;
    }
    if (body !== null) result['content-length'] = String(body.length);
    return result;
}

export async function relayHttpCall({
    routeKey,
    method = 'GET',
    target = '/',
    headers = {},
    body = null,
    timeoutMs,
    runtime = getRoutingRuntime(),
} = {}) {
    const requestBody = body === null || body === undefined ? null : Buffer.from(body);
    const { targetPath, query } = splitTarget(target);
    const authority = runtime.publicAuthority;
    const lease = runtime.acquire({ listenerClass: 'public', authority });
    let channel;
    let relayAgent;
    try {
        const preAdmissionPlan = runtime.resolvePrimary({
            lease,
            routeKey,
            method: String(method || 'GET').toUpperCase(),
            externalPath: `/${encodeURIComponent(routeKey)}${targetPath}`,
            targetPath,
            query,
            authority,
            listenerClass: 'public',
            scheme: 'http',
            transport: 'http',
        });
        if (!preAdmissionPlan) throw new Error(`relayHttpCall: route '${routeKey}' has no active primary service`);
        const plan = finalizePlanAfterAdmission(preAdmissionPlan);
        if (requestBody && requestBody.length > plan.limits.bufferedBodyBytes) {
            throw new Error('relayHttpCall: request body limit exceeded');
        }
        const applicationHeaders = normalizedHeaders(headers, requestBody);
        applicationHeaders.host = `127.0.0.1:${plan.port}`;
        if (measureHeaderBytes(applicationHeaders) > plan.limits.requestHeaderBytes) {
            throw new Error('relayHttpCall: request header limit exceeded');
        }
        const bodyMode = requestBody?.length ? 'buffered-v1' : 'none-v1';
        const bodyHash = sha256RawBodyHash(requestBody || Buffer.alloc(0));
        channel = await runtime.relayManager.checkout({ plan, lease, authorized: true });
        const stream = await channel.openRequest({ plan, bodyMode, bodyHash, headers: applicationHeaders });
        const connection = new RelayDuplex(stream);
        relayAgent = createRelayHttpAgent(connection);
        return await new Promise((resolve, reject) => {
            const upstream = http.request({
                method: plan.method,
                path: `${plan.targetPath}${plan.query ? `?${plan.query}` : ''}`,
                headers: applicationHeaders,
                maxHeaderSize: plan.limits.responseHeaderBytes,
                agent: relayAgent,
            }, response => {
                clearTimeout(headerTimer);
                const chunks = [];
                let total = 0;
                response.on('data', chunk => {
                    total += chunk.length;
                    if (total > plan.limits.bufferedBodyBytes) {
                        upstream.destroy(new Error('relayHttpCall: response body limit exceeded'));
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                });
                response.once('end', () => resolve({
                    statusCode: response.statusCode || 502,
                    headers: { ...response.headers },
                    body: Buffer.concat(chunks),
                }));
                response.once('error', reject);
                response.setTimeout(plan.limits.idleTimeoutMs, () => {
                    upstream.destroy(new Error('relayHttpCall: upstream idle timeout'));
                });
            });
            const headerTimer = setTimeout(() => {
                upstream.destroy(new Error('relayHttpCall: upstream response header timeout'));
            }, timeoutMs || plan.limits.headerTimeoutMs);
            headerTimer.unref?.();
            upstream.once('error', error => {
                clearTimeout(headerTimer);
                reject(error);
            });
            upstream.end(requestBody || undefined);
        });
    } finally {
        relayAgent?.destroy();
        channel?.close();
        lease.release();
    }
}

export default relayHttpCall;
