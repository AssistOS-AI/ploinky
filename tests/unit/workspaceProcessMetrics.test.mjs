import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateProcessTreeMetrics } from '../../cli/server/workspaceProcessMetrics.js';

test('process-tree metrics aggregate the entrypoint and every descendant', () => {
  const metrics = aggregateProcessTreeMetrics(`
    10 1 1.5 100
    11 10 2.0 200
    12 11 3.5 300
    20 1 9.0 900
  `, [10]);

  assert.deepEqual(metrics.get(10), {
    available: true,
    cpuPercent: 7,
    memoryBytes: 600 * 1024,
  });
  assert.equal(metrics.has(20), false);
});

test('process-tree metrics omit a root PID that is not visible to ps', () => {
  const metrics = aggregateProcessTreeMetrics('10 1 1.5 100', [99]);
  assert.equal(metrics.has(99), false);
});
