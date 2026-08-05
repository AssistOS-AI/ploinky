import assert from 'node:assert/strict';
import test from 'node:test';

import { runPostinstallHook } from '../../cli/sandbox/docker/agentHooks.js';
import { executeContainerHook } from '../../cli/utils/runtime/lifecycleHooks.js';

const CONTAINER_ID = '2'.repeat(64);
const EXACT_OPTIONS = Object.freeze({
    runtime: 'podman',
    containerId: CONTAINER_ID,
    runtimeIdentity: Object.freeze({
        instanceId: 'instance-exact',
        enableGeneration: 'generation-exact',
    }),
});

test('profile container hook inspects the exact record and execs by immutable Podman ID', () => {
    const calls = [];
    const result = executeContainerHook('ploinky_agent', 'npm ci', { MODE: 'test' }, {
        ...EXACT_OPTIONS,
        inspectRuntimeIdentity(identity) { calls.push(['inspect', identity.containerId]); },
        spawnSyncImpl(runtime, args) {
            calls.push(['spawn', runtime, ...args]);
            return { status: 0, stdout: 'installed\n', stderr: '' };
        },
    });
    assert.equal(result.success, true);
    assert.deepEqual(calls, [
        ['inspect', CONTAINER_ID],
        ['spawn', 'podman', 'exec', '-e', 'MODE=test', '-w', '/code', CONTAINER_ID, 'sh', '-c', 'npm ci'],
    ]);
});

test('profile container hook fails closed before inspection or spawn for a generic runtime', () => {
    let touched = false;
    const result = executeContainerHook('ploinky_agent', 'npm ci', {}, {
        ...EXACT_OPTIONS,
        runtime: 'container',
        inspectRuntimeIdentity() { touched = true; },
        spawnSyncImpl() { touched = true; },
    });
    assert.equal(result.success, false);
    assert.match(result.message, /runtime exactly 'podman'/);
    assert.equal(touched, false);
});

test('postinstall waits, checks, and execs only the inspected immutable Podman ID', () => {
    const calls = [];
    runPostinstallHook('demo', 'ploinky_agent', {
        profiles: { default: { postinstall: ['npm ci'] } },
    }, '/code', {
        ...EXACT_OPTIONS,
        inspectRuntimeIdentity(identity) { calls.push(['inspect', identity.containerId]); },
        waitForContainerRunningImpl(id, attempts, delay, options) {
            calls.push(['wait', id, attempts, delay, options.runtime]);
            return true;
        },
        isContainerRunningImpl(id, options) {
            calls.push(['running', id, options.runtime]);
            return true;
        },
        spawnSyncImpl(runtime, args) {
            calls.push(['spawn', runtime, ...args]);
            return { status: 0 };
        },
    });
    assert.deepEqual(calls, [
        ['inspect', CONTAINER_ID],
        ['wait', CONTAINER_ID, 40, 250, 'podman'],
        ['running', CONTAINER_ID, 'podman'],
        ['spawn', 'podman', 'exec', CONTAINER_ID, 'sh', '-lc', "cd '/code' && npm ci"],
        ['running', CONTAINER_ID, 'podman'],
    ]);
});

test('postinstall rejects a generic runtime before Podman state is touched', () => {
    let touched = false;
    assert.throws(() => runPostinstallHook('demo', 'ploinky_agent', {
        profiles: { default: { postinstall: 'npm ci' } },
    }, '/code', {
        ...EXACT_OPTIONS,
        runtime: 'container',
        inspectRuntimeIdentity() { touched = true; },
        waitForContainerRunningImpl() { touched = true; },
        spawnSyncImpl() { touched = true; },
    }), { code: 'PLOINKY_PODMAN_RUNTIME_IDENTITY_INVALID' });
    assert.equal(touched, false);
});
