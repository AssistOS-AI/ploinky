import test from 'node:test';
import assert from 'node:assert/strict';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('uncommitted authorization-to-dial leases fail after generation replacement', () => {
    const store = new GenerationStore();
    store.activate(compileGeneration(generationInput()));
    const stale = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    store.activate(compileGeneration(generationInput({ policy: {
        entries: [{ path: '/alpha/private', access: 'authenticated' }],
    } })));
    assert.equal(stale.invalidated, true);
    assert.equal(stale.commit(), false);
    stale.release();
});
test('a lease commits once immediately before target use', () => {
    const store = new GenerationStore();
    store.activate(compileGeneration(generationInput()));
    const lease = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    assert.equal(lease.commit(), true);
    assert.equal(lease.commit(), false);
    store.deactivate();
    assert.equal(lease.invalidated, false);
    lease.release();
});
