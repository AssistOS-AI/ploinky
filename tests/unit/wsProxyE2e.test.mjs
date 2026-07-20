import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { evaluateGenerationAccess } from '../../cli/server/generation/evaluateGenerationAccess.js';
import { resolveConvention } from '../../cli/server/agentPortConvention/resolveConvention.js';
import { executeWebSocketPlan } from '../../cli/server/proxy/executeWebSocketPlan.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

class LocalRelayStream extends EventEmitter {
    constructor() {
        super();
        this.channel = { child: { stdin: new EventEmitter() } };
        this.request = Buffer.alloc(0);
        this.responded = false;
    }

    write(chunk) {
        this.request = Buffer.concat([this.request, Buffer.from(chunk)]);
        if (!this.responded && this.request.includes(Buffer.from('\r\n\r\n'))) {
            this.responded = true;
            const text = this.request.toString('latin1');
            const key = text.match(/sec-websocket-key:\s*([^\r\n]+)/i)?.[1]?.trim();
            const accept = crypto.createHash('sha1')
                .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
                .digest('base64');
            setImmediate(() => this.emit('data', Buffer.from([
                'HTTP/1.1 101 Switching Protocols',
                'Connection: Upgrade',
                'Upgrade: websocket',
                `Sec-WebSocket-Accept: ${accept}`,
                '',
                '',
            ].join('\r\n'))));
        }
        return true;
    }
    end() {}
    cancel() { this.emit('end'); }
}

class BrowserSocket extends Duplex {
    constructor() {
        super();
        this.response = Buffer.alloc(0);
    }

    _read() {}
    _write(chunk, _encoding, callback) {
        this.response = Buffer.concat([this.response, Buffer.from(chunk)]);
        callback();
        if (this.response.includes(Buffer.from('\r\n\r\n'))) setImmediate(() => this.destroy());
    }
}

test('convention WebSocket upgrades use the generation relay plan and preserve protocol headers', async () => {
    const port = 7001;
    const generation = compileGeneration(generationInput());
    const store = new GenerationStore();
    store.activate(generation);
    const lease = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    const plan = resolveConvention({
        requestTarget: `/base-agent-additional-server/alpha/${port}/socket?channel=one`,
        method: 'GET',
        authority: '127.0.0.1:8080',
        generation,
        transport: 'websocket',
        evaluateAccess: input => evaluateGenerationAccess({ generation, ...input }),
    });
    let selectedPlan;
    let channelClosed = false;
    let relayStream;
    const relayManager = {
        checkout: async ({ plan: finalized, authorized }) => {
            assert.equal(authorized, true);
            selectedPlan = finalized;
            return {
                openRequest: async () => {
                    relayStream = new LocalRelayStream();
                    return relayStream;
                },
                close: () => {
                    channelClosed = true;
                    relayStream?.cancel();
                },
            };
        },
    };
    const key = crypto.randomBytes(16).toString('base64');
    const request = new EventEmitter();
    request.method = 'GET';
    request.headers = {
        host: '127.0.0.1:8080',
        connection: 'Upgrade',
        upgrade: 'websocket',
        origin: 'http://127.0.0.1:8080',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
    };
    const browser = new BrowserSocket();
    const audit = [];
    const handled = await executeWebSocketPlan({
        req: request,
        socket: browser,
        plan,
        lease,
        relayManager,
        authorized: true,
        auditSink: event => audit.push(event),
    });
    assert.equal(handled, true, JSON.stringify({ audit, response: browser.response.toString('latin1') }));
    assert.equal(selectedPlan.targetPath, '/socket');
    assert.equal(selectedPlan.query, 'channel=one');
    assert.equal(channelClosed, true);
    const response = browser.response.toString('latin1').toLowerCase();
    assert.match(response, /^http\/1\.1 101/);
    assert.match(response, /connection: upgrade/);
    assert.match(response, /upgrade: websocket/);
});
