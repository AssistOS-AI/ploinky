import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
    ensureAgentLibCacheLink,
    agentLibCacheLinkProblem,
    agentLibStampProblem,
    agentLibStampSection,
} from '../../cli/utils/dependencies/agentLibLink.js';

function writePackage(directory, name, marker = 'private-copy') {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.mjs' }));
    fs.writeFileSync(path.join(directory, 'index.mjs'), `export const marker = ${JSON.stringify(marker)};\n`);
    return directory;
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-aliases-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cache = path.join(root, 'cache');
    const modules = path.join(cache, 'node_modules');
    fs.mkdirSync(modules, { recursive: true });
    const selected = writePackage(path.join(root, 'selected'), 'ploinky-agent-lib', 'selected');
    return { root, cache, modules, selected };
}

test('hoisted and scoped nested npm consumers load the one selected AgentLib', (t) => {
    const f = fixture(t);
    const consumers = [
        writePackage(path.join(f.modules, 'consumer'), 'consumer'),
        writePackage(path.join(f.modules, '@outer', 'parent', 'node_modules', 'consumer'), 'consumer'),
    ];
    const installed = [
        path.join(f.modules, 'ploinky-agent-lib'),
        path.join(consumers[1], 'node_modules', 'ploinky-agent-lib'),
        path.join(consumers[1], 'node_modules', 'achillesAgentLib'),
        path.join(f.modules, '@renamed', 'framework'),
    ];
    for (const directory of installed) writePackage(directory, 'ploinky-agent-lib');
    const sourceBefore = fs.readFileSync(path.join(f.selected, 'index.mjs'), 'utf8');
    assert.match(agentLibCacheLinkProblem(f.cache, f.selected), /missing|copied package/);
    for (const directory of installed) assert.equal(fs.lstatSync(directory).isDirectory(), true, 'inspection is read-only');

    assert.equal(ensureAgentLibCacheLink(f.cache, f.selected).created, true);
    assert.equal(agentLibCacheLinkProblem(f.cache, f.selected), '');
    for (const directory of installed) {
        assert.equal(fs.lstatSync(directory).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(directory), f.selected);
        assert.equal(fs.readFileSync(path.join(directory, 'index.mjs'), 'utf8'), sourceBefore);
    }
    for (const directory of consumers) {
        const require = createRequire(path.join(directory, 'package.json'));
        assert.equal(require.resolve('ploinky-agent-lib'), path.join(f.selected, 'index.mjs'));
        assert.equal(require.resolve('achillesAgentLib'), path.join(f.selected, 'index.mjs'));
    }
    assert.equal(ensureAgentLibCacheLink(f.cache, f.selected).created, false);
    assert.equal(fs.readFileSync(path.join(f.selected, 'index.mjs'), 'utf8'), sourceBefore);
});

test('wrong and broken AgentLib links are replaced without modifying their source', (t) => {
    const f = fixture(t);
    const stale = writePackage(path.join(f.root, 'stale'), 'ploinky-agent-lib');
    const consumer = writePackage(path.join(f.modules, 'consumer'), 'consumer');
    fs.mkdirSync(path.join(consumer, 'node_modules'));
    fs.symlinkSync(stale, path.join(f.modules, 'ploinky-agent-lib'));
    fs.symlinkSync('/missing-agentlib', path.join(consumer, 'node_modules', 'ploinky-agent-lib'));
    ensureAgentLibCacheLink(f.cache, f.selected);
    assert.equal(agentLibCacheLinkProblem(f.cache, f.selected), '');
    assert.match(fs.readFileSync(path.join(stale, 'index.mjs'), 'utf8'), /private-copy/);
    assert.equal(fs.readlinkSync(path.join(consumer, 'node_modules', 'ploinky-agent-lib')), f.selected);
    fs.unlinkSync(path.join(f.modules, 'ploinky-agent-lib'));
    assert.match(agentLibCacheLinkProblem(f.cache, f.selected), /missing/);
    ensureAgentLibCacheLink(f.cache, f.selected);
    assert.equal(agentLibCacheLinkProblem(f.cache, f.selected), '');
});

test('linked package, scope and nested module trees with private AgentLib fail without source mutation', (t) => {
    for (const placement of ['package', 'scope', 'nested', 'root']) {
        const f = fixture(t);
        const outside = path.join(f.root, 'outside');
        const privateLibrary = writePackage(path.join(outside, ...(placement === 'package' ? ['node_modules'] : []), 'ploinky-agent-lib'), 'ploinky-agent-lib');
        if (placement === 'package') fs.symlinkSync(outside, path.join(f.modules, 'linked'));
        if (placement === 'scope') fs.symlinkSync(outside, path.join(f.modules, '@linked'));
        if (placement === 'nested') {
            const consumer = writePackage(path.join(f.modules, 'consumer'), 'consumer');
            fs.symlinkSync(outside, path.join(consumer, 'node_modules'));
        }
        if (placement === 'root') {
            fs.rmdirSync(f.modules);
            fs.symlinkSync(outside, f.modules);
        }
        assert.match(agentLibCacheLinkProblem(f.cache, f.selected), /Unsafe AgentLib dependency cache/, placement);
        assert.throws(() => ensureAgentLibCacheLink(f.cache, f.selected), /Unsafe AgentLib dependency cache/, placement);
        assert.equal(fs.lstatSync(privateLibrary).isDirectory(), true);
        assert.match(fs.readFileSync(path.join(privateLibrary, 'index.mjs'), 'utf8'), /private-copy/);
        assert.deepEqual(fs.readdirSync(outside), [placement === 'package' ? 'node_modules' : 'ploinky-agent-lib']);
    }
});

