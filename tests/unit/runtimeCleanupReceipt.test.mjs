import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanupExactAgentRuntimeCandidate } from '../../cli/sandbox/docker/agentServiceManager.js';
import {
    assertCandidateLifecycleTransition,
    classifyManagedFailureRecovery,
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

test('managed failure recovery classification authorizes cleanup only for a created exact candidate', () => {
    const adopted = classifyManagedFailureRecovery({
        candidateCreationAttempted: false,
        candidateInspectionComplete: true,
        candidatePresent: true,
        candidateOwned: true,
        candidateId: 'predecessor-id',
    });
    assert.deepEqual(adopted, {
        phase: 'candidate-observed',
        state: 'not-created-proven',
        candidateId: '',
        inspectionComplete: true,
        ownershipProof: { adoptedExistingRuntime: true },
    });

    const created = classifyManagedFailureRecovery({
        candidateCreationAttempted: true,
        candidateInspectionComplete: true,
        candidatePresent: true,
        candidateOwned: true,
        candidateId: 'created-id',
    });
    assert.deepEqual(created, {
        phase: 'candidate-observed',
        state: 'retryable-exact-id',
        candidateId: 'created-id',
        inspectionComplete: true,
        ownershipProof: { immutableId: true },
    });
    assert.equal(Object.isFrozen(created), true);
    assert.equal(Object.isFrozen(created.ownershipProof), true);

    assert.deepEqual(classifyManagedFailureRecovery({
        exactCleanupPerformed: true,
        candidateCreationAttempted: true,
        candidateInspectionComplete: true,
        candidatePresent: true,
        candidateOwned: true,
        candidateId: 'removed-created-id',
    }), {
        phase: 'readiness',
        state: 'removed-proven',
        candidateId: '',
        inspectionComplete: true,
        ownershipProof: { exactAbsenceProven: true },
    });
});

test('managed failure recovery distinguishes proven absence and preserves malformed evidence', () => {
    assert.deepEqual(classifyManagedFailureRecovery({
        candidateCreationAttempted: false,
        candidateInspectionComplete: true,
        candidatePresent: false,
        candidateOwned: false,
        candidateId: '',
    }), {
        phase: 'readiness',
        state: 'absent-proven',
        candidateId: '',
        inspectionComplete: true,
        ownershipProof: { exactAbsenceProven: true },
    });

    for (const recovery of [
        null,
        { candidateInspectionComplete: true, candidateOwned: true, candidateId: 'missing-presence' },
        {
            candidateCreationAttempted: false,
            candidateInspectionComplete: true,
            candidatePresent: false,
            candidateOwned: true,
            candidateId: '',
        },
        {
            candidateCreationAttempted: false,
            candidateInspectionComplete: true,
            candidatePresent: false,
            candidateOwned: false,
            candidateId: 'contradictory-id',
        },
        {
            candidateInspectionComplete: true,
            candidatePresent: false,
            candidateOwned: false,
            candidateId: '',
        },
        {
            candidateCreationAttempted: undefined,
            candidateInspectionComplete: true,
            candidatePresent: true,
            candidateOwned: true,
            candidateId: 'missing-creation-state',
        },
        {
            candidateCreationAttempted: 'false',
            candidateInspectionComplete: true,
            candidatePresent: true,
            candidateOwned: true,
            candidateId: 'non-boolean-creation-state',
        },
        {
            candidateCreationAttempted: false,
            candidateInspectionComplete: true,
            candidatePresent: true,
            candidateOwned: true,
            candidateId: '',
        },
        {
            exactCleanupPerformed: true,
            candidateCreationAttempted: false,
            candidateInspectionComplete: true,
            candidatePresent: true,
            candidateOwned: true,
            candidateId: 'predecessor-id',
        },
        {
            exactCleanupPerformed: true,
            candidateCreationAttempted: true,
            candidateInspectionComplete: true,
            candidatePresent: false,
            candidateOwned: true,
            candidateId: '',
        },
    ]) {
        const classified = classifyManagedFailureRecovery(recovery);
        assert.equal(classified.phase, 'readiness');
        assert.equal(classified.state, 'preserved-ambiguous');
        assert.equal(classified.candidateId, '');
        assert.equal(classified.ownershipProof.exactAbsenceProven, false);
    }
});

test('resolve may record honest pre-create absence or ambiguity', () => {
    for (const next of [
        {
            ...base,
            phase: 'readiness',
            state: 'absent-proven',
            inspectionComplete: true,
            ownershipProof: { exactAbsenceProven: true },
        },
        {
            ...base,
            phase: 'readiness',
            state: 'preserved-ambiguous',
            ownershipProof: { exactAbsenceProven: false },
        },
    ]) {
        assert.equal(assertCandidateLifecycleTransition(base, Object.freeze(next)), next);
    }
});

test('adoption receipts require proof and cannot carry a destructive candidate ID', () => {
    const adopted = Object.freeze({
        ...base,
        phase: 'candidate-observed',
        state: 'not-created-proven',
        inspectionComplete: true,
        candidateId: '',
        ownershipProof: Object.freeze({ adoptedExistingRuntime: true }),
    });
    assert.equal(assertCandidateLifecycleTransition(base, adopted), adopted);

    for (const invalid of [
        { ...adopted, candidateId: 'predecessor-id' },
        { ...adopted, ownershipProof: {} },
    ]) {
        assert.throws(
            () => assertCandidateLifecycleTransition(base, Object.freeze(invalid)),
            { code: 'PLOINKY_RUNTIME_CLEANUP_RECEIPT_INVALID' },
        );
    }
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
