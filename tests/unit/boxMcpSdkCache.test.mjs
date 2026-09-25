// The Box image supplies the one MCP SDK. Declarations, bundles and the
// store build path must reject every tampered, mismatched or overriding SDK
// before an immutable dependency object can be published.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {
    MCP_SDK_BUNDLE_METADATA_NAME,
    createMcpSdkBundleMetadata,
    readMcpSdkRepositoryFromLock,
    validateMcpSdkBundle,
} from '../../ploinky-box/mcp-sdk-bundle.mjs';
import {
    activeBoxMcpSdkBundle,
    boxMcpSdkCacheProblem,
    boxMcpSdkStampSection,
    finalizeBoxMcpSdkCache,
    installWithBoxMcpSdk,
    needsNpmInstall,
    withoutBoxMcpSdk,
} from '../../ploinky-box/agent-dependencies/mcp-sdk.mjs';
import { mergePackageJson } from '../../cli/utils/dependencies/dependencyInstaller.js';
import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { buildAgentInstallPlan } from '../../cli/utils/dependencies/store/installContract.mjs';
import { containerProvider, fakeLease, makeAgentLib } from './dependencyStoreFixtures.mjs';

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'box-sdk-cache-test-'));
const lockPath = new URL('../../ploinky-box/dependencies.lock.json', import.meta.url);
const repository = readMcpSdkRepositoryFromLock({ lockPath });
const IMAGE = `sha256:${'a'.repeat(64)}`;
const AGENTLIB_LINK = '/opt/ploinky-agentlib';
const SDK_DECLARATION = 'git+https://github.com/AssistOS-AI/MCPSDK.git#main';
const GLOBAL = Object.freeze({ name: 'ploinky-global-deps', version: '1.0.0', dependencies: { 'mcp-sdk': SDK_DECLARATION } });
const CONSUMER = Object.freeze({ kind: 'test-consumer', process: { pid: 1, processStart: 'x', bootScope: 'y' } });

test.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

function fixture(t) {
    const root = fs.mkdtempSync(path.join(workspace, 'fixture-'));
    const sourceRoot = path.join(root, 'image-sdk');
    fs.mkdirSync(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
        name: '@modelcontextprotocol/sdk', version: '1.19.1', type: 'module',
    }));
    fs.writeFileSync(path.join(sourceRoot, 'index.js'), 'export const bundled = true;\n');
    const metadata = createMcpSdkBundleMetadata({ sourceRoot, repository });
    fs.writeFileSync(path.join(sourceRoot, MCP_SDK_BUNDLE_METADATA_NAME), JSON.stringify(metadata));
    const bundle = validateMcpSdkBundle({ sourceRoot, expectedRepository: repository });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, sourceRoot, bundle };
}

/** A Box workspace whose dependency store builds with the validated image SDK. */
function boxStore(t) {
    const f = fixture(t);
    const agentLib = makeAgentLib(f.root);
    const provider = containerProvider({ imageId: IMAGE, sdkBundle: f.bundle, agentLib });
    const { lease, assertLease } = fakeLease();
    fs.mkdirSync(path.join(f.root, 'ws'));
    const store = createCacheStore({
        depsDir: path.join(f.root, 'ws', '.ploinky', 'deps'),
        workspaceRoot: path.join(f.root, 'ws'),
        assertLease,
        checkDiskSpace: () => ({ ok: true, availableBytes: 1e12 }),
    });
    const plan = (manifest, registration = 'repo/agent') => buildAgentInstallPlan({
        provider,
        globalPackage: GLOBAL,
        agentPackage: manifest ? { selection: 'code', relativePath: `${registration}/code/package.json`, sha256: 'f'.repeat(64), manifest } : null,
        registration,
        sdkBundle: f.bundle,
        agentLibSelection: agentLib,
    });
    return { ...f, agentLib, provider, lease, store, plan };
}

/**
 * npm as the container installer runs it inside a Box: the SDK arrives only as
 * the prepared local link, and npm prunes it (it is not a real dependency of
 * the restored manifest). `during` runs after the install, before finalization.
 */
