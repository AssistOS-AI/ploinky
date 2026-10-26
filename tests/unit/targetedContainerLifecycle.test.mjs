import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TARGETED_DRAIN_ACKNOWLEDGEMENT,
    TARGETED_DRAIN_TIMEOUT_MS,
    drainAndRemoveTargetedContainer,
    drainTargetedContainer,
} from '../../cli/sandbox/docker/targetedContainerLifecycle.js';

const PREDECESSOR_ID = 'a'.repeat(64);

function fixture({ runningChecks = [true, false], exitCode = 0, oomKilled = false, inspectedId = PREDECESSOR_ID } = {}) {
    const events = [];
    let index = 0;
    let exists = true;
    let time = 0;
    return {
        events,
        options: {
            runtime: 'podman',
            timeoutMs: 10,
            pollMs: 1,
            acknowledgement: TARGETED_DRAIN_ACKNOWLEDGEMENT,
            affectedSelectors: ['service:route/editor'],
            exists: () => exists,
            isRunning: () => runningChecks[Math.min(index++, runningChecks.length - 1)],
            assertSelectorsInactive: ({ affectedSelectors }) => {
                events.push(['selector-check', ...affectedSelectors]);
                return true;
            },
            retireControlSocket: (name) => { events.push(['retire-relay', name]); },
            signal: (_runtime, name) => { events.push(['signal', name]); return { status: 0 }; },
            inspect: () => ({ Id: inspectedId, State: { Running: false, ExitCode: exitCode, OOMKilled: oomKilled, Error: '' } }),
            now: () => time,
            sleep: (ms) => { time += ms; events.push(['wait', ms]); },
            remove: (_runtime, name) => { events.push(['remove', name]); exists = false; return { status: 0 }; },
        },
    };
}

test('targeted drain proves exact selectors inactive before SIGTERM and removes only after acknowledged clean exit', () => {
    const state = fixture();
    const result = drainAndRemoveTargetedContainer('ploinky_agent', state.options);
    assert.deepEqual(result, {
        state: 'drained',
        containerName: 'ploinky_agent',
        exitCode: 0,
        affectedSelectors: ['service:route/editor'],
        removed: true,
    });
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'retire-relay', 'signal', 'remove']);
});

test('failed application drain remains running and blocks force removal, recreate, and activation', () => {
    const state = fixture({ runningChecks: [true, true, true, true] });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
        (error) => error?.code === 'TARGETED_DRAIN_TIMEOUT'
            && /refusing SIGKILL, removal, recreate, or selector activation/.test(error.message),
    );
    const eventNames = state.events.map(([event]) => event);
    assert.deepEqual(eventNames.slice(0, 3), ['selector-check', 'retire-relay', 'signal']);
    assert.ok(eventNames.slice(3).every((event) => event === 'wait'));
    assert.ok(!eventNames.includes('remove'));
});

test('signal-style exit 143 is not an application acknowledgement and blocks removal', () => {
    const state = fixture({ exitCode: 143 });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
        (error) => error?.code === 'TARGETED_DRAIN_FAILED',
    );
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'retire-relay', 'signal']);
});

test('an already-stopped predecessor still requires an exit-zero acknowledgement', () => {
    const state = fixture({ runningChecks: [false], exitCode: 1 });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
        (error) => error?.code === 'TARGETED_DRAIN_FAILED',
    );
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check']);
});

test('active or unproved affected selectors block signaling even when the container is absent', () => {
    const state = fixture();
    state.options.exists = () => false;
    state.options.assertSelectorsInactive = () => false;
    assert.throws(
        () => drainTargetedContainer('ploinky_agent', state.options),
        (error) => error?.code === 'TARGETED_SELECTOR_ACTIVE',
    );
    assert.deepEqual(state.events, []);
});

