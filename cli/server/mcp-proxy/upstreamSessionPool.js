// Upstream MCP session pool (Router -> agent).
//
// One upstream MCP session per exact agent instance, reused across callers. A
// session id is not a credential: every tools/call and resources/read carries
// its own freshly minted Router Request token, supplied per attempt by the
// caller, so entries and snapshots never hold tokens. The caller is not part of
// the key because the agent derives identity only from the token verified on
// each HTTP request.
//
// Fail-closed rules:
// - `beforeDial()` runs synchronously immediately before every POST; anything
//   other than `true` raises EDGE_GENERATION_CHANGED and nothing is sent.
// - At most one retry, and only for failures that happened before the agent
//   dispatched the request (HTTP 400 "Missing session", HTTP 404, or
//   ECONNREFUSED before any response byte). Before retrying, the entry is
//   evicted, readiness is re-run and a new session is opened; the caller's
//   header factory mints a new token for the new attempt.
// - Any transport or session error evicts the entry and clears its readiness.
// - A response that is not the JSON-RPC answer for the sent id (non-JSON
//   content, malformed body or a different id) is a pool mismatch: the entry is
//   evicted and the key is served through the caller's per-call SDK path.

import http from 'node:http';

export const UPSTREAM_POOL_ERROR_CODES = Object.freeze({
    EDGE_GENERATION_CHANGED: 'EDGE_GENERATION_CHANGED',
    UPSTREAM_SESSION_LOST: 'UPSTREAM_SESSION_LOST',
    UPSTREAM_TRANSPORT: 'UPSTREAM_TRANSPORT',
});

const { EDGE_GENERATION_CHANGED, UPSTREAM_SESSION_LOST, UPSTREAM_TRANSPORT } = UPSTREAM_POOL_ERROR_CODES;
const POOL_ERROR_CODE_SET = new Set(Object.values(UPSTREAM_POOL_ERROR_CODES));

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const ACCEPT_HEADER = 'application/json, text/event-stream';
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_READY_TTL_MS = 10_000;
// Below Node's default 5 s server keepAliveTimeout, which AgentServer keeps.
const FREE_SOCKET_IDLE_MS = 2_000;
// The pool, not http.Agent, bounds concurrency: at most 8 requests in flight
// per entry. The agent itself is uncapped so a granted request is bound to a
// socket synchronously inside http.request, right after its generation check.
const MAX_INFLIGHT_PER_ENTRY = 8;
const MAX_FREE_SOCKETS_PER_ENTRY = 8;
const DELETE_TIMEOUT_MS = 1_000;

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Same environment knobs and defaults as AgentClient.js.
const DEFAULT_TOOL_CALL_TIMEOUT_MS = parsePositiveInt(process.env.PLOINKY_MCP_TOOL_CALL_TIMEOUT_MS, 600000);
const DEFAULT_REQUEST_TIMEOUT_MS = parsePositiveInt(process.env.PLOINKY_MCP_REQUEST_TIMEOUT_MS, 5000);

export function upstreamTimeoutForMethod(method) {
    return method === 'tools/call' ? DEFAULT_TOOL_CALL_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Kill switch: PLOINKY_MCP_UPSTREAM_POOL=0 restores the per-call client path. */
export function isUpstreamPoolEnabled(env = process.env) {
    const flag = String(env?.PLOINKY_MCP_UPSTREAM_POOL ?? '').trim().toLowerCase();
    return !(flag === '0' || flag === 'false' || flag === 'off');
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Pool key for an active agent-root route plan:
 * (routeKey, lease.id, hostPort, containerId, instanceId, enableGeneration).
 * Any missing part returns null, which keeps the existing per-call path.
 */
export function poolKeyForRoutePlan(routePlan) {
    if (!routePlan || typeof routePlan !== 'object') return null;
    const routeKey = text(routePlan.routeKey);
    const leaseId = text(routePlan.lease?.id);
    const hostPort = Number(routePlan.target?.hostPort);
    const container = text(routePlan.route?.container);
    const record = container ? routePlan.snapshot?.agents?.[container] : null;
    const containerId = text(record?.containerId);
    const instanceId = text(record?.instanceId);
    const enableGeneration = text(record?.enableGeneration);
    if (!routeKey || !leaseId || !container || !containerId || !instanceId || !enableGeneration) return null;
    if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535) return null;
    // The proxy dials route.hostPort; refuse a plan whose route disagrees.
    if (routePlan.route?.hostPort !== undefined && Number(routePlan.route.hostPort) !== hostPort) return null;
    return JSON.stringify([routeKey, leaseId, hostPort, containerId, instanceId, enableGeneration]);
}

function slotForKey(key) {
    try {
        const parsed = JSON.parse(key);
        if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0]) return parsed[0];
    } catch (_) { }
    return key;
}

