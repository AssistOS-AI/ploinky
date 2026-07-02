import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MASTER_KEY = '7'.repeat(64);

// Minimal http.ServerResponse stand-in matching the other router-route unit
// tests (userAdminRoutes / guestAuthRoutes): records status + JSON body so a
// handler that calls sendJson / res.writeHead+end can be asserted against.
class MockResponse {
    constructor() {
        this.statusCode = 200;
        this.headers = new Map();
        this.body = '';
    }

    setHeader(name, value) {
        this.headers.set(String(name).toLowerCase(), value);
    }

    getHeader(name) {
        return this.headers.get(String(name).toLowerCase());
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        for (const [name, value] of Object.entries(headers || {})) {
            this.setHeader(name, value);
        }
    }

    end(chunk = '') {
        this.body += chunk ? String(chunk) : '';
    }
}

function makeRequest({ method = 'POST', url = '/api/router/identity/user-api-key', body, user }) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
    const req = Readable.from(chunks);
    req.method = method;
    req.url = url;
    req.headers = {
        accept: 'application/json',
        host: 'localhost',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    req.socket = { encrypted: false };
    // The auth gate populates req.user upstream; the handler trusts it. Anonymous
    // requests simply leave it unset.
    if (user !== undefined) {
        req.user = user;
    }
    return req;
}

async function invoke(handler, options) {
    const req = makeRequest(options);
    const res = new MockResponse();
    const parsedUrl = new URL(options.url || '/api/router/identity/user-api-key', 'http://localhost');
    const handled = await handler(req, res, parsedUrl);
    return {
        handled,
        statusCode: res.statusCode,
        headers: res.headers,
        body: res.body ? JSON.parse(res.body) : null,
    };
}

function decodePublicUserApiKey(apiKey) {
    assert.equal(typeof apiKey, 'string');
    assert.ok(apiKey.startsWith('sk-soul-'), `expected public key prefix, got ${apiKey}`);
    assert.equal(apiKey.includes('user:'), false, 'public key must not expose a user subject');
    assert.equal(apiKey.startsWith('sk-soul-v1'), false, 'public key prefix must not expose a version marker');
    const payload = apiKey.slice('sk-soul-'.length);
    assert.match(payload, /^[A-Za-z0-9_-]+$/);
    return Buffer.from(payload, 'base64url').toString('utf8');
}

// Load the route handler, the pure builder, and the verify primitive in a
// throwaway cwd with an explicit master key, exactly like agentEnvInjection +
// userAdminRoutes do, so the keypair file lands under <temp>/.ploinky and no
// real workspace leaks in.
async function loadModules(t) {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'ploinky-user-api-key-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    mkdirSync(ploinkyDir, { recursive: true });

    const previousCwd = process.cwd();
    const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
    process.chdir(workspace);
    process.env.PLOINKY_MASTER_KEY = MASTER_KEY;
    t.after(() => {
        process.chdir(previousCwd);
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_MASTER_KEY;
        } else {
            process.env.PLOINKY_MASTER_KEY = previousMasterKey;
        }
        rmSync(workspace, { recursive: true, force: true });
    });

    const nonce = `${Date.now()}-${Math.random()}`;
    const route = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/server/userIdentityKeyRoute.js')).href}?test=${nonce}`);
    const pure = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/services/userIdentityKey.js')).href}?test=${nonce}`);
    const primitive = await import(`${pathToFileURL(path.join(REPO_ROOT, 'cli/services/subjectIdentityKey.js')).href}?test=${nonce}`);
    return { route, pure, primitive };
}

test('authenticated user receives sk-soul encoded key that verifies after decoding', async (t) => {
    const { route, primitive } = await loadModules(t);

    const result = await invoke(route.handleUserIdentityKeyRoute, {
        user: { id: '123', username: 'alice', roles: ['user'] },
    });

    assert.equal(result.handled, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.subjectId, 'user:123');
    assert.equal(typeof result.body.publicKey, 'string');
    assert.ok(result.body.publicKey.length > 0);
    assert.equal(result.body.publicKey, primitive.getSubjectIdentityPublicKey());

    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:123|'), `decoded key should start with user:123| (got ${rawApiKey})`);
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(rawApiKey, result.body.publicKey),
        { subjectId: 'user:123', subjectType: 'user' },
    );
});

test('a body userId is ignored for a non-admin (no horizontal privilege escalation)', async (t) => {
    const { route, primitive } = await loadModules(t);

    // Non-admin alice (id 123) attempts to mint a key for victim 999.
    const result = await invoke(route.handleUserIdentityKeyRoute, {
        body: { userId: '999' },
        user: { id: '123', username: 'alice', roles: ['user'] },
    });

    assert.equal(result.statusCode, 200);
    // The key is for alice's OWN id, NOT the requested 999.
    assert.equal(result.body.subjectId, 'user:123');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:123|'));
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(rawApiKey, result.body.publicKey),
        { subjectId: 'user:123', subjectType: 'user' },
    );
});

test('an admin CAN mint a key for another userId via the body', async (t) => {
    const { route, primitive } = await loadModules(t);

    // Admin (roles include admin) mints for another user 999.
    const result = await invoke(route.handleUserIdentityKeyRoute, {
        body: { userId: '999' },
        user: { id: 'sso:admin', username: 'admin', roles: ['user', 'admin'] },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.subjectId, 'user:999');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:999|'));
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(rawApiKey, result.body.publicKey),
        { subjectId: 'user:999', subjectType: 'user' },
    );
});

