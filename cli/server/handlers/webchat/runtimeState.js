import crypto from 'crypto';

const STREAM_RECONNECT_GRACE_MS = 120000;
const MAX_PENDING_SSE_EVENTS = 200;
const MAX_RUNTIME_MODEL_LENGTH = 256;
const WEBCHAT_RUNTIME_STATE_FLAG = '__webchatRuntimeState';
const WEBCHAT_SESSION_FLAG = '__webchatSession';
const WEBCHAT_INTERACTION_FLAG = '__webchatInteraction';
const WEBCHAT_INTERACTION_RESOLVED_FLAG = '__webchatInteractionResolved';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const TASK_CONTINUATION_HANDLE_RE = /^[A-Za-z0-9_-]{16,200}$/;
const TASK_TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,160}$/;
const INTERACTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INTERACTION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLOINKY_WORKSPACE_BANNER_RE = /^\[ploinky\]\s+using \.ploinky:\s+.+$/;
const TASK_STATUSES = new Set(['ongoing', 'finished', 'stopped', 'error']);

function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object' || !TASK_ID_RE.test(String(raw.id || ''))) return null;
    const continuationTarget = String(raw.continuation?.targetAgent || raw.targetAgent || '').trim().slice(0, 160);
    const continuationTool = String(raw.continuation?.toolName || '').trim();
    const continuationHandle = String(raw.continuation?.handle || '').trim();
    const continuation = raw.continuation?.version === 1
        && continuationTarget
        && TASK_TOOL_NAME_RE.test(continuationTool)
        && (!continuationHandle || TASK_CONTINUATION_HANDLE_RE.test(continuationHandle))
        ? {
            version: 1,
            targetAgent: continuationTarget,
            toolName: continuationTool,
            ...(continuationHandle ? { handle: continuationHandle } : {}),
        }
        : null;
    return {
        version: 1,
        id: String(raw.id),
        targetAgent: String(raw.targetAgent || '').slice(0, 160),
        remoteTaskId: String(raw.remoteTaskId || '').slice(0, 200),
        toolName: String(raw.toolName || '').slice(0, 160),
        description: String(raw.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        status: TASK_STATUSES.has(raw.status) ? raw.status : 'ongoing',
        remoteStatus: String(raw.remoteStatus || '').slice(0, 80),
        createdAt: normalizeTimestamp(raw.createdAt),
        updatedAt: normalizeTimestamp(raw.updatedAt),
        executionStartedAt: normalizeTimestamp(raw.executionStartedAt),
        turn: Number.isSafeInteger(raw.turn) && raw.turn > 0 ? raw.turn : 1,
        error: String(raw.error || '').slice(0, 1000),
        finalOutputOffset: Number.isSafeInteger(raw.finalOutputOffset) && raw.finalOutputOffset >= 0
            ? raw.finalOutputOffset
            : null,
        finalOutputLength: Number.isSafeInteger(raw.finalOutputLength) && raw.finalOutputLength > 0
            ? raw.finalOutputLength
            : 0,
        ...(raw.logRetention === 'full' ? { logRetention: 'full' } : {}),
        ...(continuation ? { continuation } : {}),
    };
}

export function parseWebchatTaskState(envelope) {
    if (!envelope || envelope.__webchatTask !== 1 || envelope.version !== 1) return undefined;
    if (envelope.event === 'list') {
        if (!Array.isArray(envelope.tasks)) return undefined;
        return { event: 'list', tasks: envelope.tasks.map(normalizeTask).filter(Boolean).slice(0, 1000) };
    }
    const task = normalizeTask(envelope.task);
    if (!task) return undefined;
    if (envelope.event === 'view') {
        const rawLog = envelope.log && typeof envelope.log === 'object' ? envelope.log : {};
        return {
            event: 'view',
            task,
            log: {
                text: typeof rawLog.text === 'string' ? rawLog.text : '',
                nextOffset: Math.max(0, Number(rawLog.nextOffset) || 0),
                reset: rawLog.reset === true,
            },
        };
    }
    return {
        event: String(envelope.event || 'update').slice(0, 32),
        task,
        ...(typeof envelope.logAppend === 'string' ? { logAppend: envelope.logAppend } : {}),
        ...(Number.isFinite(Number(envelope.logOffset)) ? { logOffset: Number(envelope.logOffset) } : {}),
        ...(envelope.action ? { action: String(envelope.action).slice(0, 32), ok: envelope.ok === true } : {}),
        ...(typeof envelope.error === 'string' ? { error: envelope.error.slice(0, 1000) } : {}),
    };
}

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
    return { model };
}

