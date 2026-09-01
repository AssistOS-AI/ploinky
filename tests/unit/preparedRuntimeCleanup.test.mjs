import assert from 'node:assert/strict';
import test from 'node:test';

import {
    activatePreparedRuntimeAfterReadiness,
    cleanupFailedPreparedRuntime,
} from '../../cli/commands/workspaceUtil.js';

function preparedRuntime(mode = 'replacement') {
    return {
        requiresEdgeActivation: true,
        containerName: 'prepared-runtime',
        containerId: 'a'.repeat(64),
        hostPort: 45123,
        registryRecord: {
            type: 'agent',
            instanceId: 'candidate-instance',
            enableGeneration: 'candidate-enable-generation',
        },
        preparationLease: { mode, transactionId: 'prepared-runtime-lease' },
    };
}

test('additive activation atomically supplies final runtime locators without prewriting mutable sources', async () => {
    const result = preparedRuntime('additive');
    const applyLockCapability = Object.freeze({ fixture: 'apply-lock' });
    const networkLifecycleCapability = Object.freeze({ fixture: 'network-lock' });
    result.replacementPredecessor = {
        containerName: 'predecessor-runtime',
        containerId: 'b'.repeat(64),
        runtimeNetwork: { mode: 'default' },
        registryRecord: {
            type: 'agent',
            instanceId: 'predecessor-instance',
            enableGeneration: 'predecessor-enable-generation',
            containerId: 'b'.repeat(64),
        },
    };
    const calls = [];

    assert.equal(await activatePreparedRuntimeAfterReadiness({
        result,
        routeKey: 'demo',
        repoName: 'demo-repo',
        shortAgentName: 'demo',
        agentPath: '/workspace/demo',
        networkLifecycleCapability,
    }, {
        mergeRouting: () => assert.fail('additive activation must not prewrite mutable routing'),
        loadAgents: () => ({
            'predecessor-runtime': {
                type: 'agent',
                instanceId: 'predecessor-instance',
                enableGeneration: 'predecessor-enable-generation',
            },
        }),
        readRouting: () => ({ routes: { demo: { access: 'authenticated' } } }),
        mergeRoute: (current, patch, locator) => ({ ...current, ...patch, ...locator }),
        withApplyLock: (callback, options) => {
            assert.equal(options.preparationLease, result.preparationLease);
            calls.push('lock');
            return callback(applyLockCapability);
        },
        commitAdditive: (lease, options) => {
            assert.equal(lease, result.preparationLease);
            assert.equal(options.applyLockCapability, applyLockCapability);
            assert.equal(options.agents['predecessor-runtime'], undefined);
            assert.deepEqual(options.agents['prepared-runtime'], result.registryRecord);
            assert.deepEqual(options.routing.routes.demo, {
                access: 'authenticated',
                container: 'prepared-runtime',
                hostPath: '/workspace/demo',
                repo: 'demo-repo',
                agent: 'demo',
                hostPort: 45123,
            });
            calls.push('commit');
        },
        retirePredecessor: (predecessor, options) => {
            assert.equal(predecessor, result.replacementPredecessor);
            assert.equal(options.networkLifecycleCapability, networkLifecycleCapability);
            calls.push('retire');
        },
        reportRetirementFailure: () => assert.fail('exact predecessor retirement must succeed'),
    }), true);
    assert.deepEqual(calls, ['lock', 'commit', 'retire']);
});

test('activation failure delegates ownership of cleanup to the shared failure handler', async () => {
    const result = preparedRuntime();
    const activationError = new Error('selector changed');
    const calls = [];

    await assert.rejects(
        () => activatePreparedRuntimeAfterReadiness({
            result,
            routeKey: 'demo',
            repoName: 'demo-repo',
            shortAgentName: 'demo',
            agentPath: '/workspace/demo',
        }, {
            mergeRouting: async () => { throw activationError; },
            cleanupFailure(current, error, reason) {
                calls.push({ current, error, reason });
            },
        }),
        (error) => error === activationError,
    );

    assert.deepEqual(calls, [{
        current: result,
        error: activationError,
        reason: 'runtime-replacement-activation-failed',
    }]);
});

