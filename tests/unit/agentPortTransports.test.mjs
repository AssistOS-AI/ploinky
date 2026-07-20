import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { evaluateGenerationAccess } from '../../cli/server/generation/evaluateGenerationAccess.js';
import { resolveConvention } from '../../cli/server/agentPortConvention/resolveConvention.js';
import { executeHttpPlan } from '../../cli/server/proxy/executeHttpPlan.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

class ApplicationRelayStream extends EventEmitter {
    constructor() {
        super();
        this.channel = { child: { stdin: new EventEmitter() } };
        this.request = Buffer.alloc(0);
        this.responded = false;
    }

    write(chunk) {
        this.request = Buffer.concat([this.request, Buffer.from(chunk)]);
        const headerEnd = this.request.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd >= 0 && !this.responded) {
            const header = this.request.subarray(0, headerEnd).toString('latin1');
            const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1] || 0);
            if (this.request.length >= headerEnd + 4 + length) {
                this.responded = true;
                setImmediate(() => {
                    this.emit('data', Buffer.from([
                        'HTTP/1.1 200 OK',
                        'Content-Type: application/json',
                        'Content-Length: 11',
                        'Connection: close',
                        '',
                        '{"ok":true}',
                    ].join('\r\n')));
                    this.emit('end');
                });
            }
        }
        return true;
    }
    end() {}
    cancel() { this.emit('end'); }
}

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

test('buffered HTTP uses the admitted generation relay, rewritten suffix, and exact body', async () => {
    const generation = compileGeneration(generationInput());
    const store = new GenerationStore();
    store.activate(generation);
    const lease = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    const plan = resolveConvention({
        requestTarget: '/base-agent-additional-server/alpha/7001/api/items?page=2',
        method: 'POST',
        authority: '127.0.0.1:8080',
        generation,
        evaluateAccess: input => evaluateGenerationAccess({ generation, ...input }),
    });
    const body = Buffer.from('{"name":"one"}');
    const request = Readable.from([body]);
    request.method = 'POST';
    request.headers = {
        host: '127.0.0.1:8080',
        'content-type': 'application/json',
    };
    const response = new Response();
    let opened;
    const relayManager = {
        checkout: async ({ plan: finalized, lease: selectedLease, authorized }) => {
            assert.equal(authorized, true);
            assert.equal(selectedLease.commit(), true);
            return {
                openRequest: async options => {
                    opened = options;
                    return new ApplicationRelayStream();
                },
                close() {},
            };
        },
    };
    const handled = await executeHttpPlan({
        req: request,
        res: response,
        plan,
        lease,
        relayManager,
        authorized: true,
    });
    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString('utf8'), '{"ok":true}');
    assert.equal(opened.plan.targetPath, '/api/items');
    assert.equal(opened.plan.query, 'page=2');
    assert.equal(opened.bodyMode, 'buffered-v1');
    assert.match(opened.bodyHash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(opened.headers.host, '127.0.0.1:7001');
    assert.equal(opened.headers['x-forwarded-prefix'], '/base-agent-additional-server/alpha/7001');
});
