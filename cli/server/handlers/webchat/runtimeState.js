import crypto from 'crypto';

import {
    appendAssistantProgress,
    appendSessionMessage,
    appendToAssistantMessage,
    buildContinuationHistory,
    formatContinuationContext,
    insertSessionTaskItem,
    loadSession,
    summarizeSession
} from '../../webchat/sessionStore.js';
import { hasOngoingTask, ingestTaskEvent } from '../../webchat/taskStore.js';

const STREAM_RECONNECT_GRACE_MS = 120000;
const MAX_PENDING_SSE_EVENTS = 200;
const MAX_RUNTIME_MODEL_LENGTH = 256;
const RUNTIME_INSTANCE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROCESS_PREFIX_RE = /^(?:\s*\.+\s*){3,}/;
const WEBCHAT_RUNTIME_STATE_FLAG = '__webchatRuntimeState';
const WEBCHAT_INTERACTION_FLAG = '__webchatInteraction';
const WEBCHAT_INTERACTION_RESOLVED_FLAG = '__webchatInteractionResolved';
const INTERACTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INTERACTION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function stripCtrlAndAnsi(input) {
    try {
        let out = input || '';
        out = out.replace(/\u001b\][^\u0007\u001b]*?(?:\u0007|\u001b\\)/g, '');
        out = out.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        out = out.replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F]/g, '');
        return out;
    } catch (_) {
        return input;
    }
}

function isProcessingChunk(text) {
    if (!text) {
        return false;
    }
    const trimmed = text.replace(/\s/g, '');
    if (trimmed.length === 0 || !/^[.·…]+$/.test(trimmed)) {
        return false;
    }
    const hasWhitespace = /\s/.test(text);
    return hasWhitespace || trimmed.length > 3;
}

function stripProcessingPrefix(text) {
    if (!text) {
        return text;
    }
    const match = PROCESS_PREFIX_RE.exec(text);
    if (!match) {
        return text;
    }
    if (match[0].length >= text.length) {
        return '';
    }
    return text.slice(match[0].length);
}

function looksLikeReadlinePromptEcho(text, pendingClientText) {
    if (!text || !pendingClientText) {
        return false;
    }
    const trimmed = String(text).trim();
    const clientText = String(pendingClientText).trim();
    if (!clientText) {
        return false;
    }
    return trimmed.startsWith('you> ')
        && trimmed.slice(5).trim() === clientText;
}

function looksLikeEnvelopeEcho(text) {
    const normalized = String(text || '').trim();
    return normalized.includes('"__webchatMessage"')
        && normalized.includes('"version"')
        && normalized.includes('"text"')
        && normalized.includes('"attachments"');
}

function looksLikeProgressEnvelope(text) {
    const normalized = String(text || '').trim();
    if (!normalized.includes('"__webchatProgress"')) {
        return false;
    }
    try {
        const parsed = JSON.parse(normalized);
        return Boolean(parsed && parsed.__webchatProgress);
    } catch (_) {
        return true;
    }
}

function progressReasonFromEnvelope(text) {
    const normalized = String(text || '').trim();
    if (!normalized.includes('"__webchatProgress"')) return '';
    try {
        const parsed = JSON.parse(normalized);
        if (!parsed?.__webchatProgress) return '';
        return typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    } catch (_) {
        return '';
    }
}


