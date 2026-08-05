import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProviderOperationSessionRegistry } from '../../Agent/lib/providerOperationSessions.mjs';
import { TaskQueue } from '../../Agent/server/TaskQueue.mjs';
import { createAgentServerContainerEnvironment } from '../helpers/agentServerCredentialRuntime.mjs';

const credentialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-server-provider-module-'));
Object.assign(process.env, await createAgentServerContainerEnvironment({
    tempDir: credentialDir,
    agentPrincipal: 'agent:test/provider-module',
}));
const {
    __closeProviderInfrastructure,
    __deriveProviderOperationOwner,
    __executeShell,
    __executeProviderModuleWithRuntime,
    __resolveProviderOperationSession,
    __sanitizeProviderLogValue,
    __shutdownAgentServerRuntime,
} = await import(`../../Agent/server/AgentServer.mjs?provider-module=${Date.now()}`);

const OWNER = 'a'.repeat(64);
const HANDLE = 'h'.repeat(43);

test.after(() => fs.rmSync(credentialDir, { recursive: true, force: true }));

test('generic shell execution propagates onSpawn rejection and withholds task input', async () => {
    const spawnError = Object.freeze(Object.assign(new Error('spawn ownership unavailable'), {
        code: 'PLOINKY_TASK_PROCESS_IDENTITY_UNVERIFIED',
    }));
    await assert.rejects(
        Promise.race([
            __executeShell({
                command: process.execPath,
                args: ['-e', 'process.stdin.resume()'],
                cwd: '/',
                env: {},
            }, { secret: 'must-not-be-written' }, {
                onSpawn() { throw spawnError; },
            }),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('shell onSpawn rejection remained pending')),
                1000,
            )),
        ]),
        (error) => error === spawnError,
    );
});

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
}

async function waitFor(predicate, timeout = 1000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('timed out waiting for provider module state');
}

function retainedController(completion) {
    return Object.freeze({
        stdin: Object.freeze({ write() {} }),
        stdout: Object.freeze({ on() {} }),
        stderr: Object.freeze({ on() {} }),
        completion,
        launch: Object.freeze({ provider: 'codex', mode: 'operation' }),
    });
}

function fakeRuntime({ provider = 'codex', used = false, controller = null } = {}) {
    const calls = [];
    let closed = false;
    return {
        provider,
        mode: 'operation',
        calls,
        assertBoundaryUsed() {
            calls.push('assert-used');
            if (!used) throw new Error('provider boundary required');
        },
        assertBoundaryUnused() {
            calls.push('assert-unused');
            if (used) throw new Error('provider boundary unexpected');
        },
        claimRetainedOperation(received) {
            calls.push('claim');
            assert.equal(received, controller);
        },
        async close() {
            if (closed) return;
            closed = true;
            calls.push('close');
        },
    };
}

test('AgentServer transfers one retained login boundary to its registry and controls it without a new launch', async () => {
    const completion = deferred();
    const controller = retainedController(completion.promise);
    const retainedRuntime = fakeRuntime({ used: true, controller });
    const registry = createProviderOperationSessionRegistry({
        createId: () => 'dddddddd-eeee-4fff-8000-111111111111',
        createHandle: () => HANDLE,
    });
    const startPayload = {
        tool: 'task-session-control',
        input: { operation: 'login_start' },
    };
    assert.equal(__resolveProviderOperationSession(startPayload), 'login_start');
    const started = await __executeProviderModuleWithRuntime({
        provider: 'codex',
        providerRuntime: retainedRuntime,
        operationSessionRegistry: registry,
        ownerBinding: OWNER,
        payload: startPayload,
        execute: async (_payload, { operationSessions }) => ({
            ok: true,
            response: await operationSessions.retainLoginOperation({
                controller,
                authProvider: 'openai',
                method: 'device_code',
                initialState: { status: 'running' },
            }),
        }),
    });
    const startedEnvelope = JSON.parse(started.stdout);
    const control = {
        flowId: startedEnvelope.response.flowId,
        continuationHandle: startedEnvelope.response.continuationHandle,
    };
    assert.equal(started.code, 0);
    assert.deepEqual(retainedRuntime.calls, ['assert-used', 'claim']);

    const statusRuntime = fakeRuntime();
    const statusPayload = {
        tool: 'task-session-control',
        input: { operation: 'login_status', ...control },
    };
    const status = await __executeProviderModuleWithRuntime({
        provider: 'codex',
        providerRuntime: statusRuntime,
        operationSessionRegistry: registry,
        ownerBinding: OWNER,
        payload: statusPayload,
        execute: async (payload, { operationSessions }) => ({
            ok: true,
            response: await operationSessions.getLoginStatus({
                flowId: payload.input.flowId,
                continuationHandle: payload.input.continuationHandle,
            }),
        }),
    });
    assert.equal(JSON.parse(status.stdout).response.status, 'running');
    assert.deepEqual(statusRuntime.calls, ['assert-unused', 'assert-unused', 'close']);

    await registry.close();
    assert.deepEqual(retainedRuntime.calls, ['assert-used', 'claim', 'close']);
});

