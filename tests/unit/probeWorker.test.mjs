import assert from 'node:assert/strict';
import test from 'node:test';

import { serializeProbeError } from '../../cli/server/probeWorker.js';

test('probe worker preserves a trusted control-plane timeout code', () => {
    const error = new Error('spawnSync podman ETIMEDOUT');
    error.code = 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT';

    assert.deepEqual(serializeProbeError(error), {
        error: 'spawnSync podman ETIMEDOUT',
        code: 'PLOINKY_PROBE_CONTROL_PLANE_TIMEOUT',
    });
});

test('probe worker does not infer infrastructure status from an error message', () => {
    assert.deepEqual(serializeProbeError(new Error('spawnSync podman ETIMEDOUT')), {
        error: 'spawnSync podman ETIMEDOUT',
        code: null,
    });
});
