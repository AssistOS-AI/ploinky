import assert from 'node:assert/strict';
import test from 'node:test';
import { planMpsTransition, resolveMpsServerDefault, runMpsTransition } from '../../cli/sandbox/hardwareLimits/mpsTransition.mjs';
import { mpsClientArgs } from '../../cli/sandbox/hardwareLimits/mps.mjs';

function before(events, first, second) {
    const firstIndex = events.indexOf(first), secondIndex = events.indexOf(second);
    assert(firstIndex >= 0, `Missing lifecycle event: ${first}`);
    assert(secondIndex >= 0, `Missing lifecycle event: ${second}`);
    assert(firstIndex < secondIndex, `${first} must precede ${second}`);
}

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
    before(f.events, 'set-readback', 'create:a');
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
    for (const key of ['a', 'b']) before(f.events, `drain:${key}`, 'quit');
    before(f.events, 'quit', 'start');
    before(f.events, 'set-readback', 'create:a');
});
for (const [title, origin] of [['MPL.final-apply-clear', 'apply'], ['MPL.final-host-clear-restart', 'cli']]) test(title, () => {
    const f = fixture({ state: ready(), oldClients: [client('a')], desiredClients: [client('a', null)], origin });
    const result = f.run(); assert.equal(result.plan.action, 'clear');
    before(f.events, 'drain:a', 'quit'); before(f.events, 'quit', 'create:a');
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
    before(f.events, 'drain:b', 'quit'); assert.equal(f.state.oldClients.length, 0);
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

test('MPS recovery drains a created pending candidate before stopping its daemon', () => {
    const pending = client('orphan', share(), { containerId: 'c'.repeat(64), mpsGeneration: 'daemon-old:config-old', phase: 'readiness' });
    const state = { ...ready(), pendingClients: [pending], status: 'pending' };
    const f = fixture({ state, oldClients: [client('a')], desiredClients: [client('a', share(50,2048))] });
    f.run(); before(f.events, 'drain:orphan', 'quit');
});
test('MPS recovered pending observation can share an exact already-recorded identity', () => {
    const same = client('a');
    const plan = planMpsTransition({ oldClients: [same], desiredClients: [same], state: { ...ready(), pendingClients: [{ ...same, phase: 'readiness' }] }, observedDaemon: { state: 'owned' }, defaultsVerified: true });
    assert.equal(plan.action, 'reuse'); assert.equal(plan.oldClients.length, 1);
});

test('MPS uncreated intent retaining predecessor CID is not a created observation', () => {
    const applied = client('a');
    const desired = { ...applied, share: share(50, 2048) }; delete desired.mpsGeneration;
    const plan = planMpsTransition({oldClients:[applied],desiredClients:[desired],state:{...ready(),status:'pending',pendingClients:[{...desired,phase:'pending'}]},observedDaemon:{state:'owned'},defaultsVerified:true});
    assert.equal(plan.oldClients.length,1); assert.deepEqual(plan.oldClients[0],applied);
});

// Fix round 3, M3: one failing share client neither stalls nor churns the cohort.
function cohortFixture() {
    const share = (sm, mem) => ({ smPercent: sm, memoryMiB: mem, deviceUuid: 'GPU-12345678-1234-1234-1234-123456789012', driverVersion: '595.91.07', wiringFingerprint: 'f'.repeat(64) });
    const member = (key, value) => ({ key, ref: `repo/${key}`, alias: '', instanceId: `i-${key}`, enableGeneration: `g-${key}`, containerId: { a: 'a', b: 'b', c: 'c' }[key].repeat(64), share: value, mpsGeneration: 'd0:c0' });
    let state = { schema: 1, status: 'ready', daemon: { pid: 7, startTime: '1' }, daemonGeneration: 'd0', configurationGeneration: 'c0', pipeDirectory: `/run/ploinky/mps/pipe-${'1'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'1'.repeat(32)}`, serverDefault: resolveMpsServerDefault([{ share: share(25, 1024) }]), oldClients: [], pendingClients: [] };
    let alive = true;
    const events = [];
    const backend = {
        observe: () => ({ state: alive ? 'owned' : 'gone', daemon: state.daemon }), verify: (value) => Boolean(value?.daemon) && alive,
        stop: () => { events.push('quit'); alive = false; }, cleanup: () => events.push('cleanup'),
        start: (defaults, { onState }) => { events.push('start'); const next = { ...state, daemon: { pid: 8, startTime: '2' }, daemonGeneration: 'd1', configurationGeneration: 'c1', serverDefault: defaults, pipeDirectory: `/run/ploinky/mps/pipe-${'2'.repeat(32)}`, logDirectory: `/run/ploinky/mps/log-${'2'.repeat(32)}` }; onState(next); alive = true; return { ...next, status: 'ready' }; },
    };
    const store = { read: () => state, write: (value) => { state = structuredClone(value); } };
    const [a, b, c] = ['a', 'b', 'c'].map((key) => member(key, share(25, 1024)));
    const run = (failing, selected = ['a']) => runMpsTransition({ oldClients: [a, b, c], desiredClients: [{ ...a, share: share(50, 2048) }, b, c], configuredPolicies: [{ share: share(50, 2048) }, { share: b.share }, { share: c.share }], selectedKeys: selected, capability: {}, origin: 'cli' }, {
        assertCapability: () => {}, store, backend, drain: (value) => events.push(`drain:${value.key}`),
        recreate: (value) => { if (value.key === failing) { events.push(`create:${value.key}:failed`); throw new Error(`${value.key} readiness failed`); } events.push(`create:${value.key}`); return { key: value.key, state: 'applied' }; },
    });
    return { run, events, get state() { return state; } };
}

test('MPL.p6-peer-failure-recreates-the-rest-and-reports-a-ready-daemon', async () => {
    const { readMpsStatus } = await import('../../cli/sandbox/hardwareLimits/mpsStatus.mjs');
    const f = cohortFixture();
    let thrown;
    assert.throws(() => f.run('b'), (error) => { thrown = error; return /b readiness failed/.test(error.message); });
    // c is still recreated after b fails, and every client has its outcome.
    assert.ok(f.events.includes('create:c'), f.events.join(' '));
    assert.deepEqual(thrown.mpsTransitionResults.map((value) => [value.key, value.state]), [['a', 'applied'], ['b', 'pending'], ['c', 'applied']]);
    // The cohort stays pending for retry from observations; b is its pending client.
    assert.equal(f.state.status, 'pending');
    assert.deepEqual(f.state.pendingClients.map((value) => value.key), ['b']);
    // Daemon health is separate: the verified d1 generation is ready.
    const status = readMpsStatus({ workspaceRoot: '/w', readGrant: () => ({ valid: true, state: 'active', mps: {}, fingerprint: 'f'.repeat(64) }),
        observeGpu: () => ({ uuid: 'GPU-12345678-1234-1234-1234-123456789012', driverVersion: '595.91.07', memoryModel: 'dedicated', name: 'RTX', memoryMiB: 12288 }),
        readState: () => f.state, backend: { observe: () => ({ state: 'owned' }), verify: () => true } });
    assert.equal(status.daemonStatus, 'ready');
    assert.equal(status.mpsGeneration, 'd1:c1');
    assert.equal(status.clientsPending, true);
});

test('MPL.p6-selected-failure-still-recreates-the-cohort', () => {
    const f = cohortFixture();
    assert.throws(() => f.run('a'), (error) => /a readiness failed/.test(error.message) && error.mpsTransitionResults?.length === 3);
    assert.ok(f.events.includes('create:b') && f.events.includes('create:c'), f.events.join(' '));
    assert.deepEqual(f.state.pendingClients.map((value) => value.key), ['a']);
});
