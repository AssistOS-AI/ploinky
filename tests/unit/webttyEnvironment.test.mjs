import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SHELL_ENVIRONMENT_KEYS,
    WORKER_ENVIRONMENT_KEYS,
    assertExactShellEnvironment,
    buildShellEnvironment,
    buildWorkerEnvironment,
} from '../../core-services/webtty/environment.mjs';

const inheritedSecrets = {
    ROUTER_AUTH_SECRET: 'router-secret',
    PLOINKY_ROUTING_JWT: 'routing-secret',
    CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-secret',
    AGENT_AUTH_TOKEN: 'agent-secret',
    NPM_TOKEN: 'npm-secret',
    NODE_AUTH_TOKEN: 'node-secret',
    AWS_SECRET_ACCESS_KEY: 'workspace-secret',
    PATH: '/attacker/bin',
    HOME: '/root',
    LANG: 'attacker-locale',
};

test('worker and shell environments ignore every inherited value', () => {
    const worker = buildWorkerEnvironment(inheritedSecrets);
    const shell = buildShellEnvironment(inheritedSecrets);
    assert.deepEqual(Object.keys(worker).sort(), WORKER_ENVIRONMENT_KEYS);
    assert.deepEqual(Object.keys(shell).sort(), SHELL_ENVIRONMENT_KEYS);
    assert.equal(worker.HOME, '/home/podman');
    assert.equal(worker.PATH, '/opt/ploinky/bin:/usr/local/bin:/usr/bin:/bin');
    assert.equal(shell.SHELL, '/bin/bash');
    assert.equal(shell.PLOINKY_WORKSPACE_ROOT, '/workspace');
    for (const key of Object.keys(inheritedSecrets)) {
        if (['PATH', 'HOME', 'LANG'].includes(key)) assert.notEqual(shell[key], inheritedSecrets[key]);
        else assert.equal(shell[key], undefined, key);
    }
});

test('the worker rejects additions, omissions, and altered fixed values', () => {
    const shell = buildShellEnvironment();
    assert.deepEqual(assertExactShellEnvironment(shell), shell);
    for (const changed of [
        { ...shell, NPM_TOKEN: 'secret' },
        Object.fromEntries(Object.entries(shell).filter(([key]) => key !== 'HOME')),
        { ...shell, PATH: `${shell.PATH}:/workspace/bin` },
        { ...shell, PLOINKY_WORKSPACE_ROOT: '/physical/host/path' },
    ]) {
        assert.throws(
            () => assertExactShellEnvironment(changed),
            (error) => error.code === 'WEBTTY_ENVIRONMENT_INVALID',
        );
    }
});
