import { isDeepStrictEqual } from 'node:util';
import { need } from './manifest_codex.mjs';
import { CAMPAIGN_RESERVES_MS, REQUIRED_GATES, RELEASE_GENERATIONS, admitCanonicalFreshness, admitCampaignImageReserve, assertFunctionalToReleaseBoundary, assertReleaseGenerations,
    assertCanonicalGateResults, assertLiveBefore, assertSameCandidate } from './contracts_codex.mjs';
import { expectedLiveFromManifest } from './live_admission_codex.mjs';
import { remainingGenerationWorkMs } from './gates_codex.mjs';
import { runActivationPhase, sameState, assertRegistryMembership } from './activation_codex.mjs';
import { gpuWiringIdentityOf } from './engine_codex.mjs';

// U7c-U9: the release epoch is two fresh generations. R1 (never activated) runs the baseline-graph Copilot gate; R2 is
// activated by the runner-owned UA phase and then runs OnlyOffice and WebMeet. This module never deploys, destroys or
// recreates anything: it verifies that each deployment now running is a different Box over a recreated workspace with the
// identical pushed commit map and immutable image, admits it from scratch, and only then runs its gates, in the fixed order.
export const ONLYOFFICE_AGENT = 'onlyOffice';
const identityOf = observed => `${observed.workspace.dev}:${observed.workspace.ino}`;
const candidateOf = (observed, imageId) => ({ imageId, repositories: observed.candidate.repositories });
const labelled = manifest => manifest.engine.gpuWiringIdentity !== gpuWiringIdentityOf({});

export function functionalRecord({ manifest, observed, finishedAt, frozen, cleanupComplete }) {
    return Object.freeze({ complete: frozen === true, writerQuiescent: true, cleanupComplete: cleanupComplete === true, copiesVerified: frozen === true, browserGateCredit: 0, boxId: manifest.box.id, startedAt: manifest.box.startedAt,
        finishedAt, workspaceIdentity: identityOf(observed), candidate: candidateOf(observed, manifest.box.imageId), generation: manifest.box.activeGeneration });
}

