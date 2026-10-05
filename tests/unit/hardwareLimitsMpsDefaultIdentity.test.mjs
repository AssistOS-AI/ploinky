// M-MPS-05: what defines the MPS daemon's configuration. `shareMemoryMiB` (the largest share the whole-GiB default came
// from) is reporting only. A client change inside the same default recreates only that client with its exact new limit; a
// real default change (another GiB, SM percentage, device, driver or wiring) still drains, quits and restarts the cohort.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mpsClientEnvironment, sameMpsServerDefault, MPS_SERVER_DEFAULT_IDENTITY } from '../../cli/sandbox/hardwareLimits/mps.mjs';
import { prepareMpsGraph } from '../../cli/sandbox/hardwareLimits/mpsGraph.mjs';
import { resolveMpsServerDefault, runMpsTransition } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';
import { createMpsLaunch, verifyMpsLaunch } from '../../cli/sandbox/hardwareLimits/mpsLaunch.mjs';

const device = { deviceUuid: 'GPU-fixture', driverVersion: '595.91.07', wiringFingerprint: 'wiring' };
// A share of a 6144-MiB device: 17% = 1044 MiB, 18% = 1105 MiB, 12% = 737 MiB, 34% = 2088 MiB.
const share = (memoryMiB, smPercent = 25) => ({ smPercent, memoryMiB, ...device });
const record = key => ({ type: 'agent', repoName: 'demo', agentName: key, instanceId: `i-${key}`, enableGeneration: `g-${key}`, containerId: key.repeat(64) });
const PIPE = `/run/ploinky/mps/pipe-${'a'.repeat(32)}`;

test('M05.the-daemon-identity-fields-are-compared-and-the-reported-share-never-counts', () => {
    const base = resolveMpsServerDefault([{ share: share(1044) }, { share: share(737) }]);
    assert.deepEqual([base.memoryMiB, base.shareMemoryMiB], [2048, 1044]);
    assert.deepEqual(MPS_SERVER_DEFAULT_IDENTITY, ['smPercent', 'memoryMiB', 'deviceUuid', 'driverVersion', 'wiringFingerprint']);
    assert.equal(sameMpsServerDefault(base, { ...base, shareMemoryMiB: 1105 }), true, 'a changed largest share alone is not a daemon change');
    assert.equal(sameMpsServerDefault(base, { ...base }), true);
    for (const [field, value] of [['smPercent', 50], ['memoryMiB', 3072], ['deviceUuid', 'GPU-other'], ['driverVersion', '600.1'], ['wiringFingerprint', 'other']]) {
        assert.equal(sameMpsServerDefault(base, { ...base, [field]: value }), false, field);
    }
    assert.equal(sameMpsServerDefault(null, null), true); assert.equal(sameMpsServerDefault(undefined, null), true);
    assert.equal(sameMpsServerDefault(base, null), false); assert.equal(sameMpsServerDefault(null, base), false);
});

// One real transition over injected engine boundaries: an owned, verified daemon with clients a and b.
function transition({ a, b, nextA }) {
    const events = [];
    const peers = [{ key: 'a', ref: 'demo/a', alias: '', ...record('a'), share: a }, { key: 'b', ref: 'demo/b', alias: '', ...record('b'), share: b }];
    const generation = 'd0:c0';
    let state = {
        schema: 1, status: 'ready', daemon: { pid: 9, startTime: '1' }, daemonGeneration: 'd0', configurationGeneration: 'c0', pipeDirectory: PIPE, logDirectory: PIPE.replace('pipe', 'log'),
        serverDefault: resolveMpsServerDefault([{ share: a }, { share: b }]), oldClients: [], pendingClients: [], drainedClients: [], lastProblem: null,
    };
    const store = { read: () => structuredClone(state), write: value => { state = structuredClone(value); } };
    const backend = {
        observe: () => ({ state: 'owned' }), verify: () => true, stop: () => events.push('stop-daemon'), cleanup: () => events.push('cleanup'),
        start: (defaults, { onState }) => { events.push('start-daemon'); const next = { ...state, daemon: { pid: 10, startTime: '2' }, daemonGeneration: 'd1', configurationGeneration: 'c1', serverDefault: defaults, status: 'ready' }; onState(next); return next; },
    };
    const input = {
        oldClients: peers.map(client => ({ ...client, mpsGeneration: generation })),
        desiredClients: [{ ...peers[0], share: nextA }, peers[1]], configuredPolicies: [{ share: nextA }, { share: b }], selectedKeys: ['a'], capability: {}, origin: 'cli',
    };
    const recreated = [];
    const result = runMpsTransition(input, {
        assertCapability: () => {}, store, backend, drain: client => events.push(`drain:${client.key}`),
        recreate: client => { events.push(`recreate:${client.key}`); recreated.push(client); return { key: client.key, state: 'applied' }; },
    });
    return { events, result, recreated, state: () => state };
}

test('M05.a-client-change-inside-the-same-default-recreates-only-that-client-and-keeps-the-daemon-and-the-peer', () => {
    // 17% to 18% of a 6144-MiB device with an unchanged 12% peer: the daemon default stays 25% and 2048 MiB.
    const run = transition({ a: share(1044), b: share(737), nextA: share(1105) });
    assert.deepEqual(run.events, ['drain:a', 'recreate:a'], 'no daemon stop or start, and the peer is neither drained nor recreated');
    assert.equal(run.state().daemonGeneration, 'd0'); assert.equal(run.state().configurationGeneration, 'c0');
    // The changed client receives its exact new limit; the reported share follows.
    assert.equal(run.recreated.length, 1);
    assert.equal(mpsClientEnvironment(run.recreated[0].share, PIPE).CUDA_MPS_PINNED_DEVICE_MEM_LIMIT, '0=1105M');
    assert.deepEqual([run.state().serverDefault.memoryMiB, run.state().serverDefault.shareMemoryMiB], [2048, 1105]);
});

