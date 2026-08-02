import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { createRelayReplayCache } from '../../Agent/lib/relayTokenVerify.mjs';
import {
    verifyRelayRequestToken,
    verifyRelaySessionToken,
} from '../../Agent/lib/relayRequestAuth.mjs';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import {
    RelayFrameDecoder,
    encodeRelayFrame,
} from '../../Agent/lib/runtimeRelayProtocol.mjs';

const AGENT_SECRET = crypto.randomBytes(32);
const CONTAINER_ID = 'a'.repeat(64);
let nonce = 0;
const minter = new RelayRequestMinter({
    resolveAgentSecret: async () => AGENT_SECRET,
    createNonce: () => `nonce-${++nonce}`,
});

const identity = {
    targetAgentId: 'agent:fixtures/alpha',
    effectiveInstanceId: 'alpha-instance-1',
    enableGeneration: 'alpha-enable-generation-1',
    containerId: CONTAINER_ID,
    generationDigest: 'generation-one',
};
const RELAY_HELPER_PATH = fileURLToPath(new URL('../../Agent/server/RuntimeHttpRelay.mjs', import.meta.url));

function decodeFrames(bytes) {
    const frames = [];
    const decoder = new RelayFrameDecoder();
    decoder.on('frame', frame => frames.push(frame));
    decoder.push(bytes);
    decoder.end();
    return frames;
}

function runRuntimeRelaySync(frames) {
    const result = spawnSync(process.execPath, [RELAY_HELPER_PATH], {
        env: {
            PATH: process.env.PATH || '',
            PLOINKY_AGENT_ID: identity.targetAgentId,
        },
        input: Buffer.concat(frames.map(encodeRelayFrame)),
        timeout: 5_000,
    });
    if (result.error) throw result.error;
    return { ...result, frames: decodeFrames(result.stdout) };
}

function trackChildInputFrames(child, frames) {
    const decoder = new RelayFrameDecoder();
    decoder.on('frame', frame => frames.push(frame));
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk, ...args) => {
        decoder.push(Buffer.from(chunk));
        return write(chunk, ...args);
    };
    return child;
}

test('runtime relay starts with only the tracked Agent library available', () => {
    const result = spawnSync(process.execPath, [
        RELAY_HELPER_PATH,
    ], {
        env: {
            ...process.env,
            NODE_PATH: '',
            PLOINKY_AGENT_ID: identity.targetAgentId,
            PLOINKY_AGENT_SECRET: AGENT_SECRET.toString('hex'),
        },
        input: '',
        encoding: 'utf8',
        timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
});

test('relay session token binds owner, runtime identity, generation, session, and deny set', async () => {
    const minted = await minter.mintSession({
        ...identity,
        relaySessionId: 'session-one',
        deniedPorts: [8081, 22, 22],
    });
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'session-one',
        deniedPorts: [22, 8081],
        replayCache: createRelayReplayCache(),
    };
    const verified = verifyRelaySessionToken(minted.token, expected);
    assert.deepEqual(verified.deniedPorts, [22, 8081]);
    for (const [key, value] of [
        ['effectiveInstanceId', 'other-instance'],
        ['enableGeneration', 'other-enable-generation'],
        ['containerId', 'b'.repeat(64)],
        ['generationDigest', 'other-generation'],
        ['relaySessionId', 'other-session'],
    ]) {
        assert.throws(() => verifyRelaySessionToken(minted.token, {
            ...expected,
            [key]: value,
            replayCache: createRelayReplayCache(),
        }), /mismatch/);
    }
    assert.throws(() => verifyRelaySessionToken(minted.token, {
        ...expected,
        deniedPorts: [22],
        replayCache: createRelayReplayCache(),
    }), /deny set mismatch/);
});

test('relay tokens accept a channel-scoped signing key without resolving the reusable agent secret', async () => {
    const signingSecret = crypto.randomBytes(32);
    const isolatedMinter = new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('channel-scoped relay signing must not resolve the agent secret'),
        createNonce: () => `isolated-${++nonce}`,
    });
    const session = await isolatedMinter.mintSession({
        ...identity,
        relaySessionId: 'isolated-session',
        deniedPorts: [22],
    }, { signingSecret });
    verifyRelaySessionToken(session.token, {
        secret: signingSecret,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'isolated-session',
        deniedPorts: [22],
        replayCache: createRelayReplayCache(),
    });
    assert.throws(() => verifyRelaySessionToken(session.token, {
        secret: crypto.randomBytes(32),
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'isolated-session',
        deniedPorts: [22],
        replayCache: createRelayReplayCache(),
    }), /signature invalid/);

    const request = await isolatedMinter.mintRequest({
        ...identity,
        relaySessionId: 'isolated-session',
        denySetDigest: session.payload.denySetDigest,
        method: 'GET',
        port: 7880,
        path: '/',
        query: '',
        bodyMode: 'none',
        bodyHash: '',
    }, { signingSecret });
    verifyRelayRequestToken(request.token, {
        secret: signingSecret,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'isolated-session',
        denySetDigest: session.payload.denySetDigest,
        method: 'GET',
        port: 7880,
        path: '/',
        query: '',
        bodyMode: 'none',
        bodyHash: '',
        replayCache: createRelayReplayCache(),
    });
});

