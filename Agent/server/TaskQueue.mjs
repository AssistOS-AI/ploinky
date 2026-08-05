import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describeShellFailure } from '../lib/toolError.mjs';
import { inspectProcessIdentity, normalizeProcessIdentity } from '../lib/processIdentity.mjs';

const DEFAULT_MAX_LOG_TAIL_BYTES = 128 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 2000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const CONTINUATION_HANDLE_RE = /^[A-Za-z0-9_-]{16,200}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,160}$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const PROVIDER_LOGIN_OPERATIONS = new Set([
    'login_start', 'login_status', 'login_respond', 'login_cancel',
]);
const RESTORABLE_STATUSES = new Set([
    'pending', 'running', 'cancelling', 'completed', 'failed', 'cancelled',
]);
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const PERSISTENCE_SCHEMA_VERSION = 1;
const MAX_PERSISTENCE_BYTES = 16 * 1024 * 1024;
const MAX_PERSISTED_TASKS = 10_000;
const MAX_PERSISTED_VALUE_BYTES = 1024 * 1024;
const PERSISTED_TASK_KEYS = new Set([
    'schemaVersion', 'id', 'toolName', 'commandSpec', 'payload', 'status', 'timeoutMs',
    'createdAt', 'updatedAt', 'error', 'result', 'logRetention', 'continuationTool',
    'logTail', 'logSeq', 'logTruncated',
]);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedJson(value, maximum = MAX_PERSISTED_VALUE_BYTES) {
    try {
        const encoded = JSON.stringify(value);
        return typeof encoded === 'string' && Buffer.byteLength(encoded, 'utf8') <= maximum;
    } catch {
        return false;
    }
}

function exactPersistedTask(entry, maxLogTailBytes) {
    if (!isPlainObject(entry) || Object.keys(entry).length !== PERSISTED_TASK_KEYS.size
        || Object.keys(entry).some((key) => !PERSISTED_TASK_KEYS.has(key))
        || entry.schemaVersion !== PERSISTENCE_SCHEMA_VERSION
        || !TASK_ID_RE.test(entry.id)
        || !TOOL_NAME_RE.test(entry.toolName)
        || !isPlainObject(entry.commandSpec)
        || !isPlainObject(entry.payload) || !boundedJson(entry.payload)
        || !RESTORABLE_STATUSES.has(entry.status)
        || (entry.timeoutMs !== null
            && (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0))
        || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))
        || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))
        || (entry.error !== null
            && (typeof entry.error !== 'string' || Buffer.byteLength(entry.error, 'utf8') > 64 * 1024))
        || (entry.result !== null && (!isPlainObject(entry.result) || !boundedJson(entry.result)))
        || (entry.logRetention !== 'full' && entry.logRetention !== 'bounded')
        || typeof entry.continuationTool !== 'string'
        || (entry.continuationTool !== '' && !TOOL_NAME_RE.test(entry.continuationTool))
        || typeof entry.logTail !== 'string'
        || Buffer.byteLength(entry.logTail, 'utf8') > (entry.logRetention === 'full'
            ? MAX_PERSISTED_VALUE_BYTES
            : maxLogTailBytes)
        || !Number.isSafeInteger(entry.logSeq) || entry.logSeq < 0
        || typeof entry.logTruncated !== 'boolean') {
        return false;
    }
    const commandKeys = Object.keys(entry.commandSpec);
    if (entry.commandSpec.kind === 'provider-module') {
        const allowed = new Set([
            'kind', 'provider', 'module', 'exportName', 'sandboxMode', 'timeoutMs',
        ]);
        return commandKeys.every((key) => allowed.has(key))
            && typeof entry.commandSpec.provider === 'string'
            && typeof entry.commandSpec.module === 'string'
            && typeof entry.commandSpec.exportName === 'string';
    }
    const allowed = new Set(['kind', 'command', 'args', 'cwd', 'env', 'timeoutMs']);
    return commandKeys.every((key) => allowed.has(key))
        && typeof entry.commandSpec.kind === 'string'
        && typeof entry.commandSpec.command === 'string'
        && Array.isArray(entry.commandSpec.args)
        && entry.commandSpec.args.every((argument) => typeof argument === 'string')
        && (entry.commandSpec.cwd === undefined || typeof entry.commandSpec.cwd === 'string')
        && isPlainObject(entry.commandSpec.env)
        && boundedJson(entry.commandSpec);
}

function taskQueueError(code, message, options) {
    const error = new Error(message, options);
    error.code = code;
    return error;
}

function isRetainedLifecycleFailure(error) {
    return error?.ownershipRetained === true
        || error?.code === 'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN'
        || error?.code === 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN'
        || error?.code === 'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED';
}

function hasExactProviderTerminationProof(error) {
    if (error?.ownershipRetained !== false || !Array.isArray(error.terminationEvidence)
        || error.terminationEvidence.length === 0) {
        return false;
    }
    return error.terminationEvidence.some((entry) => (
        entry && typeof entry === 'object'
        && entry.state === 'terminated'
        && (entry.phase === 'initial' || entry.terminal === true)
    ));
}

function parsePositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return fallback;
}

function normalizeContinuation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const handle = String(raw.handle || '').trim();
    const toolName = String(raw.toolName || '').trim();
    if (raw.version !== 1 || !CONTINUATION_HANDLE_RE.test(handle) || !TOOL_NAME_RE.test(toolName)) {
        return null;
    }
    return { version: 1, handle, toolName };
}

function commandResult(stdout) {
    const raw = typeof stdout === 'string' ? stdout : String(stdout ?? '');
    const trimmed = raw.trim();
    if (!trimmed) return { text: '(no output)', continuation: null };
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.outputText === 'string') {
            return {
                text: parsed.outputText || '(no output)',
                continuation: normalizeContinuation(parsed.continuation),
            };
        }
    } catch {
    }
    return { text: raw, continuation: null };
}

function cloneCommandSpec(commandSpec = {}) {
    if (commandSpec.kind === 'provider-module') {
        return {
            kind: 'provider-module',
            provider: commandSpec.provider,
            module: commandSpec.module,
            exportName: commandSpec.exportName,
            sandboxMode: commandSpec.sandboxMode,
            timeoutMs: commandSpec.timeoutMs,
        };
    }
    return {
        kind: commandSpec.kind || 'shell',
        command: commandSpec.command,
        args: Array.isArray(commandSpec.args) ? [...commandSpec.args] : [],
        cwd: commandSpec.cwd,
        env: commandSpec.env ? { ...commandSpec.env } : {},
        timeoutMs: commandSpec.timeoutMs,
    };
}

