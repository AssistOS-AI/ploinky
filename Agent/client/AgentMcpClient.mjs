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

import { signAgentAssertion, signAgentHttpAssertion } from '../lib/agentAssertion.mjs';
import { OPENAI_MODELS_PATH, OPENAI_MODELS_TOOL } from '../lib/invocationAuth.mjs';
import {
    assertVerifiedGeneratedRouterDescriptor,
    loadVerifiedGeneratedRouterDescriptor,
    resolveGeneratedRouterOperation,
} from './generatedRouterDescriptor.mjs';

function trustedDescriptor(descriptor) {
    return descriptor === undefined
        ? loadVerifiedGeneratedRouterDescriptor()
        : assertVerifiedGeneratedRouterDescriptor(descriptor);
}

function normalizeAgentName(agentName) {
    const value = String(agentName || '').trim();
    if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
        throw new Error('AgentMcpClient: agentName is invalid');
    }
    return value;
}

export function getRouterUrl(descriptor) {
    return trustedDescriptor(descriptor).physicalOrigin;
}

export function getAgentMcpUrl(agentName, descriptor) {
    return resolveGeneratedRouterOperation(
        trustedDescriptor(descriptor),
        `/${normalizeAgentName(agentName)}/mcp`,
    ).toString();
}

export function getRouterAuthority(descriptor) {
    return trustedDescriptor(descriptor).requestAuthority;
}

const DEFAULT_TASK_POLL_INTERVAL_MS = 5000;
const DEFAULT_CALL_TIMEOUT_MS = 450000;
const MARKETPLACE_PATH = '/api/marketplace';
const MARKETPLACE_TARGET = 'ploinky-router';
const MARKETPLACE_READ_TOOL = 'marketplace.read';
const MARKETPLACE_ENABLE_TOOL = 'marketplace.enable_agent';
const DEFAULT_AGENT_START_TIMEOUT_MS = 180000;
const AGENT_START_POLL_INTERVAL_MS = 250;
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

let taskObserver = null;

function normalizeCallTimeout(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
        ? Math.max(1, Math.floor(parsed))
        : DEFAULT_CALL_TIMEOUT_MS;
}

function callTimeoutError(timeoutMs) {
    const error = new Error(`AgentMcpClient: tool call timed out after ${timeoutMs}ms`);
    error.code = 'PLOINKY_AGENT_MCP_TIMEOUT';
    return error;
}

export function setAgentTaskObserver(observer) {
    if (observer !== null && typeof observer !== 'function') {
        throw new Error('AgentMcpClient: task observer must be a function or null');
    }
    taskObserver = observer;
    return () => {
        if (taskObserver === observer) {
            taskObserver = null;
        }
    };
}

async function applyTaskObserver({
    result,
    agentName,
    taskId,
    toolName,
    toolArgs,
    metadata,
    descriptor,
    descriptorProvider,
}) {
    if (typeof taskObserver !== 'function') return null;
    const observation = await taskObserver({
        agentName,
        taskId,
        toolName,
        arguments: toolArgs,
        metadata: metadata || {},
        getTaskStatus: () => getTaskStatus(
            agentName,
            taskId,
            typeof descriptorProvider === 'function' ? descriptorProvider() : descriptor,
        ),
    });
    if (observation?.detached !== true) return null;
    return {
        ...result,
        metadata: {
            ...(metadata || {}),
            backgroundTask: {
                detached: true,
                id: observation.id || '',
                description: observation.description || '',
            },
        },
    };
}

export const __testables = { applyTaskObserver };

function normalizeDelegationToken(token) {
    if (token === undefined || token === null || token === '') return '';
    if (typeof token !== 'string') {
        throw new Error('AgentMcpClient: userDelegationToken must be a string');
    }
    return token.trim();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function marketplaceUrl(descriptor) {
    return resolveGeneratedRouterOperation(trustedDescriptor(descriptor), MARKETPLACE_PATH);
}

function marketplaceToolForRequest(method, body) {
    return method === 'POST' && body?.action === 'enable_agent'
        ? MARKETPLACE_ENABLE_TOOL
        : MARKETPLACE_READ_TOOL;
}

function requestMarketplace(method = 'GET', body = null, descriptor) {
    const verified = trustedDescriptor(descriptor);
    const url = marketplaceUrl(verified);
    const httpModule = url.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : Buffer.alloc(0);
    const tool = marketplaceToolForRequest(method, body);
    const assertion = signAgentHttpAssertion({
        method,
        path: MARKETPLACE_PATH,
        query: '',
        body: payload,
        targetAgent: MARKETPLACE_TARGET,
        tool,
    });

    return new Promise((resolve, reject) => {
        const req = httpModule.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: MARKETPLACE_PATH,
            method,
            headers: {
                host: getRouterAuthority(verified),
                accept: 'application/json',
                authorization: `Bearer ${assertion}`,
                ...(payload.length ? {
                    'content-type': 'application/json',
                    'content-length': payload.length,
                } : {}),
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { json = null; }
                if ((res.statusCode || 0) >= 400 || !json || json.ok === false) {
                    const detail = json?.message || json?.error || text || `HTTP ${res.statusCode}`;
                    reject(new Error(`Marketplace request failed: ${String(detail).slice(0, 300)}`));
                    return;
                }
                resolve(json.marketplace || json);
            });
        });
        req.on('error', reject);
        if (payload.length) req.write(payload);
        req.end();
    });
}

