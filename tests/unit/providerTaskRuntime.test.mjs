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

test('provider runtime keeps context and broker private and activates only at the helper barrier', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const completion = deferred();
    const spawned = [];
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        provider: 'opencode',
        taskId: 'task:1',
        audience: `${PRINCIPAL}/execute-task`,
        onSpawn: (child) => spawned.push(child.pid),
        ...runtimeIdentityOptions(),
    });

    assert.deepEqual(Object.keys(runtime).sort(), [
        'audience', 'close', 'launch', 'provider', 'spawnWith', 'taskId',
    ]);
    assert.equal(runtime.credentialContext, undefined);
    assert.equal(runtime.brokerEnvironment, undefined);

    let adapterInput;
    let adapterLifecycle;
    let afterExitLaunch;
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
        stdio: ['ignore', 'pipe', 'pipe'],
        afterExit({ launch }) {
            afterExitLaunch = launch;
        },
    });

    assert.equal(adapterInput.credentialContext, context);
    assert.equal(adapterInput.environment.PLOINKY_PROVIDER_MODEL, 'soul/fast');
    assert.match(adapterInput.environment.PLOINKY_TASK_BROKER_URL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(spawned[0], 4242);
    assert.equal(handle.launch.env, undefined);
    assert.equal(handle.launch.cwd, '/workspace/projects/alpha');
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

test('provider runtime rejects lifecycle/context overrides and wrong-boundary activation', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
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

test('provider runtime accepts a canonical helper that exits and revokes before its handle returns', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
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

test('provider runtime redacts its scoped broker credential across output chunk boundaries', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const completion = deferred();
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
        provider: 'pi',
        taskId: 'task:redaction',
        audience: `${PRINCIPAL}/execute-task`,
        ...runtimeIdentityOptions(),
    });
    let rawChild;
    let secret;
    const handle = await runtime.spawnWith(async (input, lifecycle) => {
        secret = input.environment.PLOINKY_TASK_BROKER_KEY;
        rawChild = pipedFakeChild(7272);
        const processControl = fakeProcessControl(rawChild);
        lifecycle.onSpawn(rawChild, processControl);
        lifecycle.activateCapability({ provider: 'pi', mode: 'task' });
        return {
            child: rawChild,
            processControl,
            completion: completion.promise,
            cleanup() {},
            launch: {
                helper: '/usr/local/libexec/ploinky-bwrap-launch',
                provider: 'pi',
                mode: 'task',
                workdir: 'projects/alpha',
                cwd: '/workspace/projects/alpha',
            },
        };
    }, { workdir: 'projects/alpha', args: ['hello'] });
    const stdout = [];
    const stderr = [];
    handle.child.stdout.on('data', (chunk) => stdout.push(chunk));
    handle.child.stderr.on('data', (chunk) => stderr.push(chunk));
    const outputEnded = Promise.all([
        new Promise((resolve) => handle.child.stdout.once('end', resolve)),
        new Promise((resolve) => handle.child.stderr.once('end', resolve)),
    ]);
    rawChild.stdout.write(`before:${secret.slice(0, 17)}`);
    rawChild.stdout.end(`${secret.slice(17)}:after`);
    rawChild.stderr.end(`error:${secret}`);
    completion.resolve({ code: 0, signal: null });
    await handle.completion;
    await outputEnded;
    const visible = Buffer.concat([...stdout, ...stderr]).toString('utf8');
    assert.doesNotMatch(visible, new RegExp(secret));
    assert.equal(visible, 'before:[REDACTED]:aftererror:[REDACTED]');
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

test('provider runtime revokes capability after proven termination even when completion reports an ordinary error', async (t) => {
    const context = credentialContext();
    const registry = await startScopedSoulBrokerRegistry({ credentialContext: context });
    t.after(() => registry.close());
    const runtime = createProviderTaskRuntime({
        credentialContext: context,
        brokerRegistry: registry,
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
