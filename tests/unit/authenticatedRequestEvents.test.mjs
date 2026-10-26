import assert from 'node:assert/strict';
import test from 'node:test';

import {
    onAuthenticatedRequestDecision,
    publishAuthenticatedRequestDecision,
} from '../../cli/server/auth/authenticatedRequestEvents.mjs';

function request(mode = 'local', roles = ['user']) {
    return { authMode: mode, user: { id: 'user-a', roles },
        sessionId: 'private-session', headers: { authorization: 'private-token' },
        session: { createdAt: 1000, _jwtPayload: { usr: { roles: [...roles] } }, tokens: { accessToken: 'private-provider-token' } },
    };
}

test('decisions are synchronous immutable sanitized snapshots; listener failures and disposal are isolated', async (t) => {
    assert.throws(() => onAuthenticatedRequestDecision(null), TypeError);
    const seen = [];
    const stopThrow = onAuthenticatedRequestDecision(() => { throw new Error('observer failure'); });
    const stopReject = onAuthenticatedRequestDecision(async () => { throw new Error('async observer failure'); });
    const stop = onAuthenticatedRequestDecision(decision => seen.push(decision));
    t.after(() => { stop(); stopThrow(); stopReject(); });
    const req = request('local', [' User ', 'ADMIN']);
    assert.equal(publishAuthenticatedRequestDecision(req), true);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { authMode: 'local', userId: 'user-a', roles: ['user', 'admin'], decidedAt: 1000 });
    assert.equal(Object.isFrozen(seen[0]), true);
    assert.equal(Object.isFrozen(seen[0].roles), true);
    req.user.roles[0] = 'guest';
    req.user.id = 'changed';
    assert.equal(seen[0].userId, 'user-a');
    assert.deepEqual(seen[0].roles, ['user', 'admin']);
    assert.doesNotMatch(JSON.stringify(seen), /private|session|authorization|token/i);
    stop(); stop();
    assert.equal(publishAuthenticatedRequestDecision(request()), true);
    assert.equal(seen.length, 1);
    await new Promise(resolve => setImmediate(resolve));
});

test('unsupported/guest/incomplete/expired identities and missing local issuance never publish', (t) => {
    const seen = [];
    const stop = onAuthenticatedRequestDecision(value => seen.push(value));
    t.after(stop);
    const invalid = [null, {}, request('guest'), request('none'), request('sso', [' Guest ']), request('local', ['guest'])];
    for (const change of [
        req => { delete req.user; }, req => { req.user.id = ''; },
        req => { delete req.user.roles; }, req => { req.user.roles = [null]; },
        req => { delete req.session._jwtPayload.usr.roles; },
        req => { req.session._jwtPayload.usr.roles = ['admin']; },
        req => { delete req.session.createdAt; }, req => { req.session.createdAt = 0; },
        req => { req.session.createdAt = Infinity; }, req => { req.session.createdAt = '1000'; },
        req => { req.session.expiresAt = 1; },
    ]) {
        const req = request(); change(req); invalid.push(req);
    }
    for (const req of invalid) assert.equal(publishAuthenticatedRequestDecision(req), false);
    assert.deepEqual(seen, []);
});

test('empty full roles are a valid decision and SSO publication uses current time', (t) => {
    t.mock.method(Date, 'now', () => 987_654);
    const seen = [];
    const stop = onAuthenticatedRequestDecision(value => seen.push(value));
    t.after(stop);
    assert.equal(publishAuthenticatedRequestDecision(request('local', [])), true);
    assert.equal(publishAuthenticatedRequestDecision(request('sso', [])), true);
    assert.deepEqual(seen.map(value => [value.roles, value.decidedAt]), [[[], 1000], [[], 987_654]]);
});

test('provider identifiers retain exact bytes, including surrounding whitespace', (t) => {
    const seen = [];
    const stop = onAuthenticatedRequestDecision(value => seen.push(value));
    t.after(stop);
    const req = request('sso');
    req.user.id = ' user-a ';
    assert.equal(publishAuthenticatedRequestDecision(req), true);
    assert.equal(seen[0].userId, ' user-a ');
});