test('runtime relay verifies HELLO with only its principal and the channel-scoped key', async (t) => {
    const signingSecret = crypto.randomBytes(32);
    const isolatedMinter = new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('runtime relay bootstrap must not resolve the agent secret'),
        createNonce: () => `bootstrap-${++nonce}`,
    });
    const session = await isolatedMinter.mintSession({
        ...identity,
        relaySessionId: 'bootstrap-session',
        deniedPorts: [22],
    }, { signingSecret });
    const child = spawn(process.execPath, [
        fileURLToPath(new URL('../../Agent/server/RuntimeHttpRelay.mjs', import.meta.url)),
    ], {
        env: {
            PATH: process.env.PATH || '',
            PLOINKY_AGENT_ID: identity.targetAgentId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    t.after(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
    });

    const decoder = new RelayFrameDecoder();
    child.stdout.on('data', (chunk) => decoder.push(chunk));
    const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runtime relay READY timeout')), 5_000);
        const cleanup = () => clearTimeout(timer);
        decoder.once('frame', (frame) => {
            cleanup();
            if (frame.type === 'READY') resolve(frame);
            else reject(new Error(`unexpected runtime relay frame ${frame.type}`));
        });
        child.once('error', (error) => {
            cleanup();
            reject(error);
        });
        child.once('exit', (code) => {
            if (code === 0) return;
            cleanup();
            reject(new Error(`runtime relay exited ${code}`));
        });
    });
    child.stdin.write(encodeRelayFrame({
        type: 'HELLO',
        ...identity,
        relaySessionId: session.payload.relaySessionId,
        deniedPorts: session.payload.deniedPorts,
        denySetDigest: session.payload.denySetDigest,
        verificationKey: signingSecret.toString('hex'),
        token: session.token,
    }));
    const frame = await ready;
    assert.equal(frame.targetAgentId, identity.targetAgentId);
    assert.equal(frame.relaySessionId, 'bootstrap-session');
    assert.equal(Object.hasOwn(frame, 'verificationKey'), false);
    child.stdin.end();
});

test('runtime relay rejects missing, malformed, wrong, and duplicate channel keys', async () => {
    const signingSecret = crypto.randomBytes(32);
    const isolatedMinter = new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('runtime relay bootstrap must not resolve the agent secret'),
        createNonce: () => `key-rejection-${++nonce}`,
    });
    const session = await isolatedMinter.mintSession({
        ...identity,
        relaySessionId: 'key-rejection-session',
        deniedPorts: [22],
    }, { signingSecret });
    const hello = {
        type: 'HELLO',
        ...identity,
        relaySessionId: session.payload.relaySessionId,
        deniedPorts: session.payload.deniedPorts,
        denySetDigest: session.payload.denySetDigest,
        verificationKey: signingSecret.toString('hex'),
        token: session.token,
    };

    for (const invalidKey of [undefined, 'not-a-32-byte-hex-key', crypto.randomBytes(32).toString('hex')]) {
        const frame = { ...hello };
        if (invalidKey === undefined) delete frame.verificationKey;
        else frame.verificationKey = invalidKey;
        const result = runRuntimeRelaySync([frame]);
        assert.equal(result.status, 1);
        assert.equal(result.frames.at(-1)?.type, 'ERROR');
        assert.equal(result.frames.at(-1)?.code, 'RELAY_REJECTED');
    }

    const duplicate = runRuntimeRelaySync([hello, hello]);
    assert.equal(duplicate.status, 1);
    assert.deepEqual(duplicate.frames.map(frame => frame.type), ['READY', 'ERROR']);
    assert.match(duplicate.frames[1].message, /duplicate HELLO/);
});

