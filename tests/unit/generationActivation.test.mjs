import test from 'node:test';
import assert from 'node:assert/strict';

import { activateGeneration } from '../../cli/server/generation/activateGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('generation activation is atomic and invalid candidates leave no active selectors', () => {
    const store = new GenerationStore();
    const active = activateGeneration(store, generationInput());
    assert.equal(store.active, active);
    assert.throws(() => activateGeneration(store, {
        ...generationInput(),
        routingBytes: Buffer.from('{broken'),
    }), /invalid routing/);
    assert.equal(store.active, null);
});
test('generation acquisition binds exact listener class and authority', () => {
    const store = new GenerationStore();
    activateGeneration(store, generationInput());
    const lease = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    assert.equal(lease.generation, store.active);
    assert.throws(
        () => store.acquire({ listenerClass: 'private', authority: '0.0.0.0:8081' }),
        /inactive listener authority/,
    );
    lease.release();
});

test('activating identical content preserves the active object and its uncommitted leases', () => {
    const store = new GenerationStore();
    const active = activateGeneration(store, generationInput());
    const lease = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    assert.equal(activateGeneration(store, generationInput()), active);
    assert.equal(lease.invalidated, false);
    assert.equal(lease.commit(), true);
    lease.release();
});
