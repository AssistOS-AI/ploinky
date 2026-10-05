// Every start path that replaces an existing runtime says why, in one line,
// before anything is removed or created:
//   [start] <agent>: replacing its runtime (<reason>)
// The start graph covers executionChanged, profileChanged and the runtime
// reasons; ensureAgentService covers the replacements the graph left to it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

const originalCwd = process.cwd();
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-reason-')));
fs.mkdirSync(path.join(tempDir, '.ploinky'), { recursive: true });
fs.writeFileSync(path.join(tempDir, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes: {} }));
process.chdir(tempDir);

const imp = (relative) => import(new URL(relative, import.meta.url).href);
const { ensureGraphNodesEnabled, graphNodeRuntimeReplacementReason } = await imp('../../cli/commands/workspaceUtil.js');
const replacementLog = await imp('../../cli/sandbox/runtimeReplacementLog.js');
const capabilities = await imp('../../cli/sandbox/runtimeCapabilities.js');

test.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
});

const FULL_A = 'a'.repeat(64);
const FULL_B = 'b'.repeat(64);

function graphNode(overrides = {}) {
    return {
        id: 'demo/worker', repoName: 'demo', shortAgentName: 'worker', alias: '',
        agentRef: 'demo/worker', enableSpec: 'demo/worker global', profile: 'default', isStatic: false,
        manifest: { container: 'node:20-alpine', network: { mode: 'none' } },
        ...overrides,
    };
}

function graphRecord(overrides = {}) {
    return {
        type: 'agent', repoName: 'demo', agentName: 'worker', runMode: 'global', projectPath: tempDir,
        profile: 'default', instanceId: 'retained-instance', enableGeneration: 'retained-generation',
        ...overrides,
    };
}

// Runs the start graph decision with a fake engine; returns the printed lines
// and the order of removal relative to them.
function runGraph({ node = graphNode(), record = graphRecord(), replacement = {}, reason } = {}) {
    const registry = { worker_container: record };
    const lines = [];
    const events = [];
    ensureGraphNodesEnabled({ nodes: new Map([[node.id, node]]) }, registry, {
        logLine(line) { lines.push(line); events.push('line'); },
        ...(reason !== undefined ? { runtimeReplacementReason() { return reason; } } : {}),
        runtimeReplacementOptions: {
            containerExistsImpl: () => true,
            isContainerRunningImpl: () => true,
            getRuntimeForAgentImpl: () => 'podman',
            getRuntimeImpl: () => 'podman',
            computeEnvHashImpl: () => FULL_B,
            getContainerLabelImpl: () => FULL_B,
            isLlmRuntimeManifestImpl: () => false,
            createNetworkLifecycleAdapterImpl: () => ({ inspectContainerContract: () => ({ state: 'exact' }) }),
            admitRuntimeImpl: () => null,
            ...replacement,
        },
        inactivateGeneration() { events.push('inactivate'); },
        loadRouting() { return { routes: { worker: { container: 'worker_container', repo: 'demo', agent: 'worker' } } }; },
        saveRouting() {},
        saveAgents() {},
        retireNoWaitMarkers() {},
        prepareAgentEnableBatch() { return { plans: [], preparedGeneration: { selector: { state: 'inactive' } } }; },
        removeAgentContainerForRecreate() { events.push('remove'); },
        uuid: randomUUID,
        executionRecordOptions: { workspaceRoot: tempDir },
    });
    return { lines, events };
}

test('RR.graph-unchanged-runtime-prints-no-line', () => {
    const { lines, events } = runGraph();
    assert.deepEqual(lines, []);
    assert.equal(events.includes('remove'), false);
});

test('RR.graph-execution-change-names-the-differing-fields', () => {
    const { lines, events } = runGraph({ record: graphRecord({ runMode: 'isolated', projectPath: path.join(tempDir, '.data', 'worker') }) });
    assert.deepEqual(lines, [
        `[start] demo/worker: replacing its runtime (execution changed: runMode isolated -> global, projectPath ${path.join(tempDir, '.data', 'worker')} -> ${tempDir})`,
    ]);
    assert.ok(events.indexOf('line') < events.indexOf('inactivate'), 'the line precedes the first revocation');
    assert.ok(events.indexOf('line') < events.indexOf('remove'), 'the line precedes the removal');
});