test('runtime relay manager rechecks a principal-only host-mode lease immediately before OPEN', async (t) => {
    const isolatedMinter = new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('host-mode relay must not resolve the reusable agent secret'),
        createNonce: () => `manager-bootstrap-${++nonce}`,
    });
    const containerName = 'alpha-container';
    let generationCurrent = true;
    let commitCalls = 0;
    const routerFrames = [];
    const manager = new RuntimeRelayManager({
        minter: isolatedMinter,
        inspectContainer: async () => {
            generationCurrent = false;
            return {
                Id: CONTAINER_ID,
                Name: `/${containerName}`,
                State: { Running: true },
                HostConfig: { NetworkMode: 'host' },
                Config: {
                    Labels: {
                        [NETWORK_LABELS.managed]: '1',
                        [NETWORK_LABELS.resource]: 'agent',
                        [NETWORK_LABELS.instanceId]: identity.effectiveInstanceId,
                        [NETWORK_LABELS.enableGeneration]: identity.enableGeneration,
                    },
                },
            };
        },
        spawnProcess: (runtime, args, options) => {
            assert.equal(runtime, 'podman');
            assert.deepEqual(args, [
                'exec', '-i', CONTAINER_ID,
                'node', '/Agent/server/RuntimeHttpRelay.mjs',
            ]);
            return trackChildInputFrames(spawn(process.execPath, [RELAY_HELPER_PATH], {
                env: {
                    PATH: process.env.PATH || '',
                    PLOINKY_AGENT_ID: identity.targetAgentId,
                },
                stdio: options.stdio,
            }), routerFrames);
        },
        channelIdleTimeoutMs: 5_000,
    });
    t.after(() => manager.close());
    const plan = {
        owner: {
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
        },
        relay: {
            kind: 'container-exec-stdio',
            runtime: 'podman',
            containerId: CONTAINER_ID,
            containerName,
            targetAgentId: identity.targetAgentId,
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
            networkMode: 'host',
        },
        generationDigest: identity.generationDigest,
        deniedPorts: [22],
        method: 'GET',
        port: 7880,
        targetPath: '/',
        query: '',
        transport: 'http',
        limits: {
            connectTimeoutMs: 5_000,
            concurrentStreamsPerAgent: 4,
            concurrentStreamsTotal: 8,
        },
    };
    const checkout = await manager.checkout({
        authorized: true,
        lease: {
            commit: () => {
                commitCalls += 1;
                return generationCurrent;
            },
        },
        plan,
    });
    assert.equal(checkout.channel.session.payload.aud, identity.targetAgentId);
    await assert.rejects(
        checkout.openRequest({ plan }),
        error => error?.code === 'EDGE_GENERATION_CHANGED',
    );
    assert.equal(commitCalls, 2);
    assert.deepEqual(routerFrames.map(frame => frame.type), ['HELLO']);
    assert.equal(checkout.channel.streams.size, 0);
    checkout.close();
});

