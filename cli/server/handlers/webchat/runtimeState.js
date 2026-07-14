import crypto from 'crypto';

import {
    appendAssistantProgress,
    appendSessionMessage,
    appendToAssistantMessage,
    summarizeSession
} from '../../webchat/sessionStore.js';
import { hasOngoingTask, ingestTaskEvent } from '../../webchat/taskStore.js';

const STREAM_RECONNECT_GRACE_MS = 120000;
const MAX_PENDING_SSE_EVENTS = 200;
const PROCESS_PREFIX_RE = /^(?:\s*\.+\s*){3,}/;

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
    return trimmed === clientText
        || (trimmed.startsWith('you> ') && trimmed.slice(5).trim() === clientText);
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
    if (normalized.includes('"__webchatTask"')) {
        try {
            const envelope = JSON.parse(normalized);
            if (envelope?.__webchatTask) {
                const update = ingestTaskEvent(tab.workspaceDirectory, envelope);
                if (!(tab.backgroundTaskIds instanceof Set)) tab.backgroundTaskIds = new Set();
                tab.backgroundTaskIds.add(update.task.id);
                broadcastWorkspaceTaskEvent(
                    appState,
                    tab.workspaceDirectory,
                    `event: task-update\ndata: ${JSON.stringify(update)}\n\n`,
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
    if (trimmed.startsWith('{') && ('{"__webchatTask"'.startsWith(trimmed) || trimmed.includes('"__webchatTask"'))) {
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
        captureWorkspaceHistoryOutput(tab, tab.taskProtocolBuffer);
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
