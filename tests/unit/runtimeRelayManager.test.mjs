import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { compileProxyLimits } from '../../cli/server/proxy/limits.js';
import { RelayFrameDecoder, encodeRelayFrame } from '../../cli/server/runtimeRelay/protocol.js';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';
import { AGENT_SECRET, CONTAINER_ID } from './routingProxyTestFixtures.mjs';

const relay = Object.freeze({
    kind: 'container-exec-stdio',
    runtime: 'podman',
    containerId: CONTAINER_ID,
    containerName: 'ploinky-alpha',
    targetAgentId: 'alpha-agent-id',
    effectiveInstanceId: 'alpha-instance-1',
    networkMode: 'bridge',
});
function routePlan() {
    return {
        relay,
        owner: { effectiveInstanceId: relay.effectiveInstanceId },
        generationDigest: 'generation-one',
        deniedPorts: [22, 8081],
        method: 'GET',
        port: 7000,
        targetPath: '/',
        query: '',
        transport: 'http',
        limits: compileProxyLimits({ connectTimeoutMs: 100, headerTimeoutMs: 100 }),
    };
}

function fakeChild(onHello) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    const decoder = new RelayFrameDecoder();
    child.stdin.on('data', chunk => decoder.push(chunk));
    decoder.on('frame', frame => {
        if (frame.type === 'HELLO') onHello(frame, child);
    });
    return child;
}

function inspectedContainer() {
    return [{
        Id: CONTAINER_ID,
        Name: '/ploinky-alpha',
        State: { Running: true },
        HostConfig: { NetworkMode: 'bridge' },
    }];
}

function readyChild() {
    return fakeChild((hello, child) => child.stdout.write(encodeRelayFrame({
        type: 'READY',
        version: 1,
        containerId: hello.containerId,
        effectiveInstanceId: hello.effectiveInstanceId,
        generationDigest: hello.generationDigest,
        denySetDigest: hello.denySetDigest,
    })));
}

function validLease(commit = () => true) {
    return { commit };
}

test('relay checkout is authorization/lease gated and launches only exact exec/stdio relay', async () => {
    let inspectCalls = 0;
    let spawnArgs;
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: () => {
            inspectCalls += 1;
            return inspectedContainer();
        },
        spawnProcess: (...args) => {
            spawnArgs = args;
            return fakeChild((hello, child) => child.stdout.write(encodeRelayFrame({
                type: 'READY',
                version: 1,
                containerId: hello.containerId,
                effectiveInstanceId: hello.effectiveInstanceId,
                generationDigest: hello.generationDigest,
                denySetDigest: hello.denySetDigest,
            })));
        },
    });
    const plan = routePlan();
    await assert.rejects(() => manager.checkout({
        plan,
        lease: { commit: () => true },
        authorized: false,
    }), /authorization/);
    await assert.rejects(() => manager.checkout({
        plan,
        lease: { commit: () => false },
        authorized: true,
    }), /stale/);
    assert.equal(inspectCalls, 0);

    const channel = await manager.checkout({
        plan,
        lease: { commit: () => true },
        authorized: true,
    });
    assert.equal(inspectCalls, 1);
    assert.equal(spawnArgs[0], 'podman');
    assert.deepEqual(spawnArgs[1], [
        'exec', '-i', CONTAINER_ID,
        'node', '/Agent/server/RuntimeHttpRelay.mjs',
    ]);
    assert.deepEqual(spawnArgs[2], { stdio: ['pipe', 'pipe', 'pipe'] });
    const child = channel.channel.child;
    channel.close();
    assert.equal(manager.totalActive, 0);
    assert.equal(child.killed, undefined);
    manager.close();
    assert.equal(child.killed, true);
});

test('relay checkout fails closed on stale or host-network container identity', async () => {
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    for (const inspection of [
        [{ Id: 'b'.repeat(64), Name: '/ploinky-alpha', State: { Running: true }, HostConfig: { NetworkMode: 'bridge' } }],
        [{ Id: CONTAINER_ID, Name: '/ploinky-alpha', State: { Running: true }, HostConfig: { NetworkMode: 'host' } }],
    ]) {
        let spawned = false;
        const manager = new RuntimeRelayManager({
            minter,
            inspectContainer: () => inspection,
            spawnProcess: () => { spawned = true; },
        });
        await assert.rejects(() => manager.checkout({
            plan: routePlan(),
            lease: { commit: () => true },
            authorized: true,
        }), /stale container identity|network-confined/);
        assert.equal(spawned, false);
        assert.equal(manager.totalActive, 0);
    }
});

test('sequential checkouts reuse one generation-scoped relay process', async () => {
    let inspectCalls = 0;
    let spawnCalls = 0;
    const children = [];
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: () => { inspectCalls += 1; return inspectedContainer(); },
        spawnProcess: () => {
            spawnCalls += 1;
            const child = readyChild();
            children.push(child);
            return child;
        },
    });

    const first = await manager.checkout({ plan: routePlan(), lease: validLease(), authorized: true });
    first.close();
    const second = await manager.checkout({ plan: routePlan(), lease: validLease(), authorized: true });
    second.close();

    assert.equal(inspectCalls, 1);
    assert.equal(spawnCalls, 1);
    assert.equal(children[0].killed, undefined);
    assert.equal(manager.totalActive, 0);
    manager.close();
});

