import test from 'node:test';
import assert from 'node:assert/strict';

import { mintMachineCallAssertion } from '../../Agent/lib/machineCallAssertion.mjs';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { MachineCallAssertionService } from '../../cli/server/security/tokens/MachineCallAssertionService.js';
import { AGENT_SECRET, generationInput } from './routingProxyTestFixtures.mjs';

async function fixture() {
    const store = new GenerationStore();
    const generation = compileGeneration(generationInput());
    store.activate(generation);
    const service = new MachineCallAssertionService({
        resolveAgentSecret: () => AGENT_SECRET,
        generationStore: store,
    });
    const bodyHash = sha256RawBodyHash(Buffer.from('payload'));
    const token = await mintMachineCallAssertion({
        callerAgentId: 'agent:test/alpha',
        callerEnableGeneration: 'alpha-enable-1',
        targetAgentId: 'agent:test/alpha',
        port: 7000,
        method: 'POST',
        path: '/alpha/control',
        bodyHash,
        generationDigest: generation.digest,
    }, { secret: AGENT_SECRET });
    return { store, service, token, bodyHash };
}

test('private machine assertion binds caller, enable generation, target, request, and active generation', async () => {
    const { service, token, bodyHash } = await fixture();
    const request = {
        targetRouteKey: 'alpha',
        port: 7000,
        method: 'POST',
        path: '/alpha/control',
        bodyHash,
    };
    const result = service.verify(token, request);
    assert.equal(result.payload.iss, 'agent:test/alpha');
    await assert.rejects(async () => {
        const next = await fixture();
        next.service.verify(next.token, { ...request, method: 'GET' });
    }, /ACL denied/);
    await assert.rejects(async () => {
        const next = await fixture();
        next.service.verify(next.token, { ...request, port: 7001 });
    }, /ACL denied/);
});

test('private machine assertions are replay protected and invalidated by generation replacement', async () => {
    const { store, service, token, bodyHash } = await fixture();
    const request = {
        targetRouteKey: 'alpha', port: 7000, method: 'POST', path: '/alpha/control', bodyHash,
    };
    service.verify(token, request);
    assert.throws(() => service.verify(token, request), /consumed|replay/i);

    const next = await fixture();
    const oldToken = next.token;
    next.store.activate(compileGeneration(generationInput({ policy: {
        entries: [{ path: '/alpha/*', access: 'authenticated' }],
    } })));
    assert.throws(() => next.service.verify(oldToken, request), /generationDigest mismatch/);
    store.deactivate();
});

test('private caller ACL denies before assertion trust', async () => {
    const { store, service, token, bodyHash } = await fixture();
    const generation = compileGeneration(generationInput({
        routing: { privateCallerAcls: { alpha: [] } },
    }));
    store.activate(generation);
    assert.throws(() => service.verify(token, {
        targetRouteKey: 'alpha',
        port: 7000,
        method: 'POST',
        path: '/alpha/control',
        bodyHash,
    }), /ACL denied/);
});
