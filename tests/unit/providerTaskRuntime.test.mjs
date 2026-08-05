import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    __testables as credentialContextTestables,
} from '../../Agent/lib/agentCredentialContext.mjs';
import {
    createProviderTaskRuntime,
} from '../../Agent/lib/providerTaskRuntime.mjs';
import {
    startScopedSoulBrokerRegistry,
} from '../../Agent/lib/scopedSoulBroker.mjs';
import { buildBwrapAgentCredential } from '../../cli/sandbox/bwrap/bwrapAgentCredential.js';

const PRINCIPAL = 'agent:AchillesCLI/opencodeAgent';
const INSTANCE = 'opencodeAgent_alias-1';
const GENERATION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const TEST_UID = typeof process.getuid === 'function' ? process.getuid() : 501;
const TEST_IDENTITY = 'linux-proc:11111111-1111-4111-8111-111111111111:100';

function runtimeIdentityOptions() {
    return {
        inspectProcessIdentity: () => ({
            state: 'identified',
            processIdentity: TEST_IDENTITY,
            processUid: TEST_UID,
        }),
        getUid: () => TEST_UID,
    };
}

function credentialContext() {
    const generated = buildBwrapAgentCredential({
        principalId: PRINCIPAL,
        instanceId: INSTANCE,
        enableGeneration: GENERATION,
        runtimeKey: INSTANCE,
        routeKey: 'opencodeAgent',
        router: {
            physicalOrigin: 'http://127.0.0.1:8080',
            requestAuthority: '127.0.0.1:18080',
            host: '127.0.0.1',
            port: 8080,
        },
        admission: {
            runtimeKind: 'bwrap',
            manifestDigest: `sha256:${'1'.repeat(64)}`,
            capabilityDigest: `sha256:${'2'.repeat(64)}`,
            networkHash: `sha256:${'3'.repeat(64)}`,
        },
    }, {
        now: Math.floor(Date.now() / 1000) - 10,
        randomBytes: () => Buffer.alloc(32, 7),
        buildCredentialEnv: () => ({
            PLOINKY_AGENT_SECRET: 'a'.repeat(64),
            PLOINKY_AGENT_PRIVATE_SECRET: 'b'.repeat(64),
            PLOINKY_AGENT_API_KEY: `${PRINCIPAL}|fixture-signature`,
            PLOINKY_AGENT_API_PUBLIC_KEY: Buffer.alloc(32, 8).toString('base64url'),
        }),
    });
    return credentialContextTestables.createBwrapContextFromRead({
        descriptor: generated.descriptor,
        publicAttestation: generated.publicAttestation,
    });
}

