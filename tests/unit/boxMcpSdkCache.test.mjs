// The Box image supplies the one MCP SDK. Declarations, the supplied package
// and the store build path must reject every missing, mismatched or overriding
// SDK before an immutable dependency object can be published. The SDK is
// identified by the outer Box image that carries it: it is checked as a
// package and never hashed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { BOX_IMAGE_ID_ENV } from '../../agentlib/contract.mjs';
import { MCP_SDK_BUNDLE_METADATA_NAME, MCP_SDK_REPOSITORY_URL } from '../../ploinky-box/mcp-sdk-bundle.mjs';
import {
    PROVIDED_LIBRARIES_RECORD_NAME,
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
import { buildAgentInstallPlan, buildSeedInstallPlan } from '../../cli/utils/dependencies/store/installContract.mjs';
import {
    NESTED_IMAGE_ID,
    OUTER_IMAGE_ID,
    containerProvider,
    fakeLease,
    makeAgentLib,
    makeImageAgentLib,
    makeImageSdk,
} from './dependencyStoreFixtures.mjs';

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'box-sdk-cache-test-'));
const OTHER_OUTER_IMAGE = `sha256:${'d4'.repeat(32)}`;
const AGENTLIB_LINK = '/opt/ploinky-agentlib';
const SDK_DECLARATION = 'git+https://github.com/AssistOS-AI/MCPSDK.git#main';
const GLOBAL = Object.freeze({ name: 'ploinky-global-deps', version: '1.0.0', dependencies: { 'mcp-sdk': SDK_DECLARATION } });
const CONSUMER = Object.freeze({ kind: 'test-consumer', process: { pid: 1, processStart: 'x', bootScope: 'y' } });

test.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

function fixture(t, imageId = OUTER_IMAGE_ID) {
    const root = fs.mkdtempSync(path.join(workspace, 'fixture-'));
    const bundle = makeImageSdk(root, { supplyingImageId: imageId });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, sourceRoot: bundle.sourceRoot, bundle };
}

/**
 * A Box workspace whose dependency store builds with the supplied SDK. The
 * nested agent toolchain image differs from the outer Box image that supplies
 * the SDK, so confusing the two identities fails.
 */
function boxStore(t, { agentLibKind = 'local', imageId = OUTER_IMAGE_ID } = {}) {
    const f = fixture(t, imageId);
    const agentLib = agentLibKind === 'image' ? makeImageAgentLib(f.root, { supplyingImageId: imageId }) : makeAgentLib(f.root);
    const provider = containerProvider({ imageId: NESTED_IMAGE_ID, sdkBundle: f.bundle, agentLib });
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

/** Run `fn` while recording every file body read under an installed SDK subtree. */
function recordSdkBodyReads(fn) {
    const originalRead = fs.readFileSync;
    const reads = [];
    fs.readFileSync = function patched(file, ...rest) {
        const name = String(file);
        if (/[\\/]node_modules[\\/]mcp-sdk[\\/]/.test(name) && path.basename(name) !== 'package.json') reads.push(name);
        return originalRead.call(this, file, ...rest);
    };
    try {
        return { value: fn(), reads };
    } finally {
        fs.readFileSync = originalRead;
    }
}

test('a direct mcp-sdk declaration is removed whatever its ref, in every npm dependency field', (t) => {
    const { bundle } = fixture(t);
    for (const spec of [
        'git+https://github.com/AssistOS-AI/MCPSDK.git#main',
        'github:AssistOS-AI/MCPSDK#main',
        'AssistOS-AI/MCPSDK#main',
        'git+ssh://git@github.com/AssistOS-AI/MCPSDK.git#main',
        `${MCP_SDK_REPOSITORY_URL}#${'a'.repeat(40)}`,
        'github:AssistOS-AI/MCPSDK#other',
        'github:AssistOS-AI/MCPSDK#v1.2.3',
        'file:../sdk',
        '^1.0.0',
        '1.19.1',
        'github:other/MCPSDK#main',
    ]) {
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
            const pkg = { [field]: { 'mcp-sdk': spec, example: '1.0.0' } };
            const normalized = withoutBoxMcpSdk(pkg, { bundle });
            assert.deepEqual(normalized[field], { example: '1.0.0' }, `${field} ${spec}`);
            assert.equal(pkg[field]['mcp-sdk'], spec, 'input manifests must not be mutated');
        }
    }
    const meta = withoutBoxMcpSdk({
        bundledDependencies: ['mcp-sdk', 'other'], bundleDependencies: ['mcp-sdk'],
        peerDependenciesMeta: { 'mcp-sdk': { optional: true }, other: { optional: true } },
    }, { bundle });
    assert.deepEqual(meta.bundledDependencies, ['other']);
    assert.deepEqual(meta.bundleDependencies, []);
    assert.deepEqual(meta.peerDependenciesMeta, { other: { optional: true } });
});