function boxNpm({ during = null, extra = null } = {}) {
    const calls = [];
    return {
        kind: 'box-npm',
        calls,
        describe() { return { kind: 'box-npm' }; },
        install({ payloadDir, options }) {
            const pkg = JSON.parse(fs.readFileSync(path.join(payloadDir, 'package.json'), 'utf8'));
            calls.push({ pkg, options });
            assert.equal(pkg.dependencies['mcp-sdk'], 'file:.ploinky-provided/node_modules/mcp-sdk');
            assert.equal(pkg.overrides['mcp-sdk'], '$mcp-sdk');
            assert.equal(options.linkBoxMcpSdk, true);
            for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
                assert.equal(Object.hasOwn(pkg[field] || {}, 'mcp-sdk'), false, `npm input still contains SDK in ${field}`);
            }
            const nodeModules = path.join(payloadDir, 'node_modules');
            const lock = { name: pkg.name || 'x', lockfileVersion: 3, requires: true, packages: {} };
            for (const [name] of Object.entries(pkg.dependencies)) {
                if (['mcp-sdk', 'achillesAgentLib', 'ploinky-agent-lib'].includes(name)) continue;
                fs.mkdirSync(path.join(nodeModules, name), { recursive: true });
                fs.writeFileSync(path.join(nodeModules, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
                lock.packages[`node_modules/${name}`] = { version: '1.0.0', resolved: `https://registry.example/${name}/-/${name}-1.0.0.tgz` };
            }
            fs.writeFileSync(path.join(nodeModules, '.package-lock.json'), JSON.stringify(lock, null, 2));
            fs.rmSync(path.join(nodeModules, 'mcp-sdk'), { recursive: true, force: true });
            if (extra) extra(payloadDir);
            if (during) during(payloadDir);
        },
    };
}

function publishedObjects(store) {
    let names = [];
    try { names = fs.readdirSync(store.paths.objects); } catch { return []; }
    return names.filter((name) => fs.existsSync(path.join(store.paths.objects, name, 'complete.json')));
}

test('canonical #main and exact-commit SDK declarations are excluded from every npm dependency field', (t) => {
    const { bundle } = fixture(t);
    for (const spec of [
        'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
        'github:AssistOS-AI/MCPSDK#main',
        'AssistOS-AI/MCPSDK#main',
        'git+ssh://git@github.com/AssistOS-AI/MCPSDK.git#main',
        `${repository.url}#${repository.commit}`,
    ]) {
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
            const pkg = { [field]: { 'mcp-sdk': spec, example: '1.0.0' } };
            const normalized = withoutBoxMcpSdk(pkg, { bundle });
            assert.deepEqual(normalized[field], { example: '1.0.0' });
            assert.equal(pkg[field]['mcp-sdk'], spec, 'input manifests must not be mutated');
        }
    }
});

test('conflicting SDK refs, local copies, aliases and nested overrides fail closed', (t) => {
    const { bundle } = fixture(t);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const spec of ['github:AssistOS-AI/MCPSDK#other', 'file:../sdk', '^1.0.0', 'github:other/MCPSDK#main']) {
            assert.throws(() => withoutBoxMcpSdk({ [field]: { 'mcp-sdk': spec } }, { bundle }), /overrides 'mcp-sdk'/);
        }
        assert.throws(() => withoutBoxMcpSdk({ [field]: { alias: 'github:AssistOS-AI/MCPSDK#main' } }, { bundle }), /duplicate dependency/);
        assert.throws(() => withoutBoxMcpSdk({ [field]: { alias: 'npm:mcp-sdk@1' } }, { bundle }), /duplicate dependency/);
    }
    for (const overrides of [
        { 'mcp-sdk': repository.url },
        { outer: { 'mcp-sdk@1': '2' } },
        { alias: 'github:AssistOS-AI/MCPSDK#main' },
        { outer: { '.': '$mcp-sdk' } },
    ]) {
        assert.throws(() => withoutBoxMcpSdk({ overrides }, { bundle }), /remove the override/);
    }
});

test('missing, mismatched and tampered image bundles cannot become an SDK source', (t) => {
    const f = fixture(t);
    assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: path.join(f.root, 'missing'), lockPath }), /missing/);
    const otherLock = path.join(f.root, 'other-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.repositories['mcp-sdk'].commit = 'a'.repeat(40);
    fs.writeFileSync(otherLock, JSON.stringify(lock));
    assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: f.sourceRoot, lockPath: otherLock }), /does not match.*lock/);
    fs.writeFileSync(path.join(f.sourceRoot, 'index.js'), 'tampered\n');
    assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: f.sourceRoot, lockPath }), /fingerprint/);
});

