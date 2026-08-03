import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanupExactAgentRuntimeCandidate } from '../../cli/sandbox/docker/agentServiceManager.js';
import {
    assertCandidateLifecycleTransition,
    isCandidateCleanupReceiptDocument,
} from '../../cli/sandbox/runtimeCleanupReceipt.js';

const contractHash = `sha256:${'a'.repeat(64)}`;
const base = Object.freeze({
    version: 1,
    scope: 'candidate',
    operationId: '11111111-1111-4111-8111-111111111111',
    runtimeKind: 'container',
    candidateName: 'candidate-one',
    contractHash,
    runtimeIdentity: Object.freeze({
        instanceId: 'instance-one',
        enableGeneration: 'enable-one',
    }),
    phase: 'resolve',
    creationAttempted: false,
    state: 'not-created-proven',
    inspectionComplete: false,
    ownershipProof: Object.freeze({}),
});

test('cleanup lifecycle validator permits the exact forward create transition', () => {
    const attempted = Object.freeze({
        ...base,
        phase: 'create-attempted',
        creationAttempted: true,
        state: 'preserved-ambiguous',
    });
    assert.equal(isCandidateCleanupReceiptDocument(base), true);
    assert.equal(assertCandidateLifecycleTransition(base, attempted), attempted);
});

test('cleanup lifecycle validator rejects jumps, backwards transitions, and identity changes', () => {
    const backwards = Object.freeze({
        ...base,
        phase: 'predecessor-removed',
    });
    assert.throws(
        () => assertCandidateLifecycleTransition(base, backwards),
        { code: 'PLOINKY_RUNTIME_CLEANUP_RECEIPT_INVALID' },
    );
    const changedIdentity = Object.freeze({
        ...base,
        phase: 'pre-create',
        runtimeIdentity: Object.freeze({
            instanceId: 'instance-two',
            enableGeneration: 'enable-one',
        }),
    });
    assert.throws(
        () => assertCandidateLifecycleTransition(base, changedIdentity),
        { code: 'PLOINKY_RUNTIME_CLEANUP_RECEIPT_INVALID' },
    );
});

test('a deserialized or field-identical receipt cannot authorize cross-generation cleanup', () => {
    const lookalike = JSON.parse(JSON.stringify({
        ...base,
        runtimeKind: 'bwrap',
        phase: 'candidate-observed',
        creationAttempted: true,
        state: 'retryable-exact-id',
        candidateId: 'instance-one:enable-one',
        inspectionComplete: true,
        ownershipProof: { processIdentity: true },
    }));
    assert.throws(
        () => cleanupExactAgentRuntimeCandidate({
            containerName: 'candidate-one',
            registryRecord: {
                type: 'agent',
                runtime: 'bwrap',
                instanceId: 'instance-two',
                enableGeneration: 'enable-two',
            },
            cleanupReceipt: lookalike,
        }),
        { code: 'PLOINKY_RUNTIME_CLEANUP_RECEIPT_INVALID' },
    );
});
