import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

import { TaskQueue } from '../../Agent/server/TaskQueue.mjs';

const PERSISTED_TASK_KEYS = new Set([
    'id', 'toolName', 'status', 'timeoutMs', 'createdAt', 'updatedAt', 'error', 'logRetention',
    'continuationTool', 'taskMessageTool', 'liveContinuation', 'details',
]);
const HOUR_MS = 60 * 60 * 1000;

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

test('TaskQueue runs async command args in process and persists only the allowlisted snapshot', async (t) => {
    const storagePath = makeTempStorage(t);
    const executed = [];
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (spec, payload, options = {}) => {
            executed.push({ spec, payload });
            options.onStdoutChunk?.('ok');
            return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' });
        }
    });

    const { id } = queue.enqueueTask({
        toolName: 'execute-task',
        commandSpec: { command: '/usr/bin/node', args: ['/tmp/script.mjs'], cwd: '/code', env: { TOOL_NAME: 'x' } },
        payload: { prompt: 'test' },
    });
    await waitFor(() => queue.getTask(id)?.status === 'completed');
    await queue.flushPersist();

    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0].spec.args, ['/tmp/script.mjs']);
    assert.equal(executed[0].spec.command, '/usr/bin/node');
    assert.equal(executed[0].payload.prompt, 'test');

    const snapshot = JSON.parse(readFileSync(storagePath, 'utf8'));
    const persistedEntry = snapshot.find((entry) => entry?.id === id);
    assert.equal(persistedEntry?.toolName, 'execute-task');
    assert.equal(persistedEntry?.status, 'completed');
    assert.deepEqual(
        Object.keys(persistedEntry).filter((key) => !PERSISTED_TASK_KEYS.has(key)),
        [],
    );
    assert.equal(persistedEntry.commandSpec, undefined);
    assert.equal(persistedEntry.payload, undefined);

    const restored = new TaskQueue({ storagePath, executor: async () => assert.fail('restored tasks never execute') });
    restored.initialize();
    assert.equal(restored.getTask(id)?.status, 'completed');
    assert.equal(restored.getTask(id)?.toolName, 'execute-task');
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

