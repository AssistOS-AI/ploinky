import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { describeShellFailure } from '../lib/toolError.mjs';
import { inspectProcessIdentity, normalizeProcessIdentity } from '../lib/processIdentity.mjs';

const DEFAULT_MAX_LOG_TAIL_BYTES = 128 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 2000;
const CONTINUATION_HANDLE_RE = /^[A-Za-z0-9_-]{16,200}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9._-]{1,160}$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

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
        processIdentityInspector = inspectProcessIdentity,
        signalProcessGroup = (pid, signal) => process.kill(-pid, signal),
        getUid = () => (typeof process.getuid === 'function' ? process.getuid() : null),
    }) {
        if (typeof executor !== 'function') {
            throw new Error('TaskQueue requires an executor function');
        }
        this.maxConcurrent = maxConcurrent;
        this.storagePath = storagePath;
        this.executor = executor;
        this.maxLogTailBytes = parsePositiveInt(maxLogTailBytes, DEFAULT_MAX_LOG_TAIL_BYTES);
        this.cancelGraceMs = parsePositiveInt(cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);
        if (typeof processIdentityInspector !== 'function'
            || typeof signalProcessGroup !== 'function' || typeof getUid !== 'function') {
            throw new Error('TaskQueue process identity dependencies are invalid');
        }
        this.processIdentityInspector = processIdentityInspector;
        this.signalProcessGroup = signalProcessGroup;
        this.getUid = getUid;
        this.tasks = new Map();
        this.taskLogs = new Map();
        this.pending = [];
        this.running = new Set();
        this.activeChildren = new Map();
        this.activeProcessOwnership = new Map();
        this.activeAbortControllers = new Map();
        this.cancelTimers = new Map();
        this.lifecycleFailure = null;
        this.initialized = false;
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
        try {
            const raw = fs.readFileSync(this.storagePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                for (const entry of parsed) {
                    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
                        continue;
                    }
                    const commandSpec = entry.commandSpec || {};
                    const task = {
                        id: entry.id,
                        toolName: entry.toolName,
                        commandSpec: cloneCommandSpec(commandSpec),
                        payload: entry.payload,
                        status: entry.status || 'pending',
                        timeoutMs: entry.timeoutMs ?? null,
                        logRetention: entry.logRetention === 'full' ? 'full' : 'bounded',
                        continuationTool: TOOL_NAME_RE.test(String(entry.continuationTool || '').trim())
                            ? String(entry.continuationTool).trim()
                            : '',
                        createdAt: entry.createdAt || new Date().toISOString(),
                        updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
                        error: entry.error ?? null,
                        result: null,
                        logTail: '',
                        logSeq: 0,
                        logTruncated: false
                    };
                    this.tasks.set(task.id, task);
                }
            }
        } catch (err) {
            if (err?.code !== 'ENOENT') {
                console.error('[AgentServer/MCP] Failed to restore task queue:', err);
            }
        }
    }

    persistTasks() {
        if (!this.storagePath) {
            return;
        }
        try {
            const snapshot = [...this.tasks.values()].map(task => ({
                id: task.id,
                toolName: task.toolName,
                commandSpec: task.commandSpec,
                payload: task.payload,
                status: task.status,
                timeoutMs: task.timeoutMs,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
                error: task.error,
                logRetention: task.logRetention,
                continuationTool: task.continuationTool,
            }));
            fs.writeFileSync(this.storagePath, JSON.stringify(snapshot, null, 2));
        } catch (err) {
            console.error('[AgentServer/MCP] Failed to persist task queue:', err);
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
        if (this.lifecycleFailure) return;
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

    requestRunningTaskCancellation(task, child) {
        if (!task || !child) return;
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
        runPromise.finally(() => {
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
                    try {
                        const ownership = this.captureTaskProcessOwnership(child);
                        this.activeProcessOwnership.set(task.id, ownership);
                    } catch (error) {
                        this.lifecycleFailure = Object.freeze({ taskId: task.id, child, error });
                        throw error;
                    }
                    if (task.cancelRequested) {
                        this.requestRunningTaskCancellation(task, child);
                    }
                    if (Number.isFinite(task.timeoutMs) && task.timeoutMs > 0) {
                        timer = setTimeout(() => {
                            if (!child.killed) {
                                timedOut = true;
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
            });

            if (timer) {
                clearTimeout(timer);
            }

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
                this.lifecycleFailure ||= Object.freeze({
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
            if ((task.cancelRequested || task.status === 'cancelling') && task.terminationFailure) {
                task.status = 'failed';
                task.error = `${task.terminationFailure.code}: exact task termination was not proven`;
                task.result = null;
                this.lifecycleFailure ||= Object.freeze({
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
            if (this.lifecycleFailure?.taskId !== task.id) {
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
