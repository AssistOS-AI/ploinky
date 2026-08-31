import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

import { TaskQueue } from '../../Agent/server/TaskQueue.mjs';

function makeTempStorage(t) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'task-queue-test-'));
    const storagePath = path.join(dir, 'queue.json');
    t.after(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    return storagePath;
}

function dummyTaskConfig(payload = {}) {
    return {
        toolName: 'demo',
        commandSpec: { command: '/bin/true', cwd: '/', env: {} },
        payload,
        timeoutMs: null
    };
}

async function waitFor(predicate, timeout = 1000, interval = 10) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = predicate();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error('Timed out waiting for condition');
}

test('TaskQueue transitions from pending to running and completed', async (t) => {
    const storagePath = makeTempStorage(t);
    const executions = [];

    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, payload) => new Promise(resolve => {
            executions.push({ payload, resolve });
        })
    });

    const { id } = queue.enqueueTask(dummyTaskConfig({ job: 'one' }));

    await waitFor(() => executions.length === 1);
    const runningTask = queue.getTask(id);
    assert.equal(runningTask?.status, 'running');
    assert.equal(executions[0].payload.taskId, id, 'taskId injected into payload');

    executions[0].resolve({ code: 0, stdout: 'ok', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'completed');

    const completed = queue.getTask(id);
    assert.equal(completed?.result?.content?.[0]?.text, 'ok');
    assert.equal(completed?.error, null);
});

test('TaskQueue honors maxConcurrent and leaves later tasks pending until slots free', async (t) => {
    const storagePath = makeTempStorage(t);
    const completions = [];
    const started = [];

    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, payload) => new Promise(resolve => {
            started.push(payload.taskId);
            completions.push(resolve);
        })
    });

    const first = queue.enqueueTask(dummyTaskConfig({ order: 1 })).id;
    const second = queue.enqueueTask(dummyTaskConfig({ order: 2 })).id;

    await waitFor(() => started.length === 1);
    assert.equal(started[0], first);
    assert.equal(queue.getTask(second)?.status, 'pending');

    completions[0]({ code: 0, stdout: 'done', stderr: '' });
    await waitFor(() => started.length === 2);
    assert.equal(started[1], second);
    assert.equal(queue.getTask(first)?.status, 'completed');
    assert.equal(queue.getTask(second)?.status, 'running');

    completions[1]({ code: 0, stdout: 'done', stderr: '' });
    await waitFor(() => queue.getTask(second)?.status === 'completed');
});

test('TaskQueue captures task failures and surfaces stderr', async (t) => {
    const storagePath = makeTempStorage(t);

    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: async () => ({ code: 1, stdout: '', stderr: 'boom' })
    });

    const { id } = queue.enqueueTask(dummyTaskConfig({ job: 'fail' }));
    await waitFor(() => queue.getTask(id)?.status === 'failed');

    const failed = queue.getTask(id);
    assert.equal(failed?.error, 'boom');
});

test('TaskQueue preserves async command args across queue persistence', async (t) => {
    const storagePath = makeTempStorage(t);
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, _payload, options = {}) => {
            options.onStdoutChunk?.('ok');
            return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' });
        }
    });

    const { id } = queue.enqueueTask({
        toolName: 'execute-task',
        commandSpec: { command: '/usr/bin/node', args: ['/tmp/script.mjs'], cwd: '/code', env: {} },
        payload: { prompt: 'test' },
    });

    const snapshot = JSON.parse(readFileSync(storagePath, 'utf8'));
    const restoredEntry = snapshot.find((entry) => entry?.id === id);

    assert.deepEqual(restoredEntry?.commandSpec?.args, ['/tmp/script.mjs']);
    assert.equal(restoredEntry?.toolName, 'execute-task');
});

test('TaskQueue exposes stderr as live logs without leaking stdout result payloads', async (t) => {
    const storagePath = makeTempStorage(t);
    const completions = [];

    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, _payload, options = {}) => new Promise(resolve => {
            options.onStdoutChunk?.('step 1\n');
            options.onStderrChunk?.('step 2\n');
            completions.push(resolve);
        })
    });

    const { id } = queue.enqueueTask(dummyTaskConfig({ job: 'logs' }));

    const runningTask = await waitFor(() => {
        const task = queue.getTask(id);
        return task?.status === 'running' && task?.logSeq >= 1 ? task : null;
    });

    assert.match(runningTask.logTail, /step 2/);
    assert.doesNotMatch(runningTask.logTail, /step 1/);
    assert.equal(runningTask.logTruncated, false);

    completions[0]({ code: 0, stdout: 'done', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'completed');

    const completed = queue.getTask(id);
    assert.ok(completed.logSeq >= 1);
    assert.doesNotMatch(completed.logTail, /step 1/);
});