test('offline npm lifecycle imports use the image SDK even through a transitive Git dependency', (t) => {
    const { root, bundle } = fixture(t);
    const cachePath = path.join(root, 'cache');
    const tarRoot = path.join(root, 'consumer');
    const consumer = path.join(tarRoot, 'package');
    fs.mkdirSync(consumer, { recursive: true });
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
        name: 'offline-consumer', version: '1.0.0', main: 'index.cjs',
        dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#main' },
    }));
    fs.writeFileSync(path.join(consumer, 'index.cjs'), "module.exports = require.resolve('mcp-sdk');\n");
    const archive = path.join(root, 'consumer.tgz');
    const packed = childProcess.spawnSync('tar', ['-czf', archive, '-C', tarRoot, 'package'], { encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const script = "node -e \"require('offline-consumer'); import('mcp-sdk').then(m => { if (!m.bundled) process.exit(1) })\"";
    const pkg = {
        name: 'offline-lifecycle', version: '1.0.0',
        dependencies: { 'offline-consumer': `file:${archive}` },
        scripts: { postinstall: script },
    };
    fs.mkdirSync(cachePath);
    fs.writeFileSync(path.join(cachePath, 'package.json'), JSON.stringify(pkg));
    const bin = path.join(root, 'bin');
    const gitInvoked = path.join(root, 'git-invoked');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nprintf forbidden > "$SDK_TEST_GIT_LOG"\nexit 99\n', { mode: 0o755 });
    installWithBoxMcpSdk(cachePath, pkg, bundle, (cwd, options) => {
        assert.equal(options.linkBoxMcpSdk, true);
        const result = childProcess.spawnSync('npm', [
            'install', '--offline', '--no-package-lock', '--no-audit', '--no-fund', '--install-links=false',
        ], {
            cwd, encoding: 'utf8', timeout: 30000,
            env: {
                ...process.env,
                PATH: `${bin}${path.delimiter}${process.env.PATH}`,
                SDK_TEST_GIT_LOG: gitInvoked,
                npm_config_cache: path.join(root, 'empty-npm-cache'),
            },
        });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, /postinstall/);
        assert.equal(fs.lstatSync(path.join(cwd, 'node_modules', 'mcp-sdk')).isSymbolicLink(), true, 'npm consumes a prepared local link');
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cachePath, 'package.json'), 'utf8')), pkg);
    assert.equal(fs.existsSync(gitInvoked), false, 'even a transitive Git declaration must use the supplied local SDK');
    assert.equal(fs.existsSync(path.join(cachePath, '.ploinky-provided')), false);
    assert.equal(fs.lstatSync(path.join(cachePath, 'node_modules', 'mcp-sdk')).isSymbolicLink(), false);
    const runtime = childProcess.spawnSync(process.execPath, ['-e', "require('offline-consumer'); import('mcp-sdk').then(m => { if (!m.bundled) process.exit(1) })"], { cwd: cachePath, encoding: 'utf8' });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.equal(boxMcpSdkCacheProblem(cachePath, { mcpSdk: boxMcpSdkStampSection(bundle) }, bundle), '');
});

test('finalization rejects a different self-consistent package pretending to be the image SDK', (t) => {
    const { root, sourceRoot, bundle } = fixture(t);
    const cachePath = path.join(root, 'cache');
    finalizeBoxMcpSdkCache(cachePath, bundle);
    const installedRoot = path.join(cachePath, 'node_modules', 'mcp-sdk');
    fs.writeFileSync(path.join(installedRoot, 'index.js'), 'different bytes\n');
    fs.writeFileSync(path.join(installedRoot, MCP_SDK_BUNDLE_METADATA_NAME), JSON.stringify(
        createMcpSdkBundleMetadata({ sourceRoot: installedRoot, repository }),
    ));
    assert.match(boxMcpSdkCacheProblem(cachePath, { mcpSdk: boxMcpSdkStampSection(bundle) }, bundle), /does not match/);
    finalizeBoxMcpSdkCache(cachePath, bundle);
    assert.equal(boxMcpSdkCacheProblem(cachePath, { mcpSdk: boxMcpSdkStampSection(bundle) }, bundle), '');
    assert.equal(validateMcpSdkBundle({ sourceRoot }).contentSha256, bundle.contentSha256);
});