test('aliases and overrides that would duplicate the supplied SDK fail as duplicate-source errors', (t) => {
    const { bundle } = fixture(t);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        assert.throws(() => withoutBoxMcpSdk({ [field]: { alias: 'github:AssistOS-AI/MCPSDK#main' } }, { bundle }), /duplicate dependency/);
        assert.throws(() => withoutBoxMcpSdk({ [field]: { alias: 'npm:mcp-sdk@1' } }, { bundle }), /duplicate dependency/);
    }
    for (const overrides of [
        { 'mcp-sdk': MCP_SDK_REPOSITORY_URL },
        { outer: { 'mcp-sdk@1': '2' } },
        { alias: 'github:AssistOS-AI/MCPSDK#main' },
        { outer: { '.': '$mcp-sdk' } },
    ]) {
        assert.throws(() => withoutBoxMcpSdk({ overrides }, { bundle }), /remove the override/);
    }
});

test('the upstream registry package keeps its ordinary npm semantics', (t) => {
    const { bundle } = fixture(t);
    const pkg = {
        dependencies: { '@modelcontextprotocol/sdk': '^1.0.0', upstream: 'npm:@modelcontextprotocol/sdk@1', example: '1.0.0' },
        overrides: { '@modelcontextprotocol/sdk': '1.19.1' },
    };
    assert.deepEqual(withoutBoxMcpSdk(pkg, { bundle }), pkg,
        'a dependency on the upstream package is neither removed nor rejected');
});

test('a missing, wrong or unidentified supplied SDK cannot become the SDK source', (t) => {
    const f = fixture(t);
    const env = { [BOX_IMAGE_ID_ENV]: OUTER_IMAGE_ID };
    assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: path.join(f.root, 'missing'), env }), /missing/);
    fs.writeFileSync(path.join(f.sourceRoot, 'package.json'), JSON.stringify({ name: 'other', version: '1' }));
    assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: f.sourceRoot, env }), /must contain @modelcontextprotocol\/sdk/);
    const fresh = fixture(t);
    for (const [label, badEnv] of Object.entries({
        'a missing Box image ID': {},
        'a mutable reference': { [BOX_IMAGE_ID_ENV]: 'docker.io/assistos/ploinky-box:latest' },
        'a bare hex ID': { [BOX_IMAGE_ID_ENV]: 'b2'.repeat(32) },
    })) {
        assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: fresh.sourceRoot, env: badEnv }),
            { code: 'PLOINKY_AGENTLIB_IMAGE_INVALID' }, label);
    }
});

test('the active SDK is identified by the outer Box image, carries optional provenance and hashes nothing', (t) => {
    const f = fixture(t);
    const env = { [BOX_IMAGE_ID_ENV]: OUTER_IMAGE_ID };
    const reads = [];
    const original = fs.readFileSync;
    fs.readFileSync = function patched(file, ...rest) { reads.push(path.basename(String(file))); return original.call(this, file, ...rest); };
    let bundle;
    try { bundle = activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: f.sourceRoot, env }); } finally { fs.readFileSync = original; }
    assert.deepEqual(bundle.identity, { kind: 'image', library: 'mcp-sdk', supplyingImageId: OUTER_IMAGE_ID });
    assert.deepEqual(boxMcpSdkStampSection(bundle), bundle.identity);
    assert.equal(bundle.packageName, '@modelcontextprotocol/sdk');
    assert.deepEqual(bundle.provenance, { repository: null, branch: null, commit: null, packageVersion: null });
    assert.ok(reads.every((name) => ['package.json', MCP_SDK_BUNDLE_METADATA_NAME].includes(name)), `read ${reads.join(', ')}`);
    assert.equal(activeBoxMcpSdkBundle({ insideBox: false, sourceRoot: '/missing', env: {} }), null);
});

