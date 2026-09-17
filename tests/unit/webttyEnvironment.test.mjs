import assert from 'node:assert/strict';
import test from 'node:test';

import {
    SHELL_ENVIRONMENT_KEYS,
    WEBTTY_SHELL_PROMPT,
    WORKER_ENVIRONMENT_KEYS,
    assertExactShellEnvironment,
    buildShellEnvironment,
    buildWorkerEnvironment,
} from '../../core-services/webtty/environment.mjs';

const WORKSPACE_ROOT = '/home/user/work space/proiect ăîș';

const inheritedSecrets = {
    PLOINKY_WORKSPACE_ROOT: '/attacker/selected/root',
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
    PS1: '$(printf inherited-prompt)',
};

test('worker and shell environments ignore every inherited value', () => {
    const worker = buildWorkerEnvironment(inheritedSecrets, { workspaceRoot: WORKSPACE_ROOT });
    const shell = buildShellEnvironment(inheritedSecrets, { workspaceRoot: WORKSPACE_ROOT });
    assert.deepEqual(Object.keys(worker).sort(), WORKER_ENVIRONMENT_KEYS);
    assert.deepEqual(Object.keys(shell).sort(), SHELL_ENVIRONMENT_KEYS);
    assert.equal(worker.HOME, '/home/podman');
    assert.equal(worker.PATH, '/opt/ploinky/bin:/usr/local/bin:/usr/bin:/bin');
    assert.equal(worker.PLOINKY_WORKSPACE_ROOT, WORKSPACE_ROOT);
    assert.equal(shell.SHELL, '/bin/bash');
    assert.equal(shell.PLOINKY_WORKSPACE_ROOT, WORKSPACE_ROOT);
    assert.equal(shell.PS1, WEBTTY_SHELL_PROMPT);
    for (const key of Object.keys(inheritedSecrets)) {
        if (['PATH', 'HOME', 'LANG', 'PS1', 'PLOINKY_WORKSPACE_ROOT'].includes(key)) {
            assert.notEqual(shell[key], inheritedSecrets[key], key);
        } else assert.equal(shell[key], undefined, key);
    }
});

test('the explicit workspace root is required and never inherited', () => {
    for (const workspaceRoot of [undefined, '', 'relative', '/home/user/project/', '/home/user/../project']) {
        for (const build of [buildWorkerEnvironment, buildShellEnvironment]) {
            assert.throws(
                () => build({ PLOINKY_WORKSPACE_ROOT: '/home/user/project' }, { workspaceRoot }),
                (error) => error.code === 'WEBTTY_CWD_INVALID' && error.category === 'workspace-root',
            );
        }
    }
});

test('the worker rejects additions, omissions, and altered fixed values', () => {
    const options = { workspaceRoot: WORKSPACE_ROOT };
    const shell = buildShellEnvironment({}, options);
    assert.deepEqual(assertExactShellEnvironment(shell, options), shell);
    for (const changed of [
        { ...shell, NPM_TOKEN: 'secret' },
        Object.fromEntries(Object.entries(shell).filter(([key]) => key !== 'HOME')),
        Object.fromEntries(Object.entries(shell).filter(([key]) => key !== 'PLOINKY_WORKSPACE_ROOT')),
        { ...shell, PATH: `${shell.PATH}:${WORKSPACE_ROOT}/bin` },
        { ...shell, PLOINKY_WORKSPACE_ROOT: '/other/host/path' },
        { ...shell, PLOINKY_WORKSPACE_ROOT: `${WORKSPACE_ROOT}/nested` },
        { ...shell, PS1: 'bash-5.3$ ' },
    ]) {
        assert.throws(
            () => assertExactShellEnvironment(changed, options),
            (error) => error.code === 'WEBTTY_ENVIRONMENT_INVALID',
        );
    }
    // The worker compares against its own trusted root, not the message.
    for (const workspaceRoot of ['/other/host/path', undefined, 'relative']) {
        assert.throws(
            () => assertExactShellEnvironment(shell, { workspaceRoot }),
            (error) => error.code === 'WEBTTY_ENVIRONMENT_INVALID',
        );
    }
});
