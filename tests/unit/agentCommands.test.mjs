import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildAgentSidecarExecArgs,
    launchAgentSidecar,
} from '../../cli/sandbox/docker/agentCommands.js';

const CONTAINER_ID = '1'.repeat(64);

test('start+agent sidecars preserve compound manifest commands through a shell', () => {
    const command = 'node /code/runtime/wait-for-nginx.mjs && sh /Agent/server/AgentServer.sh';

    assert.deepEqual(buildAgentSidecarExecArgs(CONTAINER_ID, command), [
        'exec',
        '-d',
        CONTAINER_ID,
        'sh',
        '-lc',
        command
    ]);
});

test('sidecar exec arguments reject empty container names or commands', () => {
    assert.deepEqual(buildAgentSidecarExecArgs('', 'node server.mjs'), []);
    assert.deepEqual(buildAgentSidecarExecArgs(CONTAINER_ID, '  '), []);
});

test('sidecar launch uses only exact inspected Podman identity and immutable container ID', () => {
    const calls = [];
    launchAgentSidecar({
        containerName: 'publishing',
        containerId: CONTAINER_ID,
        runtime: 'podman',
        runtimeIdentity: { instanceId: 'instance-exact', enableGeneration: 'generation-exact' },
        agentCommand: 'node server.mjs',
        agentName: 'publisher',
        inspectRuntimeIdentity(identity) { calls.push(['inspect', identity.containerId]); },
        waitForContainerRunningImpl(id, attempts, delay, options) {
            calls.push(['wait', id, attempts, delay, options.runtime]);
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
        ['spawn', 'podman', 'exec', '-d', CONTAINER_ID, 'sh', '-lc', 'node server.mjs'],
    ]);
});

test('sidecar launch rejects generic runtime before inspection, wait, or spawn', () => {
    let touched = false;
    assert.throws(() => launchAgentSidecar({
        containerName: 'publishing',
        containerId: CONTAINER_ID,
        runtime: 'container',
        runtimeIdentity: { instanceId: 'instance-exact', enableGeneration: 'generation-exact' },
        agentCommand: 'node server.mjs',
        inspectRuntimeIdentity() { touched = true; },
        waitForContainerRunningImpl() { touched = true; },
        spawnSyncImpl() { touched = true; },
    }), { code: 'PLOINKY_PODMAN_RUNTIME_IDENTITY_INVALID' });
    assert.equal(touched, false);
});
