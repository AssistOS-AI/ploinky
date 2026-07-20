import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ensureHistoryDirectory } from './sessionStore.js';

const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const JOURNAL_NAME = 'agent_tasks';
const LOG_DIRECTORY_NAME = 'task_logs';
const MAX_LOG_BYTES = 1024 * 1024;
const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);
const CONTINUATION_HANDLE_RE = /^[A-Za-z0-9_-]{16,200}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,160}$/;

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertRegularFileOrMissing(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_task_file');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function ensureTaskStorage(workspaceDirectory) {
    const { historyDirectory } = ensureHistoryDirectory(workspaceDirectory);
    const logDirectory = path.join(historyDirectory, LOG_DIRECTORY_NAME);
    try {
        const stat = fs.lstatSync(logDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_task_log_directory');
        if (!isInside(historyDirectory, fs.realpathSync(logDirectory))) throw new Error('unsafe_task_log_directory');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        fs.mkdirSync(logDirectory, { mode: 0o700 });
    }
    const journalPath = path.join(historyDirectory, JOURNAL_NAME);
    assertRegularFileOrMissing(journalPath);
    return { historyDirectory, logDirectory, journalPath };
}

function normalizeTask(raw) {
    if (!raw || typeof raw !== 'object' || !TASK_ID_RE.test(String(raw.id || ''))) {
        throw new Error('invalid_task_event');
    }
    const status = ['ongoing', 'finished', 'stopped', 'error'].includes(raw.status)
        ? raw.status
        : 'ongoing';
    const now = new Date().toISOString();
    const createdAt = validTimestamp(raw.createdAt) || now;
    const continuation = normalizeContinuation(raw.continuation, raw.targetAgent);
    return {
        version: 1,
        id: raw.id,
        targetAgent: String(raw.targetAgent || '').slice(0, 160),
        remoteTaskId: String(raw.remoteTaskId || '').slice(0, 200),
        toolName: String(raw.toolName || '').slice(0, 160),
        description: String(raw.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        status,
        remoteStatus: String(raw.remoteStatus || '').slice(0, 80),
        createdAt,
        updatedAt: validTimestamp(raw.updatedAt) || now,
        executionStartedAt: validTimestamp(raw.executionStartedAt) || createdAt,
        turn: Number.isSafeInteger(raw.turn) && raw.turn > 0 ? raw.turn : 1,
        error: String(raw.error || '').trim().slice(0, 1000),
        ...(raw.logRetention === 'full' ? { logRetention: 'full' } : {}),
        ...(continuation ? { continuation } : {}),
        ...(Number.isInteger(raw.pid) && raw.pid > 0 ? { pid: raw.pid } : {}),
    };
}

function normalizeContinuation(raw, fallbackTargetAgent = '') {
    if (!raw || typeof raw !== 'object' || raw.version !== 1) return null;
    const targetAgent = String(raw.targetAgent || fallbackTargetAgent || '').trim().slice(0, 160);
    const toolName = String(raw.toolName || '').trim();
    const handle = String(raw.handle || '').trim();
    if (!targetAgent || !TOOL_NAME_RE.test(toolName)) return null;
    if (handle && !CONTINUATION_HANDLE_RE.test(handle)) return null;
    return {
        version: 1,
        targetAgent,
        toolName,
        ...(handle ? { handle } : {}),
    };
}

function validTimestamp(value) {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : '';
}

function readJournal(journalPath) {
    let raw = '';
    try {
        raw = fs.readFileSync(journalPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return new Map();
        throw error;
    }
    const tasks = new Map();
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            const task = normalizeTask(JSON.parse(line));
            const existing = tasks.get(task.id);
            if (existing && task.turn < existing.turn) continue;
            if (existing && task.turn === existing.turn
                && task.remoteTaskId && existing.remoteTaskId
                && task.remoteTaskId !== existing.remoteTaskId) continue;
            if (existing && TERMINAL_STATUSES.has(existing.status) && task.status === 'ongoing'
                && task.turn <= existing.turn) continue;
            tasks.set(task.id, {
                ...existing,
                ...task,
                ...(existing?.continuation?.handle && !task.continuation?.handle
                    ? { continuation: existing.continuation }
                    : {}),
            });
        } catch (_) {
            // Ignore malformed or incomplete journal lines.
        }
    }
    return tasks;
}

function appendMetadata(journalPath, task) {
    fs.appendFileSync(journalPath, `${JSON.stringify(task)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function taskPaths(logDirectory, taskId) {
    if (!TASK_ID_RE.test(taskId)) throw new Error('invalid_task_id');
    return {
        logPath: path.join(logDirectory, `${taskId}.log`),
        cursorPath: path.join(logDirectory, `${taskId}.cursor.json`),
    };
}

function readCursor(cursorPath) {
    assertRegularFileOrMissing(cursorPath);
    try {
        const parsed = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
        return {
            tail: typeof parsed.tail === 'string' ? parsed.tail : '',
            seq: Number.isFinite(Number(parsed.seq)) ? Number(parsed.seq) : null,
            sourceId: typeof parsed.sourceId === 'string' ? parsed.sourceId.slice(0, 200) : '',
        };
    } catch (_) {
        return { tail: '', seq: null, sourceId: '' };
    }
}

function atomicWriteJson(filePath, value) {
    assertRegularFileOrMissing(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporaryPath, filePath);
    } finally {
        try { fs.unlinkSync(temporaryPath); } catch (_) { }
    }
}

function overlapDelta(previousTail, nextTail) {
    if (!nextTail) return '';
    if (!previousTail) return nextTail;
    if (nextTail.startsWith(previousTail)) return nextTail.slice(previousTail.length);
    const maximum = Math.min(previousTail.length, nextTail.length);
    for (let size = maximum; size > 0; size -= 1) {
        if (previousTail.slice(-size) === nextTail.slice(0, size)) return nextTail.slice(size);
    }
    return `\n[task log source truncated or restarted]\n${nextTail}`;
}

function appendTaskLog(logPath, text, { retainFull = false } = {}) {
    if (!text) return '';
    assertRegularFileOrMissing(logPath);
    fs.appendFileSync(logPath, text, { encoding: 'utf8', mode: 0o600 });
    const raw = fs.readFileSync(logPath);
    if (retainFull || raw.length <= MAX_LOG_BYTES) return text;
    const marker = Buffer.from('[older task log content truncated]\n', 'utf8');
    const kept = raw.subarray(Math.max(0, raw.length - (MAX_LOG_BYTES - marker.length)));
    fs.writeFileSync(logPath, Buffer.concat([marker, kept]), { mode: 0o600 });
    return text;
}

function ingestLog(logDirectory, task, rawLog = {}) {
    const taskId = task.id;
    const { logPath, cursorPath } = taskPaths(logDirectory, taskId);
    const cursor = readCursor(cursorPath);
    const tail = typeof rawLog.tail === 'string' ? rawLog.tail : '';
    const seq = Number.isFinite(Number(rawLog.seq)) ? Number(rawLog.seq) : null;
    const sourceId = String(rawLog.sourceId || task.remoteTaskId || '').slice(0, 200);
    const sameSource = !sourceId || !cursor.sourceId || sourceId === cursor.sourceId;
    let appended = '';
    if (tail && (seq === null || cursor.seq === null || seq !== cursor.seq || tail !== cursor.tail)) {
        appended += overlapDelta(sameSource ? cursor.tail : '', tail);
    }
    appendTaskLog(logPath, appended, { retainFull: task.logRetention === 'full' });
    atomicWriteJson(cursorPath, {
        tail,
        seq,
        sourceId,
        truncated: rawLog.truncated === true,
    });
    let nextOffset = 0;
    try {
        nextOffset = fs.readFileSync(logPath, 'utf8').length;
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    return { appended, nextOffset };
}

export function ingestTaskEvent(workspaceDirectory, envelope) {
    const { logDirectory, journalPath } = ensureTaskStorage(workspaceDirectory);
    const incoming = normalizeTask(envelope?.task);
    const tasks = readJournal(journalPath);
    const existing = tasks.get(incoming.id) || null;
    const staleTurn = existing && incoming.turn < existing.turn;
    const staleSource = existing && incoming.turn === existing.turn
        && incoming.remoteTaskId && existing.remoteTaskId
        && incoming.remoteTaskId !== existing.remoteTaskId;
    const invalidRegression = existing && TERMINAL_STATUSES.has(existing.status)
        && incoming.status === 'ongoing' && incoming.turn <= existing.turn;
    const task = staleTurn || staleSource || invalidRegression
        ? existing
        : {
            ...existing,
            ...incoming,
            ...(existing?.continuation?.handle && !incoming.continuation?.handle
                ? { continuation: existing.continuation }
                : {}),
        };
    const metadataChanged = !existing
        || existing.status !== task.status
        || existing.remoteStatus !== task.remoteStatus
        || existing.error !== task.error
        || existing.description !== task.description
        || existing.remoteTaskId !== task.remoteTaskId
        || existing.turn !== task.turn
        || existing.continuation?.handle !== task.continuation?.handle;
    if (metadataChanged) appendMetadata(journalPath, task);
    const logUpdate = envelope?.log
        ? ingestLog(logDirectory, task, envelope.log)
        : { appended: '', nextOffset: null };
    return {
        task,
        logAppend: logUpdate.appended,
        ...(Number.isInteger(logUpdate.nextOffset) ? { logOffset: logUpdate.nextOffset } : {}),
    };
}

export function getTask(workspaceDirectory, taskId) {
    if (!TASK_ID_RE.test(String(taskId || ''))) throw new Error('invalid_task_id');
    const { journalPath } = ensureTaskStorage(workspaceDirectory);
    return readJournal(journalPath).get(taskId) || null;
}

function continuationLogEntry(turn, message) {
    const safeMessage = String(message || '')
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .trim();
    return `\n[Continuation ${turn}]\nUser: ${safeMessage}\n\n`;
}

export function beginTaskContinuation(workspaceDirectory, taskId, {
    remoteTaskId,
    message,
    updatedAt = new Date().toISOString(),
} = {}) {
    const { logDirectory, journalPath } = ensureTaskStorage(workspaceDirectory);
    const existing = readJournal(journalPath).get(String(taskId || ''));
    if (!existing) throw new Error('task_not_found');
    if (!TERMINAL_STATUSES.has(existing.status)) throw new Error('task_not_terminal');
    if (!existing.continuation?.handle) throw new Error('task_not_continuable');
    const normalizedRemoteTaskId = String(remoteTaskId || '').trim().slice(0, 200);
    if (!normalizedRemoteTaskId || normalizedRemoteTaskId === existing.remoteTaskId) {
        throw new Error('invalid_remote_task_id');
    }
    const next = {
        ...existing,
        remoteTaskId: normalizedRemoteTaskId,
        status: 'ongoing',
        remoteStatus: 'pending',
        updatedAt: validTimestamp(updatedAt) || new Date().toISOString(),
        executionStartedAt: validTimestamp(updatedAt) || new Date().toISOString(),
        turn: existing.turn + 1,
        error: '',
        logRetention: 'full',
    };
    appendMetadata(journalPath, next);
    const { logPath, cursorPath } = taskPaths(logDirectory, next.id);
    appendTaskLog(logPath, continuationLogEntry(next.turn, message), { retainFull: true });
    atomicWriteJson(cursorPath, {
        tail: '',
        seq: null,
        sourceId: normalizedRemoteTaskId,
        truncated: false,
    });
    return next;
}

export function listTasks(workspaceDirectory) {
    const { journalPath } = ensureTaskStorage(workspaceDirectory);
    return [...readJournal(journalPath).values()]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function readTaskLog(workspaceDirectory, taskId, offset = 0) {
    const { logDirectory } = ensureTaskStorage(workspaceDirectory);
    const { logPath } = taskPaths(logDirectory, taskId);
    assertRegularFileOrMissing(logPath);
    let text = '';
    try {
        text = fs.readFileSync(logPath, 'utf8');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    const requested = Math.max(0, Number.parseInt(offset, 10) || 0);
    const reset = requested > text.length;
    const start = reset ? 0 : requested;
    return { text: text.slice(start), nextOffset: text.length, reset };
}

export function hasOngoingTask(workspaceDirectory, taskIds = []) {
    if (!taskIds.length) return false;
    const ids = new Set(taskIds);
    return listTasks(workspaceDirectory).some((task) => ids.has(task.id) && task.status === 'ongoing');
}

export const __testables = {
    MAX_LOG_BYTES,
    normalizeContinuation,
    normalizeTask,
    overlapDelta,
    readJournal,
};
