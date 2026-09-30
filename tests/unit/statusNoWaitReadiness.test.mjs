import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    applyCurrentNoWaitReadiness,
    applyRuntimeReadinessProjection,
} from '../../cli/utils/noWaitReadiness.js';

const CONTAINER = 'ploinky_Agents_onlyOffice_workspace_12345678';
const RECORD = Object.freeze({
    type: 'agent',
    instanceId: 'instance-1',
    enableGeneration: 'generation-1',
});
const REGISTRY = Object.freeze({ [CONTAINER]: RECORD });
const LIVE = Object.freeze({
    containerName: CONTAINER,
    state: Object.freeze({ status: 'running', running: true, pid: 42 }),
});

function optionsFor(state) {
    return {
        runningDir: '/workspace/.ploinky/running',
        readMarker: () => ({
            runId: '11111111-2222-4333-8444-555555555555',
            runStartedAtMs: 100,
            waveIndex: 0,
            statusFile: `${CONTAINER}.11111111-2222-4333-8444-555555555555.json`,
        }),
        createBinding: (containerName, record, marker) => ({ containerName, record, marker }),
        observeRun: () => ({ state }),
    };
}

test('status keeps ordinary foreground runtime state when no no-wait marker exists', () => {
    const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, {
        readMarker: () => null,
        readStatus: () => null,
    });
    assert.equal(result, LIVE);
});

test('status fails closed when a no-wait status names the current runtime but no current marker binds it', () => {
    for (const state of ['running', 'starting']) {
        const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, {
            readMarker: () => null,
            readStatus: (containerName) => {
                assert.equal(containerName, CONTAINER);
                return { containerName: CONTAINER, instanceId: 'instance-1', enableGeneration: 'generation-1', state };
            },
        });
        assert.equal(result.state.status, 'unknown');
        assert.equal(result.state.running, true, 'the process remains live');
        assert.equal(result.state.ready, false);
        assert.equal(result.state.noWaitState, 'unreadable');
    }
});

// A start retires a marker and rotates the tuple, an enable mints a new
// generation, and a staged replacement moves the runtime to a new name that a
// later candidate can cycle back to. Each leaves a no-wait status that names a
// tuple which no longer runs: it says nothing about the current runtime.
test('status keeps the runtime state when the only no-wait status names another runtime tuple', () => {
    const stale = [
        ['no-wait agent restarted as blocking (rotated tuple)', { instanceId: 'instance-0', enableGeneration: 'generation-0' }],
        ['disabled then re-enabled (new generation)', { instanceId: 'instance-1', enableGeneration: 'generation-0' }],
        ['staged name cycled back to a new tuple', { instanceId: 'instance-0', enableGeneration: 'generation-1' }],
        ['status of another container', { containerName: 'other_runtime', instanceId: 'instance-1', enableGeneration: 'generation-1' }],
    ];
    for (const [label, fields] of stale) {
        const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, {
            readMarker: () => null,
            readStatus: () => ({ containerName: CONTAINER, state: 'running', ...fields }),
        });
        assert.equal(result, LIVE, label);
    }
});

test('status reads the real canonical no-wait status when no marker binds the runtime', () => {
    const runningDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'status-no-wait-')));
    try {
        const directory = path.join(runningDir, 'no-wait');
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.chmodSync(directory, 0o700);
        const write = (status) => fs.writeFileSync(path.join(directory, `${CONTAINER}.json`),
            JSON.stringify({ containerName: CONTAINER, state: 'running', ...status }), { mode: 0o600 });

        assert.equal(applyCurrentNoWaitReadiness(LIVE, REGISTRY, { runningDir }), LIVE, 'no status');
        write({ instanceId: 'instance-0', enableGeneration: 'generation-0' });
        assert.equal(applyCurrentNoWaitReadiness(LIVE, REGISTRY, { runningDir }), LIVE, 'stale status');
        write({ instanceId: 'instance-1', enableGeneration: 'generation-1' });
        const unbound = applyCurrentNoWaitReadiness(LIVE, REGISTRY, { runningDir });
        assert.equal(unbound.state.ready, false, 'current-tuple status without a marker');
        assert.equal(unbound.state.noWaitState, 'unreadable');
    } finally {
        fs.rmSync(runningDir, { recursive: true, force: true });
    }
});

test('status fails closed when the no-wait status of an unbound agent cannot be read', () => {
    const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, {
        readMarker: () => null,
        readStatus: () => { throw new Error('malformed status'); },
    });
    assert.equal(result.state.ready, false);
    assert.equal(result.state.noWaitState, 'unreadable');
});

test('runtime readiness projection applies one registry snapshot to every runtime', () => {
    const seen = [];
    const entries = [{ containerName: 'one' }, { containerName: 'two' }];
    const result = applyRuntimeReadinessProjection(entries, REGISTRY, {
        applyReadiness: (entry, registry) => {
            seen.push(registry);
            return { ...entry, projected: true };
        },
    });
    assert.deepEqual(result, [
        { containerName: 'one', projected: true },
        { containerName: 'two', projected: true },
    ]);
    assert.deepEqual(seen, [REGISTRY, REGISTRY]);
});

test('status does not expose a live no-wait container as ready before semantic readiness', () => {
    for (const noWaitState of ['pending', 'starting']) {
        const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, optionsFor(noWaitState));
        assert.equal(result.state.status, 'starting');
        assert.equal(result.state.running, true, 'the process remains live even though it is not ready');
        assert.equal(result.state.ready, false);
        assert.equal(result.state.noWaitState, noWaitState);
    }
});

test('status exposes a no-wait runtime as running only after terminal readiness publication', () => {
    const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, optionsFor('running'));
    assert.equal(result.state.status, 'running');
    assert.equal(result.state.running, true);
    assert.equal(result.state.ready, true);
    assert.equal(result.state.noWaitState, 'running');
});

test('status surfaces terminal no-wait failure without hiding the live process evidence', () => {
    const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, optionsFor('failed'));
    assert.equal(result.state.status, 'failed');
    assert.equal(result.state.running, true);
    assert.equal(result.state.ready, false);
    assert.equal(result.state.noWaitState, 'failed');
});

test('status fails closed when current no-wait state cannot be proved', () => {
    for (const failurePoint of ['marker', 'observation']) {
        const result = applyCurrentNoWaitReadiness(LIVE, REGISTRY, {
            ...optionsFor('starting'),
            ...(failurePoint === 'marker'
                ? { readMarker: () => { throw new Error('malformed marker'); } }
                : { observeRun: () => { throw new Error('stale run'); } }),
        });
        assert.equal(result.state.status, 'unknown');
        assert.equal(result.state.running, true);
        assert.equal(result.state.ready, false);
        assert.equal(result.state.noWaitState, 'unreadable');
    }
});