test('offline npm lifecycle imports use the supplied SDK even through a transitive Git dependency', (t) => {
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
    assert.equal(boxMcpSdkCacheProblem(cachePath, bundle), '');
});

test('finalization writes the completion record last and refreshes only when it names another image', (t) => {
    const { root, bundle } = fixture(t);
    const cachePath = path.join(root, 'cache');
    const recordPath = path.join(cachePath, PROVIDED_LIBRARIES_RECORD_NAME);
    const installedRoot = path.join(cachePath, 'node_modules', 'mcp-sdk');
    assert.match(boxMcpSdkCacheProblem(cachePath, bundle), /completion record is missing/);
    finalizeBoxMcpSdkCache(cachePath, bundle);
    assert.equal(boxMcpSdkCacheProblem(cachePath, bundle), '');
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath, 'utf8')), {
        schema: 'ploinky.provided-libraries/v1',
        providedLibraries: { 'mcp-sdk': bundle.identity },
    });

    // Same supplying image: nothing is recopied, even for a same-shape edit.
    fs.writeFileSync(path.join(installedRoot, 'index.js'), 'export const bundled = "edited but functional";\n');
    finalizeBoxMcpSdkCache(cachePath, bundle);
    assert.equal(fs.readFileSync(path.join(installedRoot, 'index.js'), 'utf8'), 'export const bundled = "edited but functional";\n');

    // A copy whose record names another image is replaced.
    const other = { ...bundle, identity: { ...bundle.identity, supplyingImageId: OTHER_OUTER_IMAGE } };
    assert.match(boxMcpSdkCacheProblem(cachePath, other), /names another supplying image/);
    finalizeBoxMcpSdkCache(cachePath, other);
    assert.equal(boxMcpSdkCacheProblem(cachePath, other), '');
    assert.equal(fs.readFileSync(path.join(installedRoot, 'index.js'), 'utf8'), 'export const bundled = true;\n');

    // A damaged copy or a missing record is a miss.
    fs.rmSync(path.join(installedRoot, 'index.js'));
    assert.match(boxMcpSdkCacheProblem(cachePath, other), /cache is invalid/);
    finalizeBoxMcpSdkCache(cachePath, other);
    assert.equal(boxMcpSdkCacheProblem(cachePath, other), '');
    fs.rmSync(recordPath);
    assert.match(boxMcpSdkCacheProblem(cachePath, other), /completion record is missing/);
    finalizeBoxMcpSdkCache(cachePath, other);
    assert.equal(boxMcpSdkCacheProblem(cachePath, other), '');
    // A record of any other shape never matches.
    fs.writeFileSync(recordPath, JSON.stringify({ schema: 'ploinky.box.mcp-sdk/v1', contentSha256: 'c'.repeat(64) }));
    assert.match(boxMcpSdkCacheProblem(cachePath, other), /completion record is missing/);
});

test('an unusable supplied SDK and an unusable copy are never admitted', (t) => {
    const { root, sourceRoot, bundle } = fixture(t);
    const cachePath = path.join(root, 'cache');
    fs.rmSync(path.join(sourceRoot, 'index.js'));
    assert.throws(() => finalizeBoxMcpSdkCache(cachePath, bundle), /supplied by the Box image is unusable/);
    assert.equal(fs.existsSync(path.join(cachePath, 'node_modules', 'mcp-sdk')), false);
    // A symlink inside the supplied package is refused when it is copied.
    fs.writeFileSync(path.join(sourceRoot, 'index.js'), 'export const bundled = true;\n');
    fs.symlinkSync('index.js', path.join(sourceRoot, 'linked.js'));
    assert.throws(() => finalizeBoxMcpSdkCache(cachePath, bundle), /not a usable package/);
    assert.equal(fs.existsSync(path.join(cachePath, 'node_modules', 'mcp-sdk')), false);
    assert.equal(fs.existsSync(path.join(cachePath, PROVIDED_LIBRARIES_RECORD_NAME)), false);
    assert.deepEqual(fs.readdirSync(path.join(cachePath, 'node_modules')), [], 'no staging litter');
});

