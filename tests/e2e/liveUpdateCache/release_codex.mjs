import { isDeepStrictEqual } from 'node:util';
import { need } from './manifest_codex.mjs';
import { REQUIRED_GATES, admitCanonicalFreshness, assertFunctionalToReleaseBoundary, assertCanonicalGateResults, assertLiveBefore, assertSameCandidate } from './contracts_codex.mjs';
import { expectedLiveFromManifest } from './live_admission_codex.mjs';
import { remainingGateWorkMs } from './gates_codex.mjs';

// U7c-U9: the release epoch. The functional epoch has been settled, frozen and cleaned; a fresh canonical fixture was
// then created under its own grant. This module never deploys, destroys or recreates anything: it verifies that the
// deployment now running is a different Box over a recreated workspace with the identical pushed commit map and
// immutable image, admits it from scratch, and only then runs the three gates against it, in the fixed order.
const identityOf = observed => `${observed.workspace.dev}:${observed.workspace.ino}`;
const candidateOf = (observed, imageId) => ({ imageId, repositories: observed.candidate.repositories });

export function functionalRecord({ manifest, observed, finishedAt, frozen, cleanupComplete }) {
    return Object.freeze({ complete: frozen === true, writerQuiescent: true, cleanupComplete: cleanupComplete === true, copiesVerified: frozen === true, browserGateCredit: 0, boxId: manifest.box.id, startedAt: manifest.box.startedAt,
        finishedAt, workspaceIdentity: identityOf(observed), candidate: candidateOf(observed, manifest.box.imageId), generation: manifest.box.activeGeneration });
}

export function createReleasePhases(ctx) {
    const { manifest, ports, state } = ctx;
    // An epoch observation: the Box, workspace and candidate bindings that assertCanonicalGateResults compares, plus the
    // active edge generation and every required runtime's identity tuple, which must not move except in one bracket.
    async function epoch(observer, release, { generation } = {}) {
        const observed = await observer.observe(), expected = expectedLiveFromManifest(release); expected.activeGeneration = generation ?? observed.activeGeneration;
        assertLiveBefore({ expected, observed });
        return Object.freeze({ boxId: observed.box.id, startedAt: observed.box.startedAt, workspaceIdentity: identityOf(observed), candidate: candidateOf(observed, release.box.imageId),
            generation: observed.activeGeneration, runtimes: observed.graph.map(row => [row.name, row.runtimeId, row.instanceId, row.enableGeneration]) });
    }
    const sameState = (left, right) => left.generation === right.generation && isDeepStrictEqual(left.runtimes, right.runtimes);
    return {
        async U7c() {
            const functional = state.functional; need(functional, 'functional-epoch-missing');
            const release = await ports.release.load(); state.releaseManifest = release;
            need(release.runId !== manifest.runId && release.evidence.root !== manifest.evidence.root && release.workspace.path === manifest.workspace.path && release.mode === manifest.mode
                && release.host.target === manifest.host.target && release.engine.identity === manifest.engine.identity, 'release-manifest-binding');
            const observer = ports.release.observerFor(release); state.releaseObserver = observer;
            const admission = await observer.admit(); const entry = await epoch(observer, release);
            assertFunctionalToReleaseBoundary({ functional, release: { fresh: true, workspaceRecreated: entry.workspaceIdentity !== functional.workspaceIdentity, boxId: entry.boxId, startedAt: entry.startedAt, workspaceIdentity: entry.workspaceIdentity, candidate: entry.candidate } });
            need(release.box.imageId === manifest.box.imageId && isDeepStrictEqual(release.candidate.repositories.map(repo => [repo.name, repo.commit, repo.branch]), manifest.candidate.repositories.map(repo => [repo.name, repo.commit, repo.branch])), 'release-candidate-mismatch');
            state.release = entry;
            return { phase: 'U7c', fresh: true, workspaceRecreated: true, sameCandidate: true, sameImage: true, generation: admission.activeGeneration, browserGateCredit: 0 };
        },
        async U8() {
            const release = state.releaseManifest, observer = state.releaseObserver, gates = []; let known = state.release;
            for (const [index, gate] of REQUIRED_GATES.entries()) {
                ctx.check();
                // Nothing may move between gates: the epoch about to be used is the epoch last proved.
                const before = await epoch(observer, release, { generation: known.generation }); need(sameState(before, known), 'canonical-epoch-changed');
                // The remaining validity must cover every gate still to run; it is never renewed by re-reading metadata.
                admitCanonicalFreshness({ nowMs: ctx.wallNow(), boxStartedAt: release.box.startedAt, imageCreatedAt: release.box.imageCreatedAt, remainingWorkMs: remainingGateWorkMs(REQUIRED_GATES.slice(index)) });
                const row = await ports.gates.run(gate);
                need(row.discovered === 1 && row.passed === 1 && row.failed === 0 && row.skipped === 0 && row.retries === 0 && row.ignoredErrors === 0, 'canonical-gate-invalid');
                // Only OnlyOffice performs targeted restarts; its change is accepted once and must then be stable, so the next
                // gate starts from an observed, refreshed epoch. Copilot and WebMeet must leave the epoch exactly as they found it.
                let after;
                if (gate === 'OnlyOffice') {
                    after = await epoch(observer, release); const refreshed = await epoch(observer, release, { generation: after.generation }); need(sameState(refreshed, after), 'canonical-epoch-changed');
                } else { after = await epoch(observer, release, { generation: known.generation }); need(sameState(after, before), 'canonical-epoch-changed'); }
                known = after; gates.push({ ...row, before, after });
            }
            assertCanonicalGateResults({ release: state.release, gates }); state.gates = gates;
            return { phase: 'U8', gates: gates.map(gate => ({ name: gate.name, runId: gate.runId, discovered: gate.discovered, passed: gate.passed, skipped: gate.skipped, retries: gate.retries, ignoredErrors: gate.ignoredErrors })) };
        },
        async U9() {
            need(ctx.latchClean(), 'writers-not-quiescent');
            const browser = await ports.browser.close(); const open = ports.custody.snapshot().filter(row => !row.settled);
            need(open.length === 0 && ports.browser.openContexts() === 0 && ports.fixture.state().prepared === false && ports.fixture.state().container === null, 'owned-resource-unsettled');
            return { phase: 'U9', browserClosed: browser.closed === true, unsettledCommands: 0, openContexts: 0, ownedServer: 'absent', ownedFiles: 'absent' };
        },
    };
}

export { assertSameCandidate };
