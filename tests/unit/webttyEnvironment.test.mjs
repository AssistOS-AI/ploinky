import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PROFILE_SHELL_ENVIRONMENT_KEYS,
    SHELL_ENVIRONMENT_KEYS,
    SHELL_PROFILE_ENVIRONMENT_KEYS,
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

const PROFILE = Object.freeze({
    home: `${WORKSPACE_ROOT}/.data/provider/profiles/p-1/home`,
    provider: 'provider',
    id: 'p-1',
    label: 'Profile One',
});

test('a profile changes only the shell HOME and adds INPUTRC and three profile variables', () => {
    const options = { workspaceRoot: WORKSPACE_ROOT };
    const plain = buildShellEnvironment(inheritedSecrets, options);
    const profiled = buildShellEnvironment(inheritedSecrets, { ...options, profile: PROFILE });
    assert.deepEqual(Object.keys(profiled).sort(), PROFILE_SHELL_ENVIRONMENT_KEYS);
    assert.deepEqual(PROFILE_SHELL_ENVIRONMENT_KEYS, [...SHELL_ENVIRONMENT_KEYS, ...SHELL_PROFILE_ENVIRONMENT_KEYS].sort());
    assert.deepEqual(profiled, {
        ...plain,
        HOME: PROFILE.home,
        INPUTRC: '/etc/inputrc',
        PLOINKY_WEBTTY_PROFILE_PROVIDER: 'provider',
        PLOINKY_WEBTTY_PROFILE_ID: 'p-1',
        PLOINKY_WEBTTY_PROFILE_LABEL: 'Profile One',
    });
    // PATH, the shell and the worker environment are untouched.
    assert.equal(profiled.PATH, plain.PATH);
    assert.equal(profiled.SHELL, '/bin/bash');
    assert.deepEqual(buildWorkerEnvironment(inheritedSecrets, options), buildWorkerEnvironment({}, options));
    assert.equal(buildWorkerEnvironment({}, options).HOME, '/home/podman');
    // Without a profile the shell environment is exactly the fixed allowlist.
    assert.deepEqual(Object.keys(plain).sort(), SHELL_ENVIRONMENT_KEYS);
    assert.equal(plain.HOME, '/home/podman');
    assert.equal('INPUTRC' in plain, false);
    assert.equal('INPUTRC' in buildWorkerEnvironment({}, options), false);
    for (const profile of [
        { ...PROFILE, home: 'relative/home' },
        { ...PROFILE, home: `${PROFILE.home}/` },
        { ...PROFILE, home: '/' },
        { ...PROFILE, home: `${WORKSPACE_ROOT}/../escape` },
        { ...PROFILE, provider: '../provider' },
        { ...PROFILE, id: 'p/1' },
        { ...PROFILE, label: '' },
        { ...PROFILE, label: 'bad\u001blabel' },
        { ...PROFILE, label: 'x'.repeat(129) },
    ]) {
        assert.throws(
            () => buildShellEnvironment({}, { ...options, profile }),
            (error) => error.code === 'WEBTTY_ENVIRONMENT_INVALID',
            JSON.stringify(profile).slice(0, 80),
        );
    }
});

test('the worker accepts profile keys only against its own revalidated HOME', () => {
    const options = { workspaceRoot: WORKSPACE_ROOT };
    const plain = buildShellEnvironment({}, options);
    const profiled = buildShellEnvironment({}, { ...options, profile: PROFILE });
    assert.deepEqual(assertExactShellEnvironment(profiled, { ...options, home: PROFILE.home }), profiled);
    for (const [environment, home] of [
        [profiled, undefined],
        [plain, PROFILE.home],
        [profiled, `${WORKSPACE_ROOT}/.data/provider/profiles/p-2/home`],
        [{ ...profiled, HOME: '/root' }, PROFILE.home],
        [{ ...profiled, PLOINKY_WEBTTY_PROFILE_LABEL: 'bad\nlabel' }, PROFILE.home],
        [{ ...profiled, PLOINKY_WEBTTY_PROFILE_ID: '../x' }, PROFILE.home],
        [{ ...profiled, NPM_TOKEN: 'secret' }, PROFILE.home],
        [{ ...profiled, INPUTRC: `${PROFILE.home}/.inputrc` }, PROFILE.home],
        [Object.fromEntries(Object.entries(profiled).filter(([key]) => key !== 'INPUTRC')), PROFILE.home],
        [{ ...plain, INPUTRC: '/etc/inputrc' }, undefined],
        [{ ...profiled, PATH: `${profiled.PATH}:${PROFILE.home}/bin` }, PROFILE.home],
        [Object.fromEntries(Object.entries(profiled).filter(([key]) => key !== 'PLOINKY_WEBTTY_PROFILE_ID')), PROFILE.home],
    ]) {
        assert.throws(
            () => assertExactShellEnvironment(environment, { ...options, home }),
            (error) => error.code === 'WEBTTY_ENVIRONMENT_INVALID',
        );
    }
});
