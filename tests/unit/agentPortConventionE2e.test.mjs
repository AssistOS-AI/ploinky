import test from 'node:test';
import assert from 'node:assert/strict';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { evaluateGenerationAccess } from '../../cli/server/generation/evaluateGenerationAccess.js';
import { resolveConvention, rewriteConventionAfterAdmission } from '../../cli/server/agentPortConvention/resolveConvention.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('hard-cut convention captures selection, policy, rewrite, generation, and lease', () => {
    const generation = compileGeneration(generationInput());
    const store = new GenerationStore();
    store.activate(generation);
    const lease = store.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    const selected = resolveConvention({
        requestTarget: '/base-agent-additional-server/alpha/7000/ui/index.html?mode=full',
        method: 'GET',
        authority: '127.0.0.1:8080',
        generation: lease.generation,
        evaluateAccess: input => evaluateGenerationAccess({ generation: lease.generation, ...input }),
    });
    const plan = rewriteConventionAfterAdmission(selected);
    assert.equal(plan.routeKey, 'alpha');
    assert.equal(plan.port, 7000);
    assert.equal(plan.targetPath, '/ui/index.html');
    assert.equal(plan.query, 'mode=full');
    assert.equal(plan.access.access, 'authenticated');
    assert.equal(plan.generationDigest, generation.digest);
    assert.equal(lease.commit(), true);
    lease.release();
});
