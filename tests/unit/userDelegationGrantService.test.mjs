import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { UserDelegationGrantService } = await import(`../../cli/server/security/tokens/UserDelegationGrantService.js${moduleSuffix}`);

test('UserDelegationGrantService refuses to mint grants for guests', async () => {
    const service = new UserDelegationGrantService({
        jwsCodec: { signHmacJwt: async () => 'udg.jwt' },
        resolveGrantSecret: async () => 'grant-secret',
    });

    await assert.rejects(
        () => service.mint({
            sourceAgentId: 'source',
            user: null,
            actor: { kind: 'guest', sid: 'guest-1' },
            targetAgentId: 'target',
            tools: ['read'],
            scopes: ['files:read'],
            route: { routeKey: 'docs' },
        }),
        /USER_DELEGATION_REQUIRES_AUTHENTICATED_USER/,
    );
});
