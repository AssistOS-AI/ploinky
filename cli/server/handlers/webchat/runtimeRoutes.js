import crypto from 'crypto';

import {
    appendSessionTurn,
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
    serializeRuntimeStateSseEvent,
    writeOrBufferSseEvent
} from './runtimeState.js';

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
                    continuationContext: formatContinuationContext(currentSession),
                    continuationPending: currentSession.messages.length > 0,
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
            const agentMessage = shouldRestore
                ? `${tab.continuationContext}\n\n[New user message]\n${rawMessage}`
                : rawMessage;
            if (shouldRestore) tab.continuationPending = false;
            const agentEnvelope = { ...envelope, text: agentMessage };
            const text = shouldForwardWebchatEnvelope(parsedUrl, effectiveConfig)
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

    throw new Error(`unsupported_webchat_runtime_route:${pathname}`);
}