test('a reused relay channel rechecks the new checkout lease before a second target dial', async (t) => {
    let targetConnections = 0;
    const target = net.createServer(socket => {
        targetConnections += 1;
        socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => {
        target.once('error', reject);
        target.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => target.close());
    const targetPort = target.address().port;
    const containerName = 'alpha-pooled-container';
    const routerFrames = [];
    const isolatedMinter = new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('pooled host-mode relay must not resolve the reusable agent secret'),
        createNonce: () => `pooled-${++nonce}`,
    });
    const manager = new RuntimeRelayManager({
        minter: isolatedMinter,
        inspectContainer: async () => ({
            Id: CONTAINER_ID,
            Name: `/${containerName}`,
            State: { Running: true },
            HostConfig: { NetworkMode: 'host' },
            Config: {
                Labels: {
                    [NETWORK_LABELS.managed]: '1',
                    [NETWORK_LABELS.resource]: 'agent',
                    [NETWORK_LABELS.instanceId]: identity.effectiveInstanceId,
                    [NETWORK_LABELS.enableGeneration]: identity.enableGeneration,
                },
            },
        }),
        spawnProcess: (_runtime, _args, options) => trackChildInputFrames(
            spawn(process.execPath, [RELAY_HELPER_PATH], {
                env: {
                    PATH: process.env.PATH || '',
                    PLOINKY_AGENT_ID: identity.targetAgentId,
                },
                stdio: options.stdio,
            }),
            routerFrames,
        ),
        channelIdleTimeoutMs: 5_000,
    });
    t.after(() => manager.close());
    const plan = {
        owner: {
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
        },
        relay: {
            kind: 'container-exec-stdio',
            runtime: 'podman',
            containerId: CONTAINER_ID,
            containerName,
            targetAgentId: identity.targetAgentId,
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
            networkMode: 'host',
        },
        generationDigest: identity.generationDigest,
        deniedPorts: [22],
        method: 'GET',
        port: targetPort,
        targetPath: '/',
        query: '',
        transport: 'http',
        limits: {
            connectTimeoutMs: 5_000,
            headerTimeoutMs: 5_000,
            idleTimeoutMs: 5_000,
            webSocketHandshakeTimeoutMs: 5_000,
            streamedBodyBytes: 64 * 1024,
            bufferedBodyBytes: 64 * 1024,
            requestHeaderBytes: 8 * 1024,
            responseHeaderBytes: 8 * 1024,
            concurrentStreamsPerAgent: 4,
            concurrentStreamsTotal: 8,
        },
    };
    const firstCheckout = await manager.checkout({
        authorized: true,
        lease: { commit: () => true },
        plan,
    });
    const pooledChannel = firstCheckout.channel;
    const firstStream = await firstCheckout.openRequest({ plan });
    await new Promise((resolve, reject) => {
        firstStream.once('ready', resolve);
        firstStream.once('error', reject);
    });
    assert.equal(targetConnections, 1);
    firstStream.cancel();
    await new Promise((resolve, reject) => {
        firstStream.once('end', resolve);
        firstStream.once('error', reject);
    });
    firstCheckout.close();

    let secondGenerationCurrent = true;
    const secondCheckout = await manager.checkout({
        authorized: true,
        lease: { commit: () => secondGenerationCurrent },
        plan,
    });
    assert.equal(secondCheckout.channel, pooledChannel);
    secondGenerationCurrent = false;
    await assert.rejects(
        secondCheckout.openRequest({ plan }),
        error => error?.code === 'EDGE_GENERATION_CHANGED',
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(targetConnections, 1);
    assert.deepEqual(routerFrames.map(frame => frame.type), ['HELLO', 'OPEN', 'CANCEL']);
    secondCheckout.close();
});

test('runtime relay preserves the HTTP response-header budget before applying body idle timeout', async (t) => {
    let responseSent = false;
    const target = net.createServer(socket => {
        socket.on('error', () => {});
        socket.once('data', () => {
            setTimeout(() => {
                responseSent = true;
                socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
            }, 60);
        });
    });
    await new Promise((resolve, reject) => {
        target.once('error', reject);
        target.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => target.close());

    const containerName = 'alpha-header-budget-container';
    const isolatedMinter = new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('header-budget relay must use its channel key'),
        createNonce: () => `header-budget-${++nonce}`,
    });
    const manager = new RuntimeRelayManager({
        minter: isolatedMinter,
        inspectContainer: async () => ({
            Id: CONTAINER_ID,
            Name: `/${containerName}`,
            State: { Running: true },
            HostConfig: { NetworkMode: 'host' },
            Config: {
                Labels: {
                    [NETWORK_LABELS.managed]: '1',
                    [NETWORK_LABELS.resource]: 'agent',
                    [NETWORK_LABELS.instanceId]: identity.effectiveInstanceId,
                    [NETWORK_LABELS.enableGeneration]: identity.enableGeneration,
                },
            },
        }),
        spawnProcess: (_runtime, _args, options) => spawn(process.execPath, [RELAY_HELPER_PATH], {
            env: {
                PATH: process.env.PATH || '',
                PLOINKY_AGENT_ID: identity.targetAgentId,
            },
            stdio: options.stdio,
        }),
        channelIdleTimeoutMs: 5_000,
    });
    t.after(() => manager.close());
    const plan = {
        owner: {
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
        },
        relay: {
            kind: 'container-exec-stdio',
            runtime: 'podman',
            containerId: CONTAINER_ID,
            containerName,
            targetAgentId: identity.targetAgentId,
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
            networkMode: 'host',
        },
        generationDigest: identity.generationDigest,
        deniedPorts: [22],
        method: 'GET',
        port: target.address().port,
        targetPath: '/',
        query: '',
        transport: 'http',
        limits: {
            connectTimeoutMs: 200,
            headerTimeoutMs: 200,
            idleTimeoutMs: 20,
            webSocketHandshakeTimeoutMs: 30,
            streamedBodyBytes: 64 * 1024,
            bufferedBodyBytes: 64 * 1024,
            requestHeaderBytes: 8 * 1024,
            responseHeaderBytes: 8 * 1024,
            concurrentStreamsPerAgent: 4,
            concurrentStreamsTotal: 8,
        },
    };
    const checkout = await manager.checkout({
        authorized: true,
        lease: { commit: () => true },
        plan,
    });
    const startedAt = Date.now();
    const stream = await checkout.openRequest({ plan });
    await new Promise((resolve, reject) => {
        stream.once('ready', () => stream.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
        stream.once('end', resolve);
        stream.once('error', reject);
    });
    assert.equal(responseSent, true);
    assert.ok(Date.now() - startedAt >= 50);
    checkout.close();
});

test('runtime relay applies the body idle timeout after the first HTTP response bytes', async (t) => {
    const target = net.createServer(socket => {
        socket.on('error', () => {});
        socket.once('data', () => {
            socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n');
        });
    });
    await new Promise((resolve, reject) => {
        target.once('error', reject);
        target.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => target.close());

    const containerName = 'alpha-idle-budget-container';
    const isolatedMinter = new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('idle-budget relay must use its channel key'),
        createNonce: () => `idle-budget-${++nonce}`,
    });
    const manager = new RuntimeRelayManager({
        minter: isolatedMinter,
        inspectContainer: async () => ({
            Id: CONTAINER_ID,
            Name: `/${containerName}`,
            State: { Running: true },
            HostConfig: { NetworkMode: 'host' },
            Config: {
                Labels: {
                    [NETWORK_LABELS.managed]: '1',
                    [NETWORK_LABELS.resource]: 'agent',
                    [NETWORK_LABELS.instanceId]: identity.effectiveInstanceId,
                    [NETWORK_LABELS.enableGeneration]: identity.enableGeneration,
                },
            },
        }),
        spawnProcess: (_runtime, _args, options) => spawn(process.execPath, [RELAY_HELPER_PATH], {
            env: {
                PATH: process.env.PATH || '',
                PLOINKY_AGENT_ID: identity.targetAgentId,
            },
            stdio: options.stdio,
        }),
        channelIdleTimeoutMs: 5_000,
    });
    t.after(() => manager.close());
    const plan = {
        owner: {
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
        },
        relay: {
            kind: 'container-exec-stdio',
            runtime: 'podman',
            containerId: CONTAINER_ID,
            containerName,
            targetAgentId: identity.targetAgentId,
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
            networkMode: 'host',
        },
        generationDigest: identity.generationDigest,
        deniedPorts: [22],
        method: 'GET',
        port: target.address().port,
        targetPath: '/',
        query: '',
        transport: 'http',
        limits: {
            connectTimeoutMs: 200,
            headerTimeoutMs: 200,
            idleTimeoutMs: 25,
            webSocketHandshakeTimeoutMs: 30,
            streamedBodyBytes: 64 * 1024,
            bufferedBodyBytes: 64 * 1024,
            requestHeaderBytes: 8 * 1024,
            responseHeaderBytes: 8 * 1024,
            concurrentStreamsPerAgent: 4,
            concurrentStreamsTotal: 8,
        },
    };
    const checkout = await manager.checkout({
        authorized: true,
        lease: { commit: () => true },
        plan,
    });
    const stream = await checkout.openRequest({ plan });
    const startedAt = Date.now();
    const failure = await new Promise((resolve, reject) => {
        stream.once('ready', () => stream.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'));
        stream.once('error', resolve);
        stream.once('end', () => reject(new Error('expected response-body idle failure')));
    });
    assert.equal(failure.code, 'TARGET_FAILURE');
    assert.match(failure.message, /target idle timeout/);
    assert.ok(Date.now() - startedAt >= 20);
    checkout.close();
});

test('relay request token binds every HTTP target and body selector without a protocol version', async () => {
    const session = await minter.mintSession({
        ...identity,
        relaySessionId: 'session-two',
        deniedPorts: [22],
    });
    const requestInput = {
        ...identity,
        relaySessionId: 'session-two',
        denySetDigest: session.payload.denySetDigest,
        method: 'POST',
        port: 7000,
        path: '/api/items',
        query: 'page=1',
        bodyMode: 'buffered',
        bodyHash: 'body-digest',
    };
    const minted = await minter.mintRequest(requestInput);
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...requestInput,
    };
    assert.equal(Object.hasOwn(minted.payload, 'schemaVersion'), false);
    verifyRelayRequestToken(minted.token, {
        ...expected,
        replayCache: createRelayReplayCache(),
    });
    const mismatches = {
        effectiveInstanceId: 'other-instance',
        enableGeneration: 'other-enable-generation',
        containerId: 'b'.repeat(64),
        generationDigest: 'other-generation',
        relaySessionId: 'other-session',
        denySetDigest: 'other-deny-set',
        method: 'GET',
        port: '7001',
        path: '/other',
        query: 'page=2',
        bodyMode: 'stream',
        bodyHash: 'other-body',
    };
    for (const [key, value] of Object.entries(mismatches)) {
        assert.throws(() => verifyRelayRequestToken(minted.token, {
            ...expected,
            [key]: value,
            replayCache: createRelayReplayCache(),
        }), /mismatch/);
    }
});