export function serializeRuntimeStateSseEvent(state) {
    const model = normalizeRuntimeModel(state?.model);
    if (model === undefined) return '';
    return `event: runtime-state\ndata: ${JSON.stringify({ model })}\n\n`;
}

function normalizeSessionId(value) {
    const sessionId = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return SESSION_ID_RE.test(sessionId) ? sessionId : '';
}

function normalizeTimestamp(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
}

function normalizeSessionSummary(raw) {
    const sessionId = normalizeSessionId(raw?.sessionId);
    const createdAt = normalizeTimestamp(raw?.createdAt);
    const updatedAt = normalizeTimestamp(raw?.updatedAt);
    if (!sessionId || !createdAt || !updatedAt) return null;
    return {
        sessionId,
        preview: typeof raw.preview === 'string' ? raw.preview.slice(0, 256) : 'New session',
        createdAt,
        updatedAt,
        hasHistory: raw.hasHistory === true,
    };
}

function normalizeSessionMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'task') {
        const taskId = typeof raw.taskId === 'string' ? raw.taskId.trim() : '';
        return TASK_ID_RE.test(taskId) ? { type: 'task', taskId } : null;
    }
    const role = raw.role === 'user' ? 'user' : (raw.role === 'assistant' ? 'assistant' : '');
    if (!role) return null;
    const timestamp = normalizeTimestamp(raw.timestamp);
    const message = {
        role,
        text: typeof raw.text === 'string' ? raw.text : '',
        ...(timestamp ? { timestamp } : {}),
        attachments: Array.isArray(raw.attachments) ? raw.attachments.slice(0, 64) : [],
        references: Array.isArray(raw.references) ? raw.references.slice(0, 64) : [],
    };
    if (role === 'assistant' && Array.isArray(raw.progress)) {
        message.progress = raw.progress
            .filter((entry) => typeof entry === 'string')
            .map((entry) => entry.trim().slice(0, 2000))
            .filter(Boolean)
            .slice(0, 500);
    }
    if (raw.context === false) message.context = false;
    return message;
}

function normalizeSession(raw) {
    const sessionId = normalizeSessionId(raw?.sessionId);
    const createdAt = normalizeTimestamp(raw?.createdAt);
    const updatedAt = normalizeTimestamp(raw?.updatedAt);
    if (!sessionId || !createdAt || !updatedAt || !Array.isArray(raw.messages)) return null;
    return {
        sessionId,
        createdAt,
        updatedAt,
        messages: raw.messages.map(normalizeSessionMessage).filter(Boolean).slice(0, 10000),
    };
}

export function parseWebchatSessionState(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope[WEBCHAT_SESSION_FLAG] || envelope.version !== 1) {
        return undefined;
    }
    if (envelope.event === 'list') {
        const currentSessionId = normalizeSessionId(envelope.currentSessionId);
        if (!currentSessionId || !Array.isArray(envelope.sessions)) return undefined;
        return {
            event: 'list',
            currentSessionId,
            sessions: envelope.sessions.map(normalizeSessionSummary).filter(Boolean).slice(0, 1000),
        };
    }
    if (envelope.event !== 'current' && envelope.event !== 'selected') return undefined;
    const session = normalizeSession(envelope.session);
    const summary = normalizeSessionSummary(envelope.summary);
    if (!session || !summary || session.sessionId !== summary.sessionId) return undefined;
    return { event: envelope.event, session, summary };
}

