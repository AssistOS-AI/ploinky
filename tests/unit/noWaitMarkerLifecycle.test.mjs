import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    retireNoWaitRunMarker,
    retireNoWaitRunMarkers,
} from '../../cli/commands/noWaitMarkerLifecycle.js';

const CONTAINER = 'ploinky_demo_worker';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const RETIREMENT_ID = '99999999-8888-4777-a666-555555555555';
const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function markerIdentity(overrides = {}) {
    return {
        containerName: CONTAINER,
        instanceId: INSTANCE_ID,
        enableGeneration: 'ffffffff-1111-4222-8333-444444444444',
        repoName: 'demo',
        shortAgent: 'worker',
        alias: '',
        routeKey: 'worker',
        runId: RUN_ID,
        runStartedAtMs: 1_700_000_000_000,
        waveIndex: 0,
        statusFile: `${CONTAINER}.${RUN_ID}.json`,
        ...overrides,
    };
}

function expectedRecord(identity = markerIdentity()) {
    return {
        type: 'agent',
        instanceId: identity.instanceId,
        enableGeneration: identity.enableGeneration,
        repoName: identity.repoName,
        agentName: identity.shortAgent,
        ...(identity.alias ? { alias: identity.alias } : {}),
    };
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-marker-retire-'));
    const runningDir = path.join(root, 'running');
    const markerDirectory = path.join(runningDir, 'no-wait');
    fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return {
        runningDir,
        markerDirectory,
        markerPath: path.join(markerDirectory, `${CONTAINER}.current.json`),
    };
}

function writeMarker(markerPath, identity = markerIdentity()) {
    fs.writeFileSync(markerPath, JSON.stringify(identity), { mode: 0o600 });
}

function retireOptions(runningDir, overrides = {}) {
    return {
        runningDir,
        randomUUID: () => RETIREMENT_ID,
        ...overrides,
    };
}

test('missing marker retirement is idempotent and creates no state', (t) => {
    const env = fixture(t);
    assert.deepEqual(
        retireNoWaitRunMarker(CONTAINER, retireOptions(env.runningDir)),
        { retired: false, containerName: CONTAINER, markerPath: env.markerPath },
    );
    assert.deepEqual(fs.readdirSync(env.markerDirectory), []);
    assert.deepEqual(
        retireNoWaitRunMarker(CONTAINER, retireOptions(env.runningDir, {
            expectedRecord: { ...expectedRecord(), enableGeneration: INSTANCE_ID },
        })),
        { retired: false, containerName: CONTAINER, markerPath: env.markerPath },
        'absence remains idempotent even for a legacy caller record that cannot own a new marker',
    );
});

test('an exact prior-generation marker is atomically retired and removed', (t) => {
    const env = fixture(t);
    const identity = markerIdentity();
    writeMarker(env.markerPath, identity);
    assert.deepEqual(
        retireNoWaitRunMarker(CONTAINER, retireOptions(env.runningDir, {
            expectedRecord: expectedRecord(identity),
        })),
        { retired: true, containerName: CONTAINER, markerPath: env.markerPath },
    );
    assert.equal(fs.existsSync(env.markerPath), false);
    assert.deepEqual(fs.readdirSync(env.markerDirectory), []);
    assert.deepEqual(
        retireNoWaitRunMarker(CONTAINER, retireOptions(env.runningDir, {
            expectedRecord: expectedRecord(identity),
        })),
        { retired: false, containerName: CONTAINER, markerPath: env.markerPath },
    );
});

