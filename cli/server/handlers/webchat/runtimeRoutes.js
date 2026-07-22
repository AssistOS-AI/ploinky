import crypto from 'crypto';

import {
    appendSessionTurn,
    buildContinuationHistory,
    ensureCurrentSession,
    formatContinuationContext
} from '../../webchat/sessionStore.js';
import { getSession } from './browserSession.js';
import {
    parseInputEnvelope,
    serializeWebchatEnvelopeForAgent,
    shouldForwardWebchatEnvelope
} from './messageEnvelope.js';
import {
    broadcastWorkspaceRuntimeEvent,
    buildRuntimeKey,
    disposeTab,
    getRuntimeMap,
    scheduleDisconnectedTabCleanup,
    routeWorkspaceRuntimeOutput,
    serializeInteractionRequestSseEvent,
    serializeInteractionResolvedSseEvent,
    serializeRuntimeStateSseEvent,
    writeOrBufferSseEvent
} from './runtimeState.js';

const MAX_INTERACTION_RESPONSE_BYTES = 16 * 1024;
const INTERACTION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

        let currentSession;
        try {
            currentSession = ensureCurrentSession(workspaceDirectory);
        } catch (_) {
            res.writeHead(500); return res.end('Session store unavailable.');
        }
        const runtimes = getRuntimeMap(appState);
        const runtimeKey = buildRuntimeKey(workspaceDirectory, currentSession.sessionId, effectiveConfig, agentQuery);
        let tab = runtimes.get(runtimeKey);

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
                const continuationHistory = buildContinuationHistory(currentSession);
                const ssoUser = req.user && req.authMode === 'sso' ? {
                    id: req.user.id,
                    username: req.user.username,
                    email: req.user.email,
                    roles: req.user.roles || [],
                    sessionId: req.sessionId || null
                } : null;
                const tty = effectiveConfig.ttyFactory.create(ssoUser, {
                    hasHistory: currentSession.messages.length > 0
                });
                tab = {
                    tty,
                    subscribers: new Map(),
                    createdAt: Date.now(),
                    pid: tty.pid || null,
                    cleanupTimer: null,
                    ttyClosed: false,
                    runtimeKey,
                    sessionId: currentSession.sessionId,
                    workspaceDirectory,
                    continuationHistory,
                    continuationContext: formatContinuationContext(currentSession),
                    continuationPending: continuationHistory.length > 0,
                    workspaceHistory: {
                        workspaceDirectory,
                        sessionId: currentSession.sessionId,
                        buffer: '',
                        lastClientText: '',
                        userInputSent: false,
                        lastAssistantMessageIndex: null
                    },
                    backgroundTaskIds: new Set(),
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
        res.write(`: connected session=${currentSession.sessionId}\n\n`);
        const connectionId = crypto.randomUUID();
        tab.subscribers.set(connectionId, { res, sid, tabId });
        const runtimeStateSnapshot = serializeRuntimeStateSseEvent(tab.webchatRuntimeState);
        if (runtimeStateSnapshot) res.write(runtimeStateSnapshot);
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
            console.log(`[webchat] Client ${tabId} disconnected from folder session ${tab.sessionId}, tty pid=${tab.pid || tab.tty?.pid}`);
            if (tab.subscribers.size === 0) {
                scheduleDisconnectedTabCleanup(tab, runtimeKey, { runtimes });
            }
        });
        return;
    }

    if (pathname === '/input' && req.method === 'POST') {
        const tabId = String(parsedUrl.searchParams.get('tabId') || '').trim();
        let currentSession;
        try {
            currentSession = ensureCurrentSession(workspaceDirectory);
        } catch (_) {
            res.writeHead(500); return res.end('Session store unavailable.');
        }
        const runtimes = getRuntimeMap(appState);
        const runtimeKey = buildRuntimeKey(workspaceDirectory, currentSession.sessionId, effectiveConfig, agentQuery);
        const tab = runtimes.get(runtimeKey);
        if (!tab?.tty || !tabId) { res.writeHead(409); return res.end('Session runtime unavailable.'); }
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
            let appendedHistory = null;
            if (hasContent) {
                try {
                    appendedHistory = appendSessionTurn(workspaceDirectory, currentSession.sessionId, {
                        text: envelope.text,
                        attachments: envelope.attachments,
                        references: envelope.references
                    });
                    tab.workspaceHistory.lastClientText = String(envelope.text || '');
                    tab.workspaceHistory.userInputSent = false;
                    tab.workspaceHistory.lastAssistantMessageIndex = appendedHistory.assistantMessageIndex;
                    broadcastWorkspaceRuntimeEvent(appState, workspaceDirectory, currentSession.sessionId, `event: user-message\ndata: ${JSON.stringify({
                        sourceTabId: tabId,
                        messageIndex: appendedHistory.userMessageIndex,
                        message: appendedHistory.userMessage
                    })}\n\n`);
                } catch (_) { }
            }

            const rawMessage = typeof envelope.text === 'string' ? envelope.text : body;
            const shouldRestore = tab.continuationPending
                && rawMessage.trim()
                && !rawMessage.trimStart().startsWith('/');
            const forwardEnvelope = shouldForwardWebchatEnvelope(parsedUrl, effectiveConfig);
            const agentMessage = shouldRestore && !forwardEnvelope
                ? `${tab.continuationContext}\n\n[New user message]\n${rawMessage}`
                : rawMessage;
            if (shouldRestore) tab.continuationPending = false;
            const agentEnvelope = { ...envelope, text: agentMessage };
            if (shouldRestore && forwardEnvelope) {
                agentEnvelope.history = tab.continuationHistory;
            }
            const text = forwardEnvelope
                ? serializeWebchatEnvelopeForAgent({
                    req,
                    effectiveConfig,
                    tabId,
                    envelope: agentEnvelope,
                    fallbackText: agentMessage
                })
                : agentMessage;
            tab.tty.write(`${text}\n`);
            res.writeHead(204); res.end();
        });
        return;
    }

    if (pathname === '/control' && req.method === 'POST') {
        let currentSession;
        try {
            currentSession = ensureCurrentSession(workspaceDirectory);
        } catch (_) {
            res.writeHead(500); return res.end();
        }
        const runtimeKey = buildRuntimeKey(workspaceDirectory, currentSession.sessionId, effectiveConfig, agentQuery);
        const tab = getRuntimeMap(appState).get(runtimeKey);
        if (!tab?.tty) { res.writeHead(409); return res.end(); }
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { tab.tty.write(body); } catch (_) { }
            res.writeHead(204); res.end();
        });
        return;
    }

    if (pathname === '/interaction' && req.method === 'POST') {
        const sid = getSession(req, appState);
        const tabId = String(parsedUrl.searchParams.get('tabId') || '').trim();
        let currentSession;
        try {
            currentSession = ensureCurrentSession(workspaceDirectory);
        } catch (_) {
            res.writeHead(500); return res.end('Session store unavailable.');
        }
        const runtimeKey = buildRuntimeKey(workspaceDirectory, currentSession.sessionId, effectiveConfig, agentQuery);
        const tab = getRuntimeMap(appState).get(runtimeKey);
        const ownsSubscriber = tab?.subscribers instanceof Map
            && [...tab.subscribers.values()].some((subscriber) => subscriber.sid === sid && subscriber.tabId === tabId);
        if (!sid || !tabId || !tab?.tty || !ownsSubscriber) {
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
            try {
                tab.tty.write(`${JSON.stringify({
                    __webchatInteractionResponse: 1,
                    version: 1,
                    id: interactionId,
                    optionId,
                })}\n`);
            } catch (_) {
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
