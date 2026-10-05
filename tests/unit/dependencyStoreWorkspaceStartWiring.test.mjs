// Workspace start runtime-option wiring. The first test executes the real
// startWorkspace body (its exact source text) in a VM sandbox whose global
// scope supplies the module's collaborators, as reinstallRecovery.test.mjs
// does for reinstallAgent: lease, graph, Router and readiness boundaries are
// stubs; any collaborator the test does not supply is a ReferenceError. It proves
// the exact options the production start passes to ensureAgentService. The
// second test proves, through the real ensureAgentService and the fake
// engine, what those options mean for the prepared registry record.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

import {
    createStartLaunchContainment,
    graphNodeRuntimeReplacementReason,
    launchAdditionalRuntimes,
    launchWorkspaceGraphWaves,
    recordMpsGraphPreparation,
    startWorkspace,
} from '../../cli/commands/workspaceUtil.js';
import { summarizeStartResult } from '../../cli/sandbox/hardwareLimits/outcomes.mjs';
import { tempRoot } from './dependencyStoreFixtures.mjs';
import { containerOf, entryFor, makeWorld } from './hardwareAvailabilityResolverFixtures.mjs';
import { runRetirementDriver } from './hardwareAvailabilityRetirementHarness.mjs';
import { stageNoWaitAvailabilitySlots } from '../../cli/commands/noWaitAvailabilitySlots.js';
import {
    CONTAINER,
    driveWiring,
    registration,
    stepValue,
    wiringWorkspace,
} from './dependencyStoreWiringHarness.mjs';

// An identifier the test does not supply is undefined in the sandbox and
// fails the run with a ReferenceError, so no collaborator is silently skipped.
function sandbox(collaborators) {
    return vm.runInNewContext(`(${startWorkspace.toString()})`, { ...collaborators });
}

