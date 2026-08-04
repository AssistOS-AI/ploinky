import http from 'node:http';
import {
    createLeaseCommittedAgent,
    createRootAgentDialContext,
} from './rootAgentDial.js';

const SAFE_CALLER_METADATA_HEADERS = new Set(['accept-language', 'user-agent']);

export function sanitizeAgentCardFanoutHeaders(headers = {}) {
    const sanitized = {};
    for (const [name, value] of Object.entries(headers || {})) {
        const normalized = String(name || '').toLowerCase();
        if (SAFE_CALLER_METADATA_HEADERS.has(normalized)) sanitized[normalized] = value;
    }
    return sanitized;
}

export function requestAgentCard(route, agentName, callerHeaders = {}, {
    dialContext = null,
    routePlan = null,
} = {}) {
    return new Promise((resolve) => {
        let capturedDialContext = dialContext;
        try {
            capturedDialContext ||= createRootAgentDialContext({
                routePlan,
                routeKey: agentName,
                route,
                targetPort: route?.hostPort,
            });
        } catch (_) {
            resolve({
                ok: false,
                generationChanged: true,
                error: { name: agentName, error: 'edge_generation_changed' },
            });
            return;
        }
        const agent = createLeaseCommittedAgent(capturedDialContext);
        if (!agent) {
            resolve({
                ok: false,
                generationChanged: true,
                error: { name: agentName, error: 'edge_generation_changed' },
            });
            return;
        }
        const upstream = http.request({
            hostname: '127.0.0.1',
            port: route.hostPort,
            path: '/agent-card',
            method: 'GET',
            headers: {
                ...sanitizeAgentCardFanoutHeaders(callerHeaders),
                accept: 'application/json',
            },
            timeout: 5000,
            agent,
        }, upstreamRes => {
            const chunks = [];
            upstreamRes.on('data', chunk => chunks.push(chunk));
            upstreamRes.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                const statusCode = upstreamRes.statusCode || 0;
                if (statusCode < 200 || statusCode >= 300) {
                    resolve({ ok: false, error: { name: agentName, statusCode, error: body || `HTTP ${statusCode}` } });
                    return;
                }
                try {
                    resolve({ ok: true, agent: { name: agentName, statusCode, payload: body ? JSON.parse(body) : null } });
                } catch (_) {
                    resolve({ ok: true, agent: { name: agentName, statusCode, body } });
                }
            });
        });
        upstream.on('timeout', () => upstream.destroy(new Error('agent-card request timed out')));
        upstream.on('error', err => {
            agent.destroy();
            if (err?.code === 'EDGE_GENERATION_CHANGED') {
                resolve({
                    ok: false,
                    generationChanged: true,
                    error: { name: agentName, error: 'edge_generation_changed' },
                });
                return;
            }
            resolve({
                ok: false,
                error: { name: agentName, error: err?.message || String(err) },
            });
        });
        upstream.once('close', () => agent.destroy());
        upstream.end();
    });
}

export default requestAgentCard;
