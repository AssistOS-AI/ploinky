// A repeat `ploinky start` of unchanged, running, limited fixture agents must
// replace none of them (amendment A2: the same effective values give the same
// limits hash, so nothing restarts). The host half proves the environment gate
// and the saved gate select identical wiring and rewrite nothing; the in-Box
// half runs the graph reuse decision of the start path twice over real
// admissions against the cgroup fake, with the running containers' limits
// labels taken from the arguments the creation path renders, never from the
// decision itself.
//
// SCOPE: the ENVIRONMENT hash is stubbed here (computeEnvHashImpl,
// computeRetainedManagedEnvHashImpl and the envhash label are one constant), so
// this file proves the limits decision and the graph wiring GIVEN EQUAL env
// hashes. It does not prove that the creation path and the graph compute equal
// env hashes; hardwareLimitsEnvHashConsistency.test.mjs does, with the real
// creation path, the real builders and the real hash functions.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

const originalCwd = process.cwd();
const originalEnv = {
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
};
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-repeat-')));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'home');
fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
fs.mkdirSync(home);
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '8080';
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);

const markerPath = path.join(root, 'ploinky-box');
fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
const boxMarkerOptions = { markerPath };


const imp = (relative) => import(new URL(relative, import.meta.url).href);
const { buildWorkspaceIdentity } = await imp('../../ploinky-box/identity.mjs');
const { createHardwareGateStore, resolveDesiredHardwareWiring, selectHardwareGate } = await imp('../../ploinky-box/hardwareLimitsGate.mjs');
const { initializeStore } = await imp('../../cli/sandbox/hardwareLimits/store.mjs');
const { readBoxHardwareContext, resetHardwareContextCacheForTests } = await imp('../../cli/sandbox/hardwareLimits/context.mjs');
const { preparedCgroupFs } = await imp('../hardware-limits/fakeCgroupFs.mjs');
const { FIXTURE_REPOSITORY, fixtureManifest, fixturePlan } = await imp('../hardware-limits/liveFixture.mjs');
const workspaceUtil = await import(new URL('../../cli/commands/workspaceUtil.js', import.meta.url).href);
const workspaceSvc = await import(new URL('../../cli/utils/workspace.js', import.meta.url).href);
const dockerSvc = await import(new URL('../../cli/sandbox/docker/index.js', import.meta.url).href);
const capabilities = await import(new URL('../../cli/sandbox/runtimeCapabilities.js', import.meta.url).href);
const profileService = await import(new URL('../../cli/utils/runtime/profileService.js', import.meta.url).href);
const structure = await import(new URL('../../cli/utils/workspaceStructure.js', import.meta.url).href);

const { ensureGraphNodesEnabled, preflightWorkspaceStartRuntimeCapabilities, createGraphAvailabilityTracker } = workspaceUtil;

test.after(() => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});

const IMAGE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
const STATIC_REF = `${FIXTURE_REPOSITORY}/memory`;
const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
const ROOT = '/sys/fs/cgroup';

