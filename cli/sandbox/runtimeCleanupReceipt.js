const RECEIPT_VERSION = 1;
const RUNTIME_KINDS = new Set(['container', 'bwrap', 'seatbelt']);
const PHASES = new Set([
    'resolve',
    'predecessor-inspected',
    'predecessor-removed',
    'pre-create',
    'create-attempted',
    'candidate-observed',
    'readiness',
    'activation',
]);
const STATES = new Set([
    'not-created-proven',
    'absent-proven',
    'removed-proven',
    'retryable-exact-id',
    'preserved-ambiguous',
]);
const NEXT_PHASES = Object.freeze({
    resolve: new Set(['predecessor-inspected', 'pre-create', 'create-attempted', 'candidate-observed', 'readiness']),
    'predecessor-inspected': new Set(['predecessor-removed']),
    'predecessor-removed': new Set(['pre-create']),
    'pre-create': new Set(['create-attempted']),
    'create-attempted': new Set(['candidate-observed', 'readiness']),
    'candidate-observed': new Set(['readiness', 'activation']),
    readiness: new Set(['activation']),
    activation: new Set(),
});

function invalidReceipt(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_RUNTIME_CLEANUP_RECEIPT_INVALID';
    return error;
}

// This classifier is deliberately pure. It may describe a lifecycle
// transition, but only the private lifecycle owner can mint or advance an
// authorized cleanup receipt from it.
export function classifyManagedFailureRecovery(recovery) {
    const candidateId = typeof recovery?.candidateId === 'string'
        ? recovery.candidateId.trim()
        : '';
    const exactCleanupEvidence = (
        recovery?.candidatePresent === false
        && recovery?.candidateOwned === false
        && recovery?.candidateId === ''
    ) || (
        recovery?.candidatePresent === true
        && recovery?.candidateOwned === true
        && Boolean(candidateId)
    );
    if (recovery?.exactCleanupPerformed === true
        && recovery?.candidateCreationAttempted === true
        && recovery?.candidateInspectionComplete === true
        && exactCleanupEvidence) {
        return Object.freeze({
            phase: 'readiness',
            state: 'removed-proven',
            candidateId: '',
            inspectionComplete: true,
            ownershipProof: Object.freeze({ exactAbsenceProven: true }),
        });
    }
    if (recovery?.exactCleanupPerformed !== true
        && recovery?.candidateInspectionComplete === true
        && typeof recovery?.candidateCreationAttempted === 'boolean'
        && recovery?.candidatePresent === false
        && recovery?.candidateOwned === false
        && recovery?.candidateId === '') {
        return Object.freeze({
            phase: 'readiness',
            state: 'absent-proven',
            candidateId: '',
            inspectionComplete: true,
            ownershipProof: Object.freeze({ exactAbsenceProven: true }),
        });
    }
    if (recovery?.exactCleanupPerformed !== true
        && recovery?.candidateInspectionComplete === true
        && recovery?.candidatePresent === true
        && recovery?.candidateOwned === true
        && candidateId
        && recovery?.candidateCreationAttempted === false) {
        return Object.freeze({
            phase: 'candidate-observed',
            state: 'not-created-proven',
            candidateId: '',
            inspectionComplete: true,
            ownershipProof: Object.freeze({ adoptedExistingRuntime: true }),
        });
    }
    if (recovery?.exactCleanupPerformed !== true
        && recovery?.candidateInspectionComplete === true
        && recovery?.candidatePresent === true
        && recovery?.candidateOwned === true
        && candidateId
        && recovery?.candidateCreationAttempted === true) {
        return Object.freeze({
            phase: 'candidate-observed',
            state: 'retryable-exact-id',
            candidateId,
            inspectionComplete: true,
            ownershipProof: Object.freeze({ immutableId: true }),
        });
    }
    return Object.freeze({
        phase: 'readiness',
        state: 'preserved-ambiguous',
        candidateId: '',
        inspectionComplete: recovery?.candidateInspectionComplete === true,
        ownershipProof: Object.freeze({ exactAbsenceProven: false }),
    });
}

export function isCandidateCleanupReceiptDocument(receipt) {
    return receipt?.version === RECEIPT_VERSION
        && receipt.scope === 'candidate'
        && /^[0-9a-f-]{36}$/i.test(String(receipt.operationId || ''))
        && RUNTIME_KINDS.has(receipt.runtimeKind)
        && PHASES.has(receipt.phase)
        && STATES.has(receipt.state)
        && typeof receipt.creationAttempted === 'boolean'
        && Boolean(String(receipt.candidateName || ''))
        && /^sha256:[a-f0-9]{64}$/.test(String(receipt.contractHash || ''))
        && receipt.runtimeIdentity && typeof receipt.runtimeIdentity === 'object'
        && !Array.isArray(receipt.runtimeIdentity)
        && typeof receipt.inspectionComplete === 'boolean'
        && receipt.ownershipProof && typeof receipt.ownershipProof === 'object'
        && !Array.isArray(receipt.ownershipProof);
}

export function assertCandidateLifecycleTransition(previous, next) {
    if (!isCandidateCleanupReceiptDocument(previous) || !isCandidateCleanupReceiptDocument(next)) {
        throw invalidReceipt('candidate cleanup lifecycle transition requires valid receipt documents');
    }
    for (const field of ['version', 'scope', 'operationId', 'runtimeKind', 'candidateName', 'contractHash']) {
        if (String(previous[field] ?? '') !== String(next[field] ?? '')) {
            throw invalidReceipt(`candidate cleanup lifecycle cannot change ${field}`);
        }
    }
    if (JSON.stringify(previous.runtimeIdentity) !== JSON.stringify(next.runtimeIdentity)) {
        throw invalidReceipt('candidate cleanup lifecycle cannot change runtimeIdentity');
    }
    if (!NEXT_PHASES[previous.phase]?.has(next.phase)) {
        throw invalidReceipt(`candidate cleanup lifecycle cannot transition from ${previous.phase} to ${next.phase}`);
    }
    if (previous.creationAttempted && !next.creationAttempted) {
        throw invalidReceipt('candidate cleanup lifecycle cannot clear creationAttempted');
    }
    if (next.phase === 'create-attempted'
        && (next.creationAttempted !== true || next.state !== 'preserved-ambiguous')) {
        throw invalidReceipt('create-attempted must preserve an ambiguous attempted candidate');
    }
    if (next.phase === 'candidate-observed') {
        const exactCandidate = next.state === 'retryable-exact-id'
            && next.creationAttempted === true
            && next.inspectionComplete === true
            && Boolean(String(next.candidateId || ''));
        const adoptedCandidate = next.state === 'not-created-proven'
            && next.creationAttempted === false
            && next.inspectionComplete === true
            && !Boolean(String(next.candidateId || ''))
            && next.ownershipProof?.adoptedExistingRuntime === true;
        if (!exactCandidate && !adoptedCandidate) {
            throw invalidReceipt('candidate-observed requires exact inspected ownership or proven adoption');
        }
    }
    if (next.phase === 'readiness') {
        const exactAbsence = (next.state === 'removed-proven' || next.state === 'absent-proven')
            && next.inspectionComplete === true
            && next.ownershipProof?.exactAbsenceProven === true;
        const preserved = next.state === 'preserved-ambiguous'
            && next.ownershipProof?.exactAbsenceProven === false;
        if (!exactAbsence && !preserved) {
            throw invalidReceipt('readiness cleanup must prove exact absence or preserve ambiguity');
        }
    }
    return next;
}

export const RUNTIME_CLEANUP_RECEIPT_VERSION = RECEIPT_VERSION;
