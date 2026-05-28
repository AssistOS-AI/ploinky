// AgentClient: minimal MCP client wrapper used by RoutingServer.
// Not a class; exposes factory returning concrete methods for MCP interactions.

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const JSONRPC_VERSION = '2.0';
const DEFAULT_TASK_POLL_INTERVAL_MS = 5000;
const TASK_POLL_INTERVAL_MS = (() => {
    try {
        if (typeof process !== 'undefined' && process.env) {
            const raw = process.env.PLOINKY_MCP_TASK_POLL_INTERVAL_MS;
            const parsed = Number.parseInt(raw, 10);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }
    } catch {
        // ignore env parsing errors
    }
    return DEFAULT_TASK_POLL_INTERVAL_MS;
})();


const RECOVERABLE_ERROR_PATTERNS = [
    'Missing or invalid MCP session',
    'Request timed out',
    'fetch failed',
    ' is still starting.',
    'Try again in a moment'
];

const AGENT_STARTING_RETRY_DELAYS_MS = [300, 900];

function isRecoverableMcpError(error) {
    const message = error?.message || error?.toString?.() || '';
    if (typeof message !== 'string') {
        return false;
    }
    return RECOVERABLE_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

function resolveBaseUrl(baseUrl) {
    try {
        if (typeof window !== 'undefined' && window.location) {
            return new URL(baseUrl, window.location.href).toString();
        }
    } catch {
        // Fall through to absolute resolution
    }

    return new URL(baseUrl).toString();
}

function isAgentProxyMcpEndpoint(endpoint) {
    try {
        const url = new URL(endpoint);
        return /^\/[^/]+\/mcp$/.test(url.pathname || '');
    } catch {
        return false;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRequestHeaders(rawHeaders) {
    if (!rawHeaders) return [];
    if (typeof Headers !== 'undefined' && rawHeaders instanceof Headers) {
        return Array.from(rawHeaders.entries());
    }
    if (Array.isArray(rawHeaders)) {
        return rawHeaders
            .filter((entry) => Array.isArray(entry) && entry.length >= 2)
            .map(([key, value]) => [String(key), String(value)]);
    }
    if (typeof rawHeaders === 'object') {
        return Object.entries(rawHeaders)
            .filter(([key, value]) => key && value !== undefined && value !== null)
            .map(([key, value]) => [String(key), String(value)]);
    }
    return [];
}

function createAgentClient(baseUrl, options = {}) {
    const endpoint = resolveBaseUrl(baseUrl);
    const disableSseProbe = isAgentProxyMcpEndpoint(endpoint);
    const requestHeaders = normalizeRequestHeaders(options?.requestHeaders);

    let connected = false;
    let sessionId = null;
    let protocolVersion = null;
    let abortController = null;
    let streamTask = null;
    let streamUnsupported = disableSseProbe;
    let connectPromise = null;
    let messageId = 0;
    const requestControllers = new Set();

    const pending = new Map();
    const taskPollers = new Map();

    let serverCapabilities = null;
    let serverInfo = null;
    let instructions = null;

    function nextId() {
        messageId += 1;
        return `${messageId}`;
    }

    function buildHeaders(options = {}) {
        const { acceptStream = false, includeContentType = false } = options;

        const headers = new Headers();
        if (includeContentType) {
            headers.set('content-type', 'application/json');
        }
        headers.set('accept', acceptStream ? 'text/event-stream' : 'application/json, text/event-stream');
        if (sessionId) {
            headers.set('mcp-session-id', sessionId);
        }
        if (protocolVersion) {
            headers.set('mcp-protocol-version', protocolVersion);
        }
        for (const [key, value] of requestHeaders) {
            headers.set(key, value);
        }
        return headers;
    }

    function handleJsonrpcMessage(message) {
        const id = message.id !== undefined && message.id !== null ? String(message.id) : null;

        if (id && pending.has(id)) {
            const { resolve, reject } = pending.get(id);
            pending.delete(id);

            if ('error' in message && message.error) {
                reject(new Error(message.error.message ?? 'Unknown MCP error'));
            } else {
                resolve(message.result);
            }
            return;
        }

        // Notifications are ignored; extend here if needed.
    }

    async function parseJsonResponse(response) {
        const data = await response.json();
        const messages = Array.isArray(data) ? data : [data];
        for (const message of messages) {
            handleJsonrpcMessage(message);
        }
    }

    async function parseSseStream(stream) {
        if (!stream) {
            return;
        }

        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });

            let boundaryIndex;
            while (
                (boundaryIndex = buffer.indexOf('\n\n')) !== -1 ||
                (boundaryIndex = buffer.indexOf('\r\n\r\n')) !== -1
            ) {
                const delimiterLength = buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2;
                const rawEvent = buffer.slice(0, boundaryIndex);
                buffer = buffer.slice(boundaryIndex + delimiterLength);

                const eventLines = rawEvent.split(/\r?\n/);
                let eventId = null;
                const dataLines = [];

                for (const line of eventLines) {
                    if (line.startsWith('id:')) {
                        eventId = line.slice(3).trimStart();
                    } else if (line.startsWith('data:')) {
                        dataLines.push(line.slice(5).trimStart());
                    }
                }

                if (dataLines.length === 0) {
                    continue;
                }

                const payload = dataLines.join('\n');
                try {
                    const parsed = JSON.parse(payload);
                    if (Array.isArray(parsed)) {
                        for (const item of parsed) {
                            handleJsonrpcMessage(item);
                        }
                    } else {
                        handleJsonrpcMessage(parsed);
                    }
                } catch (error) {
                    console.warn('Failed to parse SSE message', error);
                }
            }
        }

        buffer += decoder.decode();

        if (buffer.trim().length > 0) {
            try {
                const parsed = JSON.parse(buffer.trim());
                if (Array.isArray(parsed)) {
                    for (const item of parsed) {
                        handleJsonrpcMessage(item);
                    }
                } else {
                    handleJsonrpcMessage(parsed);
                }
            } catch {
                // Ignore trailing partial data
            }
        }
    }

    function resolveTaskStatusPath(pathname) {
        if (typeof pathname !== 'string' || pathname.length === 0) {
            return '/getTaskStatus';
        }
        let normalized = pathname;
        if (normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }
        const match = normalized.match(/^\/([^/]+)\/mcp$/);
        if (match && match[1]) {
            return `/${match[1]}/task`;
        }
        return '/getTaskStatus';
    }

    function buildTaskStatusUrl(taskId, pathOverride) {
        const statusUrl = new URL(endpoint);
        statusUrl.pathname = pathOverride || resolveTaskStatusPath(statusUrl.pathname || '');
        statusUrl.search = '';
        statusUrl.searchParams.set('taskId', taskId);
        statusUrl.searchParams.set('_', Date.now().toString());
        return statusUrl.toString();
    }

    async function fetchTaskStatus(taskId, poller) {
        try {
            const response = await fetch(buildTaskStatusUrl(taskId, poller?.statusPath), {
                method: 'GET',
                headers: {
                    accept: 'application/json'
                },
                credentials: 'include'
            });
            if (!response.ok) {
                const bodyText = await response.text().catch(() => '');
                if (response.status === 404) {
                    try {
                        const parsed = bodyText ? JSON.parse(bodyText) : null;
                        if (parsed?.error === 'task not found') {
                            return { state: 'not_found' };
                        }
                    } catch {
                        // not JSON; fall through to http_error branch
                    }
                }
                const error = new Error(`Failed to fetch task status: HTTP ${response.status}`);
                error.statusCode = response.status;
                error.body = bodyText;
                return { state: 'http_error', error };
            }
            const payload = await response.json().catch(() => null);
            return { state: 'ok', task: payload?.task ?? null };
        } catch (error) {
            return { state: 'network_error', error };
        }
    }

    function stopTaskPoller(taskId) {
        const poller = taskPollers.get(taskId);
        if (!poller) {
            return;
        }
        if (poller.timer) {
            clearTimeout(poller.timer);
        }
        taskPollers.delete(taskId);
    }

    function stopAllTaskPollers() {
        for (const poller of taskPollers.values()) {
            if (poller.timer) {
                clearTimeout(poller.timer);
            }
        }
        taskPollers.clear();
    }

    async function pollTaskStatus(taskId, callback) {
        const poller = taskPollers.get(taskId);
        if (!poller) {
            return;
        }
        try {
            const result = await fetchTaskStatus(taskId, poller);
            if (result.state === 'not_found') {
                stopTaskPoller(taskId);
                callback({
                    id: taskId,
                    status: 'failed',
                    error: 'task not found'
                });
                return;
            }
            if (result.state === 'network_error') {
                poller.lastError = result.error || null;
                console.warn('[MCPBrowserClient] Task status poll encountered a network error, will retry', result.error);
            } else if (result.state === 'http_error') {
                poller.lastError = result.error || null;
                console.warn('[MCPBrowserClient] Task status poll failed', result.error);
            } else if (result.task) {
                const task = result.task;
                const status = typeof task.status === 'string' ? task.status : null;
                const logSeqValue = Number(task?.logSeq);
                const logSeq = Number.isFinite(logSeqValue) ? logSeqValue : null;
                const isTerminal = status === 'completed' || status === 'failed';
                const statusChanged = poller.lastStatus !== status;
                const logChanged = poller.lastLogSeq !== logSeq;
                if (statusChanged || logChanged) {
                    poller.lastStatus = status;
                    poller.lastLogSeq = logSeq;
                    callback(task);
                }
                if (isTerminal) {
                    stopTaskPoller(taskId);
                    return;
                }
            }
        } catch (error) {
            poller.lastError = error;
            console.warn('[MCPBrowserClient] Task status poll failed', error);
        }
        if (taskPollers.has(taskId)) {
            const timer = setTimeout(() => {
                void pollTaskStatus(taskId, callback);
            }, TASK_POLL_INTERVAL_MS);
            const pollerRef = taskPollers.get(taskId);
            if (pollerRef) {
                pollerRef.timer = timer;
            }
        }
    }

    function startTaskPolling(taskId, callback, options = {}) {
        if (!taskId || typeof callback !== 'function' || taskPollers.has(taskId)) {
            return;
        }
        taskPollers.set(taskId, {
            timer: null,
            lastStatus: null,
            lastLogSeq: null,
            lastError: null,
            statusPath: options.statusPath || null
        });
        void pollTaskStatus(taskId, callback);
    }

    function ensureStreamTask() {
        if (streamTask || streamUnsupported) {
            return;
        }

        if (abortController?.signal.aborted) {
            abortController = null;
        }

        if (!abortController) {
            abortController = new AbortController();
        }

        streamTask = (async () => {
            try {
                const headers = buildHeaders({ acceptStream: true });
                const response = await fetch(endpoint, {
                    method: 'GET',
                    headers,
                    signal: abortController.signal,
                    credentials: 'include'
                });

                if (response.status === 405) {
                    streamUnsupported = true;
                    if (typeof window !== 'undefined') {
                        console.warn('[MCPBrowserClient] SSE stream not supported; falling back to POST responses.');
                    }
                    // Server does not support SSE; fall back to direct responses.
                    return;
                }

                if (!response.ok) {
                    throw new Error(`Failed to open MCP SSE stream: HTTP ${response.status}`);
                }

                await parseSseStream(response.body);
            } catch (error) {
                if (!abortController.signal.aborted) {
                    console.warn('MCP SSE stream error', error);
                }
            } finally {
                streamTask = null;
            }
        })();
    }

    async function sendMessage(message) {
        const requestController = new AbortController();
        requestControllers.add(requestController);
        const optimisticallyAccepted = message.id === undefined;
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: buildHeaders({ includeContentType: true }),
                body: JSON.stringify(message),
                credentials: 'include',
                signal: requestController.signal
            });

            const receivedSession = response.headers.get('mcp-session-id');
            if (receivedSession) {
                sessionId = receivedSession;
            }

            const receivedProtocol = response.headers.get('mcp-protocol-version');
            if (receivedProtocol) {
                protocolVersion = receivedProtocol;
            }

            if (response.status === 202 || response.status === 204) {
                // Asynchronous response via SSE; nothing else to do here.
                return;
            }

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`MCP request failed: HTTP ${response.status}${text ? ` - ${text}` : ''}`);
            }

            const contentType = response.headers.get('content-type') ?? '';
            if (contentType.includes('application/json')) {
                await parseJsonResponse(response);
                return;
            }

            if (contentType.includes('text/event-stream')) {
                await parseSseStream(response.body);
                return;
            }

            if (!optimisticallyAccepted) {
                throw new Error(`Unsupported MCP response content type: ${contentType || '<none>'}`);
            }
        } finally {
            requestControllers.delete(requestController);
        }
    }

    async function sendRequest(method, params) {
        ensureStreamTask();

        const id = nextId();

        const deferred = {};
        const promise = new Promise((resolve, reject) => {
            deferred.resolve = resolve;
            deferred.reject = reject;
        });

        pending.set(id, deferred);

        try {
            await sendMessage({ jsonrpc: JSONRPC_VERSION, id, method, params });
        } catch (error) {
            pending.delete(id);
            deferred.reject(error);
        }

        return promise;
    }

    async function sendNotification(method, params) {
        ensureStreamTask();
        await sendMessage({ jsonrpc: JSONRPC_VERSION, method, params });
    }

    async function connect() {
        if (connected) {
            return;
        }
        if (connectPromise) {
            await connectPromise;
            return;
        }

        connectPromise = (async () => {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    ensureStreamTask();

                    const initResult = await sendRequest('initialize', {
                        protocolVersion: DEFAULT_PROTOCOL_VERSION,
                        capabilities: {},
                        clientInfo: {
                            name: 'ploinky-router',
                            version: '1.0.0'
                        }
                    });

                    protocolVersion = initResult.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
                    serverCapabilities = initResult.capabilities ?? null;
                    serverInfo = initResult.serverInfo ?? null;
                    instructions = initResult.instructions ?? null;

                    await sendNotification('notifications/initialized');
                    connected = true;
                    return;
                } catch (error) {
                    if (attempt >= AGENT_STARTING_RETRY_DELAYS_MS.length || !isRecoverableMcpError(error)) {
                        throw error;
                    }
                    await resetConnectionState();
                    await sleep(AGENT_STARTING_RETRY_DELAYS_MS[attempt]);
                }
            }
        })();
        try {
            await connectPromise;
        } finally {
            connectPromise = null;
        }
    }

    async function resetConnectionState() {
        if (abortController) {
            abortController.abort();
        }
        for (const controller of requestControllers) {
            try {
                controller.abort();
            } catch {
                // ignore abort failures
            }
        }
        requestControllers.clear();
        streamTask = null;
        abortController = null;
        streamUnsupported = disableSseProbe;
        connectPromise = null;

        for (const { reject } of pending.values()) {
            reject(new Error('MCP client reset'));
        }
        pending.clear();

        stopAllTaskPollers();

        connected = false;
        sessionId = null;
        protocolVersion = null;
        serverCapabilities = null;
        serverInfo = null;
        instructions = null;
    }

    async function withReconnectRetry(operation) {
        try {
            return await operation();
        } catch (error) {
            if (!isRecoverableMcpError(error)) {
                throw error;
            }
            await resetConnectionState();
            return await operation();
        }
    }

    async function listTools() {
        return await withReconnectRetry(async () => {
            await connect();
            const result = await sendRequest('tools/list', {});
            return result?.tools ?? [];
        });
    }

    async function callTool(name, args, options = {}) {
        return await withReconnectRetry(async () => {
            await connect();
            const params = {
                name,
                arguments: args ?? {}
            };
            const result = await sendRequest('tools/call', params);
        const taskMetadata = result?.metadata && typeof result.metadata === 'object' ? result.metadata : null;
        const taskId = typeof taskMetadata?.taskId === 'string' && taskMetadata.taskId.trim().length
            ? taskMetadata.taskId.trim()
            : null;
        if (!taskId) {
            return result;
        }
        if (typeof options.onTaskUpdate === 'function') {
            try {
                options.onTaskUpdate({
                    id: taskId,
                    status: typeof taskMetadata?.status === 'string' ? taskMetadata.status : 'queued',
                    createdAt: taskMetadata?.createdAt,
                    updatedAt: taskMetadata?.updatedAt,
                    toolName: taskMetadata?.toolName || name
                });
            } catch (error) {
                console.warn('[MCPBrowserClient] onTaskUpdate callback failed', error);
            }
        }
        const statusAgent = typeof taskMetadata?.agent === 'string' && taskMetadata.agent.trim().length
            ? taskMetadata.agent.trim()
            : null;

        const finalTask = await new Promise((resolve, reject) => {
            startTaskPolling(taskId, (task) => {
                if (!task) {
                    return;
                }
                if (typeof options.onTaskUpdate === 'function') {
                    try {
                        options.onTaskUpdate(task);
                    } catch (error) {
                        console.warn('[MCPBrowserClient] onTaskUpdate callback failed', error);
                    }
                }
                const status = typeof task.status === 'string' ? task.status.toLowerCase() : '';
                if (status === 'completed') {
                    resolve(task);
                } else if (status === 'failed') {
                    const error = new Error(task.error || 'Task failed');
                    error.task = task;
                    reject(error);
                }
            }, { statusPath: statusAgent ? `/${statusAgent}/task` : undefined });
        });

            const metadata = {
                ...finalTask.result.metadata,
                taskId: finalTask.id,
                toolName: finalTask.toolName,
                status: finalTask.status,
                createdAt: finalTask.createdAt,
                updatedAt: finalTask.updatedAt
            };
            return { content: finalTask.result.content, metadata };
        });
    }

    async function listResources() {
        return await withReconnectRetry(async () => {
            await connect();
            const result = await sendRequest('resources/list', {});
            return result?.resources ?? [];
        });
    }

    async function readResource(uri, meta) {
        return await withReconnectRetry(async () => {
            await connect();
            const params = { uri };
            if (meta && typeof meta === 'object') {
                params._meta = meta;
            }
            const result = await sendRequest('resources/read', params);
            return result?.resource ?? result;
        });
    }

    async function ping(meta) {
        return await withReconnectRetry(async () => {
            await connect();
            const params = meta && typeof meta === 'object' ? { _meta: meta } : undefined;
            return await sendRequest('ping', params);
        });
    }

    async function close() {
        const currentSessionId = sessionId;
        if (abortController) {
            abortController.abort();
        }
        streamTask = null;
        abortController = null;
        streamUnsupported = disableSseProbe;
        connectPromise = null;

        try {
            if (currentSessionId) {
                const headers = new Headers();
                headers.set('accept', 'application/json, text/event-stream');
                headers.set('mcp-session-id', currentSessionId);
                if (protocolVersion) {
                    headers.set('mcp-protocol-version', protocolVersion);
                }
                for (const [key, value] of requestHeaders) {
                    headers.set(key, value);
                }
                await fetch(endpoint, {
                    method: 'DELETE',
                    headers,
                    credentials: 'include'
                });
            }
        } catch {
            // Ignore close errors
        }

        for (const { reject } of pending.values()) {
            reject(new Error('MCP client closed'));
        }
        pending.clear();

        stopAllTaskPollers();

        connected = false;
        sessionId = null;
        protocolVersion = null;
        serverCapabilities = null;
        serverInfo = null;
        instructions = null;
    }

    return {
        connect,
        listTools,
        callTool,
        listResources,
        readResource,
        ping,
        close,
        getCapabilities: () => serverCapabilities,
        getServerInfo: () => serverInfo,
        getInstructions: () => instructions
    };
}

export { createAgentClient };
