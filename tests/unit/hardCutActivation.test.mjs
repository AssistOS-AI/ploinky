import test from 'node:test';
import assert from 'node:assert/strict';

import { activateGeneration } from '../../cli/server/generation/activateGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('legacy endpoint state deactivates routing instead of installing a fallback', () => {
    const store = new GenerationStore();
    activateGeneration(store, generationInput());
    const input = generationInput();
    const routing = JSON.parse(input.routingBytes);
    routing.routes.alpha[['host', 'Port'].join('')] = 12345;
    assert.throws(() => activateGeneration(store, {
        ...input,
        routingBytes: Buffer.from(JSON.stringify(routing)),
    }), /forbidden legacy field/);
    assert.equal(store.active, null);
});

test('valid relay-only state activates exactly one frozen generation', () => {
    const store = new GenerationStore();
    const generation = activateGeneration(store, generationInput());
    assert.equal(store.active, generation);
    assert.equal(Object.isFrozen(generation), true);
    assert.equal(Object.isFrozen(generation.routes.alpha.relay), true);
    assert.equal(store.leases.size, 0);
});
