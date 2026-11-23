import http from 'node:http';

const SAFE_CALLER_METADATA_HEADERS = new Set(['accept-language', 'user-agent']);

export function sanitizeAgentCardFanoutHeaders(headers = {}) {
    const sanitized = {};
    for (const [name, value] of Object.entries(headers || {})) {
        const normalized = String(name || '').toLowerCase();
        if (SAFE_CALLER_METADATA_HEADERS.has(normalized)) sanitized[normalized] = value;
    }
    return sanitized;
}

export function requestAgentCard(route, agentName, callerHeaders = {}, { beforeDial = null, selection } = {}) {
    return new Promise((resolve) => {
        if (typeof beforeDial === 'function') {
            try {
                if (beforeDial() !== true || !assertSelectionCurrent(selection)) {
                    resolve({
                        ok: false,
                        generationChanged: true,
                        error: { name: agentName, error: 'edge_generation_changed' },
                    });
                    return;
                }
            } catch (_) {
                resolve({
                    ok: false,
                    generationChanged: true,
                    error: { name: agentName, error: 'edge_generation_changed' },
                });
                return;
            }
        }
        const start = performance.now();
        const plan = selection || { routeKey: agentName };
        let received = false;
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
        }, upstreamRes => {
            received = true;
            observeProxyOutcome({ plan, outcome: 'success', upstreamStatus: upstreamRes.statusCode,
                ttfbMs: performance.now() - start });
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
            if (!received) observeProxyOutcome({ plan, outcome: 'failure', unreachable: true });
            resolve({ ok: false, error: { name: agentName, error: err?.message || String(err) } });
        });
        upstream.end();
    });
}

export default requestAgentCard;

import { observeProxyOutcome } from './canary/proxyOutcomes.js';
import { assertSelectionCurrent } from './canary/selection.mjs';

import { routeAdmitted } from './canary/routeAdmission.mjs';
import { selectRouteRuntime } from './canary/selection.mjs';

export function selectAgentCardCandidates(plan, req) {
    const snapshot = plan?.lease?.snapshot;
    const candidates = [];
    for (const [agentName, route] of Object.entries(snapshot?.routing?.routes || {})) {
        if (!routeAdmitted(route, agentName, snapshot)) continue;
        const selection = selectRouteRuntime({ routeKey: agentName, route, snapshot, req });
        if (selection.route.hostPort) candidates.push({ agentName, selection });
    }
    return candidates;
}