function startFixture(t) {
    const root = tempRoot(t, 'depstore-wsstart-');
    const agentPath = path.join(root, 'repos', 'repo', 'demo');
    fs.mkdirSync(agentPath, { recursive: true });
    const manifestPath = path.join(agentPath, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ container: 'node:20', start: 'node index.js', network: { mode: 'none' } }));
    const calls = [];
    const earlyLease = Object.freeze({ mode: 'replace', tag: 'early-prelaunch-lease' });
    const postProviderLease = Object.freeze({ mode: 'replace', preparedGeneration: 'g2', tag: 'post-provider-lease' });
    const workspaceLease = Object.freeze({ tag: 'workspace-mutation-lease' });
    // The lease start binds as its operation's own, for nested reuse.
    let boundLease = null;
    const networkCapability = Object.freeze({ tag: 'network-capability' });
    const applyCapability = Object.freeze({ tag: 'apply-capability' });
    const stalledNoWaitRuns = [];
    const preparedRecord = Object.freeze({ ...registration(), instanceId: 'prepared-instance', enableGeneration: 'prepared-generation' });
    const staticNode = { id: 'repo/demo', repoName: 'repo', shortAgentName: 'demo', manifestPath, agentPath, isStatic: true };
    const graph = { nodes: new Map([[staticNode.id, staticNode]]), staticNodeId: staticNode.id };
    let registry = { [CONTAINER]: preparedRecord };
    let config = { static: { agent: 'repo/demo', port: 8080 } };
    let routing = { port: 8080, routes: {} };
    const ensureResult = {
        containerName: CONTAINER,
        hostPort: 0,
        registryRecord: { ...preparedRecord, runtime: 'podman', containerId: 'c'.repeat(64) },
    };
    const collaborators = {
        console: { log() {}, warn() {}, error(message) { calls.push(['console.error', message]); } },
        path,
        fs,
        __dirname: '/ploinky/cli/commands',
        PLOINKY_WORKSPACE_ROOT: root,
        PLOINKY_DIR: path.join(root, '.ploinky'),
        RUNNING_DIR: path.join(root, '.ploinky', 'running'),
        LOGS_DIR: path.join(root, '.ploinky', 'logs'),
        workspaceSvc: {
            getConfig: () => config,
            setConfig: (next) => { config = next; },
            saveAgents: (next) => { registry = { ...next }; calls.push(['saveAgents', structuredClone(next)]); },
            loadAgents: () => registry,
        },
        agentsSvc: { resolveEnabledAgentRecord: () => ({ containerName: CONTAINER, record: preparedRecord }) },
        utils: {
            colorize: (value) => value,
            findAgent: () => ({ repo: 'repo', shortAgentName: 'demo', manifestPath }),
        },
        dockerSvc: {
            getAgentContainerName: () => CONTAINER,
            ensureAgentService(agentName, manifest, suppliedAgentPath, options) {
                calls.push(['ensureAgentService', agentName, suppliedAgentPath, options]);
                calls.push(['ensureBoundLease', boundLease === workspaceLease]);
                return ensureResult;
            },
            cleanupExactAgentRuntimeCandidate: (candidate) => calls.push(['cleanupCandidate', candidate]),
        },
        prepareDefaultBootRepositories: () => {},
        prepareManifestRepositories: async () => {},
        getActiveProfile: () => 'default',
        getProfileConfig: () => ({}),
        preflightWorkspaceStartRuntimeCapabilities: () => ({ admissions: ['admitted'], graph, registry, additionalNodes: [] }),
        resetPreinstallRunInProcess: () => {},
        acquireSettledWorkspaceMutationLease: async (options) => { calls.push(['acquireLease', options.operation]); return workspaceLease; },
        inspectLiveNoWaitWorkers: () => { calls.push(['inspectStalled']); return stalledNoWaitRuns; },
        releaseWorkspaceStartLock: (lease) => calls.push(['releaseLease', lease === workspaceLease]),
        runWithWorkspaceMutationLease: async (lease, fn) => {
            boundLease = lease;
            try { return await fn(); } finally { boundLease = null; }
        },
        withNetworkLifecycleLockReclaimingStoppedOwner: async (callback) => callback(networkCapability),
        assertWorkspaceGraphAdmissionsCurrent: () => {},
        resolveWorkspaceGraphSsoConfig: () => null,
        initializeFreshEdgeRoutingSources: () => {},
        retireAbandonedWorkspaceStartPreparation: (options) => { calls.push(['retirePreparation', options]); return { retired: false }; },
        inactivateEdgeRoutingGeneration: (reason) => calls.push(['inactivate', reason]),
        resolveAndPersistStartRouterPort: async () => 8080,
        parseRouterPort: (value) => Number(value),
        readRoutingConfig: () => structuredClone(routing),
        writeRoutingConfig: (next) => { routing = structuredClone(next); },
        buildRouterEnv: () => ({}),
        ensureRouterGenerationReady: async () => ({ reused: true }),
        resolveStaticRouterContainerName: () => CONTAINER,
        deduplicateAgentRegistry: (value) => ({ ...value }),
        classifyDependencyGraphWaitMode: () => ({ noWait: new Set() }),
        ensureGraphNodesEnabled: (dependencyGraph, reg, options) => {
            calls.push(['ensureGraphNodesEnabled', options]);
            return { preparedGeneration: { preparationLease: earlyLease, selector: { state: 'inactive' } } };
        },
        applyStartupConfigProvidersForGraph: async () => ({ providers: [], applied: [], warnings: [] }),
        reprepareGraphAfterStartupProviders: (dependencyGraph, reg, prepared, options) => {
            calls.push(['reprepare', prepared.preparedGeneration.preparationLease === earlyLease, options]);
            return { preparedGraph: { preparedGeneration: { preparationLease: postProviderLease, selector: { state: 'inactive' } } }, preparedContainerNames: [] };
        },
        topologicallyGroupDependencyGraph: () => [[staticNode.id]],
        findRegistryEntryForGraphNode: () => ({ key: CONTAINER }),
        formatGraphNodeLabel: (node) => node.id,
        findAgentManifest: () => manifestPath,
        resolveAgentRepositoryName: () => 'repo',
        resolveManifestRouterEndpoint: () => null,
        resolveManifestRuntimeProfile: () => ({ resolvedProfileName: 'default', profileConfig: {}, network: { mode: 'none' } }),
        prepareHostModeCapabilityForInactiveGeneration: () => { throw new Error('network mode none needs no host capability'); },
        resolveAgentExecutionMode: () => ({ type: 'start_only' }),
        buildRelayReadinessRoute: ({ route }) => route,
        buildBlockingReadinessEntryFromNode: (node, route) => ({ node: node.id, route }),
        waitForReadinessEntries: async (entries) => calls.push(['readiness', entries.length]),
        mergeRoutingConfig: async (mutate, options = {}) => {
            calls.push(['mergeRoutingConfig', options]);
            // A coordinated merge hands its mutator the live capabilities; a `coordinate: false` merge holds neither lock.
            routing = mutate(structuredClone(routing), options.coordinate === false
                ? { applyLockCapability: undefined, networkLifecycleCapability: undefined }
                : { applyLockCapability: applyCapability, networkLifecycleCapability: networkCapability });
            calls.push(['mutatorReturned', options.reason || null]);
            return routing;
        },
        partitionAdditionalStartupAgents: () => ({ inactiveManual: [], activeManual: [], automatic: [] }),
        loadRegistryManifest: () => { throw new Error('no additional agents in this graph'); },
        isRegistryRuntimeRunning: () => { throw new Error('no additional agents in this graph'); },
        retireRuntimeCandidate: () => {},
        randomUUID: () => '00000000-0000-4000-8000-000000000000',
        buildNoWaitLaunchSchedule: () => [],
        bindNoWaitLaunchScheduleIdentity: (schedule) => schedule,
        buildRouterUrl: (port) => `http://127.0.0.1:${port}`,
        collectDependencyObjectsAfterAdmission: (options) => { calls.push(['collect', options.lease === workspaceLease, options.reason]); return {}; },
        reportDependencyCollection: (value) => value,
        abortEdgeRoutingPreparation: (lease, options) => calls.push(['abortPreparation', lease, options]),
        // The hardware-limits collaborators of the start. The graph carries no GPU share and no refusal, so the tracker reports every
        // node eligible and the MPS graph preparation is empty; the launch containment and the wave launchers are the real ones.
        createGraphAvailabilityTracker: () => ({
            outcomeForNode: () => null, outcomeForKey: () => null, unavailableEntries: () => [], recordLaunchRefusal: () => [],
        }),
        prepareMpsGraph: async () => ({ refusals: [], replacedKeys: new Set(), graphPreparationId: null }),
        recordMpsGraphPreparation,
        graphNodeRegistryKey: () => CONTAINER,
        graphNodeRuntimeReplacementReason,
        createStartLaunchContainment,
        launchWorkspaceGraphWaves,
        launchAdditionalRuntimes,
        markRouteHardwareUnavailable: (route) => route,
        finalizeMpsGraph: async () => {},
        verifyMpsRuntimeReady: async () => {},
        acknowledgeMpsRuntimeReady: async () => {},
        writeNoWaitHardwareOutcome: () => {},
        // Start's no-wait availability slot staging (M-NW-01 D2-S): recorded here, exercised against the real store in noWaitAvailabilitySlots.test.mjs.
        stageNoWaitAvailabilitySlots: async (options) => { calls.push(['stageSlots', options]); },
        resolveNoWaitBarrierTimeouts: () => ({ startupGraceMs: 7000 }),
        // D2S.13 site S: recorded here, exercised against the real store and real locks in hardwareAvailabilityRetirement.test.mjs.
        retireStartReadyPublications: (options) => { calls.push(['retireStartPublications', options]); return { retired: [] }; },
        summarizeStartResult,
        printStartResultSummary: () => {},
    };
    return { collaborators, calls, earlyLease, postProviderLease, workspaceLease, networkCapability, applyCapability, preparedRecord, ensureResult, stalledNoWaitRuns, registry: () => registry };
}

