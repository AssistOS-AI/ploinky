import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ensureHistoryDirectory } from './sessionStore.js';

const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const JOURNAL_NAME = 'agent_tasks';
const LOG_DIRECTORY_NAME = 'task_logs';
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_REMOTE_TAIL = 256 * 1024;
const TERMINAL_STATUSES = new Set(['finished', 'stopped', 'error']);

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
    return {
        version: 1,
        id: raw.id,
        targetAgent: String(raw.targetAgent || '').slice(0, 160),
        remoteTaskId: String(raw.remoteTaskId || '').slice(0, 200),
        toolName: String(raw.toolName || '').slice(0, 160),
        description: String(raw.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
        status,
        remoteStatus: String(raw.remoteStatus || '').slice(0, 80),
        createdAt: validTimestamp(raw.createdAt) || now,
        updatedAt: validTimestamp(raw.updatedAt) || now,
        error: String(raw.error || '').trim().slice(0, 1000),
        ...(Number.isInteger(raw.pid) && raw.pid > 0 ? { pid: raw.pid } : {}),
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
            if (existing && TERMINAL_STATUSES.has(existing.status) && task.status === 'ongoing') continue;
            tasks.set(task.id, { ...existing, ...task });
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
            tail: typeof parsed.tail === 'string' ? parsed.tail.slice(-MAX_REMOTE_TAIL) : '',
            seq: Number.isFinite(Number(parsed.seq)) ? Number(parsed.seq) : null,
            resultHash: typeof parsed.resultHash === 'string' ? parsed.resultHash : '',
        };
    } catch (_) {
        return { tail: '', seq: null, resultHash: '' };
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

function appendBoundedLog(logPath, text) {
    if (!text) return '';
    assertRegularFileOrMissing(logPath);
    fs.appendFileSync(logPath, text, { encoding: 'utf8', mode: 0o600 });
    const raw = fs.readFileSync(logPath);
    if (raw.length <= MAX_LOG_BYTES) return text;
    const marker = Buffer.from('[older task log content truncated]\n', 'utf8');
    const kept = raw.subarray(Math.max(0, raw.length - (MAX_LOG_BYTES - marker.length)));
    fs.writeFileSync(logPath, Buffer.concat([marker, kept]), { mode: 0o600 });
    return text;
}

function ingestLog(logDirectory, taskId, rawLog = {}) {
    const { logPath, cursorPath } = taskPaths(logDirectory, taskId);
    const cursor = readCursor(cursorPath);
    const tail = typeof rawLog.tail === 'string' ? rawLog.tail.slice(-MAX_REMOTE_TAIL) : '';
    const seq = Number.isFinite(Number(rawLog.seq)) ? Number(rawLog.seq) : null;
    let appended = '';
    if (tail && (seq === null || cursor.seq === null || seq !== cursor.seq || tail !== cursor.tail)) {
        appended += overlapDelta(cursor.tail, tail);
    }
    const result = typeof rawLog.result === 'string' ? rawLog.result : '';
    const resultHash = result ? crypto.createHash('sha256').update(result).digest('hex') : '';
    if (result && resultHash !== cursor.resultHash) {
        appended += `${appended && !appended.endsWith('\n') ? '\n' : ''}\n[task result]\n${result}\n`;
    }
    appendBoundedLog(logPath, appended);
    atomicWriteJson(cursorPath, {
        tail,
        seq,
        resultHash: resultHash || cursor.resultHash,
        truncated: rawLog.truncated === true,
    });
    return appended;
}

export function ingestTaskEvent(workspaceDirectory, envelope) {
    const { logDirectory, journalPath } = ensureTaskStorage(workspaceDirectory);
    const incoming = normalizeTask(envelope?.task);
    const tasks = readJournal(journalPath);
    const existing = tasks.get(incoming.id) || null;
    const task = existing && TERMINAL_STATUSES.has(existing.status) && incoming.status === 'ongoing'
        ? existing
        : { ...existing, ...incoming };
    const metadataChanged = !existing
        || existing.status !== task.status
        || existing.remoteStatus !== task.remoteStatus
        || existing.error !== task.error
        || existing.description !== task.description;
    if (metadataChanged) appendMetadata(journalPath, task);
    const logAppend = envelope?.log ? ingestLog(logDirectory, task.id, envelope.log) : '';
    return { task, logAppend };
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
    normalizeTask,
    overlapDelta,
    readJournal,
};
