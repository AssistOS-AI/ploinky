import assert from 'node:assert/strict';
import test from 'node:test';

import {
    canNoWaitAgentPublishHttp,
    inspectNoWaitAgentPublication,
    mapNoWaitObservationForMarketplace,
    observeNoWaitAgentRecord,
    resolveNoWaitAgentStartupState,
} from '../../cli/server/noWaitAgentStartupState.js';

const CONTAINER = 'ploinky_demo_slow';
const INSTANCE_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const INSTANCE_B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GENERATION_A = '11111111-aaaa-4bbb-8ccc-dddddddddddd';
const GENERATION_B = '22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RUN_A = '11111111-2222-4333-8444-555555555555';
const RUN_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function makeIdentity(overrides = {}) {
    const runId = overrides.runId || RUN_A;
    return {
        containerName: CONTAINER,
        instanceId: INSTANCE_A,
        enableGeneration: GENERATION_A,
        repoName: 'demo',
        shortAgent: 'slow',
        alias: '',
        routeKey: 'slow',
        runId,
        runStartedAtMs: 10_000,
        waveIndex: 0,
        statusFile: `${CONTAINER}.${runId}.json`,
        ...overrides,
    };
}

function makeFixture({ networkMode = 'default', alias = '' } = {}) {
    const routeKey = alias || 'slow';
    const record = {
        type: 'agent',
        instanceId: INSTANCE_A,
        enableGeneration: GENERATION_A,
        repoName: 'demo',
        agentName: 'slow',
        ...(alias ? { alias } : {}),
        profile: 'default',
    };
    const route = {
        container: CONTAINER,
        repo: 'demo',
        agent: 'slow',
        ...(alias ? { alias } : {}),
        hostPath: '/captured/demo/slow',
        hostPort: null,
    };
    const manifest = { network: { mode: networkMode } };
    const snapshot = {
        agents: { [CONTAINER]: record },
        manifests: { [routeKey]: manifest },
        routing: { routes: { [routeKey]: route } },
    };
    let leaseCurrent = true;
    let leaseCommits = 0;
    const plan = {
        ok: true,
        kind: 'agent-root-pending',
        target: null,
        routeKey,
        route,
        snapshot,
        lease: {
            id: `sha256:${'a'.repeat(64)}`,
            commit() {
                leaseCommits += 1;
                return leaseCurrent;
            },
        },
    };
    return {
        plan,
        route,
        record,
        manifest,
        snapshot,
        marker: makeIdentity({ alias, routeKey }),
        setLeaseCurrent(value) { leaseCurrent = value; },
        leaseCommits() { return leaseCommits; },
    };
}

function fakeObserver(state, fixture, extra = {}) {
    return () => ({ state, record: fixture.record, ...extra });
}

test('snapshot-only publication inspection proves the exact captured route, record, manifest, and profile', () => {
    const fixture = makeFixture({ alias: 'blue' });
    const publication = inspectNoWaitAgentPublication(fixture.plan);
    assert.equal(publication.ok, true);
    assert.equal(publication.containerName, CONTAINER);
    assert.equal(publication.routeKey, 'blue');
    assert.equal(publication.record, fixture.record);
    assert.equal(publication.manifest, fixture.manifest);
    assert.equal(publication.profileResolution.resolvedProfileName, 'default');
    assert.equal(publication.canPublishHttp, true);
    assert.equal(canNoWaitAgentPublishHttp(fixture.plan), true);
});

test('network.mode none is valid captured identity but cannot publish ordinary HTTP', () => {
    const fixture = makeFixture({ networkMode: 'none' });
    assert.deepEqual(inspectNoWaitAgentPublication(fixture.plan), {
        ok: true,
        containerName: CONTAINER,
        routeKey: 'slow',
        repoName: 'demo',
        shortAgent: 'slow',
        alias: '',
        record: fixture.record,
        manifest: fixture.manifest,
        profileResolution: {
            requestedProfileName: 'default',
            resolvedProfileName: 'default',
            profileConfig: null,
            network: { mode: 'none' },
        },
        canPublishHttp: false,
    });
    assert.equal(canNoWaitAgentPublishHttp(fixture.plan), false);
});

