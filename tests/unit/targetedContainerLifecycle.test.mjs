import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TARGETED_DRAIN_ACKNOWLEDGEMENT,
    TARGETED_DRAIN_TIMEOUT_MS,
    drainAndRemoveTargetedContainer,
    drainTargetedContainer,
} from '../../cli/sandbox/docker/targetedContainerLifecycle.js';

const CONTAINER_ID = 'f'.repeat(64);

function fixture({ runningChecks = [true, false], exitCode = 0 } = {}) {
    const events = [];
    let index = 0;
    let exists = true;
    let time = 0;
    return {
        events,
        options: {
            runtime: 'podman',
            containerId: CONTAINER_ID,
            runtimeIdentity: Object.freeze({
                instanceId: 'instance-exact',
                enableGeneration: 'generation-exact',
                releaseGeneration: '7'.repeat(64),
            }),
            timeoutMs: 10,
            pollMs: 1,
            acknowledgement: TARGETED_DRAIN_ACKNOWLEDGEMENT,
            affectedSelectors: ['service:route/editor'],
            exists: (id, options) => {
                assert.equal(id, CONTAINER_ID);
                assert.deepEqual(options, { runtime: 'podman' });
                return exists;
            },
            isRunning: (id, options) => {
                assert.equal(id, CONTAINER_ID);
                assert.deepEqual(options, { runtime: 'podman' });
                return runningChecks[Math.min(index++, runningChecks.length - 1)];
            },
            inspectRuntimeIdentity: (identity) => {
                assert.equal(identity.containerId, CONTAINER_ID);
                assert.equal(identity.releaseGeneration, '7'.repeat(64));
                events.push(['identity', identity.containerId]);
                return identity;
            },
            assertSelectorsInactive: ({ affectedSelectors }) => {
                events.push(['selector-check', ...affectedSelectors]);
                return true;
            },
            signal: (_runtime, id) => { events.push(['signal', id]); return { status: 0 }; },
            inspect: () => ({ State: { ExitCode: exitCode, OOMKilled: false, Error: '' } }),
            now: () => time,
            sleep: (ms) => { time += ms; events.push(['wait', ms]); },
            remove: (_runtime, id) => { events.push(['remove', id]); exists = false; return { status: 0 }; },
        },
    };
}

test('targeted drain proves exact selectors inactive before SIGTERM and removes only after acknowledged clean exit', () => {
    const state = fixture();
    const result = drainAndRemoveTargetedContainer('ploinky_agent', state.options);
    assert.deepEqual(result, {
        state: 'drained',
        containerName: 'ploinky_agent',
        releaseGeneration: '7'.repeat(64),
        exitCode: 0,
        affectedSelectors: ['service:route/editor'],
        removed: true,
    });
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'identity', 'signal', 'remove']);
});

test('failed application drain remains running and blocks force removal, recreate, and activation', () => {
    const state = fixture({ runningChecks: [true, true, true, true] });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
        (error) => error?.code === 'TARGETED_DRAIN_TIMEOUT'
            && /refusing SIGKILL, removal, recreate, or selector activation/.test(error.message),
    );
    const eventNames = state.events.map(([event]) => event);
    assert.deepEqual(eventNames.slice(0, 3), ['selector-check', 'identity', 'signal']);
    assert.ok(eventNames.slice(3).every((event) => event === 'wait'));
    assert.ok(!eventNames.includes('remove'));
});

test('signal-style exit 143 is not an application acknowledgement and blocks removal', () => {
    const state = fixture({ exitCode: 143 });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
        (error) => error?.code === 'TARGETED_DRAIN_FAILED',
    );
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'identity', 'signal']);
});

test('an already-stopped predecessor still requires an exit-zero acknowledgement', () => {
    const state = fixture({ runningChecks: [false], exitCode: 1 });
    assert.throws(
        () => drainAndRemoveTargetedContainer('ploinky_agent', state.options),
        (error) => error?.code === 'TARGETED_DRAIN_FAILED',
    );
    assert.deepEqual(state.events.map(([event]) => event), ['selector-check', 'identity']);
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

test('targeted drain rejects generic runtime and incomplete immutable identity before selector or Podman access', () => {
    const state = fixture();
    for (const invalid of [
        { runtime: 'container' },
        { containerId: 'ploinky_agent' },
        { runtimeIdentity: { instanceId: '', enableGeneration: 'generation-exact' } },
        { runtimeIdentity: { instanceId: 'instance-exact', enableGeneration: ' padded ' } },
        { runtimeIdentity: { instanceId: 'instance-exact', enableGeneration: 'generation-exact', releaseGeneration: 'main' } },
    ]) {
        state.events.length = 0;
        assert.throws(
            () => drainTargetedContainer('ploinky_agent', { ...state.options, ...invalid }),
            { code: 'PLOINKY_PODMAN_RUNTIME_IDENTITY_INVALID' },
        );
        assert.deepEqual(state.events, []);
    }
});
