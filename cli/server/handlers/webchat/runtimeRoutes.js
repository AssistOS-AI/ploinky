import crypto from 'crypto';

import { getSession } from './browserSession.js';
import {
    parseInputEnvelope,
    serializeWebchatEnvelopeForAgent,
    shouldForwardWebchatEnvelope
} from './messageEnvelope.js';
import {
    buildRuntimeKey,
    disposeTab,
    getRuntimeMap,
    scheduleDisconnectedTabCleanup,
    routeWorkspaceRuntimeOutput,
    serializeInteractionRequestSseEvent,
    serializeInteractionResolvedSseEvent,
    serializeRuntimeStateSseEvent,
    serializeSessionStateSseEvent,
    serializeSkillsStateSseEvent,
    serializeTaskListSseEvent,
    serializeWorkspaceFilesSseEvent,
    writeOrBufferSseEvent
} from './runtimeState.js';

const MAX_INTERACTION_RESPONSE_BYTES = 16 * 1024;
const INTERACTION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PAGE_INSTANCE_RE = /^[A-Za-z0-9_-]{1,128}$/;

function writeRuntimeAdmissionError(res, code, status = 503, extraHeaders = {}) {
    const stableCode = typeof code === 'string' && /^PLOINKY_[A-Z0-9_]+$/.test(code)
        ? code
        : 'PLOINKY_WEBCHAT_RUNTIME_UNAVAILABLE';
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...extraHeaders,
    });
    return res.end(JSON.stringify({ ok: false, error: stableCode }));
}

function pageInstanceIdFrom(parsedUrl) {
    const value = String(parsedUrl.searchParams.get('pageInstanceId') || '').trim();
    return PAGE_INSTANCE_RE.test(value) ? value : '';
}

function isRuntimeWritable(tab) {
    if (!tab?.tty) return false;
    try {
        return typeof tab.tty.isAlive !== 'function' || tab.tty.isAlive();
    } catch (_) {
        return false;
    }
}

function writeRuntimeInput(tab, data) {
    if (!isRuntimeWritable(tab)) return false;
    try {
        return tab.tty.write(data) !== false;
    } catch (_) {
        return false;
    }
}

function disposeUnavailableRuntime(tab, runtimeKey, runtimes) {
    if (!tab) return;
    tab.ttyClosed = true;
    disposeTab(tab, runtimeKey, { runtimes });
}

