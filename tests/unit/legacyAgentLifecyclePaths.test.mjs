import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { ensureAgentService, startAgentContainer } from '../../cli/sandbox/docker/agentServiceManager.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';
import {
    assertInterimOwnedGlobalAgent, assertInterimLifecycleMutation,
    inspectInterimAgentLifecycle, isLegacyAgentLifecycleRefusal, LegacyAgentLifecycleRefusal,
    preflightInterimAgentLifecycles,
} from '../../cli/sandbox/legacyAgentLifecycleGuard.mjs';
import { networkContractHash } from '../../cli/sandbox/networkContract.js';
import { removeExactContainerAndDescriptor } from '../../cli/sandbox/docker/containerFleet.js';
import { prepareTargetedAgentRestart } from '../../cli/commands/targetedAgentRestart.js';
import { ensureGraphNodesEnabled, removeGraphContainerForRecreate } from '../../cli/commands/workspaceUtil.js';
import { withMpsEnablePreparation } from '../../cli/utils/agents.js';
import { reconcileExactHardwareInstance } from '../../cli/sandbox/hardwareLimits/reconcile.mjs';
import { prepareMpsGraph } from '../../cli/sandbox/hardwareLimits/mpsGraph.mjs';
import { coordinateMpsLifecycle } from '../../cli/sandbox/hardwareLimits/mpsLifecycle.mjs';
import { runMpsTransition, runMpsTransitionAsync } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';
import { writeRuntimePredecessor, readRuntimePredecessor } from '../../cli/sandbox/runtimePredecessorStore.js';
import { writeRuntimeCandidate, readRuntimeCandidate } from '../../cli/sandbox/runtimeCandidateStore.js';
import { lifecycleRecord, lifecycleHarness, lifecycleNetworkHarness, CONTAINER_ID } from './helpers/legacyAgentLifecycleHarness.mjs';

const refused = isLegacyAgentLifecycleRefusal;
const assertion = (runtime, runMode = 'global') => ({ record, containerId, containerName }) =>
    assertInterimOwnedGlobalAgent({ runtime, runMode, containerName, containerId, record });

for (const runtime of ['docker', 'podman']) for (const mode of ['host', 'none']) {
    test(`${runtime}/${mode}: reuse and drift classification refuse before replacement`, (t) => {
        const f = lifecycleNetworkHarness(t, { runtime, mode });
        const before = f.snapshot();
        for (const drift of [false, true]) {
            assert.throws(() => f.adapter.inspectContainerContract('agent', f.network, 'worker', {
                contractHash: networkContractHash(f.network), requireRuntimeIdentity: true,
                instanceId: drift ? 'new-instance' : f.record.instanceId, enableGeneration: f.record.enableGeneration,
                assertExistingAgent: assertion(runtime),
            }), refused);
        }
        assert.equal(f.snapshot(), before);
    });
}

for (const operation of ['adoptManagedContainerTransaction', 'runManagedContainerTransaction']) {
    for (const stopped of [false, true]) test(`${operation}: marked ${stopped ? 'stopped' : 'running'} predecessor has zero effects`, (t) => {
        const f = lifecycleNetworkHarness(t); f.inspected.State = { Running: !stopped };
        const before = f.snapshot();
        assert.throws(() => f.adapter[operation]({ network: f.network, canonicalAgentId: 'worker',
            containerName: 'agent', runtimeIdentity: f.record, assertExistingAgent: assertion('podman'),
            createContainer: () => f.effects.push('create'), inspectAdoption: () => { f.effects.push('adopt'); return { adopted: false }; },
        }), refused);
        assert.equal(f.snapshot(), before);
    });
}