export function createReleasePhases(ctx) {
    const { manifest, ports, state } = ctx;
    // An epoch observation: the Box, workspace and candidate bindings that assertCanonicalGateResults compares, plus the
    // active edge generation and every required runtime's identity tuple, which must not move except in one bracket.
    // `addedGraph` (R2 after the activation) extends the required graph by the three declared optional runtimes.
    async function epoch(observer, release, { generation, addedGraph } = {}) {
        need(!addedGraph || Array.isArray(release.activation), 'activation-declaration');
        const added = addedGraph ? release.activation : undefined;
        const observed = await observer.observe({ addedGraph: added }), expected = expectedLiveFromManifest(release, added); expected.activeGeneration = generation ?? observed.activeGeneration;
        assertLiveBefore({ expected, observed });
        // The whole registry must be exactly the expected agent set: this is the only observation of agents outside the probed rows.
        assertRegistryMembership({ registryAgents: observed.registryAgents, release, afterActivation: Boolean(addedGraph) });
        return Object.freeze({ boxId: observed.box.id, startedAt: observed.box.startedAt, workspaceIdentity: identityOf(observed), candidate: candidateOf(observed, release.box.imageId),
            generation: observed.activeGeneration, runtimes: observed.graph.map(row => [row.name, row.runtimeId, row.instanceId, row.enableGeneration]) });
    }
    // The OnlyOffice gate restarts only the OnlyOffice agent (`ploinky restart onlyOffice`). Inside that window the edge
    // generation and the row(s) identifying that agent may change; every other required runtime must be exactly as before.
    const onlyOfficeRow = row => row[0].split('/').at(-1) === ONLYOFFICE_AGENT;
    const restartWindowOk = (left, right) => left.runtimes.length === right.runtimes.length
        && left.runtimes.every((row, index) => row[0] === right.runtimes[index][0] && (onlyOfficeRow(row) || isDeepStrictEqual(row, right.runtimes[index])));
    const bindToFunctional = release => {
        need(release.runId !== manifest.runId && release.evidence.root !== manifest.evidence.root && release.workspace.path === manifest.workspace.path && release.mode === manifest.mode
            && release.host.target === manifest.host.target && release.engine.identity === manifest.engine.identity, 'release-manifest-binding');
        // A different image or one different pushed commit in the declared manifests is a candidate mismatch before anything is observed.
        need(release.box.imageId === manifest.box.imageId && isDeepStrictEqual(release.candidate.repositories.map(repo => [repo.name, repo.commit, repo.branch]), manifest.candidate.repositories.map(repo => [repo.name, repo.commit, repo.branch])), 'release-candidate-mismatch');
    };
    const boundary = (functional, entry) => assertFunctionalToReleaseBoundary({ functional, release: { fresh: true, workspaceRecreated: entry.workspaceIdentity !== functional.workspaceIdentity, boxId: entry.boxId,
        startedAt: entry.startedAt, workspaceIdentity: entry.workspaceIdentity, candidate: entry.candidate } });

    // One generation's gates, in order. The epoch about to be used is the epoch last proved; the remaining validity is the work still to run
    // inside THIS generation (never renewed by re-reading metadata); only OnlyOffice may move the epoch, once, and then it must be stable.
    async function runGenerationGates({ genId, gates, release, observer, known, addedGraph, reserveMs, recheck }) {
        const rows = [];
        for (const gate of gates) {
            ctx.check();
            const before = await epoch(observer, release, { generation: known.generation, addedGraph }); need(sameState(before, known), 'canonical-epoch-changed');
            const nowMs = ctx.wallNow(), generationRemainingMs = remainingGenerationWorkMs(genId, gate);
            admitCanonicalFreshness({ nowMs, boxStartedAt: release.box.startedAt, imageCreatedAt: release.box.imageCreatedAt, remainingWorkMs: generationRemainingMs });
            const admission = { gate, boxAgeMs: nowMs - Date.parse(release.box.startedAt), generationRemainingMs, imageAgeMs: nowMs - Date.parse(release.box.imageCreatedAt), campaignReserveMs: reserveMs(gate) };
            if (recheck) await recheck();
            const row = await ports.gates.run(gate);
            need(row.discovered === 1 && row.passed === 1 && row.failed === 0 && row.skipped === 0 && row.retries === 0 && row.ignoredErrors === 0, 'canonical-gate-invalid');
            let after;
            if (gate === 'OnlyOffice') {
                after = await epoch(observer, release, { addedGraph }); need(restartWindowOk(before, after), 'canonical-epoch-changed');
                const refreshed = await epoch(observer, release, { generation: after.generation, addedGraph }); need(sameState(refreshed, after), 'canonical-epoch-changed');
            } else { after = await epoch(observer, release, { generation: known.generation, addedGraph }); need(sameState(after, before), 'canonical-epoch-changed'); }
            known = after; rows.push({ ...row, before, after, admission });
        }
        return rows;
    }
    const gateEvidence = gate => ({ name: gate.name, runId: gate.runId, discovered: gate.discovered, passed: gate.passed, skipped: gate.skipped, retries: gate.retries, ignoredErrors: gate.ignoredErrors,
        before: { generation: gate.before.generation, runtimes: gate.before.runtimes }, after: { generation: gate.after.generation, runtimes: gate.after.runtimes } });

    return {
        async U7c() {
            const functional = state.functional; need(functional, 'functional-epoch-missing');
            const release = await ports.release.load('R1'); need(release.activation === null, 'release-manifest-binding');
            bindToFunctional(release); state.release1Manifest = release;
            const observer = ports.release.observerFor(release);
            const admission = await observer.admit(); const entry = await epoch(observer, release);
            boundary(functional, entry);
            state.r1 = { manifest: release, observer, known: entry };
            return { phase: 'U7c', fresh: true, workspaceRecreated: true, sameCandidate: true, sameImage: true, generation: admission.activeGeneration, boxName: release.box.name, browserGateCredit: 0 };
        },
        // R1: the unactivated baseline-graph Copilot gate, then the record that invocation 3 binds to.
        async U8a() {
            const r1 = state.r1; need(r1, 'release-epoch1-missing');
            admitCampaignImageReserve({ nowMs: ctx.wallNow(), imageCreatedAt: r1.manifest.box.imageCreatedAt, reserveMs: CAMPAIGN_RESERVES_MS.B2 });
            const rows = await runGenerationGates({ genId: 'R1', gates: RELEASE_GENERATIONS[0].gates, release: r1.manifest, observer: r1.observer, known: r1.known, reserveMs: () => CAMPAIGN_RESERVES_MS.B2 });
            const [copilot] = rows;
            state.release1Record = Object.freeze({ boxId: r1.known.boxId, boxName: r1.manifest.box.name, startedAt: r1.known.startedAt, workspaceIdentity: r1.known.workspaceIdentity, candidate: r1.known.candidate, generation: copilot.after.generation,
                imageId: r1.manifest.box.imageId, gpuGrantLabelPresent: labelled(r1.manifest), copilotGate: copilot });
            return { phase: 'U8a', gates: rows.map(gateEvidence), admissions: rows.map(row => row.admission) };
        },
        // R2: a different Box over a recreated workspace, in time order after the Copilot gate, with the identical candidate.
        async U7d() {
            const functional = state.functional, r1 = state.release1Record; need(functional && r1, 'release-epoch1-missing');
            const release = await ports.release.load('R2'); need(Array.isArray(release.activation), 'release-manifest-binding');
            bindToFunctional(release);
            const observer = ports.release.observerFor(release);
            const admission = await observer.admit(); const entry = await epoch(observer, release);
            boundary(functional, entry);
            assertReleaseGenerations({ functional, r1: { boxId: r1.boxId, workspaceIdentity: r1.workspaceIdentity, startedAt: r1.startedAt, candidate: r1.candidate }, r2: entry, copilotFinishedAt: r1.copilotGate.finishedAt });
            state.r2 = { manifest: release, observer, known: entry, u7dFinishedAt: ctx.wallNow() };
            return { phase: 'U7d', fresh: true, workspaceRecreated: true, distinctFromR1: true, sameCandidate: true, sameImage: true, generation: admission.activeGeneration, boxName: release.box.name, browserGateCredit: 0 };
        },
        // The one runner-owned activation (UA-0 install, UA-1 Marketplace command, receipt, change window).
        async UA() {
            const r2 = state.r2; need(r2, 'release-epoch2-missing');
            const result = await runActivationPhase({ release: r2.manifest, known: r2.known, u7dFinishedAt: r2.u7dFinishedAt, port: ports.activation, wallNow: ctx.wallNow, check: ctx.check,
                epoch: options => epoch(r2.observer, r2.manifest, options) });
            Object.assign(r2, { known: result.after, activated: true, place: result.place, postObservedAt: ctx.wallNow() });
            state.activation = { receiptSha256: result.receipt.receiptSha256, before: { generation: result.before.generation, runtimes: result.before.runtimes }, after: { generation: result.after.generation, runtimes: result.after.runtimes },
                install: { exitCode: result.install.exitCode, clean: result.install.clean === true } };
            return { phase: 'UA', activation: state.activation };
        },
        // R2 gates on the activated graph. The activation receipt is re-checked before each, so a Box restart invalidates the proof.
        async U8b() {
            const r2 = state.r2, r1 = state.release1Record; need(r2?.activated === true && r1, 'activation-missing');
            const recheck = () => ports.activation.verify({ release2: r2.manifest, place: r2.place, u7dFinishedAt: r2.u7dFinishedAt, postObservedAt: r2.postObservedAt });
            const rows = await runGenerationGates({ genId: 'R2', gates: RELEASE_GENERATIONS[1].gates, release: r2.manifest, observer: r2.observer, known: r2.known, addedGraph: true,
                reserveMs: gate => (gate === 'OnlyOffice' ? CAMPAIGN_RESERVES_MS.B3 : 0), recheck });
            const gates = [r1.copilotGate, ...rows], epochOf = row => ({ boxId: row.boxId, startedAt: row.startedAt, workspaceIdentity: row.workspaceIdentity, candidate: row.candidate });
            need(gates.length === REQUIRED_GATES.length, 'canonical-gates-incomplete');
            assertCanonicalGateResults({ releases: { R1: epochOf(r1), R2: epochOf(r2.known) }, gates });
            state.gates = gates; state.admissions = gates.map(gate => gate.admission);
            state.releaseGenerations = [{ id: 'R1', boxId: r1.boxId, boxName: r1.boxName, startedAt: r1.startedAt, imageId: r1.imageId, gpuGrantLabelPresent: r1.gpuGrantLabelPresent },
                { id: 'R2', boxId: r2.known.boxId, boxName: r2.manifest.box.name, startedAt: r2.known.startedAt, imageId: r2.manifest.box.imageId, gpuGrantLabelPresent: labelled(r2.manifest) }];
            return { phase: 'U8b', gates: rows.map(gateEvidence), admissions: rows.map(row => row.admission) };
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
