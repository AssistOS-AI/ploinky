import crypto from 'crypto';

const STREAM_RECONNECT_GRACE_MS = 120000;
const MAX_PENDING_SSE_EVENTS = 200;
const MAX_RUNTIME_MODEL_LENGTH = 256;
const WEBCHAT_RUNTIME_STATE_FLAG = '__webchatRuntimeState';
const WEBCHAT_SESSION_FLAG = '__webchatSession';
const WEBCHAT_WORKSPACE_FILES_FLAG = '__webchatWorkspaceFiles';
const WEBCHAT_INTERACTION_FLAG = '__webchatInteraction';
const WEBCHAT_INTERACTION_RESOLVED_FLAG = '__webchatInteractionResolved';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const TASK_CONTINUATION_HANDLE_RE = /^[A-Za-z0-9_-]{16,200}$/;
const TASK_TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_TASK_FINAL_OUTPUT_RANGES = 1000;
const TASK_LOG_SSE_CHUNK_CHARS = 64 * 1024;
const INTERACTION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INTERACTION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLOINKY_WORKSPACE_BANNER_RE = /^\[ploinky\]\s+using \.ploinky:\s+.+$/;
const TASK_STATUSES = new Set(['ongoing', 'finished', 'stopped', 'error']);
const MAX_WORKSPACE_FILE_PATHS = 100000;
const MAX_WORKSPACE_FILE_DELTA_PATHS = 20000;
const MAX_WORKSPACE_FILE_PATH_LENGTH = 4096;

function normalizeFinalOutputRanges(raw) {
    const byTurn = new Map();
    const declared = Array.isArray(raw?.finalOutputRanges)
        ? raw.finalOutputRanges.slice(-MAX_TASK_FINAL_OUTPUT_RANGES)
        : [];
    const legacy = {
        turn: raw?.turn,
        offset: raw?.finalOutputOffset,
        length: raw?.finalOutputLength,
    };
    for (const candidate of [...declared, legacy]) {
        if (!Number.isSafeInteger(candidate?.turn) || candidate.turn < 1) continue;
        if (!Number.isSafeInteger(candidate.offset) || candidate.offset < 0) continue;
        if (!Number.isSafeInteger(candidate.length) || candidate.length < 1) continue;
        byTurn.set(candidate.turn, {
            turn: candidate.turn,
            offset: candidate.offset,
            length: candidate.length,
        });
    }
    return [...byTurn.values()]
        .sort((left, right) => left.turn - right.turn || left.offset - right.offset)
        .slice(-MAX_TASK_FINAL_OUTPUT_RANGES);
}