function findMarketplaceAgent(marketplace, agentRef) {
    const normalizedRef = String(agentRef || '').trim();
    if (!normalizedRef) {
        throw new Error('AgentMcpClient: agentRef is required');
    }
    const agents = Array.isArray(marketplace?.agents) ? marketplace.agents : [];
    const exact = agents.find((agent) => String(agent?.ref || '') === normalizedRef);
    if (exact) return exact;
    if (!normalizedRef.includes('/')) {
        const matches = agents.filter((agent) => String(agent?.name || '') === normalizedRef);
        if (matches.length === 1) return matches[0];
        if (matches.length > 1) {
            throw new Error(`AgentMcpClient: agent '${normalizedRef}' is ambiguous; use repo/agent`);
        }
    }
    return null;
}

export async function getAgentStatus(agentRef, descriptor) {
    const verified = trustedDescriptor(descriptor);
    const marketplace = await requestMarketplace('GET', null, verified);
    return findMarketplaceAgent(marketplace, agentRef);
}

export async function ensureAgentRunning(agentRef, options = {}, descriptor) {
    const verified = trustedDescriptor(descriptor);
    const initial = await getAgentStatus(agentRef, verified);
    if (!initial) {
        throw new Error(`AgentMcpClient: agent '${agentRef}' is not installed`);
    }
    if (initial.running === true) return initial;

    const mode = typeof options.mode === 'string' ? options.mode.trim() : '';
    const marketplace = await requestMarketplace('POST', {
        action: 'enable_agent',
        agentRef: initial.ref,
        ...(mode ? { mode } : {}),
    }, verified);
    const enabled = findMarketplaceAgent(marketplace, initial.ref);
    if (enabled?.running === true) return enabled;

    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_AGENT_START_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(AGENT_START_POLL_INTERVAL_MS);
        const status = await getAgentStatus(initial.ref, verified);
        if (status?.running === true) return status;
    }
    throw new Error(`AgentMcpClient: agent '${initial.ref}' did not start within ${timeoutMs}ms`);
}

function postToolCall(agentName, jsonRpcBody, assertion, userDelegationToken = '', descriptor, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    const verified = trustedDescriptor(descriptor);
    const url = resolveGeneratedRouterOperation(verified, `/${normalizeAgentName(agentName)}/mcp`);
    const httpModule = url.protocol === 'https:' ? https : http;
    const payload = Buffer.from(JSON.stringify(jsonRpcBody), 'utf8');
    const delegationToken = normalizeDelegationToken(userDelegationToken);
    return new Promise((resolve, reject) => {
        let req;
        const timeout = setTimeout(() => req?.destroy(callTimeoutError(timeoutMs)), timeoutMs);
        req = httpModule.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search || ''}`,
            method: 'POST',
            headers: {
                host: getRouterAuthority(verified),
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
                clearTimeout(timeout);
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { json = null; }
                resolve({ status: res.statusCode, json, text });
            });
        });
        req.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        req.end(payload);
    });
}

function getTaskStatus(agentName, taskId, descriptor, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    const verified = trustedDescriptor(descriptor);
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
        throw new Error('AgentMcpClient: taskId is required');
    }
    const url = resolveGeneratedRouterOperation(verified, `/${normalizeAgentName(agentName)}/task`);
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
        let req;
        const timeout = setTimeout(() => req?.destroy(callTimeoutError(timeoutMs)), timeoutMs);
        req = httpModule.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search || ''}`,
            method: 'GET',
            headers: {
                host: getRouterAuthority(verified),
                accept: 'application/json',
                authorization: `Bearer ${assertion}`,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                clearTimeout(timeout);
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
        req.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        req.end();
    });
}

