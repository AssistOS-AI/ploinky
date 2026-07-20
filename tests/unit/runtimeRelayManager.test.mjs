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

test('relay checkout is authorization/lease gated and launches only exact exec/stdio relay', async () => {
    let inspectCalls = 0;
    let spawnArgs;
    const minter = new RelayRequestMinter({ resolveAgentSecret: async () => AGENT_SECRET });
    const manager = new RuntimeRelayManager({
        minter,
        inspectContainer: () => {
            inspectCalls += 1;
            return [{
                Id: CONTAINER_ID,
                Name: '/ploinky-alpha',
                State: { Running: true },
                HostConfig: { NetworkMode: 'bridge' },
            }];
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
    channel.close();
    assert.equal(manager.totalActive, 0);
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
