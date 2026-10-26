import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { RelayFrameDecoder, encodeRelayFrame } from '../../Agent/lib/runtimeRelayProtocol.mjs';
import { NETWORK_LABELS } from '../../cli/sandbox/networkLifecycle.js';
import { executeHttpPlan } from '../../cli/server/proxy/executeHttpPlan.js';
import { compileProxyLimits } from '../../cli/server/proxy/limits.js';
import { createRoutePlan } from '../../cli/server/proxy/RoutePlan.js';
import { RelayRequestMinter } from '../../cli/server/runtimeRelay/relayRequestMinter.js';
import { RuntimeRelayManager } from '../../cli/server/runtimeRelay/RuntimeRelayManager.js';

// The Router slices request DATA into raw chunks of at most this size, so a
// base64 DATA frame stays far below the 8 MiB relay frame cap.
const SLICE_BYTES = 256 * 1024;
const MIB = 1024 * 1024;
const CONTAINER_ID = 'c'.repeat(64);
const CONTAINER_NAME = 'alpha-chunking-container';
const RELAY_HELPER_PATH = fileURLToPath(new URL('../../Agent/server/RuntimeHttpRelay.mjs', import.meta.url));
const identity = {
    targetAgentId: 'agent:fixtures/alpha',
    effectiveInstanceId: 'alpha-instance-1',
    enableGeneration: 'alpha-enable-generation-1',
    generationDigest: 'generation-one',
};
let nonce = 0;

function createMinter() {
    return new RelayRequestMinter({
        resolveAgentSecret: () => assert.fail('relay requests must use the channel key'),
        createNonce: () => `chunking-${++nonce}`,
    });
}

async function inspectContainer() {
    return {
        Id: CONTAINER_ID,
        Name: `/${CONTAINER_NAME}`,
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
}

const relayDescriptor = {
    kind: 'container-control-socket',
    runtime: 'podman',
    containerId: CONTAINER_ID,
    containerName: CONTAINER_NAME,
    targetAgentId: identity.targetAgentId,
    effectiveInstanceId: identity.effectiveInstanceId,
    enableGeneration: identity.enableGeneration,
    networkMode: 'host',
};

function channelPlan(port = 7001) {
    return {
        owner: {
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
        },
        relay: relayDescriptor,
        generationDigest: identity.generationDigest,
        deniedPorts: [22],
        method: 'POST',
        port,
        targetPath: '/upload',
        query: '',
        transport: 'http',
        limits: compileProxyLimits(),
    };
}

// A relay transport whose stdin applies real Writable backpressure and can
// hold its write callbacks, so tests choose when the channel drains.
class FakeRelayChild extends EventEmitter {
    constructor() {
        super();
        this.frames = [];
        this.heldCallbacks = [];
        this.holding = false;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        const decoder = new RelayFrameDecoder();
        decoder.on('frame', frame => {
            this.frames.push(frame);
            if (frame.type === 'HELLO') {
                setImmediate(() => this.reply({
                    type: 'READY',
                    containerId: frame.containerId,
                    effectiveInstanceId: frame.effectiveInstanceId,
                    enableGeneration: frame.enableGeneration,
                    generationDigest: frame.generationDigest,
                    denySetDigest: frame.denySetDigest,
                }));
            }
        });
        this.stdin = new Writable({
            highWaterMark: 1024,
            write: (chunk, _encoding, callback) => {
                decoder.push(chunk);
                if (this.holding) this.heldCallbacks.push(callback);
                else callback();
            },
        });
    }

    hold() { this.holding = true; }

    release() {
        this.holding = false;
        for (const callback of this.heldCallbacks.splice(0)) callback();
    }

    reply(frame) { this.stdout.write(encodeRelayFrame(frame)); }

    kill() {}

    framesFor(requestId) {
        return this.frames.filter(frame => frame.requestId === requestId);
    }
}

async function openFakeStreams(t, count) {
    const child = new FakeRelayChild();
    const manager = new RuntimeRelayManager({
        minter: createMinter(),
        inspectContainer,
        resolveSocket: () => ({ path: '/test/runtime-relay.sock' }),
        openTransport: async () => child,
        channelIdleTimeoutMs: 5_000,
    });
    t.after(() => manager.close());
    const plan = channelPlan();
    const streams = [];
    for (let index = 0; index < count; index += 1) {
        const checkout = await manager.checkout({ authorized: true, lease: { commit: () => true }, plan });
        t.after(() => checkout.close());
        const stream = await checkout.openRequest({ plan, bodyMode: 'buffered', bodyHash: 'h' });
        stream.on('error', () => {});
        streams.push(stream);
    }
    return { child, streams };
}

function turns(count = 20) {
    let chain = Promise.resolve();
    for (let index = 0; index < count; index += 1) {
        chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
    }
    return chain;
}

function patternedBody(length) {
    const body = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) body[index] = (index * 31 + 7) & 0xff;
    return body;
}

