import test from 'node:test';
import assert from 'node:assert/strict';

import { waitForAgentReady } from '../../cli/server/utils/agentReadiness.js';
import { buildBlockingReadinessEntryFromNode } from '../../cli/commands/workspaceUtil.js';
import { compileGeneration } from '../../cli/server/generation/compileGeneration.js';
import { generationInput } from './routingProxyTestFixtures.mjs';

function route() {
    return compileGeneration(generationInput()).routes.alpha;
}

test('waitForAgentReady probes only a confined primary service', async () => {
    let observed;
    const ready = await waitForAgentReady(route(), {
        protocol: 'mcp',
        timeoutMs: 100,
        probe: async (selectedRoute, protocol) => {
            observed = { selectedRoute, protocol };
            return true;
        },
    });
    assert.equal(ready, true);
    assert.equal(observed.selectedRoute.relay.kind, 'container-exec-stdio');
    assert.equal(observed.selectedRoute.primaryService.port, 7000);
    assert.equal(observed.protocol, 'mcp');
});
test('waitForAgentReady is bounded and returns false when relay probes fail', async () => {
    let attempts = 0;
    const startedAt = Date.now();
    const ready = await waitForAgentReady(route(), {
        protocol: 'tcp',
        timeoutMs: 60,
        intervalMs: 10,
        probe: async () => {
            attempts += 1;
            throw new Error('relay unavailable');
        },
    });
    assert.equal(ready, false);
    assert.ok(attempts >= 2);
    assert.ok(Date.now() - startedAt < 1000);
});

test('waitForAgentReady rejects routes without a relay primary descriptor', async () => {
    assert.equal(await waitForAgentReady({ primaryService: { port: 7000 } }), false);
    assert.equal(await waitForAgentReady({ relay: route().relay }), false);
});

test('blocking startup readiness allows protocol none without a primary relay', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'worker',
        shortAgentName: 'worker',
        manifest: { readiness: { protocol: 'none' } },
    }, {}, 'explorer');
    assert.equal(entry.protocol, 'none');
});

test('blocking startup readiness requires a confined primary service', () => {
    assert.throws(() => buildBlockingReadinessEntryFromNode({
        id: 'api',
        shortAgentName: 'api',
        manifest: { readiness: { protocol: 'tcp' } },
    }, {}, 'explorer'), /no confined primary service/);
});
