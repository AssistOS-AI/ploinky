import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TARGETED_DRAIN_ACKNOWLEDGEMENT,
    TARGETED_DRAIN_TIMEOUT_MS,
    drainAndRemoveTargetedContainer,
    drainTargetedContainer,
} from '../../cli/sandbox/docker/targetedContainerLifecycle.js';

function fixture({ runningChecks = [true, false], exitCode = 0 } = {}) {
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
            inspect: () => ({ State: { ExitCode: exitCode, OOMKilled: false, Error: '' } }),
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
