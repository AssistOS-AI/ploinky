import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { sealEdgeSelector, selectorIdentity } from '../../cli/sandbox/edgeSelectorRecord.mjs';
import { classifyFailedActivation, postStopSelectorBound } from '../../ploinky-box/activationRecovery.mjs';

const GEN_A = `sha256:${'a'.repeat(64)}`;
const GEN_B = `sha256:${'b'.repeat(64)}`;

function active(generation = GEN_B) {
    return sealEdgeSelector({
        schemaVersion: 1, state: 'active', generation, publicationState: 'ready',
        activationId: crypto.randomUUID(), activatedAt: new Date().toISOString(),
    });
}

function inactive({ generation = GEN_B, previousGeneration = GEN_A, reason = 'coordinated-apply' } = {}) {
    return sealEdgeSelector({
        schemaVersion: 1, state: 'inactive', generation, previousGeneration, reason,
        activationId: crypto.randomUUID(), changedAt: new Date().toISOString(),
    });
}

const valid = (value, extra = {}) => ({ state: 'valid', value, ...extra });
const absent = { state: 'absent' };

function evidence({ live = absent, intent = absent, receipt = absent, directories = { state: 'valid' } } = {}) {
    return { directories, live, intent, receipt };
}

function intentFor(intended, predecessor) {
    return valid({ intended: selectorIdentity(intended), predecessor: selectorIdentity(predecessor) });
}

// --- AC6: one pure case per row ------------------------------------------

test('the decision table keeps the graph unless the predecessor is proven in force (R1-R7, P-W1L)', () => {
    const predecessor = inactive();
    const intended = active();
    const baselineActive = active(GEN_A);
    const notCommitted = valid({ outcome: 'not-committed' });
    const committed = valid({ outcome: 'committed' });
    const rows = [
        ['R1', evidence({ directories: { state: 'invalid', reason: 'not private' } }), null, 'kept-indeterminate'],
        ['R2a absent', evidence(), null, 'rollback'],
        ['R2a inactive', evidence({ live: valid(inactive()) }), selectorIdentity(baselineActive), 'rollback'],
        ['R2a baseline', evidence({ live: valid(baselineActive) }), selectorIdentity(baselineActive), 'rollback'],
        ['R2 other active is R7', evidence({ live: valid(active()) }), selectorIdentity(baselineActive), 'kept-indeterminate'],
        ['R2 absent with unknown baseline is R7', evidence(), 'unknown', 'kept-indeterminate'],
        ['R3', evidence({ intent: { state: 'invalid', reason: 'foreign' }, live: valid(predecessor) }), null, 'kept-indeterminate'],
        ['R4 no receipt', evidence({ intent: intentFor(intended, predecessor), live: valid(intended) }), null, 'kept-activated'],
        ['R4 committed', evidence({ intent: intentFor(intended, predecessor), live: valid(intended), receipt: committed }), null, 'kept-activated'],
        ['R5', evidence({ intent: intentFor(intended, predecessor), live: valid(inactive()), receipt: notCommitted }), null, 'rollback'],
        ['R6 no receipt', evidence({ intent: intentFor(intended, predecessor), live: valid(predecessor) }), null, 'rollback'],
        // The predecessor is always inactive, so R5 already decides this case.
        ['R5 predecessor not committed', evidence({ intent: intentFor(intended, predecessor), live: valid(predecessor), receipt: notCommitted }), null, 'rollback'],
        ['R7 invalid receipt', evidence({ intent: intentFor(intended, predecessor), live: valid(intended), receipt: { state: 'invalid', reason: 'digest-mismatch' } }), null, 'kept-indeterminate'],
        ['R7 committed without R4', evidence({ intent: intentFor(intended, predecessor), live: valid(predecessor), receipt: committed }), null, 'kept-indeterminate'],
        ['R7 not committed, active non-intended', evidence({ intent: intentFor(intended, predecessor), live: valid(active()), receipt: notCommitted }), null, 'kept-indeterminate'],
        ['R7 unreadable live', evidence({ intent: intentFor(intended, predecessor), live: { state: 'invalid', reason: 'symlink' } }), null, 'kept-indeterminate'],
        // P-W1L: W1 threw before the rename, its not-committed receipt was lost,
        // and the catch wrote a fresh inactive selector.
        ['P-W1L', evidence({ intent: intentFor(intended, predecessor), live: valid(inactive()) }), null, 'kept-indeterminate'],
    ];
    for (const [label, input, baseline, expected] of rows) {
        const decision = classifyFailedActivation({ evidence: input, baseline });
        assert.equal(decision.verdict, expected, label);
        assert.equal(decision.row, label.split(' ')[0].replace(/^R2$/, 'R7').replace('P-W1L', 'R7'), label);
    }
});

// --- postStopSelectorBound -----------------------------------------------

test('the post-stop selector is bound only to the stop this rollback ran', () => {
    const preActive = active(GEN_B);
    const preInactive = inactive({ generation: GEN_B, previousGeneration: GEN_A });
    const stopOf = (pre) => inactive({
        generation: undefined,
        previousGeneration: pre?.state === 'active' ? pre.generation : (pre?.previousGeneration || ''),
        reason: 'cli-workspace-stop',
    });
    assert.equal(postStopSelectorBound(preActive, stopOf(preActive)), true);
    assert.equal(postStopSelectorBound(preInactive, stopOf(preInactive)), true);
    assert.equal(postStopSelectorBound(null, stopOf(null)), true, 'an absent pre-stop selector derives an empty previous generation');
    assert.equal(postStopSelectorBound(preActive, inactive({ previousGeneration: GEN_B, reason: 'apply-failed' })), false, 'another reason');
    assert.equal(postStopSelectorBound(preActive, inactive({ previousGeneration: GEN_A, reason: 'cli-workspace-stop' })), false, 'wrong previous generation');
    assert.equal(postStopSelectorBound(preActive, null), false);
    assert.equal(postStopSelectorBound(preActive, active()), false);
    // The stop's preserved branch keeps the exact inactive selector.
    assert.equal(postStopSelectorBound(preInactive, preInactive), true);
    assert.equal(postStopSelectorBound(preActive, preActive), false, 'an unchanged active selector was not stopped');
});