test('ordinary callers cannot opt into targeted drain without the explicit application acknowledgement', () => {
    const state = fixture();
    assert.throws(
        () => drainTargetedContainer('ploinky_agent', {
            ...state.options,
            acknowledgement: undefined,
        }),
        (error) => error?.code === 'TARGETED_DRAIN_INVALID',
    );
    assert.deepEqual(state.events, []);
});

test('targeted drain bound is fixed and rejects attempts to extend it', () => {
    const state = fixture({ runningChecks: [false] });
    assert.throws(
        () => drainTargetedContainer('ploinky_agent', {
            ...state.options,
            timeoutMs: TARGETED_DRAIN_TIMEOUT_MS + 1,
        }),
        (error) => error?.code === 'TARGETED_DRAIN_INVALID',
    );
    assert.deepEqual(state.events, []);
});

test('an absent predecessor has nothing left to drain or acknowledge once its selectors are proved inactive', () => {
    const state = fixture();
    state.options.exists = () => false;
    assert.deepEqual(drainAndRemoveTargetedContainer('ploinky_agent', state.options), {
        state: 'absent',
        containerName: 'ploinky_agent',
        affectedSelectors: ['service:route/editor'],
        removed: false,
    });
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check']);
});

test('an operator-accepted failed drain replaces only the exact already-stopped predecessor without signaling it', () => {
    for (const refusal of [{ exitCode: 143 }, { exitCode: 137, oomKilled: true }]) {
        const state = fixture({ runningChecks: [false], ...refusal });
        const result = drainAndRemoveTargetedContainer('ploinky_agent', {
            ...state.options,
            acceptedFailedDrain: { containerId: PREDECESSOR_ID },
        });
        assert.deepEqual(result, {
            state: 'accepted-failed-drain',
            containerName: 'ploinky_agent',
            containerId: PREDECESSOR_ID,
            exitCode: refusal.exitCode,
            oomKilled: refusal.oomKilled === true,
            affectedSelectors: ['service:route/editor'],
            removed: true,
        });
        assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'remove']);
    }
});

test('an accepted failed drain never signals, kills, or removes a running predecessor', () => {
    const state = fixture({ runningChecks: [true, true] });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', {
            ...state.options,
            acceptedFailedDrain: { containerId: PREDECESSOR_ID },
        }),
        (error) => error?.code === 'TARGETED_DRAIN_ACCEPTANCE_REFUSED'
            && /applies only to an already-stopped predecessor/.test(error.message),
    );
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check']);
});

test('an accepted failed drain names one exact container and refuses any other stopped runtime', () => {
    const state = fixture({ runningChecks: [false], exitCode: 143, inspectedId: 'b'.repeat(64) });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', {
            ...state.options,
            acceptedFailedDrain: { containerId: PREDECESSOR_ID },
        }),
        (error) => error?.code === 'TARGETED_DRAIN_ACCEPTANCE_REFUSED'
            && error.message.includes(`not the accepted predecessor ${PREDECESSOR_ID}`),
    );
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check']);
});

test('an accepted failed drain must name the full immutable predecessor container ID', () => {
    for (const acceptedFailedDrain of [{ containerId: PREDECESSOR_ID.slice(0, 12) }, { containerId: PREDECESSOR_ID.toUpperCase() }, {}, PREDECESSOR_ID]) {
        const state = fixture({ runningChecks: [false], exitCode: 143 });
        assert.throws(
            () => drainTargetedContainer('ploinky_agent', { ...state.options, acceptedFailedDrain }),
            (error) => error?.code === 'TARGETED_DRAIN_INVALID',
        );
        assert.deepEqual(state.events, []);
    }
});

test('an accepted failed drain still requires the exact affected selectors to be inactive', () => {
    const state = fixture({ runningChecks: [false], exitCode: 143 });
    state.options.assertSelectorsInactive = () => false;
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', {
            ...state.options,
            acceptedFailedDrain: { containerId: PREDECESSOR_ID },
        }),
        (error) => error?.code === 'TARGETED_SELECTOR_ACTIVE',
    );
    assert.deepEqual(state.events, []);
});
