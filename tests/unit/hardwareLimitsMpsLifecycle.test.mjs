import assert from 'node:assert/strict';
import test from 'node:test';
import { planMpsTransition, resolveMpsServerDefault, runMpsTransition } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';
import { mpsClientArgs } from '../../cli/sandbox/hardwareLimits/mps.mjs';

const share = (smPercent = 25, memoryMiB = 1024) => ({ smPercent, memoryMiB, deviceUuid: 'GPU-12345678-1234-1234-1234-123456789012', driverVersion: '595.91.07', wiringFingerprint: 'f'.repeat(64) });
const client = (key, value = share(), extra = {}) => ({ key, ref: `repo/${key}`, instanceId: `instance-${key}`, enableGeneration: `generation-${key}`, containerId: key === 'a' ? 'a'.repeat(64) : 'b'.repeat(64), share: value, mpsGeneration: 'daemon-old:config-old', ...extra });
const defaultFor = (values) => resolveMpsServerDefault(values.map((value) => ({ share: value })));
const ready = (values = [share()]) => ({ schema: 1, daemon: { pid: 12, startTime: '123', executableDev: 1, executableIno: 2 }, daemonGeneration: 'daemon-old', configurationGeneration: 'config-old', pipeDirectory: `/run/ploinky/mps/pipe-${'1'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'1'.repeat(32)}`, serverDefault: defaultFor(values), status: 'ready', oldClients: [], pendingClients: [], lastProblem: null });

function fixture(input = {}) {
    const capability = {};
    const events = [];
    const writes = [];
    let state = input.state ?? null;
    let observed = input.observed || 'owned';
    let failKey = input.failKey;
    const store = { read: () => state, write: (value) => { state = structuredClone(value); writes.push(state); events.push(`journal:${value.status}`); } };
    const backend = {
        observe: () => ({ state: observed }),
        verify: (value) => Boolean(value?.daemon && observed === 'owned'),
        stop: (value) => { assert(value.daemon); events.push('quit'); observed = 'gone'; },
        start: (defaults, { onState }) => {
            events.push('start'); const daemon = { ...ready(), daemonGeneration: 'daemon-new', configurationGeneration: 'config-new', serverDefault: defaults };
            onState({ ...daemon, status: 'starting', pendingClients: [] }); events.push('set-readback'); observed = 'owned'; return daemon;
        },
    };
    const dependencies = {
        assertCapability: (value) => { assert.equal(value, capability); events.push('capability'); }, store, backend,
        drain: (value, cap) => { assert.equal(cap, capability); assert(writes.at(-1)?.oldClients.some((entry) => entry.key === value.key)); events.push(`drain:${value.key}`); },
        recreate: (value, daemon, cap) => {
            assert.equal(cap, capability); assert.equal(writes.at(-1).pendingClients.some((entry) => entry.key === value.key), true); events.push(`create:${value.key}`);
            if (value.key === failKey) { failKey = null; throw new Error('candidate failed'); }
            const args = daemon ? mpsClientArgs(value.share, daemon) : [];
            return { key: value.key, args, state: 'applied' };
        },
    };
    const run = (extra = {}) => runMpsTransition({ oldClients: input.oldClients || [], desiredClients: input.desiredClients || [], configuredPolicies: input.configuredPolicies || input.desiredClients || [], selectedKeys: input.selectedKeys || ['a'], origin: input.origin || 'apply', capability, ...extra }, dependencies);
    return { run, events, writes, get state() { return state; }, dependencies, capability };
}