test('request DATA is sliced, written under stdin backpressure, and half-closed after the last slice', async (t) => {
    const { child, streams: [large, small] } = await openFakeStreams(t, 2);
    const body = patternedBody(4 * SLICE_BYTES + 5);
    child.hold();

    assert.equal(large.write(body), false);
    let largeDrained = false;
    large.once('drain', () => { largeDrained = true; });
    small.write(Buffer.from('small'));
    small.end();
    large.end();
    await turns();
    // Only the first slice reached stdin before it reported backpressure.
    assert.equal(child.framesFor(large.requestId).filter(frame => frame.type === 'DATA').length, 1);
    assert.equal(largeDrained, false);

    child.release();
    await turns(40);

    const largeFrames = child.framesFor(large.requestId);
    const dataFrames = largeFrames.filter(frame => frame.type === 'DATA');
    assert.deepEqual(dataFrames.map(frame => frame.data.length), [
        SLICE_BYTES, SLICE_BYTES, SLICE_BYTES, SLICE_BYTES, 5,
    ]);
    assert.ok(Buffer.concat(dataFrames.map(frame => frame.data)).equals(body));
    assert.deepEqual(largeFrames.map(frame => frame.type), ['OPEN', 'DATA', 'DATA', 'DATA', 'DATA', 'DATA', 'HALF_CLOSE']);
    assert.equal(largeDrained, true);

    // The pooled channel interleaves the other stream instead of queueing it
    // behind the whole large body.
    const order = child.frames.filter(frame => frame.type === 'DATA');
    const smallIndex = order.findIndex(frame => frame.requestId === small.requestId);
    const secondLargeIndex = order.findIndex((frame, index) => frame.requestId === large.requestId
        && order.slice(0, index).some(prior => prior.requestId === large.requestId));
    assert.ok(smallIndex >= 0 && smallIndex < secondLargeIndex);
    assert.deepEqual(child.framesFor(small.requestId).map(frame => frame.type), ['OPEN', 'DATA', 'HALF_CLOSE']);
});

test('CANCEL, abandon, a helper END, and channel failure drop queued slices so no DATA follows them', async (t) => {
    const { child, streams: [cancelled, abandoned, ended, failed] } = await openFakeStreams(t, 4);
    const body = patternedBody(4 * SLICE_BYTES);
    const uncaught = [];
    const onUncaught = error => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    t.after(() => process.off('uncaughtException', onUncaught));
    child.hold();

    assert.equal(cancelled.write(body), false);
    cancelled.cancel();
    assert.equal(abandoned.write(body), false);
    abandoned.abandon();
    assert.equal(ended.write(body), false);
    child.reply({ type: 'END', requestId: ended.requestId });
    await turns();
    ended.end();
    child.release();
    await turns(40);

    // Each stream sent exactly its first slice; the other slices were dropped.
    for (const stream of [cancelled, abandoned, ended]) {
        assert.deepEqual(child.framesFor(stream.requestId).filter(frame => frame.type === 'DATA')
            .map(frame => frame.data.length), [SLICE_BYTES]);
    }
    assert.deepEqual(child.framesFor(cancelled.requestId).map(frame => frame.type), ['OPEN', 'DATA', 'CANCEL']);
    assert.deepEqual(child.framesFor(abandoned.requestId).map(frame => frame.type), ['OPEN', 'DATA', 'CANCEL']);
    assert.deepEqual(child.framesFor(ended.requestId).map(frame => frame.type), ['OPEN', 'DATA']);

    const failure = new Promise(resolve => failed.once('error', resolve));
    child.hold();
    assert.equal(failed.write(body), false);
    child.emit('exit', 1, null);
    assert.match((await failure).message, /runtime relay exited/);
    child.release();
    await turns(40);
    assert.deepEqual(child.framesFor(failed.requestId).map(frame => frame.type), ['OPEN', 'DATA']);
    assert.equal(child.framesFor(failed.requestId)[1].data.length, SLICE_BYTES);
    assert.deepEqual(uncaught, []);
});

class Response extends Writable {
    constructor() {
        super();
        this.statusCode = 0;
        this.headers = {};
        this.body = Buffer.alloc(0);
        this.headersSent = false;
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
    }