function handleWorkspaceAssistantLine(tab, rawLine) {
    if (!tab?.workspaceHistory) return;
    const originalText = typeof rawLine === 'string' ? rawLine : String(rawLine || '');
    if (!originalText || isProcessingChunk(originalText)) return;
    const stripped = stripProcessingPrefix(originalText);
    const normalized = stripped.trim();
    if (!normalized || looksLikeEnvelopeEcho(normalized)) return;
    if (looksLikeProgressEnvelope(normalized)) {
        const reason = progressReasonFromEnvelope(normalized);
        if (reason && Number.isInteger(tab.workspaceHistory.lastAssistantMessageIndex)) {
            try {
                appendAssistantProgress(
                    tab.workspaceHistory.workspaceDirectory,
                    tab.workspaceHistory.sessionId,
                    tab.workspaceHistory.lastAssistantMessageIndex,
                    reason
                );
            } catch (_) {
                // Folder history capture must never break the live process.
            }
        }
        return;
    }
    const pendingEcho = String(tab.workspaceHistory.lastClientText || '').trim();
    if (pendingEcho && looksLikeReadlinePromptEcho(normalized, pendingEcho)) {
        tab.workspaceHistory.lastClientText = '';
        return;
    }

    const workspaceHistory = tab.workspaceHistory;
    try {
        if (!workspaceHistory.userInputSent && Number.isInteger(workspaceHistory.lastAssistantMessageIndex)) {
            appendToAssistantMessage(
                workspaceHistory.workspaceDirectory,
                workspaceHistory.sessionId,
                workspaceHistory.lastAssistantMessageIndex,
                stripped
            );
        } else {
            const appended = appendSessionMessage(
                workspaceHistory.workspaceDirectory,
                workspaceHistory.sessionId,
                { role: 'assistant', text: stripped }
            );
            workspaceHistory.lastAssistantMessageIndex = appended.messageIndex;
        }
        workspaceHistory.userInputSent = false;
    } catch (_) {
        // Folder history capture must never break the live process.
    }
}

export function captureWorkspaceHistoryOutput(tab, data) {
    const workspaceHistory = tab?.workspaceHistory;
    if (!workspaceHistory) return;
    workspaceHistory.buffer = String(workspaceHistory.buffer || '') + stripCtrlAndAnsi(String(data ?? ''));
    const lines = workspaceHistory.buffer.split(/\r?\n/);
    workspaceHistory.buffer = lines.pop() ?? '';
    for (const line of lines) handleWorkspaceAssistantLine(tab, line);
}

export function flushWorkspaceHistoryOutput(tab) {
    const workspaceHistory = tab?.workspaceHistory;
    if (!workspaceHistory?.buffer) return;
    const tail = stripCtrlAndAnsi(workspaceHistory.buffer);
    workspaceHistory.buffer = '';
    if (tail.trim() && !isProcessingChunk(tail)) {
        handleWorkspaceAssistantLine(tab, tail);
    }
}


function forceKillPid(pid, tabId) {
    if (!pid || typeof global.processKill !== 'function') {
        return;
    }
    setTimeout(() => {
        try {
            global.processKill(pid, 0);
            global.processKill(pid, 'SIGKILL');
            console.warn(`[webchat] Force killed lingering process ${pid} for tab ${tabId}`);
        } catch (_) {
            console.log(`[webchat] Process ${pid} already dead for tab ${tabId}`);
        }
    }, 2000);
}

function pushPendingSseEvent(tab, payload) {
    if (!tab || !payload) return;
    if (!Array.isArray(tab.pendingSseEvents)) {
        tab.pendingSseEvents = [];
    }
    tab.pendingSseEvents.push(String(payload));
    if (tab.pendingSseEvents.length > MAX_PENDING_SSE_EVENTS) {
        tab.pendingSseEvents.splice(0, tab.pendingSseEvents.length - MAX_PENDING_SSE_EVENTS);
    }
}

export function writeOrBufferSseEvent(tab, payload) {
    if (!tab || !payload) return;
    if (tab.subscribers instanceof Map) {
        for (const [connectionId, subscriber] of tab.subscribers.entries()) {
            try {
                subscriber.res.write(String(payload));
            } catch (_) {
                tab.subscribers.delete(connectionId);
            }
        }
        return;
    }
    if (tab.sseRes) {
        try {
            tab.sseRes.write(String(payload));
            return;
        } catch (_) {
            tab.sseRes = null;
        }
    }
    pushPendingSseEvent(tab, payload);
}

export function broadcastTaskUpdate(appState, workspaceDirectory, update) {
    if (!update?.task?.id) return;
    const payload = `event: task-update\ndata: ${JSON.stringify(update)}\n\n`;
    for (const runtime of getRuntimeMap(appState).values()) {
        if (runtime?.workspaceDirectory === workspaceDirectory) {
            writeOrBufferSseEvent(runtime, payload);
        }
    }
}

