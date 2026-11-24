import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TARGETED_DRAIN_ACKNOWLEDGEMENT,
    TARGETED_DRAIN_TIMEOUT_MS,
    drainAndRemoveTargetedContainer,
    drainTargetedContainer,
} from '../../cli/sandbox/docker/targetedContainerLifecycle.js';

const PREDECESSOR_ID = 'a'.repeat(64);

// Inspect records follow real `podman inspect` output. A nested Box agent runs
// with HostConfig.Cgroups "disabled" (the Box podman's containers.conf), so its
// State.OOMKilled reflects the Box's shared memory.events counter. A container
// with its own cgroup reports "default", "enabled" (hardware-placed agents) or
// "split"; docker and older records have no HostConfig.Cgroups at all.
function inspectRecord({ inspectedId, exitCode, oomKilled, stateError = '', cgroups }) {
    return {
        Id: inspectedId,
        State: { Running: false, ExitCode: exitCode, OOMKilled: oomKilled, Error: stateError },
        ...(cgroups === undefined ? {} : { HostConfig: { Cgroups: cgroups } }),
    };
}

function fixture({ runningChecks = [true, false], exitCode = 0, oomKilled = false, inspectedId = PREDECESSOR_ID, stateError = '', cgroups } = {}) {
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
            inspect: () => inspectRecord({ inspectedId, exitCode, oomKilled, stateError, cgroups }),
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

// Bizanso 2026-11-24: one OOM kill anywhere in the Box made podman mark every
// later exit of every nested agent as OOM-killed, and ten clean exit-0 drains
// were refused at once.
test('a shared Box cgroup OOM flag does not refuse an exit-zero drain', () => {
    const state = fixture({ exitCode: 0, oomKilled: true, cgroups: 'disabled' });
    assert.deepEqual(drainAndRemoveTargetedContainer('ploinky_agent', state.options), {
        state: 'drained',
        containerName: 'ploinky_agent',
        exitCode: 0,
        sharedCgroupOomFlag: true,
        affectedSelectors: ['service:route/editor'],
        removed: true,
    });
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'retire-relay', 'signal', 'remove']);
});

test('a shared Box cgroup OOM flag does not refuse an already-stopped exit-zero predecessor', () => {
    const state = fixture({ runningChecks: [false], exitCode: 0, oomKilled: true, cgroups: 'disabled' });
    assert.deepEqual(drainAndRemoveTargetedContainer('ploinky_agent', state.options), {
        state: 'already-stopped',
        containerName: 'ploinky_agent',
        exitCode: 0,
        sharedCgroupOomFlag: true,
        affectedSelectors: ['service:route/editor'],
        removed: true,
    });
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'remove']);
});

test('an accepted drain of an exit-zero predecessor with a shared Box cgroup OOM flag is an ordinary replacement', () => {
    const state = fixture({ runningChecks: [false], exitCode: 0, oomKilled: true, cgroups: 'disabled' });
    assert.deepEqual(drainAndRemoveTargetedContainer('ploinky_agent', {
        ...state.options,
        acceptedFailedDrain: { containerId: PREDECESSOR_ID },
    }), {
        state: 'already-stopped',
        containerName: 'ploinky_agent',
        exitCode: 0,
        sharedCgroupOomFlag: true,
        affectedSelectors: ['service:route/editor'],
        removed: true,
    });
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'remove']);
});

test('an OOM kill in the container\'s own cgroup still refuses an exit-zero drain', () => {
    for (const cgroups of ['default', 'enabled', 'split', 'no-conmon', 'Disabled', '', undefined]) {
        for (const runningChecks of [[true, false], [false]]) {
            const state = fixture({ runningChecks, exitCode: 0, oomKilled: true, cgroups });
            assert.throws(
                () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
                (error) => error?.code === 'TARGETED_DRAIN_FAILED'
                    && error.oomKilled === true
                    && error.sharedCgroupOomFlag === undefined
                    && /\(exit=0, oom-killed\); refusing removal or recreate/.test(error.message),
                `cgroups=${cgroups} running=${runningChecks[0]}`,
            );
            assert.ok(!state.events.some(([event]) => event === 'remove'), `cgroups=${cgroups}`);
        }
    }
});

test('a shared Box cgroup OOM flag never excuses a signal death, an application failure or a runtime error', () => {
    const refusals = [{ exitCode: 137 }, { exitCode: 143 }, { exitCode: 1 }, { exitCode: 0, stateError: 'conmon exited unexpectedly' }];
    for (const refusal of refusals) {
        for (const runningChecks of [[true, false], [false]]) {
            const state = fixture({ runningChecks, oomKilled: true, cgroups: 'disabled', ...refusal });
            assert.throws(
                () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
                (error) => error?.code === 'TARGETED_DRAIN_FAILED'
                    && error.exitCode === refusal.exitCode
                    && error.oomKilled === false
                    && error.sharedCgroupOomFlag === true
                    && error.message.includes('OOM flag from the shared Box cgroup'),
                JSON.stringify(refusal),
            );
            assert.ok(!state.events.some(([event]) => event === 'remove'), JSON.stringify(refusal));
        }
    }
});

test('a shared Box cgroup without an OOM flag adds nothing to the drain result', () => {
    const state = fixture({ exitCode: 0, oomKilled: false, cgroups: 'disabled' });
    assert.deepEqual(drainAndRemoveTargetedContainer('ploinky_agent', state.options), {
        state: 'drained',
        containerName: 'ploinky_agent',
        exitCode: 0,
        affectedSelectors: ['service:route/editor'],
        removed: true,
    });
});

test('an accepted failed drain still reports an own-cgroup OOM kill and a shared Box cgroup flag separately', () => {
    const cases = [
        [{ exitCode: 0, oomKilled: true, cgroups: 'enabled' }, { oomKilled: true }],
        [{ exitCode: 143, oomKilled: true, cgroups: 'disabled' }, { oomKilled: false, sharedCgroupOomFlag: true }],
    ];
    for (const [refusal, reported] of cases) {
        const state = fixture({ runningChecks: [false], ...refusal });
        assert.deepEqual(drainAndRemoveTargetedContainer('ploinky_agent', {
            ...state.options,
            acceptedFailedDrain: { containerId: PREDECESSOR_ID },
        }), {
            state: 'accepted-failed-drain',
            containerName: 'ploinky_agent',
            containerId: PREDECESSOR_ID,
            exitCode: refusal.exitCode,
            ...reported,
            affectedSelectors: ['service:route/editor'],
            removed: true,
        }, JSON.stringify(refusal));
    }
});