test('a failed swap or completion write restores the previous copy and its record', (t) => {
    for (const failAt of ['swap', 'record']) {
        const { root, bundle } = fixture(t);
        const cachePath = path.join(root, `cache-${failAt}`);
        finalizeBoxMcpSdkCache(cachePath, bundle);
        const installedRoot = path.join(cachePath, 'node_modules', 'mcp-sdk');
        fs.writeFileSync(path.join(installedRoot, 'prior-marker'), 'prior');
        const other = { ...bundle, identity: { ...bundle.identity, supplyingImageId: OTHER_OUTER_IMAGE } };

        const originalRename = fs.renameSync;
        const originalWrite = fs.writeFileSync;
        fs.renameSync = function patched(source, destination) {
            if (failAt === 'swap' && String(source).endsWith('.tmp') && String(destination) === installedRoot) {
                throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
            }
            return originalRename.call(this, source, destination);
        };
        fs.writeFileSync = function patched(file, data, ...rest) {
            if (failAt === 'record' && String(file).includes(PROVIDED_LIBRARIES_RECORD_NAME) && String(file).endsWith('.tmp')) {
                throw Object.assign(new Error('simulated record write failure'), { code: 'EIO' });
            }
            return originalWrite.call(this, file, data, ...rest);
        };
        try {
            assert.throws(() => finalizeBoxMcpSdkCache(cachePath, other), /simulated/);
        } finally {
            fs.renameSync = originalRename;
            fs.writeFileSync = originalWrite;
        }
        assert.equal(fs.readFileSync(path.join(installedRoot, 'prior-marker'), 'utf8'), 'prior', `${failAt}: the prior copy survives`);
        assert.equal(boxMcpSdkCacheProblem(cachePath, bundle), '', `${failAt}: the prior record is restored`);
        assert.equal(boxMcpSdkCacheProblem(cachePath, other) === '', false, `${failAt}: nothing claims the other image`);
        assert.deepEqual(fs.readdirSync(path.join(cachePath, 'node_modules')), ['mcp-sdk'], `${failAt}: no litter`);
    }
});

