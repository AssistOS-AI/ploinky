import assert from 'node:assert/strict';
import test from 'node:test';

import { __testables } from '../../cli/server/authHandlers/marketplaceRoutes.js';

test('Marketplace enable waits with the readiness protocol resolved from the manifest', async () => {
    const calls = [];

    await __testables.waitForMarketplaceAgentReadiness(
        { readiness: { protocol: 'tcp' } },
        { hostPort: 47891 },
        {
            agentRef: 'Agents/codexAgent',
            waitForReady: async (...args) => {
                calls.push(args);
                return true;
            },
        },
    );

    assert.deepEqual(calls, [[{ hostPort: 47891 }, { protocol: 'tcp' }]]);
});

test('Marketplace enable skips port readiness when the manifest protocol is none', async () => {
    let called = false;

    await __testables.waitForMarketplaceAgentReadiness(
        { readiness: { protocol: 'none' } },
        {},
        {
            agentRef: 'Agents/worker',
            waitForReady: async () => {
                called = true;
                return true;
            },
        },
    );

    assert.equal(called, false);
});

test('Marketplace enable fails when the agent does not become ready', async () => {
    await assert.rejects(
        __testables.waitForMarketplaceAgentReadiness(
            {},
            { hostPort: 47891 },
            {
                agentRef: 'Agents/codexAgent',
                waitForReady: async () => false,
            },
        ),
        /did not become ready after Marketplace enable/,
    );
});
