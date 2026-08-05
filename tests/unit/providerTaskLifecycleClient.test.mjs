import assert from 'node:assert/strict';
import test from 'node:test';

import {
    __testables,
    createProviderTaskLifecycleClient,
} from '../../Agent/lib/providerTaskLifecycleClient.mjs';
import {
    __testables as credentialContextTestables,
} from '../../Agent/lib/agentCredentialContext.mjs';
import { buildBwrapAgentCredential } from '../../cli/sandbox/bwrap/bwrapAgentCredential.js';

const PRINCIPAL = 'agent:AchillesCLI/opencodeAgent';
const INSTANCE = 'opencodeAgent_alias-1';
const GENERATION = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PROCESS_IDENTITY = 'linux-proc:11111111-1111-4111-8111-111111111111:100';
const PROCESS_UID = 501;

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

function lifecycleFixture(overrides = {}) {
    const requests = [];
    const scheduled = [];
    const client = createProviderTaskLifecycleClient({
        credentialContext: credentialContext(),
        provider: 'opencode',
        mode: 'task',
        taskId: 'task-phase9',
        audience: `${PRINCIPAL}/execute-task`,
        heartbeatIntervalMs: 5000,
        inspectProcessIdentity: () => ({
            state: 'identified',
            processIdentity: PROCESS_IDENTITY,
            processUid: PROCESS_UID,
        }),
        scheduleHeartbeat(callback, intervalMs) {
            const timer = { callback, intervalMs, cleared: false };
            scheduled.push(timer);
            return timer;
        },
        clearHeartbeat(timer) { timer.cleared = true; },
        signAssertion({ path, body }) {
            assert.ok(Buffer.isBuffer(body));
            return `signed:${path}`;
        },
        async request(request) {
            requests.push({
                ...request,
                body: Buffer.from(request.body),
                headers: { ...request.headers },
            });
            if (request.path.endsWith('/publish') || request.path.endsWith('/heartbeat')) {
                return {
                    statusCode: 200,
                    body: Buffer.from(JSON.stringify({
                        ok: true,
                        owner: {
                            ownerKey: 'provider-task:runtime:task-phase9',
                            logPath: '/workspace/.ploinky/logs/tasks/task-phase9-provider.log',
                        },
                    })),
                };
            }
            return { statusCode: 200, body: Buffer.from('{"ok":true}') };
        },
        ...overrides,
    });
    return { client, requests, scheduled };
}

function publishInput() {
    return {
        runtimeKind: 'bwrap',
        runtimeKey: INSTANCE,
        homeKey: `${INSTANCE}.sandbox-v2`,
        workdir: '/workspace/projects/alpha',
        ownership: {
            pid: 4242,
            processGroupId: 4242,
            processIdentity: PROCESS_IDENTITY,
            processUid: PROCESS_UID,
        },
    };
}

test('provider lifecycle publishes one exact signed v1 owner to the bwrap private Router', async () => {
    const { client, requests, scheduled } = lifecycleFixture();
    const owner = await client.publish(publishInput());

    assert.deepEqual(owner, {
        ownerKey: 'provider-task:runtime:task-phase9',
        logPath: '/workspace/.ploinky/logs/tasks/task-phase9-provider.log',
    });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].intervalMs, 5000);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].origin, 'http://127.0.0.1:8081');
    assert.equal(requests[0].path, '/api/edge/provider-tasks/publish');
    assert.deepEqual(requests[0].headers, {
        'content-type': 'application/json',
        'ploinky-agent-assertion': 'signed:/api/edge/provider-tasks/publish',
    });
    const body = JSON.parse(requests[0].body);
    assert.deepEqual(Object.keys(body), [
        'schemaVersion', 'taskId', 'audience', 'provider', 'mode', 'runtimeKind', 'runtimeKey',
        'homeKey', 'workdir', 'pid', 'processGroupId', 'processIdentity',
        'processUid', 'brokerOwner', 'readiness', 'state',
    ]);
    assert.deepEqual(body, {
        schemaVersion: 1,
        taskId: 'task-phase9',
        audience: `${PRINCIPAL}/execute-task`,
        provider: 'opencode',
        mode: 'task',
        runtimeKind: 'bwrap',
        runtimeKey: INSTANCE,
        homeKey: `${INSTANCE}.sandbox-v2`,
        workdir: '/workspace/projects/alpha',
        pid: 4242,
        processGroupId: 4242,
        processIdentity: PROCESS_IDENTITY,
        processUid: PROCESS_UID,
        brokerOwner: __testables.computeBrokerOwner({
            principalId: PRINCIPAL,
            instanceId: INSTANCE,
            enableGeneration: GENERATION,
            taskId: 'task-phase9',
            provider: 'opencode',
            audience: `${PRINCIPAL}/execute-task`,
        }),
        readiness: 'ready',
        state: 'running',
    });
    assert.match(body.brokerOwner, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(requests[0].body.toString('utf8'), /fixture-signature|bbbbbbbbbbbbbbbb/);
});