test('publication inspection fails closed for every route and registry identity mismatch', () => {
    const mutations = [
        ['plan kind', ({ plan }) => { plan.kind = 'agent-root'; }],
        ['dialable target', ({ plan }) => { plan.target = { hostname: '127.0.0.1', hostPort: 7000 }; }],
        ['route pointer', ({ plan }) => { plan.route = { ...plan.route }; }],
        ['route container', ({ route }) => { route.container = 'other-container'; }],
        ['route repository', ({ route }) => { route.repo = 'other'; }],
        ['route agent', ({ route }) => { route.agent = 'other'; }],
        ['route alias', ({ route }) => { route.alias = 'other'; }],
        ['route key', ({ plan }) => { plan.routeKey = 'other'; }],
        ['route path', ({ route }) => { route.hostPath = ''; }],
        ['record instance', ({ record }) => { record.instanceId = ''; }],
        ['record generation', ({ record }) => { record.enableGeneration = ''; }],
        ['record repository', ({ record }) => { record.repoName = 'other'; }],
        ['record agent', ({ record }) => { record.agentName = 'other'; }],
        ['record alias', ({ record }) => { record.alias = 'other'; }],
        ['record profile', ({ record }) => { record.profile = 'missing'; }],
        ['captured manifest', ({ snapshot }) => { snapshot.manifests.slow = null; }],
        ['active port', ({ route }) => { route.hostPort = 7000; }],
    ];
    for (const [label, mutate] of mutations) {
        const fixture = makeFixture();
        mutate(fixture);
        assert.deepEqual(
            inspectNoWaitAgentPublication(fixture.plan),
            { ok: false, canPublishHttp: false },
            label,
        );
    }
});

test('one-record observer reads and binds only the supplied container', () => {
    const fixture = makeFixture();
    const calls = [];
    const result = observeNoWaitAgentRecord(CONTAINER, fixture.record, {
        readRunMarker(containerName) {
            calls.push(['marker', containerName]);
            return fixture.marker;
        },
        createRunBinding(containerName, record, marker) {
            calls.push(['binding', containerName, record, marker]);
            return { ...marker, marker };
        },
        observeRun(binding, options) {
            calls.push(['observe', binding]);
            assert.equal(options.readRegistrySnapshot(), fixture.snapshot.agents);
            return { state: 'starting', queued: false, record: fixture.record };
        },
        readRegistrySnapshot: () => fixture.snapshot.agents,
    });
    assert.equal(result.state, 'starting');
    assert.deepEqual(calls.map((entry) => entry[0]), ['marker', 'binding', 'observe']);
    assert.equal(calls[0][1], CONTAINER);
});

test('one-record observer performs no bind or observation when the exact marker is absent', () => {
    let extraCalls = 0;
    const result = observeNoWaitAgentRecord(CONTAINER, makeFixture().record, {
        readRunMarker: () => null,
        createRunBinding: () => { extraCalls += 1; },
        observeRun: () => { extraCalls += 1; },
    });
    assert.equal(result, null);
    assert.equal(extraCalls, 0);
});

test('resolver maps pending, active starting, queued starting, and failed without diagnostics', () => {
    const fixture = makeFixture();
    const common = {
        readRunMarker: () => fixture.marker,
        createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
    };
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...common,
        observeRun: fakeObserver('pending', fixture),
    }), { state: 'starting', queued: false });
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...common,
        observeRun: fakeObserver('starting', fixture, { queued: false, workerPid: 9876 }),
    }), { state: 'starting', queued: false });
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...common,
        observeRun: fakeObserver('starting', fixture, { queued: true, workerPid: 9876 }),
    }), { state: 'starting', queued: true });
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...common,
        observeRun: fakeObserver('failed', fixture, {
            status: { error: { message: 'secret at /host/path:7000?token=do-not-leak' } },
        }),
    }), { state: 'failed', code: 'startup_failed' });
});

