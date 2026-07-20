import {
    beginTaskContinuation,
    getTask,
    ingestTaskEvent,
    listTasks,
    readTaskLog,
} from '../../webchat/taskStore.js';
import {
    loadRoutingConfig,
    readEnabledAgentManifest,
} from '../../httpServiceRoutes.js';
import {
    cancelAuthenticatedAgentTask,
    invokeAuthenticatedAgentTool,
    readAuthenticatedAgentTask,
} from '../../mcp-proxy/index.js';
import { waitForAgentReady } from '../../utils/agentReadiness.js';
import * as agentsSvc from '../../../utils/agents.js';
import { resolveAgentReadinessProtocol } from '../../../utils/runtime/startupReadiness.js';
import { broadcastTaskUpdate } from './runtimeState.js';

const MAX_CONTINUATION_MESSAGE_BYTES = 32 * 1024;
const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);
const continuationAgentActivations = new Map();

function sendJson(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
    res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
    });
    res.end(html);
}

function resolveAgentRoute(targetAgent) {
    const routes = loadRoutingConfig().routes || {};
    if (routes[targetAgent]) return { agentName: targetAgent, route: routes[targetAgent] };
    for (const [agentName, route] of Object.entries(routes)) {
        const routeRef = route?.repo && route?.agent ? `${route.repo}/${route.agent}` : '';
        if (route?.agent === targetAgent || routeRef === targetAgent || route?.alias === targetAgent) {
            return { agentName, route };
        }
    }
    return null;
}

async function routeIsReady(resolved, {
    timeoutMs,
    waitUntilReady,
    readManifest,
}) {
    if (!resolved?.route?.hostPort) return false;
    const manifest = readManifest(resolved.agentName);
    const protocol = resolveAgentReadinessProtocol(manifest || {});
    if (protocol === 'none') return true;
    return waitUntilReady(resolved.route, {
        timeoutMs,
        intervalMs: 125,
        probeTimeoutMs: 250,
        protocol,
    });
}

async function ensureContinuationAgentRoute(targetAgent, {
    resolveRoute = resolveAgentRoute,
    activateAgent = agentsSvc.enableAgent,
    waitUntilReady = waitForAgentReady,
    readManifest = (agentName) => readEnabledAgentManifest(
        agentName,
        loadRoutingConfig().routes || {},
    ),
} = {}) {
    const normalizedTarget = String(targetAgent || '').trim();
    if (!normalizedTarget) return null;
    const current = resolveRoute(normalizedTarget);
    if (current && await routeIsReady(current, {
        timeoutMs: 750,
        waitUntilReady,
        readManifest,
    })) {
        return current;
    }

    const pending = continuationAgentActivations.get(normalizedTarget);
    if (pending) return pending;

    const activation = (async () => {
        let enabled;
        try {
            enabled = await activateAgent(normalizedTarget, 'global');
        } catch (error) {
            throw Object.assign(new Error('continuation_agent_start_failed'), {
                status: 503,
                cause: error,
            });
        }
        const candidates = [
            normalizedTarget,
            enabled?.alias,
            enabled?.shortAgentName,
            enabled?.repoName && enabled?.shortAgentName
                ? `${enabled.repoName}/${enabled.shortAgentName}`
                : '',
        ].filter(Boolean);
        let resolved = null;
        for (const candidate of candidates) {
            resolved = resolveRoute(candidate);
            if (resolved) break;
        }
        if (!resolved) {
            throw Object.assign(new Error('continuation_agent_unavailable'), { status: 409 });
        }
        const ready = await routeIsReady(resolved, {
            timeoutMs: 15_000,
            waitUntilReady,
            readManifest,
        });
        if (!ready) {
            throw Object.assign(new Error('continuation_agent_not_ready'), { status: 503 });
        }
        return resolved;
    })().finally(() => {
        continuationAgentActivations.delete(normalizedTarget);
    });
    continuationAgentActivations.set(normalizedTarget, activation);
    return activation;
}

