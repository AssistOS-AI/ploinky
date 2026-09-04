import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { SessionTokenService } = await import(`../../cli/server/security/tokens/SessionTokenService.js${moduleSuffix}`);

function serviceWithSessions() {
    return new SessionTokenService({
        verifySessionJwt: (token) => {
            if (token === 'user-token') return { typ: 'user-session', chn: 'cli', sub: 'local:admin', usr: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
            if (token === 'browser-token') return { typ: 'user-session', usr: { id: 'local:admin', roles: ['admin'] } };
            if (token === 'guest-token') {
                return {
                    typ: 'guest-session',
                    usr: { id: 'guest:g1', username: 'visitor', roles: ['guest'] },
                    rev: 0,
                    gscope: 'guest-scope',
                    groute: 'guestAgent',
                };
            }
            throw new Error('Not a session JWT');
        },
    });
}

test('getUserSession accepts only the signed CLI operator identity', async () => {
    const service = serviceWithSessions();
    const userSession = await service.getUserSession('user-token');
    assert.equal(userSession.kind, 'operator');
    assert.equal(userSession.user.id, 'local:admin');
    assert.equal(await service.getUserSession('guest-token'), null);
    assert.equal(await service.getUserSession('browser-token'), null);
    assert.equal(await service.getUserSession('garbage'), null);
});

test('getGuestSession accepts only typ guest-session', async () => {
    const service = serviceWithSessions();
    const guestSession = await service.getGuestSession('guest-token', {
        policy: { routeKey: 'guestAgent', guestScope: 'guest-scope' },
    });
    assert.equal(guestSession.kind, 'guest');
    assert.deepEqual(guestSession.user.roles, ['guest']);
    const preserved = await service.getGuestSession('guest-token', {
        routeKey: 'guestAgent',
        allowAnyGuestScope: true,
    });
    assert.equal(preserved.kind, 'guest');
    assert.equal(preserved._jwtPayload.gscope, 'guest-scope');
    assert.equal(await service.getGuestSession('guest-token', {
        routeKey: 'otherAgent',
        allowAnyGuestScope: true,
    }), null);
    assert.equal(await service.getGuestSession('user-token'), null);
});