test('Box SDK store build: an SDK-only agent publishes the validated image SDK without an installer run', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    for (const [registration, manifest] of [
        ['plain', null],
        ['test-script', { scripts: { test: 'node --test' } }],
        ['sdk-declaration', { dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#main' } }],
    ]) {
        const plan = w.plan(manifest, registration);
        assert.equal(plan.npmRequired, false);
        assert.equal(plan.installManifest.dependencies?.['mcp-sdk'], undefined, 'the bundled SDK never reaches npm or pins');
        const built = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
        assert.equal(built.status, 'built');
        assert.equal(boxMcpSdkCacheProblem(built.payloadPath, { mcpSdk: boxMcpSdkStampSection(w.bundle) }, w.bundle), '');
        assert.equal(w.store.validateObject(built.objectId, { inputKey: plan.inputKey }).valid, true);
    }
    assert.equal(installer.calls.length, 0);
});

test('Box SDK store build: other dependencies install through the provided SDK link and the image SDK is restored after npm pruning', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const plan = w.plan({
        dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#main', example: '1.0.0' },
        scripts: { postinstall: 'node setup.js' },
    });
    assert.equal(plan.npmRequired, true);
    const built = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    assert.equal(installer.calls.length, 1);
    assert.deepEqual(installer.calls[0].pkg.dependencies, {
        example: '1.0.0', 'mcp-sdk': 'file:.ploinky-provided/node_modules/mcp-sdk',
        achillesAgentLib: `file:${AGENTLIB_LINK}`,
        'ploinky-agent-lib': `file:${AGENTLIB_LINK}`,
    });
    assert.equal(installer.calls[0].pkg.scripts.postinstall, 'node setup.js');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(built.payloadPath, 'package.json'), 'utf8')).dependencies, { example: '1.0.0' });
    assert.equal(fs.existsSync(path.join(built.payloadPath, '.ploinky-provided')), false);
    assert.equal(fs.lstatSync(path.join(built.nodeModulesPath, 'mcp-sdk')).isDirectory(), true, 'a self-contained copy, not a link');
    assert.equal(boxMcpSdkCacheProblem(built.payloadPath, { mcpSdk: boxMcpSdkStampSection(w.bundle) }, w.bundle), '');
    assert.equal(validateMcpSdkBundle({ sourceRoot: w.sourceRoot }).contentSha256, w.bundle.contentSha256, 'the image bundle is never changed');
});

test('Box SDK store build: npm lifecycle scripts run even when no npm dependencies remain', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const plan = w.plan({ scripts: { prepare: 'node build.js' } });
    assert.equal(plan.npmRequired, true);
    const built = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    assert.equal(installer.calls.length, 1);
    assert.equal(installer.calls[0].pkg.scripts.prepare, 'node build.js');
    assert.equal(boxMcpSdkCacheProblem(built.payloadPath, { mcpSdk: boxMcpSdkStampSection(w.bundle) }, w.bundle), '');
});

test('Box SDK store build: an agent override of the image SDK is rejected before any install', (t) => {
    const w = boxStore(t);
    for (const field of ['dependencies', 'optionalDependencies']) {
        assert.throws(() => w.plan({ [field]: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#other' } }), /overrides 'mcp-sdk'/);
    }
    assert.throws(() => w.plan({ overrides: { 'mcp-sdk': repository.url } }), /remove the override/);
    assert.deepEqual(publishedObjects(w.store), []);
});

test('Box SDK store build: an image bundle tampered after planning never reaches npm or publication', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const withNpm = w.plan({ dependencies: { example: '1.0.0' } });
    const sdkOnly = w.plan(null, 'repo/sdk-only');
    fs.writeFileSync(path.join(w.sourceRoot, 'index.js'), 'tampered\n');
    assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: w.sourceRoot, lockPath }), /fingerprint/,
        'planning a new command rejects the tampered image bundle');
    for (const plan of [withNpm, sdkOnly]) {
        assert.throws(() => w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER }),
            (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED' && /fingerprint/.test(error.message));
        assert.equal(w.store.readIndex(plan.inputKey), null);
    }
    assert.equal(installer.calls.length, 0);
    assert.deepEqual(publishedObjects(w.store), []);
});