for (const operation of ['adoptManagedContainerTransaction', 'runManagedContainerTransaction']) {
    test(`${operation}: marker seen only at final adoption is terminal with no cleanup or candidate receipt`, (t) => {
        const f = lifecycleNetworkHarness(t, { marked: false }); f.prepare();
        const before = JSON.stringify(f.registry);
        assert.throws(() => f.adapter[operation]({ network: f.network, canonicalAgentId: 'worker',
            containerName: 'agent', runtimeIdentity: f.record, assertExistingAgent: assertion('podman'),
            createContainer: () => f.effects.push('create'), inspectAdoption: () => {
                f.inspected.HostConfig.Privileged = true;
                return { adopted: true, finalize: () => f.effects.push('finalize') };
            },
        }), (error) => refused(error) && !Object.hasOwn(error, 'ploinkyContainerTransaction'));
        assert.deepEqual(f.effects, []); assert.equal(JSON.stringify(f.registry), before);
    });
}

test('unmarked managed validation still adopts with absent mask evidence', (t) => {
    const f = lifecycleNetworkHarness(t, { marked: false }); f.prepare();
    const result = f.adapter.adoptManagedContainerTransaction({ network: f.network, canonicalAgentId: 'worker',
        containerName: 'agent', runtimeIdentity: f.record, assertExistingAgent: assertion('podman'),
        inspectAdoption: () => ({ adopted: true }),
    });
    assert.equal(result.adopted, true); assert.deepEqual(f.effects, []);
});

for (const guard of [true, false]) test(`exact fleet ${guard ? 'implicit replacement refuses' : 'explicit cleanup remains available'}`, () => {
    const f = lifecycleHarness(undefined, { marked: ['agent'] }); const before = f.snapshot();
    const execute = () => removeExactContainerAndDescriptor('agent', f.registry.agent, 'podman', {
        inspect: f.inspect, workspaceIdentity: f.dependencies.workspaceIdentity, withLock: (callback) => callback(),
        retireRelay: () => f.effects.push('retire'), pause: () => {}, fast: true,
        ...(guard ? { assertBeforeMutation: assertInterimLifecycleMutation } : {}),
        control: (_runtime, args) => {
            f.effects.push(args[0]);
            if (args[0] === 'kill') f.containers.get(CONTAINER_ID).State.Running = false;
            if (args[0] === 'rm') f.containers.delete(CONTAINER_ID);
            return { status: 0 };
        },
    });
    if (guard) { assert.throws(execute, refused); assert.equal(f.snapshot(), before); }
    else { assert.equal(execute().removed, true); assert.ok(f.effects.includes('rm')); }
});

test('fleet checks a marker appearing at the exact pre-signal read', () => {
    const f = lifecycleHarness(); let reads = 0;
    assert.throws(() => removeExactContainerAndDescriptor('agent', f.registry.agent, 'podman', {
        inspect: (...args) => { const value = f.inspect(...args); if (++reads === 2) value.HostConfig.Privileged = true; return value; },
        workspaceIdentity: f.dependencies.workspaceIdentity, withLock: (callback) => callback(),
        assertBeforeMutation: assertInterimLifecycleMutation,
        control: () => { f.effects.push('control'); throw new Error('unexpected'); },
        retireRelay: () => f.effects.push('retire'),
    }), refused);
    assert.deepEqual(f.effects, []);
});

test('targeted restart refuses outside withdrawal fallback, including failed-drain acceptance', async () => {
    const f = lifecycleHarness(undefined, { marked: ['agent'] }); const before = f.snapshot();
    for (const acceptedFailedDrain of [null, { containerId: CONTAINER_ID }]) {
        await assert.rejects(prepareTargetedAgentRestart({ containerName: 'agent', routeKey: 'worker',
            repoName: 'demo', shortAgentName: 'worker', record: f.registry.agent, acceptedFailedDrain,
        }, { inspectLegacy: f.preflight, faultHooks: () => ({ forceUnprovableWithdrawal: true }),
            withdrawRoute: () => f.effects.push('withdraw'), mergeRouting: () => f.effects.push('fallback'),
        }), refused);
    }
    assert.equal(f.snapshot(), before);
});