function requestBroker(environment, payload) {
    const target = new URL(`${environment.PLOINKY_TASK_BROKER_URL}/chat/completions`);
    const body = Buffer.from(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
        const request = http.request(target, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${environment.PLOINKY_TASK_BROKER_KEY}`,
                'content-type': 'application/json',
                'content-length': body.length,
            },
        }, (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
        request.end(body);
    });
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function fakeChild(pid = 4242) {
    const child = new EventEmitter();
    child.pid = pid;
    child.killed = false;
    child.kill = (signal) => {
        child.killed = signal;
        return true;
    };
    return child;
}

function fakeProcessControl(child) {
    const signals = [];
    return Object.freeze({
        ownership: Object.freeze({
            pid: child.pid,
            processIdentity: TEST_IDENTITY,
            processUid: TEST_UID,
        }),
        signal(signal) {
            signals.push(signal);
            child.killed = signal;
            return true;
        },
        async terminate() {
            signals.push('terminate');
            child.killed = 'SIGKILL';
            return { evidence: [] };
        },
        signals,
    });
}

function pipedFakeChild(pid = 4242) {
    const child = fakeChild(pid);
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

test('provider runtime rejects an already-aborted launch before invoking any provider spawn adapter', async (t) => {
    for (const provider of ['codex', 'opencode', 'pi']) {
        await t.test(provider, async (providerTest) => {
            const context = credentialContext();
            const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
            providerTest.after(() => registry.close());
            const controller = new AbortController();
            const reason = new Error(`cancelled before ${provider} spawn`);
            controller.abort(reason);
            let spawnCalls = 0;
            const runtime = createProviderTaskRuntime({
                credentialContext: context,
                brokerRegistry: registry,
                mode: 'task',
                provider,
                taskId: `task:pre-aborted:${provider}`,
                audience: `${PRINCIPAL}/execute-task`,
                signal: controller.signal,
                ...runtimeIdentityOptions(),
            });

            await assert.rejects(
                runtime.spawnWith(async () => {
                    spawnCalls += 1;
                    throw new Error('spawn adapter must not run');
                }, { workdir: 'projects/alpha' }),
                (error) => error?.code === 'PLOINKY_PROVIDER_RUNTIME_ABORTED'
                    && error?.cause === reason,
            );
            assert.equal(spawnCalls, 0);
            assert.equal(runtime.assertBoundaryUnused(), true);
            await runtime.close();
        });
    }
});

test('provider runtime propagates its trusted signal across asynchronous adapter bootstrap', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const controller = new AbortController();
    const entered = deferred();
    const release = deferred();
    const reason = new Error('cancelled during adapter bootstrap');
    let providerSpawnCalls = 0;
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'codex',
        taskId: 'task:adapter-bootstrap-abort',
        audience: `${PRINCIPAL}/execute-task`,
        signal: controller.signal,
        ...runtimeIdentityOptions(),
    });

    const launch = runtime.spawnWith(async (_input, lifecycle) => {
        assert.equal(lifecycle.signal, controller.signal);
        entered.resolve();
        await release.promise;
        lifecycle.signal.throwIfAborted();
        providerSpawnCalls += 1;
        throw new Error('provider spawn must not run after cancellation');
    }, { workdir: 'projects/alpha' });
    await entered.promise;
    controller.abort(reason);
    release.resolve();

    await assert.rejects(launch, (error) => error === reason);
    assert.equal(providerSpawnCalls, 0);
    await runtime.close();
});

test('provider runtime keeps context and broker private and activates only at the helper barrier', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const completion = deferred();
    const spawned = [];
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:1',
        audience: `${PRINCIPAL}/execute-task`,
        onSpawn: (child) => spawned.push(child.pid),
        ...runtimeIdentityOptions(),
    });

    assert.deepEqual(Object.keys(runtime).sort(), [
        'assertBoundaryUnused', 'assertBoundaryUsed', 'audience', 'claimRetainedOperation', 'close', 'continueOperation',
        'launch', 'launchRetainedOperation', 'mode', 'provider', 'resolveHomeState', 'spawnWith', 'taskId',
        'transitionToTask',
    ]);
    assert.equal(runtime.credentialContext, undefined);
    assert.equal(runtime.brokerEnvironment, undefined);
    assert.throws(
        () => runtime.assertBoundaryUsed(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_REQUIRED' },
    );
    assert.equal(runtime.assertBoundaryUnused(), true);

    let adapterInput;
    let adapterLifecycle;
    let afterExitLaunch;
    const lifecycleEvents = [];
    const handle = await runtime.spawnWith(async (input, lifecycle) => {
        adapterInput = input;
        adapterLifecycle = lifecycle;
        assert.equal(await requestBroker(input.environment, { model: 'invalid' }), 401);
        lifecycle.activateCapability({ provider: 'opencode', mode: 'task' });
        assert.equal(await requestBroker(input.environment, { model: 'invalid' }), 400);
        const child = fakeChild();
        const processControl = fakeProcessControl(child);
        lifecycle.onSpawn(child, processControl);
        return {
            child,
            processControl,
            completion: completion.promise,
            cleanup() {},
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'opencode',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
                env: { PLOINKY_TASK_BROKER_KEY: 'must-not-escape' },
            },
        };
    }, {
        workdir: 'projects/alpha',
        args: ['run', 'hello'],
    }, {
        environment: { PLOINKY_PROVIDER_MODEL: 'soul/fast' },
        observeProcess(child) {
            lifecycleEvents.push(`observe:${child.pid}`);
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        afterExit({ launch }) {
            afterExitLaunch = launch;
        },
    });

    assert.equal(adapterInput.credentialContext, context);
    assert.equal(adapterInput.environment.PLOINKY_PROVIDER_MODEL, 'soul/fast');
    assert.match(adapterInput.environment.PLOINKY_TASK_BROKER_URL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(spawned[0], 4242);
    assert.deepEqual(lifecycleEvents, ['observe:4242']);
    assert.equal(handle.launch.env, undefined);
    assert.equal(handle.launch.cwd, '/workspace/projects/alpha');
    assert.equal(runtime.assertBoundaryUsed(), true);
    await adapterLifecycle.afterExit({
        code: 0,
        signal: null,
        launch: {
            helper: '/usr/local/libexec/ploinky-bwrap-launch',
            provider: 'opencode',
            mode: 'task',
            workdir: 'projects/alpha',
            cwd: '/workspace/projects/alpha',
            env: { PLOINKY_TASK_BROKER_KEY: 'must-not-escape' },
        },
    });
    assert.equal(afterExitLaunch.env, undefined);
    assert.equal(afterExitLaunch.cwd, '/workspace/projects/alpha');
    completion.resolve({ code: 0, signal: null });
    await handle.completion;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await requestBroker(adapterInput.environment, { model: 'invalid' }), 401);
    await runtime.close();
});

test('provider child lifecycle listeners cannot recover the raw child receiver or handles', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const completion = deferred();
    const rawChild = pipedFakeChild(4343);
    rawChild.stdio = [rawChild.stdin, rawChild.stdout, rawChild.stderr, { privateFd: 3 }];
    let rawKillCalls = 0;
    rawChild.kill = () => { rawKillCalls += 1; return true; };
    const processControl = fakeProcessControl(rawChild);
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:listener-facade',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    const handle = await runtime.spawnWith(async (_input, lifecycle) => {
        lifecycle.activateCapability({ provider: 'opencode', mode: 'task' });
        lifecycle.onSpawn(rawChild, processControl);
        return {
            child: rawChild,
            processControl,
            completion: completion.promise,
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'opencode',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
            },
        };
    }, { workdir: 'projects/alpha' });

    assert.equal(handle.child.stdio, undefined);
    let duplicateCalls = 0;
    function duplicateListener(code, signal) {
        duplicateCalls += 1;
        assert.equal(this, handle.child);
        assert.equal(this.stdio, undefined);
        assert.deepEqual([code, signal], [0, null]);
    }
    handle.child.on('close', duplicateListener).on('close', duplicateListener);
    handle.child.removeListener('close', duplicateListener);
    rawChild.emit('close', 0, null, rawChild);
    assert.equal(duplicateCalls, 1);
    handle.child.removeListener('close', duplicateListener);
    rawChild.emit('close', 0, null, rawChild);
    assert.equal(duplicateCalls, 1);

    let onceCalls = 0;
    handle.child.once('exit', function onceListener() {
        onceCalls += 1;
        assert.equal(this, handle.child);
    });
    rawChild.emit('exit', 0, null, rawChild);
    rawChild.emit('exit', 0, null, rawChild);
    assert.equal(onceCalls, 1);

    const removedListener = () => assert.fail('removed facade listener must not run');
    handle.child.once('disconnect', removedListener);
    handle.child.removeListener('disconnect', removedListener);
    rawChild.emit('disconnect', rawChild);

    let safeError;
    handle.child.once('error', function errorListener(error) {
        assert.equal(this, handle.child);
        safeError = error;
    });
    rawChild.emit('error', Object.assign(new Error('private raw child failure'), {
        code: 'ENOENT',
        retainedProcess: { child: rawChild },
    }), rawChild);
    assert.equal(safeError.message, 'provider child process emitted an error');
    assert.equal(safeError.code, 'ENOENT');
    assert.equal(safeError.retainedProcess, undefined);
    assert.equal(safeError.cause, undefined);
    assert.throws(
        () => handle.child.on('message', () => {}),
        { code: 'PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID' },
    );
    handle.child.kill('SIGTERM');
    assert.deepEqual(processControl.signals, ['SIGTERM']);
    assert.equal(rawKillCalls, 0);

    completion.resolve({ code: 0, signal: null });
    await handle.completion;
    await runtime.close();
});

test('provider runtime keeps raw retained-process authority private and retries after terminal proof', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const terminal = deferred();
    const rawChild = pipedFakeChild(4444);
    rawChild.stdio = [rawChild.stdin, rawChild.stdout, rawChild.stderr, { privateFd: 3 }];
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:retained-private',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    const lowLevel = Object.assign(new Error('raw provider identity failure'), {
        code: 'PLOINKY_PROVIDER_PROCESS_IDENTITY_UNVERIFIED',
        ownershipRetained: true,
        evidence: { terminalObserved: false, transportClosed: true, pid: rawChild.pid },
        retainedProcess: Object.freeze({
            pid: rawChild.pid,
            child: rawChild,
            terminal: terminal.promise,
        }),
    });

    await assert.rejects(
        runtime.spawnWith(async () => { throw lowLevel; }, { workdir: 'projects/alpha' }),
        (error) => error?.code === 'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN'
            && error.ownershipRetained === true
            && error.retainedProcess === undefined
            && error.cause === undefined
            && Object.isFrozen(error.evidence)
            && JSON.stringify(error.evidence).includes(String(rawChild.pid)) === false,
    );
    await assert.rejects(
        runtime.close(),
        (error) => error?.code === 'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN'
            && error.retainedProcess === undefined
            && error.cause === undefined,
    );
    terminal.resolve({ code: null, signal: 'SIGTERM' });
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.close();
});

test('retained operation controller hides process identity and is claimable exactly once', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const completion = deferred();
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'operation',
        provider: 'codex',
        taskId: 'operation:login-start',
        audience: `${PRINCIPAL}/login_start`,
        async spawnProviderSandbox(_input, lifecycle) {
            lifecycle.activateCapability({ provider: 'codex', mode: 'operation' });
            const child = pipedFakeChild(8361);
            const processControl = fakeProcessControl(child);
            lifecycle.onSpawn(child, processControl);
            return {
                child,
                processControl,
                completion: completion.promise,
                launch: {
                    helper: '/usr/local/libexec/ploinky-bwrap-launch',
                    provider: 'codex',
                    mode: 'operation',
                    workdir: null,
                    cwd: '/workspace/operation',
                },
            };
        },
        ...runtimeIdentityOptions(),
    });
    const controller = await runtime.launchRetainedOperation({
        command: ['/home/agent/.local/bin/codex', 'login', '--device-auth'],
    });

    assert.deepEqual(Object.keys(controller).sort(), [
        'completion', 'launch', 'stderr', 'stdin', 'stdout',
    ]);
    assert.equal(controller.pid, undefined);
    assert.equal(controller.kill, undefined);
    assert.equal(runtime.claimRetainedOperation(controller), true);
    assert.throws(
        () => runtime.claimRetainedOperation(controller),
        { code: 'PLOINKY_PROVIDER_RUNTIME_RETAIN_INVALID' },
    );
    assert.throws(
        () => runtime.assertBoundaryUnused(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_UNEXPECTED' },
    );
    completion.resolve({ code: 0, signal: null });
    await controller.completion;
    await runtime.close();
});

test('provider runtime rejects lifecycle/context overrides and wrong-boundary activation', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'pi',
        taskId: 'task:2',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    await assert.rejects(
        runtime.spawnWith(() => {}, { workdir: 'projects/alpha', credentialContext: {} }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID' },
    );
    await assert.rejects(
        runtime.spawnWith(() => {}, { workdir: 'projects/alpha' }, { leaseRoot: '/tmp/escape' }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID' },
    );
    await assert.rejects(
        runtime.spawnWith(async (_input, lifecycle) => {
            lifecycle.activateCapability({ provider: 'opencode', mode: 'task' });
        }, { workdir: 'projects/alpha' }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID' },
    );
    await runtime.close();
});

test('provider runtime rejects adapters that bypass canonical helper activation', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'codex',
        taskId: 'task:3',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    const child = fakeChild(5252);
    const processControl = fakeProcessControl(child);
    await assert.rejects(
        runtime.spawnWith(async () => ({
            child,
            processControl,
            completion: Promise.resolve({ code: 0, signal: null }),
            cleanup() {},
            launch: {
                helper: '/usr/bin/bwrap',
                provider: 'codex',
                mode: 'task',
            },
        }), { workdir: 'projects/alpha' }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID' },
    );
    assert.equal(child.killed, 'SIGKILL');
    await runtime.close();
});

test('floating launch is not a pure control and close waits for exact pending-launch cleanup', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const adapterEntered = deferred();
    const adapterGate = deferred();
    // The production adapter is injected through spawnWith for this race so it
    // can be held before publishing a process controller.
    const floatingRuntime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'operation',
        provider: 'pi',
        taskId: 'operation:floating-close',
        audience: `${PRINCIPAL}/login_status`,
        async spawnProviderSandbox(_input, lifecycle) {
            adapterEntered.resolve();
            await adapterGate.promise;
            lifecycle.activateCapability({ provider: 'pi', mode: 'operation' });
            const child = pipedFakeChild(8585);
            const processControl = fakeProcessControl(child);
            lifecycle.onSpawn(child, processControl);
            return {
                child,
                processControl,
                completion: Promise.resolve({ code: 0, signal: null }),
                launch: {
                    helper: '/usr/local/libexec/ploinky-bwrap-launch',
                    provider: 'pi',
                    mode: 'operation',
                    workdir: null,
                    cwd: '/workspace/operation',
                },
            };
        },
        ...runtimeIdentityOptions(),
    });
    const floatingLaunch = floatingRuntime.launch({ command: ['/home/agent/.local/bin/pi', '--version'] });
    await adapterEntered.promise;
    assert.throws(
        () => floatingRuntime.assertBoundaryUnused(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_UNEXPECTED' },
    );
    let closeSettled = false;
    const closing = floatingRuntime.close().then(() => { closeSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    adapterGate.resolve();
    await assert.rejects(floatingLaunch, { code: 'PLOINKY_PROVIDER_RUNTIME_BOUNDARY_INVALID' });
    await closing;

});

test('provider runtime accepts a canonical helper that exits and revokes before its handle returns', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:fast-exit',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    let environment;
    const handle = await runtime.spawnWith(async (input, lifecycle) => {
        environment = input.environment;
        lifecycle.activateCapability({ provider: 'opencode', mode: 'task' });
        assert.equal(await requestBroker(environment, { model: 'invalid' }), 400);
        lifecycle.deactivateCapability();
        const child = fakeChild(6262);
        const processControl = fakeProcessControl(child);
        lifecycle.onSpawn(child, processControl);
        return {
            child,
            processControl,
            completion: Promise.resolve({ code: 2, signal: null }),
            cleanup() {},
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'opencode',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
            },
        };
    }, { workdir: 'projects/alpha', args: ['run', 'hello'] });
    assert.deepEqual(await handle.completion, { code: 2, signal: null });
    assert.equal(await requestBroker(environment, { model: 'invalid' }), 401);
    await runtime.close();
});

test('provider runtime binds a private named operation to the exact operation sandbox mode', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'operation',
        provider: 'codex',
        taskId: 'operation:models',
        audience: `${PRINCIPAL}/openai.models`,
        ...runtimeIdentityOptions(),
    });
    const handle = await runtime.spawnWith(async (_input, lifecycle) => {
        assert.equal(lifecycle.leaseMetadata.mode, 'operation');
        lifecycle.activateCapability({ provider: 'codex', mode: 'operation' });
        const child = fakeChild(6363);
        const processControl = fakeProcessControl(child);
        lifecycle.onSpawn(child, processControl);
        return {
            child,
            processControl,
            completion: Promise.resolve({ code: 0, signal: null }),
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'codex',
                mode: 'operation',
                workdir: null,
                cwd: '/workspace/operation',
            },
        };
    }, { command: ['app-server', '--stdio'] });
    assert.equal(handle.launch.mode, 'operation');
    assert.equal(handle.launch.workdir, null);
    assert.equal(runtime.assertBoundaryUsed(), true);
    await handle.completion;
    await runtime.close();
});

test('provider runtime resolves trusted HOME state under lease then revalidates after task lease before launch', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'operation',
        provider: 'pi',
        taskId: 'continuation:1',
        audience: `${PRINCIPAL}/continue-task`,
        async withCredentialProviderHomeLease(input, callback) {
            assert.equal(input.credentialContext, context);
            assert.deepEqual({ ...input, credentialContext: undefined }, {
                credentialContext: undefined,
                provider: 'pi',
                taskId: 'continuation:1',
                audience: `${PRINCIPAL}/continue-task`,
            });
            return callback(Object.freeze({
                homePath: '/home/agent',
                provider: 'pi',
                runtimeKind: 'bwrap',
            }));
        },
        ...runtimeIdentityOptions(),
    });

    assert.throws(
        () => runtime.transitionToTask(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID' },
    );

    const selected = await runtime.resolveHomeState((home) => {
        assert.deepEqual(home, {
            homePath: '/home/agent',
            provider: 'pi',
            runtimeKind: 'bwrap',
        });
        return Object.freeze({ sessionId: 'session-1', workdir: 'projects/alpha' });
    });
    assert.deepEqual(selected, { sessionId: 'session-1', workdir: 'projects/alpha' });
    await assert.rejects(
        runtime.spawnWith(() => {
            throw new Error('must not reach operation adapter after HOME resolution');
        }, { command: ['/home/agent/.local/bin/pi', '--continue', 'opaque'] }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_STATE_INVALID' },
    );

    assert.equal(runtime.transitionToTask(), 'task');
    assert.equal(runtime.mode, 'task');
    assert.throws(
        () => runtime.transitionToTask(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID' },
    );
    await assert.rejects(
        runtime.spawnWith(() => {
            throw new Error('must not launch without task-lease revalidation');
        }, {
            workdir: 'projects/alpha',
            command: ['/home/agent/.local/bin/pi', '--continue', 'opaque'],
        }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID' },
    );

    const taskCompletion = deferred();
    const task = await runtime.spawnWith(async (_input, lifecycle) => {
        await lifecycle.validateAfterLease({
            provider: 'pi',
            mode: 'task',
            workdir: 'projects/alpha',
            homePath: '/home/agent',
            runtimeKind: 'bwrap',
        });
        lifecycle.activateCapability({ provider: 'pi', mode: 'task' });
        const child = pipedFakeChild(8102);
        const processControl = fakeProcessControl(child);
        lifecycle.onSpawn(child, processControl);
        return {
            child,
            processControl,
            completion: taskCompletion.promise,
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'pi',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
            },
        };
    }, { workdir: 'projects/alpha', command: ['/home/agent/.local/bin/pi', '--continue', 'opaque'] }, {
        validateAfterLease(home) {
            assert.deepEqual(home, {
                provider: 'pi',
                mode: 'task',
                workdir: 'projects/alpha',
                homePath: '/home/agent',
                runtimeKind: 'bwrap',
            });
            assert.deepEqual(selected, { sessionId: 'session-1', workdir: 'projects/alpha' });
        },
    });
    taskCompletion.resolve({ code: 0, signal: null });
    await task.completion;
    await runtime.close();
});

test('provider runtime never resolves or transitions after a failed HOME resolver or from task mode', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const taskRuntime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:no-transition',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    assert.throws(
        () => taskRuntime.transitionToTask(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID' },
    );
    assert.throws(
        () => taskRuntime.continueOperation(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID' },
    );
    await assert.rejects(
        taskRuntime.resolveHomeState(() => ({})),
        { code: 'PLOINKY_PROVIDER_RUNTIME_STATE_INVALID' },
    );
    await taskRuntime.close();

    const operationRuntime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'operation',
        provider: 'codex',
        taskId: 'continuation:failed',
        audience: `${PRINCIPAL}/continue-task`,
        async withCredentialProviderHomeLease(_input, callback) {
            return callback(Object.freeze({
                homePath: '/home/agent',
                provider: 'codex',
                runtimeKind: 'bwrap',
            }));
        },
        ...runtimeIdentityOptions(),
    });
    await assert.rejects(
        operationRuntime.resolveHomeState(() => {
            throw new Error('invalid continuation record');
        }),
        /invalid continuation record/,
    );
    await assert.rejects(
        operationRuntime.resolveHomeState(() => ({})),
        { code: 'PLOINKY_PROVIDER_RUNTIME_STATE_INVALID' },
    );
    assert.throws(
        () => operationRuntime.transitionToTask(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID' },
    );
    await operationRuntime.close();
});

test('provider runtime can explicitly continue a revalidated operation after trusted HOME resolution', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'operation',
        provider: 'opencode',
        taskId: 'operation:login-control',
        audience: `${PRINCIPAL}/login_status`,
        async withCredentialProviderHomeLease(_input, callback) {
            return callback(Object.freeze({
                homePath: '/home/agent',
                provider: 'opencode',
                runtimeKind: 'bwrap',
            }));
        },
        ...runtimeIdentityOptions(),
    });
    const selected = await runtime.resolveHomeState(() => Object.freeze({
        flowId: 'flow-1',
        provider: 'github-copilot',
    }));
    assert.equal(runtime.continueOperation(), 'operation');
    assert.throws(
        () => runtime.continueOperation(),
        { code: 'PLOINKY_PROVIDER_RUNTIME_TRANSITION_INVALID' },
    );
    await assert.rejects(
        runtime.spawnWith(() => {
            throw new Error('must not launch without operation-lease revalidation');
        }, { command: ['/home/agent/.opencode/bin/opencode', 'serve'] }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_INPUT_INVALID' },
    );

    const completion = deferred();
    const handle = await runtime.spawnWith(async (_input, lifecycle) => {
        await lifecycle.validateAfterLease({
            provider: 'opencode',
            mode: 'operation',
            workdir: null,
            homePath: '/home/agent',
            runtimeKind: 'bwrap',
        });
        lifecycle.activateCapability({ provider: 'opencode', mode: 'operation' });
        const child = pipedFakeChild(8401);
        const processControl = fakeProcessControl(child);
        lifecycle.onSpawn(child, processControl);
        return {
            child,
            processControl,
            completion: completion.promise,
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'opencode',
                mode: 'operation',
                workdir: null,
                cwd: '/workspace/operation',
            },
        };
    }, { command: ['/home/agent/.opencode/bin/opencode', 'serve'] }, {
        validateAfterLease(home) {
            assert.equal(home.mode, 'operation');
            assert.equal(home.workdir, null);
            assert.deepEqual(selected, { flowId: 'flow-1', provider: 'github-copilot' });
        },
    });
    completion.resolve({ code: 0, signal: null });
    await handle.completion;
    await runtime.close();
});

test('provider runtime redacts broker and private provider credentials across output chunk boundaries', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const completion = deferred();
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:redaction',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    let rawChild;
    let secret;
    const privateSecret = 'p'.repeat(43);
    const handle = await runtime.spawnWith(async (input, lifecycle) => {
        secret = input.environment.PLOINKY_TASK_BROKER_KEY;
        rawChild = pipedFakeChild(7272);
        const processControl = fakeProcessControl(rawChild);
        lifecycle.onSpawn(rawChild, processControl);
        lifecycle.activateCapability({ provider: 'opencode', mode: 'task' });
        return {
            child: rawChild,
            processControl,
            completion: completion.promise,
            cleanup() {},
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'opencode',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
            },
        };
    }, { workdir: 'projects/alpha', args: ['hello'] }, {
        environment: { OPENCODE_SERVER_PASSWORD: privateSecret },
    });
    const stdout = [];
    const stderr = [];
    handle.child.stdout.on('data', (chunk) => stdout.push(chunk));
    handle.child.stderr.on('data', (chunk) => stderr.push(chunk));
    const outputEnded = Promise.all([
        new Promise((resolve) => handle.child.stdout.once('end', resolve)),
        new Promise((resolve) => handle.child.stderr.once('end', resolve)),
    ]);
    rawChild.stdout.write(`before:${secret.slice(0, 17)}`);
    rawChild.stdout.write(`${secret.slice(17)}:middle:${privateSecret.slice(0, 19)}`);
    rawChild.stdout.end(`${privateSecret.slice(19)}:after`);
    rawChild.stderr.end(`error:${secret}:${privateSecret}`);
    completion.resolve({ code: 0, signal: null });
    await handle.completion;
    await outputEnded;
    const visible = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.doesNotMatch(visible, new RegExp(secret));
    assert.doesNotMatch(visible, new RegExp(privateSecret));
    assert.equal(visible, 'before:[REDACTED]:middle:[REDACTED]:aftererror:[REDACTED]:[REDACTED]');
    assert.equal(handle.child.stdio, undefined);
    await runtime.close();
});

test('provider runtime retains capability ownership and blocks relaunch after unproven termination', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const abortController = new AbortController();
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:retained-termination',
        audience: `${PRINCIPAL}/execute-task`,
        signal: abortController.signal,
        ...runtimeIdentityOptions(),
    });
    const completion = deferred();
    let environment;
    const child = fakeChild(8282);
    const terminationError = new Error('exact child termination is unproven');
    terminationError.code = 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN';
    terminationError.ownershipRetained = true;
    terminationError.evidence = Object.freeze({ phase: 'after-kill', pid: child.pid });
    const processControl = Object.freeze({
        ownership: Object.freeze({
            pid: child.pid,
            processIdentity: TEST_IDENTITY,
            processUid: TEST_UID,
        }),
        signal() { throw terminationError; },
        terminate() { return Promise.reject(terminationError); },
    });
    await runtime.spawnWith(async (input, lifecycle) => {
        environment = input.environment;
        lifecycle.activateCapability({ provider: 'opencode', mode: 'task' });
        lifecycle.onSpawn(child, processControl);
        return {
            child,
            processControl,
            completion: completion.promise,
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'opencode',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
            },
        };
    }, { workdir: 'projects/alpha' });
    assert.equal(await requestBroker(environment, { model: 'invalid' }), 400);

    abortController.abort();
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
        runtime.spawnWith(() => {}, { workdir: 'projects/beta' }),
        { code: 'PLOINKY_PROVIDER_RUNTIME_STATE_INVALID' },
    );
    assert.equal(await requestBroker(environment, { model: 'invalid' }), 400);
    await assert.rejects(
        runtime.close(),
        (error) => error?.code === 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN'
            || error?.code === 'PLOINKY_PROVIDER_RUNTIME_TERMINATION_UNPROVEN',
    );
});

test('provider runtime retries exact retained cleanup after an unproven close attempt', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const completion = deferred();
    const child = pipedFakeChild(8338);
    const firstError = new Error('first exact termination attempt is unproven');
    firstError.code = 'PLOINKY_PROVIDER_TERMINATION_UNPROVEN';
    firstError.ownershipRetained = true;
    let attempts = 0;
    const processControl = Object.freeze({
        ownership: Object.freeze({
            pid: child.pid,
            processIdentity: TEST_IDENTITY,
            processUid: TEST_UID,
        }),
        signal() { return true; },
        async terminate() {
            attempts += 1;
            if (attempts === 1) throw firstError;
            completion.resolve({ code: null, signal: 'SIGTERM' });
            return { evidence: [{ phase: 'dead' }] };
        },
    });
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'operation',
        provider: 'codex',
        taskId: 'operation:retry-retained-cleanup',
        audience: `${PRINCIPAL}/login_start`,
        spawnProviderSandbox: async (_input, lifecycle) => {
            lifecycle.onSpawn(child, processControl);
            lifecycle.activateCapability({ provider: 'codex', mode: 'operation' });
            return {
                child,
                processControl,
                completion: completion.promise,
                launch: {
                    helper: '/usr/local/libexec/ploinky-bwrap-launch',
                    provider: 'codex',
                    mode: 'operation',
                    workdir: 'operation',
                    cwd: '/workspace/operation',
                },
            };
        },
        ...runtimeIdentityOptions(),
    });
    const retained = await runtime.launchRetainedOperation({ args: ['login', '--device-auth'] }, {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    runtime.claimRetainedOperation(retained);

    await assert.rejects(runtime.close(), (error) => error === firstError);
    assert.equal(attempts, 1);
    await runtime.close();
    assert.equal(attempts, 2);
});

test('provider runtime revokes capability after proven termination even when completion reports an ordinary error', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        mode: 'task',
        provider: 'opencode',
        taskId: 'task:ordinary-completion-error',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    const completion = deferred();
    const child = fakeChild(8383);
    const completionError = new Error('afterExit callback failed after exact cleanup');
    let environment;
    const processControl = Object.freeze({
        ownership: Object.freeze({
            pid: child.pid,
            processIdentity: TEST_IDENTITY,
            processUid: TEST_UID,
        }),
        signal() { return true; },
        async terminate() {
            child.killed = 'SIGTERM';
            completion.reject(completionError);
            return { evidence: [{ phase: 'dead' }] };
        },
    });
    await runtime.spawnWith(async (input, lifecycle) => {
        environment = input.environment;
        lifecycle.activateCapability({ provider: 'opencode', mode: 'task' });
        lifecycle.onSpawn(child, processControl);
        return {
            child,
            processControl,
            completion: completion.promise,
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'opencode',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
            },
        };
    }, { workdir: 'projects/alpha' });
    assert.equal(await requestBroker(environment, { model: 'invalid' }), 400);
    await assert.rejects(runtime.close(), (error) => error === completionError);
    assert.equal(await requestBroker(environment, { model: 'invalid' }), 401);
});
