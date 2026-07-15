// AgentMcpClient: lets an agent call another agent's tools THROUGH the router.
//
// Agent-to-agent is always router-mediated (DS013): the source agent signs a
// per-call Agent Assertion with its OWN PLOINKY_AGENT_SECRET, posts a direct
// JSON-RPC tools/call to the router at /<target>/mcp with the assertion as
// `Authorization: Bearer`, and the router verifies the assertion, applies MCP
// policy, and mints a Router Request for the target. There is no shared key and
// no client-credentials token exchange; the legacy /auth/agent-token flow is gone.

import http from 'node:http';
import https from 'node:https';

import { signAgentAssertion } from '../lib/agentAssertion.mjs';

export function getRouterUrl() {
    const raw = process.env.PLOINKY_ROUTER_URL;
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error('AgentMcpClient: PLOINKY_ROUTER_URL is required and must be a valid nonempty HTTP(S) URL');
    }
    let url;
    try {
        url = new URL(raw.trim());
    } catch (error) {
        throw new Error('AgentMcpClient: PLOINKY_ROUTER_URL must be a valid nonempty HTTP(S) URL', { cause: error });
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new Error('AgentMcpClient: PLOINKY_ROUTER_URL must be a valid nonempty HTTP(S) URL without credentials');
    }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
        throw new Error('AgentMcpClient: PLOINKY_ROUTER_URL must identify the router origin without a path, query, or fragment');
    }
    return url.origin;
}

export function getAgentMcpUrl(agentName, routerUrl = getRouterUrl()) {
    return `${routerUrl}/${agentName}/mcp`;
}

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

const taskPollers = new Map();

function normalizeDelegationToken(token) {
    if (token === undefined || token === null || token === '') return '';
    if (typeof token !== 'string') {
        throw new Error('AgentMcpClient: userDelegationToken must be a string');
    }
    return token.trim();
}

