import test from 'node:test';
import assert from 'node:assert/strict';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { RoutingRuntime } from '../../cli/server/generation/RoutingRuntime.js';
import { finalizePlanAfterAdmission } from '../../cli/server/proxy/RoutePlan.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('primary HTTP uses the generation-owned relay and primary service descriptor', () => {
    const generation = compileGeneration(generationInput());
    const runtime = Object.create(RoutingRuntime.prototype);
    runtime.store = new GenerationStore();
    runtime.store.activate(generation);
    const lease = runtime.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    const plan = runtime.resolvePrimary({
        lease,
        routeKey: 'alpha',
        method: 'POST',
        externalPath: '/alpha/mcp',
        targetPath: '/mcp',
        authority: '127.0.0.1:8080',
    });
    const finalized = finalizePlanAfterAdmission(plan);
    assert.equal(finalized.port, 7000);
    assert.equal(finalized.targetPath, '/mcp');
    assert.equal(finalized.relay, generation.routes.alpha.relay);
    assert.equal(finalized.generationDigest, generation.digest);
    assert.equal(Object.hasOwn(finalized.relay, ['host', 'Port'].join('')), false);
    lease.release();
});

test('custom-command routes without a primary descriptor remain convention-only', () => {
    const generation = compileGeneration(generationInput({ route: { primaryService: null } }));
    const runtime = Object.create(RoutingRuntime.prototype);
    runtime.store = new GenerationStore();
    runtime.store.activate(generation);
    const lease = runtime.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    assert.equal(runtime.resolvePrimary({
        lease,
        routeKey: 'alpha',
        method: 'GET',
        externalPath: '/alpha/',
        targetPath: '/',
        authority: '127.0.0.1:8080',
    }), null);
    lease.release();
});

test('primary route default access is compiled from captured agent auth policy', () => {
    const generation = compileGeneration(generationInput({ route: { auth: { mode: 'local', usersVar: 'USERS' } } }));
    const runtime = Object.create(RoutingRuntime.prototype);
    runtime.store = new GenerationStore();
    runtime.store.activate(generation);
    const lease = runtime.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    const plan = runtime.resolvePrimary({
        lease,
        routeKey: 'alpha',
        method: 'GET',
        externalPath: '/alpha/',
        targetPath: '/',
        authority: '127.0.0.1:8080',
    });
    assert.equal(plan.access.access, 'authenticated');
    assert.equal(plan.access.source, 'agent-primary-default');
    lease.release();
});
