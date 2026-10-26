import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { RouterRequestTokenService, normalizeActor, normalizeUserClaims } = await import(`../../cli/server/security/tokens/RouterRequestTokenService.js${moduleSuffix}`);

test('RouterRequestTokenService mints byte-compatible router-request payloads', async () => {
    const signed = [];
    const service = new RouterRequestTokenService({
        jwsCodec: {
            signHmacJwt: async (input) => {
                signed.push(input);
                return 'rr.jwt';
            },
        },
        resolveAgentSecret: async () => 'agent-secret',
        now: () => new Date('2026-06-11T00:00:00.000Z'),
        randomId: () => 'nonce-1',
    });

    assert.equal(await service.mint({
        targetAgentId: 'agent-a',
        sub: 'user:guest:g1',
        actor: { kind: 'guest', id: 'user:guest:g1', roles: ['guest'] },
        caller: { kind: 'user', id: 'user:guest:g1' },
        scope: ['public:webmeet:room', 'public:webmeet:room', ''],
        method: 'GET',
        path: '/agent-a/readme',
        tool: null,
        rch: 'browser',
    }), 'rr.jwt');

    const payload = signed[0].payload;
    assert.equal(payload.typ, 'router-request');
    assert.equal(payload.iss, 'ploinky-router');
    assert.equal(payload.aud, 'agent-a');
    assert.equal(payload.sub, 'user:guest:g1');
    assert.deepEqual(payload.actor, { kind: 'guest', id: 'user:guest:g1', roles: ['guest'] });
    assert.deepEqual(payload.scope, ['public:webmeet:room']);
    assert.equal(payload.method, 'GET');
    assert.equal(payload.path, '/agent-a/readme');
    assert.equal(payload.rch, 'browser');
    assert.equal(payload.jti, 'nonce-1');
    assert.equal(payload.exp - payload.iat, 30);
    assert.equal('tool' in payload, false);
    assert.equal('usr' in payload, false);
    assert.equal('delegations' in payload, false);
});

test('RouterRequestTokenService clamps caller-supplied TTLs and carries singular delegation metadata', async () => {
    const signed = [];
    const service = new RouterRequestTokenService({
        jwsCodec: { signHmacJwt: async (input) => { signed.push(input); return 'rr.jwt'; } },
        resolveAgentSecret: async () => 'agent-secret',
        now: () => new Date('2026-06-11T00:00:00.000Z'),
        randomId: () => 'nonce-2',
    });
    await service.mint({
        targetAgentId: 'agent-a',
        sub: 'agent:repo/source',
        actor: { kind: 'agent', id: 'agent:repo/source', roles: [] },
        method: 'POST',
        path: '/mcp',
        tool: 'write',
        rch: 'mcp',
        ttlSeconds: 600,
        delegation: { sourceAgentId: 'agent:repo/source', tool: 'write' },
    });
    const payload = signed[0].payload;
    assert.equal(payload.exp - payload.iat, 30, 'ttl is clamped to max(5, min(ttl, 30)) like buildRouterRequest');
    assert.equal(payload.tool, 'write');
    assert.equal(payload.delegation.sourceAgentId, 'agent:repo/source');
    assert.equal(payload.delegation.tool, 'write');
});

test('normalizeActor passes a trimmed, capped displayName for user actors only and omits it when empty', () => {
    const user = { kind: 'user', id: 'user:USER.3', roles: ['user'] };
    assert.equal(normalizeActor({ ...user, displayName: '  alice  ' }).displayName, 'alice');
    assert.equal(normalizeActor({ ...user, displayName: 'n'.repeat(300) }).displayName, 'n'.repeat(128));
    for (const empty of [undefined, '', '   ', 42, null, {}]) {
        assert.equal('displayName' in normalizeActor({ ...user, displayName: empty }), false, String(empty));
    }
    assert.equal('displayName' in normalizeActor({ kind: 'guest', id: 'guest:x', roles: ['guest'], displayName: 'alice' }), false);
    assert.equal('displayName' in normalizeActor({ kind: 'agent', id: 'agent:a/b', roles: [], displayName: 'alice' }), false);
    assert.equal(JSON.stringify(normalizeActor(user)), '{"kind":"user","id":"user:USER.3","roles":["user"]}');
});

test('normalizeUserClaims carries displayName only when non-empty', () => {
    assert.equal(normalizeUserClaims({ id: 'u1', displayName: ' bob ' }).displayName, 'bob');
    assert.equal('displayName' in normalizeUserClaims({ id: 'u1', displayName: ' ' }), false);
    assert.equal('displayName' in normalizeUserClaims({ id: 'u1' }), false);
});

test('a minted direct user actor carries displayName and still has no usr claim', async () => {
    const signed = [];
    const service = new RouterRequestTokenService({
        jwsCodec: { signHmacJwt: async (input) => { signed.push(input); return 'rr.jwt'; } },
        resolveAgentSecret: async () => 'secret',
        now: () => new Date('2026-10-26T00:00:00.000Z'),
        randomId: () => 'nonce',
    });
    await service.mint({
        targetAgentId: 'agent-a', sub: 'user:USER.3',
        actor: { kind: 'user', id: 'user:USER.3', roles: ['user'], displayName: 'alice' },
        method: 'POST', path: '/mcp', rch: 'r',
    });
    assert.deepEqual(signed[0].payload.actor, { kind: 'user', id: 'user:USER.3', roles: ['user'], displayName: 'alice' });
    assert.equal('usr' in signed[0].payload, false);
});