test('AgentServer rejects login control that bypasses the registry and closes the unused runtime', async () => {
    const runtime = fakeRuntime({ provider: 'pi' });
    const registry = createProviderOperationSessionRegistry();
    await assert.rejects(
        __executeProviderModuleWithRuntime({
            provider: 'pi',
            providerRuntime: runtime,
            operationSessionRegistry: registry,
            ownerBinding: OWNER,
            payload: {
                tool: 'task-session-control',
                input: { operation: 'login_cancel', flowId: 'login:missing' },
            },
            execute: async () => ({ ok: true, response: { status: 'cancelled' } }),
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_CONTROL_REQUIRED',
    );
    assert.deepEqual(runtime.calls, ['close']);
    await registry.close();
});

test('AgentServer rolls back a retained runtime when provider publication fails', async () => {
    const completion = deferred();
    const controller = retainedController(completion.promise);
    const runtime = fakeRuntime({ provider: 'opencode', used: true, controller });
    const registry = createProviderOperationSessionRegistry({
        createId: () => 'eeeeeeee-ffff-4000-8111-222222222222',
        createHandle: () => HANDLE,
    });
    await assert.rejects(
        __executeProviderModuleWithRuntime({
            provider: 'opencode',
            providerRuntime: runtime,
            operationSessionRegistry: registry,
            ownerBinding: OWNER,
            payload: { tool: 'task-session-control', input: { operation: 'login_start' } },
            execute: async (_payload, { operationSessions }) => {
                await operationSessions.retainLoginOperation({
                    controller,
                    authProvider: 'github-copilot',
                    method: 'device_code',
                    initialState: { status: 'running' },
                });
                throw new Error('response publication failed');
            },
        }),
        /response publication failed/,
    );
    assert.deepEqual(runtime.calls, ['assert-used', 'claim', 'close']);
    assert.equal(registry.size, 0);
    await registry.close();
});

test('AgentServer surfaces an immutable cleanup failure without attaching provider output', async () => {
    const cleanupError = Object.freeze(new Error('exact retained cleanup failed'));
    const runtime = fakeRuntime();
    const operationSessionRegistry = {
        createInvocation() {
            return {
                providerApi: Object.freeze({}),
                disposition: () => 'staged',
                async rollback() { throw cleanupError; },
            };
        },
    };
    await assert.rejects(
        __executeProviderModuleWithRuntime({
            provider: 'codex',
            providerRuntime: runtime,
            operationSessionRegistry,
            ownerBinding: OWNER,
            payload: { tool: 'task-session-control', input: { operation: 'login_start' } },
            execute: async () => { throw new Error('provider-controlled publication detail'); },
        }),
        (error) => error === cleanupError && error.cause === undefined,
    );
    assert.deepEqual(runtime.calls, ['close']);
});

test('AgentServer closes an allocated runtime when session invocation admission fails', async () => {
    const runtime = fakeRuntime();
    const admissionError = Object.assign(new Error('registry is closed'), {
        code: 'PLOINKY_PROVIDER_LOGIN_REGISTRY_CLOSED',
    });
    await assert.rejects(
        __executeProviderModuleWithRuntime({
            provider: 'codex',
            providerRuntime: runtime,
            operationSessionRegistry: {
                createInvocation() { throw admissionError; },
            },
            ownerBinding: OWNER,
            payload: { tool: 'task-session-control', input: { operation: 'login_start' } },
            execute: async () => { throw new Error('must not execute'); },
        }),
        (error) => error === admissionError,
    );
    assert.deepEqual(runtime.calls, ['close']);
});

test('AgentServer rolls back staged login on serialization failure or pre-commit abort', async () => {
    for (const failure of ['serialization', 'abort']) {
        const completion = deferred();
        const controller = retainedController(completion.promise);
        const runtime = fakeRuntime({ used: true, controller });
        const registry = createProviderOperationSessionRegistry({
            createId: () => failure === 'serialization'
                ? 'ffffffff-0000-4000-8111-333333333333'
                : '00000000-1111-4222-8333-444444444444',
            createHandle: () => HANDLE,
        });
        const abortController = new AbortController();
        if (failure === 'abort') abortController.abort();
        await assert.rejects(
            __executeProviderModuleWithRuntime({
                provider: 'codex',
                providerRuntime: runtime,
                operationSessionRegistry: registry,
                ownerBinding: OWNER,
                signal: abortController.signal,
                payload: { tool: 'task-session-control', input: { operation: 'login_start' } },
                execute: async (_payload, { operationSessions }) => {
                    const state = await operationSessions.retainLoginOperation({
                        controller,
                        authProvider: 'openai',
                        method: 'device_code',
                        initialState: { status: 'running' },
                    });
                    const result = { ok: true, response: state };
                    if (failure === 'serialization') result.cycle = result;
                    return result;
                },
            }),
            failure === 'serialization'
                ? (error) => error instanceof TypeError
                : (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_START_ABORTED',
        );
        assert.deepEqual(
            runtime.calls,
            failure === 'abort' ? ['close'] : ['assert-used', 'claim', 'close'],
        );
        assert.equal(registry.size, 0);
        await registry.close();
    }
});

test('AgentServer abort revokes and cleans a retained login even when provider execution never returns', async () => {
    const completion = deferred();
    const controller = retainedController(completion.promise);
    const runtime = fakeRuntime({ used: true, controller });
    const registry = createProviderOperationSessionRegistry({
        createId: () => '12121212-3434-4567-8abc-565656565656',
        createHandle: () => HANDLE,
    });
    const abortController = new AbortController();
    const staged = deferred();
    const neverReturns = deferred();
    const execution = __executeProviderModuleWithRuntime({
        provider: 'codex',
        providerRuntime: runtime,
        operationSessionRegistry: registry,
        ownerBinding: OWNER,
        signal: abortController.signal,
        payload: { tool: 'task-session-control', input: { operation: 'login_start' } },
        execute: async (_payload, { operationSessions }) => {
            await operationSessions.retainLoginOperation({
                controller,
                authProvider: 'openai',
                method: 'device_code',
                initialState: { status: 'running' },
            });
            staged.resolve();
            return neverReturns.promise;
        },
    });
    await staged.promise;
    abortController.abort();
    await assert.rejects(
        Promise.race([
            execution,
            new Promise((_, reject) => setTimeout(() => reject(new Error('aborted provider execution remained hung')), 100)),
        ]),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_START_ABORTED',
    );
    assert.deepEqual(runtime.calls, ['assert-used', 'claim', 'close']);
    assert.equal(registry.size, 0);
    await registry.close();
});

test('AgentServer rejects an inexact retained-login success envelope before registry commit', async () => {
    const completion = deferred();
    const controller = retainedController(completion.promise);
    const runtime = fakeRuntime({ used: true, controller });
    const registry = createProviderOperationSessionRegistry({
        createId: () => '34343434-5656-4789-8abc-787878787878',
        createHandle: () => HANDLE,
    });
    await assert.rejects(
        __executeProviderModuleWithRuntime({
            provider: 'codex',
            providerRuntime: runtime,
            operationSessionRegistry: registry,
            ownerBinding: OWNER,
            payload: { tool: 'task-session-control', input: { operation: 'login_start' } },
            execute: async (_payload, { operationSessions }) => ({
                ok: true,
                response: await operationSessions.retainLoginOperation({
                    controller,
                    authProvider: 'openai',
                    method: 'device_code',
                    initialState: { status: 'running' },
                }),
                reflected: 'provider-controlled-extra-field',
            }),
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_ENDPOINT_RESPONSE_INVALID',
    );
    assert.equal(registry.size, 0);
    assert.deepEqual(runtime.calls, ['assert-used', 'claim', 'close']);
    await registry.close();
});

test('AgentServer awaits and exact-binds a control result instead of accepting provider reflection', async () => {
    const completion = deferred();
    const controller = retainedController(completion.promise);
    const retainedRuntime = fakeRuntime({ used: true, controller });
    const registry = createProviderOperationSessionRegistry({
        createId: () => '56565656-7878-4901-8abc-909090909090',
        createHandle: () => HANDLE,
    });
    const started = await __executeProviderModuleWithRuntime({
        provider: 'codex',
        providerRuntime: retainedRuntime,
        operationSessionRegistry: registry,
        ownerBinding: OWNER,
        payload: { tool: 'task-session-control', input: { operation: 'login_start' } },
        execute: async (_payload, { operationSessions }) => ({
            ok: true,
            response: await operationSessions.retainLoginOperation({
                controller,
                authProvider: 'openai',
                method: 'device_code',
                initialState: { status: 'running' },
            }),
        }),
    });
    const state = JSON.parse(started.stdout).response;
    const callbackGate = deferred();
    const controlRuntime = fakeRuntime();
    const execution = __executeProviderModuleWithRuntime({
        provider: 'codex',
        providerRuntime: controlRuntime,
        operationSessionRegistry: registry,
        ownerBinding: OWNER,
        payload: { tool: 'task-session-control', input: { operation: 'login_status' } },
        execute: async (_payload, { operationSessions }) => {
            void operationSessions.getLoginStatus({
                flowId: state.flowId,
                continuationHandle: state.continuationHandle,
            });
            await callbackGate.promise;
            return { ok: true, response: { type: 'forged', accessToken: 'reflected' } };
        },
    });
    callbackGate.resolve();
    await assert.rejects(
        execution,
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_CONTROL_RESPONSE_INVALID',
    );
    assert.deepEqual(controlRuntime.calls, ['assert-unused', 'assert-unused', 'close']);
    await registry.close();
});

test('AgentServer derives a stable owner binding from verified caller and runtime generations', () => {
    const payload = {
        tool: 'task-session-control',
        metadata: {
            invocation: {
                iss: 'agent:caller/source',
                sub: 'user:123',
                workspace_id: 'workspace-1',
                tool: 'task-session-control',
                caller: { kind: 'agent', id: 'agent:caller/source' },
                actor: { kind: 'user', id: 'user:123' },
            },
        },
    };
    const first = __deriveProviderOperationOwner(payload);
    const second = __deriveProviderOperationOwner(payload);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
    assert.notEqual(
        first,
        __deriveProviderOperationOwner({
            ...payload,
            metadata: {
                invocation: { ...payload.metadata.invocation, workspace_id: 'workspace-2' },
            },
        }),
    );
});

test('AgentServer shutdown proves retained session cleanup before closing the scoped broker', async () => {
    const calls = [];
    await __closeProviderInfrastructure({
        taskQueueInstance: {
            async close() { calls.push('queue'); },
        },
        operationSessionRegistry: {
            async close() { calls.push('sessions'); },
        },
        brokerRegistryPromise: Promise.resolve({
            async close() { calls.push('broker'); },
        }),
    });
    assert.deepEqual(calls, ['queue', 'sessions', 'broker']);
});

test('AgentServer shutdown still attempts retained-session cleanup after queue cleanup fails', async () => {
    const calls = [];
    const queueError = Object.freeze(Object.assign(new Error('queue cleanup unproven'), {
        code: 'PLOINKY_TASK_QUEUE_CLEANUP_UNPROVEN',
    }));
    await assert.rejects(
        __closeProviderInfrastructure({
            taskQueueInstance: {
                async close() { calls.push('queue'); throw queueError; },
            },
            operationSessionRegistry: {
                async close() { calls.push('sessions'); },
            },
            brokerRegistryPromise: Promise.resolve({
                async close() { calls.push('broker'); },
            }),
        }),
        (error) => error === queueError,
    );
    assert.deepEqual(calls, ['queue', 'sessions']);
});

test('AgentServer shutdown keeps the broker open when retained-session cleanup fails', async () => {
    const calls = [];
    const sessionsError = Object.freeze(Object.assign(new Error('session cleanup unproven'), {
        code: 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN',
    }));
    await assert.rejects(
        __closeProviderInfrastructure({
            taskQueueInstance: {
                async close() { calls.push('queue'); },
            },
            operationSessionRegistry: {
                async close() { calls.push('sessions'); throw sessionsError; },
            },
            brokerRegistryPromise: Promise.resolve({
                async close() { calls.push('broker'); },
            }),
        }),
        (error) => error === sessionsError,
    );
    assert.deepEqual(calls, ['queue', 'sessions']);
});

test('AgentServer shutdown aggregates independent cleanup failures without closing the broker', async () => {
    const calls = [];
    const queueError = new Error('queue cleanup unproven');
    const sessionsError = new Error('session cleanup unproven');
    await assert.rejects(
        __closeProviderInfrastructure({
            taskQueueInstance: {
                async close() { calls.push('queue'); throw queueError; },
            },
            operationSessionRegistry: {
                async close() { calls.push('sessions'); throw sessionsError; },
            },
            brokerRegistryPromise: Promise.resolve({
                async close() { calls.push('broker'); },
            }),
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_SHUTDOWN_CLEANUP_UNPROVEN'
            && error instanceof AggregateError
            && error.errors[0] === queueError
            && error.errors[1] === sessionsError,
    );
    assert.deepEqual(calls, ['queue', 'sessions']);
});

test('AgentServer shutdown retries transient provider cleanup before closing broker, sessions, and HTTP', async () => {
    const calls = [];
    let queueAttempts = 0;
    const serverHttp = {
        close(callback) {
            calls.push('http-close-request');
            this.closed = callback;
        },
        closeAllConnections() {
            calls.push('http-close-all');
            this.closed();
        },
    };
    await __shutdownAgentServerRuntime({
        taskQueueInstance: {
            async close() {
                queueAttempts += 1;
                calls.push(`queue:${queueAttempts}`);
                if (queueAttempts === 1) {
                    throw Object.assign(new Error('transient cleanup failure'), {
                        code: 'PLOINKY_TASK_QUEUE_CLEANUP_UNPROVEN',
                    });
                }
            },
        },
        operationSessionRegistry: {
            async close() { calls.push(`sessions:${queueAttempts}`); },
        },
        brokerRegistryPromise: Promise.resolve({
            async close() { calls.push('broker'); },
        }),
        sessions: {
            one: { transport: { async close() { calls.push('transport'); } } },
        },
        serverHttp,
        retryDelayMs: 1,
        delay: async (milliseconds) => {
            assert.equal(milliseconds, 1);
            calls.push('retry-delay');
        },
    });
    assert.deepEqual(calls, [
        'http-close-request',
        'queue:1',
        'sessions:1',
        'retry-delay',
        'queue:2',
        'sessions:2',
        'broker',
        'transport',
        'http-close-all',
    ]);
});

test('AgentServer shutdown contains HTTP and remains retryable when a transport never settles', async () => {
    const calls = [];
    let transportAttempts = 0;
    let httpAlreadyClosed = false;
    const serverHttp = {
        close(callback) {
            calls.push('http-close-request');
            if (httpAlreadyClosed) {
                queueMicrotask(() => callback(Object.assign(new Error('Server is not running'), {
                    code: 'ERR_SERVER_NOT_RUNNING',
                })));
                return;
            }
            this.closed = callback;
        },
        closeAllConnections() {
            calls.push('http-close-all');
            if (!httpAlreadyClosed) {
                httpAlreadyClosed = true;
                this.closed();
            }
        },
    };
    const dependencies = {
        taskQueueInstance: { async close() { calls.push('queue'); } },
        operationSessionRegistry: { async close() { calls.push('sessions'); } },
        brokerRegistryPromise: Promise.resolve({ async close() { calls.push('broker'); } }),
        sessions: {
            one: {
                transport: {
                    close() {
                        transportAttempts += 1;
                        calls.push(`transport:${transportAttempts}`);
                        return transportAttempts === 1 ? new Promise(() => {}) : Promise.resolve();
                    },
                },
            },
        },
        serverHttp,
        transportCloseTimeoutMs: 10,
    };

    await assert.rejects(
        __shutdownAgentServerRuntime(dependencies),
        (error) => error?.code === 'PLOINKY_AGENT_SERVER_SHUTDOWN_TIMEOUT'
            && Object.isFrozen(error.evidence)
            && error.evidence.transportCount === 1,
    );
    assert.ok(calls.indexOf('transport:1') < calls.indexOf('http-close-all'));
    await __shutdownAgentServerRuntime(dependencies);
    assert.equal(transportAttempts, 2);
    assert.equal(calls.filter((entry) => entry === 'http-close-all').length, 2);
});

test('TaskQueue shutdown retries the exact provider runtime cleanup authority retained by AgentServer', async () => {
    let closeAttempts = 0;
    const cleanupError = Object.freeze(Object.assign(new Error('HOME release proof failed'), {
        code: 'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED',
        ownershipRetained: true,
    }));
    const runtime = fakeRuntime({ used: true });
    runtime.close = async () => {
        closeAttempts += 1;
        runtime.calls.push(`close:${closeAttempts}`);
        if (closeAttempts === 1) throw cleanupError;
    };
    const queue = new TaskQueue({
        maxConcurrent: 1,
        executor: (_spec, payload, options) => __executeProviderModuleWithRuntime({
            execute: async () => ({ ok: true, response: { value: 'done' } }),
            payload,
            provider: 'codex',
            providerRuntime: runtime,
            registerRetainedCleanup: options.onRetainedCleanup,
        }),
    });
    const task = queue.enqueueTask({
        toolName: 'provider-task',
        commandSpec: {
            kind: 'provider-module',
            provider: 'codex',
            module: '/code/provider.mjs',
            exportName: 'execute',
            sandboxMode: 'task',
        },
        payload: { tool: 'execute-task', input: { prompt: 'work' } },
    });
    await waitFor(() => queue.getTask(task.id)?.status === 'failed');
    assert.equal(queue.lifecycleFailure?.error, cleanupError);
    assert.equal(closeAttempts, 1);
    await queue.close();
    assert.equal(closeAttempts, 2);
    assert.equal(queue.lifecycleFailure, null);
    assert.equal(queue.cleanupComplete, true);
});

test('TaskQueue retains and retries every concurrent provider cleanup authority independently', async () => {
    const attempts = new Map([['a', 0], ['b', 0]]);
    const failureFor = (name) => Object.freeze(Object.assign(new Error(`${name} cleanup unproven`), {
        code: 'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED',
        ownershipRetained: true,
    }));
    const runtimes = Object.fromEntries(['a', 'b'].map((name) => {
        const runtime = fakeRuntime({ used: true });
        runtime.close = async () => {
            const attempt = attempts.get(name) + 1;
            attempts.set(name, attempt);
            if (attempt === 1 || (name === 'b' && attempt === 2)) throw failureFor(name);
        };
        return [name, runtime];
    }));
    const queue = new TaskQueue({
        maxConcurrent: 2,
        executor: (_spec, payload, options) => __executeProviderModuleWithRuntime({
            execute: async () => ({ ok: true, response: { value: payload.name } }),
            payload,
            provider: 'codex',
            providerRuntime: runtimes[payload.name],
            registerRetainedCleanup: options.onRetainedCleanup,
        }),
    });
    const tasks = ['a', 'b'].map((name) => queue.enqueueTask({
        toolName: `provider-task-${name}`,
        commandSpec: {
            kind: 'provider-module',
            provider: 'codex',
            module: '/code/provider.mjs',
            exportName: 'execute',
            sandboxMode: 'task',
        },
        payload: { name, tool: 'execute-task', input: { prompt: name } },
    }));
    await waitFor(() => tasks.every((task) => queue.getTask(task.id)?.status === 'failed'));
    assert.equal(queue.lifecycleFailures.size, 2);
    await assert.rejects(
        queue.close(),
        (error) => error?.code === 'PLOINKY_PROVIDER_TERMINAL_CLEANUP_FAILED',
    );
    assert.deepEqual(Object.fromEntries(attempts), { a: 2, b: 2 });
    assert.equal(queue.lifecycleFailures.size, 1);
    assert.equal(queue.cleanupComplete, false);
    await queue.close();
    assert.deepEqual(Object.fromEntries(attempts), { a: 2, b: 3 });
    assert.equal(queue.lifecycleFailures.size, 0);
    assert.equal(queue.lifecycleFailure, null);
    assert.equal(queue.cleanupComplete, true);
});

test('AgentServer logs redact login continuation capabilities and secret responses', () => {
    assert.deepEqual(__sanitizeProviderLogValue({
        operation: 'login_respond',
        flowId: 'login:public-id',
        continuationHandle: 'capability-must-not-log',
        response: 'oauth-code-must-not-log',
        nested: { secretResponse: 'also-secret' },
    }), {
        operation: 'login_respond',
        flowId: 'login:public-id',
        continuationHandle: '[redacted]',
        response: '[redacted]',
        nested: { secretResponse: '[redacted]' },
    });
});
