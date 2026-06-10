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

test('authInfoFromInvocation leaves agent callers on the agent path with no user identity', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'agent:AssistOSExplorer/gitAgent',
        actor: { kind: 'agent', id: 'agent:AssistOSExplorer/gitAgent', roles: [] },
        caller: { kind: 'agent', id: 'agent:AssistOSExplorer/gitAgent', roles: ['agent'] },
        tool: 'git_status'
    });

    assert.deepEqual(authInfo.agent, {
        principalId: 'agent:AssistOSExplorer/gitAgent',
        name: 'AssistOSExplorer/gitAgent'
    });
    assert.equal(authInfo.user, undefined);
    assert.equal(authInfo.principalId, undefined);
    assert.equal(authInfo.invocation.actor.kind, 'agent');
    assert.equal(authInfo.invocation.caller.id, 'agent:AssistOSExplorer/gitAgent');
});

test('authInfoFromInvocation leaves a guest actor unauthenticated', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'guest:room_x',
        actor: { kind: 'guest', id: 'guest:room_x', roles: ['guest'] },
        tool: 'webmeet_room_list'
    });

    assert.equal(authInfo.user, undefined);
    assert.equal(authInfo.principalId, undefined);
    assert.equal(authInfo.invocation.actor.kind, 'guest');
});

test('authInfoFromInvocation does not promote a guest actor even when sub is user-shaped', () => {
    // Hardening (M1): an explicit non-user actor must never be derived into an
    // authenticated user via the `sub` fallback.
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'user:local:admin',
        actor: { kind: 'guest', id: 'guest:room_x', roles: ['guest'] },
        tool: 'webmeet_room_list'
    });

    assert.equal(authInfo.user, undefined);
    assert.equal(authInfo.principalId, undefined);
});

test('authInfoFromInvocation keeps legacy usr claims authoritative and normalizes the id', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'user:local:admin',
        actor: { kind: 'user', id: 'user:local:admin', roles: ['admin'] },
        usr: { id: 'user:local:admin', username: 'admin', email: 'a@b.c', roles: ['operator'] }
    });

    // Legacy claims win for identity + roles; the `user:` prefix is stripped so
    // the id matches the `user:${id}` principal convention used by DPU/Git.
    assert.equal(authInfo.user.id, 'local:admin');
    assert.equal(authInfo.user.username, 'admin');
    assert.equal(authInfo.user.email, 'a@b.c');
    assert.deepEqual(authInfo.user.roles, ['operator']);
    assert.equal(authInfo.principalId, 'user:local:admin');
});

test('authInfoFromInvocation does not merge actor.roles into present usr claims', () => {
    // Precedence guard (M2): when usr/user is present, actor.roles are not merged
    // in, so a privileged actor cannot widen a delegated user's roles.
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'user:github:1',
        actor: { kind: 'user', id: 'user:github:1', roles: ['admin'] },
        usr: { id: 'github:1', username: 'octocat', roles: [] }
    });

    assert.deepEqual(authInfo.user.roles, []);
    assert.equal(authInfo.invocation.actor.roles.includes('admin'), true);
});

test('authInfoFromInvocation ignores a malformed user actor with an empty id', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'guest:x',
        actor: { kind: 'user', id: '', roles: ['admin'] },
        tool: 'webmeet_room_list'
    });

    assert.equal(authInfo.user, undefined);
    assert.equal(authInfo.principalId, undefined);
});

test('authInfoFromInvocation exposes caller and delegation metadata while keeping usr authoritative', () => {
    const authInfo = authInfoFromInvocation({
        iss: 'ploinky-router',
        sub: 'agent:AssistOSExplorer/onlyOffice',
        actor: { kind: 'agent', id: 'agent:AssistOSExplorer/onlyOffice', roles: ['agent'] },
        caller: { kind: 'agent', id: 'agent:AssistOSExplorer/onlyOffice', roles: ['agent'] },
        usr: { id: 'local:alice', username: 'alice', roles: ['user'] },
        delegation: {
            jti: 'delegation-1',
            scope: ['dpu:confidential:read'],
            sourceAgentId: 'agent:AssistOSExplorer/onlyOffice'
        },
        tool: 'dpu_confidential_get'
    });

    assert.equal(authInfo.user.id, 'local:alice');
    assert.equal(authInfo.agent.principalId, 'agent:AssistOSExplorer/onlyOffice');
    assert.equal(authInfo.invocation.caller.id, 'agent:AssistOSExplorer/onlyOffice');
    assert.equal(authInfo.invocation.delegation.jti, 'delegation-1');
});
