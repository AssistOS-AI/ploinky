import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { resolveConvention } from '../../cli/server/agentPortConvention/resolveConvention.js';
import { evaluateGenerationAccess } from '../../cli/server/generation/evaluateGenerationAccess.js';
import { executeHttpPlan, proxyErrorStatus } from '../../cli/server/proxy/executeHttpPlan.js';
import { WebSocketFrameLimitTransform } from '../../cli/server/proxy/executeWebSocketPlan.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

class RelayStream extends EventEmitter {
    constructor(response = null) {
        super();
        this.channel = { child: { stdin: new EventEmitter() } };
        this.response = response;
        this.request = Buffer.alloc(0);
        this.responded = false;
    }

    write(chunk) {
        this.request = Buffer.concat([this.request, Buffer.from(chunk)]);
        if (this.response && !this.responded && this.request.includes(Buffer.from('\r\n\r\n'))) {
            this.responded = true;
            setImmediate(() => {
                this.emit('data', this.response);
                this.emit('end');
            });
        }
        return true;
    }

    end() {}
    cancel() { this.emit('end'); }
}

class TestResponse extends Writable {
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

function planHarness({ allowRequestStreaming = false, response = null } = {}) {
    const generation = compileGeneration(generationInput({
        route: {
            allowRequestStreaming,
            limits: { bufferedBodyBytes: 4, streamedBodyBytes: 5 },
        },
    }));
    const store = new GenerationStore();
    store.activate(generation);
    const lease = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    const plan = resolveConvention({
        requestTarget: '/base-agent-additional-server/alpha/7001/upload',
        method: allowRequestStreaming ? 'POST' : 'GET',
        authority: '127.0.0.1:8080',
        generation,
        evaluateAccess: input => evaluateGenerationAccess({ generation, ...input }),
    });
    const stream = new RelayStream(response);
    const relayManager = {
        checkout: async ({ lease: selectedLease }) => {
            assert.equal(selectedLease.commit(), true);
            return {
                openRequest: async () => stream,
                close() {},
            };
        },
    };
    return { lease, plan, relayManager, stream };
}

function websocketFrame(payload, { opcode = 0x2, fin = true } = {}) {
    const body = Buffer.from(payload);
    assert.ok(body.length < 126);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, body.length]), body]);
}

async function transformFrames(chunks, limits) {
    const transform = new WebSocketFrameLimitTransform(limits);
    const output = [];
    transform.on('data', chunk => output.push(Buffer.from(chunk)));
    const completion = new Promise((resolve, reject) => {
        transform.once('end', resolve);
        transform.once('error', reject);
    });
    Readable.from(chunks).pipe(transform);
    await completion;
    return Buffer.concat(output);
}

test('streaming request bytes are bounded in RoutingServer before relay overflow', async () => {
    const { lease, plan, relayManager } = planHarness({ allowRequestStreaming: true });
    const req = Readable.from([Buffer.from('123456')]);
    req.method = 'POST';
    req.headers = { host: '127.0.0.1:8080', 'content-type': 'application/octet-stream' };
    const res = new TestResponse();
    const handled = await executeHttpPlan({ req, res, plan, lease, relayManager, authorized: true });
    assert.equal(handled, false);
    assert.equal(res.statusCode, 413);
    assert.equal(lease.released, true);
});

test('streaming response bytes are bounded after HTTP header parsing', async () => {
    const response = Buffer.from([
        'HTTP/1.1 200 OK',
        'Content-Length: 6',
        'Connection: close',
        '',
        '123456',
    ].join('\r\n'));
    const { lease, plan, relayManager } = planHarness({ response });
    const req = Readable.from([]);
    req.method = 'GET';
    req.headers = { host: '127.0.0.1:8080' };
    const res = new TestResponse();
    const handled = await executeHttpPlan({ req, res, plan, lease, relayManager, authorized: true });
    assert.equal(handled, false);
    assert.equal(res.destroyed, true);
    assert.equal(lease.released, true);
});

test('WebSocket frame and fragmented-message limits are incremental', async () => {
    const valid = [
        websocketFrame('abc', { opcode: 0x1, fin: false }),
        websocketFrame('!', { opcode: 0x9 }),
        websocketFrame('de', { opcode: 0x0, fin: true }),
    ];
    assert.deepEqual(
        await transformFrames(valid, { frameBytes: 4, messageBytes: 5 }),
        Buffer.concat(valid),
    );
    await assert.rejects(
        transformFrames([websocketFrame('12345')], { frameBytes: 4, messageBytes: 8 }),
        /frame limit/,
    );
    await assert.rejects(
        transformFrames([
            websocketFrame('123', { opcode: 0x1, fin: false }),
            websocketFrame('456', { opcode: 0x0, fin: true }),
        ], { frameBytes: 4, messageBytes: 5 }),
        /message limit/,
    );
});

test('proxy failures use bounded topology-free status classes', () => {
    assert.equal(proxyErrorStatus({ code: 'AUTH_REQUIRED' }), 403);
    assert.equal(proxyErrorStatus({ code: 'REQUEST_TOO_LARGE' }), 413);
    assert.equal(proxyErrorStatus(new Error('relay concurrency limit exceeded')), 503);
    assert.equal(proxyErrorStatus(new Error('upstream response header timeout')), 504);
    assert.equal(proxyErrorStatus(new Error('target refused connection')), 502);
});
