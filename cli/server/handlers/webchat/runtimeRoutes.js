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
    writeOrBufferSseEvent
} from './runtimeState.js';

const MAX_INTERACTION_RESPONSE_BYTES = 16 * 1024;
const INTERACTION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
        if (!sid || !tabId) { res.writeHead(400); return res.end(); }

        const runtimes = getRuntimeMap(appState);
        const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, agentQuery);
        let tab = runtimes.get(runtimeKey);

        if (tab && !isRuntimeWritable(tab)) {
            disposeUnavailableRuntime(tab, runtimeKey, runtimes);
            tab = null;
        }

        if (!tab && runtimes.size >= 20) {
            res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '30' });
            return res.end('Server at capacity. Please try again later.');
        }
        if (!tab && !effectiveConfig.ttyFactory) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            return res.end(effectiveConfig.unavailableReason || 'WebChat is not available for this agent.');
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
                    pid: tty.pid || null,
                    cleanupTimer: null,
                    ttyClosed: false,
                    runtimeKey,
                    workspaceDirectory,
                    webchatSessionSnapshot: null,
                    liveMessageCount: 0,
                    webchatTasks: new Map(),
                    taskProtocolBuffer: ''
                };
                runtimes.set(runtimeKey, tab);

                tty.onOutput((data) => {
                    routeWorkspaceRuntimeOutput(appState, tab, data);
                });
                tty.onClose(() => {
                    writeOrBufferSseEvent(tab, 'event: close\ndata: {}\n\n');
                    tab.ttyClosed = true;
                    tab.tty = null;
                    disposeTab(tab, runtimeKey, { runtimes });
                });
            } catch (error) {
                console.error(`[webchat] Failed to create folder session runtime: ${error?.message || error}`);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                return res.end(`Failed to create chat session: ${error?.message || error}`);
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

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache',
            'x-accel-buffering': 'no',
            'alt-svc': 'clear'
        });
        res.write(': connected\n\n');
        const connectionId = crypto.randomUUID();
        tab.subscribers.set(connectionId, { res, sid, tabId });
        const runtimeStateSnapshot = serializeRuntimeStateSseEvent(tab.webchatRuntimeState);
        if (runtimeStateSnapshot) res.write(runtimeStateSnapshot);
        const sessionStateSnapshot = serializeSessionStateSseEvent(tab.webchatSessionSnapshot);
        if (sessionStateSnapshot) res.write(sessionStateSnapshot);
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
            console.log(`[webchat] Client ${tabId} disconnected from folder runtime, tty pid=${tab.pid || tab.tty?.pid}`);
            if (tab.subscribers.size === 0) {
                scheduleDisconnectedTabCleanup(tab, runtimeKey, { runtimes });
            }
        });
        return;
    }

    if (pathname === '/input' && req.method === 'POST') {
        const tabId = String(parsedUrl.searchParams.get('tabId') || '').trim();
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
        const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, agentQuery);
        const runtimes = getRuntimeMap(appState);
        const tab = runtimes.get(runtimeKey);
        const ownsSubscriber = tab?.subscribers instanceof Map
            && [...tab.subscribers.values()].some((subscriber) => subscriber.sid === sid && subscriber.tabId === tabId);
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
            const pending = tab.pendingInteraction;
            if (!INTERACTION_TOKEN_RE.test(interactionId) || !INTERACTION_TOKEN_RE.test(optionId)) {
                res.writeHead(400); res.end('Invalid interaction response.');
                return;
            }
            if (!pending || pending.id !== interactionId) {
                res.writeHead(409); res.end('Interaction is no longer pending.');
                return;
            }
            if (!pending.options.some((option) => option.id === optionId)) {
                res.writeHead(400); res.end('Unknown interaction option.');
                return;
            }
            if (!writeRuntimeInput(tab, `${JSON.stringify({
                    __webchatInteractionResponse: 1,
                    version: 1,
                    id: interactionId,
                    optionId,
                })}\n`)) {
                disposeUnavailableRuntime(tab, runtimeKey, runtimes);
                res.writeHead(409); res.end('Session runtime unavailable.');
                return;
            }
            tab.pendingInteraction = null;
            const resolution = { id: interactionId, optionId, status: 'submitted' };
            writeOrBufferSseEvent(tab, serializeInteractionResolvedSseEvent(resolution));
            res.writeHead(204); res.end();
        });
        return;
    }

    throw new Error(`unsupported_webchat_runtime_route:${pathname}`);
}