function poolError(code, message, extra = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, extra);
    return error;
}

function generationChanged() {
    return poolError(EDGE_GENERATION_CHANGED, 'edge routing generation changed before upstream connection');
}

function isJsonContentType(headers) {
    const value = String(headers?.['content-type'] || '').toLowerCase();
    return /^application\/json\s*(;|$)/.test(value);
}

function readSessionIdHeader(headers) {
    const value = headers?.['mcp-session-id'];
    const sessionId = Array.isArray(value) ? value[0] : value;
    return typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : '';
}

function isSessionLostResponse(response) {
    if (response.statusCode === 404) return true;
    return response.statusCode === 400 && /missing session/i.test(response.body || '');
}

/**
 * Classify an upstream response to a JSON-RPC request with id `id`.
 * Returns the JSON-RPC message ({ result } or { error }) or throws a pool error.
 */
function interpretRpcResponse(response, id, { dispatched }) {
    if (isSessionLostResponse(response)) {
        throw poolError(UPSTREAM_SESSION_LOST, `upstream MCP session lost (HTTP ${response.statusCode})`, {
            retryable: true,
            status: response.statusCode,
        });
    }
    const success = response.statusCode >= 200 && response.statusCode < 300;
    if (!success) {
        throw poolError(UPSTREAM_TRANSPORT,
            `Error POSTing to endpoint (HTTP ${response.statusCode}): ${String(response.body || '').slice(0, 512)}`,
            { status: response.statusCode });
    }
    const mismatch = (reason) => poolError(UPSTREAM_TRANSPORT, `upstream MCP response is not poolable: ${reason}`, {
        poolMismatch: true,
        dispatched,
        status: response.statusCode,
    });
    if (!isJsonContentType(response.headers)) {
        throw mismatch(`content-type '${String(response.headers?.['content-type'] || '')}'`);
    }
    let message;
    try {
        message = JSON.parse(response.body || '');
    } catch (_) {
        throw mismatch('body is not JSON');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || message.jsonrpc !== '2.0' || message.id !== id) {
        throw mismatch('body is not the JSON-RPC response for the sent id');
    }
    if (message.error && typeof message.error === 'object') {
        return { error: message.error };
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'result')) {
        throw mismatch('JSON-RPC response has neither result nor error');
    }
    return { result: message.result };
}