test('parallel first checkouts coalesce relay inspection and startup', async () => {
    let inspectCalls = 0;
    let spawnCalls = 0;
    let releaseInspection;
    const inspectionGate = new Promise(resolve => { releaseInspection = resolve; });
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: async () => {
            inspectCalls += 1;
            await inspectionGate;
            return inspectedContainer();
        },
        spawnProcess: () => { spawnCalls += 1; return readyChild(); },
    });

    const firstPromise = manager.checkout({ plan: routePlan(), lease: validLease(), authorized: true });
    const secondPromise = manager.checkout({ plan: routePlan(), lease: validLease(), authorized: true });
    releaseInspection();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(inspectCalls, 1);
    assert.equal(spawnCalls, 1);
    assert.equal(manager.totalActive, 2);
    first.close();
    second.close();
    manager.close();
});

test('pool never reuses a relay across generations or for a stale lease', async () => {
    let inspectCalls = 0;
    let spawnCalls = 0;
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: () => { inspectCalls += 1; return inspectedContainer(); },
        spawnProcess: () => { spawnCalls += 1; return readyChild(); },
    });
    const firstPlan = routePlan();
    const first = await manager.checkout({ plan: firstPlan, lease: validLease(), authorized: true });
    first.close();

    await assert.rejects(() => manager.checkout({
        plan: firstPlan,
        lease: validLease(() => false),
        authorized: true,
    }), /stale/);
    assert.equal(inspectCalls, 1);
    assert.equal(spawnCalls, 1);

    const secondPlan = { ...routePlan(), generationDigest: 'generation-two' };
    const second = await manager.checkout({ plan: secondPlan, lease: validLease(), authorized: true });
    second.close();
    assert.equal(inspectCalls, 2);
    assert.equal(spawnCalls, 2);
    assert.equal(manager.channels.size, 2);
    manager.close();
});

test('relay exit fails active streams, evicts the channel, and starts a replacement', async () => {
    let spawnCalls = 0;
    const children = [];
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: inspectedContainer,
        spawnProcess: () => {
            spawnCalls += 1;
            const child = readyChild();
            children.push(child);
            return child;
        },
    });
    const plan = routePlan();
    const first = await manager.checkout({ plan, lease: validLease(), authorized: true });
    const stream = await first.openRequest({ plan });
    const failed = new Promise(resolve => stream.once('error', resolve));
    children[0].emit('exit', 0, null);
    assert.match((await failed).message, /runtime relay exited/);
    first.close();

    const second = await manager.checkout({ plan, lease: validLease(), authorized: true });
    assert.equal(spawnCalls, 2);
    second.close();
    manager.close();
});

test('relay startup failure includes bounded stderr diagnostics', async () => {
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: inspectedContainer,
        spawnProcess: () => {
            const child = fakeChild((_hello, activeChild) => {
                activeChild.stderr.write('node: cannot find /Agent/server/RuntimeHttpRelay.mjs\n');
                activeChild.emit('exit', 1, null);
            });
            return child;
        },
    });

    await assert.rejects(
        () => manager.checkout({ plan: routePlan(), lease: validLease(), authorized: true }),
        /runtime relay exited \(1\): node: cannot find \/Agent\/server\/RuntimeHttpRelay\.mjs/,
    );
    manager.close();
});

test('capacity remains request-scoped when requests share a relay channel', async () => {
    let spawnCalls = 0;
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        limits: { concurrentStreamsPerAgent: 1, concurrentStreamsTotal: 1 },
        inspectContainer: inspectedContainer,
        spawnProcess: () => { spawnCalls += 1; return readyChild(); },
    });
    const plan = routePlan();
    plan.limits = { ...plan.limits, concurrentStreamsPerAgent: 1, concurrentStreamsTotal: 1 };
    const first = await manager.checkout({ plan, lease: validLease(), authorized: true });
    await assert.rejects(() => manager.checkout({ plan, lease: validLease(), authorized: true }), /concurrency limit/);
    first.close();
    const second = await manager.checkout({ plan, lease: validLease(), authorized: true });
    second.close();
    assert.equal(spawnCalls, 1);
    manager.close();
});

test('idle pooled channels expire and manager shutdown rejects new checkouts', async () => {
    const children = [];
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        channelIdleTimeoutMs: 10,
        inspectContainer: inspectedContainer,
        spawnProcess: () => {
            const child = readyChild();
            children.push(child);
            return child;
        },
    });
    const checkout = await manager.checkout({ plan: routePlan(), lease: validLease(), authorized: true });
    checkout.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(children[0].killed, true);
    assert.equal(manager.channels.size, 0);

    manager.close();
    await assert.rejects(() => manager.checkout({
        plan: routePlan(),
        lease: validLease(),
        authorized: true,
    }), /manager is closed/);
});