function getAgentModels(agentName, descriptor, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    const verified = trustedDescriptor(descriptor);
    const normalizedAgentName = normalizeAgentName(agentName);
    const url = resolveGeneratedRouterOperation(verified, `/${normalizedAgentName}${OPENAI_MODELS_PATH}`);
    const httpModule = url.protocol === 'https:' ? https : http;
    const assertion = signAgentHttpAssertion({
        method: 'GET',
        path: OPENAI_MODELS_PATH,
        query: '',
        body: Buffer.alloc(0),
        targetAgent: normalizedAgentName,
        tool: OPENAI_MODELS_TOOL,
    });
    return new Promise((resolve, reject) => {
        let req;
        const timeout = setTimeout(() => req?.destroy(callTimeoutError(timeoutMs)), timeoutMs);
        req = httpModule.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: `${url.pathname}${url.search || ''}`,
            method: 'GET',
            headers: {
                host: getRouterAuthority(verified),
                accept: 'application/json',
                authorization: `Bearer ${assertion}`,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                clearTimeout(timeout);
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { json = null; }
                if ((res.statusCode || 500) >= 400 || !json || !Array.isArray(json.data)) {
                    const detail = json?.error?.message || json?.error || text || `HTTP ${res.statusCode}`;
                    reject(new Error(`agent models failed: ${String(detail).slice(0, 300)}`));
                    return;
                }
                resolve(json);
            });
        });
        req.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        req.end();
    });
}

function cancelTask(agentName, taskId, descriptor) {
    const verified = trustedDescriptor(descriptor);
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) throw new Error('AgentMcpClient: taskId is required');
    const args = { taskId: normalizedTaskId };
    const url = resolveGeneratedRouterOperation(verified, `/${normalizeAgentName(agentName)}/task/cancel`);
    const payload = Buffer.from(JSON.stringify(args), 'utf8');
    const httpModule = url.protocol === 'https:' ? https : http;
    const assertion = signAgentAssertion({
        method: 'POST',
        path: '/task/cancel',
        targetAgent: agentName,
        tool: '__task_cancel__',
        argumentsObj: args,
    });
    return new Promise((resolve, reject) => {
        const req = httpModule.request({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                host: getRouterAuthority(verified),
                accept: 'application/json',
                'content-type': 'application/json',
                'content-length': payload.length,
                authorization: `Bearer ${assertion}`,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = text ? JSON.parse(text) : null; } catch { json = null; }
                if (res.statusCode >= 400 || !json?.task) {
                    reject(new Error(json?.reason || json?.error || `agent task cancel failed (status ${res.statusCode})`));
                    return;
                }
                resolve(json.task);
            });
        });
        req.on('error', reject);
        req.end(payload);
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

function stopTaskPoller(taskPollers, taskId, reason = null) {
    const poller = taskPollers.get(taskId);
    if (!poller) {
        return;
    }
    if (poller.timer) {
        clearTimeout(poller.timer);
    }
    taskPollers.delete(taskId);
    if (reason && typeof poller.cancel === 'function') {
        poller.cancel(reason);
    }
}

function stopAllTaskPollers(taskPollers, reason = new Error('AgentMcpClient: client closed')) {
    for (const taskId of [...taskPollers.keys()]) {
        stopTaskPoller(taskPollers, taskId, reason);
    }
}

function parseTaskStatusResponse(agentName, taskId, descriptor, timeoutMs) {
    return getTaskStatus(agentName, taskId, descriptor, timeoutMs)
        .then((task) => ({ state: 'ok', task }))
        .catch((error) => {
            if (isTaskNotFoundError(error)) {
                return { state: 'not_found', error };
            }
            return { state: 'error', error };
        });
}

async function pollTaskStatus(taskPollers, agentName, taskId, callback, options = {}) {
    const poller = taskPollers.get(taskId);
    if (!poller) {
        return;
    }
    const remainingMs = Number(options.deadline || 0) - Date.now();
    if (Number(options.deadline || 0) > 0 && remainingMs <= 0) {
        stopTaskPoller(taskPollers, taskId, callTimeoutError(options.timeoutMs));
        return;
    }
    try {
        const requestDescriptor = typeof options.descriptorProvider === 'function'
            ? options.descriptorProvider()
            : options.descriptor;
        const result = await parseTaskStatusResponse(
            agentName,
            taskId,
            requestDescriptor,
            Number(options.deadline || 0) > 0 ? Math.max(1, remainingMs) : DEFAULT_CALL_TIMEOUT_MS,
        );
        if (result.state === 'not_found') {
            stopTaskPoller(taskPollers, taskId);
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
                stopTaskPoller(taskPollers, taskId);
                return;
            }
        }
    } catch (error) {
        poller.lastError = error;
        console.warn('[AgentMcpClient] Task status poll failed', error);
    }

    if (taskPollers.has(taskId)) {
        const delayMs = Number(options.deadline || 0) > 0
            ? Math.min(TASK_POLL_INTERVAL_MS, Math.max(1, Number(options.deadline) - Date.now()))
            : TASK_POLL_INTERVAL_MS;
        const timer = setTimeout(() => {
            void pollTaskStatus(taskPollers, agentName, taskId, callback, options);
        }, delayMs);
        const pollerRef = taskPollers.get(taskId);
        if (pollerRef) {
            pollerRef.timer = timer;
        }
    }
}

