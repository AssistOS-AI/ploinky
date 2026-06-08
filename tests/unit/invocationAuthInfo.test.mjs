import test from 'node:test';
import assert from 'node:assert/strict';

import { authInfoFromInvocation } from '../../Agent/lib/invocation-auth.mjs';

test('authInfoFromInvocation promotes router user actor into authInfo.user', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'user:local:admin',
        actor: { kind: 'user', id: 'user:local:admin', roles: ['admin'] },
        tool: 'webmeet_room_list'
    });

    assert.equal(authInfo.principalId, 'user:local:admin');
    assert.deepEqual(authInfo.user, {
        id: 'local:admin',
        username: 'admin',
        email: '',
        roles: ['admin']
    });
    assert.equal(authInfo.invocation.actor.id, 'user:local:admin');
});

test('authInfoFromInvocation derives user identity from user subject when actor is absent', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'user:github:1234',
        tool: 'webmeet_room_list'
    });

    assert.equal(authInfo.principalId, 'user:github:1234');
    assert.equal(authInfo.user.id, 'github:1234');
    assert.equal(authInfo.user.username, 'github:1234');
});
