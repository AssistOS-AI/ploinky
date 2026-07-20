import test from 'node:test';
import assert from 'node:assert/strict';

import { NO_NODE_RUNTIME_KEY } from '../../cli/utils/dependencies/dependencyRuntimeKey.js';
import { resolveDependencyCachePreparation } from '../../cli/sandbox/docker/agentServiceManager.js';

test('node-less container agent without package.json skips dependency cache preparation', () => {
    const plan = resolveDependencyCachePreparation({
        needsCoreDeps: true,
        agentHasPackageJson: false,
        isLlmRuntime: false,
        runtimeKey: NO_NODE_RUNTIME_KEY,
    });

    assert.deepEqual(plan, {
        prepare: false,
        fatal: false,
        reason: 'no-node-image',
    });
});

test('node-less container agent with package.json fails instead of hiding missing node', () => {
    const plan = resolveDependencyCachePreparation({
        needsCoreDeps: true,
        agentHasPackageJson: true,
        isLlmRuntime: false,
        runtimeKey: NO_NODE_RUNTIME_KEY,
    });

    assert.equal(plan.prepare, false);
    assert.equal(plan.fatal, true);
    assert.match(plan.message, /package\.json/);
    assert.match(plan.message, /no node/i);
});