test('MPL.first-apply', () => {
    const f = fixture({ desiredClients: [client('a')] });
    const result = f.run(); assert.equal(result.plan.action, 'restart');
    assert(f.events.indexOf('set-readback') < f.events.indexOf('create:a'));
    assert.equal(f.state.status, 'ready'); assert.equal(f.state.pendingClients.length, 0);
    assert(result.results[0].args.includes('CUDA_MPS_ACTIVE_THREAD_PERCENTAGE=25'));
    assert.equal(f.writes.find((value) => value.status === 'transitioning').pendingClients.length, 1);
});
test('MPL.unchanged-reuse', () => {
    const f = fixture({ state: ready(), oldClients: [client('a')], desiredClients: [client('a')] });
    assert.equal(f.run().plan.action, 'reuse'); assert.deepEqual(f.events, ['capability']);
});
test('MPL.own-share-only', () => {
    const other = client('b', share(50, 2048));
    const next = client('a', share(30, 1200));
    const f = fixture({ state: ready([share(50, 2048)]), oldClients: [client('a'), other], desiredClients: [next, other] });
    const result = f.run(); assert.equal(result.plan.action, 'clients');
    assert(f.events.includes('drain:a')); assert(!f.events.includes('drain:b')); assert(!f.events.includes('quit')); assert(!f.events.includes('start'));
    assert.deepEqual(result.results.map((value) => value.key), ['a']);
});
test('MPL.full-cohort-drain-before-quit', () => {
    const old = [client('a'), client('b')]; const desired = [client('a', share(50, 2048)), client('b')];
    const f = fixture({ state: ready(), oldClients: old, desiredClients: desired });
    const result = f.run(); assert.deepEqual(result.plan.expandedKeys, ['b']);
    for (const key of ['a', 'b']) assert(f.events.indexOf(`drain:${key}`) < f.events.indexOf('quit'));
    assert(f.events.indexOf('quit') < f.events.indexOf('start'));
    assert(f.events.indexOf('set-readback') < f.events.indexOf('create:a'));
});
for (const [title, origin] of [['MPL.final-apply-clear', 'apply'], ['MPL.final-host-clear-restart', 'cli']]) test(title, () => {
    const f = fixture({ state: ready(), oldClients: [client('a')], desiredClients: [client('a', null)], origin });
    const result = f.run(); assert.equal(result.plan.action, 'clear');
    assert(f.events.indexOf('drain:a') < f.events.indexOf('quit')); assert(f.events.indexOf('quit') < f.events.indexOf('create:a'));
    assert(!f.events.includes('start')); assert.deepEqual(result.results[0].args, []); assert.equal(f.state.daemon, null); assert.equal(f.state.serverDefault, null);
});
test('MPL.daemon-loss', () => {
    const f = fixture({ state: ready(), observed: 'gone', oldClients: [client('a'), client('b')], desiredClients: [client('a'), client('b')] });
    const result = f.run(); assert.equal(result.plan.action, 'restart'); assert(f.events.includes('drain:b')); assert(!f.events.includes('quit'));
    assert.equal(f.state.daemonGeneration, 'daemon-new');
});
test('MPL.core-crash-journal', () => {
    const state = { ...ready(), status: 'pending', oldClients: [client('a'), client('b')], pendingClients: [client('b')] };
    const f = fixture({ state, oldClients: [], desiredClients: [client('a'), client('b')] });
    const result = f.run(); assert.deepEqual(result.plan.drain.map((value) => value.key), ['a', 'b']);
    assert(f.events.indexOf('drain:b') < f.events.indexOf('quit')); assert.equal(f.state.oldClients.length, 0);
});
test('MPL.partial-retry', () => {
    const old = [client('a'), client('b')]; const desired = [client('a', share(50, 2048)), client('b')];
    const f = fixture({ state: ready(), oldClients: old, desiredClients: desired, failKey: 'b' });
    assert.throws(() => f.run(), /candidate failed/); assert.equal(f.state.status, 'pending');
    assert.deepEqual(f.state.pendingClients.map((value) => value.key), ['b']); assert.equal(f.state.oldClients.length, 2);
    assert.equal(f.run().state.status, 'ready'); assert.equal(f.state.pendingClients.length, 0);
});
test('MPL.no-unrelated-stop', () => {
    const f = fixture({ state: ready(), oldClients: [client('a'), client('unrelated', null)], desiredClients: [client('a', share(50, 2048)), client('unrelated', null)] });
    f.run(); assert(!f.events.includes('drain:unrelated')); assert(!f.events.includes('create:unrelated'));
});
test('MPL.lock-reuse', () => {
    const f = fixture({ desiredClients: [client('a')] }); f.run(); assert.equal(f.events.filter((value) => value === 'capability').length, 1);
    assert.throws(() => runMpsTransition({ capability: {} }, f.dependencies), assert.AssertionError);
});
test('MPL.generation-drift', () => {
    const stale = client('a', share(), { mpsGeneration: 'previous:daemon' });
    const plan = planMpsTransition({ oldClients: [stale], desiredClients: [client('a')], state: ready(), observedDaemon: { state: 'owned' }, defaultsVerified: true });
    assert.equal(plan.action, 'restart'); assert.equal(plan.drain.length, 1);
    assert.throws(() => planMpsTransition({ desiredClients: [client('a')], state: ready(), observedDaemon: { state: 'foreign' }, defaultsVerified: false }), /another process/);
});