test('running maps to generation change for HTTP and terminal unavailable for targetless profiles', () => {
    const http = makeFixture();
    const targetless = makeFixture({ networkMode: 'none' });
    const optionsFor = (fixture) => ({
        readRunMarker: () => fixture.marker,
        createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
        observeRun: fakeObserver('running', fixture),
    });
    assert.deepEqual(
        resolveNoWaitAgentStartupState(http.plan, optionsFor(http)),
        { state: 'generation_changed' },
    );
    assert.deepEqual(
        resolveNoWaitAgentStartupState(targetless.plan, optionsFor(targetless)),
        { state: 'unavailable', code: 'route_unavailable' },
    );
});

test('missing, malformed, read-failed, process-unproven, and unknown states are unverified', () => {
    const hostile = [
        { readRunMarker: () => null },
        { readRunMarker: () => { throw Object.assign(new Error('secret path'), { code: 'NO_WAIT_OBSERVATION_INVALID' }); } },
        {
            readRunMarker: () => makeFixture().marker,
            createRunBinding: () => { throw Object.assign(new Error('marker malformed'), { code: 'NO_WAIT_OBSERVATION_INVALID' }); },
        },
        {
            readRunMarker: () => makeFixture().marker,
            createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
            observeRun: () => { throw Object.assign(new Error('pid 1234 is foreign'), { code: 'PROCESS_IDENTITY_MISMATCH' }); },
        },
        {
            readRunMarker: () => makeFixture().marker,
            createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
            observeRun: (binding) => ({ state: 'invented', record: makeFixture().record, binding }),
        },
    ];
    for (const options of hostile) {
        const fixture = makeFixture();
        assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, options), { state: 'unverified' });
    }
});

test('generation-A marker cannot bind to generation-B captured record', () => {
    const fixture = makeFixture();
    fixture.record.instanceId = INSTANCE_B;
    fixture.record.enableGeneration = GENERATION_B;
    const result = resolveNoWaitAgentStartupState(fixture.plan, {
        readRunMarker: () => fixture.marker,
        observeRun: () => assert.fail('generation mismatch must fail before status observation'),
    });
    assert.deepEqual(result, { state: 'generation_changed' });
});

test('generation-A/B status mismatch and superseding marker collapse to safe states', () => {
    const fixture = makeFixture();
    const base = {
        readRunMarker: () => fixture.marker,
        createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
    };
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...base,
        observeRun: () => {
            throw Object.assign(new Error(`status belongs to ${RUN_B}`), { code: 'NO_WAIT_OBSERVATION_INVALID' });
        },
    }), { state: 'unverified' });
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...base,
        observeRun: () => {
            throw Object.assign(new Error('new marker generation'), { code: 'NO_WAIT_RUN_SUPERSEDED' });
        },
    }), { state: 'generation_changed' });
});

test('stale timeout is exposed only after a second exact marker and registry fence', () => {
    const fixture = makeFixture();
    let markerReads = 0;
    const options = {
        readRunMarker: () => {
            markerReads += 1;
            return fixture.marker;
        },
        observeRun: () => {
            throw Object.assign(new Error('expired /private/state/path'), { code: 'NO_WAIT_OBSERVATION_STALE' });
        },
        readRegistrySnapshot: () => ({ [CONTAINER]: fixture.record }),
    };
    assert.deepEqual(
        resolveNoWaitAgentStartupState(fixture.plan, options),
        { state: 'failed', code: 'startup_timed_out' },
    );
    assert.equal(markerReads, 2);

    const supersedingMarker = makeIdentity({
        runId: RUN_B,
        instanceId: INSTANCE_B,
        enableGeneration: GENERATION_B,
        statusFile: `${CONTAINER}.${RUN_B}.json`,
    });
    markerReads = 0;
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...options,
        readRunMarker: () => (++markerReads === 1 ? fixture.marker : supersedingMarker),
    }), { state: 'unverified' });

    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        ...options,
        readRegistrySnapshot: () => ({
            [CONTAINER]: { ...fixture.record, profile: 'other' },
        }),
    }), { state: 'unverified' });
});