function startTaskPolling(taskPollers, agentName, taskId, callback, _options = {}) {
    if (!taskId || typeof callback !== 'function' || taskPollers.has(taskId)) {
        return;
    }
    taskPollers.set(taskId, {
        timer: null,
        lastStatus: null,
        lastLogSeq: null,
        lastError: null,
        cancel: _options.onCancel,
    });
    void pollTaskStatus(taskPollers, agentName, taskId, callback, _options);
}

/**
 * Create a router-mediated client for calling `agentName`'s tools. Only tool
 * calls are supported: the router's delegated path accepts a direct tools/call,
 * so listing/initialization over agent-to-agent is intentionally unavailable
 * (use a user/session surface for discovery).
 */
export async function createAgentClient(agentName, options = {}) {
    // Validate provenance before assertion signing can read the agent secret
    // and before a request can construct a socket.
    const injectedDescriptor = options?.routerDescriptor;
    const descriptor = trustedDescriptor(injectedDescriptor);
    const descriptorForRequest = () => injectedDescriptor === undefined
        ? loadVerifiedGeneratedRouterDescriptor()
        : descriptor;
    normalizeAgentName(agentName);
    const defaultDelegationToken = normalizeDelegationToken(options?.userDelegationToken);
    const taskPollers = new Map();

    async function requestToolCall(name, args = {}, callOptions = {}) {
        const timeoutMs = normalizeCallTimeout(callOptions.timeoutMs);
        const deadline = Date.now() + timeoutMs;
        const requestDescriptor = descriptorForRequest();
        resolveGeneratedRouterOperation(requestDescriptor, `/${normalizeAgentName(agentName)}/mcp`);
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
        const { status, json, text } = await postToolCall(
            agentName,
            body,
            assertion,
            delegationToken,
            requestDescriptor,
            timeoutMs,
        );
        if (json && json.error) {
            const err = new Error(json.error.message || 'agent-to-agent call failed');
            err.code = json.error.code;
            err.data = json.error.data;
            throw err;
        }
        if (status >= 400 || !json) {
            throw new Error(`agent-to-agent call failed (status ${status}): ${(text || '').slice(0, 200)}`.trim());
        }
        return {
            result: unwrapToolResult(json.result),
            toolArgs,
            timeoutMs,
            deadline,
        };
    }

    async function callTool(name, args = {}, callOptions = {}) {
        const { result, timeoutMs, deadline } = await requestToolCall(name, args, callOptions);
        const taskId = normalizeTaskId(result);
        if (!taskId) {
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
            let deadlineTimer = null;
            const finalize = (task, isError = false) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (deadlineTimer) clearTimeout(deadlineTimer);
                stopTaskPoller(taskPollers, taskId);
                if (isError) {
                    reject(task);
                } else {
                    resolve(task);
                }
            };

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                finalize(callTimeoutError(timeoutMs), true);
                return;
            }
            deadlineTimer = setTimeout(() => {
                finalize(callTimeoutError(timeoutMs), true);
            }, remainingMs);
            startTaskPolling(taskPollers, agentName, taskId, (task) => {
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
            }, {
                descriptorProvider: descriptorForRequest,
                deadline,
                timeoutMs,
                onCancel: (error) => finalize(error, true),
            });
        });

        return parseTaskPayload(finalTask);
    }

    async function callToolWithoutWait(name, args = {}, callOptions = {}) {
        const { result, toolArgs } = await requestToolCall(name, args, callOptions);
        const taskId = normalizeTaskId(result);
        if (!taskId) {
            return result;
        }

        const metadata = result?.metadata;
        const observedResult = await applyTaskObserver({
            result,
            agentName,
            taskId,
            toolName: metadata?.toolName || name,
            toolArgs,
            metadata,
            descriptorProvider: descriptorForRequest,
        });
        return observedResult || result;
    }

    const unsupported = (op) => async () => {
        throw new Error(`${op} is not available via agent-to-agent calls; use callTool`);
    };

    return {
        callTool,
        callToolWithoutWait,
        getAgentStatus: (agentRef = agentName) => getAgentStatus(agentRef, descriptorForRequest()),
        ensureAgentRunning: (agentRef = agentName, startOptions = {}) => ensureAgentRunning(agentRef, startOptions, descriptorForRequest()),
        getTaskStatus: (taskId) => getTaskStatus(agentName, taskId, descriptorForRequest()),
        getModels: () => getAgentModels(agentName, descriptorForRequest()),
        cancelTask: (taskId) => cancelTask(agentName, taskId, descriptorForRequest()),
        connect: async () => {},
        listTools: unsupported('listTools'),
        listResources: unsupported('listResources'),
        readResource: unsupported('readResource'),
        ping: unsupported('ping'),
        close: async () => {
            stopAllTaskPollers(taskPollers);
        },
    };
}
