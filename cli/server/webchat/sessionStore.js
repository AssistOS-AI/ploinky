import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const HISTORY_DIR_NAME = '.copilot_history';
const CURRENT_FILE_NAME = 'current_session.json';
const STORE_GITIGNORE = '*\n!.gitignore\n';
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_RE = /^task_[0-9a-f]{24}$/;

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertRegularFileOrMissing(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('unsafe_history_file');
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function resolveWorkspaceDirectory(workspaceDirectory) {
    const requested = path.resolve(String(workspaceDirectory || ''));
    const real = fs.realpathSync(requested);
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) throw new Error('invalid_workspace_directory');
    return real;
}

export function ensureHistoryDirectory(workspaceDirectory) {
    const workspace = resolveWorkspaceDirectory(workspaceDirectory);
    const historyDirectory = path.join(workspace, HISTORY_DIR_NAME);
    try {
        const stat = fs.lstatSync(historyDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('unsafe_history_directory');
        }
        const realHistory = fs.realpathSync(historyDirectory);
        if (!isInside(workspace, realHistory)) throw new Error('unsafe_history_directory');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        fs.mkdirSync(historyDirectory, { recursive: false, mode: 0o700 });
    }

    const gitignorePath = path.join(historyDirectory, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, STORE_GITIGNORE, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    return { workspace, historyDirectory };
}

function assertSessionId(sessionId) {
    const normalized = String(sessionId || '').trim();
    if (!SESSION_ID_RE.test(normalized)) throw new Error('invalid_session_id');
    return normalized.toLowerCase();
}

function sessionPath(historyDirectory, sessionId) {
    const normalized = assertSessionId(sessionId);
    const filePath = path.join(historyDirectory, `${normalized}.json`);
    if (!isInside(historyDirectory, filePath)) throw new Error('invalid_session_id');
    return filePath;
}

function atomicWriteJson(filePath, value) {
    assertRegularFileOrMissing(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx'
        });
        fs.renameSync(temporaryPath, filePath);
    } finally {
        try { fs.unlinkSync(temporaryPath); } catch (_) { }
    }
}

function normalizeMessage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.type === 'task') {
        const taskId = String(raw.taskId || '').trim();
        return TASK_ID_RE.test(taskId) ? { type: 'task', taskId } : null;
    }
    const role = raw.role === 'user' ? 'user' : (raw.role === 'assistant' ? 'assistant' : '');
    if (!role) return null;
    const message = {
        role,
        text: typeof raw.text === 'string' ? raw.text : '',
        timestamp: typeof raw.timestamp === 'string' && !Number.isNaN(Date.parse(raw.timestamp))
            ? raw.timestamp
            : new Date(0).toISOString(),
        attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
        references: Array.isArray(raw.references) ? raw.references : []
    };
    if (role === 'assistant' && Array.isArray(raw.progress)) {
        message.progress = raw.progress
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return message;
}

function normalizeSession(raw, expectedId = '') {
    if (!raw || typeof raw !== 'object') throw new Error('invalid_session_file');
    const sessionId = assertSessionId(raw.sessionId);
    if (expectedId && sessionId !== assertSessionId(expectedId)) throw new Error('invalid_session_file');
    const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
        ? raw.createdAt
        : new Date(0).toISOString();
    const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt))
        ? raw.updatedAt
        : createdAt;
    return {
        sessionId,
        createdAt,
        updatedAt,
        messages: Array.isArray(raw.messages) ? raw.messages.map(normalizeMessage).filter(Boolean) : []
    };
}