test('lease changes after lifecycle observation suppress every renderable claim', () => {
    for (const state of ['pending', 'starting', 'failed', 'running']) {
        const fixture = makeFixture({ networkMode: state === 'running' ? 'none' : 'default' });
        fixture.setLeaseCurrent(false);
        let observed = 0;
        const result = resolveNoWaitAgentStartupState(fixture.plan, {
            readRunMarker: () => fixture.marker,
            createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
            observeRun: () => {
                observed += 1;
                return {
                    state,
                    queued: false,
                    record: fixture.record,
                    status: state === 'failed' ? { error: { message: 'hidden' } } : null,
                };
            },
        });
        assert.equal(observed, 1, state);
        assert.equal(fixture.leaseCommits(), 1, state);
        assert.deepEqual(result, { state: 'generation_changed' }, state);
    }
});

test('fresh registry profile replacement after observation is unverified', () => {
    const fixture = makeFixture();
    assert.deepEqual(resolveNoWaitAgentStartupState(fixture.plan, {
        readRunMarker: () => fixture.marker,
        createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
        observeRun: () => ({
            state: 'starting',
            queued: false,
            record: { ...fixture.record, profile: 'other' },
        }),
    }), { state: 'unverified' });
    assert.equal(fixture.leaseCommits(), 0);
});

test('all Router results are allowlisted and contain no producer diagnostic material', () => {
    const fixture = makeFixture();
    const forbidden = [
        'secret-token', '/Users/operator/workspace', 'container-id', 'pid',
        'http://127.0.0.1:7000/path?token=x', '.current.json', '\n', '\u001b',
    ];
    const diagnostics = forbidden.join(' ');
    const variants = [
        resolveNoWaitAgentStartupState(fixture.plan, { readRunMarker: () => null }),
        resolveNoWaitAgentStartupState(fixture.plan, {
            readRunMarker: () => fixture.marker,
            createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
            observeRun: () => ({
                state: 'failed',
                record: fixture.record,
                status: { error: { message: diagnostics }, raw: diagnostics },
            }),
        }),
        resolveNoWaitAgentStartupState(fixture.plan, {
            readRunMarker: () => fixture.marker,
            createRunBinding: (_container, _record, marker) => ({ ...marker, marker }),
            observeRun: () => { throw Object.assign(new Error(diagnostics), { code: 'NO_WAIT_OBSERVATION_INVALID' }); },
        }),
    ];
    for (const result of variants) {
        const serialized = JSON.stringify(result);
        for (const value of forbidden) assert.equal(serialized.includes(value), false, serialized);
        assert.match(serialized, /^\{"state":"(?:unverified|failed)"(?:,"code":"startup_failed")?\}$/);
    }
});

test('Marketplace mapping preserves its detailed operator-facing response shape', () => {
    assert.deepEqual(mapNoWaitObservationForMarketplace({ state: 'pending' }), {
        status: 'starting',
        detail: 'Background startup is in progress.',
    });
    assert.deepEqual(mapNoWaitObservationForMarketplace({ state: 'starting', queued: true }), {
        status: 'starting',
        detail: 'Waiting for an earlier startup wave.',
    });
    assert.deepEqual(mapNoWaitObservationForMarketplace({
        state: 'failed',
        status: { phase: 'launch', error: { message: 'bounded operator detail' } },
    }, {
        summarizeFailure: (status) => `phase: ${status.phase} — ${status.error.message}`,
    }), {
        status: 'failed',
        detail: 'phase: launch — bounded operator detail',
    });
    assert.deepEqual(mapNoWaitObservationForMarketplace({ state: 'running' }), {
        status: 'running',
        detail: '',
    });
    assert.equal(mapNoWaitObservationForMarketplace(null), null);
});