test('workspace start settles an abandoned graph preparation under its leases before replacing the selector', async (t) => {
    const fixture = startFixture(t);
    await sandbox(fixture.collaborators)('repo/demo', '8080', {});
    const retireIndex = fixture.calls.findIndex(([name]) => name === 'retirePreparation');
    const inactivateIndex = fixture.calls.findIndex(([name, reason]) => name === 'inactivate' && reason === 'workspace-start-prepare');
    assert.ok(retireIndex >= 0, 'start inspects an outstanding preparation');
    assert.ok(inactivateIndex > retireIndex, 'the selector that binds a stopped start preparation is replaced only afterwards');
    const [, options] = fixture.calls[retireIndex];
    assert.equal(options.workspaceMutationLease, fixture.workspaceLease, 'the exact held workspace start lease authorizes retirement');
    assert.equal(options.networkLifecycleCapability, fixture.networkCapability);
});

test('workspace start supersedes the stalled no-wait workers it finds under its leases in both graph preparations', async (t) => {
    const fixture = startFixture(t);
    const stalled = Object.freeze({ containerName: CONTAINER, runId: '11111111-2222-4333-8444-555555555555', pid: 4242, identity: Object.freeze({ containerName: CONTAINER }) });
    fixture.stalledNoWaitRuns.push(stalled);
    await sandbox(fixture.collaborators)('repo/demo', '8080', {});
    const names = fixture.calls.map(([name]) => name);
    assert.ok(names.indexOf('inspectStalled') > names.indexOf('acquireLease'), 'stalled workers are read under the settled workspace lease');
    assert.ok(names.indexOf('inspectStalled') < names.indexOf('retirePreparation'), 'and before any selector or graph mutation');
    const [, enableOptions] = fixture.calls.find(([name]) => name === 'ensureGraphNodesEnabled');
    assert.deepEqual(enableOptions.supersededNoWaitRuns, [stalled]);
    const [, , reprepareOptions] = fixture.calls.find(([name]) => name === 'reprepare');
    assert.deepEqual(reprepareOptions.graphEnableOptions.supersededNoWaitRuns, [stalled],
        'the post-provider preparation keeps superseding them');
});

test('a refused abandoned preparation stops workspace start before any selector, routing or graph mutation', async (t) => {
    const fixture = startFixture(t);
    const refusal = new Error('edge lifecycle preparation "workspace-graph-enable-prelaunch" (pid 686420) cannot be retired automatically: '
        + 'its exact inactive selector was replaced; stop the exact Box from its host workspace with `ploinky stop`, then run `ploinky start`, '
        + 'which retires the preparation while the Box is stopped');
    refusal.code = 'EDGE_PREPARATION_BUSY';
    fixture.collaborators.retireAbandonedWorkspaceStartPreparation = (options) => {
        fixture.calls.push(['retirePreparation', options]);
        throw refusal;
    };
    await assert.rejects(sandbox(fixture.collaborators)('repo/demo', '8080', {}), {
        message: /^start \(workspace\) failed: edge lifecycle preparation .*`ploinky stop`, then run `ploinky start`/,
    });
    const names = fixture.calls.map(([name]) => name);
    assert.ok(names.includes('retirePreparation'));
    for (const forbidden of ['inactivate', 'ensureGraphNodesEnabled', 'ensureAgentService', 'mergeRoutingConfig', 'abortPreparation']) {
        assert.equal(names.includes(forbidden), false, `${forbidden} must not run after the refusal`);
    }
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'releaseLease'), [['releaseLease', true]]);
});

test('workspace start launches each graph runtime with its prepared registry record and the post-provider preparation lease', async (t) => {
    const fixture = startFixture(t);
    const run = sandbox(fixture.collaborators);
    await run('repo/demo', '8080', {});
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'console.error'), []);
    const ensures = fixture.calls.filter(([name]) => name === 'ensureAgentService');
    assert.equal(ensures.length, 1, 'the graph runtime is ensured once');
    const [, agentName, , options] = ensures[0];
    assert.equal(agentName, 'demo');
    assert.equal(options.containerName, CONTAINER);
    assert.equal(options.preservePreparedRegistryRecord, true, 'workspace start preserves the prepared registry record');
    assert.equal(options.preparationLease, fixture.postProviderLease, 'the exact post-provider preparation lease authorizes the launch');
    assert.notEqual(options.preparationLease, fixture.earlyLease);
    assert.equal(options.instanceId, fixture.preparedRecord.instanceId, 'the prepared runtime identity is requested');
    assert.equal(options.enableGeneration, fixture.preparedRecord.enableGeneration);
    assert.equal(options.networkLifecycleCapability, fixture.networkCapability);
    assert.equal(options.forceRecreate, false);
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'ensureBoundLease'), [['ensureBoundLease', true]],
        'the runtime is ensured inside the start operation that owns the workspace lease');

    // The same lease commits the graph, with the runtime's exact record.
    const commits = fixture.calls.filter(([name, opts]) => name === 'mergeRoutingConfig' && opts?.reason === 'workspace-runtime-graph-ready');
    assert.equal(commits.length, 1);
    assert.equal(commits[0][1].preparationLease, fixture.postProviderLease);
    assert.deepEqual(fixture.registry()[CONTAINER], fixture.ensureResult.registryRecord);
    assert.deepEqual(fixture.calls.filter(([name]) => name === 'abortPreparation'), [], 'the preparation was committed, not aborted');
    assert.deepEqual(fixture.calls.find(([name]) => name === 'collect'), ['collect', true, 'workspace-start']);
});

