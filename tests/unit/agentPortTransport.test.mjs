import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import { executeHttpPlan } from '../../cli/server/proxy/executeHttpPlan.js';
import { compileProxyLimits } from '../../cli/server/proxy/limits.js';
import { createRoutePlan } from '../../cli/server/proxy/RoutePlan.js';

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

function routePlan({ allowRequestStreaming = false } = {}) {
    return createRoutePlan({
        matched: true,
        ok: true,
        listenerClass: 'public',
        authority: '127.0.0.1:8080',
        surfaceKind: 'agent-port-convention',
        owner: {
            effectiveInstanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
        routeKey: 'alpha',
        port: 7001,
        policyPath: '/base-agent-additional-server/alpha/7001/api/items',
        convention: 'base-agent-additional-server',
        unmatchedSuffix: '/api/items',
        query: 'page=2',
        relay: {
            kind: 'container-exec-stdio',
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            containerName: 'alpha-container',
            targetAgentId: 'agent:fixtures/alpha',
            effectiveInstanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
        access: { access: 'authenticated' },
        scheme: 'http',
        origin: 'http://127.0.0.1:8080',
        forwardedPrefix: '/base-agent-additional-server/alpha/7001',
        limits: compileProxyLimits(),
        generationDigest: 'sha256:generation',
        auditId: 'audit-http',
        method: 'POST',
        transport: 'http',
        allowRequestStreaming,
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

test('HTTP relay uses the admitted convention suffix, port, query, and exact body', async () => {
    const body = Buffer.from('{"name":"one"}');
    const request = Readable.from([body]);
    request.method = 'POST';
    request.headers = {
        host: '127.0.0.1:8080',
        'content-type': 'application/json',
    };
    const response = new Response();
    let opened;
    let released = false;
    const relayManager = {
        checkout: async ({ authorized }) => {
            assert.equal(authorized, true);
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
        plan: routePlan(),
        lease: { release() { released = true; } },
        relayManager,
        authorized: true,
    });

    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString('utf8'), '{"ok":true}');
    assert.equal(opened.plan.targetPath, '/api/items');
    assert.equal(opened.plan.port, 7001);
    assert.equal(opened.plan.query, 'page=2');
    assert.equal(opened.bodyMode, 'buffered');
    assert.match(opened.bodyHash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(opened.headers.host, '127.0.0.1:7001');
    assert.equal(opened.headers['x-forwarded-prefix'], '/base-agent-additional-server/alpha/7001');
    assert.equal(released, true);
});

test('prebuffered private request bodies take precedence over route streaming', async () => {
    const body = Buffer.from('{"room":"diagnostic-room"}');
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = {
        host: 'host.containers.internal:8081',
        'content-type': 'application/json',
        'content-length': String(body.length),
    };
    const response = new Response();
    let opened;
    let relayStream;
    const relayManager = {
        checkout: async () => ({
            openRequest: async options => {
                opened = options;
                relayStream = new ApplicationRelayStream();
                return relayStream;
            },
            close() {},
        }),
    };

    const handled = await executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan({ allowRequestStreaming: true }),
        lease: { release() {} },
        relayManager,
        authorized: true,
        prebufferedBody: body,
    });

    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(opened.bodyMode, 'buffered');
    assert.equal(opened.headers['content-length'], String(body.length));
    assert.equal(
        relayStream.request.subarray(relayStream.request.indexOf(Buffer.from('\r\n\r\n')) + 4).toString('utf8'),
        body.toString('utf8'),
    );
});
