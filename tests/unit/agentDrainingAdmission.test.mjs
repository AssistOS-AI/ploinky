import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAgentServiceNotDraining } from '../../cli/sandbox/docker/agentServiceManager.js';

test('a failed targeted drain blocks later automatic admission of the same runtime owner', () => {
    const loadRouting = () => ({ routes: {
        office: { container: 'exact-owner', draining: true },
    } });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(() => assertAgentServiceNotDraining('exact-owner', { loadRouting }), {
            code: 'PLOINKY_AGENT_DRAINING',
        });
    }
    assert.doesNotThrow(() => assertAgentServiceNotDraining('another-owner', { loadRouting }));
});

test('only the coordinated targeted restart may proceed while its predecessor remains draining', () => {
    assert.doesNotThrow(() => assertAgentServiceNotDraining('exact-owner', {
        targetedRestart: true,
        loadRouting() { throw new Error('Targeted restart validates its own selected drain generation.'); },
    }));
});

test('cleared or absent drain state permits ordinary admission', () => {
    for (const routing of [null, {}, { routes: { office: { container: 'exact-owner', draining: false } } }]) {
        assert.doesNotThrow(() => assertAgentServiceNotDraining('exact-owner', { loadRouting: () => routing }));
    }
});
