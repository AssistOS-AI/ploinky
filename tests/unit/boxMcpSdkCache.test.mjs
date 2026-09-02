import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { BOX_MARKER_CONTENT, BOX_MARKER_PATH } from '../../ploinky-box/constants.mjs';
import {
    MCP_SDK_BUNDLE_PATH,
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

const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'box-sdk-cache-test-'));
const previousWorkspace = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const cache = await import('../../cli/utils/dependencies/dependencyCache.js');
const installer = await import('../../cli/utils/dependencies/dependencyInstaller.js');
const lockPath = new URL('../../ploinky-box/dependencies.lock.json', import.meta.url);
const repository = readMcpSdkRepositoryFromLock({ lockPath });
const runtimeKey = 'container-linux-x64-glibc-node24';
const selection = {
    sourceDir: '/selected/achillesAgentLib',
    mode: 'managed',
    fingerprint: 'a'.repeat(64),
    commit: 'b'.repeat(40),
    sourceIdHash: 'c'.repeat(64),
};
const prepareOptions = {
    runtimeKey,
    image: 'example/node:24',
    runtime: 'podman',
    agentLib: selection,
    log() {},
};

test.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (previousWorkspace === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspace;
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

/** Exercise actual prepare/inspect code with a temporary immutable-image fixture. */
function boxEnvironment(t, { globalPackage = null, insideBox = true, onInstall = null } = {}) {
    const f = fixture(t);
    const marker = path.join(f.root, 'box-marker');
    fs.writeFileSync(marker, BOX_MARKER_CONTENT);
    const alternateGlobal = path.join(f.root, 'global-package.json');
    if (globalPackage) fs.writeFileSync(alternateGlobal, JSON.stringify(globalPackage));
    const remap = (filename) => {
        if (filename === BOX_MARKER_PATH) return insideBox ? marker : path.join(f.root, 'no-marker');
        if (typeof filename === 'string' && (filename === MCP_SDK_BUNDLE_PATH || filename.startsWith(`${MCP_SDK_BUNDLE_PATH}/`))) {
            return `${f.sourceRoot}${filename.slice(MCP_SDK_BUNDLE_PATH.length)}`;
        }
        if (globalPackage && filename === cache.getGlobalPackagePath()) return alternateGlobal;
        return filename;
    };
    const mocks = [];
    for (const method of ['lstatSync', 'readFileSync', 'readdirSync']) {
        const original = fs[method];
        mocks.push(t.mock.method(fs, method, (filename, ...args) => original(remap(filename), ...args)));
    }
    const actualSpawn = childProcess.spawnSync;
    const installs = [];
    const calls = [];
    mocks.push(t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
        calls.push({ command, args });
        if (command === 'podman') {
            if (args[0] === 'image') return { status: 1, stdout: '', stderr: '' };
            if (args.includes('test')) return { status: 0, stdout: '', stderr: '' };
            const volume = args[args.indexOf('-v') + 1];
            assert.ok(volume.endsWith(':/install:z'));
            const installPath = volume.slice(0, -':/install:z'.length);
            const pkg = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf8'));
            if (insideBox) {
                assert.equal(pkg.dependencies['mcp-sdk'], 'file:.ploinky-provided/node_modules/mcp-sdk');
                assert.equal(pkg.overrides['mcp-sdk'], '$mcp-sdk');
                assert.ok(args.at(-1).includes('--install-links=false'));
                for (const field of ['devDependencies', 'optionalDependencies', 'peerDependencies']) {
                    assert.equal(Object.hasOwn(pkg[field] || {}, 'mcp-sdk'), false, `npm input still contains SDK in ${field}`);
                }
            }
            installs.push({ installPath, pkg });
            // npm prunes extraneous entries; the production finalizer must
            // restore the validated image bundle after this operation.
            fs.rmSync(path.join(installPath, 'node_modules', 'mcp-sdk'), { recursive: true, force: true });
            fs.rmSync(path.join(installPath, 'node_modules', 'achillesAgentLib'), { recursive: true, force: true });
            if (onInstall) onInstall(installPath, pkg);
            return { status: 0, stdout: '', stderr: '' };
        }
        assert.notEqual(command, 'npm', 'unexpected host npm install');
        assert.notEqual(command, 'git', 'SDK preparation must not fetch Git');
        return actualSpawn(command, args.map(remap), options);
    }));
    syncBuiltinESMExports();
    t.after(() => {
        for (const mock of mocks) mock.mock.restore();
        syncBuiltinESMExports();
    });
    return { ...f, installs, calls, alternateGlobal };
}

function agentPackage(root, pkg) {
    const filename = path.join(root, 'agent-package.json');
    fs.writeFileSync(filename, JSON.stringify(pkg));
    return filename;
}

