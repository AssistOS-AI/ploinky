import test from 'node:test';
import assert from 'node:assert/strict';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { generationInput, routingState } from './routingProxyTestFixtures.mjs';

test('generation compilation captures exact bytes and immutable relay identity', () => {
    const firstInput = generationInput();
    const first = compileGeneration(firstInput);
    const second = compileGeneration({
        ...firstInput,
        routingBytes: Buffer.from(`${firstInput.routingBytes.toString('utf8')} `),
    });
    assert.notEqual(first.digest, second.digest);
    assert.equal(first.routes.alpha.relay.containerId.length, 64);
    assert.equal(Object.isFrozen(first.routes.alpha), true);
    assert.equal(Object.isFrozen(first.routes.alpha.relay), true);
    assert.deepEqual(first.routes.alpha.deniedPorts, [22, 8081]);
    const authorityState = routingState();
    delete authorityState.surfaces;
    const authorityInput = {
        routingBytes: Buffer.from(JSON.stringify(authorityState)),
        policyBytes: Buffer.from('{"entries":[]}'),
        privateAuthority: '127.0.0.1:8081',
    };
    assert.notEqual(
        compileGeneration({ ...authorityInput, publicAuthority: 'router-one.example:8080' }).digest,
        compileGeneration({ ...authorityInput, publicAuthority: 'router-two.example:8080' }).digest,
    );
});
test('generation compilation rejects legacy targets, ambiguous surfaces, and incomplete identities', () => {
    const forbiddenHostTarget = ['host', 'Port'].join('');
    const state = routingState();
    state.routes.alpha[forbiddenHostTarget] = 49152;
    assert.throws(() => compileGeneration({
        ...generationInput(),
        routingBytes: Buffer.from(JSON.stringify(state)),
    }), /forbidden legacy field/);
    assert.throws(() => compileGeneration(generationInput({
        routing: { surfaces: { public: { authority: 'same' }, private: { authority: 'same' } } },
    })), /ambiguous/);
    assert.throws(() => compileGeneration(generationInput({
        route: { effectiveInstanceId: '' },
    })), /incomplete or inconsistent identity/);
    assert.throws(() => compileGeneration(generationInput({
        route: { relay: { ...routingState().routes.alpha.relay, targetAgentId: 'agent:other/agent' } },
    })), /relay principal/);
    assert.throws(() => compileGeneration(generationInput({
        routing: { privateCallerAcls: { alpha: ['*'] } },
    })), /requires exact entries/);
    assert.throws(() => compileGeneration(generationInput({
        routing: { privateCallerAcls: { alpha: [{
            callerAgentId: 'agent:test/alpha', port: 7000, method: '*', path: '/alpha/control',
        }] } },
    })), /invalid method or port/);
    assert.throws(() => compileGeneration(generationInput({
        routing: { privateCallerAcls: { alpha: [{
            callerAgentId: 'agent:test/alpha', port: 22, method: 'POST', path: '/alpha/control',
        }] } },
    })), /denied port/);
});

test('generation compilation rejects reserved owners and invalid trusted limits', () => {
    const state = routingState();
    state.routes['base-agent-additional-server'] = state.routes.alpha;
    delete state.routes.alpha;
    assert.throws(() => compileGeneration({
        ...generationInput(),
        routingBytes: Buffer.from(JSON.stringify(state)),
    }), /reserved/);
    assert.throws(() => compileGeneration(generationInput({
        route: { limits: { requestHeaderBytes: -1 } },
    })), /positive safe integer/);
    assert.throws(() => compileGeneration(generationInput({
        policy: { entries: [{ path: '/alpha/../admin', access: 'public' }] },
    })), /invalid policy entry/);
    assert.throws(() => compileGeneration(generationInput({
        policy: { entries: [{ path: '/alpha/data', access: 'unknown' }] },
    })), /invalid policy entry/);
});