export function createUpstreamSessionPool({
    idleMs = DEFAULT_IDLE_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    readyTtlMs = DEFAULT_READY_TTL_MS,
    httpImpl = http,
    now = Date.now,
} = {}) {
    const entries = new Map(); // key -> entry, in LRU order (oldest first)
    const slots = new Map(); // routeKey -> current key
    const readyUntil = new Map(); // key -> timestamp
    const fallbackKeys = new Map(); // key -> timestamp; served through the SDK path
    const pendingCloses = new Set();
    const counters = {
        sessionsOpened: 0,
        requests: 0,
        retries: 0,
        evictions: 0,
        deletes: 0,
        fallbacks: 0,
    };
    let sweepTimer = null;
    let closed = false;
    let closePromise = null;

    function assertOpen() {
        if (closed) {
            throw poolError(UPSTREAM_SESSION_LOST, 'upstream MCP session closed before dispatch', { retryable: false });
        }
    }

    function createAgent() {
        const agent = new httpImpl.Agent({
            keepAlive: true,
            maxSockets: Infinity,
            maxFreeSockets: MAX_FREE_SOCKETS_PER_ENTRY,
        });
        const keepSocketAlive = typeof agent.keepSocketAlive === 'function'
            ? agent.keepSocketAlive.bind(agent)
            : null;
        // Free sockets idle out after 2 s so a pooled socket is never reused after
        // the agent's keep-alive timeout could have closed it.
        agent.keepSocketAlive = (socket) => {
            const keep = keepSocketAlive ? keepSocketAlive(socket) : true;
            if (!keep) return false;
            const current = Number(socket.timeout) || 0;
            if (current === 0 || current > FREE_SOCKET_IDLE_MS) socket.setTimeout(FREE_SOCKET_IDLE_MS);
            return true;
        };
        return agent;
    }

    function createEntry(key, hostPort) {
        return {
            key,
            slot: slotForKey(key),
            hostPort,
            sessionId: '',
            protocolVersion: DEFAULT_PROTOCOL_VERSION,
            nextId: 1,
            inflight: 0,
            active: 0,
            waiters: [],
            lastUsedAt: now(),
            agent: createAgent(),
            opening: null,
            closed: false,
            retirement: null,
            finishRetirement: null,
            cleanupStarted: false,
        };
    }

    function sendDelete(hostPort, sessionId, protocolVersion) {
        counters.deletes += 1;
        return new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const done = (ok) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                resolve(ok);
            };
            let request;
            try {
                request = httpImpl.request({
                    host: '127.0.0.1',
                    port: hostPort,
                    method: 'DELETE',
                    path: '/mcp',
                    headers: {
                        accept: ACCEPT_HEADER,
                        'mcp-session-id': sessionId,
                        'mcp-protocol-version': protocolVersion,
                    },
                    agent: false,
                });
            } catch (_) {
                done(false);
                return;
            }
            timer = setTimeout(() => {
                request.destroy();
                done(false);
            }, DELETE_TIMEOUT_MS);
            timer.unref?.();
            request.on('response', (response) => {
                response.on('error', () => done(false));
                response.on('end', () => done(response.statusCode >= 200 && response.statusCode < 300));
                response.resume();
            });
            request.on('error', () => done(false));
            request.end();
        });
    }

    function finishClose(entry) {
        if (!entry.closed || entry.opening || entry.inflight > 0 || entry.cleanupStarted) return;
        entry.cleanupStarted = true;
        const sessionId = entry.sessionId;
        entry.sessionId = '';
        const done = () => {
            try { entry.agent.destroy(); } catch (_) { }
            pendingCloses.delete(entry.retirement);
            entry.finishRetirement();
        };
        (sessionId
            ? sendDelete(entry.hostPort, sessionId, entry.protocolVersion)
            : Promise.resolve(false))
            .then(done, done);
    }

    function forgetKey(key) {
        readyUntil.delete(key);
    }

    function evict(entry, { retryWaiters = true } = {}) {
        forgetKey(entry.key);
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        if (entry.closed) return;
        entry.closed = true;
        // Register ownership now, including opening and busy entries removed
        // from the pool before shutdown begins.
        entry.retirement = new Promise((resolve) => { entry.finishRetirement = resolve; });
        pendingCloses.add(entry.retirement);
        counters.evictions += 1;
        rejectWaiters(entry, retryWaiters);
        finishClose(entry);
    }

    // Raised when a request's deadline passes before it is dispatched; nothing
    // was checked, minted or sent for it.
    function deadlineExpired() {
        return poolError(UPSTREAM_TRANSPORT, 'MCP error -32001: Request timed out', {
            timedOut: true,
            queued: true,
        });
    }

    // Requests beyond MAX_INFLIGHT_PER_ENTRY wait here, before their generation
    // check and mint; the wait is bounded by the request's own deadline and a
    // timed-out or rejected waiter has sent nothing.
    function takeSlot(entry, deadline) {
        if (entry.active < MAX_INFLIGHT_PER_ENTRY && entry.waiters.length === 0) {
            entry.active += 1;
            return null;
        }
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null, done: false };
            waiter.timer = setTimeout(() => {
                if (waiter.done) return;
                waiter.done = true;
                const index = entry.waiters.indexOf(waiter);
                if (index >= 0) entry.waiters.splice(index, 1);
                reject(deadlineExpired());
            }, Math.max(0, deadline - Date.now()));
            waiter.timer.unref?.();
            entry.waiters.push(waiter);
        });
    }

    function releaseSlot(entry) {
        entry.active = Math.max(0, entry.active - 1);
        while (entry.waiters.length > 0 && entry.active < MAX_INFLIGHT_PER_ENTRY) {
            const waiter = entry.waiters.shift();
            if (waiter.done) continue;
            waiter.done = true;
            clearTimeout(waiter.timer);
            entry.active += 1;
            waiter.resolve();
        }
    }

    function rejectWaiters(entry, retryable) {
        for (const waiter of entry.waiters.splice(0)) {
            if (waiter.done) continue;
            waiter.done = true;
            clearTimeout(waiter.timer);
            waiter.reject(poolError(UPSTREAM_SESSION_LOST, 'upstream MCP session closed before dispatch', {
                retryable,
            }));
        }
    }

    function release(entry) {
        entry.inflight = Math.max(0, entry.inflight - 1);
        entry.lastUsedAt = now();
        finishClose(entry);
    }

    function stopSweepIfIdle() {
        if (sweepTimer && entries.size === 0) {
            clearInterval(sweepTimer);
            sweepTimer = null;
        }
    }

    function sweepIdle() {
        const current = now();
        for (const entry of [...entries.values()]) {
            if (entry.inflight === 0 && !entry.opening && current - entry.lastUsedAt > idleMs) {
                evict(entry);
            }
        }
        stopSweepIfIdle();
    }

    function ensureSweepTimer() {
        if (sweepTimer || entries.size === 0) return;
        sweepTimer = setInterval(sweepIdle, Math.max(1_000, Math.floor(idleMs / 2)));
        sweepTimer.unref?.();
    }

    function markFallback(key) {
        if (closed) return;
        if (!fallbackKeys.has(key)) counters.fallbacks += 1;
        fallbackKeys.delete(key);
        fallbackKeys.set(key, now());
        while (fallbackKeys.size > maxEntries) {
            fallbackKeys.delete(fallbackKeys.keys().next().value);
        }
    }

    // A new key for the same route slot (new lease, port, container or
    // instance) evicts the previous key's entry and readiness.
    function claimSlot(key) {
        const slot = slotForKey(key);
        const previous = slots.get(slot);
        if (previous && previous !== key) {
            const stale = entries.get(previous);
            if (stale) evict(stale);
            forgetKey(previous);
            fallbackKeys.delete(previous);
        }
        slots.delete(slot);
        slots.set(slot, key);
        while (slots.size > maxEntries) {
            slots.delete(slots.keys().next().value);
        }
    }

    function post(entry, body, { sessionId = '', authorization = '', timeoutMs }) {
        assertOpen();
        return new Promise((resolve, reject) => {
            const payload = Buffer.from(JSON.stringify(body), 'utf8');
            const headers = {
                'content-type': 'application/json',
                accept: ACCEPT_HEADER,
                'content-length': String(payload.length),
            };
            if (authorization) headers.authorization = authorization;
            if (sessionId) {
                headers['mcp-session-id'] = sessionId;
                headers['mcp-protocol-version'] = entry.protocolVersion;
            }
            let responded = false;
            let settled = false;
            let timer = null;
            const settle = (fn, value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                fn(value);
            };
            const request = httpImpl.request({
                host: '127.0.0.1',
                port: entry.hostPort,
                method: 'POST',
                path: '/mcp',
                headers,
                agent: entry.agent,
                timeout: timeoutMs,
            });
            const fail = (error) => {
                if (error?.code === 'ECONNREFUSED' && !responded) {
                    settle(reject, poolError(UPSTREAM_SESSION_LOST, 'upstream agent refused the connection', {
                        retryable: true,
                        cause: error,
                    }));
                    return;
                }
                settle(reject, error?.code === UPSTREAM_TRANSPORT
                    ? error
                    : poolError(UPSTREAM_TRANSPORT, error?.message || 'upstream transport error', { cause: error }));
            };
            const timedOut = () => {
                const error = poolError(UPSTREAM_TRANSPORT, 'MCP error -32001: Request timed out', { timedOut: true });
                settle(reject, error);
                request.destroy(error);
            };
            timer = setTimeout(timedOut, timeoutMs);
            timer.unref?.();
            request.on('timeout', timedOut);
            request.on('response', (response) => {
                responded = true;
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('error', fail);
                response.on('aborted', () => fail(new Error('upstream response aborted')));
                response.on('end', () => settle(resolve, {
                    statusCode: response.statusCode || 0,
                    headers: response.headers || {},
                    body: Buffer.concat(chunks).toString('utf8'),
                }));
            });
            request.on('error', fail);
            request.end(payload);
        });
    }

    async function openSession(entry, beforeDial, timeoutMs) {
        assertOpen();
        if (beforeDial() !== true) throw generationChanged();
        const initializeId = entry.nextId++;
        const initialized = await post(entry, {
            jsonrpc: '2.0',
            id: initializeId,
            method: 'initialize',
            params: {
                protocolVersion: DEFAULT_PROTOCOL_VERSION,
                capabilities: {},
                clientInfo: { name: 'ploinky-router', version: '1.0.0' },
            },
        }, { timeoutMs });
        const sessionId = readSessionIdHeader(initialized.headers);
        if (sessionId) entry.sessionId = sessionId;
        assertOpen();
        const message = interpretRpcResponse(initialized, initializeId, { dispatched: false });
        if (message.error) {
            throw poolError(UPSTREAM_TRANSPORT,
                `MCP error ${message.error.code}: ${message.error.message || 'initialize failed'}`);
        }
        if (!sessionId) {
            throw poolError(UPSTREAM_TRANSPORT, 'upstream MCP response is not poolable: no session id', {
                poolMismatch: true,
                dispatched: false,
            });
        }
        const negotiated = text(message.result?.protocolVersion);
        if (negotiated) entry.protocolVersion = negotiated;
        if (beforeDial() !== true) throw generationChanged();
        const ack = await post(entry, { jsonrpc: '2.0', method: 'notifications/initialized' }, {
            sessionId,
            timeoutMs,
        });
        assertOpen();
        if (isSessionLostResponse(ack)) {
            throw poolError(UPSTREAM_SESSION_LOST, `upstream MCP session lost (HTTP ${ack.statusCode})`, {
                retryable: true,
                status: ack.statusCode,
            });
        }
        if (ack.statusCode < 200 || ack.statusCode >= 300) {
            throw poolError(UPSTREAM_TRANSPORT, `Error POSTing to endpoint (HTTP ${ack.statusCode})`, {
                status: ack.statusCode,
            });
        }
        counters.sessionsOpened += 1;
    }

    function handleFailure(entry, error) {
        // Errors raised by the caller (for example a failed mint) are not
        // upstream failures and leave the session alone.
        if (!POOL_ERROR_CODE_SET.has(error?.code)) return;
        if (error?.queued) {
            // Saturated, not broken: nothing was sent. Drop readiness only.
            forgetKey(entry.key);
            return;
        }
        if (error?.code === EDGE_GENERATION_CHANGED) {
            // The key's lease is no longer active: drop its readiness and its
            // session (DELETE after any call in flight finishes).
            evict(entry);
            return;
        }
        evict(entry);
        if (error?.poolMismatch) markFallback(entry.key);
    }

    async function acquire(key, hostPort, beforeDial, timeoutMs) {
        for (let round = 0; round < 3; round += 1) {
            assertOpen();
            let entry = entries.get(key);
            if (entry && entry.inflight === 0 && !entry.opening && now() - entry.lastUsedAt > idleMs) {
                evict(entry);
                entry = null;
            }
            if (!entry) {
                entry = createEntry(key, hostPort);
                entries.set(key, entry);
                while (entries.size > maxEntries) {
                    evict(entries.values().next().value);
                }
                ensureSweepTimer();
            } else {
                entries.delete(key);
                entries.set(key, entry);
            }
            if (!entry.sessionId || entry.opening) {
                if (!entry.opening) {
                    const target = entry;
                    target.opening = openSession(target, beforeDial, timeoutMs)
                        .catch((error) => {
                            handleFailure(target, error);
                            throw error;
                        })
                        .finally(() => {
                            target.opening = null;
                            finishClose(target);
                        });
                }
                await entry.opening;
            }
            assertOpen();
            if (!entry.closed && entry.sessionId) return entry;
        }
        throw poolError(UPSTREAM_SESSION_LOST, 'upstream MCP session could not be established', { retryable: false });
    }

    async function attempt({ key, hostPort, method, params, headers, beforeDial, timeoutMs }) {
        const deadline = Date.now() + timeoutMs;
        const entry = await acquire(key, hostPort, beforeDial, Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS));
        assertOpen();
        entry.inflight += 1;
        let holdsSlot = false;
        try {
            const waiting = takeSlot(entry, deadline);
            if (waiting) await waiting;
            holdsSlot = true;
            assertOpen();
            // A slow session open, or a slot granted late (for example after an
            // event-loop stall), can use up the deadline: fail before the
            // generation check, the mint and the POST.
            if (Date.now() >= deadline) throw deadlineExpired();
            if (entry.closed || !entry.sessionId) {
                throw poolError(UPSTREAM_SESSION_LOST, 'upstream MCP session closed before dispatch', { retryable: true });
            }
            // From here to http.request everything is synchronous: generation
            // check, per-attempt mint, timer start and socket binding.
            if (beforeDial() !== true) throw generationChanged();
            assertOpen();
            const supplied = typeof headers === 'function' ? headers() : headers;
            const authorization = typeof supplied?.authorization === 'string' ? supplied.authorization : '';
            const id = entry.nextId++;
            counters.requests += 1;
            const response = await post(entry, { jsonrpc: '2.0', id, method, params: params ?? {} }, {
                sessionId: entry.sessionId,
                authorization,
                timeoutMs: Math.max(1, deadline - Date.now()),
            });
            const message = interpretRpcResponse(response, id, { dispatched: true });
            entry.lastUsedAt = now();
            if (!entry.closed) readyUntil.set(key, now() + readyTtlMs);
            return message;
        } catch (error) {
            handleFailure(entry, error);
            throw error;
        } finally {
            if (holdsSlot) releaseSlot(entry);
            release(entry);
        }
    }

    /**
     * Send one JSON-RPC request on the pooled session for `key`.
     * `headers` is an object or a function called once per attempt; only its
     * `authorization` value is forwarded. `ensureReady` is awaited before the
     * single permitted retry and must resolve `true`.
     * Resolves `{ result }` or `{ error }` (the upstream JSON-RPC answer).
     */
    async function request({
        key,
        hostPort,
        method,
        params = {},
        headers = null,
        beforeDial,
        timeoutMs,
        ensureReady = null,
    } = {}) {
        assertOpen();
        if (typeof key !== 'string' || !key) throw new TypeError('upstream pool request requires a key');
        if (typeof beforeDial !== 'function') throw new TypeError('upstream pool request requires beforeDial');
        const port = Number(hostPort);
        if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
            throw new TypeError('upstream pool request requires a valid hostPort');
        }
        const effectiveTimeoutMs = parsePositiveInt(timeoutMs, upstreamTimeoutForMethod(method));
        claimSlot(key);
        for (let attemptIndex = 0; ; attemptIndex += 1) {
            assertOpen();
            try {
                return await attempt({
                    key,
                    hostPort: port,
                    method,
                    params,
                    headers,
                    beforeDial,
                    timeoutMs: effectiveTimeoutMs,
                });
            } catch (error) {
                assertOpen();
                if (!error?.retryable || attemptIndex >= 1) throw error;
                counters.retries += 1;
                if (typeof ensureReady === 'function') {
                    let ready = false;
                    try {
                        ready = (await ensureReady()) === true;
                    } catch (_) {
                        ready = false;
                    }
                    assertOpen();
                    if (!ready) {
                        throw poolError(UPSTREAM_SESSION_LOST, 'upstream agent is not ready', {
                            notReady: true,
                            cause: error,
                        });
                    }
                }
            }
        }
    }

    function isReady(key) {
        if (typeof key !== 'string' || !key) return false;
        const until = readyUntil.get(key);
        const entry = entries.get(key);
        return Boolean(until !== undefined && now() < until && entry && !entry.closed && entry.sessionId);
    }

    function usesFallback(key) {
        return typeof key === 'string' && fallbackKeys.has(key);
    }

    function invalidate(key, _reason = '') {
        if (typeof key !== 'string' || !key) return;
        const entry = entries.get(key);
        if (entry) evict(entry);
        forgetKey(key);
        fallbackKeys.delete(key);
    }

    function closeAll() {
        if (closePromise) return closePromise;
        closed = true;
        let finishShutdown;
        closePromise = new Promise((resolve) => { finishShutdown = resolve; });
        if (sweepTimer) {
            clearInterval(sweepTimer);
            sweepTimer = null;
        }
        // Idle entries are DELETEd now. Entries with calls in flight are DELETEd
        // after their last call finishes, so a running tool's reply is never cut
        // off by the shutdown; queued requests that sent nothing are rejected.
        for (const entry of [...entries.values()]) {
            evict(entry, { retryWaiters: false });
        }
        entries.clear();
        slots.clear();
        readyUntil.clear();
        fallbackKeys.clear();
        Promise.allSettled([...pendingCloses]).then(() => finishShutdown());
        return closePromise;
    }

    function snapshot() {
        const current = now();
        return {
            entries: [...entries.values()].map((entry) => ({
                key: entry.key,
                sessionId: entry.sessionId,
                protocolVersion: entry.protocolVersion,
                nextId: entry.nextId,
                inflight: entry.inflight,
                idleMs: Math.max(0, current - entry.lastUsedAt),
                ready: isReady(entry.key),
            })),
            fallbackKeys: [...fallbackKeys.keys()],
            counters: { ...counters },
        };
    }

    return { request, invalidate, closeAll, snapshot, isReady, usesFallback };
}

export default {
    createUpstreamSessionPool,
    isUpstreamPoolEnabled,
    poolKeyForRoutePlan,
    upstreamTimeoutForMethod,
    UPSTREAM_POOL_ERROR_CODES,
};
