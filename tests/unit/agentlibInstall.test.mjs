import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    AGENTLIB_CACHE_LINK_NAMES,
    agentLibCacheLinkProblem,
    assertNoReservedAgentLibDependency,
    ensureAgentLibCacheLink,
    installWithAgentLib,
} from '../../cli/utils/dependencies/agentLibLink.js';
import { canonicalAgentLibRemote } from '../../agentlib/contract.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-install-'));
    const source = path.join(root, 'selected');
    const cache = path.join(root, 'cache');
    fs.mkdirSync(source);
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
        name: 'ploinky-agent-lib', version: '1.0.0', main: 'index.cjs',
    }));
    fs.writeFileSync(path.join(source, 'index.cjs'), 'module.exports = "selected-source";\n');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, source, cache };
}

test('both AgentLib dependency names, aliases and overrides are reserved before npm runs', () => {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of AGENTLIB_CACHE_LINK_NAMES) {
            assert.throws(() => assertNoReservedAgentLibDependency({ [field]: { [name]: 'file:../private' } }),
                { code: 'PLOINKY_AGENTLIB_RESERVED_DEPENDENCY' });
        }
        for (const spec of ['npm:ploinky-agent-lib@1', 'npm:achillesAgentLib@1', `${canonicalAgentLibRemote().url}#main`]) {
            assert.throws(() => assertNoReservedAgentLibDependency({ [field]: { renamed: spec } }),
                { code: 'PLOINKY_AGENTLIB_RESERVED_DEPENDENCY' });
        }
    }
    for (const overrides of [
        { 'ploinky-agent-lib': 'file:../private' },
        { consumer: { 'achillesAgentLib@1': '2' } },
        { consumer: { '.': '$ploinky-agent-lib' } },
    ]) assert.throws(() => assertNoReservedAgentLibDependency({ overrides }), /remove the override/);
    assert.throws(() => assertNoReservedAgentLibDependency({ bundledDependencies: ['ploinky-agent-lib'] }), /must not bundle/);
    assert.doesNotThrow(() => assertNoReservedAgentLibDependency({
        dependencies: { example: '1.0.0' }, overrides: { example: '1.0.1' },
    }));
});

test('both cache names resolve to the same source and reject nested renamed copies', (t) => {
    const { source, cache } = fixture(t);
    ensureAgentLibCacheLink(cache, source);
    for (const name of AGENTLIB_CACHE_LINK_NAMES) {
        assert.equal(fs.realpathSync(path.join(cache, 'node_modules', name)), source);
    }
    assert.equal(agentLibCacheLinkProblem(cache, source), '');
    assert.equal(ensureAgentLibCacheLink(cache, source).created, false);
    for (const name of [...AGENTLIB_CACHE_LINK_NAMES, '@private/renamed']) {
        const copied = path.join(cache, 'node_modules', 'consumer', 'node_modules', name);
        fs.mkdirSync(copied, { recursive: true });
        fs.writeFileSync(path.join(copied, 'package.json'), JSON.stringify({ name: 'ploinky-agent-lib' }));
        assert.match(agentLibCacheLinkProblem(cache, source), /competing AgentLib package/);
        ensureAgentLibCacheLink(cache, source);
        assert.match(agentLibCacheLinkProblem(cache, source), /competing AgentLib package/,
            'repairing root links must not hide a nested duplicate');
        fs.rmSync(copied, { recursive: true, force: true });
    }
    assert.equal(agentLibCacheLinkProblem(cache, source), '');
});

test('failed npm restores the original manifest and never rewrites the selected source', (t) => {
    const { source, cache } = fixture(t);
    const pkg = { name: 'fixture', dependencies: { example: '1.0.0' } };
    const before = fs.readFileSync(path.join(source, 'package.json'));
    assert.throws(() => installWithAgentLib(cache, pkg, { sourceDir: source, installTarget: source }, () => {
        throw new Error('npm failed');
    }), /npm failed/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cache, 'package.json'), 'utf8')), pkg);
    assert.deepEqual(fs.readFileSync(path.join(source, 'package.json')), before);
    assert.equal(fs.existsSync(path.join(source, 'node_modules')), false);
});