export function serializeSessionStateSseEvent(state) {
    const normalized = parseWebchatSessionState({
        [WEBCHAT_SESSION_FLAG]: 1,
        version: 1,
        ...state,
    });
    return normalized ? `event: session-state\ndata: ${JSON.stringify(normalized)}\n\n` : '';
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

export function buildRuntimeKey(workspaceDirectory, effectiveConfig, agentQuery = '') {
    const agent = String(effectiveConfig?.agentName || effectiveConfig?.displayName || 'webchat').trim();
    const launchSignature = crypto.createHash('sha256').update(String(agentQuery || '')).digest('hex').slice(0, 16);
    return `${workspaceDirectory}\0${agent}\0${launchSignature}`;
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
    if (PLOINKY_WORKSPACE_BANNER_RE.test(normalized)) return;
    if (normalized.includes(`"${WEBCHAT_SESSION_FLAG}"`)) {
        try {
            const sessionState = parseWebchatSessionState(JSON.parse(normalized));
            if (sessionState !== undefined) {
                if (sessionState.event !== 'list') {
                    tab.webchatSessionSnapshot = sessionState;
                    tab.liveMessageCount = sessionState.session.messages.length;
                }
                writeOrBufferSseEvent(tab, serializeSessionStateSseEvent(sessionState));
                return;
            }
        } catch (_) {
            // Invalid session-state envelopes fall through as ordinary agent output.
        }
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
                const update = parseWebchatTaskState(envelope);
                if (!update) return;
                if (!(tab.webchatTasks instanceof Map)) tab.webchatTasks = new Map();
                if (update.event === 'list') {
                    tab.webchatTasks.clear();
                    for (const task of update.tasks) tab.webchatTasks.set(task.id, task);
                } else if (update.task) {
                    tab.webchatTasks.set(update.task.id, {
                        ...tab.webchatTasks.get(update.task.id),
                        ...update.task,
                    });
                }
                const sessionId = normalizeSessionId(envelope.sessionId);
                const messageIndex = Number.isInteger(envelope.messageIndex) && envelope.messageIndex >= 0
                    ? envelope.messageIndex
                    : null;
                broadcastWorkspaceTaskEvent(
                    appState,
                    tab.workspaceDirectory,
                    `event: task-update\ndata: ${JSON.stringify({
                        ...update,
                        ...(sessionId && messageIndex !== null ? { sessionId, messageIndex } : {}),
                    })}\n\n`,
                );
                return;
            }
        } catch (_) {
            // Invalid task envelopes fall through as ordinary agent output.
        }
    }
    writeOrBufferSseEvent(tab, `data: ${JSON.stringify(line)}\n\n`);
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
    const isSessionProtocol = `{"${WEBCHAT_SESSION_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_SESSION_FLAG}"`);
    const isInteractionProtocol = `{"${WEBCHAT_INTERACTION_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_INTERACTION_FLAG}"`)
        || `{"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`);
    if (trimmed.startsWith('{') && (isTaskProtocol || isRuntimeStateProtocol || isSessionProtocol || isInteractionProtocol)) {
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
    if (!(tab?.webchatTasks instanceof Map)) return false;
    return [...tab.webchatTasks.values()].some((task) => task?.status === 'ongoing');
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
        console.log(`[webchat] Reconnect grace expired for runtime ${tabId}; disposing TTY.`);
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

    tab.taskProtocolBuffer = '';

    if (tab.cleanupTimer) {
        clearTimeout(tab.cleanupTimer);
        tab.cleanupTimer = null;
    }

    if (tab.tty) {
        console.log(`[webchat] Disposing TTY for runtime ${tabId}`);
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
