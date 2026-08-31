import assert from 'node:assert/strict';
import test from 'node:test';

import {
    activatePreparedRuntimeAfterReadiness,
    cleanupFailedPreparedRuntime,
} from '../../cli/commands/workspaceUtil.js';

function preparedRuntime() {
    return {
        requiresEdgeActivation: true,
        containerName: 'prepared-runtime',
        containerId: 'a'.repeat(64),
        registryRecord: { type: 'agent' },
        preparationLease: { transactionId: 'prepared-runtime-lease' },
    };
}

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