test('linked dependency trees are cycle-safe and cannot hide private AgentLib copies', (t) => {
    const { root, source, cache } = fixture(t);
    const consumer = path.join(root, 'linked-consumer');
    const dependencies = path.join(consumer, 'node_modules');
    fs.mkdirSync(dependencies, { recursive: true });
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0' }));
    fs.symlinkSync(consumer, path.join(dependencies, 'cycle'));
    const pkg = { name: 'file-cache', version: '1.0.0', dependencies: { consumer: `file:${consumer}` } };
    installWithAgentLib(cache, pkg, { sourceDir: source, installTarget: source }, (cwd) => {
        const result = spawnSync('npm', [
            'install', '--offline', '--no-package-lock', '--no-audit', '--no-fund', '--install-links=false',
        ], { cwd, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, npm_config_cache: path.join(root, 'empty-npm-cache') } });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
    const consumerLink = path.join(cache, 'node_modules', 'consumer');
    assert.equal(fs.lstatSync(consumerLink).isSymbolicLink(), true, 'npm file: dependencies use external links');
    assert.equal(fs.realpathSync(consumerLink), consumer);
    ensureAgentLibCacheLink(cache, source);
    assert.equal(agentLibCacheLinkProblem(cache, source), '', 'ordinary linked packages and cycles are valid');
    const privateLibrary = path.join(dependencies, 'ploinky-agent-lib');
    fs.mkdirSync(privateLibrary);
    fs.writeFileSync(path.join(privateLibrary, 'package.json'), JSON.stringify({ name: 'ploinky-agent-lib' }));
    assert.match(agentLibCacheLinkProblem(cache, source), /competing AgentLib package/);
});

test('a linked npm scope cannot hide a renamed AgentLib package', (t) => {
    const { root, source, cache } = fixture(t);
    const scope = path.join(root, 'linked-scope');
    const renamed = path.join(scope, 'renamed');
    fs.mkdirSync(renamed, { recursive: true });
    fs.writeFileSync(path.join(renamed, 'package.json'), JSON.stringify({ name: 'ploinky-agent-lib' }));
    ensureAgentLibCacheLink(cache, source);
    fs.symlinkSync(scope, path.join(cache, 'node_modules', '@private'));
    assert.match(agentLibCacheLinkProblem(cache, source), /competing AgentLib package/);
});

test('offline npm overrides transitive Git requests and lifecycle imports use the selected source', (t) => {
    const { root, source, cache } = fixture(t);
    const consumer = path.join(root, 'consumer', 'package');
    fs.mkdirSync(consumer, { recursive: true });
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
        name: 'offline-consumer', version: '1.0.0', main: 'index.cjs',
        dependencies: {
            'ploinky-agent-lib': 'git+https://invalid.invalid/private-agentlib.git#main',
            achillesAgentLib: 'git+https://invalid.invalid/other-agentlib.git#main',
        },
        scripts: { postinstall: 'node lifecycle.cjs' },
    }));
    fs.writeFileSync(path.join(consumer, 'lifecycle.cjs'), `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.equal(require('ploinky-agent-lib'), 'selected-source');
assert.equal(require('achillesAgentLib'), 'selected-source');
assert.equal(require.resolve('ploinky-agent-lib'), require.resolve('achillesAgentLib'));
fs.writeFileSync('lifecycle-ran', 'passed');
`);
    fs.writeFileSync(path.join(consumer, 'index.cjs'), 'module.exports = require.resolve("ploinky-agent-lib");\n');
    const archive = path.join(root, 'consumer.tgz');
    const packed = spawnSync('tar', ['-czf', archive, '-C', path.dirname(consumer), 'package'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const pkg = {
        name: 'offline-cache', version: '1.0.0', dependencies: { 'offline-consumer': `file:${archive}` },
        scripts: { postinstall: `node -e "if(require('offline-consumer')!==require.resolve('ploinky-agent-lib'))process.exit(1)"` },
    };
    const gitLog = path.join(root, 'git-invoked');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf forbidden > "$AGENTLIB_TEST_GIT_LOG"\nexit 99\n', { mode: 0o755 });
    const before = fs.readFileSync(path.join(source, 'package.json'));
    installWithAgentLib(cache, pkg, { sourceDir: source, installTarget: source }, (cwd, _localPackage, options) => {
        assert.equal(options.linkAgentLib, true);
        const result = spawnSync('npm', [
            'install', '--offline', '--no-package-lock', '--no-audit', '--no-fund', '--install-links=false',
        ], {
            cwd, encoding: 'utf8', timeout: 30000,
            env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                AGENTLIB_TEST_GIT_LOG: gitLog, npm_config_cache: path.join(root, 'empty-npm-cache') },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
    assert.equal(fs.existsSync(gitLog), false, 'npm must never fetch another AgentLib source');
    assert.equal(fs.readFileSync(path.join(cache, 'node_modules', 'offline-consumer', 'lifecycle-ran'), 'utf8'), 'passed');
    ensureAgentLibCacheLink(cache, source);
    assert.equal(agentLibCacheLinkProblem(cache, source), '');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cache, 'package.json'), 'utf8')), pkg);
    assert.deepEqual(fs.readFileSync(path.join(source, 'package.json')), before);
    assert.equal(fs.existsSync(path.join(source, 'node_modules')), false);
});