test('Box SDK store build: an SDK-only agent publishes the supplied SDK without an installer run', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    for (const [registration, manifest] of [
        ['plain', null],
        ['test-script', { scripts: { test: 'node --test' } }],
        ['sdk-declaration', { dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#main' } }],
        ['other-ref', { dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#some-branch' } }],
    ]) {
        const plan = w.plan(manifest, registration);
        assert.equal(plan.npmRequired, false);
        assert.equal(plan.installManifest.dependencies?.['mcp-sdk'], undefined, 'the supplied SDK never reaches npm or pins');
        const built = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
        assert.equal(built.status, 'built');
        assert.equal(boxMcpSdkCacheProblem(built.payloadPath, w.bundle), '');
        assert.equal(w.store.validateObject(built.objectId, { inputKey: plan.inputKey }).valid, true);
    }
    assert.equal(installer.calls.length, 0);
});

test('Box SDK store build: other dependencies install through the provided SDK link and the SDK is restored after npm pruning', (t) => {
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
    assert.equal(boxMcpSdkCacheProblem(built.payloadPath, w.bundle), '');
    assert.equal(fs.readFileSync(path.join(w.sourceRoot, 'index.js'), 'utf8'), 'export const bundled = true;\n', 'the supplied package is never changed');
});

test('Box SDK store build: npm lifecycle scripts run even when no npm dependencies remain', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const plan = w.plan({ scripts: { prepare: 'node build.js' } });
    assert.equal(plan.npmRequired, true);
    const built = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    assert.equal(installer.calls.length, 1);
    assert.equal(installer.calls[0].pkg.scripts.prepare, 'node build.js');
    assert.equal(boxMcpSdkCacheProblem(built.payloadPath, w.bundle), '');
});

test('Box SDK store build: an alias or override of the supplied SDK is rejected before any install', (t) => {
    const w = boxStore(t);
    assert.throws(() => w.plan({ dependencies: { alias: 'github:AssistOS-AI/MCPSDK#other' } }), /duplicate dependency/);
    assert.throws(() => w.plan({ optionalDependencies: { alias: 'npm:mcp-sdk@1' } }), /duplicate dependency/);
    assert.throws(() => w.plan({ overrides: { 'mcp-sdk': MCP_SDK_REPOSITORY_URL } }), /remove the override/);
    assert.deepEqual(publishedObjects(w.store), []);
});

test('Box SDK store build: the SDK and Achilles provider keys follow the outer image, never the nested toolchain', (t) => {
    const local = boxStore(t);
    const image = boxStore(t, { agentLibKind: 'image' });
    const otherOuter = boxStore(t, { imageId: OTHER_OUTER_IMAGE });
    const manifest = { dependencies: { example: '1.0.0' } };
    const localPlan = local.plan(manifest);
    const imagePlan = image.plan(manifest);
    const otherPlan = otherOuter.plan(manifest);

    assert.deepEqual(localPlan.contract.providers.mcpSdk, { kind: 'image', library: 'mcp-sdk', supplyingImageId: OUTER_IMAGE_ID });
    assert.equal(localPlan.contract.toolchain.imageId, NESTED_IMAGE_ID, 'the nested toolchain identity is separate');
    assert.equal(localPlan.contract.providers.agentLib.mode, 'local');
    assert.ok(localPlan.contract.providers.agentLib.fingerprint);
    assert.equal(Object.hasOwn(localPlan.contract.providers.agentLib, 'supplyingImageId'), false);

    assert.equal(imagePlan.contract.providers.agentLib.mode, 'image');
    assert.equal(imagePlan.contract.providers.agentLib.supplyingImageId, OUTER_IMAGE_ID);
    assert.equal(imagePlan.contract.providers.agentLib.library, 'achillesAgentLib');
    assert.equal(Object.hasOwn(imagePlan.contract.providers.agentLib, 'fingerprint'), false);
    assert.equal(Object.hasOwn(imagePlan.contract.providers.agentLib, 'commit'), false);

    // Local Achilles with the image SDK still keys the SDK by the outer image.
    assert.notEqual(localPlan.inputKey, otherPlan.inputKey);
    assert.deepEqual(otherPlan.contract.providers.mcpSdk.supplyingImageId, OTHER_OUTER_IMAGE);
    assert.notEqual(imagePlan.inputKey, otherPlan.inputKey);
    assert.notEqual(localPlan.inputKey, imagePlan.inputKey);
});

test('Box SDK store build: a supplied SDK that becomes unusable never reaches npm or publication', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const withNpm = w.plan({ dependencies: { example: '1.0.0' } });
    const sdkOnly = w.plan(null, 'repo/sdk-only');
    fs.rmSync(path.join(w.sourceRoot, 'index.js'));
    assert.throws(() => activeBoxMcpSdkBundle({ insideBox: true, sourceRoot: w.sourceRoot, env: { [BOX_IMAGE_ID_ENV]: OUTER_IMAGE_ID } }),
        /entry point .* is missing/, 'planning a new command rejects the unusable package');
    for (const plan of [withNpm, sdkOnly]) {
        assert.throws(() => w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER }),
            (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED' && /unusable/.test(error.message));
        assert.equal(w.store.readIndex(plan.inputKey), null);
    }
    assert.equal(installer.calls.length, 0);
    assert.deepEqual(publishedObjects(w.store), []);
});

test('Box SDK store build: a completion record planted during npm never keeps a changed SDK copy', (t) => {
    const w = boxStore(t);
    const installer = boxNpm({
        during: (payloadDir) => {
            // A lifecycle script leaves a structurally valid, changed SDK plus a
            // record that names the right image; the published copy is still the image's.
            const planted = path.join(payloadDir, 'node_modules', 'mcp-sdk');
            fs.mkdirSync(planted, { recursive: true });
            fs.copyFileSync(path.join(w.sourceRoot, 'package.json'), path.join(planted, 'package.json'));
            fs.writeFileSync(path.join(planted, 'index.js'), 'export const changedByLifecycleScript = true;\n');
            fs.writeFileSync(path.join(payloadDir, PROVIDED_LIBRARIES_RECORD_NAME), JSON.stringify({
                schema: 'ploinky.provided-libraries/v1', providedLibraries: { 'mcp-sdk': { ...w.bundle.identity } },
            }));
        },
    });
    const built = w.store.ensureGeneration(w.lease, w.plan({ dependencies: { example: '1.0.0' } }), { installer, consumer: CONSUMER });
    assert.equal(installer.calls.length, 1);
    assert.equal(fs.readFileSync(path.join(built.nodeModulesPath, 'mcp-sdk', 'index.js'), 'utf8'), 'export const bundled = true;\n');
    assert.equal(boxMcpSdkCacheProblem(built.payloadPath, w.bundle), '');
});

test('Box SDK store build: an SDK damaged while npm runs fails before a completion marker', (t) => {
    const w = boxStore(t);
    const installer = boxNpm({
        during: (payloadDir) => fs.rmSync(path.join(payloadDir, '.ploinky-provided', 'node_modules', 'mcp-sdk', 'index.js')),
    });
    const plan = w.plan({ dependencies: { example: '1.0.0' } });
    assert.throws(() => w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER }),
        (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED' && /npm removed or damaged the provided MCP SDK/.test(error.message));
    assert.equal(w.store.readIndex(plan.inputKey), null);
    assert.deepEqual(publishedObjects(w.store), []);
});

test('Box SDK store admission: no SDK file body is read for hashing, and a same-shape SDK edit is not a digest failure', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const plan = w.plan({ dependencies: { example: '1.0.0' } });
    const { value: first, reads: buildReads } = recordSdkBodyReads(
        () => w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER }),
    );
    assert.deepEqual(buildReads, [], 'publication reads no SDK body for a digest');
    const copied = path.join(first.nodeModulesPath, 'mcp-sdk', 'index.js');
    fs.chmodSync(copied, 0o644);
    fs.writeFileSync(copied, 'export const bundled = "edited but functional";\n');
    const { value: validation, reads: admissionReads } = recordSdkBodyReads(
        () => w.store.validateObject(first.objectId, { inputKey: plan.inputKey }),
    );
    assert.equal(validation.valid, true, 'this design records no per-byte guarantee for the supplied SDK');
    assert.deepEqual(admissionReads, [], 'admission reads no SDK body for a digest');
    const { value: reuse } = recordSdkBodyReads(
        () => w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER }),
    );
    assert.equal(reuse.status, 'hit');
    assert.equal(reuse.objectId, first.objectId);
});