test('TaskQueue exposes only outputText from structured command results', async (t) => {
    const storagePath = makeTempStorage(t);
    const stdout = JSON.stringify({
        ok: true,
        outputText: 'Final assistant answer',
        projectDir: '/workspace/project',
        model: '',
    });

    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: async (_spec, _payload, options = {}) => {
            options.onStdoutChunk?.(stdout);
            options.onStderrChunk?.('live agent output\n');
            return { code: 0, stdout, stderr: 'live agent output\n' };
        },
    });

    const { id } = queue.enqueueTask(dummyTaskConfig({ job: 'structured-result' }));
    await waitFor(() => queue.getTask(id)?.status === 'completed');

    const completed = queue.getTask(id);
    assert.deepEqual(completed.result.content, [
        { type: 'text', text: 'Final assistant answer' },
    ]);
    assert.equal(completed.logTail, 'live agent output\n');
    assert.doesNotMatch(completed.logTail, /projectDir|outputText/);
});

test('TaskQueue propagates a validated continuation and retains full logs', async (t) => {
    const storagePath = makeTempStorage(t);
    const stdout = JSON.stringify({
        outputText: 'Done',
        continuation: {
            version: 1,
            handle: '12345678-1234-4123-8123-123456789abc',
            toolName: 'continue-task',
        },
    });
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        maxLogTailBytes: 8,
        executor: async (_spec, _payload, options = {}) => {
            options.onStderrChunk?.('more than eight bytes');
            return { code: 0, stdout, stderr: '' };
        },
    });

    const { id, continuationCapability, logRetention } = queue.enqueueTask({
        ...dummyTaskConfig(),
        logRetention: 'full',
        continuationTool: 'continue-task',
    });
    await waitFor(() => queue.getTask(id)?.status === 'completed');

    const task = queue.getTask(id);
    assert.equal(logRetention, 'full');
    assert.deepEqual(continuationCapability, { version: 1, toolName: 'continue-task' });
    assert.equal(task.logTail, 'more than eight bytes');
    assert.equal(task.logTruncated, false);
    assert.deepEqual(task.result.metadata.continuation, {
        version: 1,
        handle: '12345678-1234-4123-8123-123456789abc',
        toolName: 'continue-task',
    });
});

test('TaskQueue preserves a validated continuation when the provider task fails', async (t) => {
    const storagePath = makeTempStorage(t);
    const stdout = JSON.stringify({
        outputText: 'Provider rejected the configured model.',
        continuation: {
            version: 1,
            handle: '12345678-1234-4123-8123-123456789abc',
            toolName: 'continue-task',
        },
    });
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: async () => ({
            code: 1,
            stdout,
            stderr: 'insufficient credits',
        }),
    });

    const { id } = queue.enqueueTask({
        ...dummyTaskConfig(),
        continuationTool: 'continue-task',
    });
    await waitFor(() => queue.getTask(id)?.status === 'failed');

    const task = queue.getTask(id);
    assert.equal(task.error, 'insufficient credits');
    assert.deepEqual(task.result.content, []);
    assert.deepEqual(task.result.metadata.continuation, {
        version: 1,
        handle: '12345678-1234-4123-8123-123456789abc',
        toolName: 'continue-task',
    });
});

test('TaskQueue cancels queued work without starting it', async (t) => {
    const storagePath = makeTempStorage(t);
    const executions = [];
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, payload) => new Promise((resolve) => {
            executions.push({ taskId: payload.taskId, resolve });
        }),
    });
    const runningId = queue.enqueueTask(dummyTaskConfig({ order: 1 })).id;
    const queuedId = queue.enqueueTask(dummyTaskConfig({ order: 2 })).id;
    await waitFor(() => executions.length === 1);

    assert.equal(queue.cancelTask(queuedId)?.status, 'cancelled');
    executions[0].resolve({ code: 0, stdout: 'done', stderr: '' });
    await waitFor(() => queue.getTask(runningId)?.status === 'completed');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(executions.length, 1);
    assert.equal(queue.getTask(queuedId)?.status, 'cancelled');
});

test('TaskQueue keeps a running task in cancelling until cleanup returns its continuation', async (t) => {
    const storagePath = makeTempStorage(t);
    const signals = [];
    let complete;
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
            complete = resolve;
            options.onSpawn?.({
                pid: null,
                kill(signal) {
                    signals.push(signal);
                    return true;
                },
            });
        }),
    });
    const { id } = queue.enqueueTask({
        ...dummyTaskConfig(),
        continuationTool: 'continue-task',
    });
    await waitFor(() => queue.getTask(id)?.status === 'running');

    assert.equal(queue.cancelTask(id)?.status, 'cancelling');
    assert.deepEqual(signals, ['SIGTERM']);
    complete({
        code: 1,
        stderr: 'cancelled',
        stdout: JSON.stringify({
            outputText: '',
            continuation: {
                version: 1,
                handle: '12345678-1234-4123-8123-123456789abc',
                toolName: 'continue-task',
            },
        }),
    });
    await waitFor(() => queue.getTask(id)?.status === 'cancelled');

    assert.equal(queue.getTask(id)?.error, null);
    assert.equal(
        queue.getTask(id)?.result?.metadata?.continuation?.handle,
        '12345678-1234-4123-8123-123456789abc',
    );
});

