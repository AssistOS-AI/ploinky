import assert from 'node:assert/strict';
import test from 'node:test';

import {
    WebttyLaunchRecordStore,
} from '../../cli/server/webtty/launchRecords.mjs';

const RAW_ID = 'a'.repeat(64);
const OWNER = Object.freeze({ userId: 'local:admin', sessionFingerprint: 'session-a' });
const OTHER_OWNER = Object.freeze({ userId: 'local:admin', sessionFingerprint: 'session-b' });
const ROUTE = Object.freeze({
    host: 'router.localhost',
    hostRouteKey: 'control',
    generation: 'generation-a',
    activationId: 'activation-a',
});
const OTHER_ROUTE = Object.freeze({ ...ROUTE, activationId: 'activation-b' });

function randomSource() {
    let sequence = 0;
    return (bytes) => {
        sequence += 1;
        return Buffer.alloc(bytes, sequence);
    };
}

function directory(relativePath = 'projects/demo') {
    return Object.freeze({
        relativePath,
        absolutePath: `/physical/workspace/${relativePath}`,
        workspaceRealPath: '/physical/workspace',
        identity: Object.freeze({ dev: '1', ino: '2' }),
    });
}

function box(relativePath = 'projects/demo') {
    return Object.freeze({
        kind: 'box',
        directory: directory(relativePath),
        label: 'Ploinky Box',
        detail: 'Workspace runtime',
        access: 'rw',
        cwdDisplay: relativePath ? `/workspace/${relativePath}` : '/workspace',
    });
}

function agent(relativePath = 'projects/demo') {
    return Object.freeze({
        kind: 'agent',
        directory: directory(relativePath),
        runtime: 'podman',
        containerId: RAW_ID,
        containerName: 'ploinky_demo_shared',
        instanceId: 'instance-a',
        enableGeneration: 'enable-a',
        repoName: 'demo',
        agentName: 'shared',
        translatedCwd: '/workspace/projects/demo',
        label: 'shared',
        detail: 'demo/shared',
        access: 'ro',
        cwdDisplay: '/workspace/projects/demo',
    });
}

function store(options = {}) {
    return new WebttyLaunchRecordStore({ randomBytes: randomSource(), ...options });
}

test('discovery mints 192-bit opaque IDs and returns only safe bounded target rows', () => {
    const records = store();
    const discovery = records.createDiscovery({
        owner: OWNER,
        routeBinding: ROUTE,
        targets: [box(), agent()],
        agentTargetsAvailable: true,
    });
    assert.match(discovery.id, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(discovery.directory, 'projects/demo');
    assert.equal(discovery.targets[0].kind, 'box');
    assert.equal(discovery.targets[1].kind, 'agent');
    assert.match(discovery.targets[0].launch, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(discovery.targets[0].launch, discovery.targets[1].launch);
    assert.deepEqual(Object.keys(discovery.targets[1]).sort(), [
        'access', 'cwdDisplay', 'detail', 'kind', 'label', 'launch',
    ]);
    const serialized = JSON.stringify(discovery);
    assert.equal(serialized.includes(RAW_ID), false);
    assert.equal(serialized.includes('/physical/workspace'), false);
    assert.equal(serialized.includes('containerName'), false);
    assert.equal(serialized.includes('"containerId"'), false);
});

test('consume is synchronous single-use and invalidates every sibling row', () => {
    const records = store();
    const discovery = records.createDiscovery({
        owner: OWNER,
        routeBinding: ROUTE,
        targets: [box(), agent()],
    });
    const record = records.consume({
        launch: discovery.targets[1].launch,
        owner: OWNER,
        routeBinding: ROUTE,
    });
    assert.equal(record.target.containerId, RAW_ID, 'raw identity stays only in Router memory');
    assert.deepEqual(records.counts(), { batches: 0, launches: 0 });
    for (const row of discovery.targets) {
        assert.throws(
            () => records.consume({ launch: row.launch, owner: OWNER, routeBinding: ROUTE }),
            (error) => error.code === 'WEBTTY_LAUNCH_NOT_FOUND',
        );
    }
});

test('foreign owner, route replacement, expiry, unknown, and replay are non-enumerating', () => {
    let now = 1_000;
    const records = store({ now: () => now, limits: { ttlMs: 50 } });
    const discovery = records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] });
    const launch = discovery.targets[0].launch;
    const attempts = [
        { launch: 'x'.repeat(32), owner: OWNER, routeBinding: ROUTE },
        { launch, owner: OTHER_OWNER, routeBinding: ROUTE },
        { launch, owner: OWNER, routeBinding: OTHER_ROUTE },
    ];
    for (const attempt of attempts) {
        assert.throws(
            () => records.consume(attempt),
            (error) => error.code === 'WEBTTY_LAUNCH_NOT_FOUND',
        );
    }
    now += 51;
    assert.throws(
        () => records.consume({ launch, owner: OWNER, routeBinding: ROUTE }),
        (error) => error.code === 'WEBTTY_LAUNCH_NOT_FOUND',
    );
});

