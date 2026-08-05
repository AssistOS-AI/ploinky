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
                agentName,
                instanceId: 'snapshot-instance',
                enableGeneration: 'snapshot-generation',
            }
        }
    });

    assert.deepEqual(removed, [runtimeKey]);
});

test('stopAndRemoveMany fails closed for missing and legacy runtime classifications', () => {
    for (const runtime of [undefined, 'container', 'docker', ' podman', 'PODMAN']) {
        const runtimeKey = `ploinky_invalid_snapshot_${process.pid}`;
        const removed = stopAndRemoveMany([runtimeKey], {
            records: {
                [runtimeKey]: {
                    type: 'agent',
                    ...(runtime === undefined ? {} : { runtime }),
                    containerId: 'a'.repeat(64),
                    instanceId: 'snapshot-instance',
                    enableGeneration: 'snapshot-generation',
                },
            },
        });
        assert.deepEqual(removed, []);
    }
});
