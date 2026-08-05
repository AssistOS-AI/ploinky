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

export function requestAgentCard(route, agentName, callerHeaders = {}, { beforeDial = null } = {}) {
    return new Promise((resolve) => {
        if (typeof beforeDial === 'function') {
            try {
                if (beforeDial() !== true) {
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
        upstream.on('error', err => resolve({
            ok: false,
            error: { name: agentName, error: err?.message || String(err) },
        }));
        upstream.end();
    });
}

export default requestAgentCard;