test('graph batch and workspace restart preflight every member before effects', () => {
    const f = lifecycleHarness([['a', lifecycleRecord()], ['b', lifecycleRecord({ containerId: 'b'.repeat(64), agentName: 'second' })]], { marked: ['b'] });
    const before = f.snapshot();
    const nodes = new Map(Object.entries(f.registry).map(([key, record]) => [key, {
        id: key, agentRef: `${record.repoName}/${record.agentName}`, repoName: record.repoName, shortAgentName: record.agentName,
        enableSpec: `${record.repoName}/${record.agentName} isolated`,
    }]));
    assert.throws(() => ensureGraphNodesEnabled({ nodes }, f.registry, { inspectLegacy: f.preflight,
        inactivateGeneration: () => f.effects.push('inactive'), prepareAgentEnableBatch: () => f.effects.push('prepare'),
    }), refused);
    assert.throws(() => preflightInterimAgentLifecycles(Object.entries(f.registry).map(([containerName, registryRecord]) =>
        ({ containerName, registryRecord })), f.dependencies), refused);
    assert.equal(f.snapshot(), before);
});

test('enable changed successor mode checks the captured global predecessor before MPS preparation', async () => {
    const f = lifecycleHarness(undefined, { marked: ['agent'] }); const before = f.snapshot();
    await assert.rejects(withMpsEnablePreparation({}, () => f.effects.push('stage'), {
        network: (callback) => callback({}), inspectLegacy: f.preflight,
        preview: () => ({ plan: { containerName: 'agent', record: { ...f.registry.agent, runMode: 'isolated' } }, predecessor: f.registry.agent }),
        loadMps: () => { f.effects.push('mps'); throw new Error('unexpected'); },
    }), refused);
    assert.equal(f.snapshot(), before);
});

test('graph recovery removal refuses before using explicit fleet cleanup', () => {
    const f = lifecycleHarness(undefined, { marked: ['agent'] }); const before = f.snapshot();
    assert.throws(() => removeGraphContainerForRecreate('agent', 'recreate', f.registry.agent, {
        inspectLegacy: f.preflight, getRuntimeImpl: () => 'podman',
        containerExistsImpl: () => true, removeExactRegisteredContainerImpl: () => f.effects.push('remove'),
    }), refused);
    assert.equal(f.snapshot(), before);
});

test('hardware reconcile terminal refusal bypasses planning, route publication and cleanup', async () => {
    const f = lifecycleHarness(undefined, { marked: ['agent'] }); const before = f.snapshot();
    await assert.rejects(reconcileExactHardwareInstance({ key: 'agent', record: f.registry.agent }, {}, {
        inspectLegacy: f.preflight, loadRegistry: () => f.registry,
        readPolicy: () => ({ token: null }), policyCheck: () => {},
        maintenance: (_key, _options, callback) => callback(), network: (callback) => callback({}),
        loadPlan: () => f.effects.push('plan'), cleanupPrepared: () => f.effects.push('cleanup'),
        retireUnavailable: () => f.effects.push('retire'), publishUnavailable: () => f.effects.push('publish'),
    }), refused);
    assert.equal(f.snapshot(), before);
});

for (const operation of ['graph', 'coordinator']) test(`MPS ${operation}: marked second member prevents journal, image preparation and first drain`, async () => {
    const f = lifecycleHarness([['a', lifecycleRecord()], ['b', lifecycleRecord({ containerId: 'b'.repeat(64) })]], { marked: ['b'] });
    const before = f.snapshot(); const state = { oldClients: [], pendingClients: [] };
    const deps = { inspectLegacy: f.preflight, loadRegistry: () => f.registry, assertCapability: () => {},
        readContext: () => ({ gate: 'on', storeToken: null, overrides: new Map() }),
        store: { read: () => state, write: () => f.effects.push('journal') },
        readApplied: () => ({ mpsGeneration: 'old' }), runtime: () => 'podman',
        backend: {}, network: (callback) => callback({}), policyCheck: () => {},
        prepareImage: () => f.effects.push('image'), drainClient: () => f.effects.push('drain'),
    };
    if (operation === 'graph') await assert.rejects(prepareMpsGraph({
        nodes: [{ key: 'a', node: {} }, { key: 'b', node: {} }], networkLifecycleCapability: {},
    }, deps), refused);
    else await assert.rejects(coordinateMpsLifecycle({ target: { key: 'a', record: f.registry.a },
        launchTarget: () => f.effects.push('launch'),
    }, deps), refused);
    assert.equal(f.snapshot(), before); assert.deepEqual(state, { oldClients: [], pendingClients: [] });
});