test('legacy and unknown adapter schemas fail admission while the selected-source identity stays exact', () => {
    const selection = { sourceDir: '/selected', mode: 'local', fingerprint: 'a'.repeat(64), sourceIdHash: 'b'.repeat(64) };
    const current = agentLibStampSection('container-linux-x64-node25', selection);
    const legacy = { ...current };
    delete legacy.adapterSchema;
    assert.match(agentLibStampProblem({ agentLib: legacy }, current), /adapterSchema changed/);
    assert.match(agentLibStampProblem({ agentLib: { ...current, adapterSchema: 999 } }, current), /adapterSchema changed/);
    assert.match(agentLibStampProblem({ agentLib: { ...current, adapterSchema: '1' } }, current), /adapterSchema changed/);
    assert.equal(agentLibStampProblem({ agentLib: current }, current), '');
    assert.equal(current.linkTarget, '/opt/ploinky-agentlib');
    assert.equal(agentLibStampSection('seatbelt-darwin-arm64-node25', selection).linkTarget, '/selected');
});

test('unrelated local package links and linked packages using the selected library remain supported', (t) => {
    const f = fixture(t);
    const source = writePackage(path.join(f.root, 'local-consumer'), 'consumer');
    const manifestPath = path.join(source, 'package.json');
    fs.symlinkSync(source, path.join(f.modules, 'consumer'));
    ensureAgentLibCacheLink(f.cache, f.selected);
    assert.equal(agentLibCacheLinkProblem(f.cache, f.selected), '');
    const manifest = { ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        dependencies: { 'ploinky-agent-lib': '*' } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match(agentLibCacheLinkProblem(f.cache, f.selected), /AgentLib outside the owned cache/);
    fs.mkdirSync(path.join(source, 'node_modules'));
    fs.symlinkSync(f.selected, path.join(source, 'node_modules', 'ploinky-agent-lib'));
    const sourceBefore = fs.readFileSync(manifestPath, 'utf8');
    ensureAgentLibCacheLink(f.cache, f.selected);
    assert.equal(agentLibCacheLinkProblem(f.cache, f.selected), '');
    assert.equal(fs.readlinkSync(path.join(f.modules, 'consumer')), source);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), sourceBefore);
});

test('changing the admitted source repairs previously adapted npm aliases', (t) => {
    const f = fixture(t);
    const custom = writePackage(path.join(f.modules, 'renamed-framework'), 'ploinky-agent-lib');
    ensureAgentLibCacheLink(f.cache, f.selected);
    const replacement = writePackage(path.join(f.root, 'replacement'), 'ploinky-agent-lib', 'replacement');
    ensureAgentLibCacheLink(f.cache, replacement);
    assert.equal(fs.readlinkSync(custom), replacement);
    assert.equal(agentLibCacheLinkProblem(f.cache, replacement), '');
    assert.match(fs.readFileSync(path.join(f.selected, 'index.mjs'), 'utf8'), /selected/);
});

test('actual offline npm install is adapted without changing the standalone consumer contract', (t) => {
    const f = fixture(t);
    const standalone = writePackage(path.join(f.root, 'standalone-library'), 'ploinky-agent-lib');
    const consumer = writePackage(path.join(f.root, 'consumer-source'), 'consumer');
    const manifestPath = path.join(consumer, 'package.json');
    const manifest = { ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        dependencies: { 'ploinky-agent-lib': `file:${standalone}` } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(f.cache, 'package.json'), JSON.stringify({
        name: 'test-cache', private: true, dependencies: { consumer: `file:${consumer}` },
    }));
    const installed = spawnSync('npm', ['install', '--offline', '--ignore-scripts', '--no-package-lock',
        '--no-audit', '--no-fund', '--install-links=true'], {
        cwd: f.cache, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, npm_config_cache: path.join(f.root, 'npm-cache') },
    });
    assert.equal(installed.status, 0, installed.error?.message || installed.stderr);
    const require = createRequire(path.join(f.modules, 'consumer', 'package.json'));
    assert.notEqual(require.resolve('ploinky-agent-lib'), path.join(f.selected, 'index.mjs'));
    ensureAgentLibCacheLink(f.cache, f.selected);
    // A new process avoids Node's resolution cache from the pre-adaptation probe.
    const resolved = spawnSync(process.execPath, ['--input-type=module', '-e',
        'import {createRequire} from "node:module"; process.stdout.write(createRequire(process.argv[1]).resolve("ploinky-agent-lib"));',
        path.join(f.modules, 'consumer', 'package.json')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(resolved.stdout, path.join(f.selected, 'index.mjs'));
    assert.equal(agentLibCacheLinkProblem(f.cache, f.selected), '');
    assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifest);
    assert.match(fs.readFileSync(path.join(standalone, 'index.mjs'), 'utf8'), /private-copy/);
});
