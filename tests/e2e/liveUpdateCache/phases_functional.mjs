import { isDeepStrictEqual } from 'node:util';
import { AcceptanceError, need } from './manifest.mjs';
import { assertLiveBefore, assertWarmReuse, assertDependencyReplacement, assertRetainedReader, PHASE_CAPS_MS } from './contracts.mjs';
import { expectedLiveFromManifest } from './live_admission.mjs';
import { ownedRegistration } from './owned_ids.mjs';

// U0-U7b: the functional epoch. Every phase is a function of explicit ports (observer, worker host, cache ports,
// Git fixture, browser, negative fixture, owned files) so each can be exercised with fabricated adapters and run
// unchanged against the real ones. A phase returns only public, nonsecret evidence; any thrown error ends the run.
const RETRYABLE = new Set(['live-store-probe-missing', 'live-store-probe-record', 'live-store-probe-object', 'live-store-probe-manifest', 'live-store-probe-lock', 'live-store-probe-package',
    'live-store-probe-marker', 'live-store-probe-provenance', 'live-store-probe-registry-changed', 'live-store-probe-container-inspect', 'live-store-probe-ambiguous', 'live-store-probe-tree']);
const POLL_MS = 5000, READER_POLL_MS = 2000;

export function targetFor(names, alias) { return { label: alias ?? 'primary', repoName: names.repoName, agentName: names.agentName, alias, packageName: names.packageName, markerFile: 'index.js' }; }
export const graphTargets = manifest => manifest.graph.map((entry, index) => { const [repoName, agentName] = entry.name.split('/'); return { label: `g${index}`, repoName, agentName, alias: null, packageName: null, markerFile: null }; });
const cacheSnapshot = row => ({ runtimeId: row.runtimeId, instanceId: row.instanceId, enableGeneration: row.enableGeneration, objectId: row.objectId, selectorId: row.selectorId, payloadSha256: row.payloadSha256 });
const installedFacts = row => ({ version: row.version, objectId: row.objectId, payloadSha256: row.payloadSha256, sourceCommit: row.sourceCommit, lockCommit: row.lockCommit, provenanceCommit: row.provenanceCommit, markerSha256: row.markerSha256 });

export async function waitFor(ctx, label, probe, { intervalMs = POLL_MS } = {}) {
    for (;;) {
        ctx.check();
        const value = await probe();
        if (value) return value;
        ctx.check(); await ctx.ports.clock.delay(intervalMs);
    }
}

async function observeAgain(ctx, { mustChange = false, previous = null } = {}) {
    const { manifest, ports } = ctx;
    const observed = await ports.observer.observe();
    // After a mutation the edge generation legitimately changes; every other bound identity stays exactly as admitted.
    const expected = expectedLiveFromManifest(manifest); expected.activeGeneration = observed.activeGeneration;
    assertLiveBefore({ expected, observed });
    if (mustChange) need(previous !== null && observed.activeGeneration !== previous, 'generation-not-fresh');
    return observed;
}

async function probeRow(ctx, target, expectedMarker) {
    return waitFor(ctx, `runtime-${target.label}`, async () => {
        let result; try { result = await ctx.ports.cache.probeStore({ targets: [target], objects: [] }); } catch (error) { if (RETRYABLE.has(error.code)) return null; throw error; }
        const [row] = result.targets; if (!row.running || !row.labelsEqual) return null;
        if (expectedMarker === null) return row;
        const logs = await ctx.ports.cache.containerLogs(row.runtimeId);
        return logs.includes(`UC_MARKER ${expectedMarker}`) ? row : null;
    });
}

function assertInstalled(row, expected, code) {
    need(row.version === '1.0.0' && row.sourceCommit === expected.commit && row.lockCommit === expected.commit && row.provenanceCommit === expected.commit && row.markerSha256 === expected.markerSha256
        && row.mountSource !== null && row.mountSource.includes(row.objectId) && row.mountReadOnly === true && row.readerReceipt !== null && row.installerKind === 'container-npm' && row.verification === 'remote-verified', code);
}

