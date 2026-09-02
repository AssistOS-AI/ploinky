import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentSidecarExecArgs } from '../../cli/sandbox/docker/agentCommands.js';

test('start+agent sidecars preserve compound manifest commands through a shell', () => {
    const command = 'node /code/runtime/wait-for-nginx.mjs && sh /Agent/server/AgentServer.sh';

    assert.deepEqual(buildAgentSidecarExecArgs('publishing', command), [
        'exec',
        '-d',
        'publishing',
        'sh',
        '-c',
        command
    ]);
});

test('sidecar exec arguments reject empty container names or commands', () => {
    assert.deepEqual(buildAgentSidecarExecArgs('', 'node server.mjs'), []);
    assert.deepEqual(buildAgentSidecarExecArgs('publishing', '  '), []);
});