function normalizeRuntimeModel(value) {
    if (value === null) return null;
    if (typeof value !== 'string') return undefined;
    const model = value.trim();
    if (!model) return null;
    if (model.length > MAX_RUNTIME_MODEL_LENGTH || /[\u0000-\u001F\u007F]/.test(model)) {
        return undefined;
    }
    return model;
}

export function parseWebchatRuntimeState(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope[WEBCHAT_RUNTIME_STATE_FLAG]) {
        return undefined;
    }
    if (envelope.version !== 1) {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'model')) {
        return undefined;
    }
    const model = normalizeRuntimeModel(envelope.model);
    if (model === undefined) return undefined;
    if (!Object.prototype.hasOwnProperty.call(envelope, 'runtimeInstanceId')) {
        return { model };
    }
    const runtimeInstanceId = typeof envelope.runtimeInstanceId === 'string'
        ? envelope.runtimeInstanceId.trim()
        : '';
    if (!RUNTIME_INSTANCE_ID_RE.test(runtimeInstanceId)) return undefined;
    return { model, runtimeInstanceId };
}

export function serializeRuntimeStateSseEvent(state) {
    const model = normalizeRuntimeModel(state?.model);
    if (model === undefined) return '';
    return `event: runtime-state\ndata: ${JSON.stringify({ model })}\n\n`;
}

function restoreContinuationAfterRuntimeReplacement(tab, nextState) {
    const previousRuntimeInstanceId = tab?.webchatRuntimeState?.runtimeInstanceId;
    const nextRuntimeInstanceId = nextState?.runtimeInstanceId;
    if (!previousRuntimeInstanceId
        || !nextRuntimeInstanceId
        || previousRuntimeInstanceId === nextRuntimeInstanceId) {
        return;
    }
    try {
        const session = loadSession(tab.workspaceDirectory, tab.sessionId);
        const continuationHistory = buildContinuationHistory(session);
        tab.continuationHistory = continuationHistory;
        tab.continuationContext = formatContinuationContext(session);
        tab.continuationPending = continuationHistory.length > 0;
        tab.pendingInteraction = null;
    } catch (error) {
        console.warn(`[webchat] Unable to restore history after runtime replacement: ${error?.message || error}`);
    }
}

function normalizeInteractionText(value, maxLength, { required = false } = {}) {
    if (typeof value !== 'string' || value.includes('\0')) return required ? undefined : '';
    const text = value.trim();
    if ((required && !text) || text.length > maxLength) return undefined;
    return text;
}

export function parseWebchatInteraction(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope[WEBCHAT_INTERACTION_FLAG]) return undefined;
    if (envelope.version !== 1) return undefined;
    const id = normalizeInteractionText(envelope.id, 128, { required: true });
    const kind = normalizeInteractionText(envelope.kind, 64, { required: true });
    const title = normalizeInteractionText(envelope.title, 120, { required: true });
    const message = normalizeInteractionText(envelope.message, 1000);
    const detail = normalizeInteractionText(envelope.detail, 4000);
    if (!id || !INTERACTION_ID_RE.test(id) || !kind || !INTERACTION_TOKEN_RE.test(kind) || !title) return undefined;
    if (message === undefined || detail === undefined) return undefined;
    if (!Array.isArray(envelope.options) || envelope.options.length < 1 || envelope.options.length > 8) return undefined;
    const seen = new Set();
    const options = [];
    for (const raw of envelope.options) {
        const optionId = normalizeInteractionText(raw?.id, 64, { required: true });
        const label = normalizeInteractionText(raw?.label, 100, { required: true });
        if (!optionId || !INTERACTION_TOKEN_RE.test(optionId) || !label || seen.has(optionId)) return undefined;
        seen.add(optionId);
        options.push({
            id: optionId,
            label,
            tone: raw?.tone === 'danger' ? 'danger' : 'default',
        });
    }
    const requestedDefault = normalizeInteractionText(envelope.defaultOptionId, 64);
    const defaultOptionId = seen.has(requestedDefault) ? requestedDefault : options[0].id;
    return { id, kind, title, message, detail, options, defaultOptionId };
}

