import test from 'node:test';
import assert from 'node:assert/strict';

import {
    AGENT_PORT_CONVENTION_ROUTE_KEY,
    assertRouteKeyAvailable,
    isReservedRouteKey,
} from '../../cli/utils/runtime/reservedRouteKeys.js';

test('the convention and configuration keys cannot be registered as routes', () => {
    assert.equal(AGENT_PORT_CONVENTION_ROUTE_KEY, 'base-agent-additional-server');
    assert.equal(isReservedRouteKey(AGENT_PORT_CONVENTION_ROUTE_KEY), true);
    assert.equal(isReservedRouteKey('_config'), true);
    assert.throws(() => assertRouteKeyAvailable(AGENT_PORT_CONVENTION_ROUTE_KEY), /reserved/);
    assert.throws(() => assertRouteKeyAvailable('_config'), /reserved/);
    assert.equal(assertRouteKeyAvailable('alpha'), 'alpha');
});