export class TaskQueue {
    constructor({
        maxConcurrent = 10,
        storagePath,
        executor,
        maxLogTailBytes = DEFAULT_MAX_LOG_TAIL_BYTES,
        cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
        closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
        processIdentityInspector = inspectProcessIdentity,
        signalProcessGroup = (pid, signal) => process.kill(-pid, signal),
        getUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
        fsImpl = fs,
    }) {
        if (typeof executor !== 'function') {
            throw new Error('TaskQueue requires an executor function');
        }
        this.maxConcurrent = maxConcurrent;
        this.storagePath = storagePath;
        this.executor = executor;
        this.maxLogTailBytes = parsePositiveInt(maxLogTailBytes, DEFAULT_MAX_LOG_TAIL_BYTES);
        this.cancelGraceMs = parsePositiveInt(cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);
        this.closeTimeoutMs = parsePositiveInt(closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
        if (typeof processIdentityInspector !== 'function'
            || typeof signalProcessGroup !== 'function' || typeof getUid !== 'function'
            || !fsImpl || typeof fsImpl !== 'object') {
            throw new Error('TaskQueue process identity dependencies are invalid');
        }
        this.processIdentityInspector = processIdentityInspector;
        this.signalProcessGroup = signalProcessGroup;
        this.getUid = getUid;
        this.fs = fsImpl;
        this.tasks = new Map();
        this.taskLogs = new Map();
        this.pending = [];
        this.running = new Set();
        this.activeChildren = new Map();
        this.activeProcessOwnership = new Map();
        this.activeAbortControllers = new Map();
        this.cancelTimers = new Map();
        this.lifecycleFailures = new Map();
        this.lifecycleFailure = null;
        this.initialized = false;
        this.admissionClosed = false;
        this.runPromises = new Map();
        this.closePromise = null;
        this.cleanupComplete = false;
        this.persistenceFailure = null;
    }

    syncLifecycleFailure() {
        this.lifecycleFailure = this.lifecycleFailures.values().next().value ?? null;
    }

    recordLifecycleFailure(record) {
        const taskId = record?.taskId ?? '__queue__';
        const previous = this.lifecycleFailures.get(taskId);
        const next = Object.freeze({
            ...(previous ?? {}),
            ...record,
            taskId,
            cleanupRetry: record?.cleanupRetry ?? previous?.cleanupRetry ?? null,
        });
        this.lifecycleFailures.set(taskId, next);
        this.syncLifecycleFailure();
        return next;
    }

    clearLifecycleFailure(taskId) {
        const key = taskId ?? '__queue__';
        this.lifecycleFailures.delete(key);
        this.activeChildren.delete(key);
        this.activeProcessOwnership.delete(key);
        this.syncLifecycleFailure();
    }

    initialize() {
        if (this.initialized) {
            return;
        }
        this.initialized = true;
        this.restoreFromDisk();
        let needsPersist = false;
        const restartable = [...this.tasks.values()].sort((a, b) => {
            const aTime = Date.parse(a.createdAt || 0);
            const bTime = Date.parse(b.createdAt || 0);
            return aTime - bTime;
        });
        for (const task of restartable) {
            if (task.status === 'cancelling') {
                task.status = 'cancelled';
                task.error = null;
                task.updatedAt = new Date().toISOString();
                task.result = null;
                needsPersist = true;
            } else if (task.status === 'pending' || task.status === 'running') {
                task.status = 'failed';
                task.error = 'Task interrupted before completion (agent restart)';
                task.updatedAt = new Date().toISOString();
                task.result = null;
                needsPersist = true;
            } else if (task.status === 'completed' || task.status === 'failed') {
                // leave as-is
            }
        }
        if (needsPersist) {
            this.persistTasks();
        }
        this.processQueue();
    }

    restoreFromDisk() {
        if (!this.storagePath) {
            return;
        }
        let descriptor = null;
        try {
            const uid = this.getUid();
            const parent = path.dirname(this.storagePath);
            if (!Number.isSafeInteger(uid) || uid < 0
                || this.fs.realpathSync(parent) !== path.resolve(parent)) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                    'TaskQueue persistence has an untrusted owner or symlinked ancestor',
                );
            }
            const parentStat = this.fs.lstatSync(parent);
            if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
                || parentStat.uid !== uid || (parentStat.mode & 0o022) !== 0) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                    'TaskQueue persistence parent ownership or mode is unsafe',
                );
            }
            const stat = this.fs.lstatSync(this.storagePath);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid
                || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
                || stat.size <= 0 || stat.size > MAX_PERSISTENCE_BYTES) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                    'TaskQueue persistence ownership, links, mode, or size are unsafe',
                );
            }
            descriptor = this.fs.openSync(
                this.storagePath,
                this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW ?? 0),
            );
            const openedStat = this.fs.fstatSync(descriptor);
            if (!openedStat.isFile() || openedStat.dev !== stat.dev || openedStat.ino !== stat.ino
                || openedStat.uid !== uid || openedStat.nlink !== 1
                || (openedStat.mode & 0o077) !== 0 || openedStat.size !== stat.size) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                    'TaskQueue persistence identity changed while opening',
                );
            }
            const raw = this.fs.readFileSync(descriptor, 'utf8');
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed) || parsed.length > MAX_PERSISTED_TASKS) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_INVALID',
                    'TaskQueue persistence root must be an array',
                );
            }
            for (const entry of parsed) {
                if (!exactPersistedTask(entry, this.maxLogTailBytes)
                    || this.tasks.has(entry.id)) {
                    throw taskQueueError(
                        'PLOINKY_TASK_QUEUE_PERSISTENCE_INVALID',
                        'TaskQueue persistence contains an invalid task record',
                    );
                }
                const task = {
                    id: entry.id,
                    toolName: entry.toolName,
                    commandSpec: cloneCommandSpec(entry.commandSpec),
                    payload: entry.payload,
                    status: entry.status,
                    timeoutMs: entry.timeoutMs ?? null,
                    logRetention: entry.logRetention === 'full' ? 'full' : 'bounded',
                    continuationTool: TOOL_NAME_RE.test(String(entry.continuationTool || '').trim())
                        ? String(entry.continuationTool).trim()
                        : '',
                    createdAt: entry.createdAt || new Date().toISOString(),
                    updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
                    error: entry.error ?? null,
                    result: entry.result ?? null,
                    logTail: typeof entry.logTail === 'string' ? entry.logTail : '',
                    logSeq: Number.isSafeInteger(entry.logSeq) && entry.logSeq >= 0 ? entry.logSeq : 0,
                    logTruncated: entry.logTruncated === true,
                };
                this.tasks.set(task.id, task);
                this.taskLogs.set(task.id, {
                    tail: task.logTail,
                    tailBytes: Buffer.byteLength(task.logTail, 'utf8'),
                    seq: task.logSeq,
                    truncated: task.logTruncated,
                });
            }
        } catch (err) {
            if (err?.code === 'ENOENT') return;
            const error = err?.code?.startsWith?.('PLOINKY_TASK_QUEUE_PERSISTENCE_')
                ? err
                : taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_INVALID',
                    'TaskQueue persistence could not be restored exactly',
                    { cause: err },
                );
            this.persistenceFailure = error;
            this.admissionClosed = true;
            throw error;
        } finally {
            if (descriptor !== null) this.fs.closeSync(descriptor);
        }
    }

    persistTasks() {
        if (!this.storagePath) {
            return;
        }
        if (this.persistenceFailure) throw this.persistenceFailure;
        const parent = path.dirname(this.storagePath);
        const basename = path.basename(this.storagePath);
        let temporaryPath = null;
        let descriptor = null;
        try {
            const uid = this.getUid();
            if (!Number.isSafeInteger(uid) || uid < 0
                || this.fs.realpathSync(parent) !== path.resolve(parent)) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                    'TaskQueue persistence has an untrusted owner or symlinked ancestor',
                );
            }
            const parentStat = this.fs.lstatSync(parent);
            if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
                || parentStat.uid !== uid || (parentStat.mode & 0o022) !== 0) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                    'TaskQueue persistence parent ownership or mode is unsafe',
                );
            }
            try {
                const current = this.fs.lstatSync(this.storagePath);
                if (current.isSymbolicLink() || !current.isFile() || current.uid !== uid
                    || current.nlink !== 1 || (current.mode & 0o077) !== 0
                    || current.size <= 0 || current.size > MAX_PERSISTENCE_BYTES) {
                    throw taskQueueError(
                        'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                        'TaskQueue persistence must be an exact regular file, never a symlink',
                    );
                }
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            const snapshot = [...this.tasks.values()].map(task => ({
                schemaVersion: PERSISTENCE_SCHEMA_VERSION,
                id: task.id,
                toolName: task.toolName,
                commandSpec: task.commandSpec,
                payload: task.payload,
                status: task.status,
                timeoutMs: task.timeoutMs,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
                error: task.error,
                result: task.result,
                logRetention: task.logRetention,
                continuationTool: task.continuationTool,
                logTail: task.logTail,
                logSeq: task.logSeq,
                logTruncated: task.logTruncated,
            }));
            const encoded = JSON.stringify(snapshot, null, 2);
            if (snapshot.length > MAX_PERSISTED_TASKS
                || snapshot.some((entry) => !exactPersistedTask(entry, this.maxLogTailBytes))
                || Buffer.byteLength(encoded, 'utf8') > MAX_PERSISTENCE_BYTES) {
                throw taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_INVALID',
                    'TaskQueue persistence snapshot exceeds exact bounds',
                );
            }
            temporaryPath = path.join(
                parent,
                `.${basename}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
            );
            descriptor = this.fs.openSync(
                temporaryPath,
                this.fs.constants.O_CREAT | this.fs.constants.O_EXCL | this.fs.constants.O_WRONLY
                    | (this.fs.constants.O_NOFOLLOW ?? 0),
                0o600,
            );
            this.fs.writeFileSync(descriptor, encoded, 'utf8');
            this.fs.fsyncSync(descriptor);
            this.fs.closeSync(descriptor);
            descriptor = null;
            try {
                const current = this.fs.lstatSync(this.storagePath);
                if (current.isSymbolicLink() || !current.isFile() || current.uid !== uid
                    || current.nlink !== 1 || (current.mode & 0o077) !== 0) {
                    throw taskQueueError(
                        'PLOINKY_TASK_QUEUE_PERSISTENCE_UNSAFE',
                        'TaskQueue persistence changed to an unsafe target before commit',
                    );
                }
            } catch (error) {
                if (error?.code !== 'ENOENT') throw error;
            }
            this.fs.renameSync(temporaryPath, this.storagePath);
            temporaryPath = null;
            const parentDescriptor = this.fs.openSync(parent, this.fs.constants.O_RDONLY);
            try { this.fs.fsyncSync(parentDescriptor); } finally { this.fs.closeSync(parentDescriptor); }
        } catch (err) {
            if (descriptor !== null) {
                try { this.fs.closeSync(descriptor); } catch { }
            }
            if (temporaryPath !== null) {
                try { this.fs.unlinkSync(temporaryPath); } catch { }
            }
            const error = err?.code?.startsWith?.('PLOINKY_TASK_QUEUE_PERSISTENCE_')
                ? err
                : taskQueueError(
                    'PLOINKY_TASK_QUEUE_PERSISTENCE_FAILED',
                    'TaskQueue persistence could not be committed atomically',
                    { cause: err },
                );
            this.persistenceFailure = error;
            this.admissionClosed = true;
            throw error;
        }
    }

    generateId() {
        return randomBytes(8).toString('hex');
    }

    createTaskLogState() {
        return {
            tail: '',
            tailBytes: 0,
            seq: 0,
            truncated: false
        };
    }

    getOrCreateTaskLogState(taskId) {
        let state = this.taskLogs.get(taskId);
        if (!state) {
            state = this.createTaskLogState();
            this.taskLogs.set(taskId, state);
        }
        return state;
    }

    syncTaskLogSnapshot(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            return;
        }
        const state = this.getOrCreateTaskLogState(taskId);
        task.logTail = state.tail;
        task.logSeq = state.seq;
        task.logTruncated = state.truncated;
    }

    appendTaskLog(taskId, chunk) {
        if (!taskId) {
            return;
        }
        const text = Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : (typeof chunk === 'string' ? chunk : String(chunk ?? ''));
        if (!text) {
            return;
        }

        const state = this.getOrCreateTaskLogState(taskId);
        state.seq += 1;
        state.tail += text;
        state.tailBytes += Buffer.byteLength(text, 'utf8');

        const task = this.tasks.get(taskId);
        if (task?.logRetention !== 'full' && state.tailBytes > this.maxLogTailBytes) {
            state.truncated = true;
            while (state.tailBytes > this.maxLogTailBytes && state.tail.length > 0) {
                const bytesToDrop = state.tailBytes - this.maxLogTailBytes;
                const charsToDrop = Math.max(1, Math.min(state.tail.length, bytesToDrop));
                const dropped = state.tail.slice(0, charsToDrop);
                state.tail = state.tail.slice(charsToDrop);
                state.tailBytes -= Buffer.byteLength(dropped, 'utf8');
            }
        }

        this.syncTaskLogSnapshot(taskId);
    }

    getTaskLogSnapshot(taskId) {
        const state = this.taskLogs.get(taskId);
        if (state) {
            return {
                tail: state.tail,
                seq: state.seq,
                truncated: state.truncated
            };
        }
        const task = this.tasks.get(taskId);
        return {
            tail: typeof task?.logTail === 'string' ? task.logTail : '',
            seq: Number.isFinite(task?.logSeq) ? task.logSeq : 0,
            truncated: task?.logTruncated === true
        };
    }

    enqueueTask({
        toolName,
        commandSpec,
        payload,
        timeoutMs,
        logRetention = 'bounded',
        continuationTool = '',
    }) {
        this.initialize();
        if (this.admissionClosed) {
            throw taskQueueError('PLOINKY_TASK_QUEUE_CLOSED', 'TaskQueue admission is closed');
        }
        if (this.lifecycleFailures.size > 0) {
            throw taskQueueError(
                'PLOINKY_TASK_QUEUE_CLEANUP_UNPROVEN',
                'TaskQueue admission is blocked until exact lifecycle cleanup is proven',
            );
        }
        if (commandSpec?.kind === 'provider-module'
            && PROVIDER_LOGIN_OPERATIONS.has(payload?.input?.operation)) {
            throw taskQueueError(
                'PLOINKY_PROVIDER_LOGIN_ASYNC_FORBIDDEN',
                'provider login operations cannot enter the persistent task queue',
            );
        }
        const id = this.generateId();
        const payloadWithId = { ...payload, taskId: id };
        const task = {
            id,
            toolName,
            commandSpec: cloneCommandSpec(commandSpec),
            payload: payloadWithId,
            timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
            logRetention: logRetention === 'full' ? 'full' : 'bounded',
            continuationTool: TOOL_NAME_RE.test(String(continuationTool || '').trim())
                ? String(continuationTool).trim()
                : '',
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            error: null,
            result: null,
            cancelRequested: false,
            logTail: '',
            logSeq: 0,
            logTruncated: false
        };
        this.tasks.set(task.id, task);
        this.taskLogs.set(task.id, this.createTaskLogState());
        this.pending.push(task.id);
        this.persistTasks();
        this.processQueue();
        return {
            id: task.id,
            toolName: task.toolName,
            status: task.status,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            logRetention: task.logRetention,
            ...(task.continuationTool ? {
                continuationCapability: {
                    version: 1,
                    toolName: task.continuationTool,
                },
            } : {}),
        };
    }

    processQueue() {
        if (this.lifecycleFailures.size > 0 || this.admissionClosed) return;
        while (this.running.size < this.maxConcurrent && this.pending.length > 0) {
            const nextId = this.pending.shift();
            if (!nextId) {
                continue;
            }
            const task = this.tasks.get(nextId);
            if (!task) {
                continue;
            }
            if (task.status !== 'pending') {
                continue;
            }
            this.startTask(task);
        }
    }

    inspectTaskProcess(pid) {
        try {
            return Object.freeze({ inspected: this.processIdentityInspector(pid), cause: null });
        } catch (cause) {
            return Object.freeze({ inspected: null, cause });
        }
    }

    captureTaskProcessOwnership(child) {
        const pid = Number(child.pid);
        const uid = this.getUid();
        const observation = this.inspectTaskProcess(pid);
        const inspected = observation.inspected;
        let processIdentity = null;
        try { processIdentity = normalizeProcessIdentity(inspected?.processIdentity); } catch (_) { }
        if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0
            || inspected?.state !== 'identified' || inspected.processUid !== uid || !processIdentity) {
            const error = new Error('TaskQueue cannot capture a boot-bound same-UID child identity');
            error.code = 'PLOINKY_TASK_PROCESS_IDENTITY_UNVERIFIED';
            error.cause = observation.cause ?? undefined;
            error.evidence = Object.freeze({
                pid: Number.isSafeInteger(pid) ? pid : null,
                state: observation.cause ? 'inspector-error' : (inspected?.state ?? 'invalid'),
            });
            throw error;
        }
        return Object.freeze({ pid, processIdentity, processUid: uid });
    }

    signalTaskProcess(taskId, signal) {
        const ownership = this.activeProcessOwnership.get(taskId);
        if (!ownership) {
            const error = new Error('TaskQueue has no verified child identity to signal');
            error.code = 'PLOINKY_TASK_PROCESS_IDENTITY_UNVERIFIED';
            error.evidence = Object.freeze({ taskId, signal, state: 'missing' });
            throw error;
        }
        const observation = this.inspectTaskProcess(ownership.pid);
        const inspected = observation.inspected;
        if (inspected?.state === 'dead') return false;
        let processIdentity = null;
        try { processIdentity = normalizeProcessIdentity(inspected?.processIdentity); } catch (_) { }
        if (inspected?.state === 'identified' && processIdentity !== ownership.processIdentity) return false;
        if (inspected?.state !== 'identified' || inspected.processUid !== ownership.processUid
            || processIdentity !== ownership.processIdentity) {
            const error = new Error(`TaskQueue refuses ${signal} for an unverified or UID-diverged child`);
            error.code = 'PLOINKY_TASK_PROCESS_IDENTITY_UNVERIFIED';
            error.cause = observation.cause ?? undefined;
            error.evidence = Object.freeze({
                taskId,
                pid: ownership.pid,
                signal,
                state: observation.cause ? 'inspector-error' : (inspected?.state ?? 'invalid'),
            });
            throw error;
        }
        try {
            this.signalProcessGroup(ownership.pid, signal);
            return true;
        } catch (cause) {
            const afterObservation = this.inspectTaskProcess(ownership.pid);
            const after = afterObservation.inspected;
            if (after?.state === 'dead') return false;
            let afterIdentity = null;
            try { afterIdentity = normalizeProcessIdentity(after?.processIdentity); } catch (_) { }
            if (after?.state === 'identified' && afterIdentity !== ownership.processIdentity) return false;
            const error = new Error(`TaskQueue ${signal} delivery failed`);
            error.code = 'PLOINKY_TASK_PROCESS_SIGNAL_FAILED';
            error.cause = cause;
            error.evidence = Object.freeze({
                taskId,
                pid: ownership.pid,
                signal,
                state: afterObservation.cause ? 'inspector-error' : (after?.state ?? 'invalid'),
            });
            throw error;
        }
    }

    taskProcessOwnershipReleased(taskId) {
        const ownership = this.activeProcessOwnership.get(taskId);
        if (!ownership) return false;
        const observation = this.inspectTaskProcess(ownership.pid);
        const inspected = observation.inspected;
        if (inspected?.state === 'dead') return true;
        let processIdentity = null;
        try { processIdentity = normalizeProcessIdentity(inspected?.processIdentity); } catch (_) { }
        return inspected?.state === 'identified'
            && processIdentity !== null
            && processIdentity !== ownership.processIdentity;
    }

    reconcileTaskTerminationFailure(task) {
        if (!task?.terminationFailure || !this.taskProcessOwnershipReleased(task.id)) return false;
        task.terminationFailure = null;
        return true;
    }

    requestRunningTaskCancellation(task, child) {
        if (!task || !child) return;
        if (task.commandSpec?.kind === 'provider-module') {
            return;
        }
        try { this.signalTaskProcess(task.id, 'SIGTERM'); } catch (error) {
            task.terminationFailure = Object.freeze({
                code: error.code || 'PLOINKY_TASK_PROCESS_SIGNAL_FAILED',
                evidence: error.evidence ?? null,
            });
        }
        if (this.cancelTimers.has(task.id)) return;
        const timer = setTimeout(() => {
            this.cancelTimers.delete(task.id);
            const activeChild = this.activeChildren.get(task.id);
            if (activeChild) {
                try { this.signalTaskProcess(task.id, 'SIGKILL'); } catch (error) {
                    task.terminationFailure = Object.freeze({
                        code: error.code || 'PLOINKY_TASK_PROCESS_SIGNAL_FAILED',
                        evidence: error.evidence ?? null,
                    });
                }
            }
        }, this.cancelGraceMs);
        timer.unref?.();
        this.cancelTimers.set(task.id, timer);
    }

    cancelTask(taskId) {
        this.initialize();
        const task = this.tasks.get(String(taskId || ''));
        if (!task) return null;
        if (TERMINAL_STATUSES.has(task.status)) return this.getTask(task.id);
        task.cancelRequested = true;
        task.error = null;
        task.updatedAt = new Date().toISOString();
        if (task.status === 'pending') {
            this.pending = this.pending.filter((candidate) => candidate !== task.id);
            task.status = 'cancelled';
            this.persistTasks();
            this.processQueue();
            return this.getTask(task.id);
        }
        task.status = 'cancelling';
        this.persistTasks();
        this.activeAbortControllers.get(task.id)?.abort();
        const child = this.activeChildren.get(task.id);
        if (child) this.requestRunningTaskCancellation(task, child);
        return this.getTask(task.id);
    }

    startTask(task) {
        if (!task) {
            return;
        }
        task.status = 'running';
        task.updatedAt = new Date().toISOString();
        this.running.add(task.id);
        this.persistTasks();
        const runPromise = this.executeTask(task);
        this.runPromises.set(task.id, runPromise);
        runPromise.finally(() => {
            this.runPromises.delete(task.id);
            this.running.delete(task.id);
            if (task.status === 'pending') {
                if (!this.pending.includes(task.id)) {
                    this.pending.push(task.id);
                }
            }
            this.processQueue();
        }).catch((err) => {
            console.error('[AgentServer/MCP] Task execution failed:', err);
        });
    }

    async executeTask(task) {
        let timer = null;
        let timedOut = false;
        let spawnAdmissionFailure = null;
        let spawnTerminalObserved = false;
        let unverifiedSpawnChild = null;
        let retainedCleanupRetry = null;
        const abortController = new AbortController();
        this.activeAbortControllers.set(task.id, abortController);
        try {
            if (!task.commandSpec || (task.commandSpec.kind === 'provider-module'
                ? !task.commandSpec.module
                : !task.commandSpec.command)) {
                throw new Error('Missing command specification for task');
            }
            const forwardToHostLog = (target, chunk) => {
                try {
                    target.write(chunk);
                } catch (_) {
                    // Ignore log forwarding failures.
                }
            };
            const result = await this.executor(task.commandSpec, task.payload, {
                onSpawn: (child) => {
                    this.activeChildren.set(task.id, child);
                    if (task.commandSpec.kind !== 'provider-module') {
                        try {
                            const ownership = this.captureTaskProcessOwnership(child);
                            this.activeProcessOwnership.set(task.id, ownership);
                        } catch (error) {
                            spawnAdmissionFailure = error;
                            unverifiedSpawnChild = child;
                            child?.once?.('close', () => {
                                spawnTerminalObserved = true;
                                const retained = this.lifecycleFailures.get(task.id);
                                if (retained?.phase === 'spawn-admission'
                                    && retained.child === child) {
                                    this.clearLifecycleFailure(task.id);
                                    this.processQueue();
                                }
                            });
                            throw error;
                        }
                    }
                    if (task.cancelRequested) {
                        this.requestRunningTaskCancellation(task, child);
                    }
                    if (Number.isFinite(task.timeoutMs) && task.timeoutMs > 0) {
                        timer = setTimeout(() => {
                            if (!child.killed) {
                                timedOut = true;
                                if (task.commandSpec.kind === 'provider-module') {
                                    abortController.abort(taskQueueError(
                                        'PLOINKY_TASK_TIMEOUT',
                                        `Task timed out after ${task.timeoutMs}ms`,
                                    ));
                                }
                                this.requestRunningTaskCancellation(task, child);
                            }
                        }, task.timeoutMs);
                    }
                },
                onStdoutChunk: () => {
                    // Stdout is the command result channel. It is intentionally
                    // excluded from live logs so structured wrapper metadata does
                    // not leak into task presentation.
                },
                onStderrChunk: (chunk) => {
                    forwardToHostLog(process.stderr, chunk);
                    this.appendTaskLog(task.id, chunk);
                },
                detached: true,
                signal: abortController.signal,
                onRetainedCleanup: (cleanup) => {
                    if (retainedCleanupRetry || typeof cleanup !== 'function') {
                        throw taskQueueError(
                            'PLOINKY_TASK_QUEUE_CLEANUP_INVALID',
                            'executor retained cleanup registration is invalid',
                        );
                    }
                    retainedCleanupRetry = cleanup;
                },
            });

            if (timer) {
                clearTimeout(timer);
            }

            this.reconcileTaskTerminationFailure(task);

            const success = !timedOut && result.code === 0;
            const parsedResult = commandResult(result.stdout);
            const continuation = task.continuationTool
                && parsedResult.continuation?.toolName === task.continuationTool
                ? parsedResult.continuation
                : null;
            if ((task.cancelRequested || task.status === 'cancelling') && task.terminationFailure) {
                task.status = 'failed';
                task.error = `${task.terminationFailure.code}: exact task termination was not proven`;
                task.result = null;
                this.recordLifecycleFailure({
                    phase: 'process-termination',
                    taskId: task.id,
                    child: this.activeChildren.get(task.id) ?? null,
                    error: task.terminationFailure,
                });
            } else if (task.cancelRequested || task.status === 'cancelling') {
                task.status = 'cancelled';
                task.error = null;
                task.result = continuation
                    ? {
                        content: [],
                        metadata: {
                            agent: process.env.AGENT_NAME || task.toolName,
                            continuation,
                        },
                    }
                    : null;
            } else if (success) {
                const content = [{ type: 'text', text: parsedResult.text }];
                task.status = 'completed';
                task.result = {
                    content,
                    metadata: {
                        agent: process.env.AGENT_NAME || task.toolName,
                        ...(continuation ? { continuation } : {}),
                    }
                };
                task.error = null;
            } else {
                const message = timedOut
                    ? `Task timed out after ${task.timeoutMs}ms`
                    : describeShellFailure(result);
                task.status = 'failed';
                task.error = message;
                task.result = continuation
                    ? {
                        content: [],
                        metadata: {
                            agent: process.env.AGENT_NAME || task.toolName,
                            continuation,
                        },
                    }
                    : null;
            }
        } catch (err) {
            if (timer) {
                clearTimeout(timer);
            }
            this.reconcileTaskTerminationFailure(task);
            if (spawnAdmissionFailure) {
                const cleanupProven = spawnTerminalObserved || hasExactProviderTerminationProof(err);
                const failure = isRetainedLifecycleFailure(err) ? err : spawnAdmissionFailure;
                task.status = 'failed';
                task.error = `${err?.code || spawnAdmissionFailure.code}: ${err?.message || spawnAdmissionFailure.message}`;
                task.result = null;
                if (!cleanupProven) {
                    this.recordLifecycleFailure({
                        phase: 'spawn-admission',
                        taskId: task.id,
                        child: unverifiedSpawnChild,
                        error: failure,
                        cleanupRetry: retainedCleanupRetry,
                    });
                }
            } else if (isRetainedLifecycleFailure(err)) {
                task.status = 'failed';
                task.error = `${err.code || 'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED'}: ${err.message || 'exact provider cleanup was not proven'}`;
                task.result = null;
                this.recordLifecycleFailure({
                    phase: 'retained-cleanup',
                    taskId: task.id,
                    child: this.activeChildren.get(task.id) ?? null,
                    error: err,
                    cleanupRetry: retainedCleanupRetry,
                });
            } else if ((task.cancelRequested || task.status === 'cancelling') && task.terminationFailure) {
                task.status = 'failed';
                task.error = `${task.terminationFailure.code}: exact task termination was not proven`;
                task.result = null;
                this.recordLifecycleFailure({
                    phase: 'process-termination',
                    taskId: task.id,
                    child: this.activeChildren.get(task.id) ?? null,
                    error: task.terminationFailure,
                });
            } else if (task.cancelRequested || task.status === 'cancelling') {
                task.status = 'cancelled';
                task.error = null;
                task.result = null;
            } else {
                task.status = 'failed';
                task.error = err?.code
                    ? `${err.code}: ${err.message || 'Task execution failed'}`
                    : (err?.message || 'Task execution failed');
                task.result = null;
            }
        } finally {
            const retained = this.lifecycleFailures.get(task.id);
            if (retained?.phase === 'close-timeout') {
                this.clearLifecycleFailure(task.id);
            } else if (!retained) {
                this.activeChildren.delete(task.id);
                this.activeProcessOwnership.delete(task.id);
            }
            this.activeAbortControllers.delete(task.id);
            const cancelTimer = this.cancelTimers.get(task.id);
            if (cancelTimer) clearTimeout(cancelTimer);
            this.cancelTimers.delete(task.id);
            task.updatedAt = new Date().toISOString();
            this.persistTasks();
        }
    }

    async close() {
        this.initialize();
        this.admissionClosed = true;
        if (this.cleanupComplete) return;
        if (!this.closePromise) {
            this.closePromise = (async () => {
                for (const taskId of [...this.pending]) this.cancelTask(taskId);
                for (const taskId of [...this.running]) this.cancelTask(taskId);
                let timer = null;
                const timedOut = Symbol('task-queue-close-timeout');
                const outcome = await Promise.race([
                    Promise.all([...this.runPromises.values()].map((promise) => promise.catch(() => {}))),
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve(timedOut), this.closeTimeoutMs);
                        timer.unref?.();
                    }),
                ]);
                if (timer) clearTimeout(timer);
                if (outcome === timedOut) {
                    const error = taskQueueError(
                        'PLOINKY_TASK_QUEUE_CLEANUP_UNPROVEN',
                        'TaskQueue shutdown deadline expired before exact active cleanup',
                    );
                    error.ownershipRetained = true;
                    error.evidence = Object.freeze({
                        running: this.running.size,
                        activeChildren: this.activeChildren.size,
                        activeProcessOwnership: this.activeProcessOwnership.size,
                        runPromises: this.runPromises.size,
                    });
                    this.recordLifecycleFailure({
                        phase: 'close-timeout',
                        taskId: [...this.running][0] ?? null,
                        child: this.activeChildren.values().next().value ?? null,
                        error,
                    });
                    throw error;
                }
                if (this.lifecycleFailures.size > 0) {
                    const retained = [...this.lifecycleFailures.entries()];
                    const results = await Promise.allSettled(retained.map(([, failure]) => (
                        failure.cleanupRetry
                            ? failure.cleanupRetry()
                            : Promise.reject(failure.error)
                    )));
                    const unresolved = [];
                    for (let index = 0; index < retained.length; index += 1) {
                        const [taskId, failure] = retained[index];
                        const result = results[index];
                        if (result.status === 'fulfilled') {
                            this.clearLifecycleFailure(taskId);
                        } else {
                            const updated = this.recordLifecycleFailure({
                                ...failure,
                                taskId,
                                error: result.reason,
                            });
                            unresolved.push(updated.error);
                        }
                    }
                    if (unresolved.length === 1) throw unresolved[0];
                    if (unresolved.length > 1) {
                        const error = new AggregateError(
                            unresolved,
                            'TaskQueue retained cleanup retries remain unproven',
                            { cause: unresolved[0] },
                        );
                        error.code = 'PLOINKY_TASK_QUEUE_CLEANUP_UNPROVEN';
                        error.ownershipRetained = true;
                        throw error;
                    }
                }
                if (this.running.size !== 0 || this.activeChildren.size !== 0
                    || this.activeProcessOwnership.size !== 0 || this.activeAbortControllers.size !== 0) {
                    throw taskQueueError(
                        'PLOINKY_TASK_QUEUE_CLEANUP_UNPROVEN',
                        'TaskQueue shutdown could not prove exact active cleanup',
                    );
                }
                this.cleanupComplete = true;
            })();
        }
        try {
            await this.closePromise;
        } finally {
            if (!this.cleanupComplete) this.closePromise = null;
        }
    }

    getTask(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) {
            return null;
        }
        const logSnapshot = this.getTaskLogSnapshot(task.id);
        return {
            id: task.id,
            toolName: task.toolName,
            status: task.status,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            error: task.error,
            result: task.result,
            logTail: logSnapshot.tail,
            logSeq: logSnapshot.seq,
            logTruncated: logSnapshot.truncated
        };
    }
}
