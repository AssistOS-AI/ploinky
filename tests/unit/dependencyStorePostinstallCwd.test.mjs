// Real npm lifecycle script through the store's host installer: a local
// `file:` tarball whose postinstall records its working directory inside the
// installed package. npm runs offline with isolated HOME, cache and config.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import {
    buildProviderContract,
    buildSeedInstallPlan,
    defaultProbeHostToolchain,
    hostToolchainIdentity,
} from '../../cli/utils/dependencies/store/installContract.mjs';
import { resolveHostNpmPolicy } from '../../cli/utils/dependencies/store/npmPolicy.mjs';
import { createHostNpmInstaller } from '../../cli/utils/dependencies/store/installers.mjs';
import { fakeLease, hasCommand, makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

const AVAILABLE = hasCommand('npm') && hasCommand('tar');
const CONSUMER = Object.freeze({ kind: 'test-consumer', process: { pid: process.pid } });

const RECORDER = `const fs = require('fs');
fs.writeFileSync('cwd.json', JSON.stringify({ cwd: process.cwd(), initCwd: process.env.INIT_CWD || null }));
`;

function cwdProbeTarball(root) {
    const staging = path.join(root, 'tarball-src');
    const pkgDir = path.join(staging, 'package');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
        name: 'cwdprobe', version: '1.0.0', main: 'index.js', scripts: { postinstall: 'node record.js' },
    }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = "cwdprobe";\n');
    fs.writeFileSync(path.join(pkgDir, 'record.js'), RECORDER);
    const tarball = path.join(root, 'cwdprobe-1.0.0.tgz');
    const tar = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' });
    assert.equal(tar.status, 0, tar.stderr);
    return tarball;
}

test('dependency store npm: a real postinstall runs in the object\'s private payload and the published object stays immutable', { skip: !AVAILABLE && 'npm or tar unavailable', timeout: 300_000 }, (t) => {
    const root = tempRoot(t, 'depstore-postinstall-');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || root };
    const probe = defaultProbeHostToolchain({ env });
    const runtimeKey = `seatbelt-${probe.platform}-${probe.arch}-node${Number.parseInt(probe.node.version, 10)}`;
    const { policy, transport } = resolveHostNpmPolicy({ env: { npm_config_offline: 'true' }, files: [] });
    assert.equal(policy.ignoreScripts, false, 'the default host policy runs lifecycle scripts');
    const agentLib = makeAgentLib(root);
    const provider = buildProviderContract({
        runtimeKey, toolchain: hostToolchainIdentity({ runtimeKey, probe }), npmPolicy: policy, sdkBundle: null, agentLib,
    });
    const realInstaller = createHostNpmInstaller({ toolchain: probe, policy, transport, env, timeoutMs: 120_000, ceilingDirectories: [workspace] });
    const calls = [];
    const installer = {
        kind: realInstaller.kind,
        describe: (args) => realInstaller.describe(args),
        install(args) { calls.push(args.payloadDir); return realInstaller.install(args); },
    };
    const { lease, assertLease } = fakeLease();
    const depsDir = path.join(workspace, '.ploinky', 'deps');
    const store = createCacheStore({ depsDir, workspaceRoot: workspace, assertLease, checkDiskSpace: () => ({ ok: true }) });
    const tarball = cwdProbeTarball(root);
    const plan = buildSeedInstallPlan({
        provider, globalPackage: { name: 'g', version: '1.0.0', dependencies: { cwdprobe: `file:${tarball}` } }, agentLibSelection: agentLib, pinState: {},
    });

    const generation = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    assert.equal(generation.status, 'built');
    assert.equal(calls.length, 1);
    const objectDir = path.join(store.paths.objects, generation.objectId);
    assert.equal(generation.payloadPath, path.join(objectDir, 'payload'));
    const installed = path.join(generation.nodeModulesPath, 'cwdprobe');
    const recordFile = path.join(installed, 'cwd.json');
    assert.ok(fs.existsSync(recordFile), 'the real postinstall ran and wrote inside the installed package');
    const recorded = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    assert.equal(fs.realpathSync(recorded.cwd), fs.realpathSync(installed),
        'the lifecycle script ran inside this object\'s own payload');
    assert.equal(fs.realpathSync(recorded.initCwd), fs.realpathSync(generation.payloadPath),
        'npm was invoked in the object\'s private build payload');
    for (const shared of [workspace, depsDir, store.paths.objects, root]) {
        assert.notEqual(fs.realpathSync(recorded.cwd), fs.realpathSync(shared), `not the shared path ${shared}`);
    }
    assert.ok(!path.relative(objectDir, fs.realpathSync(recorded.cwd)).startsWith('..'), 'cwd is inside the private object directory');
    assert.equal(fs.existsSync(path.join(objectDir, 'work')), false, 'the transient npm work directory was removed');
    assert.deepEqual(fs.readdirSync(workspace).sort(), ['.ploinky'], 'nothing was written into the workspace outside the store');
    const recordBytes = fs.readFileSync(recordFile);

    // Published and immutable: validation holds, a repeat request is a hit
    // (no new install, no rewrite), and the recorded bytes are covered by
    // the object's tree hash.
    assert.equal(store.validateObject(generation.objectId, { inputKey: plan.inputKey }).valid, true);
    const again = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    assert.equal(again.status, 'hit');
    assert.equal(again.objectId, generation.objectId);
    assert.equal(calls.length, 1, 'the postinstall never re-runs against a published object');
    assert.deepEqual(fs.readFileSync(recordFile), recordBytes);
    fs.writeFileSync(recordFile, JSON.stringify({ cwd: workspace, initCwd: workspace }));
    assert.equal(store.validateObject(generation.objectId, { inputKey: plan.inputKey }).reason, 'installed tree hash mismatch',
        'rewriting the recorded cwd is detected as a mutated object');
});
