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
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
import { RUN_STARTED_AT_MS, containerOf, entryFor, makeWorld } from './hardwareAvailabilityResolverFixtures.mjs';
import { DRIVER as RETIREMENT_DRIVER, runRetirementDriver } from './hardwareAvailabilityRetirementHarness.mjs';
import { stageNoWaitAvailabilitySlots } from '../../cli/commands/noWaitAvailabilitySlots.js';
import { withEdgeGenerationApplyLock } from '../../cli/sandbox/edgeGeneration.js';
import { createHardwareAvailabilityResolverCache } from '../../cli/server/hardwareAvailabilityResolver.mjs';
import { createHardwareAvailabilityLatcher } from '../../cli/server/hardwareAvailabilityLatcher.mjs';
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

// ---- D2S.13a: a same-tuple ready publication also retires the published route's terminal slot of that tuple
const SUPERSEDED = 'hardware_availability_slot_superseded';
const DURABILITY = 'hardware_availability_entry_retirement_durability_unconfirmed';
const LATCHED = 'hardware_availability_latched';
const KILL_MARKER = 'retirement-killed-before-rename.json';
const linesOf = (run, type) => run.logs.filter((line) => line.type === type);
const SITE = Object.freeze({
    S: { phase: 'site-s', name: 'start', error: 'mergeError', field: null },
    A: { phase: 'site-a', name: 'additive', error: 'activationError', field: 'activated' },
    R: { phase: 'site-r', name: 'replacement', error: 'activationError', field: 'activated' },
    T: { phase: 'site-t', name: 'targeted-restart', error: 'commitError', field: 'committed' },
});
// What every fresh capture of the active generation denies on a route (a fresh cache: nothing is served from an earlier read).
const denialNow = (world, routeKey = 'alpha') => world.resolve({ cache: createHardwareAvailabilityResolverCache() }).denials.get(routeKey) || null;
const classOf = (world, routeKey = 'alpha') => world.resolve({ cache: createHardwareAvailabilityResolverCache() }).slots.get(routeKey)?.evidenceClass ?? null;
// Stage alpha's slot for its current tuple, as start would, and let the real worker writer give it `kind` evidence (none: missing).
function stagedSlot(world, { kind = 'hardware', reason = 'R1 refused', routeKey = 'alpha' } = {}) {
    const slot = world.stageSlot(routeKey);
    if (kind) world.writeWorker(routeKey, slot, { kind, ...(kind === 'hardware' ? { reason } : {}) });
    return slot;
}
function slotWorld(t, { kind, reason, entries = ['alpha'], routes } = {}) {
    const fixture = retirementWorld(t, { entries, ...(routes ? { routes } : {}) });
    const slot = stagedSlot(fixture.world, { kind, reason });
    return { ...fixture, slot, revision: fixture.world.store().revision };
}
// One publication of alpha's tuple at a site, through the driver; it must stand whatever retirement does.
function publish(site, fixture, extra = {}) {
    const { phase, error, field } = SITE[site];
    const argument = site === 'S'
        ? { ready: [containerOf('alpha')], ...extra }
        : { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: fixture.record('alpha'), hostPort: 0, ...extra };
    const run = runRetirementDriver(fixture.world, phase, argument);
    assert.equal(run[error], null, `${site}: the publication stands: ${JSON.stringify(run[error])}`);
    if (field) assert.equal(run[field], true, `${site}: published`);
    assert.equal(run.selectorAfter.state, 'active', `${site}: the published generation is active`);
    return run;
}
// A latcher over the world with the real apply lock; the workspace lease and network lock are stand-ins (they live under the
// process-wide workspace root), as in the latcher's own in-process leaves.
function stubLatcher(world) {
    const logs = [];
    const latcher = createHardwareAvailabilityLatcher({
        workspaceRoot: world.root,
        runningDir: world.runningDir,
        log: (type, data) => logs.push({ type, ...data }),
        locks: {
            createLease: (options) => ({ token: 'stub-lease', operation: options?.operation }),
            releaseLease: () => true,
            runWithLease: (_lease, work) => work(),
            networkLock: (callback) => callback({}),
            applyLock: (callback, options) => withEdgeGenerationApplyLock(callback, options),
        },
        retryMs: 20,
        pollMs: 60_000,
    });
    return { attempt: () => latcher.attempt(), logs };
}
// A driver child whose exit is observed, not parsed (the crash case), under the loaders every test process runs with.
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LATCHER_DRIVER = path.join(ROOT_DIR, 'tests/unit/hardwareAvailabilityLatcherDriver.mjs');
function spawnDriver(world, script, phase, argument) {
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: world.root, PLOINKY_ROUTER_HOST_PORT: '18080', PLOINKY_MEDIA_HOST_PORT: '17891' };
    delete env.NODE_TEST_CONTEXT;
    const hrefIn = (relative) => pathToFileURL(path.join(ROOT_DIR, relative)).href;
    return spawnSync(process.execPath, [
        '--import', hrefIn('tests/helpers/agentlibTestContract.mjs'),
        '--import', hrefIn('tests/helpers/engineSpawnGuard.mjs'),
        ...(process.env.C5_MUTATION ? ['--import', hrefIn('tests/hardware-limits/c5MutationRegister.mjs')] : []),
        script, phase, JSON.stringify(argument),
    ], { cwd: ROOT_DIR, env, encoding: 'utf8', timeout: 120_000 });
}
const lastJsonLine = (child, what) => {
    const line = String(child.stdout).trim().split('\n').filter(Boolean).pop();
    if (!line) throw new Error(`${what} wrote no result (exit ${child.status}, signal ${child.signal}): ${String(child.stderr).slice(-800)}`);
    const value = JSON.parse(line);
    if (value.driverError) throw new Error(`${what} failed: ${value.driverError.slice(0, 1500)}`);
    return value;
};

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
    // ---- post-failure: the apply fails, the entry is kept. L12 (D2S.13a): each world also holds alpha's active slot, which is kept too.
    {
        const r = retirementWorld(t);
        stagedSlot(r.world);
        const argument = (extra = {}) => ({ routeKey: 'alpha', container: containerOf('alpha'), registryRecord: r.record('alpha'), hostPort: 0, ...extra });
        const replacement = runRetirementDriver(r.world, 'site-r', argument({ failure: 'apply' }));
        assert.match(replacement.activationError.message, /the replacement apply failed/);
        assert.deepEqual(replacement.entriesAfter, ['alpha'], 'R with the apply failing keeps the entry');
        assert.deepEqual(replacement.slotsAfter, ['alpha'], 'L12 R: and the slot');
        assert.equal(replacement.selectorAfter.state, 'inactive', 'and the selector stays inactive');
        assert.deepEqual(replacement.witnesses, [], 'retirement never started');
        const targeted = retirementWorld(t);
        stagedSlot(targeted.world);
        const failedApply = runRetirementDriver(targeted.world, 'site-t', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: targeted.record('alpha'), failure: 'apply' });
        assert.match(failedApply.commitError.message, /the successor publication failed/);
        assert.deepEqual(failedApply.entriesAfter, ['alpha'], 'T with the apply failing keeps the entry');
        assert.deepEqual(failedApply.slotsAfter, ['alpha'], 'L12 T: and the slot');
        assert.equal(failedApply.selectorAfter.state, 'inactive', 'and the coordinated merge left the selector inactive');
        assert.deepEqual(failedApply.witnesses, []);
        const unverified = retirementWorld(t);
        stagedSlot(unverified.world);
        const failedVerify = runRetirementDriver(unverified.world, 'site-t', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: unverified.record('alpha'), failure: 'verify' });
        assert.match(failedVerify.commitError.message, /not .*exact|no longer selects its exact registered owner/);
        assert.deepEqual(failedVerify.entriesAfter, ['alpha'], 'T with the verification failing keeps the entry');
        assert.deepEqual(failedVerify.slotsAfter, ['alpha'], 'L12 T (verify): and the slot');
        assert.deepEqual(failedVerify.witnesses, []);
        // A: the additive commit throws: the predecessor stays selected and the entry is kept.
        const additive = retirementWorld(t);
        stagedSlot(additive.world);
        const failedCommit = runRetirementDriver(additive.world, 'site-a', { routeKey: 'alpha', container: containerOf('alpha'), registryRecord: additive.record('alpha'), hostPort: 0, failure: 'commit' });
        assert.match(failedCommit.activationError.message, /the additive commit failed/);
        assert.deepEqual(failedCommit.entriesAfter, ['alpha'], 'A with the commit throwing keeps the entry');
        assert.deepEqual(failedCommit.slotsAfter, ['alpha'], 'L12 A: and the slot');
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
    // ---- D2S.13a: the same commit also retires the published route's same-tuple slot when it applies to the published
    // generation and its evidence is terminal. Each case names the row of the reviewed design (L1-L15).
    // L1: an unlatched active slot of the published tuple is retired with the entry, in ONE commit, at every site.
    for (const site of ['S', 'A', 'R', 'T']) {
        const fixture = slotWorld(t);
        assert.equal(denialNow(fixture.world)?.reason, 'R1 refused', `L1 ${site}: the active slot denies before the publication`);
        const run = publish(site, fixture, { countCommits: true });
        assert.deepEqual(failureLogs(run), [], `L1 ${site}: no retirement failure`);
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [[], []], `L1 ${site}: alpha is gone from the entries and the slots`);
        assert.deepEqual(run.commits, [{ entries: [], slots: [], expectedRevision: fixture.revision }], `L1 ${site}: one commit carries both deletions`);
        assert.equal(run.witnesses.length, 1);
        assert.equal(run.witnesses[0].revision, fixture.revision, `L1 ${site}: nothing was committed between the publication and the retirement`);
        assert.deepEqual(run.witnesses[0].slots, ['alpha'], `L1 ${site}: the slot was there when retirement started`);
        assert.deepEqual(linesOf(run, SUPERSEDED), [{
            type: SUPERSEDED, site: SITE[site].name, routeKey: 'alpha', key: containerOf('alpha'), runId: fixture.slot.runId, evidenceClass: 'active', recovery: false,
        }], `L1 ${site}: one superseded line, not recovery`);
        assert.deepEqual(run.returns.map((value) => [value.retired, value.retiredSlots, value.durabilityUnconfirmed]), [[['alpha'], ['alpha'], undefined]]);
        assert.equal(denialNow(fixture.world), null, `L1 ${site}: no denial after the publication`);
        const latcher = stubLatcher(fixture.world);
        assert.notEqual(latcher.attempt().outcome, 'committed', `L1 ${site}: the latcher finds nothing to latch`);
        await stageNoWaitAvailabilitySlots({ schedule: [[]], workspaceRoot: fixture.world.root });
        assert.equal(denialNow(fixture.world), null, `L1 ${site}: the next staging leaves no denial`);
    }
    // L2: an older latched entry of the tuple beside a newer active slot: exactly ONE commit with both deletions.
    for (const site of ['A', 'T']) {
        const fixture = retirementWorld(t, { entries: [] });
        fixture.world.commitStore({ entries: { alpha: entryFor('alpha', {
            runStartedAtMs: RUN_STARTED_AT_MS - 120_000, finishedAtMs: RUN_STARTED_AT_MS - 119_000, reason: 'E1 older cause',
        }) } });
        const slot = stagedSlot(fixture.world, { reason: 'S2 newer cause' });
        const revision = fixture.world.store().revision;
        assert.equal(denialNow(fixture.world)?.reason, 'S2 newer cause', `L2 ${site}: the newer active slot decides`);
        const run = publish(site, fixture, { countCommits: true });
        assert.equal(run.commits.length, 1, `L2 ${site}: exactly one commit`);
        assert.deepEqual(run.commits[0], { entries: [], slots: [], expectedRevision: revision }, `L2 ${site}: its entries lack alpha and its slots lack alpha`);
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [[], []]);
        assert.deepEqual(failureLogs(run), [], `L2 ${site}: no retirement failure`);
        assert.deepEqual(linesOf(run, SUPERSEDED).map((line) => [line.runId, line.evidenceClass]), [[slot.runId, 'active']]);
        assert.equal(denialNow(fixture.world), null, `L2 ${site}: no denial`);
    }
    // L3: succeeded and failed-generic are terminal too: the slot is retired.
    for (const [kind, evidenceClass] of [['running', 'succeeded'], ['generic', 'failed-generic']]) {
        const fixture = slotWorld(t, { kind });
        assert.equal(classOf(fixture.world), evidenceClass, `L3 ${evidenceClass}: the fixture's evidence class`);
        const run = publish('A', fixture);
        assert.deepEqual(failureLogs(run), [], `L3 ${evidenceClass}: no retirement failure`);
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [[], []], `L3 ${evidenceClass}: the slot is retired with the entry`);
        assert.deepEqual(linesOf(run, SUPERSEDED).map((line) => [line.evidenceClass, line.recovery]), [[evidenceClass, false]]);
        assert.equal(denialNow(fixture.world), null, `L3 ${evidenceClass}: no denial`);
    }
    // L4: a pending (still live) run keeps its slot; its later refusal still activates against the published successor.
    for (const site of ['A', 'R', 'T']) {
        const fixture = slotWorld(t, { kind: 'starting' });
        assert.equal(classOf(fixture.world), 'pending');
        const run = publish(site, fixture, { countCommits: true });
        assert.deepEqual(failureLogs(run), [], `L4 ${site}: no retirement failure`);
        assert.deepEqual(run.slotsAfter, ['alpha'], `L4 ${site}: the pending slot is kept`);
        assert.deepEqual(run.entriesAfter, [], `L4 ${site}: the entry of the tuple is retired as before`);
        assert.deepEqual(run.commits, [{ entries: [], slots: null, expectedRevision: fixture.revision }], `L4 ${site}: an entries-only commit, as at the base`);
        assert.deepEqual(linesOf(run, SUPERSEDED), [], `L4 ${site}: nothing superseded`);
        assert.equal(denialNow(fixture.world), null, `L4 ${site}: no denial while the run is pending`);
        fixture.world.writeWorker('alpha', fixture.slot, { kind: 'hardware', reason: 'R1 refused' });
        assert.equal(denialNow(fixture.world)?.reason, 'R1 refused', `L4 ${site}: the run's later refusal still denies`);
    }
    // L5: missing, unowned and invalid evidence is not terminal: the slot is kept, nothing is superseded, nothing denies.
    for (const [label, prepare] of [
        ['missing', () => {}],
        ['unowned', (world, slot) => {
            world.writeWorker('alpha', slot, { kind: 'starting' });
            world.rewriteStatus(slot, (document) => { delete document.pid; });
        }],
        ['invalid', (world, slot) => {
            world.writeWorker('alpha', slot, { kind: 'hardware', reason: 'R1 refused' });
            world.rewriteStatus(slot, (document) => { document.runId = 'not-this-run'; });
        }],
    ]) {
        const fixture = slotWorld(t, { kind: null });
        prepare(fixture.world, fixture.slot);
        assert.equal(classOf(fixture.world), label, `L5 ${label}: the fixture's evidence class`);
        const run = publish('T', fixture);
        assert.deepEqual(failureLogs(run), [], `L5 ${label}: no retirement failure`);
        assert.deepEqual(run.slotsAfter, ['alpha'], `L5 ${label}: the slot is kept`);
        assert.deepEqual(linesOf(run, SUPERSEDED), [], `L5 ${label}: nothing superseded`);
        assert.equal(denialNow(fixture.world), null, `L5 ${label}: no denial`);
    }
    // L6: a terminal slot of a route that was not published is not touched, and no generation is loaded for it.
    {
        const fixture = retirementWorld(t, { routes: { alpha: {}, gamma: {} }, entries: ['alpha'] });
        const gamma = stagedSlot(fixture.world, { routeKey: 'gamma', reason: 'gamma refused' });
        assert.equal(denialNow(fixture.world, 'gamma')?.reason, 'gamma refused');
        const run = publish('A', fixture, { countLoader: true });
        assert.deepEqual(failureLogs(run), []);
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [[], ['gamma']], 'L6: alpha\'s entry is retired, gamma\'s slot is kept');
        assert.deepEqual(linesOf(run, SUPERSEDED), [], 'L6: nothing superseded');
        assert.equal(run.loaderCalls, 0, 'L6: no published route holds a same-tuple slot: no generation is loaded');
        assert.equal(denialNow(fixture.world, 'gamma')?.reason, 'gamma refused', 'L6: gamma still denies');
        assert.equal(fixture.world.store().slots.gamma.runId, gamma.runId);
    }
    // L7: a targeted successor: the slot does not apply to the published generation and is kept; staging later retires it.
    for (const site of ['A', 'R', 'T']) {
        const fixture = slotWorld(t);
        const run = publish(site, fixture, { hostPort: 43111 });
        assert.deepEqual(failureLogs(run), [], `L7 ${site}: no retirement failure`);
        assert.deepEqual(run.slotsAfter, ['alpha'], `L7 ${site}: the slot of a targeted successor is kept`);
        assert.deepEqual(linesOf(run, SUPERSEDED), [], `L7 ${site}: nothing superseded`);
        assert.equal(denialNow(fixture.world), null, `L7 ${site}: a targeted route carries no store denial`);
        await stageNoWaitAvailabilitySlots({ schedule: [[]], workspaceRoot: fixture.world.root });
        assert.deepEqual(Object.keys(fixture.world.store().slots), [], `L7 ${site}: staging retires it`);
    }
    // L8: the retirement commit fails: the publication stands, the entry AND the slot are kept, one failure line, one
    // commit attempt and no retry; the denial persists and the latcher later latches it, as recovery.
    for (const site of ['S', 'A', 'R', 'T']) {
        const fixture = slotWorld(t);
        const run = publish(site, fixture, { breakCommit: true });
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [['alpha'], ['alpha']], `L8 ${site}: the entry and the slot are kept`);
        assert.equal(failureLogs(run).length, 1, `L8 ${site}: one failure line`);
        assert.equal(failureLogs(run)[0].site, SITE[site].name);
        assert.equal(run.commits.length, 1, `L8 ${site}: one commit attempt, never retried`);
        assert.deepEqual(linesOf(run, SUPERSEDED), [], `L8 ${site}: nothing superseded`);
        assert.equal(denialNow(fixture.world)?.reason, 'R1 refused', `L8 ${site}: the denial persists`);
        const latcher = stubLatcher(fixture.world);
        assert.equal(latcher.attempt().outcome, 'committed', `L8 ${site}: the latcher resolves the kept slot`);
        assert.ok(latcher.logs.some((line) => line.type === LATCHED && line.resolution === 'latched' && line.recovery === true), `L8 ${site}: as recovery`);
        assert.equal(fixture.world.store().entries.alpha.source.runId, fixture.slot.runId);
    }
    // L9: the generation load fails: one failure line, the entry and the slot are kept, nothing is committed.
    {
        const fixture = slotWorld(t);
        const run = publish('R', fixture, { breakGeneration: true, countCommits: true });
        assert.equal(failureLogs(run).length, 1, 'L9: one failure line');
        assert.equal(failureLogs(run)[0].code, 'FIXTURE_GENERATION_LOAD_FAILED');
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [['alpha'], ['alpha']], 'L9: the entry and the slot are kept');
        assert.equal(run.loaderCalls, 1);
        assert.deepEqual(run.commits, [], 'L9: nothing is committed');
    }
    // L10: the rename happened and only the directory fsync failed: the deletion stands and is logged as committed,
    // durability unconfirmed, never as a failure; with (i) a slot and an entry and (ii) an entry only.
    for (const [label, withSlot] of [['(i) slot and entry', true], ['(ii) entry only', false]]) {
        const fixture = withSlot ? slotWorld(t) : retirementWorld(t);
        const revision = fixture.world.store().revision;
        const run = publish('A', fixture, { fsyncFails: true });
        const onDisk = fixture.world.store();
        assert.notEqual(onDisk.revision, revision, `L10 ${label}: the rename happened`);
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [[], []], `L10 ${label}: the retired items are gone on disk`);
        assert.deepEqual(failureLogs(run), [], `L10 ${label}: no failure line`);
        assert.deepEqual(linesOf(run, DURABILITY), [{ type: DURABILITY, site: 'additive', routeKeys: ['alpha'], revision: onDisk.revision }], `L10 ${label}: one durability line`);
        assert.deepEqual(linesOf(run, SUPERSEDED).map((line) => [line.routeKey, line.durabilityUnconfirmed, line.recovery]),
            withSlot ? [['alpha', true, false]] : [], `L10 ${label}: the superseded line carries durabilityUnconfirmed`);
        assert.equal(run.returns.length, 1);
        assert.equal(run.returns[0].durabilityUnconfirmed, true, `L10 ${label}: the result says durability is unconfirmed`);
        assert.equal(run.returns[0].failed, undefined, `L10 ${label}: and not failed`);
        assert.deepEqual(run.commits.map((commit) => commit.slots), [withSlot ? [] : null], `L10 ${label}: one commit`);
    }
    // L11: no published route holds a same-tuple slot: the entry is retired exactly as at the base, and no generation is loaded.
    {
        const fixture = retirementWorld(t);
        const revision = fixture.world.store().revision;
        const run = publish('R', fixture, { breakGeneration: true, countCommits: true });
        assert.equal(run.loaderCalls, 0, 'L11: no generation load');
        assert.deepEqual(failureLogs(run), [], 'L11: no failure line');
        assert.deepEqual(run.entriesAfter, [], 'L11: the entry is retired');
        assert.deepEqual(run.commits, [{ entries: [], slots: null, expectedRevision: revision }], 'L11: the base commit, with no slots key');
    }
    // L13: a crash after the publication and before the rename (T, inside its fresh apply lock): everything is kept, the dead
    // owner's locks are reclaimed by the existing rules, and the latcher then latches the kept slot as recovery.
    {
        const fixture = slotWorld(t);
        const storeDir = fixture.world.paths.availabilityStoreDir;
        const policyBefore = fs.readFileSync(fixture.world.paths.availabilityPolicyFile, 'utf8');
        const child = spawnDriver(fixture.world, RETIREMENT_DRIVER, SITE.T.phase, {
            routeKey: 'alpha', container: containerOf('alpha'), registryRecord: fixture.record('alpha'), hostPort: 0, killAtRetire: true,
        });
        assert.equal(child.signal, 'SIGKILL', `L13: the driver died at the retirement rename: ${String(child.stderr).slice(-800)}`);
        const marker = JSON.parse(fs.readFileSync(path.join(fixture.world.root, KILL_MARKER), 'utf8'));
        assert.equal(marker.pid, child.pid, 'L13: the kill happened at the retirement commit, before its rename');
        assert.equal(fs.readFileSync(fixture.world.paths.availabilityPolicyFile, 'utf8'), policyBefore, 'L13: the policy is byte-identical');
        assert.deepEqual([Object.keys(fixture.world.store().entries), Object.keys(fixture.world.store().slots)], [['alpha'], ['alpha']], 'L13: the entry and the slot are kept');
        assert.ok(fs.readdirSync(storeDir).some((name) => name.startsWith(`.policy.json.${child.pid}.`)), 'L13: the dead owner left its temp');
        assert.equal(JSON.parse(fs.readFileSync(fixture.world.paths.applyLockFile, 'utf8')).pid, child.pid, 'L13: the dead owner still names the apply lock');
        assert.equal(fixture.world.selection().state, 'active', 'L13: the publication had completed');
        assert.equal(denialNow(fixture.world)?.reason, 'R1 refused', 'L13: the denial persists');
        // The real latcher, under the real workspace lease, network lock and apply lock of the workspace, reclaims the
        // dead owner's locks (the network lock after its stale-owner grace) and latches the kept slot.
        const recovered = lastJsonLine(spawnDriver(fixture.world, LATCHER_DRIVER, 'recover', { timeoutMs: 40_000 }), 'the latcher driver');
        assert.deepEqual([recovered.snapshot.entries, recovered.snapshot.slots], [['alpha'], []], 'L13: the latcher latched the kept slot');
        assert.ok(recovered.logs.some((line) => line.type === LATCHED && line.resolution === 'latched' && line.recovery === true), 'L13: as recovery');
        assert.equal(fixture.world.store().entries.alpha.source.runId, fixture.slot.runId);
        assert.deepEqual(fs.readdirSync(storeDir).sort(), ['policy.json'], 'L13: the dead owner\'s temp is swept');
        assert.equal(fs.existsSync(fixture.world.paths.applyLockFile), false, 'L13: the reclaimed apply lock is released');
        assert.equal(denialNow(fixture.world)?.reason, 'R1 refused', 'L13: the same cause, now from the latched entry');
    }
    // L14: replay: the same publication again commits nothing and logs nothing.
    {
        const fixture = slotWorld(t);
        const first = publish('A', fixture);
        assert.deepEqual(first.entriesAfter, [], 'L14: the first publication retired the entry');
        const afterFirst = fixture.world.store().revision;
        const second = publish('A', fixture, { countCommits: true, countLoader: true });
        assert.deepEqual(second.commits, [], 'L14: no second commit');
        assert.deepEqual(second.logs, [], 'L14: no line');
        assert.equal(second.loaderCalls, 0, 'L14: no generation load');
        assert.equal(fixture.world.store().revision, afterFirst, 'L14: the replay leaves the store unchanged');
    }
    // L15: a caller without the workspace lease (today `ploinky cli <agent>`) fails closed: the publication stands, one
    // failure line, the entry and the slot are kept, and no generation is loaded.
    {
        const fixture = slotWorld(t);
        const run = publish('A', fixture, { noLease: true, countLoader: true });
        assert.equal(run.witnesses[0].lease, null, 'L15: the site ran without the workspace lease');
        assert.equal(failureLogs(run).length, 1, 'L15: one failure line');
        assert.equal(failureLogs(run)[0].code, 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED');
        assert.deepEqual([run.entriesAfter, run.slotsAfter], [['alpha'], ['alpha']], 'L15: the entry and the slot are kept');
        assert.equal(run.loaderCalls, 0, 'L15: no generation load');
        assert.equal(denialNow(fixture.world)?.reason, 'R1 refused', 'L15: the denial persists (the recorded residual)');
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
    // D2S.13a. SC1: terminal evidence is the resolver's own class list, imported, never restated.
    assert.match(helper, /import \{[^}]*\bTERMINAL_SLOT_EVIDENCE_CLASSES\b[^}]*\} from '\.\.\/server\/hardwareAvailabilityResolver\.mjs';/, 'SC1');
    // SC2: no raw evidence class, no resolve planner or resolve commit, no raw status read.
    const lines = helper.split('\n');
    const offending = (pattern) => lines.filter((line) => pattern.test(line));
    assert.deepEqual(offending(/'(active|succeeded|failed-generic|pending|missing|unowned|invalid)'|planNoWaitAvailabilitySlots|commitNoWaitAvailabilitySlotPlan|readFileSync|openSync/), [], 'SC2');
    // SC3: the helper only deletes: it never assigns an entry or a slot.
    assert.deepEqual(offending(/(entries|slots)\[[^\]]+\]\s*=[^=]/), [], 'SC3');
    // SC4: one commit call, so entries and slots go in one rename.
    assert.equal(offending(/\bcommit\(\{/).length, 1, 'SC4');
});
