// AgentHttpClient: HTTP/OpenAI-compatible client helper for agents and skills
// to call other agents through RoutingServer.

import http from 'node:http';
import https from 'node:https';

function stripTrailingSlash(value) {
    return String(value || '').replace(/\/+$/, '');
}

export function getRouterUrl(env = process.env) {
    const routerUrl = env.PLOINKY_ROUTER_URL;
    if (routerUrl && typeof routerUrl === 'string' && routerUrl.trim()) {
        return stripTrailingSlash(routerUrl.trim());
    }
    const routerHost = env.PLOINKY_ROUTER_HOST || '127.0.0.1';
    const routerPort = env.PLOINKY_ROUTER_PORT || '8080';
    return `http://${routerHost}:${routerPort}`;
}

function encodeAgentName(agentName) {
    const normalized = String(agentName || '').trim();
    if (!normalized) {
        throw new Error('agentName is required');
    }
    return encodeURIComponent(normalized);
}

export function getAgentCardUrl(agentName, options = {}) {
    const routerUrl = stripTrailingSlash(options.routerUrl || getRouterUrl(options.env || process.env));
    return `${routerUrl}/agent-card/${encodeAgentName(agentName)}`;
}

export function getAgentCardsUrl(options = {}) {
    const routerUrl = stripTrailingSlash(options.routerUrl || getRouterUrl(options.env || process.env));
    return `${routerUrl}/agent-card`;
}

export function getAgentChatCompletionsUrl(agentName, options = {}) {
    const routerUrl = stripTrailingSlash(options.routerUrl || getRouterUrl(options.env || process.env));
    return `${routerUrl}/v1/chat/completions/${encodeAgentName(agentName)}`;
}

function selectHttpModule(url) {
    return url.protocol === 'https:' ? https : http;
}

function normalizeHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (value === undefined || value === null) continue;
        out[key] = value;
    }
    return out;
}

function buildRequestOptions(url, method, headers = {}) {
    return {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search || ''}`,
        method,
        headers
    };
}

function requestBuffer(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 0, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const httpModule = selectHttpModule(url);
        const req = httpModule.request(buildRequestOptions(url, method, headers), (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers || {},
                    body: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.on('error', reject);
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
            });
        }
        if (signal) {
            if (signal.aborted) {
                req.destroy(new Error('Request aborted'));
            } else {
                signal.addEventListener('abort', () => req.destroy(new Error('Request aborted')), { once: true });
            }
        }
        if (body) req.write(body);
        req.end();
    });
}

function requestStream(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 0, signal = null } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const httpModule = selectHttpModule(url);
        const req = httpModule.request(buildRequestOptions(url, method, headers), (res) => {
            resolve({
                statusCode: res.statusCode || 0,
                headers: res.headers || {},
                stream: res,
                request: req
            });
        });
        req.on('error', reject);
        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            req.setTimeout(timeoutMs, () => {
                req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
            });
        }
        if (signal) {
            if (signal.aborted) {
                req.destroy(new Error('Request aborted'));
            } else {
                signal.addEventListener('abort', () => req.destroy(new Error('Request aborted')), { once: true });
            }
        }
        if (body) req.write(body);
        req.end();
    });
}

function parseJsonResponse(response, action) {
    let parsed;
    try {
        parsed = response.body ? JSON.parse(response.body) : {};
    } catch (error) {
        throw new Error(`${action} returned invalid JSON: ${response.body}`);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
        const message = parsed?.error?.message || parsed?.error || response.body || `${action} failed`;
        throw new Error(`${action} failed with HTTP ${response.statusCode}: ${message}`);
    }
    return parsed;
}

async function readErrorBody(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function* iterateSse(stream) {
    let buffer = '';
    for await (const chunk of stream) {
        buffer += chunk.toString('utf8');
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            const separator = buffer[boundary] === '\r' ? 4 : 2;
            buffer = buffer.slice(boundary + separator);
            const dataLines = rawEvent
                .split(/\r?\n/)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart());
            if (!dataLines.length) continue;
            const data = dataLines.join('\n');
            if (data === '[DONE]') {
                yield { done: true, data };
                return;
            }
            let json = null;
            try {
                json = JSON.parse(data);
            } catch (_) {
                json = null;
            }
            yield { done: false, data, json };
        }
    }
    const tail = buffer.trim();
    if (tail) {
        const dataLines = tail
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart());
        if (dataLines.length) {
            const data = dataLines.join('\n');
            if (data === '[DONE]') {
                yield { done: true, data };
            } else {
                let json = null;
                try {
                    json = JSON.parse(data);
                } catch (_) {
                    json = null;
                }
                yield { done: false, data, json };
            }
        }
    }
}

export function createAgentHttpClient(options = {}) {
    const routerUrl = stripTrailingSlash(options.routerUrl || getRouterUrl(options.env || process.env));
    const requestHeaders = normalizeHeaders(options.requestHeaders || {});
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 0;

    function buildJsonHeaders(extraHeaders = {}) {
        return normalizeHeaders({
            ...requestHeaders,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...extraHeaders
        });
    }

    async function agentCard(agentName, callOptions = {}) {
        const hasAgent = typeof agentName === 'string' && agentName.trim();
        const url = hasAgent
            ? getAgentCardUrl(agentName, { routerUrl })
            : getAgentCardsUrl({ routerUrl });
        const response = await requestBuffer(url, {
            method: 'GET',
            headers: normalizeHeaders({
                ...requestHeaders,
                Accept: 'application/json',
                ...(callOptions.headers || {})
            }),
            timeoutMs: callOptions.timeoutMs ?? timeoutMs,
            signal: callOptions.signal || null
        });
        return parseJsonResponse(response, 'agent-card');
    }

    async function chatCompletions(agentName, payload = {}, callOptions = {}) {
        if (payload?.stream === true) {
            throw new Error('chatCompletions does not consume SSE responses; use chatCompletionsStream for stream:true requests.');
        }
        const body = JSON.stringify(payload || {});
        const response = await requestBuffer(getAgentChatCompletionsUrl(agentName, { routerUrl }), {
            method: 'POST',
            headers: buildJsonHeaders({
                'Content-Length': Buffer.byteLength(body),
                ...(callOptions.headers || {})
            }),
            body,
            timeoutMs: callOptions.timeoutMs ?? timeoutMs,
            signal: callOptions.signal || null
        });
        return parseJsonResponse(response, 'chatCompletions');
    }

    async function* chatCompletionsStream(agentName, payload = {}, callOptions = {}) {
        const streamPayload = { ...(payload || {}), stream: true };
        const body = JSON.stringify(streamPayload);
        const response = await requestStream(getAgentChatCompletionsUrl(agentName, { routerUrl }), {
            method: 'POST',
            headers: buildJsonHeaders({
                Accept: 'text/event-stream',
                'Content-Length': Buffer.byteLength(body),
                ...(callOptions.headers || {})
            }),
            body,
            timeoutMs: callOptions.timeoutMs ?? timeoutMs,
            signal: callOptions.signal || null
        });
        if (response.statusCode < 200 || response.statusCode >= 300) {
            const errorBody = await readErrorBody(response.stream);
            throw new Error(`chatCompletionsStream failed with HTTP ${response.statusCode}: ${errorBody}`);
        }
        yield* iterateSse(response.stream);
    }

    return {
        routerUrl,
        agentCard,
        chatCompletions,
        chatCompletionsStream
    };
}
