import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    buildContainerInstallScript,
    NPM_INSTALL_ARGS,
    runNpmInstall,
} from '../../cli/utils/dependencies/dependencyCache.js';

function fixture(t, transport) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dependency-git-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    const config = path.join(root, 'gitconfig');
    const observed = path.join(root, 'observed.json');
    fs.mkdirSync(bin);
    fs.writeFileSync(config, transport ? `[http]\n\tversion = ${transport}\n` : '');
    // The npm stand-in executes real Git with the installer's child environment.
    fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
function git(args, absentAllowed = false) {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    if (absentAllowed && result.status === 1) return null;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
}
fs.writeFileSync(process.env.DEPS_TEST_OBSERVED, JSON.stringify({
    transport: git(['config', '--get', 'http.version'], true),
    inherited: git(['config', '--get', 'test.inherited']),
    url: git(['ls-remote', '--get-url', 'ssh://git@github.com/AssistOS-AI/soplang.git']),
    args: process.argv.slice(2),
}));
process.exit(Number(process.env.DEPS_TEST_NPM_EXIT || '0'));
`, { mode: 0o755 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, {
        HOME: root,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: config,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_PARAMETERS: "'test.inherited=kept'",
        DEPS_TEST_OBSERVED: observed,
    });
    return { root, config, observed, env };
}

function assertObserved(f, transport) {
    assert.deepEqual(JSON.parse(fs.readFileSync(f.observed, 'utf8')), {
        transport,
        inherited: 'kept',
        url: 'https://github.com/AssistOS-AI/soplang.git',
        args: NPM_INSTALL_ARGS,
    });
}

for (const transport of [null, 'HTTP/2']) {
    const label = transport || 'default negotiation';
    test(`container npm preserves ${label} and propagates install failures`, (t) => {
        const f = fixture(t, transport);
        const script = buildContainerInstallScript({ installDir: f.root, heartbeatSeconds: 0.01 });
        for (const exitCode of [0, 29]) {
            const result = spawnSync('/bin/sh', ['-c', script], {
                cwd: f.root,
                env: { ...f.env, DEPS_TEST_NPM_EXIT: String(exitCode) },
                encoding: 'utf8',
                timeout: 5000,
            });
            assert.equal(result.status, exitCode, `${result.stdout}\n${result.stderr}`);
            assertObserved(f, transport);
        }
    });

    test(`host npm preserves ${label}, caller environment and Git configuration`, (t) => {
        const f = fixture(t, transport);
        const originalEnv = process.env;
        process.env = { ...f.env };
        t.after(() => { process.env = originalEnv; });
        const before = { ...process.env };
        const config = fs.readFileSync(f.config, 'utf8');
        runNpmInstall(f.root, { log() {} });
        assertObserved(f, transport);
        assert.deepEqual(process.env, before);
        assert.equal(fs.readFileSync(f.config, 'utf8'), config);
    });
}
