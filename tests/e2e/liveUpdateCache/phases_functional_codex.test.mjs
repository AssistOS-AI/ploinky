import test from 'node:test';
import assert from 'node:assert/strict';
import { installPureGuards } from './test_support_codex.mjs';
import { createWorld } from './world_support_codex.mjs';
installPureGuards();

const ORDER = ['U0', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U7b'];
async function run(faults = {}, until = 'U7b') {
    const h = createWorld(faults), evidence = {};
    for (const name of ORDER) { evidence[name] = await h.phases[name](); if (name === until) break; }
    return { ...h, evidence };
}
async function failsAt(faults, phase, code, label = JSON.stringify(faults)) {
    const h = createWorld(faults);
    for (const name of ORDER) {
        if (name === phase) { await assert.rejects(h.phases[name](), error => error.code === code || (code instanceof RegExp && code.test(error.code)), `${label}: expected ${code} at ${phase}`); return h; }
        await h.phases[name]();
    }
    assert.fail(`${label}: phase ${phase} never ran`);
}

test('the functional epoch runs U0-U7b in order against a coherent deployment and returns only public evidence', async () => {
    const h = await run();
    assert.deepEqual(Object.keys(h.evidence), ORDER);
    const calls = h.world.calls;
    const startAt = calls.findIndex(call => call.startsWith('cli:start')); assert.ok(calls.indexOf('browser-create') < startAt && startAt < calls.indexOf('fixture-prepare'), 'U1 precedes U2 precedes U3'); assert.ok(calls.indexOf('fixture-prepare') < calls.indexOf('update:normal-update'));
    assert.ok(calls.indexOf('update:normal-update') < calls.findIndex(call => call.startsWith('reinstall:')) && calls.findIndex(call => call.startsWith('reinstall:')) < calls.indexOf('negative-run'));
    assert.ok(calls.indexOf('negative-restore') < calls.indexOf('update:settling-update') && calls.indexOf('update:settling-update') < calls.indexOf('browser-verify') && calls.indexOf('browser-verify') < calls.indexOf('cleanup:true'));
    assert.deepEqual(h.evidence.U2, { phase: 'U2', exit: 0, runtimes: 1, comparedObjects: 1, generationChanged: false });
    assert.deepEqual(h.evidence.U5.gc, { outcome: 'collected', removedCount: 1, retainedReasons: ['admitted-record', 'container-mount', 'reader:container'] }); assert.equal(h.evidence.U5.readerUnchanged, true);
    assert.equal(h.evidence.U4.predecessorRetained, true); assert.equal(h.evidence.U7.publicConfigEqual, true); assert.equal(h.evidence.U7b.cleanup.files, 'removed');
    assert.doesNotMatch(JSON.stringify(h.evidence), /PRIVATE|\/ws\//, 'evidence contains no mount source or private path');
    assert.equal(calls.filter(call => call.startsWith('cli:disable agent')).length, 3, 'only the two owned aliases and the owned primary are disabled');
});

test('U0-U2: unprepared baseline, replaced warm runtime or object, failed start and unready graph refuse', async () => {
    await failsAt({ graphNotReady: true }, 'U2', 'graph-not-ready'); await failsAt({ warmReplacesRuntime: true }, 'U2', 'warm-runtime-replaced'); await failsAt({ graphNoStore: true }, 'U2', 'warm-no-store-runtime'); await failsAt({ warmReplacesObject: true }, 'U2', 'warm-reuse-mismatch');
    await failsAt({ startExit: 1 }, 'U2', 'warm-start-failed');
});

test('U3: unreachable fixture, failed registration or enable and a wrong installed package refuse before any update', async () => {
    await failsAt({ unreachable: true }, 'U3', 'fixture-unreachable-from-box');
    await failsAt({ enableExit: 1 }, 'U3', 'fixture-enable-failed');
    await failsAt({ noReceipt: true }, 'U3', 'cache-a-unproven');
});

test('U3 records the owned server and the registration intent before the commands that could half-succeed', async () => {
    const h = await run({}, 'U3'); assert.deepEqual(h.world.recovered.map(row => row.label), ['fixture-server', 'registration-intent']);
    assert.ok(h.world.calls.indexOf('recovery:fixture-server') < h.world.calls.findIndex(call => call.startsWith('cli:add repo')) && h.world.calls.indexOf('recovery:registration-intent') < h.world.calls.findIndex(call => call.startsWith('cli:add repo')));
    assert.equal(h.world.recovered[0].value.container.id.length, 64); assert.deepEqual(h.world.recovered[1].value.aliases, h.world.names.aliases);
    const failed = createWorld({ enableExit: 1, unreachable: false }); failed.ports.cache.cli = async (operation, args) => { if (args[0] === 'add') throw Object.assign(new Error('x'), { code: 'command-exit-unexpected' }); return { code: 0 }; };
    for (const name of ['U0', 'U1', 'U2']) await failed.phases[name](); await assert.rejects(failed.phases.U3(), error => error.code === 'command-exit-unexpected');
    assert.equal(failed.ctx.state.registered, true, 'a failed add is still treated as possibly registered, so cleanup checks the exact key');
});

test('U4: an update that keeps the object, does not restart, keeps the generation, changes the wrong commit or mutates the predecessor refuses', async () => {
    await failsAt({ updateKeepsObject: true }, 'U4', /replacement-not-observed|cache-b-unproven/);
    await failsAt({ noRestart: true }, 'U4', 'runtime-not-restarted'); await failsAt({ noGenerationChange: true }, 'U4', 'generation-not-fresh');
    await failsAt({ wrongCommit: true }, 'U4', 'cache-b-unproven');
    await failsAt({ mutatePredecessor: true }, 'U4', 'predecessor-mutated'); await failsAt({ activation: 'deferred' }, 'U4', 'update-not-restarted'); await failsAt({ updateExit: 1 }, 'U4', 'update-not-restarted');
    const absent = await run({ removePredecessor: true }, 'U4'); assert.equal(absent.evidence.U4.predecessorRetained, false, 'a collected predecessor is accepted without a retained-reader claim');
});

test('U4: an update whose expectation omits the owned repository or pin record, or a registration name that is not the derived one, refuses', async () => {
    await failsAt({ wrongContainerName: true }, 'U4', 'owned-registration-derivation');
    const h = createWorld(); for (const name of ['U0', 'U1', 'U2', 'U3']) await h.phases[name]();
    h.ctx.inputs.expectedUpdates['normal-update'] = { errors: [], blockedBy: [], recordIds: ['workspace-graph'] };
    await assert.rejects(h.phases.U4(), error => error.code === 'update-records-incomplete');
});

test('U5: skipped collection, a lost reader or object, an unreadable marker or identical-object violation never pass the retained-reader claim', async () => {
    await failsAt({ gcSkipped: true }, 'U5', 'ordinary-gc-not-proven'); await failsAt({ removeReaderObject: true }, 'U5', 'ordinary-gc-not-proven'); await failsAt({ noRetainedReason: true }, 'U5', 'ordinary-gc-not-proven');
    await failsAt({ readerDies: true }, 'U5', /reader-changed-during-gc|reader-not-live/);
    // Reader predicate on every during sample, a sample after the summary, and the same container incarnation throughout.
    await failsAt({ readerUnreadableCall: 2 }, 'U5', 'reader-changed-during-gc'); await failsAt({ noSummaryCallback: true }, 'U5', 'reader-not-observed-after-gc-summary'); await failsAt({ readerRestartsDuringGc: true }, 'U5', 'reader-changed-during-gc'); await failsAt({ readerRestartsAfterReinstall: true }, 'U5', 'reader-changed-during-gc'); await failsAt({ readerUnreadable: true }, 'U5', 'reader-not-mounted');
    await failsAt({ freshObjectPerAlias: true }, 'U5', 'aliases-not-identical'); await failsAt({ noReceipt: true }, 'U3', 'cache-a-unproven');
});

test('U6: a continuation run that leaves no pending activation is refused before any settlement', async () => {
    await failsAt({ noPending: true }, 'U6', 'continuation-pending-missing');
});

test('U7 and U7b: a changed public primary configuration or a dirty run blocks settlement, freezing and cleanup', async () => {
    await failsAt({ configChanges: true }, 'U7', 'public-config-changed');
    for (const phase of ['U7', 'U7b']) {
        const h = createWorld({}); for (const name of ORDER.slice(0, ORDER.indexOf(phase))) await h.phases[name](); h.world.faults.latchDirty = true;
        const mark = h.world.calls.length;
        await assert.rejects(h.phases[phase](), error => error.code === 'writers-not-quiescent'); assert.deepEqual(h.world.calls.slice(mark), [], 'a refused phase performs no operation');
    }
});