export function createFunctionalPhases(ctx) {
    const { manifest, inputs, ports, state } = ctx; const names = ports.fixture.names;
    const expectedUpdate = operation => { const expected = inputs.expectedUpdates[operation]; need(expected, 'expectations-missing'); return expected; };
    // The update's record vocabulary is observed in the live deployment immediately before it runs: the Git-pin ids the
    // product derives for every enabled registration (owned or not), their registration keys and the registered
    // repositories. Those ids are admitted and the pin ids join the expected set; the operator's errors and blockers and every
    // other id stay exactly as stated, so the update must still produce precisely the set expected.
    const boundExpectation = async operation => {
        const base = expectedUpdate(operation), observed = await ports.cache.observeAdmissibleIds();
        const admitted = [...new Set([...observed.gitPinRecordIds, ...observed.registrations, ...observed.repositories])];
        return { observed, admitted, expected: { ...base, recordIds: [...new Set([...base.recordIds, ...observed.gitPinRecordIds])] } };
    };
    return {
        async U0() { const receipt = await ports.observer.admit(); const observed = await ports.observer.observe(); state.baseline = { generation: observed.activeGeneration, publicConfig: observed.publicConfig, boxId: observed.box.id };
            state.generation = observed.activeGeneration; return receipt; },
        async U1() {
            const observed = await ports.observer.observe(); need(isDeepStrictEqual(observed.publicConfig, state.baseline.publicConfig) && observed.activeGeneration === state.baseline.generation, 'baseline-changed');
            const receipt = await ports.browser.createMarker({ live: observed, expected: expectedLiveFromManifest(manifest) });
            const after = await ports.observer.observe(); need(isDeepStrictEqual(after.publicConfig, state.baseline.publicConfig), 'public-config-changed');
            return { ...receipt, publicConfig: state.baseline.publicConfig };
        },
        async U2() {
            const targets = graphTargets(manifest);
            const before = (await ports.cache.probeStore({ targets, objects: [] })).targets;
            const args = ['start', 'explorer', ...(manifest.candidate.deploymentBranch ? ['--branch', manifest.candidate.deploymentBranch] : [])];
            const run = await ports.cache.cli('warm-start', args); need(run.code === 0, 'warm-start-failed');
            const observed = await observeAgain(ctx); state.generation = observed.activeGeneration;
            const after = (await ports.cache.probeStore({ targets, objects: [] })).targets; let compared = 0;
            for (const [index, row] of before.entries()) {
                const next = after[index]; need(row.runtimeId === next.runtimeId && row.instanceId === next.instanceId && row.enableGeneration === next.enableGeneration && row.running && next.running && next.labelsEqual, 'warm-runtime-replaced');
                if (row.objectId !== null) { assertWarmReuse(cacheSnapshot(row), cacheSnapshot(next)); compared += 1; } else need(next.objectId === null, 'warm-store-changed');
            }
            need(compared > 0, 'warm-no-store-runtime');
            return { phase: 'U2', exit: 0, runtimes: before.length, comparedObjects: compared, generationChanged: observed.activeGeneration !== state.baseline.generation };
        },
        async U3() {
            const fixture = ports.fixture; await fixture.prepare();
            const A = await fixture.publishPackage('A', `A-${names.suffix}`), agentCommit = await fixture.publishAgent();
            try { await fixture.startServer(); } finally { if (fixture.state().container) ports.recovery.record('fixture-server', fixture.recoverySnapshot()); }
            need(await fixture.reachableFromBox('pkg', A.commit) && await fixture.reachableFromBox('agent', agentCommit), 'fixture-unreachable-from-box');
            // Intent is recorded, and ownership claimed, before the command can half-succeed: cleanup then checks the exact key and URL.
            ports.recovery.record('registration-intent', { repository: { key: names.repoName, url: fixture.agentUrl }, primary: `${names.repoName}/${names.agentName}`, aliases: [...names.aliases] }); state.registered = true;
            need((await ports.cache.cli('fixture-add-repo', ['add', 'repo', fixture.agentUrl, names.repoName, 'main'])).code === 0, 'fixture-registration-failed');
            need((await ports.cache.cli('fixture-enable-primary', ['enable', 'agent', `${names.repoName}/${names.agentName}`, 'global'])).code === 0, 'fixture-enable-failed'); state.primaryEnabled = true;
            const row = await probeRow(ctx, targetFor(names, null), A.marker); assertInstalled(row, A, 'cache-a-unproven');
            const observed = await observeAgain(ctx); state.generation = observed.activeGeneration; state.A = { ...A, row };
            return { phase: 'U3', commit: A.commit, version: row.version, readOnlyMount: true, installer: row.installerKind, runtimeMarker: 'A' };
        },
        async U4() {
            const previous = state.generation, A = state.A;
            // The update's expected record ids rest on a derivation of the owned registration; it must match what runs.
            need(A.row.containerName === ownedRegistration(manifest).containerName, 'owned-registration-derivation');
            const B = await ports.fixture.publishPackage('B', `B-${names.suffix}`);
            need(B.commit !== A.commit && B.markerSha256 !== A.markerSha256, 'fixture-replacement-invalid');
            const bound = await boundExpectation('normal-update'), owned = ownedRegistration(manifest);
            // The owned pin as the product itself derives it from the enabled registration, observed before the update.
            need(bound.observed.gitPinRecordIds.includes(owned.pinId) && bound.observed.registrations.includes(owned.containerName), 'owned-pin-not-observed');
            const proof = await ports.workerHost.update('normal-update', bound.expected, bound.admitted);
            need(proof.fulfilled === true && proof.returnedCode === 0 && proof.result.activation.outcome === 'restarted', 'update-not-restarted');
            const observed = await observeAgain(ctx, { mustChange: true, previous }); state.generation = observed.activeGeneration;
            const row = await probeRow(ctx, targetFor(names, null), B.marker); assertInstalled(row, B, 'cache-b-unproven'); need(row.runtimeId !== A.row.runtimeId, 'runtime-not-restarted');
            const objects = (await ports.cache.probeStore({ targets: [], objects: [A.row.objectId] })).objects[0];
            need(!(objects.present && !objects.treeMatches), 'predecessor-mutated');
            assertDependencyReplacement({ before: installedFacts(A.row), after: installedFacts(row), expectedA: { commit: A.commit, markerSha256: A.markerSha256 }, expectedB: { commit: B.commit, markerSha256: B.markerSha256 },
                predecessor: objects.present ? { objectId: objects.objectId, payloadSha256: objects.payloadSha256 } : null });
            state.B = { ...B, row };
            return { phase: 'U4', exit: 0, activation: 'restarted', graphGenerationChanged: true, objectReplaced: true, predecessorRetained: objects.present, runtimeMarker: 'B' };
        },
        async U5() {
            const [aliasA, aliasB] = names.aliases, gc = await retainedReaderProof(ctx, aliasA, aliasB); return gc;
        },
        async U6() {
            const evidence = await ports.negative.run({ generation: state.generation, check: ctx.check });
            // The required-membership case deliberately leaves its truthful pending activation for the settling update.
            const observed = await ports.observer.observe();
            need(observed.pendingActivation === true && observed.recoveryBarrier === false, 'continuation-pending-missing'); state.generation = observed.activeGeneration;
            return evidence;
        },
        async U7() {
            // Restoration, removal and the settling update are permitted only while every owned command has settled normally.
            need(ctx.latchClean(), 'writers-not-quiescent');
            await ports.negative.restore({ writersQuiescent: true });
            for (const target of [...names.aliases, `${names.repoName}/${names.agentName}`]) need((await ports.cache.cli('fixture-disable-agent', ['disable', 'agent', target])).code === 0, 'fixture-disable-failed');
            state.primaryEnabled = false;
            const bound = await boundExpectation('settling-update');
            const proof = await ports.workerHost.update('settling-update', bound.expected, bound.admitted);
            need(proof.fulfilled === true && proof.returnedCode === 0 && proof.result.activation.outcome === 'restarted', 'settling-update-not-restarted');
            const observed = await observeAgain(ctx); state.generation = observed.activeGeneration;
            need(isDeepStrictEqual(observed.publicConfig, state.baseline.publicConfig), 'public-config-changed');
            const marker = await ports.browser.verifyMarker();
            return { phase: 'U7', exit: 0, activation: 'restarted', pending: false, publicConfigEqual: true, marker };
        },
        async U7b() {
            need(ctx.latchClean(), 'writers-not-quiescent');
            // Receipts are frozen by the orchestrator once this phase's own receipt exists; cleanup comes first so a
            // half-cleaned functional epoch can never be resumed from.
            const cleanup = await ports.cleanup.run({ writersQuiescent: true, names, state });
            const observed = await observeAgain(ctx); need(isDeepStrictEqual(observed.publicConfig, state.baseline.publicConfig), 'public-config-changed');
            state.finalObserved = observed;
            return { phase: 'U7b', cleanup, publicConfigEqual: true };
        },
    };
}

