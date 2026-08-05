import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderOperationSessionRegistry } from '../../Agent/lib/providerOperationSessions.mjs';

const OWNER = 'a'.repeat(64);
const OTHER_OWNER = 'b'.repeat(64);
const HANDLE = 'h'.repeat(43);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
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
            if (!used) throw new Error('boundary required');
        },
        assertBoundaryUnused() {
            calls.push('assert-unused');
            if (used) throw new Error('boundary unexpected');
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

function controller(completion) {
    return Object.freeze({
        stdin: Object.freeze({ write() {} }),
        stdout: Object.freeze({ on() {} }),
        stderr: Object.freeze({ on() {} }),
        completion,
        launch: Object.freeze({ provider: 'codex', mode: 'operation' }),
    });
}

function createRegistry(id = '11111111-2222-4333-8444-555555555555') {
    return createProviderOperationSessionRegistry({
        createId: () => id,
        createHandle: () => HANDLE,
    });
}

function invocation(registry, {
    provider = 'codex', operation, ownerBinding = OWNER, runtime,
}) {
    return registry.createInvocation({ provider, operation, ownerBinding, providerRuntime: runtime });
}

test('retained login is inaccessible until exact publication commits, then pure status is owner and handle bound', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const startRuntime = fakeRuntime({ used: true, controller: retainedController });
    const closeGate = deferred();
    startRuntime.close = async () => {
        startRuntime.calls.push('close');
        await closeGate.promise;
    };
    const registry = createRegistry();
    const start = invocation(registry, {
        operation: 'login_start',
        runtime: startRuntime,
    });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'openai',
        method: 'device_code',
        initialState: {
            status: 'running',
            challenge: {
                type: 'device_code',
                verificationUri: 'https://auth.openai.com/codex/device',
                userCode: 'ABCD-EFGH',
            },
        },
        onCompletion({ outcome }) {
            assert.deepEqual(outcome, { code: 0, signal: null });
            return { status: 'completed' };
        },
    });
    assert.equal(start.disposition(), 'staged');
    const control = { flowId: state.flowId, continuationHandle: state.continuationHandle };

    const premature = invocation(registry, {
        operation: 'login_status',
        runtime: fakeRuntime(),
    });
    await assert.rejects(
        premature.providerApi.getLoginStatus(control),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_FLOW_NOT_FOUND',
    );

    start.commitRetainedOperation(state);
    assert.equal(start.disposition(), 'retained');
    assert.deepEqual(startRuntime.calls, ['assert-used', 'claim']);

    for (const [ownerBinding, continuationHandle] of [
        [OTHER_OWNER, HANDLE],
        [OWNER, 'x'.repeat(43)],
    ]) {
        const denied = invocation(registry, {
            operation: 'login_status',
            ownerBinding,
            runtime: fakeRuntime(),
        });
        await assert.rejects(
            denied.providerApi.getLoginStatus({ ...control, continuationHandle }),
            (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_FLOW_NOT_FOUND',
        );
    }

    const statusRuntime = fakeRuntime();
    const status = invocation(registry, {
        operation: 'login_status',
        runtime: statusRuntime,
    });
    assert.equal((await status.providerApi.getLoginStatus(control)).status, 'running');
    await assert.rejects(
        status.providerApi.getLoginStatus(control),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_INVOCATION_INVALID',
    );
    assert.deepEqual(statusRuntime.calls, ['assert-unused']);

    terminal.resolve({ code: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    const beforeCleanup = invocation(registry, {
        operation: 'login_status',
        runtime: fakeRuntime(),
    });
    assert.equal((await beforeCleanup.providerApi.getLoginStatus(control)).status, 'running');
    closeGate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    const completed = invocation(registry, {
        operation: 'login_status',
        runtime: fakeRuntime(),
    });
    assert.equal((await completed.providerApi.getLoginStatus(control)).status, 'completed');
    assert.deepEqual(startRuntime.calls, ['assert-used', 'claim', 'close']);
    await registry.close();
});

test('manual response is prompt-bound, single-use, and never persisted', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const runtime = fakeRuntime({ provider: 'pi', used: true, controller: retainedController });
    const registry = createRegistry('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const start = invocation(registry, {
        provider: 'pi', operation: 'login_start', runtime,
    });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'anthropic:oauth',
        method: 'manual_oauth_code',
        initialState: {
            status: 'waiting',
            prompt: { type: 'manual_code', seq: 1, nonce: 'nonce-0000000001' },
        },
        async onRespond({ response, publish }) {
            assert.equal(response, 'one-secret-response');
            publish({ status: 'running' });
        },
    });
    start.commitRetainedOperation(state);
    const control = { flowId: state.flowId, continuationHandle: state.continuationHandle };
    const respond = invocation(registry, {
        provider: 'pi', operation: 'login_respond', runtime: fakeRuntime({ provider: 'pi' }),
    });
    const running = await respond.providerApi.respondToLogin(control, {
        seq: 1,
        nonce: 'nonce-0000000001',
        response: 'one-secret-response',
    });
    assert.equal(running.status, 'running');
    assert.equal(JSON.stringify(running).includes('one-secret-response'), false);

    const duplicate = invocation(registry, {
        provider: 'pi', operation: 'login_respond', runtime: fakeRuntime({ provider: 'pi' }),
    });
    await assert.rejects(
        duplicate.providerApi.respondToLogin(control, {
            seq: 1,
            nonce: 'nonce-0000000001',
            response: 'duplicate',
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_RESPONSE_INVALID',
    );
    await registry.close();
});