function normalizeTaskCommands(raw, taskId) {
    if (!Array.isArray(raw)) return [];
    const commands = [];
    const seen = new Set();
    for (const entry of raw.slice(0, 20)) {
        const name = String(entry?.name || '').trim();
        const command = String(entry?.command || '').trim();
        const description = String(entry?.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        const loadingLabel = String(entry?.loadingLabel || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        const argCompletions = Array.isArray(entry?.argCompletions)
            ? entry.argCompletions.slice(0, 2000).map((completion) => {
                const value = String(completion?.value || '').trim().slice(0, 300);
                if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
                const label = String(completion?.label || value).replace(/\s+/g, ' ').trim().slice(0, 300);
                const completionDescription = String(completion?.description || '')
                    .replace(/\s+/g, ' ').trim().slice(0, 500);
                return { value, label: label || value, description: completionDescription };
            }).filter(Boolean)
            : [];
        const argMatchMode = entry?.argMatchMode === 'fragment' ? 'fragment' : 'prefix';
        const rawSuggestionLimit = Number(entry?.argSuggestionLimit);
        const argSuggestionLimit = Number.isInteger(rawSuggestionLimit) && rawSuggestionLimit > 0
            ? Math.min(rawSuggestionLimit, 2000)
            : null;
        const commandMatch = command.match(/^\/task [A-Za-z0-9][A-Za-z0-9_-]{0,63} (task_[0-9a-f]{24})$/);
        if (!/^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)
            || commandMatch?.[1] !== taskId || command.length > 1000
            || /[\u0000-\u001f\u007f]/.test(command) || seen.has(name)) continue;
        seen.add(name);
        commands.push({
            name,
            command,
            description,
            ...(loadingLabel ? { loadingLabel } : {}),
            ...(argCompletions.length ? { argCompletions } : {}),
            ...(argMatchMode === 'fragment' ? { argMatchMode } : {}),
            ...(argSuggestionLimit ? { argSuggestionLimit } : {}),
        });
    }
    return commands;
}

function normalizeTask(raw, { includeFinalOutputRanges = true } = {}) {
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
    const finalOutputRanges = includeFinalOutputRanges
        ? normalizeFinalOutputRanges(raw)
        : [];
    const modelKey = String(raw.execution?.model?.key || '').trim().slice(0, 300);
    const executionModel = String(raw.execution?.model?.model || '').trim().slice(0, 300);
    const executionProvider = String(raw.execution?.model?.provider || '').trim().slice(0, 160);
    const executionLabel = String(raw.execution?.model?.label || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const commands = normalizeTaskCommands(raw.commands, String(raw.id));
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
        ...(finalOutputRanges.length ? { finalOutputRanges } : {}),
        ...(raw.logRetention === 'full' ? { logRetention: 'full' } : {}),
        ...(continuation ? { continuation } : {}),
        ...(modelKey && executionModel ? {
            execution: {
                model: {
                    key: modelKey,
                    model: executionModel,
                    ...(executionProvider ? { provider: executionProvider } : {}),
                    ...(executionLabel ? { label: executionLabel } : {}),
                },
            },
        } : {}),
        ...(commands.length ? { commands } : {}),
    };
}

export function parseWebchatTaskState(envelope) {
    if (!envelope || envelope.__webchatTask !== 1 || envelope.version !== 1) return undefined;
    if (envelope.event === 'list') {
        if (!Array.isArray(envelope.tasks)) return undefined;
        return {
            event: 'list',
            tasks: envelope.tasks
                .map((task) => normalizeTask(task, { includeFinalOutputRanges: false }))
                .filter(Boolean)
                .slice(0, 1000),
        };
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

export function serializeTaskListSseEvent(tasks) {
    const values = tasks instanceof Map
        ? [...tasks.values()]
        : (Array.isArray(tasks) ? tasks : []);
    const snapshot = parseWebchatTaskState({
        __webchatTask: 1,
        version: 1,
        event: 'list',
        tasks: values,
    });
    if (!snapshot?.tasks.length) return '';
    return `event: task-update\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export function serializeTaskUpdateSseEvents(update, chunkSize = TASK_LOG_SSE_CHUNK_CHARS) {
    const serialize = (payload) => `event: task-update\ndata: ${JSON.stringify(payload)}\n\n`;
    const logText = update?.event === 'view' && typeof update?.log?.text === 'string'
        ? update.log.text
        : '';
    const safeChunkSize = Math.max(1024, Number(chunkSize) || TASK_LOG_SSE_CHUNK_CHARS);
    if (!logText || logText.length <= safeChunkSize) return [serialize(update)];

    const chunks = [];
    for (let offset = 0; offset < logText.length; offset += safeChunkSize) {
        chunks.push(logText.slice(offset, offset + safeChunkSize));
    }
    const nextOffset = Math.max(0, Number(update.log.nextOffset) || 0);
    const start = {
        ...update,
        log: { ...update.log, text: '' },
        logChunk: { phase: 'start', count: chunks.length, nextOffset },
    };
    return [
        serialize(start),
        ...chunks.map((text, index) => serialize({
            event: 'view-log-chunk',
            task: update.task,
            logChunk: {
                phase: 'chunk',
                index,
                count: chunks.length,
                text,
                nextOffset,
            },
        })),
    ];
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

function normalizeWorkspaceFilePath(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_WORKSPACE_FILE_PATH_LENGTH) return null;
    if (/[\0\r\n]/.test(value) || value.startsWith('/') || value.includes('\\')) return null;
    const segments = value.split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
    return value;
}

function normalizeWorkspaceFilePaths(values, limit) {
    if (!Array.isArray(values) || values.length > limit) return null;
    const normalized = [];
    const seen = new Set();
    for (const value of values) {
        const filePath = normalizeWorkspaceFilePath(value);
        if (!filePath) return null;
        if (seen.has(filePath)) continue;
        seen.add(filePath);
        normalized.push(filePath);
    }
    return normalized;
}

export function parseWebchatWorkspaceFilesState(envelope) {
    if (!envelope || envelope[WEBCHAT_WORKSPACE_FILES_FLAG] !== 1 || envelope.version !== 1) {
        return undefined;
    }
    const indexVersion = Number(envelope.indexVersion);
    if (!Number.isSafeInteger(indexVersion) || indexVersion < 1) return undefined;
    if (envelope.reset === true) {
        const files = normalizeWorkspaceFilePaths(envelope.files, MAX_WORKSPACE_FILE_PATHS);
        return files ? { indexVersion, reset: true, files } : undefined;
    }
    if (envelope.reset !== false) return undefined;
    const added = normalizeWorkspaceFilePaths(envelope.added, MAX_WORKSPACE_FILE_DELTA_PATHS);
    const removed = normalizeWorkspaceFilePaths(envelope.removed, MAX_WORKSPACE_FILE_DELTA_PATHS);
    if (!added || !removed || (!added.length && !removed.length)) return undefined;
    return { indexVersion, reset: false, added, removed };
}

export function serializeWorkspaceFilesSseEvent(state) {
    if (!state || !Number.isSafeInteger(state.indexVersion)) return '';
    const payload = state.reset === true
        ? { indexVersion: state.indexVersion, reset: true, files: state.files }
        : {
            indexVersion: state.indexVersion,
            reset: false,
            added: state.added,
            removed: state.removed,
        };
    return `event: workspace-files\ndata: ${JSON.stringify(payload)}\n\n`;
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

function normalizeInteractionUrl(value) {
    const url = normalizeInteractionText(value, 4000, { required: true });
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const loopback = host === 'localhost' || host.endsWith('.localhost')
            || host === '::1' || host === '[::1]' || host === '0.0.0.0' || /^127(?:\.|$)/.test(host);
        return parsed.protocol === 'https:' && !loopback ? parsed.toString() : undefined;
    } catch (_) {
        return undefined;
    }
}

function normalizeInteractionChallenge(raw) {
    if (raw === undefined) return null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const instructions = normalizeInteractionText(raw.instructions, 2000);
    if (instructions === undefined) return undefined;
    if (raw.type === 'device_code') {
        const verificationUri = normalizeInteractionUrl(raw.verificationUri);
        const userCode = normalizeInteractionText(raw.userCode, 100);
        const expiresInSeconds = Number(raw.expiresInSeconds);
        if (!verificationUri || userCode === undefined || (!userCode && !instructions)) return undefined;
        return {
            type: 'device_code',
            verificationUri,
            userCode,
            instructions,
            ...(Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
                ? { expiresInSeconds: Math.min(expiresInSeconds, 86400) }
                : {}),
        };
    }
    if (raw.type === 'manual_oauth_code') {
        const url = normalizeInteractionUrl(raw.url);
        if (!url) return undefined;
        return { type: 'manual_oauth_code', url, instructions };
    }
    return undefined;
}

export function parseWebchatInteraction(envelope) {
    if (!envelope || typeof envelope !== 'object' || !envelope[WEBCHAT_INTERACTION_FLAG]) return undefined;
    if (envelope.version !== 1) return undefined;
    const id = normalizeInteractionText(envelope.id, 128, { required: true });
    const kind = normalizeInteractionText(envelope.kind, 64, { required: true });
    const title = normalizeInteractionText(envelope.title, 120, { required: true });
    const message = normalizeInteractionText(envelope.message, 1000);
    const detail = normalizeInteractionText(envelope.detail, 4000);
    const challenge = normalizeInteractionChallenge(envelope.challenge);
    if (!id || !INTERACTION_ID_RE.test(id) || !kind || !INTERACTION_TOKEN_RE.test(kind) || !title) return undefined;
    if (message === undefined || detail === undefined || challenge === undefined) return undefined;
    if (!Array.isArray(envelope.options) || envelope.options.length > 256) return undefined;
    let input = null;
    if (envelope.input !== undefined) {
        if (!envelope.input || typeof envelope.input !== 'object' || Array.isArray(envelope.input)) return undefined;
        const inputType = envelope.input.type === 'secret' ? 'secret' : (envelope.input.type === 'text' ? 'text' : '');
        const placeholder = normalizeInteractionText(envelope.input.placeholder, 300);
        const maxLength = Number(envelope.input.maxLength);
        if (!inputType || placeholder === undefined || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 65536) {
            return undefined;
        }
        input = { type: inputType, placeholder, maxLength };
    }
    if (!input && envelope.options.length < 1) return undefined;
    const seen = new Set();
    const options = [];
    for (const raw of envelope.options) {
        const optionId = normalizeInteractionText(raw?.id, 64, { required: true });
        const label = normalizeInteractionText(raw?.label, 100, { required: true });
        const description = normalizeInteractionText(raw?.description, 500);
        if (!optionId || !INTERACTION_TOKEN_RE.test(optionId) || !label
            || description === undefined || seen.has(optionId)) return undefined;
        seen.add(optionId);
        options.push({
            id: optionId,
            label,
            description,
            tone: raw?.tone === 'danger' ? 'danger' : 'default',
        });
    }
    const requestedDefault = normalizeInteractionText(envelope.defaultOptionId, 64);
    const defaultOptionId = seen.has(requestedDefault) ? requestedDefault : (options[0]?.id || null);
    const targetTaskId = typeof envelope.targetTaskId === 'string' && TASK_ID_RE.test(envelope.targetTaskId)
        ? envelope.targetTaskId
        : '';
    const targetTabId = typeof envelope.targetTabId === 'string'
        && /^[A-Za-z0-9_-]{1,128}$/.test(envelope.targetTabId)
        ? envelope.targetTabId
        : '';
    return {
        id,
        kind,
        title,
        message,
        detail,
        options,
        defaultOptionId,
        ...(input ? { input } : {}),
        ...(challenge ? { challenge } : {}),
        ...(envelope.searchable === true && options.length ? { searchable: true } : {}),
        ...(targetTaskId ? { targetTaskId } : {}),
        ...(targetTabId ? { targetTabId } : {}),
    };
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
    if (normalized.includes(`"${WEBCHAT_WORKSPACE_FILES_FLAG}"`)) {
        try {
            const update = parseWebchatWorkspaceFilesState(JSON.parse(normalized));
            if (!update) return;
            if (update.reset) {
                tab.webchatWorkspaceFiles = {
                    indexVersion: update.indexVersion,
                    files: new Set(update.files),
                };
            } else {
                const snapshot = tab.webchatWorkspaceFiles;
                if (!snapshot || update.indexVersion <= snapshot.indexVersion) return;
                for (const filePath of update.removed) snapshot.files.delete(filePath);
                for (const filePath of update.added) snapshot.files.add(filePath);
                snapshot.indexVersion = update.indexVersion;
            }
            writeOrBufferSseEvent(tab, serializeWorkspaceFilesSseEvent(update));
            return;
        } catch (_) {
            // Invalid workspace-file envelopes fall through as ordinary agent output.
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
                const outgoing = {
                    ...update,
                    ...(sessionId && messageIndex !== null ? { sessionId, messageIndex } : {}),
                };
                for (const payload of serializeTaskUpdateSseEvents(outgoing)) {
                    broadcastWorkspaceTaskEvent(appState, tab.workspaceDirectory, payload);
                }
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
    const isWorkspaceFilesProtocol = `{"${WEBCHAT_WORKSPACE_FILES_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_WORKSPACE_FILES_FLAG}"`);
    const isInteractionProtocol = `{"${WEBCHAT_INTERACTION_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_INTERACTION_FLAG}"`)
        || `{"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`.startsWith(trimmed)
        || trimmed.includes(`"${WEBCHAT_INTERACTION_RESOLVED_FLAG}"`);
    if (trimmed.startsWith('{') && (isTaskProtocol || isRuntimeStateProtocol || isSessionProtocol
        || isWorkspaceFilesProtocol || isInteractionProtocol)) {
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
    const pid = tab.tty?.pid || tab.pid;
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
