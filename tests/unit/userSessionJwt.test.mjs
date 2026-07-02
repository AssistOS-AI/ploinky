import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-usersession-'));
const originalCwd = process.cwd();
process.chdir(tempDir);
fs.mkdirSync(path.join(tempDir, '.ploinky'), { recursive: true });
process.env.PLOINKY_MASTER_KEY = '9'.repeat(64);

const moduleSuffix = `?test=${Date.now()}`;
const localService = await import(`../../cli/server/auth/localService.js${moduleSuffix}`);
const { deriveSubkey } = await import(`../../cli/services/masterKey.js${moduleSuffix}`);
const { signHmacJwt } = await import(`../../Agent/lib/jwtSign.mjs${moduleSuffix}`);
const { revokeSessionId } = await import(`../../cli/server/auth/sessionRevocations.js${moduleSuffix}`);

const USER = { id: 'sso:daniel', username: 'daniel', name: 'Daniel', email: '', roles: ['user'] };

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function signSession(payloadOverrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        typ: 'user-session',
        iss: 'ploinky-router',
        aud: 'ploinky-router',
        sub: 'sso:daniel',
        sid: 'sess_manual',
        usr: { id: 'sso:daniel', username: 'daniel', roles: ['user'] },
        rev: 1,
        iat: now,
        exp: now + 3600,
        jti: 'jti_manual',
        ...payloadOverrides,
    };
    return signHmacJwt({ payload, secret: deriveSubkey('session') });
}

test('mintSessionJwt issues a user-session bound to the router audience with a sid', () => {
    const token = localService.mintSessionJwt(USER, 1);
    const payload = localService.verifySessionJwt(token);
    assert.equal(payload.typ, 'user-session');
    assert.equal(payload.aud, 'ploinky-router');
    assert.equal(payload.iss, 'ploinky-router');
    assert.ok(payload.sid && payload.sid.startsWith('sess_'));
    assert.ok(payload.jti);
});

test('sid is stable when an existing sid is supplied (sliding-window refresh)', () => {
    const first = localService.verifySessionJwt(localService.mintSessionJwt(USER, 1));
    const refreshed = localService.verifySessionJwt(localService.mintSessionJwt(USER, 1, { sid: first.sid }));
    assert.equal(refreshed.sid, first.sid);
    // A fresh login without a supplied sid gets a different sid.
    const other = localService.verifySessionJwt(localService.mintSessionJwt(USER, 1));
    assert.notEqual(other.sid, first.sid);
});

test('verifySessionJwt rejects a token with the wrong audience', () => {
    const token = signSession({ aud: 'someone-else' });
    assert.throws(() => localService.verifySessionJwt(token), /audience mismatch/);
});

test('verifySessionJwt rejects a token with an unknown type', () => {
    const token = signSession({ typ: 'router-request' });
    assert.throws(() => localService.verifySessionJwt(token), /Not a session JWT/);
});

test('getSession resolves a valid user-session, then null after sid revocation', () => {
    const token = localService.mintSessionJwt(USER, 1);
    const payload = localService.verifySessionJwt(token);
    const session = localService.getSession(token);
    assert.ok(session, 'expected a resolved session before revocation');
    assert.equal(session.user.username, 'daniel');

    revokeSessionId({ sid: payload.sid, reason: 'logout' });

    assert.equal(localService.getSession(token), null, 'revoked sid must no longer resolve');
    // The revocation is persisted under the workspace data dir.
    const file = path.join(tempDir, '.ploinky', 'data', 'router-security', 'sessions-revocations.json');
    assert.ok(fs.existsSync(file));
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.schema, 'sessions-revocations');
    assert.ok(stored.revoked.some((entry) => entry.sid === payload.sid));
});

test('getSession resolves a guest-session and honors jti revocation', () => {
    const guestToken = localService.mintGuestSessionJwt({ guestScope: 'demo-scope' });
    const payload = localService.verifySessionJwt(guestToken);
    assert.equal(payload.typ, 'guest-session');
    const session = localService.getSession(guestToken, { policy: { mode: 'guest', guestScope: 'demo-scope' } });
    assert.equal(session?.user?.roles?.includes('guest'), true);

    revokeSessionId({ jti: payload.jti, reason: 'logout' });
    assert.equal(localService.getSession(guestToken, { policy: { mode: 'guest', guestScope: 'demo-scope' } }), null);
});