test('generation, repository, agent, alias, and route disagreement all fail closed', (t) => {
    const mutations = [
        { instanceId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' },
        { enableGeneration: 'eeeeeeee-dddd-4ccc-8bbb-aaaaaaaaaaaa' },
        { repoName: 'other' },
        { agentName: 'other' },
        { alias: 'blue' },
    ];
    for (const mutation of mutations) {
        const env = fixture(t);
        writeMarker(env.markerPath);
        assert.throws(
            () => retireNoWaitRunMarker(CONTAINER, retireOptions(env.runningDir, {
                expectedRecord: { ...expectedRecord(), ...mutation },
            })),
            (error) => error.code === 'NO_WAIT_MARKER_RETIREMENT_FAILED',
        );
        assert.equal(fs.existsSync(env.markerPath), true, JSON.stringify(mutation));
    }
});

test('malformed, non-regular, writable, and ambiguously owned markers fail closed', (t) => {
    for (const variant of ['malformed', 'directory', 'symlink', 'writable', 'foreign-owner']) {
        const env = fixture(t);
        if (variant === 'malformed') fs.writeFileSync(env.markerPath, '{', { mode: 0o600 });
        if (variant === 'directory') fs.mkdirSync(env.markerPath);
        if (variant === 'symlink') {
            const target = path.join(env.markerDirectory, 'foreign.json');
            writeMarker(target);
            fs.symlinkSync(target, env.markerPath);
        }
        if (variant === 'writable') {
            writeMarker(env.markerPath);
            fs.chmodSync(env.markerPath, 0o622);
        }
        if (variant === 'foreign-owner') writeMarker(env.markerPath);
        assert.throws(
            () => retireNoWaitRunMarker(CONTAINER, retireOptions(env.runningDir, {
                expectedRecord: expectedRecord(),
                ...(variant === 'foreign-owner' && typeof process.getuid === 'function'
                    ? { uid: process.getuid() + 1 }
                    : {}),
            })),
            (error) => error.code === 'NO_WAIT_MARKER_RETIREMENT_FAILED',
            variant,
        );
        assert.equal(fs.existsSync(env.markerPath), true, variant);
    }
});

test('rename failure aborts retirement without hiding the current marker', (t) => {
    const env = fixture(t);
    writeMarker(env.markerPath);
    const fsApi = {
        ...fs,
        renameSync() {
            const error = new Error('simulated rename denial');
            error.code = 'EACCES';
            throw error;
        },
    };
    assert.throws(
        () => retireNoWaitRunMarker(CONTAINER, retireOptions(env.runningDir, {
            expectedRecord: expectedRecord(),
            fsApi,
        })),
        (error) => error.code === 'NO_WAIT_MARKER_RETIREMENT_FAILED'
            && /atomically/.test(error.message),
    );
    assert.equal(fs.existsSync(env.markerPath), true);
});

test('batch retirement accepts exact records, sorts, deduplicates, and rejects conflicts', (t) => {
    const env = fixture(t);
    writeMarker(env.markerPath);
    const record = expectedRecord();
    const result = retireNoWaitRunMarkers([
        { containerName: CONTAINER, record: { ...record } },
        { containerName: CONTAINER, expectedRecord: record },
    ], retireOptions(env.runningDir));
    assert.equal(result.length, 1);
    assert.equal(result[0].retired, true);

    assert.throws(
        () => retireNoWaitRunMarkers(CONTAINER, retireOptions(env.runningDir)),
        (error) => error.code === 'NO_WAIT_MARKER_RETIREMENT_FAILED',
        'a raw string must not be misread as an iterable of one-character container names',
    );

    for (const invalid of ['', '../escape', { record }, { containerName: ' nested ' }]) {
        assert.throws(
            () => retireNoWaitRunMarkers([invalid], retireOptions(env.runningDir)),
            (error) => error.code === 'NO_WAIT_MARKER_RETIREMENT_FAILED'
                && /exact container name/.test(error.message),
            JSON.stringify(invalid),
        );
    }

    assert.throws(
        () => retireNoWaitRunMarkers([
            { containerName: CONTAINER, record },
            { containerName: CONTAINER, record: { ...record, enableGeneration: 'different' } },
        ], retireOptions(env.runningDir)),
        (error) => error.code === 'NO_WAIT_MARKER_RETIREMENT_FAILED'
            && /conflicting records/.test(error.message),
    );
});
