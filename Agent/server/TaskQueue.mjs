import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { describeShellFailure } from '../lib/toolError.mjs';

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

export class TaskQueue {
    constructor({
        maxConcurrent = 10,
        storagePath,
        executor,
        maxLogTailBytes = DEFAULT_MAX_LOG_TAIL_BYTES,
        cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
    }) {
        if (typeof executor !== 'function') {
            throw new Error('TaskQueue requires an executor function');
        }
        this.maxConcurrent = maxConcurrent;
        this.storagePath = storagePath;
        this.executor = executor;
        this.maxLogTailBytes = parsePositiveInt(maxLogTailBytes, DEFAULT_MAX_LOG_TAIL_BYTES);
        this.cancelGraceMs = parsePositiveInt(cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);
        this.tasks = new Map();
        this.taskLogs = new Map();
        this.pending = [];
        this.running = new Set();
        this.activeChildren = new Map();
        this.cancelTimers = new Map();
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
                        commandSpec: {
                            command: commandSpec.command,
                            args: Array.isArray(commandSpec.args) ? [...commandSpec.args] : [],
                            cwd: commandSpec.cwd,
                            env: commandSpec.env ? { ...(commandSpec.env) } : {},
                            timeoutMs: commandSpec.timeoutMs,
                        },
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
            commandSpec: {
                command: commandSpec.command,
                args: Array.isArray(commandSpec.args)
                    ? [...commandSpec.args]
                    : [],
                cwd: commandSpec.cwd,
                env: { ...(commandSpec.env || {}) },
                timeoutMs: commandSpec.timeoutMs
            },
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

    signalTaskProcess(child, signal) {
        if (!child) return false;
        const pid = Number(child.pid);
        if (Number.isInteger(pid) && pid > 0 && process.platform !== 'win32') {
            try {
                process.kill(-pid, signal);
                return true;
            } catch (_) {
            }
        }
        try {
            return child.kill(signal) !== false;
        } catch (_) {
            return false;
        }
    }

    requestRunningTaskCancellation(task, child) {
        if (!task || !child) return;
        this.signalTaskProcess(child, 'SIGTERM');
        if (this.cancelTimers.has(task.id)) return;
        const timer = setTimeout(() => {
            this.cancelTimers.delete(task.id);
            const activeChild = this.activeChildren.get(task.id);
            if (activeChild) this.signalTaskProcess(activeChild, 'SIGKILL');
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
        try {
            if (!task.commandSpec || !task.commandSpec.command) {
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
                    if (task.cancelRequested) {
                        this.requestRunningTaskCancellation(task, child);
                    }
                    if (Number.isFinite(task.timeoutMs) && task.timeoutMs > 0) {
                        timer = setTimeout(() => {
                            if (!child.killed) {
                                timedOut = true;
                                try {
                                    this.signalTaskProcess(child, 'SIGKILL');
                                } catch (err) {
                                    console.error('[AgentServer/MCP] Failed to kill timed-out task:', err);
                                }
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
            if (task.cancelRequested || task.status === 'cancelling') {
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
            if (task.cancelRequested || task.status === 'cancelling') {
                task.status = 'cancelled';
                task.error = null;
                task.result = null;
            } else {
                task.status = 'failed';
                task.error = err?.message || 'Task execution failed';
                task.result = null;
            }
        } finally {
            this.activeChildren.delete(task.id);
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