export function parseWebchatInteractionResolved(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope[WEBCHAT_INTERACTION_RESOLVED_FLAG]) return undefined;
    if (envelope.version !== 1) return undefined;
    const id = normalizeInteractionText(envelope.id, 128, { required: true });
    const optionId = envelope.optionId === null ? null : normalizeInteractionText(envelope.optionId, 64);
    const status = normalizeInteractionText(envelope.status, 64, { required: true });
    if (!id || !INTERACTION_ID_RE.test(id) || !status || !INTERACTION_TOKEN_RE.test(status)) return undefined;
    if (optionId !== null && (!optionId || !INTERACTION_TOKEN_RE.test(optionId))) return undefined;
    return { id, optionId, status };
}

export function serializeInteractionRequestSseEvent(interaction) {
    const normalized = parseWebchatInteraction({ [WEBCHAT_INTERACTION_FLAG]: 1, version: 1, ...interaction });
    return normalized ? `event: interaction-request\ndata: ${JSON.stringify(normalized)}\n\n` : '';
}

export function serializeInteractionResolvedSseEvent(resolution) {
    const normalized = parseWebchatInteractionResolved({
        [WEBCHAT_INTERACTION_RESOLVED_FLAG]: 1,
        version: 1,
        ...resolution,
    });
    return normalized ? `event: interaction-resolved\ndata: ${JSON.stringify(normalized)}\n\n` : '';
}

export function getRuntimeMap(appState) {
    if (!(appState.runtimes instanceof Map)) appState.runtimes = new Map();
    return appState.runtimes;
}

export function buildRuntimeKey(workspaceDirectory, sessionId, effectiveConfig, agentQuery = '') {
    const agent = String(effectiveConfig?.agentName || effectiveConfig?.displayName || 'webchat').trim();
    const launchSignature = crypto.createHash('sha256').update(String(agentQuery || '')).digest('hex').slice(0, 16);
    return `${workspaceDirectory}\0${sessionId}\0${agent}\0${launchSignature}`;
}

export function broadcastWorkspaceSessionChange(appState, workspaceDirectory, session) {
    const payload = `event: session-changed\ndata: ${JSON.stringify({ session: summarizeSession(session) })}\n\n`;
    for (const runtime of getRuntimeMap(appState).values()) {
        if (runtime.workspaceDirectory === workspaceDirectory) {
            writeOrBufferSseEvent(runtime, payload);
        }
    }
}

export function broadcastWorkspaceRuntimeEvent(appState, workspaceDirectory, sessionId, payload) {
    for (const runtime of getRuntimeMap(appState).values()) {
        if (runtime.workspaceDirectory === workspaceDirectory && runtime.sessionId === sessionId) {
            writeOrBufferSseEvent(runtime, payload);
        }
    }
}

export function broadcastWorkspaceTaskEvent(appState, workspaceDirectory, payload) {
    for (const runtime of getRuntimeMap(appState).values()) {
        if (runtime.workspaceDirectory === workspaceDirectory) {
            writeOrBufferSseEvent(runtime, payload);
        }
    }
}

