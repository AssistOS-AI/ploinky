import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { signHmacJwt } from '../../Agent/lib/jwtSign.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import {
    mintUserDelegationGrant,
    verifyUserDelegationGrant,
} from '../../cli/server/mcp-proxy/userDelegationGrant.js';

const SIGNING_SECRET = crypto.randomBytes(32);
const SOURCE_AGENT = 'agent:AssistOSExplorer/onlyOffice';
const TARGET_AGENT = 'agent:AssistOSExplorer/dpuAgent';
const TOOL = 'dpu_confidential_get';
const USER = {
    id: 'local:alice',
    username: 'alice',
    roles: ['user'],
};
const SERVICE = {
    routeKey: 'onlyOffice',
    externalPrefix: '/services/onlyoffice/',
    internalPrefix: '/control/',
    internalPath: '/control/office/session',
};

function mint(overrides = {}) {
    const { now = new Date(), ...rest } = overrides;
    return mintUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        now,
        ttlSeconds: 1800,
        sourceAgentId: SOURCE_AGENT,
        service: SERVICE,
        user: USER,
        targetAgentId: TARGET_AGENT,
        tools: [TOOL, 'dpu_confidential_update'],
        scopes: ['dpu:confidential:read', 'dpu:confidential:write'],
        ...rest,
    });
}

test('mintUserDelegationGrant signs a source-bound router-audience grant', () => {
    const { token, payload } = mint();

    assert.equal(typeof token, 'string');
    assert.equal(payload.typ, 'user-delegation');
    assert.equal(payload.iss, 'ploinky-router');
    assert.equal(payload.aud, 'ploinky-router');
    assert.equal(payload.sourceAgentId, SOURCE_AGENT);
    assert.deepEqual(payload.allowedTargets, [TARGET_AGENT]);
    assert.deepEqual(payload.allowedTools, [TOOL, 'dpu_confidential_update']);
    assert.equal(payload.sub, 'user:local:alice');
    assert.deepEqual(payload.usr, {
        id: 'local:alice',
        username: 'alice',
        email: '',
        roles: ['user'],
    });
    assert.ok(payload.jti);
});

test('verifyUserDelegationGrant rejects wrong typ, issuer, and audience', () => {
    const { token } = mint();
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const wrongTyp = signHmacJwt({
        payload: { ...claims, typ: 'router-request', jti: 'wrong-typ' },
        secret: SIGNING_SECRET,
    });
    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token: wrongTyp,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation typ mismatch/);

    const wrongIssuer = signHmacJwt({
        payload: { ...claims, iss: 'not-router', jti: 'wrong-iss' },
        secret: SIGNING_SECRET,
    });
    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token: wrongIssuer,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation audience mismatch/);

    const wrongAudience = signHmacJwt({
        payload: { ...claims, aud: 'not-router', jti: 'wrong-aud' },
        secret: SIGNING_SECRET,
    });
    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token: wrongAudience,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation audience mismatch/);
});

test('verifyUserDelegationGrant rejects expired grants', () => {
    const { token } = mint({ now: new Date(Date.now() - 120_000), ttlSeconds: 30 });
    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation expired/);
});

test('verifyUserDelegationGrant rejects source, target, and tool mismatches', () => {
    const { token } = mint();

    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token,
        expectedSourceAgentId: 'agent:AssistOSExplorer/notOnlyOffice',
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation source mismatch/);

    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: 'agent:AssistOSExplorer/notDpu',
        expectedTool: TOOL,
    }), /delegation target mismatch/);

    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: 'dpu_secret_get',
    }), /delegation tool not allowed/);
});

test('verifyUserDelegationGrant rejects guests and missing usr claims', () => {
    const { token } = mint();
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

    const guestUsr = signHmacJwt({
        payload: {
            ...claims,
            jti: 'guest-usr',
            usr: { id: 'guest:anon', username: 'anon', roles: ['guest'] },
        },
        secret: SIGNING_SECRET,
    });
    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token: guestUsr,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation user missing/);

    const guestActor = signHmacJwt({
        payload: {
            ...claims,
            jti: 'guest-actor',
            actor: { kind: 'guest', id: 'guest:anon', roles: ['guest'] },
        },
        secret: SIGNING_SECRET,
    });
    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token: guestActor,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation user missing/);

    const missingUsr = signHmacJwt({
        payload: {
            ...claims,
            jti: 'missing-usr',
            usr: null,
        },
        secret: SIGNING_SECRET,
    });
    assert.throws(() => verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token: missingUsr,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
    }), /delegation user missing/);
});

test('verifyUserDelegationGrant returns normalized claims and delegation metadata', () => {
    const { token } = mint();
    const verified = verifyUserDelegationGrant({
        signingSecret: SIGNING_SECRET,
        token,
        expectedSourceAgentId: SOURCE_AGENT,
        expectedTargetAgentId: TARGET_AGENT,
        expectedTool: TOOL,
        replayCache: createMemoryReplayCache(),
    });

    assert.equal(verified.user.id, 'local:alice');
    assert.equal(verified.delegation.sourceAgentId, SOURCE_AGENT);
    assert.equal(verified.delegation.targetAgentId, TARGET_AGENT);
    assert.equal(verified.delegation.tool, TOOL);
    assert.deepEqual(verified.delegation.scope, ['dpu:confidential:read', 'dpu:confidential:write']);
});