test('Box SDK store admission: ordinary dependency edits, a broken SDK and a record for another image are still rejected', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const plan = w.plan({ dependencies: { example: '1.0.0' } });
    const first = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    const other = path.join(first.nodeModulesPath, 'example', 'package.json');
    fs.chmodSync(other, 0o644);
    fs.writeFileSync(other, JSON.stringify({ name: 'example', version: '9.9.9' }));
    assert.deepEqual(w.store.validateObject(first.objectId, { inputKey: plan.inputKey }),
        { valid: false, reason: 'installed tree hash mismatch' });
    const second = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    assert.equal(second.status, 'repaired');
    assert.notEqual(second.objectId, first.objectId);
    assert.equal(fs.readFileSync(other, 'utf8'), JSON.stringify({ name: 'example', version: '9.9.9' }), 'the rejected object is never repaired in place');

    // A broken SDK package in a published object is rejected.
    const entry = path.join(second.nodeModulesPath, 'mcp-sdk', 'index.js');
    fs.chmodSync(entry, 0o644);
    fs.rmSync(entry);
    const broken = w.store.validateObject(second.objectId, { inputKey: plan.inputKey });
    assert.equal(broken.valid, false);
    assert.match(broken.reason, /Box MCP SDK cache is invalid/);

    // So is a completion record that names another supplying image.
    const third = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
    const record = path.join(third.payloadPath, PROVIDED_LIBRARIES_RECORD_NAME);
    fs.chmodSync(record, 0o644);
    fs.writeFileSync(record, JSON.stringify({
        schema: 'ploinky.provided-libraries/v1',
        providedLibraries: { 'mcp-sdk': { kind: 'image', library: 'mcp-sdk', supplyingImageId: OTHER_OUTER_IMAGE } },
    }));
    const forged = w.store.validateObject(third.objectId, { inputKey: plan.inputKey });
    assert.equal(forged.valid, false);
});