test('RR.graph-profile-change-names-old-and-new-profile', () => {
    const { lines } = runGraph({ node: graphNode({ profile: 'embedded' }), record: graphRecord({ profile: 'default' }) });
    assert.deepEqual(lines, ['[start] demo/worker: replacing its runtime (profile changed: default -> embedded)']);
});

test('RR.graph-execution-and-profile-change-stay-one-line', () => {
    const { lines } = runGraph({
        node: graphNode({ profile: 'embedded' }),
        record: graphRecord({ runMode: 'isolated', profile: 'default' }),
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[start\] demo\/worker: replacing its runtime \(execution changed: runMode isolated -> global; profile changed: default -> embedded\)$/);
});

test('RR.graph-runtime-reason-code-is-printed', () => {
    const { lines } = runGraph({ reason: 'runtimeStopped' });
    assert.deepEqual(lines, ['[start] demo/worker: replacing its runtime (runtimeStopped)']);
});

test('RR.graph-env-hash-mismatch-prints-short-hashes-only', () => {
    const { lines } = runGraph({
        replacement: { computeEnvHashImpl: () => FULL_B, getContainerLabelImpl: () => FULL_A },
    });
    assert.deepEqual(lines, [`[start] demo/worker: replacing its runtime (envHashChanged: envHash ${'a'.repeat(12)} -> ${'b'.repeat(12)})`]);
    assert.equal(lines[0].includes('a'.repeat(13)), false, 'the full hash is never printed');
    assert.equal(lines[0].includes('b'.repeat(13)), false);
});

test('RR.graph-limits-hash-mismatch-prints-short-hashes-only', () => {
    const { lines } = runGraph({
        replacement: {
            admitRuntimeImpl: () => ({ descriptor: { hardwarePlacement: { limitsHash: FULL_B } } }),
            getContainerLabelImpl: (name, label) => (label === 'ploinky.limitshash' ? FULL_A : FULL_B),
        },
    });
    assert.deepEqual(lines, [`[start] demo/worker: replacing its runtime (limitsHashChanged: limitsHash ${'a'.repeat(12)} -> ${'b'.repeat(12)})`]);
});

test('RR.graph-missing-limits-label-prints-none', () => {
    const { lines } = runGraph({
        replacement: {
            admitRuntimeImpl: () => ({ descriptor: { hardwarePlacement: { limitsHash: FULL_B } } }),
            getContainerLabelImpl: (name, label) => (label === 'ploinky.limitshash' ? '' : FULL_B),
        },
    });
    assert.deepEqual(lines, [`[start] demo/worker: replacing its runtime (limitsHashChanged: limitsHash none -> ${'b'.repeat(12)})`]);
});

test('RR.graph-reason-function-still-returns-only-the-code', () => {
    const plan = { node: graphNode(), existing: { key: 'worker_container', rec: graphRecord() } };
    const code = graphNodeRuntimeReplacementReason(plan, {
        containerExistsImpl: () => true,
        isContainerRunningImpl: () => true,
        getRuntimeForAgentImpl: () => 'podman',
        getRuntimeImpl: () => 'podman',
        computeEnvHashImpl: () => FULL_B,
        getContainerLabelImpl: () => FULL_A,
        isLlmRuntimeManifestImpl: () => false,
        createNetworkLifecycleAdapterImpl: () => ({ inspectContainerContract: () => ({ state: 'exact' }) }),
        admitRuntimeImpl: () => null,
    });
    assert.equal(code, 'envHashChanged');
});

test('RR.formatting-never-prints-more-than-twelve-hash-characters-or-line-breaks', () => {
    assert.equal(replacementLog.shortHash(FULL_A), 'a'.repeat(12));
    assert.equal(replacementLog.shortHash(''), 'none');
    assert.equal(replacementLog.shortenHashes(`fingerprint ${FULL_A} != ${FULL_B}`), `fingerprint ${'a'.repeat(12)} != ${'b'.repeat(12)}`);
    assert.equal(
        replacementLog.formatRuntimeReplacementLine('demo/worker', 'x\ny'),
        '[start] demo/worker: replacing its runtime (x y)',
    );
});

// ---------------------------------------------------------------------------
// ensureAgentService: replacements the graph left to it. The production body
// runs with isolated collaborators; the replacement identity step throws so
// nothing past the line is exercised.

const source = fs.readFileSync(new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url), 'utf8');
const start = source.indexOf('function ensureAgentService(');
const end = source.indexOf('\nfunction removeExactGenerationCandidate(', start);
assert.ok(start > 0 && end > start);
const serviceSource = source.slice(start, end);
const STOP = new Error('stopped after the replacement line');