test('cancel publishes terminal state only after exact retained cleanup', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const closeGate = deferred();
    const runtime = fakeRuntime({ provider: 'opencode', used: true, controller: retainedController });
    runtime.close = async () => {
        runtime.calls.push('close');
        await closeGate.promise;
        terminal.resolve({ code: null, signal: 'SIGTERM' });
    };
    const registry = createRegistry('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
    const start = invocation(registry, {
        provider: 'opencode', operation: 'login_start', runtime,
    });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'github-copilot',
        method: 'device_code',
        initialState: { status: 'running' },
    });
    start.commitRetainedOperation(state);
    const control = { flowId: state.flowId, continuationHandle: state.continuationHandle };
    const cancel = invocation(registry, {
        provider: 'opencode', operation: 'login_cancel', runtime: fakeRuntime({ provider: 'opencode' }),
    });
    const cancelling = cancel.providerApi.cancelLogin(control);
    const status = invocation(registry, {
        provider: 'opencode', operation: 'login_status', runtime: fakeRuntime({ provider: 'opencode' }),
    });
    assert.equal((await status.providerApi.getLoginStatus(control)).status, 'running');
    closeGate.resolve();
    assert.equal((await cancelling).status, 'cancelled');
    await registry.close();
});

test('forced cancellation aborts and cleans a retained runtime without queueing behind a hung callback', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const runtime = fakeRuntime({ provider: 'opencode', used: true, controller: retainedController });
    const callbackStarted = deferred();
    const callbackNeverFinishes = deferred();
    let callbackSignal;
    const registry = createRegistry('abababab-cdcd-4efe-8aba-010101010101');
    const start = invocation(registry, {
        provider: 'opencode', operation: 'login_start', runtime,
    });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'github-copilot',
        method: 'device_code',
        initialState: { status: 'running' },
        async onStatus({ signal }) {
            callbackSignal = signal;
            callbackStarted.resolve();
            await callbackNeverFinishes.promise;
        },
    });
    start.commitRetainedOperation(state);
    const control = { flowId: state.flowId, continuationHandle: state.continuationHandle };
    const status = invocation(registry, {
        provider: 'opencode', operation: 'login_status', runtime: fakeRuntime({ provider: 'opencode' }),
    });
    void status.providerApi.getLoginStatus(control).catch(() => {});
    await callbackStarted.promise;

    const cancel = invocation(registry, {
        provider: 'opencode', operation: 'login_cancel', runtime: fakeRuntime({ provider: 'opencode' }),
    });
    const cancelled = await Promise.race([
        cancel.providerApi.cancelLogin(control),
        new Promise((_, reject) => setTimeout(() => reject(new Error('forced cancellation queued behind callback')), 100)),
    ]);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(callbackSignal.aborted, true);
    assert.deepEqual(runtime.calls, ['assert-used', 'claim', 'close']);
    await registry.close();
});

test('registry close revokes invocations created before shutdown and forbids staged commit afterward', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const registry = createRegistry('cdcdcdcd-efef-4012-8b8b-020202020202');
    const late = invocation(registry, {
        operation: 'login_start',
        runtime: fakeRuntime({ used: true, controller: retainedController }),
    });
    await registry.close();
    await assert.rejects(
        late.providerApi.retainLoginOperation({
            controller: retainedController,
            authProvider: 'openai',
            method: 'device_code',
            initialState: { status: 'running' },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_REGISTRY_CLOSED',
    );

    const stagedRegistry = createRegistry('efefefef-0101-4234-8c8c-030303030303');
    const stagedRuntime = fakeRuntime({ used: true, controller: retainedController });
    const staged = invocation(stagedRegistry, { operation: 'login_start', runtime: stagedRuntime });
    const state = await staged.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'openai',
        method: 'device_code',
        initialState: { status: 'running' },
    });
    await stagedRegistry.close();
    assert.throws(
        () => staged.commitRetainedOperation(state),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_REGISTRY_CLOSED',
    );
    assert.equal(stagedRegistry.size, 0);
});