test('ensureAgentService keeps a prepared registry record only when asked to preserve it', (t) => {
    const w = wiringWorkspace(t, { prefix: 'depstore-preserve-' });
    const prepared = { ...registration(), instanceId: 'prepared-instance', enableGeneration: 'prepared-generation' };
    const preserved = stepValue(driveWiring(w, [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record: { ...prepared, projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'start', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true },
    ]), 'start');
    assert.equal(preserved.instanceId, prepared.instanceId, 'the prepared instance survives the launch');
    assert.equal(preserved.enableGeneration, prepared.enableGeneration);
    const stored = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'))[CONTAINER];
    assert.equal(stored.instanceId, prepared.instanceId, 'the committed registry record is the prepared one');
    assert.equal(stored.enableGeneration, prepared.enableGeneration);

    // Negative control at the same boundary: without preservation, the
    // launch of a registered agent whose runtime is missing tries to re-mint
    // its identity with an unrelated generation apply, which the outstanding
    // workspace preparation denies. The prepared runtime is never launched.
    const other = wiringWorkspace(t, { prefix: 'depstore-rotate-' });
    const rotated = driveWiring(other, [
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record: { ...prepared, projectPath: path.join(other.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'start', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, preserve: false, activate: true, allowFailure: true },
    ]);
    assert.equal(rotated.start.ok, false, JSON.stringify(rotated.start));
    assert.equal(rotated.start.code, 'EDGE_PREPARATION_BUSY', rotated.start.message);
    assert.deepEqual(Object.keys(other.engine.state().containers), [], 'no runtime was launched');
});


// ---------------------------------------------------------------- M-NW-01 D2-S: where start stages its availability slots

// A start with one deferred (no-wait) run. Real files in the no-wait directory; every collaborator that would create a worker is a recorder.
function noWaitStart(t, { stage } = {}) {
    const fixture = startFixture(t);
    const { collaborators, calls } = fixture;
    const runId = '11111111-2222-4333-8444-555555555555';
    const noWaitDir = path.join(collaborators.RUNNING_DIR, 'no-wait');
    const canonical = path.join(noWaitDir, `${CONTAINER}.json`);
    const freshStatus = path.join(noWaitDir, `${CONTAINER}.${runId}.json`);
    const entry = {
        node: { id: 'repo/demo' }, registryName: CONTAINER, waveIndex: 0, runId, runStartedAtMs: 1_700_000_000_000,
        statusFile: freshStatus,
        identity: { containerName: CONTAINER, routeKey: 'demo', runId, statusFile: path.basename(freshStatus) },
    };
    const recording = { ...fs, unlinkSync: (target) => { calls.push(['unlink', target]); return fs.unlinkSync(target); } };
    Object.assign(collaborators, {
        fs: recording,
        buildNoWaitLaunchSchedule: () => [[entry]],
        ensureVerifiedProducerDirectory: ({ trustedRoot, relativeSegments }) => { fs.mkdirSync(path.join(trustedRoot, ...relativeSegments), { recursive: true }); },
        spawnNoWaitWorker: async (options) => { calls.push(['spawn', options.statusFile]); return { pid: 4242, logFile: '/log', statusFile: options.statusFile }; },
        writeNoWaitSpawnFailure: () => { calls.push(['spawnFailureStatus']); },
        sanitizeDiagnosticText: (value) => String(value),
        stageNoWaitAvailabilitySlots: async (options) => { calls.push(['stageSlots', options]); if (stage) await stage(options); },
    });
    fs.mkdirSync(noWaitDir, { recursive: true });
    return { ...fixture, entry, noWaitDir, canonical, freshStatus, runId, calls };
}

test('NW1.S-start-status-clearing-touches-only-canonical-and-this-runs-fresh-paths', async (t) => {
    const fixture = noWaitStart(t);
    const olderRun = '99999999-8888-4777-a666-555555555555';
    const keep = {
        olderRunStatus: path.join(fixture.noWaitDir, `${CONTAINER}.${olderRun}.json`),
        otherCanonical: path.join(fixture.noWaitDir, 'ploinky_repo_other.json'),
        marker: path.join(fixture.noWaitDir, `${CONTAINER}.current.json`),
        log: path.join(fixture.noWaitDir, `${CONTAINER}.log`),
    };
    for (const file of Object.values(keep)) fs.writeFileSync(file, `keep ${path.basename(file)}`);
    fs.writeFileSync(fixture.canonical, 'canonical');
    fs.writeFileSync(fixture.freshStatus, 'fresh');
    await sandbox(fixture.collaborators)('repo/demo', '8080', {});
    const unlinked = fixture.calls.filter(([name]) => name === 'unlink').map(([, target]) => target).sort();
    assert.deepEqual(unlinked, [fixture.canonical, fixture.freshStatus].sort(), 'start unlinks exactly the canonical status and this run\'s fresh path');
    assert.equal(fs.existsSync(fixture.canonical) || fs.existsSync(fixture.freshStatus), false);
    for (const [label, file] of Object.entries(keep)) assert.equal(fs.readFileSync(file, 'utf8'), `keep ${path.basename(file)}`, `${label} is untouched`);
});

test('NW1.S-slots-are-committed-before-any-marker-or-spawn-and-a-failed-slot-commit-aborts-the-start', async (t) => {
    // Ordering: after the statuses are cleared, before the first spawn; with the identity the store needs.
    {
        const fixture = noWaitStart(t);
        await sandbox(fixture.collaborators)('repo/demo', '8080', {});
        const names = fixture.calls.map(([name]) => name);
        assert.ok(names.includes('unlink') && names.includes('stageSlots') && names.includes('spawn'));
        assert.ok(names.lastIndexOf('unlink') < names.indexOf('stageSlots'), 'slots are staged after the statuses are cleared');
        assert.ok(names.indexOf('stageSlots') < names.indexOf('spawn'), 'and before any worker is spawned');
        assert.equal(names.filter((name) => name === 'stageSlots').length, 1, 'one staging commit per start');
        const [, options] = fixture.calls.find(([name]) => name === 'stageSlots');
        assert.equal(options.workspaceRoot, fixture.collaborators.PLOINKY_WORKSPACE_ROOT);
        assert.equal(options.startupGraceMs, 7000, 'startupGraceMs comes from the start process\'s barrier timeouts');
        assert.equal(options.schedule.flat()[0], fixture.entry, 'the bound schedule of this run');
        assert.equal(options.isParentKnown(fixture.entry), false);
    }
    // The REAL staging entry point on a workspace whose store was never initialized: the start's error names the slot commit.
    {
        const emptyRoot = tempRoot(t, 'depstore-staging-empty-');
        const fixture = noWaitStart(t, {});
        fixture.collaborators.stageNoWaitAvailabilitySlots = async (options) => {
            fixture.calls.push(['stageSlots', options]);
            return stageNoWaitAvailabilitySlots({ ...options, workspaceRoot: emptyRoot });
        };
        await assert.rejects(sandbox(fixture.collaborators)('repo/demo', '8080', {}), /start \(workspace\) failed: no-wait availability slot commit failed: .*not initialized/);
        const names = fixture.calls.map(([name]) => name);
        for (const forbidden of ['spawn', 'spawnFailureStatus']) assert.equal(names.includes(forbidden), false, `${forbidden} must not run after a failed slot commit`);
    }
    // A failed slot commit aborts the start naming the commit; no worker, no marker, no status for the run.
    {
        let fail = true;
        const fixture = noWaitStart(t, { stage: async () => { if (fail) throw new Error('store is full'); } });
        await assert.rejects(sandbox(fixture.collaborators)('repo/demo', '8080', {}), /start \(workspace\) failed: store is full/);
        const names = fixture.calls.map(([name]) => name);
        assert.ok(names.includes('stageSlots'));
        for (const forbidden of ['spawn', 'spawnFailureStatus']) assert.equal(names.includes(forbidden), false, `${forbidden} must not run after a failed slot commit`);
        // The next start succeeds.
        fail = false;
        fixture.calls.length = 0;
        await sandbox(fixture.collaborators)('repo/demo', '8080', {});
        assert.ok(fixture.calls.some(([name]) => name === 'spawn'), 'the next start spawns');
    }
});


// ---------------------------------------------------------------- M-NW-01 D2S.13: same-tuple ready publications retire same-tuple entries

const SRC = (relative) => fs.readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');
const NEW_ENTRY = 'hardware_availability_entry_retirement_failed';
const failureLogs = (value) => value.logs.filter((line) => line.type === NEW_ENTRY);

function retirementWorld(t, { routes = { alpha: {} }, entries = ['alpha'], rotated = [] } = {}) {
    const world = makeWorld(t, { routes: Object.fromEntries(Object.keys(routes).map((key) => [key, routes[key]])) });
    world.commitStore({ entries: Object.fromEntries([
        ...entries.map((key) => [key, entryFor(key)]),
        ...rotated.map((key) => [key, entryFor(key, { instanceId: 'rotated-instance' })]),
    ]) });
    const agents = world.readAgents();
    return { world, agents, before: world.selection(), record: (key) => agents[containerOf(key)] };
}

test('NW1.S-same-tuple-ready-publication-retires-entries-at-its-commit-point', async (t) => {
    // ---- site S, in start's own code: the call is inside the post-readiness merge mutator, before the apply
    {
        const fixture = startFixture(t);
        await sandbox(fixture.collaborators)('repo/demo', '8080', {});
        const names = fixture.calls.map(([name]) => name);
        const retireIndex = names.indexOf('retireStartPublications');
        assert.equal(names.filter((name) => name === 'retireStartPublications').length, 1, 'start retires once, in the graph-ready merge only');
        const mergeIndex = fixture.calls.findIndex(([name, options]) => name === 'mergeRoutingConfig' && options?.reason === 'workspace-runtime-graph-ready');
        const returnedIndex = fixture.calls.findIndex(([name, reason]) => name === 'mutatorReturned' && reason === 'workspace-runtime-graph-ready');
        assert.ok(mergeIndex >= 0 && retireIndex > mergeIndex, 'retirement belongs to the graph-ready merge');
        assert.ok(retireIndex < returnedIndex, 'and runs inside its mutator, before start\'s apply');
        assert.ok(names.indexOf('readiness') < retireIndex, 'after readiness');
        const [, options] = fixture.calls[retireIndex];
        assert.equal(options.capabilities.applyLockCapability, fixture.applyCapability, 'the apply-lock capability comes from the coordinated merge');
        assert.equal(options.capabilities.networkLifecycleCapability, fixture.networkCapability);
        assert.deepEqual([...options.readyAgentKeys], [CONTAINER], 'only the agents this start verified ready');
        assert.equal(options.registry[CONTAINER].instanceId, fixture.ensureResult.registryRecord.instanceId);
        // The merges that commit results hold neither lock: no retirement may happen there.
        const uncoordinated = fixture.calls.filter(([name, merge]) => name === 'mergeRoutingConfig' && merge?.coordinate === false);
        assert.ok(uncoordinated.length >= 1, 'start has uncoordinated merges');
    }
    // ---- what a coordinated and a coordinate:false merge hand their mutators, from the real mergeRoutingConfig under real locks
    {
        const { world } = retirementWorld(t);
        const seen = runRetirementDriver(world, 'merge-capabilities');
        assert.deepEqual(seen.coordinated, { applyLockLive: true, networkLive: true }, 'a coordinated merge hands over the live apply-lock and network capabilities');
        assert.deepEqual(seen.uncoordinated, { applyLockCapability: null, networkLifecycleCapability: null }, 'a coordinate:false merge hands over neither');
    }
    // ---- site S through the real mergeRoutingConfig, real lease, network lock and apply lock
    {
        const { world, record } = retirementWorld(t, { routes: { alpha: {}, gamma: {}, delta: {} }, entries: ['alpha', 'gamma'], rotated: ['delta'] });
        const ready = [containerOf('alpha'), containerOf('delta')];
        const run = runRetirementDriver(world, 'site-s', { ready });
        assert.deepEqual(failureLogs(run), [], 'no retirement failure');
        assert.deepEqual(run.retired.retired, ['alpha'], 'only a ready agent whose entry has exactly the published tuple');
        assert.deepEqual(run.entriesAfter, ['delta', 'gamma'], 'gamma is not ready and delta\'s entry names another tuple: both are kept');
        assert.equal(run.witnesses.length, 1);
        assert.equal(run.witnesses[0].selector.state, 'inactive', 'retired inside the mutator, while the selector is inactive');
        assert.deepEqual(run.witnesses[0].entries, ['alpha', 'delta', 'gamma'], 'the entry was still there when retirement started');
        assert.equal(run.selectorAfter.state, 'active', 'the merge then applies');
        assert.ok(record('alpha'));
        // The apply fails after the mutator: start fails with the selector inactive; ready agents\' entries are already retired.
        const failing = retirementWorld(t, { routes: { alpha: {}, gamma: {} }, entries: ['alpha', 'gamma'] });
        const failed = runRetirementDriver(failing.world, 'site-s', { ready: [containerOf('alpha')], failure: 'apply' });
        assert.match(failed.mergeError.message, /the apply failed after the mutator/);
        assert.deepEqual(failed.entriesAfter, ['gamma']);
        assert.equal(failed.selectorAfter.state, 'inactive');
        // A retirement-commit failure: the publication stands, the entry is kept, the failure is logged.
        const broken = retirementWorld(t);
        const brokenRun = runRetirementDriver(broken.world, 'site-s', { ready: [containerOf('alpha')], breakCommit: true });
        assert.equal(brokenRun.mergeError, null, 'the apply still succeeded');
        assert.equal(brokenRun.selectorAfter.state, 'active');
        assert.deepEqual(brokenRun.entriesAfter, ['alpha'], 'the entry is kept');
        assert.equal(failureLogs(brokenRun).length, 1);
        assert.equal(failureLogs(brokenRun)[0].site, 'start');
        // Uncoordinated capabilities (undefined) are refused by the helper: never a hidden success.
        const bare = retirementWorld(t);
        const bareRun = runRetirementDriver(bare.world, 'site-s', { ready: [containerOf('alpha')], noCapabilities: true });
        assert.deepEqual(bareRun.entriesAfter, ['alpha']);
        assert.equal(failureLogs(bareRun)[0].code, 'PLOINKY_NETWORK_LIFECYCLE_CAPABILITY_REQUIRED');
    }
    // ---- sites A, R and T: each with a target-less and a targeted successor, under real locks
    for (const [label, hostPort] of [['target-less', 0], ['targeted', 43111]]) {
        // A: after the selector switch, in the same apply-lock hold.
        {
            const { world, record, before } = retirementWorld(t);
            const run = runRetirementDriver(world, 'site-a', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: record('alpha'), hostPort });
            assert.equal(run.activationError, null, `${label} A: ${JSON.stringify(run.activationError)}`);
            assert.equal(run.activated, true);
            assert.deepEqual(failureLogs(run), [], `${label} A: no retirement failure`);
            assert.deepEqual(run.entriesAfter, [], `${label} A: the entry is gone from the store`);
            assert.equal(run.witnesses[0].selector.state, 'active');
            assert.notEqual(run.witnesses[0].selector.activationId, before.activationId, `${label} A: retirement ran after the selector switch`);
            assert.deepEqual(run.witnesses[0].entries, ['alpha'], `${label} A: the entry was present until the switch`);
        }
        // R: after the replacement generation is applied, under a fresh apply lock.
        {
            const { world, record, before } = retirementWorld(t);
            const run = runRetirementDriver(world, 'site-r', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: record('alpha'), hostPort });
            assert.equal(run.activationError, null, `${label} R: ${JSON.stringify(run.activationError)}`);
            assert.equal(run.activated, true);
            assert.deepEqual(failureLogs(run), [], `${label} R: no retirement failure`);
            assert.deepEqual(run.entriesAfter, [], `${label} R: the entry is gone from the store`);
            assert.equal(run.witnesses[0].selector.state, 'active', `${label} R: retirement ran after the apply`);
            assert.notEqual(run.witnesses[0].selector.activationId, before.activationId);
        }
        // T: after the exact publication is verified, under a fresh apply lock.
        {
            const { world, record, before } = retirementWorld(t);
            const run = runRetirementDriver(world, 'site-t', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: record('alpha'), hostPort });
            assert.equal(run.commitError, null, `${label} T: ${JSON.stringify(run.commitError)}`);
            assert.equal(run.committed, true);
            assert.deepEqual(failureLogs(run), [], `${label} T: no retirement failure`);
            assert.deepEqual(run.entriesAfter, [], `${label} T: the entry is gone from the store`);
            assert.equal(run.witnesses[0].selector.state, 'active', `${label} T: retirement ran after the publication`);
            assert.notEqual(run.witnesses[0].selector.activationId, before.activationId);
        }
    }
    // ---- post-failure: the apply fails, the entry is kept
    {
        const r = retirementWorld(t);
        const argument = (extra = {}) => ({ routeKey: 'alpha', container: containerOf('alpha'), registryRecord: r.record('alpha'), hostPort: 0, ...extra });
        const replacement = runRetirementDriver(r.world, 'site-r', argument({ failure: 'apply' }));
        assert.match(replacement.activationError.message, /the replacement apply failed/);
        assert.deepEqual(replacement.entriesAfter, ['alpha'], 'R with the apply failing keeps the entry');
        assert.equal(replacement.selectorAfter.state, 'inactive', 'and the selector stays inactive');
        assert.deepEqual(replacement.witnesses, [], 'retirement never started');
        const targeted = retirementWorld(t);
        const failedApply = runRetirementDriver(targeted.world, 'site-t', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: targeted.record('alpha'), failure: 'apply' });
        assert.match(failedApply.commitError.message, /the successor publication failed/);
        assert.deepEqual(failedApply.entriesAfter, ['alpha'], 'T with the apply failing keeps the entry');
        assert.equal(failedApply.selectorAfter.state, 'inactive', 'and the coordinated merge left the selector inactive');
        assert.deepEqual(failedApply.witnesses, []);
        const unverified = retirementWorld(t);
        const failedVerify = runRetirementDriver(unverified.world, 'site-t', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: unverified.record('alpha'), failure: 'verify' });
        assert.match(failedVerify.commitError.message, /not .*exact|no longer selects its exact registered owner/);
        assert.deepEqual(failedVerify.entriesAfter, ['alpha'], 'T with the verification failing keeps the entry');
        assert.deepEqual(failedVerify.witnesses, []);
        // A: the additive commit throws: the predecessor stays selected and the entry is kept.
        const additive = retirementWorld(t);
        const failedCommit = runRetirementDriver(additive.world, 'site-a', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: additive.record('alpha'), hostPort: 0, failure: 'commit' });
        assert.match(failedCommit.activationError.message, /the additive commit failed/);
        assert.deepEqual(failedCommit.entriesAfter, ['alpha'], 'A with the commit throwing keeps the entry');
        assert.equal(failedCommit.selectorAfter.activationId, additive.before.activationId, 'the predecessor stays selected');
        assert.deepEqual(failedCommit.witnesses, []);
        // A retirement-commit failure at A, R and T: the publication stands, the entry is kept, the failure is logged once.
        for (const [phase, field] of [['site-a', 'activated'], ['site-r', 'activated'], ['site-t', 'committed']]) {
            const x = retirementWorld(t);
            const run = runRetirementDriver(x.world, phase, { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: x.record('alpha'), hostPort: 0, breakCommit: true });
            assert.equal(run[field], true, `${phase}: the publication stands`);
            assert.deepEqual(run.entriesAfter, ['alpha'], `${phase}: the entry is kept`);
            assert.equal(run.selectorAfter.state, 'active', `${phase}: no false readiness change`);
            assert.equal(failureLogs(run).length, 1, `${phase}: the failure is logged`);
        }
    }
});