    _write(chunk, _encoding, callback) {
        this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
        callback();
    }
}

async function startHashTarget(t) {
    const received = [];
    const server = http.createServer((req, res) => {
        const hash = crypto.createHash('sha256');
        let length = 0;
        req.on('data', chunk => {
            hash.update(chunk);
            length += chunk.length;
        });
        req.on('end', () => {
            const sha256 = hash.digest('hex');
            received.push({ length, sha256, contentLength: Number(req.headers['content-length']) });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ length, sha256 }));
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    return { port: server.address().port, received };
}

function createSpawningManager(t) {
    const spawned = [];
    const manager = new RuntimeRelayManager({
        minter: createMinter(),
        inspectContainer,
        resolveSocket: () => ({ path: '/test/runtime-relay.sock' }),
        openTransport: async () => {
            const child = spawn(process.execPath, [RELAY_HELPER_PATH, 'stdio'], {
                env: {
                    PATH: process.env.PATH || '',
                    PLOINKY_AGENT_ID: identity.targetAgentId,
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            spawned.push(child);
            return child;
        },
        channelIdleTimeoutMs: 5_000,
    });
    t.after(() => manager.close());
    return { manager, spawned };
}

function agentPortPlan(port) {
    return createRoutePlan({
        matched: true,
        ok: true,
        listenerClass: 'public',
        authority: '127.0.0.1:8080',
        surfaceKind: 'agent-port-convention',
        owner: {
            effectiveInstanceId: identity.effectiveInstanceId,
            enableGeneration: identity.enableGeneration,
        },
        routeKey: 'alpha',
        port,
        policyPath: `/base-agent-additional-server/alpha/${port}/upload`,
        convention: 'base-agent-additional-server',
        unmatchedSuffix: '/upload',
        query: '',
        relay: relayDescriptor,
        deniedPorts: [22],
        access: { access: 'authenticated' },
        scheme: 'http',
        origin: 'http://127.0.0.1:8080',
        forwardedPrefix: `/base-agent-additional-server/alpha/${port}`,
        limits: compileProxyLimits(),
        generationDigest: identity.generationDigest,
        auditId: 'audit-chunking',
        method: 'POST',
        transport: 'http',
        allowRequestStreaming: false,
        credentialPolicy: {
            allowApplicationAuthorization: true,
            allowApplicationCookies: true,
        },
        responsePolicy: {
            allowApplicationCookies: true,
            allowRedirects: true,
            allowCaching: true,
        },
    });
}

async function relayBufferedBody(t, length) {
    const target = await startHashTarget(t);
    const { manager, spawned } = createSpawningManager(t);
    const body = patternedBody(length);
    const request = Readable.from([body]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080', 'content-type': 'application/octet-stream' };
    const response = new Response();
    let released = false;
    const handled = await executeHttpPlan({
        req: request,
        res: response,
        plan: agentPortPlan(target.port),
        lease: { commit: () => true, release() { released = true; } },
        relayManager: manager,
        authorized: true,
    });
    return {
        handled,
        response,
        released,
        target,
        spawned,
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
    };
}

for (const length of [7 * MIB, 8 * MIB]) {
    test(`a ${length}-byte buffered agent-port body relays intact through the relay helper`, async (t) => {
        const outcome = await relayBufferedBody(t, length);

        assert.equal(outcome.handled, true);
        assert.equal(outcome.response.statusCode, 200);
        assert.deepEqual(JSON.parse(outcome.response.body.toString('utf8')), { length, sha256: outcome.sha256 });
        assert.deepEqual(outcome.target.received, [{ length, sha256: outcome.sha256, contentLength: length }]);
        assert.equal(outcome.spawned.length, 1);
        assert.equal(outcome.released, true);
    });
}

test('a buffered agent-port body one byte over the 8 MiB limit returns 413 before any relay channel', async (t) => {
    const outcome = await relayBufferedBody(t, 8 * MIB + 1);

    assert.equal(outcome.handled, false);
    assert.equal(outcome.response.statusCode, 413);
    assert.deepEqual(JSON.parse(outcome.response.body.toString('utf8')), { error: 'request_too_large' });
    assert.deepEqual(outcome.target.received, []);
    assert.equal(outcome.spawned.length, 0);
    assert.equal(outcome.released, true);
});

test('an oversized relay frame fails with an explicit code', () => {
    assert.throws(
        () => encodeRelayFrame({ type: 'DATA', requestId: 'r', data: Buffer.alloc(7 * MIB) }),
        error => error.code === 'RELAY_FRAME_TOO_LARGE' && /invalid frame length/.test(error.message),
    );
});
