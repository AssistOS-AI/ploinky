import test from 'node:test';
import assert from 'node:assert/strict';

import {
    setAgentTaskObserver,
    __testables,
} from '../../Agent/client/AgentMcpClient.mjs';

test('a task observer can attach background metadata to a non-blocking call', async () => {
    const observations = [];
    const remove = setAgentTaskObserver(async (task) => {
        observations.push(task);
        return { detached: true, id: 'task_local', description: 'Build project' };
    });
    try {
        const result = await __testables.applyTaskObserver({
            result: { metadata: { taskId: 'remote-1', status: 'pending' } },
            agentName: 'targetAgent',
            taskId: 'remote-1',
            toolName: 'execute-task',
            toolArgs: { prompt: 'Build project' },
            metadata: { taskId: 'remote-1', status: 'pending' },
        });
        assert.equal(observations.length, 1);
        assert.equal(observations[0].taskId, 'remote-1');
        assert.equal(result.metadata.backgroundTask.detached, true);
        assert.equal(result.metadata.backgroundTask.id, 'task_local');
    } finally {
        remove();
    }
});