test('natural completion exposes only the fixed outcome and keeps terminal publication registry-owned', async () => {
    const completion = deferred();
    const retainedController = controller(completion.promise);
    const runtime = fakeRuntime({ used: true, controller: retainedController });
    let completionInput;
    const registry = createProviderOperationSessionRegistry({
        createId: () => 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        createHandle: () => HANDLE,
    });
    const start = registry.createInvocation({
        provider: 'codex',
        operation: 'login_start',
        ownerBinding: OWNER,
        providerRuntime: runtime,
    });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'openai',
        method: 'device_code',
        initialState: { status: 'running' },
        onCompletion(input) {
            completionInput = input;
            return { status: 'completed' };
        },
    });
    start.commitRetainedOperation(state);
    completion.resolve({ code: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(Object.keys(completionInput), ['outcome']);
    assert.deepEqual(completionInput.outcome, { code: 0, signal: null });
    const statusRuntime = fakeRuntime();
    const status = registry.createInvocation({
        provider: 'codex',
        operation: 'login_status',
        ownerBinding: OWNER,
        providerRuntime: statusRuntime,
    });
    assert.equal((await status.providerApi.getLoginStatus({
        flowId: state.flowId,
        continuationHandle: state.continuationHandle,
    })).status, 'completed');
    await registry.close();
});

test('natural completion cleanup and registry shutdown are bounded when provider completion callback hangs', async () => {
    const completion = deferred();
    const retainedController = controller(completion.promise);
    const runtime = fakeRuntime({ used: true, controller: retainedController });
    const callbackStarted = deferred();
    const callbackNeverFinishes = deferred();
    const registry = createProviderOperationSessionRegistry({
        createId: () => 'bcbcbcbc-dede-4f01-8a8a-040404040404',
        createHandle: () => HANDLE,
        setTimeout(callback, delay) {
            if (delay === 5_000) queueMicrotask(callback);
            return Object.freeze({ unref() {} });
        },
        clearTimeout() {},
    });
    const start = invocation(registry, { operation: 'login_start', runtime });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'openai',
        method: 'device_code',
        initialState: { status: 'running' },
        async onCompletion() {
            callbackStarted.resolve();
            await callbackNeverFinishes.promise;
        },
    });
    start.commitRetainedOperation(state);
    completion.resolve({ code: 0, signal: null });
    await callbackStarted.promise;
    await Promise.race([
        registry.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('registry close waited forever for completion callback')), 100)),
    ]);
    assert.deepEqual(runtime.calls, ['assert-used', 'claim', 'close']);
    assert.equal(registry.size, 0);
});

test('provider callback publication is transaction-scoped and prompt sequence never rewinds', async () => {
    const completion = deferred();
    const retainedController = controller(completion.promise);
    const runtime = fakeRuntime({ provider: 'pi', used: true, controller: retainedController });
    const registry = createRegistry('dededede-f0f0-4123-8b8b-050505050505');
    let latePublish;
    let poll = 0;
    const start = invocation(registry, { provider: 'pi', operation: 'login_start', runtime });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'anthropic',
        method: 'oauth:0',
        initialState: {
            status: 'waiting',
            prompt: { type: 'manual_code', seq: 1, nonce: 'nonce-0000000001' },
        },
        onStatus({ publish }) {
            poll += 1;
            latePublish = publish;
            if (poll === 1) publish({ status: 'running' });
            else publish({
                status: 'waiting',
                prompt: { type: 'manual_code', seq: 1, nonce: 'nonce-0000000002' },
            });
        },
    });
    start.commitRetainedOperation(state);
    const control = { flowId: state.flowId, continuationHandle: state.continuationHandle };
    const first = invocation(registry, {
        provider: 'pi', operation: 'login_status', runtime: fakeRuntime({ provider: 'pi' }),
    });
    assert.equal((await first.providerApi.getLoginStatus(control)).status, 'running');
    assert.throws(
        () => latePublish({ status: 'waiting', prompt: { type: 'manual_code', seq: 2, nonce: 'nonce-0000000003' } }),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_STATE_INVALID',
    );
    const second = invocation(registry, {
        provider: 'pi', operation: 'login_status', runtime: fakeRuntime({ provider: 'pi' }),
    });
    await assert.rejects(
        second.providerApi.getLoginStatus(control),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_STATUS_FAILED',
    );
    await registry.close();
});