function routeCompleteOutputLine(appState, tab, line) {
    const normalized = stripCtrlAndAnsi(String(line || '')).trim();
    const pendingClientText = String(tab?.workspaceHistory?.lastClientText || '').trim();
    if (pendingClientText && looksLikeReadlinePromptEcho(normalized, pendingClientText)) {
        tab.workspaceHistory.lastClientText = '';
        return;
    }
    if (normalized.includes(`"${WEBCHAT_INTERACTION_FLAG}"`)) {
        try {
            const interaction = parseWebchatInteraction(JSON.parse(normalized));
            if (interaction) {
                tab.pendingInteraction = interaction;
                writeOrBufferSseEvent(tab, serializeInteractionRequestSseEvent(interaction));
                return;
            }
        } catch (_) {
            // Invalid interaction envelopes fall through as ordinary agent output.
        }
    }
    if (normalized.includes(`"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`)) {
        try {
            const resolution = parseWebchatInteractionResolved(JSON.parse(normalized));
            if (resolution) {
                if (tab.pendingInteraction?.id === resolution.id) tab.pendingInteraction = null;
                writeOrBufferSseEvent(tab, serializeInteractionResolvedSseEvent(resolution));
                return;
            }
        } catch (_) {
            // Invalid interaction resolution envelopes fall through as ordinary agent output.
        }
    }
    if (normalized.includes(`"${WEBCHAT_RUNTIME_STATE_FLAG}"`)) {
        try {
            const envelope = JSON.parse(normalized);
            if (envelope?.[WEBCHAT_RUNTIME_STATE_FLAG]) {
                const runtimeState = parseWebchatRuntimeState(envelope);
                if (runtimeState !== undefined) {
                    restoreContinuationAfterRuntimeReplacement(tab, runtimeState);
                    tab.webchatRuntimeState = runtimeState;
                    writeOrBufferSseEvent(tab, serializeRuntimeStateSseEvent(runtimeState));
                }
                return;
            }
        } catch (_) {
            // Invalid runtime-state envelopes fall through as ordinary agent output.
        }
    }
    if (normalized.includes('"__webchatTask"')) {
        try {
            const envelope = JSON.parse(normalized);
            if (envelope?.__webchatTask) {
                const update = ingestTaskEvent(tab.workspaceDirectory, envelope);
                let messageIndex = null;
                if (envelope.event === 'started' && Number.isInteger(tab.workspaceHistory?.lastAssistantMessageIndex)) {
                    try {
                        const inserted = insertSessionTaskItem(
                            tab.workspaceHistory.workspaceDirectory,
                            tab.workspaceHistory.sessionId,
                            tab.workspaceHistory.lastAssistantMessageIndex,
                            update.task.id,
                        );
                        messageIndex = inserted.messageIndex;
                    } catch (_) {
                        messageIndex = null;
                    }
                }
                if (!(tab.backgroundTaskIds instanceof Set)) tab.backgroundTaskIds = new Set();
                tab.backgroundTaskIds.add(update.task.id);
                broadcastWorkspaceTaskEvent(
                    appState,
                    tab.workspaceDirectory,
                    `event: task-update\ndata: ${JSON.stringify({
                        ...update,
                        ...(messageIndex !== null ? {
                            sessionId: tab.workspaceHistory.sessionId,
                            messageIndex,
                        } : {}),
                    })}\n\n`,
                );
                return;
            }
        } catch (_) {
            // Invalid task envelopes fall through as ordinary agent output.
        }
    }
    captureWorkspaceHistoryOutput(tab, line);
    broadcastWorkspaceRuntimeEvent(
        appState,
        tab.workspaceDirectory,
        tab.sessionId,
        `data: ${JSON.stringify(line)}\n\n`,
    );
}

export function routeWorkspaceRuntimeOutput(appState, tab, data) {
    const text = String(data ?? '');
    if (!text) return;
    let pending = String(tab.taskProtocolBuffer || '') + text;
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex + 1);
        pending = pending.slice(newlineIndex + 1);
        routeCompleteOutputLine(appState, tab, line);
        newlineIndex = pending.indexOf('\n');
    }

    const trimmed = stripCtrlAndAnsi(pending).trimStart();
    const isTaskProtocol = '{"__webchatTask"'.startsWith(trimmed) || trimmed.includes('"__webchatTask"');
    const isRuntimeStateProtocol = `{"${WEBCHAT_RUNTIME_STATE_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_RUNTIME_STATE_FLAG}"`);
    const isInteractionProtocol = `{"${WEBCHAT_INTERACTION_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_INTERACTION_FLAG}"`)
        || `{"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`);
    if (trimmed.startsWith('{') && (isTaskProtocol || isRuntimeStateProtocol || isInteractionProtocol)) {
        tab.taskProtocolBuffer = pending;
        return;
    }
    tab.taskProtocolBuffer = '';
    if (pending) routeCompleteOutputLine(appState, tab, pending);
}

export function flushPendingSseEvents(tab) {
    if (!tab?.sseRes || !Array.isArray(tab.pendingSseEvents) || tab.pendingSseEvents.length === 0) {
        return;
    }
    const pending = tab.pendingSseEvents.splice(0);
    for (const payload of pending) {
        try {
            tab.sseRes.write(payload);
        } catch (_) {
            pushPendingSseEvent(tab, payload);
            tab.sseRes = null;
            return;
        }
    }
}

