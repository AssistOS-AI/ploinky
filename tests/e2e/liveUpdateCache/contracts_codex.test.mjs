import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const copies = value => structuredClone(value);
const hash = digit => digit.repeat(64);
const commit = digit => digit.repeat(40);
const now = Date.parse('2026-10-04T09:00:00.000Z');
const iso = milliseconds => new Date(milliseconds).toISOString();
const rejects = (operation, code) => assert.throws(operation, error => error.code === code);
const guards = fs.mkdtempSync(path.join(process.env.HOME, 'live-update-pure-'));
const bin = path.join(guards, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'podman'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
const priorPath = process.env.PATH;
process.env.PATH = `${bin}:${priorPath}`;
assert.equal(process.env.PATH.split(path.delimiter)[0], bin);
assert.equal(fs.lstatSync(path.join(bin, 'podman')).mode & 0o777, 0o700);
const originals = new Map();
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls += 1; throw new Error('pure-control-runtime-forbidden'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    originals.set(name, childProcess[name]); childProcess[name] = forbidden;
}
const priorKill = process.kill, priorFetch = globalThis.fetch;
process.kill = forbidden; globalThis.fetch = forbidden;
const networkGuards = [[net.Socket.prototype, 'connect'], [http, 'request'], [http, 'get'],
    [https, 'request'], [https, 'get'], [dgram, 'createSocket']].map(([owner, name]) => {
    const original = owner[name]; owner[name] = forbidden; return { owner, name, original };
});
syncBuiltinESMExports();
after(() => {
    for (const [name, value] of originals) childProcess[name] = value;
    for (const { owner, name, original } of networkGuards) owner[name] = original;
    process.kill = priorKill; globalThis.fetch = priorFetch; process.env.PATH = priorPath;
    syncBuiltinESMExports();
    fs.unlinkSync(path.join(bin, 'podman')); fs.rmdirSync(bin); fs.rmdirSync(guards);
    assert.equal(forbiddenCalls, 0, 'Contracts must not perform runtime actions');
});

const {
    PHASE_CAPS_MS, REQUIRED_PHASES, REQUIRED_GATES, TOTAL_CAP_MS,
    assertRequiredPhases, assertPhaseReceipts, admitRemainingSchedule, admitCanonicalFreshness,
    assertSameCandidate, assertLiveBefore, assertWarmReuse, assertDependencyReplacement,
    assertRetainedReader, assertOptionalFailureActivation, assertDeferredFailure,
    assertFunctionalToReleaseBoundary, assertCanonicalGateResults,
} = await import('./contracts_codex.mjs');

function candidate() {
    return { imageId: hash('a'), repositories: [
        { name: 'ploinky', commit: commit('b'), pushedCommit: commit('b'), branch: 'candidate', upstream: 'origin/candidate', clean: true, detached: false },
        { name: 'explorer', commit: commit('c'), pushedCommit: commit('c'), branch: 'main', upstream: 'origin/main', clean: true, detached: false },
    ] };
}

function live() {
    const expected = { workspace: { path: '/home/operator/work/testExplorerFresh', dev: 1, ino: 42, uid: 1000 },
        box: { id: hash('d'), imageId: hash('a'), startedAt: iso(now - 60000) }, candidate: candidate(),
        requiredGraph: ['router', 'probe'].map(name => ({ name, noWait: false, externalHealthRequired: true })),
        publications: 'router-media-only', sourceMounts: 'read-only-source', engineIdentity: 'selected-engine', activeGeneration: 'generation-1' };
    const observed = { ...copies(expected), hostPlatform: 'linux', engine: 'podman', rootless: true,
        running: true, initialized: true, activeGeneration: 'generation-1', pendingActivation: false, recoveryBarrier: false,
        graph: ['router', 'probe'].map(name => ({ name, ready: true, running: true, runtimeId: `${name}-runtime`,
            instanceId: `${name}-instance`, enableGeneration: 'enabled-1', graphGeneration: 'generation-1', externalHealth: true })) };
    return { expected, observed };
}

test('aggregate requires every phase, rejects individual skips and earlier-run receipts', () => {
    assert.equal(TOTAL_CAP_MS, 12960000);
    assertRequiredPhases([...REQUIRED_PHASES]);
    rejects(() => assertRequiredPhases(REQUIRED_PHASES.filter(phase => phase !== 'U4')), 'required-phases-invalid');
    const receipts = REQUIRED_PHASES.map((phase, index) => ({ phase, runId: 'current_codex', status: 'PASS', closed: true,
        uncertain: false, startedMs: index * 20, finishedMs: index * 20 + 10, evidenceSha256: hash('e') }));
    assertPhaseReceipts({ runId: 'current_codex', receipts });
    const earlier = copies(receipts); earlier[4].runId = 'previous_codex';
    rejects(() => assertPhaseReceipts({ runId: 'current_codex', receipts: earlier }), 'phase-receipt-invalid');
    const skipped = copies(receipts); skipped[5].status = 'SKIP';
    rejects(() => assertPhaseReceipts({ runId: 'current_codex', receipts: skipped }), 'phase-receipt-invalid');
});

test('schedule admits the exact full suffix and refuses one millisecond short', () => {
    assert.equal(admitRemainingSchedule({ firstPhase: 'U0', remainingMs: TOTAL_CAP_MS }), TOTAL_CAP_MS);
    rejects(() => admitRemainingSchedule({ firstPhase: 'U0', remainingMs: TOTAL_CAP_MS - 1 }), 'schedule-insufficient');
    const suffix = PHASE_CAPS_MS.U8 + PHASE_CAPS_MS.U9 + 5000;
    assert.equal(admitRemainingSchedule({ firstPhase: 'U8', remainingMs: suffix, finalReserveMs: 5000 }), suffix);
    rejects(() => admitRemainingSchedule({ firstPhase: 'skip-update', remainingMs: TOTAL_CAP_MS }), 'schedule-invalid');
});

test('late finalization cannot become complete acceptance', () => {
    const receipts = REQUIRED_PHASES.map((phase, index) => ({ phase, runId: 'late_codex', status: 'PASS', closed: true,
        uncertain: false, startedMs: index * 20, finishedMs: index * 20 + 10, evidenceSha256: hash('e') }));
    receipts.at(-1).startedMs = TOTAL_CAP_MS; receipts.at(-1).finishedMs = TOTAL_CAP_MS + 1;
    rejects(() => assertPhaseReceipts({ runId: 'late_codex', receipts }), 'acceptance-budget-expired');
});

test('metadata recapture and requested age overrides cannot renew old outer StartedAt', () => {
    const admission = { nowMs: now, boxStartedAt: iso(now - 60000), imageCreatedAt: iso(now - 120000), remainingWorkMs: 1740000 };
    admitCanonicalFreshness(admission);
    rejects(() => admitCanonicalFreshness({ ...admission, remainingWorkMs: 1740001 }), 'box-freshness-insufficient');
    rejects(() => admitCanonicalFreshness({ ...admission, boxStartedAt: iso(now - 1860000), maxAgeMs: 86400000 }), 'box-freshness-insufficient');
    rejects(() => admitCanonicalFreshness({ ...admission, imageCreatedAt: iso(now - 14400000) }), 'image-freshness-insufficient');
    rejects(() => admitCanonicalFreshness({ ...admission, boxStartedAt: iso(now + 1) }), 'box-freshness-insufficient');
});

test('candidate equality refuses unpushed, detached and changed participating repositories', () => {
    const before = candidate(), reordered = copies(before); reordered.repositories.reverse();
    assertSameCandidate(before, reordered);
    const unpushed = copies(before); unpushed.repositories[0].pushedCommit = commit('f');
    rejects(() => assertSameCandidate(before, unpushed), 'repository-not-pinned');
    const detached = copies(before); detached.repositories[1].detached = true;
    rejects(() => assertSameCandidate(before, detached), 'repository-not-pinned');
    const changed = copies(before); changed.repositories[1].commit = commit('e'); changed.repositories[1].pushedCommit = commit('e');
    rejects(() => assertSameCandidate(before, changed), 'candidate-epoch-mismatch');
});

test('live admission requires the selected Linux Box and complete ready graph before mutation', () => {
    assertLiveBefore(live());
    for (const [key, value, code] of [['running', false, 'workspace-not-live'], ['hostPlatform', 'darwin', 'runtime-host-unqualified'],
        ['pendingActivation', true, 'workspace-not-live'], ['rootless', false, 'runtime-host-unqualified']]) {
        const proof = live(); proof.observed[key] = value;
        rejects(() => assertLiveBefore(proof), code);
    }
    const missing = live(); missing.observed.graph.pop();
    rejects(() => assertLiveBefore(missing), 'graph-invalid');
    const duplicate = live(); duplicate.observed.graph[1] = copies(duplicate.observed.graph[0]);
    rejects(() => assertLiveBefore(duplicate), 'graph-invalid');
    const foreign = live(); foreign.observed.workspace.ino += 1;
    rejects(() => assertLiveBefore(foreign), 'live-binding-mismatch');
});

test('unknown and accessor-backed expectation fields are rejected without reading private values', () => {
    const extra = live(); extra.expected.secret = 'PRIVATE_SENTINEL';
    rejects(() => assertLiveBefore(extra), 'live-expectation-invalid');
    const getter = live(); let reads = 0;
    Object.defineProperty(getter.expected, 'candidate', { get() { reads += 1; throw new Error('PRIVATE_SENTINEL'); }, enumerable: true });
    rejects(() => assertLiveBefore(getter), 'live-expectation-invalid');
    assert.equal(reads, 0);
});

test('old no-running-workspace alternative reproduces false acceptance, new live activation refuses it', () => {
    const old = /Activation: the workspace graph was restarted and the Router health check passed\.|Activation not required; no configured running workspace required a restart\./;
    assert.equal(old.test('Activation not required; no configured running workspace required a restart.'), true);
    const proof = { exitCode: 1, beforeGeneration: 'before', afterGeneration: 'after', activation: 'restarted', graphReady: true, writerQuiescent: true };
    assertOptionalFailureActivation(proof);
    rejects(() => assertOptionalFailureActivation({ ...proof, activation: 'not-required', graphReady: false }), 'optional-live-activation-missing');
    rejects(() => assertOptionalFailureActivation({ ...proof, afterGeneration: 'before' }), 'optional-live-activation-missing');
    rejects(() => assertOptionalFailureActivation({ ...proof, writerQuiescent: false }), 'optional-live-activation-missing');
});

test('unknown required membership must exit1 and defer with the original generation intact', () => {
    const proof = { exitCode: 1, beforeGeneration: 'held', afterGeneration: 'held', activation: 'deferred', pending: true, writerQuiescent: true };
    assertDeferredFailure(proof);
    rejects(() => assertDeferredFailure({ ...proof, exitCode: 0 }), 'required-deferral-missing');
    rejects(() => assertDeferredFailure({ ...proof, afterGeneration: 'restarted' }), 'required-deferral-missing');
    rejects(() => assertDeferredFailure({ ...proof, pending: false }), 'required-deferral-missing');
});

test('warm reuse refuses object, runtime, selector or payload replacement', () => {
    const before = { runtimeId: 'runtime', instanceId: 'instance', enableGeneration: 'enable', objectId: 'object', selectorId: 'selector', payloadSha256: hash('a') };
    assertWarmReuse(before, copies(before));
    for (const [key, value] of [['runtimeId', 'other'], ['objectId', 'other'], ['selectorId', 'other'], ['payloadSha256', hash('b')]]) {
        rejects(() => assertWarmReuse(before, { ...before, [key]: value }), 'warm-reuse-mismatch');
    }
});

test('moving same-version Git requires installed marker, lock and provenance changes, preserving any predecessor', () => {
    const expectedA = { commit: commit('a'), markerSha256: hash('b') }, expectedB = { commit: commit('c'), markerSha256: hash('d') };
    const installed = (expected, objectId) => ({ version: '1.0.0', objectId, sourceCommit: expected.commit,
        lockCommit: expected.commit, provenanceCommit: expected.commit, markerSha256: expected.markerSha256,
        payloadSha256: objectId === 'old' ? hash('e') : hash('f') });
    const before = installed(expectedA, 'old'), after = installed(expectedB, 'new');
    const proof = { before, after, expectedA, expectedB, predecessor: { objectId: 'old', payloadSha256: hash('e') } };
    assertDependencyReplacement(proof);
    rejects(() => assertDependencyReplacement({ ...proof, after: { ...after, payloadSha256: before.payloadSha256 } }), 'replacement-not-observed');
    rejects(() => assertDependencyReplacement({ ...proof, after: { ...after, markerSha256: before.markerSha256 } }), 'installed-replacement-mismatch');
    rejects(() => assertDependencyReplacement({ ...proof, after: { ...after, lockCommit: expectedA.commit } }), 'installed-replacement-mismatch');
    rejects(() => assertDependencyReplacement({ ...proof, predecessor: { ...proof.predecessor, payloadSha256: hash('f') } }), 'predecessor-mutated');
    assertDependencyReplacement({ ...proof, predecessor: null });
});

test('receipt-only and skipped collection cannot establish an independently live retained reader', () => {
    const before = { live: true, runtimeId: 'reader', instanceId: 'instance', enableGeneration: 'enable', objectId: 'old-object',
        mountSource: '/selected/store/old-object', mountReadOnly: true, payloadSha256: hash('a'),
        readerReceipt: { runtimeId: 'reader', instanceId: 'instance', enableGeneration: 'enable', objectId: 'old-object' } };
    const gc = { outcome: 'collected', engineKnown: true, registryKnown: true, writersKnown: true,
        selectedReaderProtected: true, selectedObjectId: 'old-object', retainedCount: 1 };
    const proof = { before, during: copies(before), after: copies(before), gc };
    assertRetainedReader(proof);
    rejects(() => assertRetainedReader({ ...proof, gc: { ...gc, outcome: 'skipped' } }), 'ordinary-gc-not-proven');
    rejects(() => assertRetainedReader({ ...proof, during: { ...before, live: false } }), 'reader-not-live');
    rejects(() => assertRetainedReader({ ...proof, after: { ...before, mountReadOnly: false } }), 'reader-not-live');
    rejects(() => assertRetainedReader({ ...proof, after: { ...before, payloadSha256: hash('b') } }), 'reader-changed-during-gc');
});

function boundary() {
    const functional = { complete: true, writerQuiescent: true, cleanupComplete: true, copiesVerified: true,
        browserGateCredit: 0, boxId: 'functional-box', workspaceIdentity: 'functional-inode', finishedAt: iso(now), candidate: candidate() };
    const release = { fresh: true, workspaceRecreated: true, boxId: 'release-box', workspaceIdentity: 'release-inode',
        startedAt: iso(now + 1), candidate: candidate() };
    return { functional, release };
}

test('fresh release boundary requires settled functional cleanup and identical candidate map/image', () => {
    assertFunctionalToReleaseBoundary(boundary());
    const unresolved = boundary(); unresolved.functional.writerQuiescent = false;
    rejects(() => assertFunctionalToReleaseBoundary(unresolved), 'functional-epoch-unsettled');
    const reused = boundary(); reused.release.boxId = reused.functional.boxId;
    rejects(() => assertFunctionalToReleaseBoundary(reused), 'release-fixture-not-fresh');
    const changed = boundary(); changed.release.candidate.imageId = hash('b');
    rejects(() => assertFunctionalToReleaseBoundary(changed), 'candidate-epoch-mismatch');
});

test('canonical gate aggregate rejects stale epochs, duplicate runs, skips and changed outer bindings', () => {
    const { release } = boundary();
    const gates = REQUIRED_GATES.map((name, index) => ({ name, runId: `gate-${index}`, discovered: 1, passed: 1,
        failed: 0, skipped: 0, retries: 0, ignoredErrors: 0, closed: true, before: copies(release), after: copies(release),
        startedAt: iso(now + 2 + index * 10), finishedAt: iso(now + 9 + index * 10) }));
    assertCanonicalGateResults({ release, gates });
    const skipped = copies(gates); skipped[1].skipped = 1;
    rejects(() => assertCanonicalGateResults({ release, gates: skipped }), 'canonical-gate-invalid');
    const old = copies(gates); old[0].before.boxId = 'prior-box';
    rejects(() => assertCanonicalGateResults({ release, gates: old }), 'canonical-gate-stale');
    const changed = copies(gates); changed[1].after.startedAt = iso(now + 50);
    rejects(() => assertCanonicalGateResults({ release, gates: changed }), 'canonical-gate-stale');
    const reused = copies(gates); reused[2].runId = reused[0].runId;
    rejects(() => assertCanonicalGateResults({ release, gates: reused }), 'canonical-gate-invalid');
    const overlap = copies(gates); overlap[1].startedAt = overlap[0].startedAt;
    rejects(() => assertCanonicalGateResults({ release, gates: overlap }), 'canonical-gate-stale');
    const reversed = copies(gates); reversed[2].startedAt = iso(now + 2); reversed[2].finishedAt = iso(now + 3);
    rejects(() => assertCanonicalGateResults({ release, gates: reversed }), 'canonical-gate-stale');
});

test('no-wait requires the expected declaration and every runtime joins the selected active generation', () => {
    const spoof = live(); spoof.observed.graph[0].ready = false; spoof.observed.graph[0].terminal = 'declared-no-wait';
    rejects(() => assertLiveBefore(spoof), 'graph-not-ready');
    const declared = live(); declared.expected.requiredGraph[1].noWait = true;
    declared.observed.graph[1].noWaitState = 'running';
    assertLiveBefore(declared);
    const old = live(); old.observed.graph[1].graphGeneration = 'previous-generation';
    rejects(() => assertLiveBefore(old), 'graph-not-ready');
    const changed = live(); changed.observed.activeGeneration = 'different-generation';
    rejects(() => assertLiveBefore(changed), 'workspace-not-live');
});

test('strict calendar and workspace parsing refuses normalization and control-character paths', () => {
    const admission = { nowMs: Date.parse('2026-03-03T09:00:00.000Z'), boxStartedAt: '2026-02-31T09:00:00.000Z',
        imageCreatedAt: '2026-03-03T09:00:00.000Z', remainingWorkMs: 1 };
    rejects(() => admitCanonicalFreshness(admission), 'timestamp-invalid');
    rejects(() => admitCanonicalFreshness({ ...admission, boxStartedAt: '2026-03-03T24:00:00.000Z' }), 'timestamp-invalid');
    for (const character of ['\0', '\r', '\n']) {
        const proof = live(); proof.expected.workspace.path = `/home/operator${character}/work/testExplorerFresh`;
        proof.observed.workspace.path = proof.expected.workspace.path;
        rejects(() => assertLiveBefore(proof), 'workspace-binding-invalid');
    }
});

test('nested candidate accessors are rejected before comparing the Box image', () => {
    const proof = live(); let reads = 0;
    Object.defineProperty(proof.expected.candidate, 'imageId', { get() { reads += 1; throw new Error('PRIVATE_SENTINEL'); }, enumerable: true });
    rejects(() => assertLiveBefore(proof), 'candidate-invalid');
    assert.equal(reads, 0);
});

test('declared no-wait terminal failure or absent physical runtime never becomes readiness success', () => {
    const proof = live(); proof.expected.requiredGraph[1].noWait = true;
    proof.observed.graph[1].noWaitState = 'running';
    assertLiveBefore(proof);
    for (const state of ['failed', 'starting', 'unreadable', undefined]) {
        const failed = copies(proof); failed.observed.graph[1].noWaitState = state;
        rejects(() => assertLiveBefore(failed), 'graph-not-ready');
    }
    const stopped = copies(proof); stopped.observed.graph[1].running = false;
    rejects(() => assertLiveBefore(stopped), 'graph-not-ready');
    const missingTuple = copies(proof); delete missingTuple.observed.graph[1].runtimeId;
    rejects(() => assertLiveBefore(missingTuple), 'graph-not-ready');
});