function service({ options = {}, labels = {}, hashes = { desired: FULL_B }, descriptor = {}, limitsCheck = () => null, agentLibProblem = null } = {}) {
    const lines = [];
    const events = [];
    const key = 'ploinky_demo_worker';
    const id = 'c'.repeat(64);
    const record = { type: 'agent', repoName: 'demo', agentName: 'worker', instanceId: 'instance', enableGeneration: 'generation', containerId: id, projectPath: '/fixture', runMode: 'isolated' };
    const network = { mode: 'none' };
    const manifest = { container: 'image', network };
    const admission = { descriptor, runtimeKind: 'container' };
    const noOp = () => {};
    const dependencies = {
        admitAgentServicePreflight: () => ({ preflightRepoName: 'demo', preflightManifestPath: '/fixture/manifest.json', preflightManifestBytes: Buffer.from('{}'), preflightAgentRuntime: 'podman', preflightRuntimeKind: 'container', preflightAdmission: admission, hardwareInstanceKey: key }),
        normalizeTargetedRestart: () => null,
        readAppliedObservation: () => null,
        hasMpsLaunch: () => false,
        assertNetworkLifecycleCapability: noOp,
        dependencyRefreshOperation: () => false,
        resolveAgentRepositoryName: () => 'demo',
        assertAgentServiceNotDraining: noOp,
        loadAgentsMap: () => ({ [key]: record }),
        assertPreparedRegistryRecordPreservation: () => false,
        resolveManifestRuntimeProfile: () => ({ resolvedProfileName: 'default', profileConfig: {}, network }),
        resolveLlmRuntimeAdmissionContext: () => ({ catalogPolicy: null, catalogIdentity: null }),
        admitManifestRuntimeCapabilities: () => admission,
        assertNetworkStartupCompatibility: noOp,
        assertRouterEndpoint: () => null,
        getRuntimeForAgent: () => 'podman',
        getRuntime: () => 'podman',
        containerExists: () => true,
        assertManifestEnvProfileCompleteness: noOp,
        resolveManifestImage: () => 'image',
        buildRuntimeRouterEnv: () => ({}),
        buildRuntimeNetworkPlan: () => ({ mode: 'none', hashEnv: {}, requiresManagedNetwork: false }),
        manifestUsesHealthProbeBroker: () => false,
        parseManifestPorts: () => ({ publishArgs: [], portMappings: [] }),
        assertHostPortContract: noOp,
        buildEnvMap: () => ({}),
        resolveImplicitAgentServerPort: () => 0,
        shouldCreateImplicitAgentServerPublish: () => false,
        readManifestAgentCommand: () => ({ raw: null }),
        readManifestStartCommand: () => null,
        randomUUID,
        computeEnvHash: () => hashes.desired,
        computeAgentEnvHash: () => hashes.desired,
        getContainerLabel: (name, label) => (label in labels ? labels[label] : hashes.desired),
        debugLog: noOp,
        agentLibReuseProblem: () => agentLibProblem,
        agentLibGrant: () => ({}),
        limitsHashReuseReason: limitsCheck,
        limitsHashDetail: replacementLog.limitsHashDetail,
        LIMITS_HASH_LABEL: 'ploinky.limitshash',
        // The admitted immutable dependency generation matches the desired one, and the host/none mount topology names it.
        containerDependencyReuseProblem: () => '',
        hasAdmittedDependencyMount: () => true,
        isLlmRuntimeManifest: () => false,
        createNetworkLifecycleAdapter: () => ({ inspectContainerContract: () => ({ state: 'exact', running: true, id }) }),
        effectiveInstanceKey: () => key,
        networkContractHash: () => 'network-hash',
        getConfiguredProjectPath: () => '/fixture',
        resolveAgentHomeLayout: () => ({ binds: [] }),
        getAgentWorkDir: () => '/fixture/home',
        spawnSync: () => ({ status: 0, stdout: JSON.stringify([{ Id: id }]) }),
        hasExactAgentHomeLayout: () => true,
        verifyReusableHardwareRuntime: noOp,
        assertHostModeGenerationCapability: noOp,
        deriveAgentPrincipalId: () => 'demo/worker',
        syncAgentMcpConfig: noOp,
        resolveReplacementRuntimeIdentity: () => { events.push('identity'); throw STOP; },
        formatReplacementReason: replacementLog.formatReplacementReason,
        hashMismatchDetail: replacementLog.hashMismatchDetail,
        shortenHashes: replacementLog.shortenHashes,
        logRuntimeReplacement: (agent, reason) => lines.push(replacementLog.formatRuntimeReplacementLine(agent, reason)),
        structuredClone,
    };
    const run = new Function(...Object.keys(dependencies), `${serviceSource}\nreturn ensureAgentService;`)(...Object.values(dependencies));
    const invoke = () => run('worker', manifest, '/fixture', { containerName: key, routerEndpoint: null, networkLifecycleCapability: {}, ...options });
    return {
        lines,
        events,
        runReuse: invoke,
        run: () => assert.throws(
            () => run('worker', manifest, '/fixture', { containerName: key, routerEndpoint: null, networkLifecycleCapability: {}, ...options }),
            (error) => error === STOP,
        ),
    };
}

