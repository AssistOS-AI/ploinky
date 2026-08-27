import assert from 'node:assert/strict';
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
    });
    assert.equal(result, LIVE);
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
