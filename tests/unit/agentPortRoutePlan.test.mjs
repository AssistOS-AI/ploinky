import test from 'node:test';
import assert from 'node:assert/strict';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { evaluateGenerationAccess } from '../../cli/server/generation/evaluateGenerationAccess.js';
import {
    resolveConvention,
    rewriteConventionAfterAdmission,
} from '../../cli/server/agentPortConvention/resolveConvention.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('one immutable plan owns HTTP, SSE, and WebSocket convention selection', () => {
    const generation = compileGeneration(generationInput());
    for (const transport of ['http', 'sse', 'websocket']) {
        const plan = resolveConvention({
            requestTarget: '/base-agent-additional-server/alpha/7001/api/ws?tail=1',
            method: 'GET',
            authority: '127.0.0.1:8080',
            listenerClass: 'public',
            generation,
            transport,
            evaluateAccess: input => evaluateGenerationAccess({ generation, ...input }),
            auditId: `audit-${transport}`,
        });
        assert.equal(plan.routeKey, 'alpha');
        assert.equal(plan.port, 7001);
        assert.equal(plan.unmatchedSuffix, '/api/ws');
        assert.equal(plan.query, 'tail=1');
        assert.equal(plan.access.access, 'authenticated');
        assert.equal(plan.transport, transport);
        assert.equal(Object.isFrozen(plan), true);
        assert.equal(rewriteConventionAfterAdmission(plan).targetPath, '/api/ws');
    }
});
test('route planning rejects authority, owner, deny-set, and relay failures before target use', () => {
    const generation = compileGeneration(generationInput());
    const input = {
        requestTarget: '/base-agent-additional-server/alpha/7000/',
        authority: '127.0.0.1:8080',
        generation,
        evaluateAccess: value => evaluateGenerationAccess({ generation, ...value }),
    };
    assert.throws(() => resolveConvention({ ...input, authority: 'attacker.example' }), /authority/);
    assert.throws(() => resolveConvention({ ...input, requestTarget: '/base-agent-additional-server/missing/7000/' }), /owner/);
    assert.throws(() => resolveConvention({ ...input, requestTarget: '/base-agent-additional-server/alpha/8081/' }), /runtime-reserved/);
});