function readJsonBody(req, maximumBytes = MAX_CONTINUATION_MESSAGE_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        req.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > maximumBytes) {
                settled = true;
                const error = new Error('continuation_message_too_large');
                error.status = 413;
                reject(error);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch {
                const error = new Error('invalid_json');
                error.status = 400;
                reject(error);
            }
        });
        req.on('error', (error) => {
            if (!settled) {
                settled = true;
                reject(error);
            }
        });
    });
}

function remoteStatus(status) {
    const normalized = String(status || '').trim().toLowerCase();
    if (normalized === 'completed') return 'finished';
    if (normalized === 'cancelled') return 'stopped';
    if (normalized === 'failed' || normalized === 'not_found') return 'error';
    return 'ongoing';
}

function taskResultText(task) {
    const content = task?.result?.content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((entry) => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry) => entry.text)
        .join('\n');
}

function ingestRemoteTask(workspaceDirectory, task, remote) {
    const continuation = remote?.result?.metadata?.continuation?.handle
        ? {
            version: 1,
            targetAgent: task.targetAgent,
            toolName: remote.result.metadata.continuation.toolName
                || task.continuation?.toolName
                || '',
            handle: remote.result.metadata.continuation.handle,
        }
        : task.continuation;
    return ingestTaskEvent(workspaceDirectory, {
        task: {
            ...task,
            status: remoteStatus(remote?.status),
            remoteStatus: String(remote?.status || 'running'),
            updatedAt: remote?.updatedAt || new Date().toISOString(),
            error: String(remote?.error || ''),
            ...(continuation ? { continuation } : {}),
        },
        log: {
            tail: typeof remote?.logTail === 'string' ? remote.logTail : '',
            seq: Number.isFinite(Number(remote?.logSeq)) ? Number(remote.logSeq) : null,
            sourceId: task.remoteTaskId,
            truncated: remote?.logTruncated === true,
        },
        finalOutput: taskResultText(remote),
    });
}