test('M05.a-real-default-change-still-drains-quits-and-restarts-the-cohort', () => {
    // 2 GiB to 3 GiB (34% = 2088 MiB), and an SM default change.
    for (const [label, next] of [['2 to 3 GiB', share(2088)], ['SM default', share(1105, 50)]]) {
        const run = transition({ a: share(1044), b: share(737), nextA: next });
        assert.deepEqual(run.events.filter(event => /^(?:drain|stop-daemon|start-daemon|recreate)/.test(event)), ['drain:a', 'drain:b', 'stop-daemon', 'start-daemon', 'recreate:a', 'recreate:b'], label);
        assert.equal(run.state().daemonGeneration, 'd1', label);
    }
});

// The graph preparation judges the same default with the same helper.
function graph({ before, after }) {
    const registry = { a: record('a'), b: record('b') };
    const nodes = Object.keys(registry).map(key => ({ key, node: { manifest: { container: 'fixture', network: { mode: 'default' } } } }));
    const shares = { a: before.a, b: before.b };
    let state = { schema: 1, daemon: { pid: 1000 }, status: 'ready', daemonGeneration: 'old', configurationGeneration: 'config', serverDefault: resolveMpsServerDefault([{ share: before.a }, { share: before.b }]), oldClients: [], drainedClients: [], pendingClients: [] };
    const context = { gate: 'on', storeToken: { epoch: 'a'.repeat(32), revision: 1 }, overrides: new Map([['demo/a', { gpu: after.a }], ['demo/b', { gpu: after.b }]]) };
    const events = [];
    const deps = {
        observeClients: () => [], readContext: () => context, loadRegistry: () => registry,
        readApplied: key => ({ ...registry[key], gpuShare: shares[key], mpsGeneration: 'old:config' }),
        store: { read: () => structuredClone(state), write: next => { state = structuredClone(next); } },
        backend: { observe: () => ({ state: 'owned' }), verify: () => true }, assertCapability: () => {},
        readSelection: () => ({ selector: { state: 'inactive', generation: 'prepared', selectorDigest: 'digest' } }), resolveShare: policy => policy,
        runtime: () => 'podman', inspect: client => ({ state: 'exact', id: client.containerId, running: true }),
        drain: key => events.push(`drain:${key}`),
    };
    return { events, state: () => state, run: () => prepareMpsGraph({ nodes, networkLifecycleCapability: {} }, deps) };
}

test('M05.graph-preparation-drains-only-the-changed-client-inside-the-same-default-and-the-cohort-across-a-real-change', async () => {
    const same = graph({ before: { a: share(1044), b: share(737) }, after: { a: share(1105), b: share(737) } });
    const kept = await same.run();
    assert.deepEqual([...kept.replacedKeys], ['a']); assert.deepEqual(same.events, ['drain:a']);
    assert.equal(same.state().graphNeedsTransition, false, 'the daemon default did not change');
    const real = graph({ before: { a: share(1044), b: share(737) }, after: { a: share(2088), b: share(737) } });
    const changed = await real.run();
    assert.deepEqual([...changed.replacedKeys].sort(), ['a', 'b']); assert.deepEqual(real.events, ['drain:a', 'drain:b']);
    assert.equal(real.state().graphNeedsTransition, true);
});

// M5b: verifyMpsLaunch compares the daemon-defining fields only. The largest share is reporting and may differ between the saved state
// and the state the launch captured; a real default change is still refused.
test('M05.a-launch-whose-saved-default-differs-only-in-the-reported-share-is-not-refused-and-a-real-difference-is', () => {
    const own = share(700);
    const ready = serverDefault => ({ schema: 1, status: 'ready', daemon: { pid: 9, startTime: '1' }, daemonGeneration: 'd0', configurationGeneration: 'c0', pipeDirectory: PIPE, serverDefault });
    const captured = ready(resolveMpsServerDefault([{ share: own }]));
    const launch = createMpsLaunch({ key: 'a', share: own, state: captured, imageId: 'a'.repeat(64) });
    const backend = { verify: () => true, verifyReason: () => ({ ok: true }) };
    const verify = saved => verifyMpsLaunch(launch, 'a', own, { store: { read: () => saved }, backend });
    // Only shareMemoryMiB differs (a later pass reported another largest share): accepted.
    assert.doesNotThrow(() => verify(ready({ ...captured.serverDefault, shareMemoryMiB: 900 })));
    assert.equal(captured.serverDefault.memoryMiB, 1024);
    // A real difference in any daemon-defining field is refused as before.
    for (const [field, value] of [['smPercent', 50], ['memoryMiB', 2048], ['deviceUuid', 'GPU-other'], ['driverVersion', '600.1'], ['wiringFingerprint', 'other']]) {
        assert.throws(() => verify(ready({ ...captured.serverDefault, [field]: value })), /the server defaults changed|the server defaults are below|the device, driver or wiring differs/, field);
    }
});
