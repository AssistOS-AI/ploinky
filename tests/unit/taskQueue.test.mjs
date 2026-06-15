import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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

test('TaskQueue exposes live log tail updates while task is running', async (t) => {
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
        return task?.status === 'running' && task?.logSeq >= 2 ? task : null;
    });

    assert.match(runningTask.logTail, /step 1/);
    assert.match(runningTask.logTail, /step 2/);
    assert.equal(runningTask.logTruncated, false);

    completions[0]({ code: 0, stdout: 'done', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'completed');

    const completed = queue.getTask(id);
    assert.ok(completed.logSeq >= 2);
    assert.match(completed.logTail, /step 1/);
});