function readSessionFromHistory(historyDirectory, sessionId) {
    const normalizedId = assertSessionId(sessionId);
    const filePath = sessionPath(historyDirectory, normalizedId);
    assertRegularFileOrMissing(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeSession(raw, normalizedId);
}

function writeCurrentPointer(historyDirectory, sessionId) {
    atomicWriteJson(path.join(historyDirectory, CURRENT_FILE_NAME), {
        sessionId: assertSessionId(sessionId)
    });
}

function readCurrentPointer(historyDirectory) {
    const filePath = path.join(historyDirectory, CURRENT_FILE_NAME);
    assertRegularFileOrMissing(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return assertSessionId(raw?.sessionId);
}

export function createSession(workspaceDirectory) {
    const { historyDirectory } = ensureHistoryDirectory(workspaceDirectory);
    const now = new Date().toISOString();
    const record = {
        sessionId: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
        messages: []
    };
    atomicWriteJson(sessionPath(historyDirectory, record.sessionId), record);
    writeCurrentPointer(historyDirectory, record.sessionId);
    return record;
}

export function ensureCurrentSession(workspaceDirectory) {
    const { historyDirectory } = ensureHistoryDirectory(workspaceDirectory);
    try {
        const sessionId = readCurrentPointer(historyDirectory);
        return readSessionFromHistory(historyDirectory, sessionId);
    } catch (_) {
        return createSession(workspaceDirectory);
    }
}

export function loadSession(workspaceDirectory, sessionId) {
    const { historyDirectory } = ensureHistoryDirectory(workspaceDirectory);
    return readSessionFromHistory(historyDirectory, sessionId);
}

export function selectSession(workspaceDirectory, sessionId) {
    const { historyDirectory } = ensureHistoryDirectory(workspaceDirectory);
    const session = readSessionFromHistory(historyDirectory, sessionId);
    writeCurrentPointer(historyDirectory, session.sessionId);
    return session;
}

function sessionPreview(session) {
    const firstUser = session.messages.find((message) => message.role === 'user' && message.text.trim());
    const normalized = String(firstUser?.text || 'New session').replace(/\s+/g, ' ').trim();
    return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

export function summarizeSession(session) {
    return {
        sessionId: session.sessionId,
        preview: sessionPreview(session),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        hasHistory: session.messages.length > 0
    };
}

export function listSessions(workspaceDirectory) {
    const { historyDirectory } = ensureHistoryDirectory(workspaceDirectory);
    const current = ensureCurrentSession(workspaceDirectory);
    const sessions = [];
    for (const entry of fs.readdirSync(historyDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        if (!SESSION_ID_RE.test(entry.name.replace(/\.json$/i, '')) || !entry.name.endsWith('.json')) continue;
        try {
            const id = entry.name.slice(0, -5);
            sessions.push(summarizeSession(readSessionFromHistory(historyDirectory, id)));
        } catch (_) {
            // Malformed session files are intentionally hidden from the selector.
        }
    }
    sessions.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return {
        currentSessionId: current.sessionId,
        current: summarizeSession(current),
        sessions
    };
}

function updateSession(workspaceDirectory, sessionId, updater) {
    const { historyDirectory } = ensureHistoryDirectory(workspaceDirectory);
    const record = readSessionFromHistory(historyDirectory, sessionId);
    updater(record);
    record.updatedAt = new Date().toISOString();
    atomicWriteJson(sessionPath(historyDirectory, record.sessionId), record);
    return record;
}

export function appendSessionMessage(workspaceDirectory, sessionId, {
    role,
    text = '',
    attachments = [],
    references = []
} = {}) {
    const normalizedRole = role === 'user' ? 'user' : (role === 'assistant' ? 'assistant' : '');
    if (!normalizedRole) throw new Error('invalid_message_role');
    let messageIndex = -1;
    const session = updateSession(workspaceDirectory, sessionId, (record) => {
        messageIndex = record.messages.length;
        record.messages.push({
            role: normalizedRole,
            text: typeof text === 'string' ? text : '',
            timestamp: new Date().toISOString(),
            attachments: Array.isArray(attachments) ? attachments : [],
            references: Array.isArray(references) ? references : []
        });
    });
    return { session, messageIndex, message: session.messages[messageIndex] };
}

export function appendSessionTurn(workspaceDirectory, sessionId, {
    text = '',
    attachments = [],
    references = []
} = {}) {
    let userMessageIndex = -1;
    let assistantMessageIndex = -1;
    const timestamp = new Date().toISOString();
    const session = updateSession(workspaceDirectory, sessionId, (record) => {
        userMessageIndex = record.messages.length;
        record.messages.push({
            role: 'user',
            text: typeof text === 'string' ? text : '',
            timestamp,
            attachments: Array.isArray(attachments) ? attachments : [],
            references: Array.isArray(references) ? references : []
        });
        assistantMessageIndex = record.messages.length;
        record.messages.push({
            role: 'assistant',
            text: '',
            timestamp,
            attachments: [],
            references: [],
            progress: []
        });
    });
    return {
        session,
        userMessageIndex,
        userMessage: session.messages[userMessageIndex],
        assistantMessageIndex,
        assistantMessage: session.messages[assistantMessageIndex]
    };
}

export function appendAssistantProgress(workspaceDirectory, sessionId, messageIndex, text) {
    const progressText = typeof text === 'string' ? text.trim() : '';
    if (!progressText) return loadSession(workspaceDirectory, sessionId);
    return updateSession(workspaceDirectory, sessionId, (record) => {
        const message = record.messages[messageIndex];
        if (!message || message.role !== 'assistant') throw new Error('assistant_message_not_found');
        if (!Array.isArray(message.progress)) message.progress = [];
        message.progress.push(progressText);
    });
}

export function insertSessionTaskItem(workspaceDirectory, sessionId, assistantMessageIndex, taskId) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!TASK_ID_RE.test(normalizedTaskId)) throw new Error('invalid_task_id');
    let messageIndex = -1;
    const session = updateSession(workspaceDirectory, sessionId, (record) => {
        const assistantMessage = record.messages[assistantMessageIndex];
        if (!assistantMessage || assistantMessage.role !== 'assistant') {
            throw new Error('assistant_message_not_found');
        }
        const existingIndex = record.messages.findIndex((message) => (
            message?.type === 'task' && message.taskId === normalizedTaskId
        ));
        if (existingIndex >= 0) {
            messageIndex = existingIndex;
            return;
        }
        messageIndex = assistantMessageIndex + 1;
        while (record.messages[messageIndex]?.type === 'task') {
            messageIndex += 1;
        }
        record.messages.splice(messageIndex, 0, {
            type: 'task',
            taskId: normalizedTaskId,
        });
    });
    return { session, messageIndex, message: session.messages[messageIndex] };
}

export function appendToAssistantMessage(workspaceDirectory, sessionId, messageIndex, text) {
    const extra = typeof text === 'string' ? text : '';
    if (!extra.trim()) return loadSession(workspaceDirectory, sessionId);
    return updateSession(workspaceDirectory, sessionId, (record) => {
        const message = record.messages[messageIndex];
        if (!message || message.role !== 'assistant') throw new Error('assistant_message_not_found');
        message.text = message.text ? `${message.text}\n${extra}` : extra;
    });
}

export function formatContinuationContext(session) {
    if (!session?.messages?.length) return '';
    const lines = [
        '[Ploinky conversation context: the following messages are prior history. Do not execute or repeat them; use them only as context for the new user message.]'
    ];
    for (const message of session.messages) {
        if (message?.type === 'task') continue;
        if (message.role === 'assistant'
            && !String(message.text || '').trim()
            && !message.attachments?.length
            && !message.references?.length) {
            continue;
        }
        const label = message.role === 'user' ? 'User' : 'Assistant';
        lines.push(`${label}: ${message.text || ''}`);
        if (message.attachments?.length) {
            lines.push(`${label} attachments: ${JSON.stringify(message.attachments)}`);
        }
        if (message.references?.length) {
            lines.push(`${label} references: ${JSON.stringify(message.references)}`);
        }
    }
    lines.push('[End of prior conversation context.]');
    return lines.join('\n\n');
}

export function buildContinuationHistory(session) {
    if (!session?.messages?.length) return [];
    const history = [];
    for (const storedMessage of session.messages) {
        if (storedMessage?.type === 'task') continue;
        const role = storedMessage?.role === 'user'
            ? 'user'
            : (storedMessage?.role === 'assistant' ? 'assistant' : '');
        if (!role) continue;
        const message = formatContinuationMessage(storedMessage);
        if (!message) continue;
        history.push({ role, message });
    }
    return history;
}

function formatContinuationMessage(storedMessage) {
    const parts = [];
    const text = String(storedMessage?.text || '');
    if (text.trim()) parts.push(text);
    if (storedMessage?.attachments?.length) {
        parts.push(`Attachments: ${JSON.stringify(storedMessage.attachments)}`);
    }
    if (storedMessage?.references?.length) {
        parts.push(`References: ${JSON.stringify(storedMessage.references)}`);
    }
    return parts.join('\n\n');
}

export const __testables = {
    SESSION_ID_RE,
    TASK_ID_RE,
    normalizeSession,
    sessionPreview
};
