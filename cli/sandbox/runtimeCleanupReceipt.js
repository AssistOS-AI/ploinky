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
    resolve: new Set(['predecessor-inspected', 'pre-create', 'create-attempted', 'candidate-observed']),
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
            && next.inspectionComplete === true;
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
