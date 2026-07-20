import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { GenerationStore } from '../../cli/server/generation/GenerationStore.js';
import { RoutingRuntime } from '../../cli/server/generation/RoutingRuntime.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

test('a captured lease resolves only its immutable generation after activation changes', () => {
    const first = compileGeneration(generationInput());
    const second = compileGeneration(generationInput({ route: { effectiveInstanceId: 'alpha-instance-2', enableGeneration: 'alpha-enable-2', relay: {
        ...JSON.parse(generationInput().routingBytes).routes.alpha.relay,
        effectiveInstanceId: 'alpha-instance-2',
    } } }));
    const runtime = Object.create(RoutingRuntime.prototype);
    runtime.store = new GenerationStore();
    runtime.store.activate(first);
    const staleLease = runtime.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    runtime.store.activate(second);
    const currentLease = runtime.acquire({ listenerClass: 'public', authority: '127.0.0.1:8080' });
    assert.equal(staleLease.generation.digest, first.digest);
    assert.equal(currentLease.generation.digest, second.digest);
    assert.equal(staleLease.commit(), false);
    assert.equal(currentLease.commit(), true);
    staleLease.release();
    currentLease.release();
});

test('request-time Router modules do not reload mutable routing files', () => {
    for (const relative of [
        '../../cli/server/RoutingServer.js',
        '../../cli/server/httpServiceRoutes.js',
        '../../cli/server/authHandlers/authContext.js',
        '../../cli/server/agentOpenAiDelegation.js',
        '../../cli/server/openAiAgentDiscovery.js',
        '../../cli/server/mcp-proxy/mcpDelegations.js',
        '../../cli/server/policy/HttpRouteProviders.js',
        '../../cli/server/policy/McpToolPolicy.js',
    ]) {
        const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /loadRoutingConfig\s*\(|readRouting\s*\(|from ['"]node:fs['"]|readEnabledAgents\s*\(|getEnabledAgents\s*\(/);
    }
});