test('NW1.S-shell-activation-retires-under-the-workspace-lease-and-logs-no-failure', (t) => {
    // `ploinky shell` activates a prepared runtime through the additive path, whose entry retirement asserts the
    // workspace mutation lease. The shell's lifecycle work runs under it, and the attach after it does not.
    const argumentFor = (fixture, extra = {}) => ({
        routeKey: 'alpha', container: containerOf('alpha'), registryRecord: fixture.record('alpha'), hostPort: 0, ...extra,
    });
    for (const [label, hostPort] of [['target-less', 0], ['targeted', 43111]]) {
        const fixture = retirementWorld(t);
        const run = runRetirementDriver(fixture.world, 'shell-lifecycle', argumentFor(fixture, { hostPort }));
        assert.equal(run.lifecycleError, null, `${label}: ${JSON.stringify(run.lifecycleError)}`);
        assert.equal(run.shell.containerName, containerOf('alpha'));
        assert.deepEqual(failureLogs(run), [], `${label}: no retirement failure is logged`);
        assert.deepEqual(run.entriesAfter, [], `${label}: the entry is retired`);
        assert.equal(run.leaseAtActivation, `shell:${containerOf('alpha')}`, `${label}: the activation runs under the shell's own lease`);
        assert.equal(run.witnesses.length, 1);
        assert.equal(run.witnesses[0].lease, `shell:${containerOf('alpha')}`, `${label}: retirement started under that lease`);
        assert.equal(run.witnesses[0].selector.state, 'active');
        assert.notEqual(run.witnesses[0].selector.activationId, fixture.before.activationId, `${label}: after the selector switch`);
    }
    // A caller that already holds the lease keeps it: the shell reuses it and takes no second one.
    {
        const fixture = retirementWorld(t);
        const run = runRetirementDriver(fixture.world, 'shell-lifecycle', argumentFor(fixture, { hold: true }));
        assert.equal(run.lifecycleError, null);
        assert.deepEqual(failureLogs(run), []);
        assert.deepEqual(run.entriesAfter, []);
        assert.equal(run.witnesses[0].lease, 'outer-holder', 'the held lease is reused');
    }
    // The command reaches that lifecycle through runShellLifecycle, and the lease wraps the whole lifecycle.
    const source = SRC('cli/commands/workspaceUtil.js');
    const lifecycle = /async function runShellLifecycle\([\s\S]*?\n\}\n/.exec(source)?.[0] || '';
    assert.match(lifecycle, /return withHeldOrAcquiredWorkspaceMutationLease\(\s*\{ operation: `shell:\$\{registeredContainerName\}` \},\s*\(\) => withNetworkLifecycleLock\(/, 'the lease is taken before the network lock');
    assert.match(lifecycle, /await activateAfterReadiness\(/);
    const shell = /async function runShell\(agentName\) \{[\s\S]*?\n\}\n/.exec(source)?.[0] || '';
    assert.match(shell, /await runShellLifecycle\(\{/);
    assert.doesNotMatch(shell, /activatePreparedRuntimeAfterReadiness|withNetworkLifecycleLock\(/, 'runShell itself no longer activates outside the lease');
});

test('NW1.S-no-retirement-site-uses-an-uncoordinated-merge-and-retirement-stays-inside-its-modules', () => {
    // S2-style source checks. The retirement call sites are in the three reviewed modules only.
    const callers = new Map();
    const walk = (directory) => {
        for (const entry of fs.readdirSync(new URL(`../../${directory}`, import.meta.url), { withFileTypes: true })) {
            const relative = `${directory}/${entry.name}`;
            if (entry.isDirectory()) walk(relative);
            else if (/\.(m?js)$/.test(entry.name)) {
                const text = SRC(relative);
                for (const name of ['commitHardwareAvailabilityPolicy(', 'retireSameTupleHardwareEntries(', 'retireSameTupleAfterApply(', 'retireStartReadyPublications(']) {
                    if (text.includes(name)) callers.set(`${relative}:${name}`, true);
                }
            }
        }
    };
    walk('cli');
    const files = [...callers.keys()].map((key) => key.split(':')[0]);
    const allowed = new Set([
        'cli/sandbox/hardwareAvailabilityStore.mjs', 'cli/commands/noWaitAvailabilitySlots.js', 'cli/commands/hardwareAvailabilityRetirement.js',
        'cli/commands/workspaceUtil.js', 'cli/commands/targetedAgentRestart.js',
        // D2S.11: the Router-process latcher writes the resolve commit; it never retires a publication's entries (below).
        'cli/server/hardwareAvailabilityLatcher.mjs',
    ]);
    for (const file of files) assert.ok(allowed.has(file), `${file} must not retire entries or commit the store`);
    for (const name of ['retireSameTupleHardwareEntries(', 'retireSameTupleAfterApply(', 'retireStartReadyPublications(']) {
        assert.equal(callers.has(`cli/server/hardwareAvailabilityLatcher.mjs:${name}`), false, `the latcher must not call ${name}`);
    }
    assert.ok(files.includes('cli/commands/workspaceUtil.js'));
    assert.match(SRC('cli/commands/targetedAgentRestart.js'), /await retireEntriesAfterApply\(/);
    // No retirement call sits inside a `coordinate: false` mutator: the text of every merge call (balanced parentheses) that holds a
    // retirement call is coordinated, and the retirement calls of the other modules sit outside any merge call.
    const spans = (text, name) => {
        const found = [];
        for (let at = text.indexOf(`${name}(`); at !== -1; at = text.indexOf(`${name}(`, at + 1)) {
            let depth = 0;
            let end = at + name.length;
            for (; end < text.length; end += 1) {
                if (text[end] === '(') depth += 1;
                else if (text[end] === ')') { depth -= 1; if (depth === 0) break; }
            }
            found.push(text.slice(at, end + 1));
        }
        return found;
    };
    const RETIREMENT = /retireStartReadyPublications\(|retireSameTuple\w*\(|retireEntries\w*\(/;
    for (const file of ['cli/commands/workspaceUtil.js', 'cli/commands/targetedAgentRestart.js']) {
        const text = SRC(file);
        for (const merge of [...spans(text, 'mergeRoutingConfig'), ...spans(text, 'mergeRouting')]) {
            if (RETIREMENT.test(merge)) assert.doesNotMatch(merge, /\},\s*\{[^}]*coordinate:\s*false/, `${file}: a retirement call inside a coordinate:false merge`);
        }
        assert.ok(spans(text, 'mergeRoutingConfig').some((merge) => /\},\s*\{[^}]*coordinate:\s*false/.test(merge)) || file.endsWith('targetedAgentRestart.js'), `${file}: the scan sees the uncoordinated merges`);
    }
    assert.ok(spans(SRC('cli/commands/workspaceUtil.js'), 'mergeRoutingConfig').some((merge) => RETIREMENT.test(merge)), 'the scan sees the graph-ready merge that retires');
    // The graph-ready merge is coordinated and its mutator takes the capabilities from its second argument.
    const start = SRC('cli/commands/workspaceUtil.js');
    const mergeFrom = start.indexOf("await mergeRoutingConfig((current, { applyLockCapability");
    assert.ok(mergeFrom > 0);
    const mergeText = start.slice(mergeFrom, start.indexOf('workspacePreparationLease = null;', mergeFrom));
    assert.match(mergeText, /retireStartReadyPublications\(/);
    assert.match(mergeText, /reason: 'workspace-runtime-graph-ready'/);
    assert.doesNotMatch(mergeText, /\},\s*\{[^}]*coordinate:\s*false/);
    // The helper refuses missing capabilities rather than falling back to anything else.
    const helper = SRC('cli/commands/hardwareAvailabilityRetirement.js');
    assert.match(helper, /assertNetworkLifecycleCapability\(networkLifecycleCapability\)/);
    assert.match(helper, /assertEdgeGenerationApplyLockCapability\(\{ workspaceRoot, applyLockCapability, storePaths \}\)/);
});
