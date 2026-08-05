import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { TaskQueue } from '../../Agent/server/TaskQueue.mjs';

const TEST_UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const TEST_IDENTITY = 'linux-proc:11111111-1111-4111-8111-111111111111:100';

function processIdentityOptions(signals) {
    return {
        processIdentityInspector: () => ({
            state: 'identified',
            processIdentity: TEST_IDENTITY,
            processUid: TEST_UID,
        }),
        signalProcessGroup: (_pid, signal) => signals.push(signal),
        getUid: () => TEST_UID,
    };
}

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

test('TaskQueue preserves the exact provider-module admission across queue persistence', async (t) => {
    const storagePath = makeTempStorage(t);
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    });
    const commandSpec = {
        kind: 'provider-module',
        provider: 'opencode',
        module: '/code/scripts/execute-task.mjs',
        exportName: 'executeProviderTask',
        timeoutMs: 30_000,
    };
    const { id } = queue.enqueueTask({
        toolName: 'execute-task',
        commandSpec,
        payload: { prompt: 'test' },
    });

    const snapshot = JSON.parse(readFileSync(storagePath, 'utf8'));
    const restoredEntry = snapshot.find((entry) => entry?.id === id);
    assert.deepEqual(restoredEntry?.commandSpec, commandSpec);
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

test('TaskQueue aborts in-process provider bootstrap before a child is spawned', async (t) => {
    const storagePath = makeTempStorage(t);
    let observedSignal;
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
            observedSignal = options.signal;
            options.signal.addEventListener('abort', () => resolve({
                code: 1,
                signal: 'SIGTERM',
                stdout: '',
                stderr: '',
            }), { once: true });
        }),
    });
    const { id } = queue.enqueueTask({
        toolName: 'execute-task',
        commandSpec: {
            kind: 'provider-module',
            provider: 'pi',
            module: '/code/scripts/execute-task.mjs',
            exportName: 'executeProviderTask',
        },
        payload: { prompt: 'test' },
    });
    await waitFor(() => observedSignal);

    assert.equal(observedSignal.aborted, false);
    assert.equal(queue.cancelTask(id)?.status, 'cancelling');
    await waitFor(() => queue.getTask(id)?.status === 'cancelled');
    assert.equal(observedSignal.aborted, true);
});

test('TaskQueue keeps a running task in cancelling until cleanup returns its continuation', async (t) => {
    const storagePath = makeTempStorage(t);
    const signals = [];
    let complete;
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        ...processIdentityOptions(signals),
        executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
            complete = resolve;
            options.onSpawn?.({
                pid: 4242,
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
        ...processIdentityOptions(signals),
        executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
            complete = resolve;
            options.onSpawn?.({
                pid: 5252,
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

test('TaskQueue never signals PID-reused, unknown, or UID-diverged children', async (t) => {
    const alternateIdentity = 'linux-proc:22222222-2222-4222-8222-222222222222:200';
    for (const [state, expectedStatus] of [
        [{ state: 'identified', processIdentity: alternateIdentity, processUid: TEST_UID }, 'cancelled'],
        [{ state: 'unknown' }, 'failed'],
        [{ state: 'uid-diverged', processUid: TEST_UID }, 'failed'],
    ]) {
        const storagePath = makeTempStorage(t);
        const signals = [];
        let complete;
        let captured = false;
        const queue = new TaskQueue({
            maxConcurrent: 1,
            storagePath,
            cancelGraceMs: 10,
            getUid: () => TEST_UID,
            signalProcessGroup: (_pid, signal) => signals.push(signal),
            processIdentityInspector: () => captured
                ? state
                : {
                    state: 'identified',
                    processIdentity: TEST_IDENTITY,
                    processUid: TEST_UID,
                },
            executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
                complete = resolve;
                options.onSpawn?.({ pid: 6363, killed: false });
                captured = true;
            }),
        });
        const { id } = queue.enqueueTask(dummyTaskConfig());
        await waitFor(() => queue.getTask(id)?.status === 'running');
        assert.equal(queue.cancelTask(id)?.status, 'cancelling');
        complete({ code: 1, signal: 'SIGTERM', stdout: '', stderr: '' });
        await waitFor(() => queue.getTask(id)?.status === expectedStatus);
        assert.deepEqual(signals, [], state.state);
        if (expectedStatus === 'failed') {
            assert.match(queue.getTask(id)?.error, /^PLOINKY_TASK_PROCESS_IDENTITY_UNVERIFIED:/);
        }
    }
});

test('TaskQueue treats identity-inspector exceptions as typed retained lifecycle failures', async (t) => {
    const storagePath = makeTempStorage(t);
    const signals = [];
    let complete;
    let captured = false;
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        cancelGraceMs: 10,
        getUid: () => TEST_UID,
        signalProcessGroup: (_pid, signal) => signals.push(signal),
        processIdentityInspector: () => {
            if (captured) throw new Error('simulated identity inspector failure');
            return {
                state: 'identified',
                processIdentity: TEST_IDENTITY,
                processUid: TEST_UID,
            };
        },
        executor: (_spec, _payload, options = {}) => new Promise((resolve) => {
            complete = resolve;
            options.onSpawn?.({ pid: 7474, killed: false });
            captured = true;
        }),
    });
    const { id } = queue.enqueueTask(dummyTaskConfig());
    await waitFor(() => queue.getTask(id)?.status === 'running');
    assert.equal(queue.cancelTask(id)?.status, 'cancelling');
    complete({ code: 1, signal: 'SIGTERM', stdout: '', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'failed');
    assert.deepEqual(signals, []);
    assert.match(queue.getTask(id)?.error, /^PLOINKY_TASK_PROCESS_IDENTITY_UNVERIFIED:/);

    const queued = queue.enqueueTask(dummyTaskConfig());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(queue.getTask(queued.id)?.status, 'pending');
});