test('prepared runtime cleanup consumes one exact failure transaction only once', () => {
    const result = preparedRuntime();
    const failure = new Error('activation failed');
    const calls = [];
    const seams = {
        cleanupCandidate(current) {
            assert.equal(current, result);
            calls.push('cleanup');
        },
        inactivate(reason, options) {
            calls.push(`inactivate:${reason}:${options.preserveSelectedGeneration}`);
        },
        abortPreparation(lease, options) {
            assert.equal(lease, result.preparationLease);
            calls.push(`abort:${options.reason}`);
        },
    };

    cleanupFailedPreparedRuntime(result, failure, 'activation-failed', seams);
    cleanupFailedPreparedRuntime(result, failure, 'outer-catch', seams);

    assert.deepEqual(calls, [
        'cleanup',
        'inactivate:activation-failed:true',
        'abort:activation-failed',
    ]);
    assert.equal(failure.message, 'activation failed');
});

test('a cleanup error is reported once even when an outer catch retries cleanup', () => {
    const result = preparedRuntime();
    const failure = new Error('activation failed');
    const seams = {
        cleanupCandidate() { throw new Error('candidate cleanup refused'); },
        inactivate() {},
        abortPreparation() {},
    };

    cleanupFailedPreparedRuntime(result, failure, 'activation-failed', seams);
    cleanupFailedPreparedRuntime(result, failure, 'outer-catch', seams);

    assert.equal(
        failure.message,
        'activation failed; exact runtime-failure cleanup: candidate cleanup refused',
    );
});

test('a launch failure cleans the exact error candidate and aborts its preparation once', () => {
    const candidate = Object.freeze(preparedRuntime());
    const failure = new Error('managed semantic adoption failed');
    Object.defineProperty(failure, 'ploinkyRestartCandidate', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: candidate,
    });
    const calls = [];
    const seams = {
        cleanupCandidate(current) {
            assert.equal(current, candidate);
            calls.push('cleanup');
        },
        inactivate(reason, options) {
            calls.push(`inactivate:${reason}:${options.preserveSelectedGeneration}`);
        },
        abortPreparation(lease, options) {
            assert.equal(lease, candidate.preparationLease);
            calls.push(`abort:${options.reason}`);
        },
    };

    cleanupFailedPreparedRuntime(null, failure, 'cli-start-failed', seams);
    cleanupFailedPreparedRuntime(null, failure, 'outer-catch', seams);

    assert.deepEqual(calls, [
        'cleanup',
        'inactivate:cli-start-failed:true',
        'abort:cli-start-failed',
    ]);
    assert.equal(failure.message, 'managed semantic adoption failed');
});

test('an additive launch failure cleans and aborts exactly once without inactivating its predecessor', () => {
    const candidate = Object.freeze(preparedRuntime('additive'));
    const failure = new Error('candidate readiness failed');
    Object.defineProperty(failure, 'ploinkyRestartCandidate', {
        configurable: true,
        enumerable: false,
        writable: false,
        value: candidate,
    });
    const calls = [];
    const seams = {
        cleanupCandidate(current) {
            assert.equal(current, candidate);
            calls.push('cleanup');
        },
        inactivate() {
            assert.fail('additive failure must retain the active predecessor selector');
        },
        abortPreparation(lease, options) {
            assert.equal(lease, candidate.preparationLease);
            calls.push(`abort:${options.reason}`);
        },
    };

    cleanupFailedPreparedRuntime(null, failure, 'cli-start-failed', seams);
    cleanupFailedPreparedRuntime(candidate, failure, 'outer-catch', seams);

    assert.deepEqual(calls, ['cleanup', 'abort:cli-start-failed']);
    assert.equal(failure.message, 'candidate readiness failed');
});
