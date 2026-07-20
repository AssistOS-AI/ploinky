import test from 'node:test';
import assert from 'node:assert/strict';

import { assertMutationAllowed, assertSupportedHttp1Request } from '../../cli/server/proxy/executeHttpPlan.js';
import { assertWebSocketHandshake } from '../../cli/server/proxy/executeWebSocketPlan.js';

const plan = { method: 'POST', origin: 'https://router.example' };

test('cookie-authenticated mutations require exact Origin and double-submit CSRF', () => {
    assert.throws(() => assertMutationAllowed({
        method: 'POST',
        headers: { cookie: 'ploinky_sso=session; ploinky_csrf=one', origin: 'https://other.example', 'x-csrf-token': 'one' },
    }, plan), /origin rejected/);
    assert.throws(() => assertMutationAllowed({
        method: 'POST',
        headers: { cookie: 'ploinky_sso=session; ploinky_csrf=one', origin: plan.origin, 'x-csrf-token': 'two' },
    }, plan), /CSRF token rejected/);
    assert.equal(assertMutationAllowed({
        method: 'POST',
        headers: { cookie: 'ploinky_sso=session; ploinky_csrf=one', origin: plan.origin, 'x-csrf-token': 'one' },
    }, plan), true);
});

test('read-only and non-Router-cookie application requests do not inherit Router CSRF semantics', () => {
    assert.equal(assertMutationAllowed({ method: 'GET', headers: {} }, plan), true);
    assert.equal(assertMutationAllowed({ method: 'POST', headers: { authorization: 'Bearer app-token' } }, plan), true);
});

test('unsupported HTTP/1.1 forms fail before relay checkout', () => {
    assert.throws(() => assertSupportedHttp1Request({ method: 'CONNECT', headers: {} }, plan), /unsupported HTTP method/);
    assert.throws(() => assertSupportedHttp1Request({
        method: 'POST', headers: { 'content-length': '1', 'transfer-encoding': 'chunked' },
    }, plan), /ambiguous HTTP message framing/);
    assert.throws(() => assertSupportedHttp1Request({ method: 'GET', headers: { upgrade: 'h2c' } }, plan), /unsupported HTTP upgrade/);
});

test('WebSocket execution accepts only a complete RFC 6455 upgrade shape', () => {
    const request = {
        method: 'GET',
        headers: {
            upgrade: 'websocket',
            connection: 'keep-alive, Upgrade',
            'sec-websocket-version': '13',
            'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'),
        },
    };
    assert.equal(assertWebSocketHandshake(request), true);
    assert.throws(() => assertWebSocketHandshake({
        ...request, headers: { ...request.headers, upgrade: 'h2c' },
    }), /invalid WebSocket handshake/);
});
