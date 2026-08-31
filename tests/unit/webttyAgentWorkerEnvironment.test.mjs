import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AGENT_WORKER_ENVIRONMENT_KEYS,
    assertExactAgentWorkerEnvironment,
    buildAgentWorkerEnvironment,
} from '../../cli/server/webtty/agentWorkerEnvironment.mjs';

test('agent Podman worker receives only the Phase 0 fixed environment', () => {
    const inherited = {
        PLOINKY_ROUTER_TOKEN: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        XDG_RUNTIME_DIR: '/attacker/runtime',
        CONTAINERS_CONF: '/attacker/containers.conf',
        PATH: '/attacker/bin',
    };
    const environment = buildAgentWorkerEnvironment(inherited);
    assert.deepEqual(Object.keys(environment).sort(), AGENT_WORKER_ENVIRONMENT_KEYS);
    assert.deepEqual(environment, {
        HOME: '/home/podman',
        USER: 'podman',
        LOGNAME: 'podman',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
    });
    assert.equal(Object.isFrozen(environment), true);
    assert.equal(JSON.stringify(environment).includes('secret'), false);
    assert.equal(environment.XDG_RUNTIME_DIR, undefined);
    assert.equal(environment.CONTAINERS_CONF, undefined);
});

test('agent worker environment validation rejects additions, omissions, and changes', () => {
    const exact = buildAgentWorkerEnvironment();
    assert.deepEqual(assertExactAgentWorkerEnvironment(exact), exact);
    for (const candidate of [
        { ...exact, ROUTER_SECRET: 'secret' },
        Object.fromEntries(Object.entries(exact).slice(1)),
        { ...exact, PATH: '/tmp' },
        null,
        [],
    ]) {
        assert.throws(
            () => assertExactAgentWorkerEnvironment(candidate),
            (error) => error.code === 'WEBTTY_AGENT_ENVIRONMENT_INVALID',
        );
    }
});
