import { manifestFixture, H } from './test_support_codex.mjs';
import { expectedLiveFromManifest } from './live_admission_codex.mjs';
import { fixtureNames } from './git_fixture_codex.mjs';
import { createFunctionalPhases } from './phases_functional_codex.mjs';
import { ownedRegistration } from './owned_ids_codex.mjs';
import { validateExpectation } from './execution_codex.mjs';

// Test-only simulation of the product behaviours the functional phases depend on. It is the control's stand-in for the
// runtime, never a runtime path: faults flip single behaviours so each refusal can be shown to trigger.
export function createWorld(faults = {}) {
    const { value: manifest } = manifestFixture(); const names = fixtureNames(manifest.runId);
    manifest.graph = [{ name: 'AssistOSExplorer/explorer', repository: 'AssistOSExplorer', noWait: false, externalHealthRequired: true, declaredEnableFlags: [], manifestSha256: H('m1') }];
    const world = { manifest, names, generation: 'gen-1', counter: 0, publicConfig: { staticAgent: 'explorer', staticPort: 8080 }, calls: [], runtimes: new Map(), objects: new Map(), commits: {}, registered: false, delays: 0, faults };
    const id = label => H(`${label}-${world.counter++}`), object = () => `00000000-0000-4000-8000-${String(world.counter++).padStart(12, '0')}`;
    const addObject = (payload, extra = {}) => { const objectId = object(); world.objects.set(objectId, { present: true, treeMatches: true, payloadSha256: H(`${payload}-${objectId}`), ...extra }); return objectId; };
    const graphObject = addObject('graph');
    world.runtimes.set('g0', { repoName: 'AssistOSExplorer', agentName: 'explorer', alias: null, runtimeId: H('graph-runtime'), instanceId: 'g-inst', enableGeneration: 'g-en', objectId: graphObject, selectorId: H('graph-sel'), running: true });
    const bump = () => { world.generation = `gen-${world.counter++}`; };
    const full = runtime => ({ label: runtime.alias ?? 'primary', containerName: runtime.alias ? `ploinky_alias_${runtime.alias}` : (faults.wrongContainerName ? 'ploinky_other' : ownedRegistration(manifest).containerName), runtimeId: runtime.runtimeId, startedAt: runtime.startedAt ?? '2026-10-04T12:00:00Z', instanceId: runtime.instanceId, enableGeneration: runtime.enableGeneration, running: runtime.running, labelsEqual: true,
        objectId: runtime.objectId, selectorId: runtime.selectorId, version: '1.0.0', sourceCommit: runtime.commit, provenanceCommit: runtime.commit, lockCommit: runtime.commit, markerSha256: runtime.markerSha256, payloadSha256: world.objects.get(runtime.objectId).payloadSha256,
        treeMatchesManifest: true, installerKind: 'container-npm', verification: 'remote-verified', readerReceipt: faults.noReceipt ? null : { runtimeId: runtime.runtimeId, instanceId: runtime.instanceId, enableGeneration: runtime.enableGeneration, objectId: runtime.objectId },
        receiptCount: 1, mountSource: `/ws/.ploinky/deps/store/objects/${runtime.objectId}/payload/node_modules`, mountReadOnly: true });
    const fixture = { names, url: repo => `http://x/${repo}`, packageUrl: 'git+http://x/pkg', agentUrl: 'http://x/agent', async prepare() { world.calls.push('fixture-prepare'); },
        async publishPackage(label, marker) { const commit = H(`commit-${label}`).slice(0, 40); world.commits[label] = { commit, markerSha256: H(`marker-${label}`), marker }; return world.commits[label]; },
        async publishAgent() { return H('agent-commit').slice(0, 40); }, async startServer() { world.calls.push('fixture-start'); return H('server'); }, async reachableFromBox() { return faults.unreachable !== true; },
        recoverySnapshot() { return { runId: manifest.runId, container: { id: H('server') }, repository: { key: names.repoName, url: 'http://x/agent' }, aliases: [...names.aliases] }; }, state: () => ({ prepared: world.calls.includes('fixture-prepare') && !world.calls.includes('fixture-cleanup'), container: world.calls.includes('fixture-start') && !world.calls.includes('fixture-cleanup') ? H('server') : null }),
        async cleanup() { world.calls.push('fixture-cleanup'); return { server: 'removed', files: 'removed' }; } };
    const runtimeFor = alias => [...world.runtimes.values()].find(runtime => runtime.alias === alias && runtime.repoName === names.repoName);
    const enable = alias => { const label = alias ? 'B' : (world.commits.B ? 'B' : 'A'), commit = world.commits[label];
        // Aliases of identical current inputs share the primary's object unless a fault gives each its own.
        const objectId = alias ? (faults.freshObjectPerAlias ? addObject(`alias-${alias}`) : world.runtimes.get('primary').objectId) : addObject(`pkg-${label}`);
        world.runtimes.set(alias ?? 'primary', { repoName: names.repoName, agentName: names.agentName, alias, runtimeId: id(`rt-${alias ?? 'primary'}`), instanceId: `inst-${world.counter++}`, enableGeneration: `en-${world.counter++}`,
            objectId, selectorId: H(`sel-${world.counter++}`), running: true, commit: commit.commit, markerSha256: commit.markerSha256, marker: commit.marker }); bump(); };
    world.recovered = [];
    // A non-owned graph registration (e.g. a no-wait agent with a Git dependency) also gets a Git-pin record in every real update.
    const nonOwnedPin = '9'.repeat(64), nonOwnedRegistration = 'ploinky_AssistOSExplorer_soplangAgent_testExplorerFresh_1f39122c';
    const ports = {
        recovery: { record(label, value) { world.calls.push(`recovery:${label}`); world.recovered.push({ label, value }); return `recovery_${world.recovered.length}_${label}_codex.json`; } },
        clock: { delay: async ms => { world.delays += 1; } },
        fixture,
        observer: { async admit() { return { phase: 'U0', admitted: true, activeGeneration: world.generation, runtimes: 1 }; },
            async observe() { const expected = expectedLiveFromManifest(manifest);
                return { hostPlatform: 'linux', engine: 'podman', rootless: true, running: true, initialized: true, activeGeneration: world.generation, pendingActivation: world.pending === true, recoveryBarrier: false, workspace: { ...expected.workspace }, box: { ...expected.box },
                    candidate: structuredClone(expected.candidate), publications: expected.publications, sourceMounts: expected.sourceMounts, engineIdentity: expected.engineIdentity,
                    graph: manifest.graph.map(entry => ({ name: entry.name, graphGeneration: world.generation, running: true, runtimeId: 'rt', instanceId: 'inst', enableGeneration: 'en', ready: faults.graphNotReady !== true, externalHealth: true, noWaitState: null })),
                    publicConfig: faults.configChanges && world.generation !== 'gen-1' ? { staticAgent: 'other', staticPort: 8080 } : { ...world.publicConfig }, activation: { generation: world.generation, activationId: 'act' } }; } },
        browser: { async createMarker() { world.calls.push('browser-create'); return { phase: 'U1', uploaded: true, previewed: true, storageProved: true }; }, async verifyMarker() { world.calls.push('browser-verify'); return { phase: 'U7', storageProved: true, previewed: true }; } },
        workerHost: { async update(operation, expected, admitted = []) { world.calls.push(`update:${operation}`);
            // A real update emits the owned repository record and, with its registration enabled, the Git-pin record; the
            // expectation must name exactly those ids (and none else), or the update would be refused as incomplete.
            validateExpectation(expected, manifest, { admitted }); const owned = ownedRegistration(manifest);
            const produced = ['workspace-graph', owned.repoName, nonOwnedPin, ...(world.runtimes.has('primary') ? [owned.pinId] : [])];
            if (JSON.stringify([...produced].sort()) !== JSON.stringify([...expected.recordIds].sort()) || expected.errors.length || expected.blockedBy.length) { const error = new Error('x'); error.code = 'update-records-incomplete'; throw error; }
            if (operation === 'normal-update') { const runtime = world.runtimes.get('primary'), B = world.commits.B; const old = runtime.objectId; if (!faults.updateKeepsObject) { runtime.objectId = addObject('pkg-B-updated'); runtime.selectorId = H(`sel-${world.counter++}`); }
                if (!faults.noRestart) runtime.runtimeId = id('rt-primary-B'); runtime.commit = faults.wrongCommit ? H('wrong').slice(0, 40) : B.commit; runtime.markerSha256 = B.markerSha256; runtime.marker = B.marker; if (faults.mutatePredecessor) world.objects.get(old).treeMatches = false; if (faults.removePredecessor) world.objects.get(old).present = false; if (!faults.noGenerationChange) bump(); }
            else if (!faults.noGenerationChange) bump();
            world.pending = false;
            return { fulfilled: true, returnedCode: faults.updateExit ?? 0, result: { activation: { outcome: faults.activation ?? 'restarted' } } }; } },
        cache: {
            async probeStore({ targets, objects }) { if (faults.readerRestartsAfterReinstall && world.reinstalled && targets.some(target => target.alias === names.aliases[0])) world.runtimes.get(names.aliases[1]).startedAt = '2026-10-04T12:05:00Z';
                return { targets: targets.map(target => { if (target.packageName === null) { const runtime = world.runtimes.get(`g${targets.indexOf(target)}`) ?? world.runtimes.get('g0'); return { label: target.label, containerName: 'ploinky_g', runtimeId: runtime.runtimeId, instanceId: runtime.instanceId, enableGeneration: runtime.enableGeneration, running: runtime.running, labelsEqual: true, objectId: faults.graphNoStore ? null : runtime.objectId, selectorId: faults.graphNoStore ? null : runtime.selectorId, payloadSha256: faults.graphNoStore ? null : world.objects.get(runtime.objectId).payloadSha256, storeMode: faults.graphNoStore ? 'none' : 'store' }; }
                    const runtime = target.alias ? runtimeFor(target.alias) : world.runtimes.get('primary'); if (!runtime) { const error = new Error('x'); error.code = 'live-store-probe-missing'; throw error; } return full(runtime); }),
                objects: objects.map(objectId => ({ objectId, ...(world.objects.get(objectId) ?? { present: false, treeMatches: false, payloadSha256: null }) })) }; },
            async observeAdmissibleIds() { const owned = ownedRegistration(manifest), primary = world.runtimes.has('primary');
                return { gitPinRecordIds: [...(faults.pinNotObserved ? [] : [nonOwnedPin]), ...(primary && !faults.ownedPinNotObserved ? [owned.pinId] : [])].sort(), registrations: [nonOwnedRegistration, ...(primary ? [owned.containerName] : [])].sort(), repositories: ['AssistOSExplorer', owned.repoName] }; },
            async containerLogs(runtimeId) { const runtime = [...world.runtimes.values()].find(item => item.runtimeId === runtimeId); return runtime?.marker ? `UC_MARKER ${runtime.marker}\n` : ''; },
            async readerMarkerSha256(runtimeId) { world.readerReads = (world.readerReads ?? 0) + 1; if (faults.readerUnreadable || faults.readerUnreadableCall === world.readerReads) return null; return [...world.runtimes.values()].find(item => item.runtimeId === runtimeId)?.markerSha256 ?? null; },
            async cli(operation, args) { world.calls.push(`cli:${args.slice(0, 3).join(' ')}`);
                if (args[0] === 'start') { if (faults.warmReplacesRuntime) world.runtimes.get('g0').runtimeId = id('graph-replaced'); if (faults.warmReplacesObject) world.runtimes.get('g0').objectId = addObject('graph-new'); return { code: faults.startExit ?? 0 }; }
                if (args[0] === 'add') { world.registered = true; return { code: 0 }; }
                if (args[0] === 'enable') { enable(args.includes('as') ? args.at(-1) : null); return { code: faults.enableExit ?? 0 }; }
                if (args[0] === 'disable') { world.runtimes.delete(args[2].includes('/') ? 'primary' : args[2]); bump(); return { code: 0 }; }
                return { code: 0 }; },
            async reinstallWithGcSummary(alias, { onChunk } = {}) { world.calls.push(`reinstall:${alias}`); world.reinstalled = true; const runtime = runtimeFor(alias), readerObject = world.runtimes.get(names.aliases[1])?.objectId;
                runtime.objectId = addObject(`reinstalled-${alias}`); runtime.selectorId = H(`sel-${world.counter++}`); runtime.runtimeId = id(`rt-${alias}-reinstalled`); if (faults.removeReaderObject) world.objects.get(readerObject).present = false;
                if (faults.readerDies) world.runtimes.get(names.aliases[1]).running = false;
                if (faults.readerRestartsDuringGc) world.runtimes.get(names.aliases[1]).startedAt = '2026-10-04T12:05:00Z';
                const summary = faults.gcSkipped ? { outcome: 'skipped' } : { outcome: 'collected', removedCount: 1, retainedBytesByReason: faults.noRetainedReason ? {} : { 'admitted-record': 4, 'container-mount': 4, 'reader:container': 4 } };
                if (!faults.noSummaryCallback) onChunk?.({ summary }); return { code: 0, summary, bytes: 100, discardedLines: 1 }; },
        },
        negative: { async run() { world.calls.push('negative-run'); if (!faults.noPending) world.pending = true; return { phase: 'U6', optional: 'passed', required: 'passed' }; }, async restore() { world.calls.push('negative-restore'); } },
        cleanup: { async run({ writersQuiescent }) { world.calls.push(`cleanup:${writersQuiescent}`); await fixture.cleanup({ writersQuiescent }); return { repo: 'uninstalled', server: 'removed', files: 'removed', marker: 'removed' }; } },
    };
    const owned = ownedRegistration(manifest);
    const state = {}, inputs = { expectedUpdates: { 'normal-update': { errors: [], blockedBy: [], recordIds: ['workspace-graph', owned.repoName, owned.pinId] }, 'settling-update': { errors: [], blockedBy: [], recordIds: ['workspace-graph', owned.repoName] } } };
    const ctx = { manifest, inputs, ports, state, check() {}, latchClean: () => faults.latchDirty !== true };
    return { world, ctx, phases: createFunctionalPhases(ctx), ports };
}