// The same three agents the live fixture writes (liveFixture.mjs).
const agents = fixturePlan(['LIVE-C1', 'LIVE-C2']);
for (const agent of agents) {
    const directory = path.join(workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY, agent.name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(fixtureManifest(agent, { image: IMAGE, agents }), null, 2)}\n`);
}

const readyQuery = () => ({ ok: true, stdout: JSON.stringify({ host: { ociRuntime: { name: 'crun' }, cgroupManager: 'cgroupfs' } }) });
const failedQuery = () => ({ ok: false, status: null, stdout: '' });

// Real files for the marker and the bound store; the fake for cgroup and proc.
// The Box's own facts the envelope is read from: 8 GiB, no namespace-root cap.
const SERVED = new Map([['/proc/meminfo', 'MemTotal:     8388608 kB\n'], [`${ROOT}/memory.max`, 'max\n'], [`${ROOT}/cpu.max`, 'max 100000\n']]);
function compositeFs(fake) {
    const routed = new Set(['readFileSync', 'lstatSync', 'mkdirSync', 'writeFileSync', 'readdirSync', 'rmdirSync']);
    return new Proxy(fs, {
        get(target, property) {
            if (!routed.has(property)) return target[property];
            return (first, ...rest) => {
                const value = typeof first === 'string' ? first : '';
                if (property === 'readFileSync' && SERVED.has(value)) return SERVED.get(value);
                if (value === ROOT || value.startsWith(`${ROOT}/`) || value.startsWith('/proc/')) return fake[property](first, ...rest);
                return target[property](first, ...rest);
            };
        },
    });
}

const lock = { assertHeld() {} };
const gateStore = createHardwareGateStore({ homeDirectory: home });
const wire = () => resolveDesiredHardwareWiring({ identity, enabled: true, hostKind: 'podman-machine', homeDirectory: home, initializeStore });
const bytesOf = (file) => fs.readFileSync(file);

test('RS.host-env-gate-repeat-and-saved-gate-repeat-select-the-same-wiring-and-rewrite-nothing', () => {
    const first = selectHardwareGate({ identity, gateStore, env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, operation: 'start' });
    assert.deepEqual([first.enabled, first.source, first.persist], [true, 'environment', true]);
    const firstWiring = wire();
    gateStore.write(identity, first.enabled, lock);
    const gateRecord = gateStore.recordPath(identity);
    const recordBefore = bytesOf(gateRecord);
    const markerBefore = bytesOf(firstWiring.markerPath);

    const envRepeat = selectHardwareGate({ identity, gateStore, env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, operation: 'start' });
    const envWiring = wire();
    const savedRepeat = selectHardwareGate({ identity, gateStore, env: {}, operation: 'start' });
    const savedWiring = wire();

    assert.deepEqual([envRepeat.enabled, envRepeat.source, envRepeat.persist, envRepeat.changed, envRepeat.note], [true, 'environment', false, false, null]);
    assert.deepEqual([savedRepeat.enabled, savedRepeat.source, savedRepeat.persist, savedRepeat.changed, savedRepeat.note], [true, 'saved', false, false, null]);
    for (const wiring of [envWiring, savedWiring]) {
        assert.equal(wiring.fingerprint, firstWiring.fingerprint, 'the Box label that drives Box replacement is unchanged');
        assert.equal(wiring.markerPath, firstWiring.markerPath);
        assert.equal(wiring.storeId, firstWiring.storeId);
        assert.deepEqual(wiring.mounts, firstWiring.mounts);
    }
    assert.deepEqual(bytesOf(gateRecord), recordBefore, 'the saved gate record is not rewritten');
    assert.deepEqual(bytesOf(firstWiring.markerPath), markerBefore, 'the wiring marker is not rewritten');
});

// ---------------------------------------------------------------------------
// In-Box: one fresh `ploinky-local start` process per call.

function boxContext({ query = readyQuery } = {}) {
    const wiring = wire();
    resetHardwareContextCacheForTests();
    const fake = preparedCgroupFs({ controllers: ['cpu', 'memory', 'pids'] });
    return readBoxHardwareContext({ fsApi: compositeFs(fake), markerPath: wiring.markerPath, storeRoot: wiring.storeRoot, query });
}

function admission(ref, name, context, { mode = 'strict' } = {}) {
    const manifestPath = path.join(workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY, name, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const profile = profileService.resolveManifestRuntimeProfile(manifest, { agentName: ref, path: `manifest(${ref})` });
    return capabilities.admitManifestRuntimeCapabilities(manifest, {
        manifestBytes,
        manifestPath,
        agentId: ref,
        profileName: profile.resolvedProfileName,
        profileConfig: profile.profileConfig,
        network: profile.network,
        runtime: 'podman',
        runtimeKind: 'container',
        hardwareAdmission: mode,
        hardwareContext: context,
        boxMarkerOptions,
        workspaceRoot: workspace,
        instanceKey: dockerSvc.getAgentContainerName(name, FIXTURE_REPOSITORY),
        alias: '',
    });
}

// What the engine recorded when it created each agent: the labels of the
// arguments the creation path renders from a strict admission.
function createdLabels(context) {
    const labels = {};
    for (const agent of agents) {
        const created = admission(`${FIXTURE_REPOSITORY}/${agent.name}`, agent.name, context);
        const args = capabilities.renderRuntimePolicyArgs(created.descriptor, { runtime: 'podman' });
        const found = {};
        args.forEach((value, index) => {
            if (value === '--label') { const [key, ...rest] = args[index + 1].split('='); found[key] = rest.join('='); }
        });
        // The env hash label is the constant the stubbed hash functions return (see SCOPE above).
        labels[dockerSvc.getAgentContainerName(agent.name, FIXTURE_REPOSITORY)] = { ...found, 'ploinky.envhash': 'envhash' };
    }
    return labels;
}

function registryAfterFirstStart() {
    const registry = {};
    agents.forEach((agent, index) => {
        const key = dockerSvc.getAgentContainerName(agent.name, FIXTURE_REPOSITORY);
        registry[key] = {
            type: 'agent', agentName: agent.name, repoName: FIXTURE_REPOSITORY, containerImage: IMAGE,
            runMode: 'isolated', profile: 'default',
            projectPath: agent.name === 'memory' ? workspace : structure.getAgentDataDir(agent.name),
            instanceId: `instance-${agent.name}`, enableGeneration: `generation-${agent.name}`,
            containerId: String(index + 1).repeat(64), auth: { mode: 'none' },
            config: { binds: [], env: [], ports: [] },
        };
    });
    registry._config = { static: { agent: STATIC_REF, port: 8080 } };
    // The first start persisted its Router port.
    fs.writeFileSync(path.join(workspace, '.ploinky', 'routing.json'), `${JSON.stringify({ port: 8080, routes: {} })}\n`);
    workspaceSvc.saveAgents(registry);
    return registry;
}

// The start path's graph decision for one start process, with only the engine
// facts faked: every agent exists, runs and carries its creation labels.
function repeatStart(context, labels) {
    const registry = registryAfterFirstStart();
    const before = structuredClone(registry);
    const preflight = preflightWorkspaceStartRuntimeCapabilities(STATIC_REF, { hardwareContext: context, boxMarkerOptions });
    const unavailable = new Set(createGraphAvailabilityTracker(preflight.graph, preflight.admissions).unavailableEntries().map((entry) => entry.nodeId));
    const removed = [];
    const prepared = ensureGraphNodesEnabled(preflight.graph, preflight.registry, {
        hardwareContext: context,
        boxMarkerOptions,
        unavailableNodeIds: unavailable,
        prepareAgentEnableBatch: () => ({ plans: [], preparedGeneration: { selector: { state: 'inactive' } } }),
        saveAgents() {}, loadRouting: () => ({ routes: {} }), saveRouting() {}, inactivateGeneration() {}, retireNoWaitMarkers() {},
        removeAgentContainerForRecreate: (key, reason) => removed.push({ key, reason }),
        executionRecordOptions: { workspaceRoot: workspace },
        runtimeReplacementOptions: {
            containerExistsImpl: () => true,
            isContainerRunningImpl: () => true,
            getRuntimeForAgentImpl: () => 'podman',
            getRuntimeImpl: () => 'podman',
            // Stubbed on purpose: this test is about the limits decision given equal env hashes.
            computeEnvHashImpl: () => 'envhash',
            computeRetainedManagedEnvHashImpl: () => 'envhash',
            getContainerLabelImpl: (key, label) => labels[key]?.[label] ?? '',
            createNetworkLifecycleAdapterImpl: () => ({ inspectContainerContract: () => ({ state: 'exact', running: true }) }),
            // The production graph reuse admission (admitGraphNodeHardwareDescriptor)
            // reads the fixed /etc/ploinky-box marker; the fixture marker and the
            // captured context stand in for the Box, nothing else is replaced.
            admitRuntimeImpl: (node) => {
                const found = admission(`${node.repoName}/${node.shortAgentName}`, node.shortAgentName, context, { mode: 'metadata' });
                return { descriptor: found.descriptor };
            },
        },
    });
    return { prepared, removed, registry, before, unavailable, preflight };
}

test('RS.repeat-start-twice-replaces-no-limited-agent-when-the-env-hashes-are-equal', () => {
    const creation = boxContext();
    assert.equal(creation.gate, 'on');
    assert.equal(creation.prepared, true);
    assert.equal(creation.backendReady, true);
    const labels = createdLabels(creation);
    for (const labelSet of Object.values(labels)) assert.match(labelSet['ploinky.limitshash'], /^[a-f0-9]{64}$/, 'the creation path rendered a limits hash label');
    for (const start of ['environment gate', 'saved gate']) {
        // Each start is a new ploinky-local process: new context, empty backend cache.
        const result = repeatStart(boxContext(), labels);
        assert.deepEqual([...result.unavailable], [], `${start}: no agent is refused`);
        assert.deepEqual(result.prepared.changedContainers, [], `${start}: no agent is planned for replacement`);
        assert.deepEqual(result.removed, [], `${start}: no agent container is removed`);
        assert.deepEqual(result.registry, result.before, `${start}: no instance or generation is rotated`);
    }
});

test('RS.service-reuse-comparison-matches-the-creation-label', () => {
    const labels = createdLabels(boxContext());
    for (const agent of agents) {
        const key = dockerSvc.getAgentContainerName(agent.name, FIXTURE_REPOSITORY);
        const service = admission(`${FIXTURE_REPOSITORY}/${agent.name}`, agent.name, boxContext());
        assert.equal(capabilities.limitsHashReuseReason(service.descriptor, labels[key]['ploinky.limitshash']), null, `${agent.name} service-level comparison`);
    }
});

test('RS.a-nested-backend-probe-failure-is-the-plan-defined-way-limited-agents-are-removed', () => {
    // Plan 8.3 and 9.1: an unprepared backend refuses limited agents, and a
    // refused instance keeps no runtime. This is the only start-time input that
    // removes a healthy limited agent without any configuration change, so a
    // live start whose nested `podman info` fails or times out looks exactly
    // like a recreation. Pinned here so the live evidence can tell them apart.
    const labels = createdLabels(boxContext());
    const result = repeatStart(boxContext({ query: failedQuery }), labels);
    assert.equal(result.unavailable.size, 3);
    assert.deepEqual(result.removed.map((entry) => entry.reason.split(':').pop()).sort(), ['hardwareUnavailable', 'hardwareUnavailable', 'hardwareUnavailable']);
});