test('TaskQueue force-kills cleanup that exceeds the cancellation grace period', async (t) => {
    const storagePath = makeTempStorage(t);
    const signals = [];
    let complete;
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        cancelGraceMs: 10,
        executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
            complete = resolve;
            options.onSpawn?.({
                pid: null,
                kill(signal) {
                    signals.push(signal);
                    return true;
                },
            });
        }),
    });
    const { id } = queue.enqueueTask(dummyTaskConfig());
    await waitFor(() => queue.getTask(id)?.status === 'running');
    queue.cancelTask(id);
    await waitFor(() => signals.includes('SIGKILL'));
    complete({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'cancelled');

    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('TaskQueue shutdown cancels pending and active work before acknowledging drain', async (t) => {
    const storagePath = makeTempStorage(t);
    const signals = [];
    let complete;
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        cancelGraceMs: 50,
        executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
            complete = resolve;
            options.onSpawn?.({
                pid: null,
                kill(signal) {
                    signals.push(signal);
                    if (signal === 'SIGTERM') {
                        setTimeout(() => resolve({ code: 143, signal, stdout: '', stderr: '' }), 5);
                    }
                    return true;
                },
            });
        }),
    });
    const runningId = queue.enqueueTask(dummyTaskConfig({ order: 1 })).id;
    const pendingId = queue.enqueueTask(dummyTaskConfig({ order: 2 })).id;
    await waitFor(() => typeof complete === 'function');

    assert.deepEqual(await queue.shutdown({ timeoutMs: 1_000, pollMs: 5 }), { state: 'drained' });
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(queue.getTask(runningId)?.status, 'cancelled');
    assert.equal(queue.getTask(pendingId)?.status, 'cancelled');
    assert.throws(
        () => queue.enqueueTask(dummyTaskConfig({ order: 3 })),
        (error) => error?.code === 'PLOINKY_TASK_QUEUE_SHUTTING_DOWN',
    );
});

test('TaskQueue shutdown refuses to acknowledge drain when final state cannot persist', async (t) => {
    const storageDirectory = path.dirname(makeTempStorage(t));
    const logged = t.mock.method(console, 'error', () => {});
    const queue = new TaskQueue({
        storagePath: storageDirectory,
        executor: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }),
    });

    await assert.rejects(
        queue.shutdown({ timeoutMs: 1_000, pollMs: 5 }),
        (error) => error?.code === 'EISDIR',
    );
    assert.ok(logged.mock.callCount() >= 1);
});

test('TaskQueue shutdown proves a detached process group absent after its leader exits', {
    skip: process.platform === 'win32',
}, async (t) => {
    const storagePath = makeTempStorage(t);
    const descendantPath = path.join(path.dirname(storagePath), 'descendant.pid');
    let leaderPid = null;
    let descendantPid = null;
    const processGroupExists = () => {
        if (!Number.isInteger(leaderPid)) return false;
        try {
            process.kill(-leaderPid, 0);
            return true;
        } catch (error) {
            if (error?.code === 'ESRCH') return false;
            throw error;
        }
    };
    t.after(() => {
        if (!processGroupExists()) return;
        try {
            process.kill(-leaderPid, 'SIGKILL');
        } catch (error) {
            if (error?.code !== 'ESRCH') throw error;
        }
    });

    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        cancelGraceMs: 50,
        executor: (_spec, _payload, options = {}) => new Promise((resolve, reject) => {
            const script = [
                "trap 'exit 0' TERM",
                '(',
                "  trap '' TERM",
                '  exec </dev/null >/dev/null 2>&1',
                '  while :; do sleep 1; done',
                ') &',
                'printf "%s\\n" "$!" > "$1"',
                'while :; do sleep 1; done',
            ].join('\n');
            const child = spawn('/bin/sh', ['-c', script, 'task-group', descendantPath], {
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            leaderPid = child.pid;
            options.onSpawn?.(child);
            child.once('error', reject);
            child.once('close', (code, signal) => resolve({
                code,
                signal,
                stdout: '',
                stderr: '',
            }));
        }),
    });
    const taskId = queue.enqueueTask(dummyTaskConfig()).id;
    await waitFor(() => {
        try {
            descendantPid = Number.parseInt(readFileSync(descendantPath, 'utf8'), 10);
            return Number.isInteger(descendantPid) && descendantPid > 0;
        } catch {
            return false;
        }
    });
    assert.equal(processGroupExists(), true);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));

    assert.deepEqual(await queue.shutdown({ timeoutMs: 2_000, pollMs: 5 }), { state: 'drained' });
    assert.equal(processGroupExists(), false, 'the exact detached process group must be absent');
    assert.throws(
        () => process.kill(descendantPid, 0),
        (error) => error?.code === 'ESRCH',
    );
    assert.equal(queue.getTask(taskId)?.status, 'cancelled');
    const persisted = JSON.parse(readFileSync(storagePath, 'utf8'));
    assert.equal(persisted.find((entry) => entry.id === taskId)?.status, 'cancelled');
});