export async function handleTaskRoute({
    pathname,
    req,
    res,
    parsedUrl,
    workspaceDirectory,
    renderTaskView,
    appState,
}) {
    if (pathname === '/tasks' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, tasks: listTasks(workspaceDirectory) });
        return true;
    }

    const match = /^\/tasks\/(task_[0-9a-f]{24})\/log$/.exec(pathname);
    if (match && req.method === 'GET') {
        try {
            const log = readTaskLog(workspaceDirectory, match[1], parsedUrl.searchParams.get('offset'));
            sendJson(res, 200, { ok: true, ...log });
        } catch (error) {
            sendJson(res, 400, { ok: false, error: error?.message || 'invalid_task_log' });
        }
        return true;
    }

    const continueMatch = /^\/tasks\/(task_[0-9a-f]{24})\/continue$/.exec(pathname);
    if (continueMatch && req.method === 'POST') {
        try {
            const task = getTask(workspaceDirectory, continueMatch[1]);
            if (!task) throw Object.assign(new Error('task_not_found'), { status: 404 });
            if (!TERMINAL_STATUSES.has(task.status)) {
                throw Object.assign(new Error('task_not_terminal'), { status: 409 });
            }
            if (!task.continuation?.handle) {
                throw Object.assign(new Error('task_not_continuable'), { status: 409 });
            }
            if (task.continuation.targetAgent !== task.targetAgent) {
                throw Object.assign(new Error('invalid_continuation_target'), { status: 409 });
            }
            const body = await readJsonBody(req);
            const message = typeof body?.message === 'string' ? body.message.trim() : '';
            if (!message) throw Object.assign(new Error('continuation_message_required'), { status: 400 });
            const resolved = await ensureContinuationAgentRoute(task.continuation.targetAgent);
            if (!resolved) {
                throw Object.assign(new Error('continuation_agent_unavailable'), { status: 409 });
            }
            const result = await invokeAuthenticatedAgentTool({
                req,
                route: resolved.route,
                agentName: resolved.agentName,
                toolName: task.continuation.toolName,
                arguments: {
                    handle: task.continuation.handle,
                    prompt: message,
                },
            });
            const remoteTaskId = String(result?.metadata?.taskId || '').trim();
            if (!remoteTaskId) {
                throw Object.assign(new Error('continuation_did_not_start_task'), { status: 502 });
            }
            const next = beginTaskContinuation(workspaceDirectory, task.id, {
                remoteTaskId,
                message,
                updatedAt: result?.metadata?.updatedAt,
            });
            const update = { task: next };
            broadcastTaskUpdate(appState, workspaceDirectory, update);
            sendJson(res, 202, { ok: true, ...update });
        } catch (error) {
            sendJson(res, error?.status || 500, {
                ok: false,
                error: error?.message || 'task_continuation_failed',
            });
        }
        return true;
    }

    const stopMatch = /^\/tasks\/(task_[0-9a-f]{24})\/stop$/.exec(pathname);
    if (stopMatch && req.method === 'POST') {
        try {
            const task = getTask(workspaceDirectory, stopMatch[1]);
            if (!task) throw Object.assign(new Error('task_not_found'), { status: 404 });
            if (task.status !== 'ongoing') {
                throw Object.assign(new Error('task_not_running'), { status: 409 });
            }
            const resolved = resolveAgentRoute(task.targetAgent);
            if (!resolved?.route?.hostPort) {
                throw Object.assign(new Error('task_agent_unavailable'), { status: 409 });
            }
            const remote = await cancelAuthenticatedAgentTask({
                req,
                route: resolved.route,
                agentName: resolved.agentName,
                taskId: task.remoteTaskId,
            });
            const update = ingestRemoteTask(workspaceDirectory, task, remote);
            broadcastTaskUpdate(appState, workspaceDirectory, update);
            sendJson(res, 202, { ok: true, ...update });
        } catch (error) {
            sendJson(res, error?.status || 500, {
                ok: false,
                error: error?.message || 'task_stop_failed',
            });
        }
        return true;
    }

    const refreshMatch = /^\/tasks\/(task_[0-9a-f]{24})\/refresh$/.exec(pathname);
    if (refreshMatch && req.method === 'GET') {
        try {
            const task = getTask(workspaceDirectory, refreshMatch[1]);
            if (!task) throw Object.assign(new Error('task_not_found'), { status: 404 });
            if (task.status !== 'ongoing') {
                sendJson(res, 200, { ok: true, task });
                return true;
            }
            const resolved = await ensureContinuationAgentRoute(
                task.continuation?.targetAgent || task.targetAgent,
            );
            if (!resolved) {
                throw Object.assign(new Error('continuation_agent_unavailable'), { status: 409 });
            }
            const remote = await readAuthenticatedAgentTask({
                req,
                route: resolved.route,
                agentName: resolved.agentName,
                taskId: task.remoteTaskId,
            });
            const update = ingestRemoteTask(workspaceDirectory, task, remote);
            broadcastTaskUpdate(appState, workspaceDirectory, update);
            sendJson(res, 200, { ok: true, ...update });
        } catch (error) {
            sendJson(res, error?.status || 500, {
                ok: false,
                error: error?.message || 'task_refresh_failed',
            });
        }
        return true;
    }

    const viewMatch = /^\/tasks\/(task_[0-9a-f]{24})\/view$/.exec(pathname);
    if (viewMatch && req.method === 'GET') {
        const html = typeof renderTaskView === 'function' ? renderTaskView(viewMatch[1]) : '';
        if (!html) {
            sendHtml(res, 404, 'Task view unavailable.');
            return true;
        }
        sendHtml(res, 200, html);
        return true;
    }
    return false;
}

export const __testables = {
    MAX_CONTINUATION_MESSAGE_BYTES,
    ensureContinuationAgentRoute,
    remoteStatus,
    resolveAgentRoute,
    ingestRemoteTask,
    taskResultText,
};