test('RR.service-reused-runtime-prints-no-line', () => {
    const f = service();
    const result = f.runReuse();
    assert.equal(result.createdByThisLaunch, false);
    assert.deepEqual(f.lines, []);
    assert.deepEqual(f.events, []);
});

test('RR.service-env-hash-mismatch-prints-short-hashes-only', () => {
    const f = service({ labels: { 'ploinky.envhash': FULL_A } });
    f.run();
    assert.deepEqual(f.lines, [`[start] demo/worker: replacing its runtime (envHashChanged: envHash ${'a'.repeat(12)} -> ${'b'.repeat(12)})`]);
    assert.deepEqual(f.events, ['identity'], 'the line precedes the replacement identity step');
});

test('RR.service-limits-hash-mismatch-prints-short-hashes-only', () => {
    const f = service({
        labels: { 'ploinky.limitshash': FULL_A },
        descriptor: { hardwarePlacement: { limitsHash: FULL_B } },
        limitsCheck: capabilities.limitsHashReuseReason,
    });
    f.run();
    assert.deepEqual(f.lines, [`[start] demo/worker: replacing its runtime (limitsHashChanged: limitsHash ${'a'.repeat(12)} -> ${'b'.repeat(12)})`]);
});

test('RR.service-forced-replacement-names-the-requesting-path', () => {
    const named = service({ options: { forceRecreate: true, forceRecreateReason: 'restart command' } });
    named.run();
    assert.deepEqual(named.lines, ['[start] demo/worker: replacing its runtime (forceRecreate: restart command)']);
    const unnamed = service({ options: { forceRecreate: true } });
    unnamed.run();
    assert.deepEqual(unnamed.lines, ['[start] demo/worker: replacing its runtime (forceRecreate: requested by the caller)']);
});

test('RR.service-agentlib-change-prints-shortened-fingerprints', () => {
    const f = service({ agentLibProblem: `agentLib fingerprint changed (${FULL_A} != ${FULL_B})` });
    f.run();
    assert.deepEqual(f.lines, [`[start] demo/worker: replacing its runtime (agentLibSelectionChanged: agentLib fingerprint changed (${'a'.repeat(12)} != ${'b'.repeat(12)}))`]);
});
