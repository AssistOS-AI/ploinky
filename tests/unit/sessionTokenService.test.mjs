import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { SessionTokenService } = await import(`../../cli/server/security/tokens/SessionTokenService.js${moduleSuffix}`);

function serviceWithSessions() {
    return new SessionTokenService({
        verifySessionJwt: (token) => {
            if (token === 'user-token') return { typ: 'user-session', usr: { id: 'u1', username: 'u1', roles: ['user'] }, rev: 1 };
            if (token === 'guest-token') return { typ: 'guest-session', usr: { id: 'guest:g1', username: 'visitor', roles: ['guest'] }, rev: 0 };
            throw new Error('Not a session JWT');
        },
        resolveUserRev: () => 1,
    });
}

test('getUserSession accepts only typ user-session', async () => {
    const service = serviceWithSessions();
    const userSession = await service.getUserSession('user-token');
    assert.equal(userSession.kind, 'user');
    assert.equal(userSession.user.id, 'u1');
    assert.equal(await service.getUserSession('guest-token'), null);
    assert.equal(await service.getUserSession('garbage'), null);
});

test('getGuestSession accepts only typ guest-session', async () => {
    const service = serviceWithSessions();
    const guestSession = await service.getGuestSession('guest-token');
    assert.equal(guestSession.kind, 'guest');
    assert.deepEqual(guestSession.user.roles, ['guest']);
    assert.equal(await service.getGuestSession('user-token'), null);
});