for (const asyncRun of [false, true]) for (const wrapped of [false, true]) {
    test(`MPS ${asyncRun ? 'async' : 'sync'} late ${wrapped ? 'wrapped' : 'direct'} refusal cannot become partial success`, async () => {
        const events = []; let state = null;
        const terminal = new LegacyAgentLifecycleRefusal({ containerName: 'b', containerId: 'b'.repeat(64) });
        const error = wrapped ? new Error('wrapper', { cause: terminal }) : terminal;
        const clients = ['a', 'b', 'c'].map((key) => ({ key, ref: `demo/${key}`, instanceId: `i-${key}`,
            enableGeneration: `g-${key}`, containerId: key.repeat(64), share: null }));
        const input = { desiredClients: clients, selectedKeys: ['a', 'b', 'c'], capability: {} };
        const deps = { assertCapability: () => {}, store: { read: () => state, write: (next) => { state = next; events.push('journal'); } },
            backend: { observe: () => ({ state: 'gone' }) },
            recreate: (client) => { events.push(`launch:${client.key}`); if (client.key === 'b') throw error; return { key: client.key, state: 'applied' }; },
        };
        if (asyncRun) await assert.rejects(runMpsTransitionAsync(input, deps), (caught) => caught === error);
        else assert.throws(() => runMpsTransition(input, deps), (caught) => caught === error);
        assert.deepEqual(events.slice(events.indexOf('launch:b')), ['launch:b']);
        assert.equal(Object.hasOwn(error, 'mpsTransitionResults'), false);
    });
}

test('real receipt normalization cannot hide a global predecessor behind an isolated successor', (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-receipt-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const f = lifecycleHarness(undefined, { marked: ['agent'] });
    const successor = { ...f.registry.agent, instanceId: 'successor-instance', enableGeneration: 'successor-generation', runMode: 'isolated' };
    writeRuntimePredecessor({ containerName: 'agent', predecessor: f.registry.agent, successor }, { workspaceRoot: root });
    const receipt = readRuntimePredecessor('agent', successor, { workspaceRoot: root });
    assert.equal(Object.hasOwn(receipt.predecessor, 'runMode'), false);
    const deps = { ...f.dependencies, readPredecessor: (name, record) => readRuntimePredecessor(name, record, { workspaceRoot: root }) };
    for (const runMode of ['isolated', 'devel']) assert.throws(() => inspectInterimAgentLifecycle({
        containerName: 'agent', registryRecord: { ...successor, runMode },
    }, deps), refused);
    delete f.containers.get(CONTAINER_ID).Config.Labels['ploinky.procunmask'];
    assert.equal(inspectInterimAgentLifecycle({ containerName: 'agent', registryRecord: successor }, deps).state, 'exact');
    assert.deepEqual(f.effects, []);
});