test('floating rejected control is observed immediately and retained for exact AgentServer handling', async () => {
    const registry = createRegistry('f0f0f0f0-1212-4345-8d8d-060606060606');
    const status = invocation(registry, {
        operation: 'login_status',
        runtime: fakeRuntime(),
    });
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);
    try {
        void status.providerApi.getLoginStatus({
            flowId: 'login:f0f0f0f0-1212-4345-8d8d-060606060606',
            continuationHandle: HANDLE,
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
        await assert.rejects(
            status.requireControlResult(),
            (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_FLOW_NOT_FOUND',
        );
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
        await registry.close();
    }
});

test('staged publication rejects arbitrary secret-shaped state and rollback removes the unpublished record', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const runtime = fakeRuntime({ used: true, controller: retainedController });
    const registry = createRegistry('cccccccc-dddd-4eee-8fff-000000000000');
    const start = invocation(registry, { operation: 'login_start', runtime });
    await assert.rejects(
        start.providerApi.retainLoginOperation({
            controller: retainedController,
            authProvider: 'openai',
            method: 'device_code',
            initialState: {
                status: 'running',
                challenge: { type: 'device_code', verificationUri: 'https://example.test', accessToken: 'leak' },
            },
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_STATE_INVALID',
    );
    assert.equal(start.disposition(), 'unused');
    assert.equal(registry.size, 0);
    await registry.close();
});

test('response callback failures are sanitized and force exact cleanup', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const runtime = fakeRuntime({ provider: 'pi', used: true, controller: retainedController });
    const registry = createRegistry('dddddddd-eeee-4fff-8000-111111111111');
    const start = invocation(registry, {
        provider: 'pi', operation: 'login_start', runtime,
    });
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'anthropic',
        method: 'oauth:0',
        initialState: {
            status: 'waiting',
            prompt: { type: 'manual_code', seq: 1, nonce: 'nonce-0000000002' },
        },
        async onRespond() {
            throw new Error('secret-response-must-not-escape');
        },
    });
    start.commitRetainedOperation(state);
    const control = { flowId: state.flowId, continuationHandle: state.continuationHandle };
    const respond = invocation(registry, {
        provider: 'pi', operation: 'login_respond', runtime: fakeRuntime({ provider: 'pi' }),
    });
    await assert.rejects(
        respond.providerApi.respondToLogin(control, {
            seq: 1,
            nonce: 'nonce-0000000002',
            response: 'secret-response-must-not-escape',
        }),
        (error) => error?.code === 'PLOINKY_PROVIDER_LOGIN_RESPONSE_FAILED'
            && !error.message.includes('secret-response'),
    );
    assert.deepEqual(runtime.calls, ['assert-used', 'claim', 'close']);
    await registry.close();
});

test('status polling runs only through the retained owner closure and publishes fixed public state', async () => {
    const terminal = deferred();
    const retainedController = controller(terminal.promise);
    const runtime = fakeRuntime({ provider: 'opencode', used: true, controller: retainedController });
    const registry = createRegistry('eeeeeeee-ffff-4000-8111-222222222222');
    const start = invocation(registry, {
        provider: 'opencode', operation: 'login_start', runtime,
    });
    let polls = 0;
    const state = await start.providerApi.retainLoginOperation({
        controller: retainedController,
        authProvider: 'github-copilot',
        method: 'oauth',
        initialState: { status: 'running' },
        async onStatus({ publish }) {
            polls += 1;
            publish({
                status: 'running',
                challenge: {
                    type: 'authorization_url',
                    verificationUri: 'https://github.com/login/oauth/authorize?state=public-state',
                },
            });
        },
    });
    start.commitRetainedOperation(state);
    const status = invocation(registry, {
        provider: 'opencode', operation: 'login_status', runtime: fakeRuntime({ provider: 'opencode' }),
    });
    const updated = await status.providerApi.getLoginStatus({
        flowId: state.flowId,
        continuationHandle: state.continuationHandle,
    });
    assert.equal(polls, 1);
    assert.deepEqual(updated.challenge, {
        type: 'authorization_url',
        verificationUri: 'https://github.com/login/oauth/authorize?state=public-state',
    });
    assert.equal(JSON.stringify(updated).includes('OPENCODE_SERVER_PASSWORD'), false);
    await registry.close();
});