test('TaskQueue exposes declared live controls before completion and retains them afterwards', async (t) => {
    const storagePath = makeTempStorage(t);
    let finish;
    const queue = new TaskQueue({ storagePath, executor: (_spec, _payload, options) => new Promise((resolve) => {
        finish = resolve;
        options.onStderrChunk('@@PLOINKY_TASK_CONTROL@@' + JSON.stringify({
            version: 1, toolName: 'resume-work', messageToolName: 'message-work', handle: 'private-session-handle',
        }) + '\nvisible output\n');
    }) });
    const { id } = queue.enqueueTask({ ...dummyTaskConfig(), continuationTool: 'resume-work', taskMessageTool: 'message-work' });
    const running = await waitFor(() => queue.getTask(id)?.liveContinuation && queue.getTask(id));
    assert.equal(running.status, 'running');
    assert.equal(running.liveContinuation.messageToolName, 'message-work');
    assert.equal(running.logTail, 'visible output\n');
    finish({ code: 0, stdout: 'done', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'completed');
    assert.equal(queue.getTask(id).result.metadata.continuation.handle, 'private-session-handle');
});

test('TaskQueue exposes a declared details link and keeps its control line out of logs', async (t) => {
    const storagePath = makeTempStorage(t);
    let finish;
    const url = '/base-agent-additional-server/roboTeamAgent/3001/roboflow?flowId=flow_603070ca4a29b08bff4a3141';
    const queue = new TaskQueue({ storagePath, executor: (_spec, _payload, options) => new Promise((resolve) => {
        finish = resolve;
        options.onStderrChunk('@@PLOINKY_TASK_CONTROL@@' + JSON.stringify({
            details: { url, label: 'Open workflow page' },
        }) + '\nvisible output\n');
    }) });
    const { id } = queue.enqueueTask(dummyTaskConfig());
    const running = await waitFor(() => queue.getTask(id)?.details && queue.getTask(id));
    assert.equal(running.status, 'running');
    assert.deepEqual(running.details, { url, label: 'Open workflow page' });
    assert.equal(running.logTail, 'visible output\n');
    finish({ code: 0, stdout: 'done', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'completed');
    assert.equal(queue.getTask(id).details.url, url);
});

test('TaskQueue ignores unsafe declared details links', async (t) => {
    const storagePath = makeTempStorage(t);
    let finish;
    const queue = new TaskQueue({ storagePath, executor: (_spec, _payload, options) => new Promise((resolve) => {
        finish = resolve;
        options.onStderrChunk('@@PLOINKY_TASK_CONTROL@@' + JSON.stringify({ details: { url: 'https://evil.example/' } }) + '\n');
        options.onStderrChunk('@@PLOINKY_TASK_CONTROL@@' + JSON.stringify({ details: { url: '//evil.example/' } }) + '\n');
        options.onStderrChunk('done\n');
    }) });
    const { id } = queue.enqueueTask(dummyTaskConfig());
    await waitFor(() => queue.getTask(id)?.logTail?.includes('done'));
    assert.equal(queue.getTask(id).details, undefined);
    finish({ code: 0, stdout: 'done', stderr: '' });
});

test('TaskQueue exposes only outputText from structured command results', async (t) => {    const storagePath = makeTempStorage(t);
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

const PERSISTED_SECRETS = [
    'SECRET-TOKEN-xyz', 'SECRET-H', 'SECRET-AUTH-user', 'secret-input-path', '"payload"', '"commandSpec"',
];

function assertNoPersistedSecrets(storagePath, secrets = PERSISTED_SECRETS) {
    const raw = readFileSync(storagePath, 'utf8');
    for (const secret of secrets) {
        assert.equal(raw.includes(secret), false, `queue file must not contain ${secret}`);
    }
    return JSON.parse(raw);
}

function tempFilesBeside(storagePath) {
    return readdirSync(path.dirname(storagePath)).filter((name) => name.includes('.tmp-'));
}

test('TaskQueue never persists the invocation token, request headers, auth info or input (Q1)', async (t) => {
    const storagePath = makeTempStorage(t);
    const received = [];
    let finish;
    const queue = new TaskQueue({
        maxConcurrent: 1,
        storagePath,
        executor: (_spec, payload) => new Promise((resolve) => {
            received.push(payload);
            finish = resolve;
        }),
    });
    const { id } = queue.enqueueTask(dummyTaskConfig({
        input: { path: '/secret-input-path' },
        metadata: { invocationToken: 'SECRET-TOKEN-xyz', authInfo: { user: 'SECRET-AUTH-user' } },
        requestInfo: { headers: { authorization: 'Bearer SECRET-H' } },
    }));
    await waitFor(() => received.length === 1);
    assert.equal(received[0].metadata.invocationToken, 'SECRET-TOKEN-xyz', 'the executor still receives the token');
    assert.equal(received[0].requestInfo.headers.authorization, 'Bearer SECRET-H');

    await queue.flushPersist();
    assert.equal(assertNoPersistedSecrets(storagePath).find((entry) => entry.id === id)?.status, 'running');

    finish({ code: 0, stdout: 'ok', stderr: '' });
    await waitFor(() => queue.getTask(id)?.status === 'completed');
    await queue.flushPersist();
    assert.equal(assertNoPersistedSecrets(storagePath).find((entry) => entry.id === id)?.status, 'completed');
});

test('TaskQueue debounces a burst of state changes into at most two renames (Q2)', async (t) => {
    const storagePath = makeTempStorage(t);
    const renames = t.mock.method(fs.promises, 'rename');
    const queue = new TaskQueue({ maxConcurrent: 1, storagePath, executor: () => new Promise(() => {}) });

    const startedAt = Date.now();
    const ids = [];
    for (let index = 0; index < 26; index += 1) ids.push(queue.enqueueTask(dummyTaskConfig({ index })).id);
    for (const id of ids.slice(2)) queue.cancelTask(id);
    assert.ok(Date.now() - startedAt < 20, 'the 50 state changes happen within 20 ms');

    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(renames.mock.callCount() >= 1, 'the burst is persisted');
    assert.ok(renames.mock.callCount() <= 2, `expected at most 2 renames, saw ${renames.mock.callCount()}`);

    const persisted = new Map(JSON.parse(readFileSync(storagePath, 'utf8')).map((entry) => [entry.id, entry.status]));
    assert.equal(persisted.size, ids.length);
    for (const id of ids) assert.equal(persisted.get(id), queue.getTask(id).status, id);
    assert.equal(persisted.get(ids[0]), 'running');
    assert.equal(persisted.get(ids[1]), 'pending');
    assert.equal(persisted.get(ids[25]), 'cancelled');
});

test('TaskQueue writes the queue file atomically as 0600 and removes the temp file of a failed write (Q3)', async (t) => {
    const storagePath = makeTempStorage(t);
    writeFileSync(storagePath, '[]');
    chmodSync(storagePath, 0o644);
    const queue = new TaskQueue({ storagePath, executor: async () => ({ code: 0, stdout: 'ok', stderr: '' }) });
    const first = queue.enqueueTask(dummyTaskConfig()).id;
    await waitFor(() => queue.getTask(first)?.status === 'completed');
    await queue.flushPersist({ required: true });
    assert.deepEqual(tempFilesBeside(storagePath), []);
    assert.equal(statSync(storagePath).mode & 0o777, 0o600);
    assert.equal(readFileSync(storagePath, 'utf8').includes('\n'), false, 'no indentation');

    const logged = t.mock.method(console, 'error', () => {});
    const failure = Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
    const rename = t.mock.method(fs.promises, 'rename', async () => { throw failure; });
    const second = queue.enqueueTask(dummyTaskConfig()).id;
    await assert.rejects(queue.flushPersist({ required: true }), (error) => error === failure);
    assert.deepEqual(tempFilesBeside(storagePath), []);
    assert.ok(logged.mock.callCount() >= 1);
    const beforeRecovery = JSON.parse(readFileSync(storagePath, 'utf8'));
    assert.deepEqual(beforeRecovery.map((entry) => entry.id), [first], 'the previous file stays intact');

    await waitFor(() => queue.getTask(second)?.status === 'completed');
    rename.mock.restore();
    await queue.flushPersist({ required: true });
    const recovered = JSON.parse(readFileSync(storagePath, 'utf8'));
    assert.deepEqual(recovered.map((entry) => [entry.id, entry.status]), [[first, 'completed'], [second, 'completed']]);
    assert.deepEqual(tempFilesBeside(storagePath), []);
    assert.equal(statSync(storagePath).mode & 0o777, 0o600);
});

test('TaskQueue prunes expired terminal tasks but never pending, running or cancelling ones (Q4)', async (t) => {
    const storagePath = makeTempStorage(t);
    const old = new Date(Date.now() - 48 * HOUR_MS).toISOString();
    writeFileSync(storagePath, JSON.stringify(Array.from({ length: 600 }, (_, index) => ({
        id: `old-${index}`, toolName: 'demo', status: 'completed', createdAt: old, updatedAt: old,
    }))));
    const queue = new TaskQueue({ maxConcurrent: 2, storagePath, executor: () => new Promise(() => {}) });
    const running = queue.enqueueTask(dummyTaskConfig()).id;
    const cancelling = queue.enqueueTask(dummyTaskConfig()).id;
    const pending = queue.enqueueTask(dummyTaskConfig()).id;
    assert.equal(queue.cancelTask(cancelling)?.status, 'cancelling');
    for (const id of [running, cancelling, pending]) {
        const task = queue.tasks.get(id);
        task.createdAt = old;
        task.updatedAt = old;
    }

    await queue.flushPersist({ required: true });
    const persisted = JSON.parse(readFileSync(storagePath, 'utf8'));
    assert.ok(persisted.length <= 500);
    assert.deepEqual(
        Object.fromEntries(persisted.map((entry) => [entry.id, entry.status])),
        { [running]: 'running', [cancelling]: 'cancelling', [pending]: 'pending' },
    );
    assert.equal(queue.getTask('old-0'), null);
    assert.equal(queue.getTask(running)?.status, 'running');
});

test('TaskQueue keeps only the newest maxTerminalTasks recent terminal tasks (Q4)', async (t) => {
    const storagePath = makeTempStorage(t);
    const now = Date.now();
    writeFileSync(storagePath, JSON.stringify(Array.from({ length: 600 }, (_, index) => {
        const at = new Date(now - (index + 1) * 1000).toISOString();
        return { id: `recent-${index}`, toolName: 'demo', status: 'completed', createdAt: at, updatedAt: at };
    })));
    const queue = new TaskQueue({ maxConcurrent: 1, storagePath, executor: () => new Promise(() => {}) });
    const running = queue.enqueueTask(dummyTaskConfig()).id;

    await queue.flushPersist({ required: true });
    const persisted = JSON.parse(readFileSync(storagePath, 'utf8'));
    const terminalIds = persisted.filter((entry) => entry.status === 'completed').map((entry) => entry.id);
    assert.equal(terminalIds.length, 500);
    assert.deepEqual(
        new Set(terminalIds),
        new Set(Array.from({ length: 500 }, (_, index) => `recent-${index}`)),
    );
    assert.equal(persisted.find((entry) => entry.id === running)?.status, 'running');
    assert.equal(persisted.length, 501);

    const smallPath = path.join(path.dirname(storagePath), 'small.json');
    writeFileSync(smallPath, JSON.stringify([
        { id: 'a', status: 'failed', createdAt: new Date(now - 1000).toISOString(), updatedAt: new Date(now - 1000).toISOString() },
        { id: 'b', status: 'cancelled', createdAt: new Date(now - 2000).toISOString(), updatedAt: new Date(now - 2000).toISOString() },
        { id: 'c', status: 'completed', createdAt: new Date(now - 3000).toISOString(), updatedAt: new Date(now - 3000).toISOString() },
        { id: 'd', status: 'completed', createdAt: new Date(now - 120_000).toISOString(), updatedAt: new Date(now - 120_000).toISOString() },
    ]));
    const small = new TaskQueue({
        storagePath: smallPath, maxTerminalTasks: 2, terminalRetentionMs: 60_000, executor: async () => ({ code: 0 }),
    });
    small.initialize();
    await small.flushPersist({ required: true });
    assert.deepEqual(JSON.parse(readFileSync(smallPath, 'utf8')).map((entry) => entry.id), ['a', 'b']);
});

test('TaskQueue rewrites a legacy queue file without secrets after restore and still serves restored tasks (Q5)', async (t) => {
    const storagePath = makeTempStorage(t);
    const recent = new Date(Date.now() - 60_000).toISOString();
    const legacyPayload = (tag) => ({
        input: { path: `/secret-input-path-${tag}` },
        metadata: { invocationToken: `SECRET-TOKEN-xyz-${tag}`, authInfo: { user: `SECRET-AUTH-user-${tag}` } },
        requestInfo: { headers: { authorization: `Bearer SECRET-H-${tag}` } },
    });
    const continuation = {
        version: 1, handle: 'legacy-continuation-handle', toolName: 'continue-task', messageToolName: 'message-task',
    };
    writeFileSync(storagePath, JSON.stringify([
        {
            id: 'legacy-done',
            toolName: 'demo',
            commandSpec: { command: '/bin/true', args: ['--secret-input-path'], cwd: '/', env: { KEY: 'SECRET-H-env' } },
            payload: legacyPayload('done'),
            status: 'completed',
            timeoutMs: null,
            createdAt: recent,
            updatedAt: recent,
            error: null,
            logRetention: 'full',
            continuationTool: 'continue-task',
            taskMessageTool: 'message-task',
            liveContinuation: continuation,
            details: { url: '/demo/details', label: 'Open details' },
        },
        {
            id: 'legacy-running',
            toolName: 'demo',
            commandSpec: { command: '/bin/true', args: [], cwd: '/', env: {} },
            payload: legacyPayload('running'),
            status: 'running',
            createdAt: recent,
            updatedAt: recent,
        },
    ], null, 2));
    chmodSync(storagePath, 0o644);

    const queue = new TaskQueue({ storagePath, executor: async () => assert.fail('restored tasks never execute') });
    queue.initialize();
    await waitFor(() => !readFileSync(storagePath, 'utf8').includes('SECRET'), 2000);
    await queue.flushPersist({ required: true });

    const persisted = assertNoPersistedSecrets(storagePath, [...PERSISTED_SECRETS, 'SECRET']);
    assert.equal(statSync(storagePath).mode & 0o777, 0o600);
    const byId = Object.fromEntries(persisted.map((entry) => [entry.id, entry]));
    assert.equal(byId['legacy-done'].status, 'completed');
    assert.deepEqual(byId['legacy-done'].liveContinuation, continuation);
    assert.deepEqual(byId['legacy-done'].details, { url: '/demo/details', label: 'Open details' });
    assert.equal(byId['legacy-done'].logRetention, 'full');
    assert.equal(byId['legacy-running'].status, 'failed');
    assert.match(byId['legacy-running'].error, /interrupted/);

    const done = queue.getTask('legacy-done');
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.liveContinuation, continuation);
    assert.deepEqual(done.details, { url: '/demo/details', label: 'Open details' });
    assert.equal(done.logTail, '');
    assert.equal(queue.cancelTask('legacy-done')?.status, 'completed');
    assert.equal(queue.getTask('legacy-running')?.status, 'failed');
});
