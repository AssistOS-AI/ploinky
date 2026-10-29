import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { verifyRouterRequestToken } from '../../Agent/lib/requestSignedTokens.mjs';
import {
    TASK_REFERENCE_ORIGIN_METHOD,
    TASK_REFERENCE_ORIGIN_PATH,
    TASK_REFERENCE_ORIGIN_TOOL,
    buildTaskReferenceOriginForToolCall,
    canonicalOriginCallerKey,
    mintTaskReferenceOriginToken,
    taskReferenceOriginBinding,
} from '../../cli/server/executionProvider/originToken.mjs';
import { deriveAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { domainFixture } from './directDomainFixtures.mjs';

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

// Fictional provider `explorer` (declares task references) and tool agent `unrelated`.
const PROVIDER = 'agent:fixtures/explorer';
const ORIGIN_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_ORIGIN_ID = 'BBBBBBBBBBBBBBBBBBBBBB';

function verifyOrigin(token, binding) {
    return verifyRouterRequestToken(token, {
        secret: deriveAgentRequestSecret(PROVIDER, { encoding: 'buffer' }),
        expectedAudience: PROVIDER,
        method: TASK_REFERENCE_ORIGIN_METHOD,
        path: TASK_REFERENCE_ORIGIN_PATH,
        tool: TASK_REFERENCE_ORIGIN_TOOL,
        rch: taskReferenceOriginBinding(binding).rch,
        replayCache: createMemoryReplayCache(),
    }).payload;
}

test('the canonical caller key names only the verified direct caller', () => {
    assert.equal(canonicalOriginCallerKey({ user: { id: 'u1', roles: ['user'] } }), 'user:u1');
    assert.equal(canonicalOriginCallerKey({ user: { id: 'user:u1', roles: ['user'] } }), 'user:u1', 'no duplicated user: prefix');
    assert.equal(canonicalOriginCallerKey({ user: { id: 'guest:g', roles: ['guest'] } }), '');
    assert.equal(canonicalOriginCallerKey({ user: { id: 'g2', roles: ['Guest'] } }), '');
    assert.equal(canonicalOriginCallerKey({}), '');
    // A verified agent caller is keyed by its principal; a carried delegation never enters the key.
    const agentReq = {
        user: { id: 'u1', roles: ['user'] },
        delegatedAgentVerified: { callerPrincipal: 'agent:fixtures/unrelated', userDelegation: { user: { id: 'u1' } } },
    };
    assert.equal(canonicalOriginCallerKey(agentReq), 'agent:fixtures/unrelated');
    assert.equal(canonicalOriginCallerKey({ delegatedAgentVerified: { callerPrincipal: 'not-a-principal' } }), '');
});

test('the origin token is minted for the provider and bound to {originKey, originRequestId, agent, tool}', () => {
    const binding = { originKey: 'user:u1', originRequestId: ORIGIN_ID, agent: 'agent:fixtures/unrelated', tool: 'start_job' };
    const { token } = mintTaskReferenceOriginToken({ providerPrincipal: PROVIDER, ...binding });
    const payload = verifyOrigin(token, binding);
    assert.equal(payload.typ, 'router-request');
    assert.equal(payload.aud, PROVIDER);
    assert.equal(payload.tool, TASK_REFERENCE_ORIGIN_TOOL);
    assert.equal(payload.exp - payload.iat, 30);
    assert.deepEqual(payload.origin, binding);
    assert.ok(payload.jti, 'a jti the provider consumes');
    // Each bound value participates in rch: changing any one fails verification.
    for (const [key, value] of [['originKey', 'user:u2'], ['originRequestId', OTHER_ORIGIN_ID], ['agent', 'agent:fixtures/mailer'], ['tool', 'other_tool']]) {
        assert.throws(() => verifyOrigin(token, { ...binding, [key]: value }), /request hash mismatch/, key);
    }
    // Another provider cannot verify it.
    assert.throws(() => verifyRouterRequestToken(token, {
        secret: deriveAgentRequestSecret('agent:fixtures/bizanso', { encoding: 'buffer' }), expectedAudience: 'agent:fixtures/bizanso',
    }));
    assert.throws(() => mintTaskReferenceOriginToken({ providerPrincipal: PROVIDER, ...binding, originRequestId: 'short' }), /22 base64url/);
    assert.throws(() => mintTaskReferenceOriginToken({ providerPrincipal: PROVIDER, ...binding, originKey: '' }), /caller key/);
});

test('a forwarded tool call gets an origin token only for an enabled declared provider, a valid originRequestId and a nameable caller', (t) => {
    const world = domainFixture(t, { mode: 'dual' });
    const file = path.join(world.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.executionProvider = { version: 1, port: 7300, taskReferences: { path: '/explorer/task-refs' } };
    fs.writeFileSync(file, JSON.stringify(manifest));
    world.apply();
    const snapshot = world.active().generation;
    const req = { user: { id: 'u1', roles: ['user'] } };
    const listing = (provider) => ({ name: 'start_job', annotations: { ploinkyTaskReference: { version: 1, provider } } });
    const call = (overrides = {}) => buildTaskReferenceOriginForToolCall({
        req, agentName: 'unrelated', toolName: 'start_job', toolArgs: { originRequestId: ORIGIN_ID },
        toolListing: listing('explorer'), snapshot, ...overrides,
    });
    const token = call();
    assert.ok(token, 'positive control');
    // The bound agent is the serving agent's principal, not its route key.
    assert.equal(verifyOrigin(token, { originKey: 'user:u1', originRequestId: ORIGIN_ID, agent: 'agent:fixtures/unrelated', tool: 'start_job' }).origin.agent, 'agent:fixtures/unrelated');
    assert.throws(() => verifyOrigin(token, { originKey: 'user:u1', originRequestId: ORIGIN_ID, agent: 'unrelated', tool: 'start_job' }), /request hash mismatch/);
    assert.equal(call({ agentName: 'missing-agent' }), null, 'an unknown serving agent');
    assert.equal(call({ toolListing: { name: 'start_job' } }), null, 'not a task-reference tool');
    assert.equal(call({ toolListing: listing('mailer') }), null, 'an undeclared provider');
    assert.equal(call({ toolListing: listing('missing') }), null, 'an unknown provider');
    assert.equal(call({ toolListing: { name: 'start_job', annotations: { ploinkyTaskReference: { version: 2, provider: 'explorer' } } } }), null);
    assert.equal(call({ toolArgs: { originRequestId: 'not-valid' } }), null, 'an invalid originRequestId');
    assert.equal(call({ toolArgs: {} }), null);
    assert.equal(call({ req: { user: { id: 'guest:g', roles: ['guest'] } } }), null, 'no nameable caller');
});
