import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const originalMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = 'c'.repeat(64);

const {
    canonicalControlOrigin,
    mintAdminCsrfToken,
    requireAdminControlRequest,
    verifyAdminMutationRequest,
} = await import(`../../cli/server/adminControlSecurity.js?t=${Date.now()}`);
const { handleDashboard } = await import(`../../cli/server/handlers/dashboard.js?t=${Date.now()}`);
const { handleStatus } = await import(`../../cli/server/handlers/status.js?t=${Date.now()}`);

test.after(() => {
    if (originalMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = originalMasterKey;
});

function request({
    url = '/dashboard/',
    method = 'GET',
    host = '127.0.0.1:8080',
    user = { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] },
    sessionId = 'session-a',
    headers = {},
} = {}) {
    const req = Readable.from([]);
    req.url = url;
    req.method = method;
    req.headers = { host, ...headers };
    req.socket = { encrypted: false };
    req.user = user;
    req.sessionId = sessionId;
    return req;
}

function response() {
    let resolve;
    const ended = new Promise((done) => { resolve = done; });
    return {
        statusCode: 0,
        headers: {},
        body: '',
        ended,
        writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; },
        end(chunk = '') { this.body += String(chunk || ''); resolve(); },
    };
}

test('admin CSRF proof is bound to exact local origin and session', () => {
    const req = request();
    req.headers.origin = 'http://127.0.0.1:8080';
    req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ sessionId: req.sessionId, req });
    assert.equal(canonicalControlOrigin(req), 'http://127.0.0.1:8080');
    assert.deepEqual(verifyAdminMutationRequest(req), { ok: true, origin: 'http://127.0.0.1:8080' });

    assert.equal(verifyAdminMutationRequest(req, 'session-b').code, 'CSRF_INVALID');
    req.headers.origin = 'http://localhost:8080';
    assert.equal(verifyAdminMutationRequest(req).code, 'CONTROL_ORIGIN_REQUIRED');
    req.headers.origin = 'http://127.0.0.1:8080';
    req.headers['x-forwarded-host'] = 'attacker.example';
    assert.equal(verifyAdminMutationRequest(req).code, 'CONTROL_ORIGIN_REQUIRED');
});

test('admin CSRF proof survives local JWT refresh for the same signed session id', () => {
    const req = request({ sessionId: 'jwt-before-refresh' });
    req.session = { _jwtPayload: { sid: 'sess-stable' } };
    req.headers.origin = 'http://127.0.0.1:8080';
    req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ sessionId: req.sessionId, req });

    req.sessionId = 'jwt-after-refresh';
    assert.equal(verifyAdminMutationRequest(req).ok, true);
    req.session._jwtPayload.sid = 'sess-other';
    assert.equal(verifyAdminMutationRequest(req).code, 'CSRF_INVALID');
});

test('non-local, malformed, and suffix-confusable control origins are rejected', () => {
    for (const host of ['example.com', 'localhost.example.com', 'localhost.', '127.0.0.1@attacker.example', 'localhost/evil']) {
        assert.equal(canonicalControlOrigin(request({ host })), null, host);
    }
    assert.equal(canonicalControlOrigin(request({ host: '[::1]:8080' })), 'http://[::1]:8080');
});

test('dashboard and status independently reject ordinary users and legacy dashboard SID cookies', async () => {
    const ordinary = { id: 'local:bob', username: 'bob', roles: ['user'] };
    for (const [handler, url] of [[handleDashboard, '/dashboard/'], [handleStatus, '/status/data']]) {
        const res = response();
        handler(request({ url, user: ordinary }), res, {}, { sessions: new Map() });
        await res.ended;
        assert.equal(res.statusCode, 403, url);
        assert.match(res.body, /ADMIN_REQUIRED/);
    }

    const legacy = request({ user: null, headers: { cookie: 'dashboard_sid=legacy' } });
    const legacyRes = response();
    handleDashboard(legacy, legacyRes, {}, { sessions: new Map([['legacy', {}]]) });
    await legacyRes.ended;
    assert.equal(legacyRes.statusCode, 401);
});

test('removed dashboard token-auth route is absent even for an administrator', async () => {
    const res = response();
    handleDashboard(request({ url: '/dashboard/auth', method: 'POST' }), res, {}, {});
    await res.ended;
    assert.equal(res.statusCode, 404);
});

test('dashboard root exposes only generic read-only monitoring contracts', async () => {
    const res = response();
    handleDashboard(request(), res, {}, {});
    await res.ended;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.readOnly, true);
    assert.deepEqual(Object.keys(body.endpoints).sort(), ['logs', 'resources', 'status']);
});

test('mutation guard rejects missing Origin and CSRF before a control handler can run', async () => {
    for (const headers of [{}, { origin: 'http://127.0.0.1:8080' }, { origin: 'https://127.0.0.1:8080', 'x-ploinky-csrf-token': 'v1.invalid' }]) {
        const req = request({ method: 'POST', headers });
        const res = response();
        assert.equal(requireAdminControlRequest(req, res, { mutation: true }), false);
        await res.ended;
        assert.equal(res.statusCode, 403);
    }
});