function postToolCall(agentName, jsonRpcBody, assertion, userDelegationToken = '', routerUrl = getRouterUrl()) {
    const url = new URL(getAgentMcpUrl(agentName, routerUrl));
    const httpModule = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(jsonRpcBody), 'utf8');
    const delegationToken = normalizeDelegationToken(userDelegationToken);
    return new Promise((resolve, reject) => {
        const req = httpModule.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search || ''}`,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': payload.length,
                accept: 'application/json',
                authorization: `Bearer ${assertion}`,
                ...(delegationToken ? { 'x-ploinky-user-delegation': delegationToken } : {}),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { json = null; }
                resolve({ status: res.statusCode, json, text });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function getTaskStatus(agentName, taskId, routerUrl = getRouterUrl()) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        throw new Error('AgentMcpClient: taskId is required');
    }
    const url = new URL(routerUrl);
    url.pathname = `/${agentName}/task`;
    url.searchParams.set('taskId', normalizedTaskId);
    const httpModule = url.protocol === 'https:' ? https : http;
    const assertion = signAgentAssertion({
        method: 'GET',
        path: '/task',
        targetAgent: agentName,
        tool: '__task_status__',
        argumentsObj: { taskId: normalizedTaskId },
    });
    return new Promise((resolve, reject) => {
        const req = httpModule.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search || ''}`,
            method: 'GET',
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${assertion}`,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { json = null; }
                if (res.statusCode >= 400 || !json) {
                    reject(new Error(`agent task status failed (status ${res.statusCode}): ${(text || '').slice(0, 200)}`.trim()));
                    return;
                }
                if (json.error) {
                    reject(new Error(json.error.reason || json.error.detail || json.error.message || json.error));
                    return;
                }
                resolve(json.task || json);
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function unwrapToolResult(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    if (content.length !== 1) {
        return result;
    }
    const entry = content[0];
    if (!entry || String(entry.type || '') !== 'text' || typeof entry.text !== 'string') {
        return result;
    }
    try {
        return JSON.parse(entry.text);
    } catch (_) {
        return result;
    }
}

function parseTaskPayload(rawTask) {
    if (!rawTask || typeof rawTask !== 'object') {
        return rawTask;
    }

    const resultSource = rawTask.result || rawTask;
    const parsed = unwrapToolResult(resultSource);
    if (parsed && typeof parsed === 'object' && parsed !== rawTask) {
        return {
            ...rawTask,
            ...parsed,
        };
    }
    return rawTask;
}

function normalizeTaskId(payload) {
    const candidate = payload?.metadata?.taskId || payload?.result?.metadata?.taskId;
    if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
    }
    return '';
}

function taskError(task) {
    const status = typeof task?.status === 'string' ? task.status : 'failed';
    const message = typeof task?.error === 'string' && task.error.trim() ? task.error.trim() : `Task ${task?.id || 'execution'} ${status}`;
    const error = new Error(message);
    error.task = task;
    return error;
}

function emitTaskUpdate(onTaskUpdate, task) {
    if (typeof onTaskUpdate !== 'function') {
        return;
    }
    try {
        onTaskUpdate(task);
    } catch (error) {
        console.warn('[AgentMcpClient] onTaskUpdate callback failed', error);
    }
}

function isTaskNotFoundError(error) {
    const message = error?.message || error?.toString?.() || '';
    if (typeof message !== 'string') {
        return false;
    }
    const normalized = message.toLowerCase();
    return normalized.includes('not_found') || normalized.includes('task not found') || normalized.includes('status 404');
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

function parseTaskStatusResponse(agentName, taskId, routerUrl) {
    return getTaskStatus(agentName, taskId, routerUrl)
        .then((task) => ({ state: 'ok', task }))
        .catch((error) => {
            if (isTaskNotFoundError(error)) {
                return { state: 'not_found', error };
            }
            return { state: 'error', error };
        });
}

async function pollTaskStatus(agentName, taskId, callback, options = {}) {
    const poller = taskPollers.get(taskId);
    if (!poller) {
        return;
    }
    try {
        const result = await parseTaskStatusResponse(agentName, taskId, options.routerUrl);
        if (result.state === 'not_found') {
            stopTaskPoller(taskId);
            callback({
                id: taskId,
                status: 'failed',
                error: 'task not found'
            });
            return;
        }
        if (result.state === 'error') {
            poller.lastError = result.error || null;
            console.warn('[AgentMcpClient] Task status poll failed, retrying', result.error);
        } else if (result.task) {
            const task = result.task;
            const status = typeof task.status === 'string' ? task.status : null;
            const logSeqValue = Number(task?.logSeq);
            const logSeq = Number.isFinite(logSeqValue) ? logSeqValue : null;
            const statusChanged = poller.lastStatus !== status;
            const logChanged = poller.lastLogSeq !== logSeq;
            if (statusChanged || logChanged) {
                poller.lastStatus = status;
                poller.lastLogSeq = logSeq;
                callback(task);
            }
            const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
            if (isTerminal) {
                stopTaskPoller(taskId);
                return;
            }
        }
    } catch (error) {
        poller.lastError = error;
        console.warn('[AgentMcpClient] Task status poll failed', error);
    }

    if (taskPollers.has(taskId)) {
        const timer = setTimeout(() => {
            void pollTaskStatus(agentName, taskId, callback, options);
        }, TASK_POLL_INTERVAL_MS);
        const pollerRef = taskPollers.get(taskId);
        if (pollerRef) {
            pollerRef.timer = timer;
        }
    }
}

function startTaskPolling(agentName, taskId, callback, _options = {}) {
    if (!taskId || typeof callback !== 'function' || taskPollers.has(taskId)) {
        return;
    }
    taskPollers.set(taskId, {
        timer: null,
        lastStatus: null,
        lastLogSeq: null,
        lastError: null,
    });
    void pollTaskStatus(agentName, taskId, callback, _options);
}

/**
 * Create a router-mediated client for calling `agentName`'s tools. Only
 * `callTool` is supported: the router's delegated path accepts a direct
 * tools/call, so listing/initialization over agent-to-agent is intentionally
 * unavailable (use a user/session surface for discovery).
 */
export async function createAgentClient(agentName, options = {}) {
    const routerUrl = getRouterUrl();
    const defaultDelegationToken = normalizeDelegationToken(options?.userDelegationToken);

    async function callTool(name, args = {}, callOptions = {}) {
        const toolArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
        const assertion = signAgentAssertion({
            method: 'POST',
            path: '/mcp',
            targetAgent: agentName,
            tool: name,
            argumentsObj: toolArgs,
        });
        const body = {
            jsonrpc: '2.0',
            id: `a2a-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2)}`,
            method: 'tools/call',
            params: { name, arguments: toolArgs },
        };
        const delegationToken = Object.prototype.hasOwnProperty.call(callOptions || {}, 'userDelegationToken')
            ? callOptions.userDelegationToken
            : defaultDelegationToken;
        const { status, json, text } = await postToolCall(agentName, body, assertion, delegationToken, routerUrl);
        if (json && json.error) {
            const err = new Error(json.error.message || 'agent-to-agent call failed');
            err.code = json.error.code;
            err.data = json.error.data;
            throw err;
        }
        if (status >= 400 || !json) {
            throw new Error(`agent-to-agent call failed (status ${status}): ${(text || '').slice(0, 200)}`.trim());
        }
        const result = unwrapToolResult(json.result);
        const taskId = normalizeTaskId(result);
        if (typeof callOptions.onTaskUpdate !== 'function' || !taskId) {
            return result;
        }

        const metadata = result?.metadata;
        const initialUpdate = {
            id: taskId,
            status: typeof metadata?.status === 'string' ? metadata.status : 'queued',
            createdAt: metadata?.createdAt,
            updatedAt: metadata?.updatedAt,
            toolName: metadata?.toolName || name,
        };
        emitTaskUpdate(callOptions.onTaskUpdate, initialUpdate);

        const finalTask = await new Promise((resolve, reject) => {
            let settled = false;
            const finalize = (task, isError = false) => {
                if (settled) {
                    return;
                }
                settled = true;
                stopTaskPoller(taskId);
                if (isError) {
                    reject(task);
                } else {
                    resolve(task);
                }
            };

            startTaskPolling(agentName, taskId, (task) => {
                emitTaskUpdate(callOptions.onTaskUpdate, task);
                if (!task || typeof task !== 'object') {
                    return;
                }
                const status = typeof task.status === 'string' ? task.status.toLowerCase() : '';
                if (status === 'completed') {
                    finalize(task);
                } else if (status === 'failed' || status === 'cancelled' || status === 'not_found') {
                    finalize(taskError(task), true);
                }
            }, { routerUrl });
        });

        return parseTaskPayload(finalTask);
    }

    const unsupported = (op) => async () => {
        throw new Error(`${op} is not available via agent-to-agent calls; use callTool`);
    };

    return {
        callTool,
        getTaskStatus: (taskId) => getTaskStatus(agentName, taskId, routerUrl),
        connect: async () => {},
        listTools: unsupported('listTools'),
        listResources: unsupported('listResources'),
        readResource: unsupported('readResource'),
        ping: unsupported('ping'),
        close: async () => {
            stopAllTaskPollers();
        },
    };
}