export function hasRuntimeBackgroundTasks(tab) {
    const taskIds = tab?.backgroundTaskIds instanceof Set ? [...tab.backgroundTaskIds] : [];
    if (!tab?.workspaceDirectory || taskIds.length === 0) return false;
    return hasOngoingTask(tab.workspaceDirectory, taskIds);
}

export function scheduleDisconnectedTabCleanup(tab, tabId, session, graceMs = STREAM_RECONNECT_GRACE_MS) {
    if (!tab || tab.disposed) return;
    if (tab.cleanupTimer) {
        clearTimeout(tab.cleanupTimer);
        tab.cleanupTimer = null;
    }
    tab.cleanupTimer = setTimeout(() => {
        const hasSubscribers = tab.subscribers instanceof Map ? tab.subscribers.size > 0 : Boolean(tab.sseRes);
        if (hasSubscribers || tab.disposed) return;
        try {
            if (hasRuntimeBackgroundTasks(tab)) {
                scheduleDisconnectedTabCleanup(tab, tabId, session, graceMs);
                return;
            }
        } catch (error) {
            console.warn(`[webchat] Unable to inspect background tasks for ${tabId}: ${error?.message || error}`);
        }
        console.log(`[webchat] Reconnect grace expired for session ${tab.sessionId || tabId}; disposing TTY.`);
        disposeTab(tab, tabId, session);
    }, Math.max(1000, Number(graceMs) || STREAM_RECONNECT_GRACE_MS));
    tab.cleanupTimer.unref?.();
}

export function disposeTab(tab, tabId, session) {
    if (!tab) {
        return;
    }
    const pid = tab.pid || tab.tty?.pid;
    if (tab.disposed) {
        if (session?.runtimes instanceof Map) session.runtimes.delete(tabId);
        if (session?.tabs instanceof Map) {
            session.tabs.delete(tabId);
        }
        return;
    }
    tab.disposed = true;

    if (tab.taskProtocolBuffer) {
        const pendingProtocol = stripCtrlAndAnsi(tab.taskProtocolBuffer).trimStart();
        const isControlEnvelope = pendingProtocol.includes('"__webchatTask"')
            || pendingProtocol.includes(`"${WEBCHAT_RUNTIME_STATE_FLAG}"`)
            || pendingProtocol.includes(`"${WEBCHAT_INTERACTION_FLAG}"`)
            || pendingProtocol.includes(`"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`);
        if (!isControlEnvelope) captureWorkspaceHistoryOutput(tab, tab.taskProtocolBuffer);
        tab.taskProtocolBuffer = '';
    }

    if (tab.cleanupTimer) {
        clearTimeout(tab.cleanupTimer);
        tab.cleanupTimer = null;
    }

    if (tab.tty) {
        flushWorkspaceHistoryOutput(tab);
        console.log(`[webchat] Disposing TTY for session ${tab.sessionId || tabId}`);
        if (typeof tab.tty.dispose === 'function') {
            try {
                tab.tty.dispose();
                console.log(`[webchat] dispose() called for pid ${pid}`);
            } catch (error) {
                console.error(`[webchat] dispose error: ${error?.message}`);
            }
        } else if (typeof tab.tty.kill === 'function') {
            try {
                tab.tty.kill();
                console.log(`[webchat] kill() called for pid ${pid}`);
            } catch (error) {
                console.error(`[webchat] kill error: ${error?.message}`);
            }
        }
        tab.tty = null;
        forceKillPid(pid, tabId);
    }

    if (tab.subscribers instanceof Map) {
        for (const subscriber of tab.subscribers.values()) {
            try { subscriber.res.end(); } catch (_) { }
        }
        tab.subscribers.clear();
    }
    if (tab.sseRes) {
        try {
            tab.sseRes.end();
        } catch (_) {
            // Ignore disconnect write failures
        }
    }
    tab.sseRes = null;

    if (session?.runtimes instanceof Map) session.runtimes.delete(tabId);
    if (session?.tabs instanceof Map) {
        session.tabs.delete(tabId);
    }

}