test('relay tokens expire and reject replay', async () => {
    const minted = await minter.mintSession({
        ...identity,
        relaySessionId: 'session-replay',
        deniedPorts: [],
    });
    const replayCache = createRelayReplayCache();
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'session-replay',
        deniedPorts: [],
        replayCache,
    };
    verifyRelaySessionToken(minted.token, expected);
    assert.throws(() => verifyRelaySessionToken(minted.token, expected), /consumed|replay/i);

    const oldMinter = new RelayRequestMinter({
        resolveAgentSecret: async () => AGENT_SECRET,
        now: () => new Date('2000-01-01T00:00:00Z'),
        createNonce: () => `old-${++nonce}`,
    });
    const expired = await oldMinter.mintSession({
        ...identity,
        relaySessionId: 'expired',
        deniedPorts: [],
    });
    assert.throws(() => verifyRelaySessionToken(expired.token, {
        ...expected,
        relaySessionId: 'expired',
        replayCache: createRelayReplayCache(),
    }), /expired/i);
});

test('relay replay cache fails closed at capacity without evicting live JTIs', async () => {
    const relaySessionIds = ['capacity-one', 'capacity-two', 'capacity-three'];
    const minted = await Promise.all(relaySessionIds.map(relaySessionId => minter.mintSession({
        ...identity,
        relaySessionId,
        deniedPorts: [],
    })));
    const replayCache = createRelayReplayCache({ maxSize: 2 });
    const verifyAt = (index) => verifyRelaySessionToken(minted[index].token, {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: relaySessionIds[index],
        deniedPorts: [],
        replayCache,
    });
    verifyAt(0);
    verifyAt(1);
    assert.throws(() => verifyAt(2), /capacity exhausted/);
    assert.throws(() => verifyAt(0), /already been consumed/);
});

test('relay replay cache retains JTIs throughout the accepted clock-skew window', async () => {
    let fakeNow = Date.now();
    const skewMinter = new RelayRequestMinter({
        resolveAgentSecret: async () => AGENT_SECRET,
        now: () => new Date(fakeNow),
        createNonce: () => `skew-${++nonce}`,
        ttlSeconds: 5,
    });
    const minted = await skewMinter.mintSession({
        ...identity,
        relaySessionId: 'skew-window',
        deniedPorts: [],
    });
    const replayCache = createRelayReplayCache({ now: () => fakeNow });
    const expected = {
        secret: AGENT_SECRET,
        expectedAudience: identity.targetAgentId,
        ...identity,
        relaySessionId: 'skew-window',
        deniedPorts: [],
        replayCache,
        clockSkewSeconds: 30,
    };
    verifyRelaySessionToken(minted.token, { ...expected, now: fakeNow });
    fakeNow += 6_000;
    assert.throws(
        () => verifyRelaySessionToken(minted.token, { ...expected, now: fakeNow }),
        /already been consumed/,
    );
});