test('Box SDK store admission: the plain-tree checks still apply to the supplied SDK without hashing any byte', (t) => {
    const outside = path.join(workspace, `external-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(outside, 'export const external = true;\n');
    t.after(() => fs.rmSync(outside, { force: true }));
    const cases = {
        'a hard link to an external file as the entry point': (sdkRoot) => {
            const entry = path.join(sdkRoot, 'index.js');
            fs.rmSync(entry);
            fs.linkSync(outside, entry);
        },
        'a hard link to another file of the SDK': (sdkRoot) => {
            fs.linkSync(path.join(sdkRoot, 'index.js'), path.join(sdkRoot, 'second-name.js'));
        },
        'an internal symlink that is not the entry point': (sdkRoot) => {
            fs.symlinkSync('index.js', path.join(sdkRoot, 'linked.js'));
        },
        'a nested symlink escaping the payload': (sdkRoot) => {
            fs.mkdirSync(path.join(sdkRoot, 'nested'));
            fs.symlinkSync(os.tmpdir(), path.join(sdkRoot, 'nested', 'escape'));
        },
        'Git metadata inside the SDK': (sdkRoot) => {
            fs.mkdirSync(path.join(sdkRoot, '.git'));
        },
    };
    for (const [label, tamper] of Object.entries(cases)) {
        const w = boxStore(t);
        const installer = boxNpm();
        const plan = w.plan({ dependencies: { example: '1.0.0' } });
        const built = w.store.ensureGeneration(w.lease, plan, { installer, consumer: CONSUMER });
        const sdkRoot = path.join(built.nodeModulesPath, 'mcp-sdk');
        assert.equal(w.store.validateObject(built.objectId, { inputKey: plan.inputKey }).valid, true, 'the untouched object is valid');
        const { value: validation, reads } = recordSdkBodyReads(() => {
            tamper(sdkRoot);
            return w.store.validateObject(built.objectId, { inputKey: plan.inputKey });
        });
        assert.equal(validation.valid, false, label);
        assert.deepEqual(reads, [], `${label}: the structural rejection reads no SDK body`);
    }
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

test('Box SDK store build: a seeded agent object carries the seed\'s completion record and stays admissible', (t) => {
    const w = boxStore(t);
    const installer = boxNpm();
    const seedPlan = buildSeedInstallPlan({
        provider: w.provider, globalPackage: GLOBAL, sdkBundle: w.bundle, agentLibSelection: w.agentLib,
    });
    const agentPlan = w.plan(null, 'repo/seeded');
    const result = w.store.ensureAgentGeneration(w.lease, { agentPlan, seedPlan, installer, consumer: CONSUMER });
    assert.equal(result.seedDecision, 'exact seed contract', 'the agent object is copied from the seed');
    assert.equal(installer.calls.length, 0);
    const record = path.join(result.payloadPath, PROVIDED_LIBRARIES_RECORD_NAME);
    assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')).providedLibraries['mcp-sdk'], w.bundle.identity);
    assert.equal(boxMcpSdkCacheProblem(result.payloadPath, w.bundle), '');
    assert.equal(w.store.validateObject(result.objectId, { inputKey: agentPlan.inputKey }).valid, true);
});

test('non-Box manifests keep their Git SDK dependency and no supplied SDK is selected', () => {
    const pkg = { dependencies: { 'mcp-sdk': 'github:someone/alternate-sdk#branch' } };
    assert.equal(withoutBoxMcpSdk(pkg, { bundle: null }), pkg);
    assert.equal(mergePackageJson({}, pkg).dependencies['mcp-sdk'], pkg.dependencies['mcp-sdk']);
    assert.equal(activeBoxMcpSdkBundle({ insideBox: false, sourceRoot: '/missing' }), null);
    assert.equal(needsNpmInstall({ scripts: { test: 'node --test' } }), false);
    assert.equal(needsNpmInstall({ scripts: { prepare: 'node build.js' } }), true, 'npm lifecycle scripts still require npm');
});