test('real candidate receipt uses its own identity and unknown original mode', (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-candidate-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const f = lifecycleHarness(undefined, { marked: ['agent'] });
    writeRuntimeCandidate({ operationId: randomUUID(), containerName: 'agent', containerId: CONTAINER_ID,
        predecessorContainerId: 'b'.repeat(64), runtime: 'podman', runtimeNetwork: { mode: 'none' }, registryRecord: f.registry.agent,
    }, { workspaceRoot: root });
    const receipt = readRuntimeCandidate('agent', f.registry.agent, { workspaceRoot: root });
    assert.equal(Object.hasOwn(receipt.registryRecord, 'runMode'), false);
    assert.throws(() => inspectInterimAgentLifecycle({ containerName: 'agent', registryRecord: {
        ...f.registry.agent, containerId: 'b'.repeat(64), runMode: 'devel',
    } }, { ...f.dependencies, readCandidate: () => receipt }), refused);
    assert.deepEqual(f.effects, []);
});

test('real direct start and forced service recreation refuse before any subprocess mutation', (t) => {
    const root = PLOINKY_WORKSPACE_ROOT;
    const agentPath = path.join(root, 'demo', 'worker');
    const bin = path.join(root, 'synthetic-bin');
    fs.mkdirSync(agentPath, { recursive: true }); fs.mkdirSync(bin, { recursive: true });
    for (const engine of ['podman', 'docker']) fs.writeFileSync(path.join(bin, engine), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const priorPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${priorPath || ''}`;
    const previousSpawn = childProcess.spawnSync;
    const previousExec = childProcess.execSync;
    const previousSpawnAsync = childProcess.spawn;
    t.after(() => {
        process.env.PATH = priorPath;
        childProcess.spawnSync = previousSpawn; childProcess.execSync = previousExec; childProcess.spawn = previousSpawnAsync;
        syncBuiltinESMExports();
    });
    for (const runtime of ['docker', 'podman']) {
        const record = lifecycleRecord({ runtime });
        const f = lifecycleHarness([['agent', record]], { marked: ['agent'], workspaceRoot: root });
        const registryPath = path.join(root, '.ploinky', 'agents.json');
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.writeFileSync(registryPath, JSON.stringify(f.registry));
        const manifest = { container: 'synthetic:fixture', network: { mode: 'none' } };
        fs.writeFileSync(path.join(agentPath, 'manifest.json'), JSON.stringify(manifest));
        childProcess.spawnSync = (engine, args) => {
            if (['docker', 'podman'].includes(engine) && args[0] === 'container' && args[1] === 'inspect') {
                const value = f.inspect(engine, args[2]);
                return value ? { status: 0, stdout: JSON.stringify([value]), stderr: '' }
                    : { status: 1, stdout: '', stderr: 'no such container' };
            }
            f.effects.push(`spawn:${engine}`); throw new Error('Unexpected subprocess in lifecycle refusal test');
        };
        childProcess.execSync = () => { throw new Error('No shell fallback in lifecycle fixture'); };
        childProcess.spawn = () => { f.effects.push('spawn-async'); throw new Error('No subprocess in lifecycle fixture'); };
        syncBuiltinESMExports();
        const before = f.snapshot(); const registryBefore = fs.readFileSync(registryPath, 'utf8');
        for (const entry of [startAgentContainer, ensureAgentService]) {
            for (const forceRecreate of [false, true]) assert.throws(() => entry('worker', manifest, agentPath, {
                containerName: 'agent', routerEndpoint: null, forceRecreate,
            }), refused);
        }
        assert.equal(f.snapshot(), before); assert.equal(fs.readFileSync(registryPath, 'utf8'), registryBefore);
    }
});

for (const runtime of ['bwrap', 'seatbelt']) for (const state of ['live-exact', 'stale', 'no-engine']) {
    test(`runtime-less ${runtime} graph predecessor resolves ${state} evidence before OCI selection`, () => {
        const record = lifecycleRecord({ runtime: undefined, containerId: undefined });
        const node = { id: 'demo/worker', agentRef: 'demo/worker', repoName: 'demo', shortAgentName: 'worker',
            manifest: { 'lite-sandbox': true, network: { mode: 'none' } } };
        const registry = { agent: record }; const before = JSON.stringify(registry);
        const reached = new Error('native preflight complete');
        const events = [];
        assert.throws(() => ensureGraphNodesEnabled({ nodes: new Map([[node.id, node]]) }, registry, {
            readRuntimePredecessorImpl: () => null,
            runtimeReplacementOptions: {
                getRuntimeForAgentImpl: () => runtime,
                probeContainerRuntimeImpl: () => { events.push('engine-availability'); return null; },
            },
            observeSandboxRuntimeImpl: (_name, { expectedIdentity }) => {
                events.push('observe-native');
                assert.deepEqual(expectedIdentity, { instanceId: record.instanceId, enableGeneration: record.enableGeneration });
                return { state: state === 'live-exact' ? state : 'absent',
                    record: state === 'no-engine' ? null : { ...expectedIdentity, pid: 9, processIdentity: 'synthetic' } };
            },
            inspectLegacy: (input) => {
                assert.equal(input.registryRecord.runtime, runtime);
                const outcome = inspectInterimAgentLifecycle({ ...input, runtime: () => assert.fail('OCI lookup for native predecessor') }, {
                    readPredecessor: () => null, readCandidate: () => null,
                    inspect: () => assert.fail('OCI inspection for native predecessor'),
                });
                assert.equal(outcome.state, 'not-applicable');
                throw reached;
            },
            inactivateGeneration: () => assert.fail('no graph effects before complete preflight'),
        }), (error) => error === reached);
        assert.equal(events[0], 'observe-native'); assert.equal(JSON.stringify(registry), before);
    });
}

for (const mode of ['isolated', 'devel', undefined]) {
    test(`real recovery wrapper preserves ${mode || 'unknown'} predecessor mode provenance`, (t) => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-wrapper-')));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const captured = lifecycleRecord({ runMode: mode });
        if (mode === undefined) delete captured.runMode;
        const f = lifecycleHarness([['agent', captured]], { marked: ['agent'] });
        const successor = { ...captured, instanceId: 'successor-instance', enableGeneration: 'successor-generation', runMode: 'global' };
        writeRuntimePredecessor({ containerName: 'agent', predecessor: captured, successor }, { workspaceRoot: root });
        const receipt = readRuntimePredecessor('agent', successor, { workspaceRoot: root });
        assert.equal(Object.hasOwn(receipt.predecessor, 'runMode'), false);
        const run = () => removeGraphContainerForRecreate('agent', 'recreate', captured, {
            predecessorReceipt: receipt, inspectLegacy: f.preflight,
            getRuntimeImpl: () => 'podman', containerExistsImpl: () => true,
            readRuntimeCandidateImpl: () => null, clearLivenessStateImpl: () => f.effects.push('clear'),
            retireRuntimePredecessorImpl: () => f.effects.push('retire-receipt'),
            removeExactRegisteredContainerImpl: (name, record, options) => removeExactContainerAndDescriptor(name, record, 'podman', {
                ...options, inspect: f.inspect, workspaceIdentity: f.dependencies.workspaceIdentity,
                withLock: (callback) => callback(), retireRelay: () => f.effects.push('retire-relay'),
                fast: true, pause: () => {}, control: (_engine, args) => {
                    f.effects.push(args[0]);
                    if (args[0] === 'kill') f.containers.get(CONTAINER_ID).State.Running = false;
                    if (args[0] === 'rm') f.containers.delete(CONTAINER_ID);
                    return { status: 0 };
                },
            }),
        });
        if (mode === undefined) { assert.throws(run, refused); assert.deepEqual(f.effects, []); }
        else { assert.equal(run().removed, true); assert.deepEqual(f.effects, ['retire-relay', 'kill', 'rm', 'clear', 'retire-receipt']); }
    });
}

// Drives the caller's own reconstruction: an earlier start persisted the
// rotated isolated successor and a receipt for the global predecessor, then
// stopped. The marker appears only at the fleet's final pre-signal read.
for (const interrupted of [true, false]) {
    test(`graph ${interrupted ? 'interrupted global-to-isolated recovery' : 'fresh known-isolated replacement'} binds predecessor mode before the receipt merge`, (t) => {
        const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-graph-recovery-')));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const original = lifecycleRecord({ runMode: interrupted ? 'global' : 'isolated', projectPath: '/synthetic/agent-data' });
        const staged = interrupted
            ? { ...original, runMode: 'isolated', instanceId: 'stage-one-instance', enableGeneration: 'stage-one-generation' }
            : original;
        const f = lifecycleHarness([['agent', original]]);
        const receipts = { workspaceRoot: root };
        if (interrupted) writeRuntimePredecessor({ containerName: 'agent', predecessor: original, successor: staged }, receipts);
        const registry = { agent: structuredClone(staged) };
        const readPredecessor = (name, record) => readRuntimePredecessor(name, record, receipts);
        const preflight = (input) => inspectInterimAgentLifecycle(input, { ...f.dependencies, readPredecessor });
        const removalRecords = [];
        let ids = 0;
        const node = { id: 'demo/worker', agentRef: 'demo/worker', repoName: 'demo', shortAgentName: 'worker' };
        const run = () => ensureGraphNodesEnabled({ nodes: new Map([[node.id, node]]) }, registry, {
            inspectLegacy: preflight, uuid: () => `fresh-${++ids}`,
            executionRecordOptions: { getAgentDataDirImpl: () => '/synthetic/agent-data', workspaceRoot: root },
            runtimeReplacementReason: () => 'syntheticRuntimeChange',
            readRuntimePredecessorImpl: readPredecessor,
            writeRuntimePredecessorImpl: (receipt) => writeRuntimePredecessor(receipt, receipts),
            retireRuntimePredecessorImpl: () => {},
            loadRouting: () => ({ routes: {} }), saveRouting: () => {}, saveAgents: () => {},
            inactivateGeneration: () => {}, abortPreparation: () => {}, retireNoWaitMarkers: () => {},
            prepareAgentEnableBatch: () => ({}), logLine: () => {},
            removeAgentContainerForRecreate: (name, label, record, options) => {
                removalRecords.push(structuredClone(record));
                return removeGraphContainerForRecreate(name, label, record, {
                    ...options, inspectLegacy: preflight, getRuntimeImpl: () => 'podman', containerExistsImpl: () => true,
                    readRuntimeCandidateImpl: () => null, clearLivenessStateImpl: () => f.effects.push('clear'),
                    retireRuntimePredecessorImpl: () => f.effects.push('retire-receipt'),
                    removeExactRegisteredContainerImpl: (exactName, exactRecord, removal) => {
                        f.containers.get(CONTAINER_ID).Config.Labels['ploinky.procunmask'] = '';
                        return removeExactContainerAndDescriptor(exactName, exactRecord, 'podman', {
                            ...removal, inspect: f.inspect, workspaceIdentity: f.dependencies.workspaceIdentity,
                            withLock: (callback) => callback(), retireRelay: () => f.effects.push('retire-relay'),
                            fast: true, pause: () => {}, control: (_engine, args) => {
                                f.effects.push(args[0]);
                                if (args[0] === 'kill') f.containers.get(CONTAINER_ID).State.Running = false;
                                if (args[0] === 'rm') f.containers.delete(CONTAINER_ID);
                                return { status: 0 };
                            },
                        });
                    },
                });
            },
        });
        if (interrupted) {
            assert.throws(run, refused);
            assert.equal(removalRecords.length, 1);
            assert.equal(removalRecords[0].instanceId, original.instanceId);
            assert.equal(removalRecords[0].runMode, 'global');
            assert.deepEqual(f.effects, []);
            assert.equal(f.containers.has(CONTAINER_ID), true);
        } else {
            run();
            assert.equal(removalRecords[0].runMode, 'isolated');
            assert.deepEqual(f.effects, ['retire-relay', 'kill', 'rm', 'clear', 'retire-receipt']);
        }
    });
}