test('an admin with no body userId mints their own key', async (t) => {
    const { route } = await loadModules(t);

    const result = await invoke(route.handleUserIdentityKeyRoute, {
        user: { id: 'sso:admin', username: 'admin', roles: ['admin'] },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.subjectId, 'user:sso:admin');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:sso:admin|'));
});

test('an anonymous request is rejected with 401 and no key is minted', async (t) => {
    const { route } = await loadModules(t);

    const result = await invoke(route.handleUserIdentityKeyRoute, {
        // no user => unauthenticated
    });

    assert.equal(result.handled, true);
    assert.equal(result.statusCode, 401);
    assert.equal(result.body.error, 'not_authenticated');
    assert.equal(result.body.apiKey, undefined);
    assert.equal(result.body.subjectId, undefined);
});

test('a guest session is rejected — guests do not satisfy authenticated access (DS005)', async (t) => {
    const { route } = await loadModules(t);

    // A guest carries roles:['guest'] → Caller.fromRequest classifies kind='guest',
    // which is NOT an authenticated user. The route must refuse to mint a signed
    // key for it even though req.user is a populated object, otherwise an
    // unauthenticated guest could self-issue a usable Soul Gateway credential.
    const result = await invoke(route.handleUserIdentityKeyRoute, {
        body: { userId: '999' },
        user: { id: 'guest:abc', username: 'visitor', roles: ['guest'] },
    });

    assert.equal(result.statusCode, 401);
    assert.equal(result.body.error, 'not_authenticated');
    assert.equal(result.body.apiKey, undefined);
    assert.equal(result.body.subjectId, undefined);
});

test('an invalid userId returns 400, not a crash', async (t) => {
    const { route } = await loadModules(t);

    // Admin supplies a userId outside the [A-Za-z0-9._:-]+ segment alphabet
    // (slash, pipe, whitespace) — the primitive throws INVALID_SUBJECT, which the
    // route maps to a 400 rather than letting it crash. An empty string is NOT in
    // this set: it means "no userId supplied" and correctly falls back to self
    // (covered by the next test), so it must not 400.
    for (const badId of ['a/b', 'a|b', 'has space', 'a\tb']) {
        const result = await invoke(route.handleUserIdentityKeyRoute, {
            body: { userId: badId },
            user: { id: 'sso:admin', username: 'admin', roles: ['admin'] },
        });
        assert.equal(result.statusCode, 400, `userId=${JSON.stringify(badId)} should be 400`);
        assert.equal(result.body.error, 'invalid_user_id');
        assert.equal(result.body.apiKey, undefined);
    }
});

test('an admin supplying an empty-string userId falls back to their own key (not a 400)', async (t) => {
    const { route } = await loadModules(t);

    const result = await invoke(route.handleUserIdentityKeyRoute, {
        body: { userId: '' },
        user: { id: 'sso:admin', username: 'admin', roles: ['admin'] },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.subjectId, 'user:sso:admin');
    const rawApiKey = decodePublicUserApiKey(result.body.apiKey);
    assert.ok(rawApiKey.startsWith('user:sso:admin|'));
});

test('a session user with no usable identifier fails closed with 400', async (t) => {
    const { route } = await loadModules(t);

    // req.user is an object (so it passes the 401 gate) but carries no id /
    // username / email — there is nothing safe to sign, so it is a 400.
    const result = await invoke(route.handleUserIdentityKeyRoute, {
        user: { roles: ['user'] },
    });

    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error, 'invalid_user_id');
});

test('a non-POST method is rejected with 405', async (t) => {
    const { route } = await loadModules(t);

    const result = await invoke(route.handleUserIdentityKeyRoute, {
        method: 'GET',
        user: { id: '123', username: 'alice', roles: ['user'] },
    });

    assert.equal(result.statusCode, 405);
    assert.equal(result.headers.get('allow'), 'POST');
});

test('the route handler returns false (does not handle) for a non-matching path', async (t) => {
    const { route } = await loadModules(t);

    const req = makeRequest({ url: '/api/router/something-else', user: { id: '1', roles: ['user'] } });
    const res = new MockResponse();
    const handled = await route.handleUserIdentityKeyRoute(req, res, new URL('/api/router/something-else', 'http://localhost'));
    assert.equal(handled, false);
    assert.equal(res.statusCode, 200); // untouched default
});

test('the pure buildUserApiKeyResult enforces the privilege model directly', async (t) => {
    const { pure, primitive } = await loadModules(t);

    // Non-admin: requestedUserId ignored.
    const nonAdmin = pure.buildUserApiKeyResult({
        sessionUser: { id: '123', username: 'alice', roles: ['user'] },
        requestedUserId: '999',
        isAdmin: false,
    });
    assert.equal(nonAdmin.subjectId, 'user:123');

    // Admin: requestedUserId honored.
    const admin = pure.buildUserApiKeyResult({
        sessionUser: { id: 'sso:admin', username: 'admin' },
        requestedUserId: '999',
        isAdmin: true,
    });
    assert.equal(admin.subjectId, 'user:999');

    // Both keys verify under the shared public key.
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(decodePublicUserApiKey(nonAdmin.apiKey), nonAdmin.publicKey),
        { subjectId: 'user:123', subjectType: 'user' },
    );
    assert.deepEqual(
        primitive.verifySubjectIdentityKey(decodePublicUserApiKey(admin.apiKey), admin.publicKey),
        { subjectId: 'user:999', subjectType: 'user' },
    );

    // Invalid id throws the typed error (mapped to 400 by the route).
    assert.throws(
        () => pure.buildUserApiKeyResult({
            sessionUser: { id: 'sso:admin' },
            requestedUserId: 'a/b',
            isAdmin: true,
        }),
        (err) => err?.name === 'SubjectIdentityKeyError' && err.code === 'INVALID_SUBJECT',
    );
});
