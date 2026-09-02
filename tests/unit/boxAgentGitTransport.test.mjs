import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    applyBoxGitTransportEnvFlags,
    hasBoxGitTransport,
    hasExactManagedEnv,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { flagsToArgs } from '../../cli/sandbox/docker/common.js';
import { formatEnvFlag } from '../../cli/utils/security/secretVars.js';
import { BOX_MARKER_CONTENT, BOX_MARKER_PATH } from '../../ploinky-box/constants.mjs';

function fixture(t, markerContent = BOX_MARKER_CONTENT) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'box-agent-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const marker = path.join(root, 'box-marker');
    if (markerContent !== null) fs.writeFileSync(marker, markerContent);
    for (const name of ['lstatSync', 'readFileSync']) {
        const original = fs[name];
        t.mock.method(fs, name, (filename, ...args) => original(filename === BOX_MARKER_PATH ? marker : filename, ...args));
    }
    const config = path.join(root, 'gitconfig');
    fs.writeFileSync(config, '[http]\n\tversion = HTTP/2\n');
    const flags = Object.entries({
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_PARAMETERS: "'test.agent=agent value' 'http.version=HTTP/2'",
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'test.counted',
        GIT_CONFIG_VALUE_0: 'kept as configured',
    }).map(([name, value]) => formatEnvFlag(name, value));
    return { root, config, flags };
}

function explicitEnv(flags) {
    const args = flagsToArgs(flags);
    const env = {};
    for (let index = 0; index < args.length; index += 2) {
        assert.equal(args[index], '-e');
        const entry = args[index + 1];
        const separator = entry.indexOf('=');
        assert.ok(separator > 0);
        env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return env;
}

function recordFromFlags(flags) {
    return { Config: { Env: flagsToArgs(flags).filter((_, index) => index % 2 === 1) } };
}

test('explicit nested agent environment carries Box transport into an executable install script', (t) => {
    const f = fixture(t);
    const originalConfig = fs.readFileSync(f.config, 'utf8');
    const priorPrivate = process.env.BOX_TRANSPORT_HOST_PRIVATE;
    process.env.BOX_TRANSPORT_HOST_PRIVATE = 'host-only-value';
    t.after(() => {
        if (priorPrivate === undefined) delete process.env.BOX_TRANSPORT_HOST_PRIVATE;
        else process.env.BOX_TRANSPORT_HOST_PRIVATE = priorPrivate;
    });
    const script = path.join(f.root, 'install.sh');
    fs.writeFileSync(script, [
        '#!/bin/sh',
        'set -eu',
        'transport=$(git config --get http.version)',
        'if [ "$transport" != HTTP/1.1 ]; then printf "unexpected transport: %s\\n" "$transport" >&2; exit 73; fi',
        'test -z "${BOX_TRANSPORT_HOST_PRIVATE+x}"',
        'git config --get http.version',
        'git config --get test.agent',
        'git config --get test.counted',
        '',
    ].join('\n'));
    const run = () => spawnSync('/bin/sh', [script], {
        cwd: f.root, env: explicitEnv(f.flags), encoding: 'utf8',
    });
    const before = run();
    assert.equal(before.status, 73, before.stderr);
    assert.match(before.stderr, /unexpected transport: HTTP\/2/);

    const required = applyBoxGitTransportEnvFlags(f.flags);
    const after = run();
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, 'HTTP/1.1\nagent value\nkept as configured\n');
    assert.deepEqual(Object.keys(required), ['GIT_CONFIG_PARAMETERS']);
    assert.equal(explicitEnv(f.flags).BOX_TRANSPORT_HOST_PRIVATE, undefined);
    assert.equal(hasExactManagedEnv(recordFromFlags(f.flags), required), true);
    assert.equal(fs.readFileSync(f.config, 'utf8'), originalConfig);
    assert.equal(process.env.BOX_TRANSPORT_HOST_PRIVATE, 'host-only-value');
});