test('consumeAndRevalidate consumes before awaiting and never revives a stale record', async () => {
    const records = store();
    const discovery = records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] });
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const first = records.consumeAndRevalidate({
        launch: discovery.targets[0].launch,
        owner: OWNER,
        routeBinding: ROUTE,
        revalidate: async () => {
            await waiting;
            const error = new Error('stale after fresh filesystem validation');
            error.code = 'WEBTTY_TARGET_STALE';
            throw error;
        },
    });
    await assert.rejects(
        records.consumeAndRevalidate({
            launch: discovery.targets[0].launch,
            owner: OWNER,
            routeBinding: ROUTE,
            revalidate: async (target) => target,
        }),
        (error) => error.code === 'WEBTTY_LAUNCH_NOT_FOUND',
    );
    release();
    await assert.rejects(first, (error) => error.code === 'WEBTTY_TARGET_STALE');
    assert.deepEqual(records.counts(), { batches: 0, launches: 0 });
});

test('a fourth live discovery evicts only that auth session oldest batch', () => {
    let now = 100;
    const records = store({ now: () => now });
    const batches = [];
    for (let index = 0; index < 4; index += 1) {
        batches.push(records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] }));
        now += 1;
    }
    assert.deepEqual(records.counts(), { batches: 3, launches: 3 });
    assert.throws(
        () => records.consume({ launch: batches[0].targets[0].launch, owner: OWNER, routeBinding: ROUTE }),
        (error) => error.code === 'WEBTTY_LAUNCH_NOT_FOUND',
    );
    assert.equal(records.consume({
        launch: batches[1].targets[0].launch,
        owner: OWNER,
        routeBinding: ROUTE,
    }).target.kind, 'box');
});

test('global and per-discovery quotas fail without partial allocation', () => {
    const records = store({ limits: { maxLaunchRecords: 2, maxTargetsPerDiscovery: 2 } });
    assert.throws(
        () => records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box(), agent(), agent()] }),
        (error) => error.code === 'WEBTTY_LAUNCH_TARGET_INVALID',
    );
    const first = records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box(), agent()] });
    assert.equal(first.targets.length, 2);
    assert.throws(
        () => records.createDiscovery({ owner: OTHER_OWNER, routeBinding: ROUTE, targets: [box()] }),
        (error) => error.code === 'WEBTTY_LAUNCH_QUOTA',
    );
    assert.deepEqual(records.counts(), { batches: 1, launches: 2 });
});

test('a failed replacement allocation does not evict the caller existing batch', () => {
    const records = store({ limits: {
        maxLaunchRecords: 2,
        maxTargetsPerDiscovery: 2,
        maxBatchesPerAuthSession: 1,
    } });
    const retained = records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] });
    records.createDiscovery({ owner: OTHER_OWNER, routeBinding: ROUTE, targets: [box()] });
    assert.throws(
        () => records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box(), agent()] }),
        (error) => error.code === 'WEBTTY_LAUNCH_QUOTA',
    );
    assert.equal(records.consume({
        launch: retained.targets[0].launch,
        owner: OWNER,
        routeBinding: ROUTE,
    }).target.kind, 'box');
});

test('randomness failure and repeated collisions leave the prior batch consumable', () => {
    let calls = 0;
    const valid = randomSource();
    const records = new WebttyLaunchRecordStore({
        limits: { maxBatchesPerAuthSession: 1 },
        randomBytes: (bytes) => {
            calls += 1;
            return calls <= 2 ? valid(bytes) : Buffer.alloc(1);
        },
    });
    const retained = records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] });
    assert.throws(
        () => records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] }),
        { code: 'WEBTTY_LAUNCH_RANDOMNESS_INVALID' },
    );
    assert.deepEqual(records.counts(), { batches: 1, launches: 1 });
    assert.equal(records.consume({
        launch: retained.targets[0].launch,
        owner: OWNER,
        routeBinding: ROUTE,
    }).target.kind, 'box');
});

test('cancel, auth revocation, and route-generation replacement remove exact batches', () => {
    const records = store();
    const own = records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] });
    const other = records.createDiscovery({ owner: OTHER_OWNER, routeBinding: ROUTE, targets: [box()] });
    assert.equal(records.cancelDiscovery({ id: own.id, owner: OTHER_OWNER, routeBinding: ROUTE }), false);
    assert.equal(records.cancelDiscovery({ id: own.id, owner: OWNER, routeBinding: ROUTE }), true);
    assert.equal(records.invalidateAuthSession(OTHER_OWNER.sessionFingerprint), 1);
    assert.deepEqual(records.counts(), { batches: 0, launches: 0 });

    records.createDiscovery({ owner: OWNER, routeBinding: ROUTE, targets: [box()] });
    records.createDiscovery({ owner: OTHER_OWNER, routeBinding: OTHER_ROUTE, targets: [box()] });
    assert.equal(records.invalidateReplacedGenerations(OTHER_ROUTE), 1);
    assert.deepEqual(records.counts(), { batches: 1, launches: 1 });
    assert.equal(records.invalidateRouteBinding(OTHER_ROUTE), 1);
    assert.deepEqual(records.counts(), { batches: 0, launches: 0 });
    assert.equal(other.targets.length, 1);
});

test('unsafe display data and mismatched target directories are rejected before allocation', () => {
    const records = store();
    assert.throws(
        () => records.createDiscovery({
            owner: OWNER,
            routeBinding: ROUTE,
            targets: [{ ...box(), label: 'bad\nlabel' }],
        }),
        (error) => error.code === 'WEBTTY_LAUNCH_TARGET_INVALID',
    );
    assert.throws(
        () => records.createDiscovery({
            owner: OWNER,
            routeBinding: ROUTE,
            targets: [box('one'), agent('two')],
        }),
        (error) => error.code === 'WEBTTY_LAUNCH_DIRECTORY_INVALID',
    );
    assert.deepEqual(records.counts(), { batches: 0, launches: 0 });
});
