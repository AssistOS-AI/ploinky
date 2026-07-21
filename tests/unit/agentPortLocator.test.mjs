import test from 'node:test';
import assert from 'node:assert/strict';

import { getAgentPortLocatorAccess, locateAgentPort } from '../../cli/server/agentPortConvention/locator.js';
import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('locator returns one authenticated, no-store, generation-bound public URL', () => {
    const generation = compileGeneration(generationInput());
    const result = locateAgentPort({ generation, routeKey: 'alpha', port: 7001, authenticated: true });
    assert.equal(result.url, 'http://127.0.0.1:8080/base-agent-additional-server/alpha/7001/');
    assert.equal(result.generationDigest, generation.digest);
    assert.equal(result.cacheControl, 'no-store');
    assert.equal(JSON.stringify(result).includes('container'), false);
    assert.equal(JSON.stringify(result).includes('8081'), false);
});
test('locator authentication is bound to the selected route without inheriting its auth mode', () => {
    assert.deepEqual(getAgentPortLocatorAccess('liveKitServerAgent'), {
        access: 'authenticated',
        routeKey: 'liveKitServerAgent',
        source: 'agent-port-locator',
    });
    assert.throws(() => getAgentPortLocatorAccess(''), /route key required/);
});
test('locator fails closed for unauthenticated, inactive, missing, and denied selections', () => {
    const generation = compileGeneration(generationInput());
    assert.throws(() => locateAgentPort({ generation, routeKey: 'alpha', port: 7001 }), /authenticated/);
    assert.throws(() => locateAgentPort({ generation: null, routeKey: 'alpha', port: 7001, authenticated: true }), /active/);
    assert.throws(() => locateAgentPort({ generation, routeKey: 'missing', port: 7001, authenticated: true }), /inactive/);
    assert.throws(() => locateAgentPort({ generation, routeKey: 'alpha', port: 8081, authenticated: true }), /invalid port/);
});