test('Box transport preserves the final configured Git parameters and remains a singleton on re-entry', (t) => {
    const f = fixture(t);
    f.flags.push(formatEnvFlag('GIT_CONFIG_PARAMETERS', "'test.agent=last value λ \\\\ literal' 'http.version=HTTP/2'"));
    const configured = applyBoxGitTransportEnvFlags(f.flags);
    const once = [...f.flags];
    for (let count = 0; count < 100; count += 1) {
        assert.deepEqual(applyBoxGitTransportEnvFlags(f.flags), configured);
    }
    assert.deepEqual(f.flags, once);
    assert.equal(f.flags.filter(flag => flag.startsWith('-e GIT_CONFIG_PARAMETERS=')).length, 1);
    const result = spawnSync('git', ['config', '--get', 'test.agent'], {
        cwd: f.root, env: explicitEnv(f.flags), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'last value λ \\\\ literal');
});

test('Git parameter escape sequences round-trip through Box launch and reuse unchanged', (t) => {
    const f = fixture(t);
    for (const value of [String.raw`C:\new\node`, 'first line\nsecond line', String.raw`quoted "value" $literal \path`]) {
        const flags = [...f.flags, formatEnvFlag('GIT_CONFIG_PARAMETERS', `'test.path=${value}' 'http.version=HTTP/2'`)];
        const readPath = () => {
            const result = spawnSync('git', ['config', '--get', 'test.path'], {
                cwd: f.root, env: explicitEnv(flags), encoding: 'utf8',
            });
            assert.equal(result.status, 0, result.stderr);
            return result.stdout.slice(0, -1);
        };
        assert.equal(readPath(), value);
        const configured = applyBoxGitTransportEnvFlags(flags);
        assert.equal(readPath(), value);
        const once = [...flags];
        for (let count = 0; count < 100; count += 1) {
            assert.deepEqual(applyBoxGitTransportEnvFlags(flags), configured);
            assert.equal(hasBoxGitTransport(recordFromFlags(flags)), true);
        }
        assert.deepEqual(flags, once);
        assert.equal(readPath(), value);
        assert.equal(hasExactManagedEnv(recordFromFlags(flags), configured), true);
    }
});

test('a nested agent without Git settings receives only the Box transport parameter', (t) => {
    fixture(t);
    const flags = [formatEnvFlag('AGENT_SETTING', 'kept')];
    const required = applyBoxGitTransportEnvFlags(flags);
    assert.deepEqual(explicitEnv(flags), { AGENT_SETTING: 'kept', ...required });
    const result = spawnSync('git', ['config', '--get', 'http.version'], {
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...required },
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'HTTP/1.1');
});

test('outside a validated Box explicit agent flags and Git behavior remain unchanged', (t) => {
    const f = fixture(t, null);
    const before = [...f.flags];
    assert.deepEqual(applyBoxGitTransportEnvFlags(f.flags), {});
    assert.deepEqual(f.flags, before);
    assert.equal(hasBoxGitTransport(recordFromFlags(f.flags)), true);
    const result = spawnSync('git', ['config', '--get', 'http.version'], {
        cwd: f.root, env: explicitEnv(f.flags), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'HTTP/2');
});

test('malformed Box marker rejects explicit runtime environment before mutation', (t) => {
    const f = fixture(t, 'invalid-marker');
    const before = [...f.flags];
    assert.throws(() => applyBoxGitTransportEnvFlags(f.flags), { code: 'PLOINKY_BOX_MARKER_INVALID' });
    assert.deepEqual(f.flags, before);
    assert.throws(() => hasBoxGitTransport(recordFromFlags(f.flags)), { code: 'PLOINKY_BOX_MARKER_INVALID' });
});

test('Box runtime reuse rejects absent, obsolete or duplicated transport settings', (t) => {
    const f = fixture(t);
    assert.equal(hasBoxGitTransport({ Config: { Env: [] } }), false);
    assert.equal(hasBoxGitTransport(recordFromFlags(f.flags)), false);
    const expected = applyBoxGitTransportEnvFlags(f.flags);
    assert.equal(hasBoxGitTransport(recordFromFlags(f.flags)), true);
    const duplicated = recordFromFlags([...f.flags, formatEnvFlag('GIT_CONFIG_PARAMETERS', expected.GIT_CONFIG_PARAMETERS)]);
    assert.equal(hasBoxGitTransport(duplicated), false);
    assert.equal(hasExactManagedEnv(duplicated, expected), false);
    const changed = recordFromFlags([formatEnvFlag('GIT_CONFIG_PARAMETERS', "'http.version=HTTP/2'")]);
    assert.equal(hasExactManagedEnv(changed, expected), false);
});