test('Box SDK store build: an image bundle changed while npm runs fails before a completion marker', (t) => {
    const w = boxStore(t);
    const installer = boxNpm({ during: () => fs.writeFileSync(path.join(w.sourceRoot, 'index.js'), 'changed during npm\n') });
    const plan = w.plan({ dependencies: { example: '1.0.0' } });
    assert.throws(() => w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER }),
        (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED' && /MCP SDK image bundle changed|fingerprint/.test(error.message));
    assert.equal(installer.calls.length, 1, 'the retry rejects the changed bundle before npm');
    assert.equal(w.store.readIndex(plan.inputKey), null);
    assert.deepEqual(publishedObjects(w.store), []);
});

test('Box SDK store admission: altered SDK bytes in a published payload are rejected and rebuilt beside the untouched object', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const plan = w.plan({ dependencies: { example: '1.0.0' } });
    const first = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    const copied = path.join(first.nodeModulesPath, 'mcp-sdk', 'index.js');
    fs.chmodSync(copied, 0o644);
    fs.writeFileSync(copied, 'altered\n');
    assert.deepEqual(w.store.validateObject(first.objectId, { inputKey: plan.inputKey }),
        { valid: false, reason: 'installed tree hash mismatch' });
    assert.match(boxMcpSdkCacheProblem(first.payloadPath, { mcpSdk: boxMcpSdkStampSection(w.bundle) }, w.bundle), /fingerprint|does not match/);
    const second = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    assert.equal(second.status, 'repaired');
    assert.notEqual(second.objectId, first.objectId);
    assert.deepEqual(second.corruption, { objectId: first.objectId, reason: 'installed tree hash mismatch' });
    assert.equal(fs.readFileSync(copied, 'utf8'), 'altered\n', 'the rejected object is never repaired in place');
    assert.equal(boxMcpSdkCacheProblem(second.payloadPath, { mcpSdk: boxMcpSdkStampSection(w.bundle) }, w.bundle), '');
});

test('Box SDK store build: hoisted and nested AgentLib copies become the selected link; an escaping link publishes nothing', (t) => {
    const w = boxStore(t);
    const relativeCopies = ['ploinky-agent-lib', '@vendor/consumer/node_modules/ploinky-agent-lib'];
    const installer = boxNpm({
        extra(payloadDir) {
            for (const relative of relativeCopies) {
                const directory = path.join(payloadDir, 'node_modules', relative);
                fs.mkdirSync(directory, { recursive: true });
                fs.writeFileSync(path.join(directory, 'package.json'), '{"name":"ploinky-agent-lib"}');
                fs.writeFileSync(path.join(directory, 'private-copy'), 'must be removed');
            }
        },
    });
    const plan = w.plan({ dependencies: { consumer: '1.0.0' } });
    const built = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    for (const relative of relativeCopies) {
        const directory = path.join(built.nodeModulesPath, relative);
        assert.equal(fs.lstatSync(directory).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(directory), AGENTLIB_LINK);
    }
    const outside = path.join(w.root, 'external-package');
    fs.mkdirSync(path.join(outside, 'node_modules', 'ploinky-agent-lib'), { recursive: true });
    const escaping = boxNpm({ extra: (payloadDir) => fs.symlinkSync(outside, path.join(payloadDir, 'node_modules', 'external-package')) });
    const unsafe = w.plan({ dependencies: { other: '1.0.0' } }, 'repo/unsafe');
    assert.throws(() => w.store.ensureGeneration(w.lease, unsafe, { installer: escaping, consumer: CONSUMER }),
        (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED');
    assert.equal(w.store.readIndex(unsafe.inputKey), null);
    assert.deepEqual(publishedObjects(w.store), [built.objectId]);
});

test('non-Box manifests keep their Git SDK dependency and no image bundle is selected', () => {
    const pkg = { dependencies: { 'mcp-sdk': 'github:someone/alternate-sdk#branch' } };
    assert.equal(withoutBoxMcpSdk(pkg, { bundle: null }), pkg);
    assert.equal(mergePackageJson({}, pkg).dependencies['mcp-sdk'], pkg.dependencies['mcp-sdk']);
    assert.equal(activeBoxMcpSdkBundle({ insideBox: false, sourceRoot: '/missing', lockPath: '/missing' }), null);
    assert.equal(needsNpmInstall({ scripts: { test: 'node --test' } }), false);
    assert.equal(needsNpmInstall({ scripts: { prepare: 'node build.js' } }), true, 'npm lifecycle scripts still require npm');
});
