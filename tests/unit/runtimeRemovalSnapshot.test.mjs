import test from 'node:test';
import assert from 'node:assert/strict';

import { stopAndRemoveMany } from '../../cli/sandbox/docker/containerFleet.js';

test('stopAndRemoveMany preserves sandbox classification from a supplied registry snapshot', () => {
    const runtimeKey = `ploinky_runtime_snapshot_${process.pid}`;
    const agentName = `missing-sandbox-process-${process.pid}`;

    const removed = stopAndRemoveMany([runtimeKey], {
        records: {
            [runtimeKey]: {
                type: 'agent',
                runtime: 'bwrap',
                agentName
            }
        }
    });

    assert.deepEqual(removed, [runtimeKey]);
});