// U5: two owned aliases of identical current inputs; alias B is the independently retained reader while the ordinary
// product collection that follows a reinstall of alias A actually reports success.
async function retainedReaderProof(ctx, aliasA, aliasB) {
    const { manifest, ports, state } = ctx, names = ports.fixture.names, B = state.B;
    state.aliasesEnabled = true;                                  // claimed before the commands that could half-succeed
    for (const alias of [aliasA, aliasB]) need((await ports.cache.cli('fixture-enable-alias', ['enable', 'agent', `${names.repoName}/${names.agentName}`, 'global', 'as', alias])).code === 0, 'fixture-enable-failed');
    const rowA0 = await probeRow(ctx, targetFor(names, aliasA), B.marker), rowB0 = await probeRow(ctx, targetFor(names, aliasB), B.marker);
    assertInstalled(rowA0, B, 'cache-alias-unproven'); assertInstalled(rowB0, B, 'cache-alias-unproven');
    need(rowA0.objectId === rowB0.objectId && rowA0.runtimeId !== rowB0.runtimeId, 'aliases-not-identical');
    // One reader observation. startedAt binds the exact container incarnation; it is compared here and is not part of the
    // contract object, which has a fixed shape.
    const observeReader = async () => {
        const result = await ports.cache.probeStore({ targets: [targetFor(names, aliasB)], objects: [] }), row = result.targets[0];
        const read = await ports.cache.readerMarkerSha256(row.runtimeId, names.packageName, 'index.js');
        need(row.readerReceipt !== null, 'reader-receipt-missing');
        return { startedAt: row.startedAt, live: row.running === true && row.labelsEqual === true && read === row.markerSha256 && read === B.markerSha256, runtimeId: row.runtimeId, instanceId: row.instanceId, enableGeneration: row.enableGeneration,
            objectId: row.objectId, mountSource: row.mountSource, mountReadOnly: row.mountReadOnly, readerReceipt: row.readerReceipt, payloadSha256: row.payloadSha256 };
    };
    const contract = ({ startedAt: _startedAt, afterSummary: _afterSummary, ...rest }) => rest;
    const before = await observeReader(); need(before.live === true && before.objectId === rowB0.objectId && before.mountSource !== null, 'reader-not-mounted');
    const during = []; let pending = null, failure = null;
    const sample = afterSummary => { const task = observeReader().then(value => { during.push({ ...value, afterSummary }); }, error => { failure ??= error; }); pending = pending ? pending.then(() => task) : task; };
    let done = false, summarySeen = false, iterations = 0;
    // The monitor polls under the same discipline as every other loop: the phase deadline is checked each iteration, and an
    // iteration cap equal to the phase cap in polling intervals bounds it even if a clock or check were ever inert. A monitor
    // that stops, or a reinstall that never settles, fails the phase and latches the run uncertain; it can never pass.
    const maxIterations = Math.ceil(PHASE_CAPS_MS.U5 / READER_POLL_MS) + 1;
    let abandonMonitor, monitorError = null; const monitorStopped = new Promise((_, reject) => { abandonMonitor = reject; }); monitorStopped.catch(() => {});
    const monitor = (async () => {
        try { while (!done) { ctx.check(); need(++iterations <= maxIterations, 'reader-monitor-budget-expired'); sample(false); await ports.clock.delay(READER_POLL_MS); } }
        catch (error) { monitorError = error; abandonMonitor(error); }
    })();
    let run; try {
        run = await Promise.race([ports.cache.reinstallWithGcSummary(aliasA, { onChunk: snapshot => { if (snapshot.summary && !summarySeen) { summarySeen = true; sample(true); } } }), monitorStopped]);
    } catch (error) { if (error === monitorError) ctx.stop?.(error?.code ?? 'reader-monitor-failed'); throw error; }
    finally { done = true; await monitor; if (pending) await pending; }
    if (failure) throw failure;
    need(run.code === 0 && run.summary.outcome === 'collected' && during.length > 0, 'ordinary-gc-not-proven');
    // The reader predicate holds for every sample taken while the command ran, at least one sample started after the
    // collection summary was printed, and the same container incarnation answered every time.
    need(during.some(sample => sample.afterSummary === true), 'reader-not-observed-after-gc-summary');
    for (const sample of during) need(sample.live === true && isDeepStrictEqual({ ...sample, afterSummary: undefined }, { ...before, afterSummary: undefined }), 'reader-changed-during-gc');
    const rowA1 = await probeRow(ctx, targetFor(names, aliasA), B.marker); const after = await observeReader();
    need(after.startedAt === before.startedAt, 'reader-changed-during-gc');
    need(rowA1.objectId !== rowA0.objectId && rowA1.selectorId !== rowA0.selectorId && rowA1.runtimeId !== rowA0.runtimeId, 'reinstall-not-replaced');
    const retained = Object.entries(run.summary.retainedBytesByReason).filter(([, bytes]) => bytes > 0).map(([reason]) => reason);
    const object = (await ports.cache.probeStore({ targets: [], objects: [before.objectId] })).objects[0];
    const gc = { outcome: 'collected', engineKnown: true, registryKnown: true, writersKnown: true, selectedReaderProtected: object.present && object.treeMatches && retained.some(reason => ['container-mount', 'reader:container', 'admitted-record'].includes(reason)),
        selectedObjectId: before.objectId, retainedCount: retained.length };
    assertRetainedReader({ before: contract(before), during: contract(during.at(-1)), after: contract(after), gc });
    const observed = await observeAgain(ctx); state.generation = observed.activeGeneration;
    return { phase: 'U5', gc: { outcome: gc.outcome, removedCount: run.summary.removedCount, retainedReasons: retained }, readerUnchanged: true, duringObservations: during.length, aliasReplaced: true };
}

export { observeAgain, probeRow };