export function handleRuntimeRoute({
    pathname,
    req,
    res,
    parsedUrl,
    appState,
    workspaceDirectory,
    effectiveConfig,
    agentQuery
}) {
    if (pathname === '/stream') {
        const sid = getSession(req, appState);
        const tabId = String(parsedUrl.searchParams.get('tabId') || '').trim();
        const pageInstanceId = pageInstanceIdFrom(parsedUrl);
        if (!sid || !tabId) { res.writeHead(400); return res.end(); }

        const runtimes = getRuntimeMap(appState);
        const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, agentQuery);
        let tab = runtimes.get(runtimeKey);

        if (tab && !isRuntimeWritable(tab)) {
            disposeUnavailableRuntime(tab, runtimeKey, runtimes);
            tab = null;
        }

        if (!tab && runtimes.size >= 20) {
            return writeRuntimeAdmissionError(
                res,
                'PLOINKY_WEBCHAT_RUNTIME_CAPACITY',
                503,
                { 'Retry-After': '30' },
            );
        }
        if (!tab && !effectiveConfig.ttyFactory) {
            return writeRuntimeAdmissionError(
                res,
                effectiveConfig.unavailableReason || 'PLOINKY_WEBCHAT_RUNTIME_UNAVAILABLE',
            );
        }

        if (!tab) {
            try {
                const ssoUser = req.user && req.authMode === 'sso' ? {
                    id: req.user.id,
                    username: req.user.username,
                    email: req.user.email,
                    roles: req.user.roles || [],
                    sessionId: req.sessionId || null
                } : null;
                const tty = effectiveConfig.ttyFactory.create(ssoUser);
                tab = {
                    tty,
                    subscribers: new Map(),
                    createdAt: Date.now(),
                    cleanupTimer: null,
                    ttyClosed: false,
                    runtimeKey,
                    workspaceDirectory,
                    webchatSessionSnapshot: null,
                    liveMessageCount: 0,
                    webchatTasks: new Map(),
                    webchatWorkspaceFiles: null,
                    webchatSkillsSnapshot: null,
                    taskProtocolBuffer: ''
                };
                runtimes.set(runtimeKey, tab);

                tty.onOutput((data) => {
                    routeWorkspaceRuntimeOutput(appState, tab, data);
                });
                tty.onClose(() => {
                    writeOrBufferSseEvent(tab, 'event: close\ndata: {}\n\n');
                    tab.ttyClosed = true;
                    disposeTab(tab, runtimeKey, { runtimes });
                });
            } catch (error) {
                console.error('[webchat] Failed to create folder session runtime.', {
                    code: typeof error?.code === 'string' ? error.code : 'PLOINKY_WEBCHAT_RUNTIME_START_FAILED',
                });
                return writeRuntimeAdmissionError(
                    res,
                    error?.code || 'PLOINKY_WEBCHAT_RUNTIME_START_FAILED',
                    Number.isInteger(error?.status) ? error.status : 500,
                );
            }
        }

        if (tab.cleanupTimer) {
            clearTimeout(tab.cleanupTimer);
            tab.cleanupTimer = null;
        }
        if (tab.ttyClosed) {
            disposeTab(tab, runtimeKey, { runtimes });
            res.writeHead(409); return res.end('Session runtime closed. Reconnect to create a new process.');
        }
        if (tab.subscribers.size >= 12) {
            res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '5' });
            return res.end('Too many clients connected to this folder session.');
        }

        const pending = tab.pendingInteraction;
        if (pageInstanceId && pending?.targetTabId === tabId
            && pending.targetPageInstanceId
            && pending.targetPageInstanceId !== pageInstanceId) {
            if (!writeRuntimeInput(tab, `${JSON.stringify({
                __webchatInteractionResponse: 1,
                version: 1,
                id: pending.id,
                cancelled: true,
            })}\n`)) {
                disposeUnavailableRuntime(tab, runtimeKey, runtimes);
                res.writeHead(409); return res.end('Session runtime unavailable.');
            }
            tab.pendingInteraction = null;
            writeOrBufferSseEvent(tab, serializeInteractionResolvedSseEvent({
                id: pending.id,
                optionId: null,
                status: 'cancelled',
            }));
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'x-accel-buffering': 'no',
            'alt-svc': 'clear'
        });
        res.write(': connected\n\n');
        const connectionId = crypto.randomUUID();
        tab.subscribers.set(connectionId, { res, sid, tabId, pageInstanceId });
        const runtimeStateSnapshot = serializeRuntimeStateSseEvent(tab.webchatRuntimeState);
        if (runtimeStateSnapshot) res.write(runtimeStateSnapshot);
        const sessionStateSnapshot = serializeSessionStateSseEvent(tab.webchatSessionSnapshot);
        if (sessionStateSnapshot) res.write(sessionStateSnapshot);
        const taskListSnapshot = serializeTaskListSseEvent(tab.webchatTasks);
        if (taskListSnapshot) res.write(taskListSnapshot);
        const workspaceFilesSnapshot = tab.webchatWorkspaceFiles
            ? serializeWorkspaceFilesSseEvent({
                indexVersion: tab.webchatWorkspaceFiles.indexVersion,
                reset: true,
                files: [...tab.webchatWorkspaceFiles.files].sort(),
            })
            : '';
        if (workspaceFilesSnapshot) res.write(workspaceFilesSnapshot);
        const skillsStateSnapshot = serializeSkillsStateSseEvent(tab.webchatSkillsSnapshot);
        if (skillsStateSnapshot) res.write(skillsStateSnapshot);
        const interactionSnapshot = serializeInteractionRequestSseEvent(tab.pendingInteraction);
        if (interactionSnapshot) res.write(interactionSnapshot);

        let keepaliveTimer = setInterval(() => {
            try { res.write(': keepalive\n\n'); } catch (_) { }
        }, 15000);
        keepaliveTimer.unref?.();

        req.on('close', () => {
            if (keepaliveTimer) clearInterval(keepaliveTimer);
            keepaliveTimer = null;
            tab.subscribers.delete(connectionId);
            console.log(`[webchat] Client ${tabId} disconnected from folder runtime, tty pid=${tab.tty?.pid || 'closed'}`);
            if (tab.subscribers.size === 0) {
                scheduleDisconnectedTabCleanup(tab, runtimeKey, { runtimes });
            }
        });
        return;
    }

    if (pathname === '/input' && req.method === 'POST') {
        const tabId = String(parsedUrl.searchParams.get('tabId') || '').trim();
        const pageInstanceId = pageInstanceIdFrom(parsedUrl);
        const runtimes = getRuntimeMap(appState);
        const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, agentQuery);
        const tab = runtimes.get(runtimeKey);
        if (!tabId || !isRuntimeWritable(tab)) {
            disposeUnavailableRuntime(tab, runtimeKey, runtimes);
            res.writeHead(409); return res.end('Session runtime unavailable. Reconnect to create a new process.');
        }
        if (tab.pendingInteraction) {
            res.writeHead(409); return res.end('Resolve the active interaction before sending another message.');
        }

        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            const envelope = parseInputEnvelope(body);
            const hasReferences = Array.isArray(envelope.references) && envelope.references.length > 0;
            const hasContent = String(envelope.text || '').trim()
                || (Array.isArray(envelope.attachments) && envelope.attachments.length)
                || hasReferences;
            const rawMessage = typeof envelope.text === 'string' ? envelope.text : body;
            const isSlashCommand = rawMessage.trimStart().startsWith('/');
            const isVisibleMessage = envelope.presentation?.visible !== false;
            const forwardEnvelope = shouldForwardWebchatEnvelope(parsedUrl, effectiveConfig);
            const text = forwardEnvelope
                ? serializeWebchatEnvelopeForAgent({
                    req,
                    effectiveConfig,
                    tabId,
                    pageInstanceId,
                    envelope,
                    fallbackText: rawMessage
                })
                : rawMessage;
            if (!writeRuntimeInput(tab, `${text}\n`)) {
                disposeUnavailableRuntime(tab, runtimeKey, runtimes);
                res.writeHead(409);
                res.end('Session runtime unavailable. Reconnect to create a new process.');
                return;
            }

            if (hasContent && (!isSlashCommand || isVisibleMessage)) {
                const messageIndex = Number.isInteger(tab.liveMessageCount)
                    ? tab.liveMessageCount
                    : null;
                tab.liveMessageCount = (messageIndex ?? 0) + 2;
                writeOrBufferSseEvent(tab, `event: user-message\ndata: ${JSON.stringify({
                    sourceTabId: tabId,
                    ...(messageIndex !== null ? { messageIndex } : {}),
                    message: {
                        role: 'user',
                        text: envelope.text,
                        timestamp: new Date().toISOString(),
                        attachments: envelope.attachments,
                        references: envelope.references,
                    },
                })}\n\n`);
            }

            res.writeHead(204); res.end();
        });
        return;
    }

    if (pathname === '/control' && req.method === 'POST') {
        const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, agentQuery);
        const runtimes = getRuntimeMap(appState);
        const tab = runtimes.get(runtimeKey);
        if (!isRuntimeWritable(tab)) {
            disposeUnavailableRuntime(tab, runtimeKey, runtimes);
            res.writeHead(409); return res.end();
        }
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            if (!writeRuntimeInput(tab, body)) {
                disposeUnavailableRuntime(tab, runtimeKey, runtimes);
                res.writeHead(409); res.end();
                return;
            }
            res.writeHead(204); res.end();
        });
        return;
    }

    if (pathname === '/interaction' && req.method === 'POST') {
        const sid = getSession(req, appState);
        const tabId = String(parsedUrl.searchParams.get('tabId') || '').trim();
        const pageInstanceId = pageInstanceIdFrom(parsedUrl);
        const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, agentQuery);
        const runtimes = getRuntimeMap(appState);
        const tab = runtimes.get(runtimeKey);
        const ownsSubscriber = tab?.subscribers instanceof Map
            && [...tab.subscribers.values()].some((subscriber) => subscriber.sid === sid
                && subscriber.tabId === tabId
                && (!pageInstanceId || subscriber.pageInstanceId === pageInstanceId));
        if (!sid || !tabId || !isRuntimeWritable(tab) || !ownsSubscriber) {
            if (tab && !isRuntimeWritable(tab)) {
                disposeUnavailableRuntime(tab, runtimeKey, runtimes);
            }
            res.writeHead(409); return res.end('Session runtime unavailable.');
        }
        let body = '';
        let tooLarge = false;
        req.on('data', (chunk) => {
            if (tooLarge) return;
            body += chunk.toString();
            if (Buffer.byteLength(body) > MAX_INTERACTION_RESPONSE_BYTES) {
                tooLarge = true;
                body = '';
            }
        });
        req.on('end', () => {
            if (tooLarge) {
                res.writeHead(413); res.end('Interaction response is too large.');
                return;
            }
            let payload;
            try {
                payload = JSON.parse(body);
            } catch (_) {
                res.writeHead(400); res.end('Invalid interaction response.');
                return;
            }
            const interactionId = typeof payload?.interactionId === 'string' ? payload.interactionId.trim() : '';
            const optionId = typeof payload?.optionId === 'string' ? payload.optionId.trim() : '';
            const response = typeof payload?.response === 'string' ? payload.response : null;
            const cancelled = payload?.cancelled === true;
            const pending = tab.pendingInteraction;
            const optionResponse = !cancelled && Boolean(optionId) && response === null;
            const inputResponse = !cancelled && !optionId && response !== null;
            const cancelResponse = cancelled && !optionId && response === null;
            if (!INTERACTION_TOKEN_RE.test(interactionId)
                || (!optionResponse && !inputResponse && !cancelResponse)
                || (optionResponse && !INTERACTION_TOKEN_RE.test(optionId))) {
                res.writeHead(400); res.end('Invalid interaction response.');
                return;
            }
            if (!pending || pending.id !== interactionId) {
                res.writeHead(409); res.end('Interaction is no longer pending.');
                return;
            }
            if (pending.targetPageInstanceId
                && pending.targetPageInstanceId !== pageInstanceId) {
                res.writeHead(409); res.end('Interaction belongs to another page instance.');
                return;
            }
            if (optionResponse && !pending.options.some((option) => option.id === optionId)) {
                res.writeHead(400); res.end('Unknown interaction option.');
                return;
            }
            if (inputResponse && (!pending.input || response.length > pending.input.maxLength)) {
                res.writeHead(400); res.end('Invalid interaction input.');
                return;
            }
            if (!writeRuntimeInput(tab, `${JSON.stringify({
                    __webchatInteractionResponse: 1,
                    version: 1,
                    id: interactionId,
                    ...(cancelResponse ? { cancelled: true } : (optionResponse ? { optionId } : { response })),
                })}\n`)) {
                disposeUnavailableRuntime(tab, runtimeKey, runtimes);
                res.writeHead(409); res.end('Session runtime unavailable.');
                return;
            }
            tab.pendingInteraction = null;
            const resolution = {
                id: interactionId,
                optionId: optionResponse ? optionId : null,
                status: cancelResponse ? 'cancelled' : 'submitted',
            };
            writeOrBufferSseEvent(tab, serializeInteractionResolvedSseEvent(resolution));
            res.writeHead(204); res.end();
        });
        return;
    }

    throw new Error(`unsupported_webchat_runtime_route:${pathname}`);
}