test('canonical legacy and immutable SDK declarations are excluded from every npm dependency field', (t) => {
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

test('SDK-only and test-script-only Box agents prepare without an npm or Git invocation', (t) => {
    const f = boxEnvironment(t);
    for (const [agentName, pkg] of [
        ['plain', null],
        ['test-script', { scripts: { test: 'node --test' } }],
        ['sdk-declaration', { dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#main' } }],
    ]) {
        const agentPackagePath = pkg ? agentPackage(f.root, pkg) : null;
        const options = { ...prepareOptions, repoName: 'core-only', agentName, agentPackagePath, force: true };
        const prepared = cache.prepareAgentCache(options);
        assert.equal(prepared.reused, false);
        assert.equal(cache.inspectAgentCache(options).valid, true);
        assert.equal(cache.verifyAgentCache(options), path.join(prepared.cachePath, 'node_modules'));
        assert.deepEqual(prepared.stamp.mcpSdk, boxMcpSdkStampSection(f.bundle));
    }
    assert.equal(f.installs.length, 0);
    assert.equal(f.calls.some(({ command }) => ['podman', 'git', 'npm'].includes(command)), false);
    assert.equal(installer.readGlobalDepsPackage().dependencies['mcp-sdk'], undefined, 'moving-Git updater sees no Box-provided dependency');
});

test('other dependencies still install and the image SDK is restored after npm pruning', (t) => {
    const f = boxEnvironment(t);
    const options = {
        ...prepareOptions, repoName: 'with-deps', agentName: 'agent', force: true,
        agentPackagePath: agentPackage(f.root, {
            dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#main', example: '1.0.0' },
            scripts: { postinstall: 'node setup.js' },
        }),
    };
    const prepared = cache.prepareAgentCache(options);
    assert.equal(f.installs.length, 1);
    assert.deepEqual(f.installs[0].pkg.dependencies, {
        example: '1.0.0', 'mcp-sdk': 'file:.ploinky-provided/node_modules/mcp-sdk',
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(prepared.cachePath, 'package.json'), 'utf8')).dependencies, { example: '1.0.0' });
    assert.equal(f.installs[0].pkg.scripts.postinstall, 'node setup.js');
    assert.equal(cache.inspectAgentCache(options).valid, true);
    assert.equal(boxMcpSdkCacheProblem(prepared.cachePath, prepared.stamp, f.bundle), '');
    assert.equal(validateMcpSdkBundle({ sourceRoot: f.sourceRoot }).contentSha256, f.bundle.contentSha256);
});

test('npm lifecycle scripts run even when no npm dependencies remain', (t) => {
    const f = boxEnvironment(t);
    assert.equal(needsNpmInstall({ scripts: { test: 'node --test' } }), false);
    const prepared = cache.prepareAgentCache({
        ...prepareOptions, repoName: 'lifecycle', agentName: 'agent', force: true,
        agentPackagePath: agentPackage(f.root, { scripts: { prepare: 'node build.js' } }),
    });
    assert.equal(f.installs.length, 1);
    assert.equal(f.installs[0].pkg.scripts.prepare, 'node build.js');
    assert.equal(boxMcpSdkCacheProblem(prepared.cachePath, prepared.stamp, f.bundle), '');
});

test('adding an npm lifecycle script invalidates a previously skipped SDK-only cache', (t) => {
    const f = boxEnvironment(t);
    const agentPackagePath = agentPackage(f.root, { scripts: { test: 'node --test' } });
    const options = { ...prepareOptions, repoName: 'script-change', agentName: 'agent', agentPackagePath };
    cache.prepareAgentCache(options);
    assert.equal(f.installs.length, 0);
    agentPackage(f.root, { scripts: { test: 'node --test', prepare: 'node build.js' } });
    assert.equal(cache.inspectAgentCache(options).valid, false);
    const refreshed = cache.prepareAgentCache(options);
    assert.equal(refreshed.reused, false);
    assert.equal(f.installs.length, 1);
    assert.equal(cache.inspectAgentCache(options).valid, true);
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

test('a global dependency removed before an SDK-only rebuild is pruned without running npm', (t) => {
    const f = boxEnvironment(t, {
        globalPackage: { dependencies: { example: '1.0.0' } },
        onInstall(installPath) {
            const installed = path.join(installPath, 'node_modules', 'example');
            fs.mkdirSync(installed, { recursive: true });
            fs.writeFileSync(path.join(installed, 'package.json'), '{"name":"example","version":"1.0.0"}');
        },
    });
    const first = cache.prepareGlobalCache(runtimeKey, { ...prepareOptions, force: true });
    assert.equal(f.installs.length, 1);
    assert.equal(fs.existsSync(path.join(first.cachePath, 'node_modules', 'example')), true);
    fs.writeFileSync(f.alternateGlobal, JSON.stringify({ dependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#main' } }));
    const rebuilt = cache.prepareGlobalCache(runtimeKey, prepareOptions);
    assert.equal(rebuilt.reused, false);
    assert.equal(f.installs.length, 1, 'SDK-only rebuild must not invoke npm');
    assert.equal(fs.existsSync(path.join(first.cachePath, 'node_modules', 'example')), false);
    assert.equal(boxMcpSdkCacheProblem(rebuilt.cachePath, rebuilt.stamp, f.bundle), '');
});

test('agent override and invalid image reject before any global npm install', (t) => {
    const f = boxEnvironment(t, { globalPackage: { dependencies: { example: '1.0.0' } } });
    const options = {
        ...prepareOptions, repoName: 'rejected', agentName: 'agent', force: true,
        agentPackagePath: agentPackage(f.root, { optionalDependencies: { 'mcp-sdk': 'github:AssistOS-AI/MCPSDK#other' } }),
    };
    assert.throws(() => cache.prepareAgentCache(options), /overrides 'mcp-sdk'/);
    assert.equal(f.installs.length, 0);
    fs.writeFileSync(path.join(f.sourceRoot, 'index.js'), 'tampered\n');
    assert.throws(() => cache.prepareAgentCache({ ...options, agentPackagePath: null }), /fingerprint/);
    assert.equal(f.installs.length, 0);
});

test('cache admission rejects stale stamps and altered bytes without repairing or restamping', (t) => {
    boxEnvironment(t);
    const options = { ...prepareOptions, repoName: 'admission', agentName: 'agent', force: true };
    const prepared = cache.prepareAgentCache(options);
    const originalStamp = fs.readFileSync(cache.stampPath(prepared.cachePath), 'utf8');
    const copiedFile = path.join(prepared.cachePath, 'node_modules', 'mcp-sdk', 'index.js');
    fs.writeFileSync(copiedFile, 'altered\n');
    assert.equal(cache.inspectAgentCache(options).valid, false);
    assert.throws(() => cache.verifyAgentCache(options), /fingerprint/);
    assert.equal(fs.readFileSync(copiedFile, 'utf8'), 'altered\n');
    assert.equal(fs.readFileSync(cache.stampPath(prepared.cachePath), 'utf8'), originalStamp);
    const repaired = cache.prepareAgentCache(options);
    const staleStamp = { ...repaired.stamp };
    delete staleStamp.mcpSdk;
    cache.writeStamp(prepared.cachePath, staleStamp);
    assert.match(cache.inspectAgentCache(options).reason, /stamp identity/);
    staleStamp.mcpSdk = { ...repaired.stamp.mcpSdk, repository: { ...repository, commit: 'a'.repeat(40) } };
    cache.writeStamp(prepared.cachePath, staleStamp);
    assert.match(cache.inspectAgentCache(options).reason, /stamp identity/);
});

test('tampering during npm fails before a fresh cache stamp can be written', (t) => {
    let sourceRoot;
    const f = boxEnvironment(t, {
        onInstall() { fs.writeFileSync(path.join(sourceRoot, 'index.js'), 'changed during npm\n'); },
    });
    sourceRoot = f.sourceRoot;
    const options = {
        ...prepareOptions, repoName: 'race', agentName: 'agent', force: true,
        agentPackagePath: agentPackage(f.root, { dependencies: { example: '1.0.0' } }),
    };
    assert.throws(() => cache.prepareAgentCache(options), /fingerprint/);
    assert.equal(cache.readStamp(cache.getAgentCachePath(options.repoName, options.agentName, runtimeKey)), null);
});

test('non-Box manifests and installers retain their Git SDK dependency behavior', (t) => {
    const f = boxEnvironment(t, { insideBox: false });
    const pkg = { dependencies: { 'mcp-sdk': 'github:someone/alternate-sdk#branch' } };
    assert.equal(withoutBoxMcpSdk(pkg, { bundle: null }), pkg);
    assert.equal(installer.mergePackageJson({}, pkg).dependencies['mcp-sdk'], pkg.dependencies['mcp-sdk']);
    const prepared = cache.prepareGlobalCache(runtimeKey, { ...prepareOptions, force: true });
    assert.equal(f.installs.length, 1);
    assert.equal(f.installs[0].pkg.dependencies['mcp-sdk'], 'git+https://github.com/AssistOS-AI/MCPSDK.git#main');
    assert.equal(prepared.stamp.mcpSdk, undefined);
    assert.equal(activeBoxMcpSdkBundle({ insideBox: false, sourceRoot: '/missing', lockPath: '/missing' }), null);
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