test('provider lifecycle serializes bounded redacted stdout/stderr chunks before terminal proof', async () => {
    const { client, requests, scheduled } = lifecycleFixture();
    await client.publish(publishInput());
    const split = 'x'.repeat((16 * 1024) + 1);
    await Promise.all([
        client.log('stdout', split),
        client.log('stderr', 'safe-error'),
    ]);
    await client.terminal({ terminalState: 'completed' });

    assert.equal(scheduled[0].cleared, true);
    const logs = requests.filter((entry) => entry.path.endsWith('/log')).map((entry) => JSON.parse(entry.body));
    assert.deepEqual(logs.map((entry) => entry.sequence), [1, 2, 3]);
    assert.deepEqual(logs.map((entry) => entry.stream), ['stdout', 'stdout', 'stderr']);
    assert.ok(logs.every((entry) => Buffer.byteLength(entry.chunk, 'utf8') <= 16 * 1024));
    assert.deepEqual(Object.keys(logs[0]), [
        'schemaVersion', 'taskId', 'provider', 'runtimeKey', 'processIdentity',
        'stream', 'sequence', 'chunk',
    ]);
    const terminal = JSON.parse(requests.at(-1).body);
    assert.equal(requests.at(-1).path, '/api/edge/provider-tasks/terminal');
    assert.equal(terminal.terminalState, 'completed');
    assert.deepEqual(terminal.terminalProof, {
        processTerminal: true,
        descendantsTerminal: true,
        brokerClosed: true,
        leaseReleased: true,
    });
});

test('provider lifecycle durably reports PID identity reuse before stopping heartbeats', async () => {
    let inspection = {
        state: 'identified',
        processIdentity: PROCESS_IDENTITY,
        processUid: PROCESS_UID,
    };
    const bridgeFailures = [];
    const { client, requests, scheduled } = lifecycleFixture({
        inspectProcessIdentity: () => inspection,
        onBridgeFailure: (error) => bridgeFailures.push(error),
    });
    await client.publish(publishInput());
    inspection = {
        state: 'identified',
        processIdentity: 'linux-proc:22222222-2222-4222-8222-222222222222:999',
        processUid: PROCESS_UID,
    };

    await assert.rejects(
        client.heartbeat(),
        (error) => error?.code === 'PLOINKY_PROVIDER_LIFECYCLE_OWNERSHIP_LOST'
            && error.ownershipRetained === true,
    );
    assert.equal(scheduled[0].cleared, true);
    assert.equal(bridgeFailures.length, 1);
    assert.equal(bridgeFailures[0].ownershipRetained, true);
    assert.deepEqual(requests.map((entry) => entry.path), [
        '/api/edge/provider-tasks/publish',
        '/api/edge/provider-tasks/report',
    ]);
    const report = JSON.parse(requests.at(-1).body);
    assert.equal(report.reportState, 'pid-reused');
    assert.equal(report.processIdentity, PROCESS_IDENTITY);
    assert.equal(report.pid, 4242);
});

test('provider lifecycle accepts an exact absolute native Seatbelt log path independently of workdir', async () => {
    const { client } = lifecycleFixture({
        async request(request) {
            if (request.path.endsWith('/publish')) {
                return {
                    statusCode: 200,
                    body: Buffer.from(JSON.stringify({
                        ok: true,
                        owner: {
                            ownerKey: 'provider-task:native:phase9',
                            logPath: '/Users/agent/workspace/.ploinky/logs/tasks/phase9.log',
                        },
                    })),
                };
            }
            return { statusCode: 200, body: Buffer.from('{"ok":true}') };
        },
    });
    assert.deepEqual(await client.publish(publishInput()), {
        ownerKey: 'provider-task:native:phase9',
        logPath: '/Users/agent/workspace/.ploinky/logs/tasks/phase9.log',
    });
});

test('provider lifecycle retains ownership and permits exact terminal retry after bridge failure', async () => {
    let terminalAttempts = 0;
    const { client } = lifecycleFixture({
        async request(request) {
            if (request.path.endsWith('/publish')) {
                return {
                    statusCode: 200,
                    body: Buffer.from(JSON.stringify({
                        ok: true,
                        owner: {
                            ownerKey: 'provider-task:runtime:task-phase9',
                            logPath: '/workspace/.ploinky/logs/tasks/task-phase9-provider.log',
                        },
                    })),
                };
            }
            if (request.path.endsWith('/terminal')) {
                terminalAttempts += 1;
                if (terminalAttempts === 1) {
                    return { statusCode: 503, body: Buffer.from('{"ok":false}') };
                }
            }
            return { statusCode: 200, body: Buffer.from('{"ok":true}') };
        },
    });
    await client.publish(publishInput());
    await assert.rejects(
        client.terminal({ terminalState: 'cancelled' }),
        (error) => error?.code === 'PLOINKY_PROVIDER_LIFECYCLE_TERMINAL_FAILED'
            && error.ownershipRetained === true
            && !JSON.stringify(error).includes('bbbbbbbb'),
    );
    await client.terminal({ terminalState: 'cancelled' });
    assert.equal(terminalAttempts, 2);
});
