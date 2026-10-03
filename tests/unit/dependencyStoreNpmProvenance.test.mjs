// Real scratch-local npm installs from a local git+file remote. npm cache,
// config and HOME are isolated in temporary directories and npm runs offline.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createCacheStore } from '../../cli/utils/dependencies/store/objectStore.mjs';
import {
    buildProviderContract,
    buildSeedInstallPlan,
    defaultProbeHostToolchain,
    hostToolchainIdentity,
} from '../../cli/utils/dependencies/store/installContract.mjs';
import { resolveHostNpmPolicy } from '../../cli/utils/dependencies/store/npmPolicy.mjs';
import { createHostNpmInstaller } from '../../cli/utils/dependencies/store/installers.mjs';
import { collectGitInputs, discoverGitPins, mergeDiscoveredPins } from '../../cli/utils/dependencies/store/gitPins.mjs';
import { readHiddenLock, verifyDirectGitProvenance } from '../../cli/utils/dependencies/store/resolution.mjs';
import { fakeLease, git, gitEnv, hasCommand, makeAgentLib, markerRemote, tempRoot } from './dependencyStoreFixtures.mjs';

const AVAILABLE = hasCommand('npm') && hasCommand('git');
const CONSUMER = Object.freeze({ kind: 'test-consumer', process: { pid: process.pid } });

function realSetup(t) {
    const root = tempRoot(t, 'depstore-npm-');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || root };
    const probe = defaultProbeHostToolchain({ env });
    const runtimeKey = `seatbelt-${probe.platform}-${probe.arch}-node${Number.parseInt(probe.node.version, 10)}`;
    const { policy, transport } = resolveHostNpmPolicy({ env: { npm_config_offline: 'true' }, files: [] });
    const agentLib = makeAgentLib(root);
    const provider = buildProviderContract({
        runtimeKey, toolchain: hostToolchainIdentity({ runtimeKey, probe }), npmPolicy: policy, sdkBundle: null, agentLib,
    });
    const realInstaller = createHostNpmInstaller({ toolchain: probe, policy, transport, env, timeoutMs: 120_000 });
    const calls = [];
    const installer = {
        kind: realInstaller.kind,
        describe: () => realInstaller.describe(),
        install(args) { calls.push(args.payloadDir); return realInstaller.install(args); },
    };
    const { lease, assertLease } = fakeLease();
    const storeAt = (name) => createCacheStore({ depsDir: path.join(root, name), workspaceRoot: root, assertLease, checkDiskSpace: () => ({ ok: true }) });
    const gEnv = gitEnv(home);
    const remote = markerRemote(root, gEnv);
    const planFor = (dependencies, pinState = {}) => buildSeedInstallPlan({
        provider, globalPackage: { name: 'g', version: '1.0.0', dependencies }, agentLibSelection: agentLib, pinState,
    });
    return { root, env, gEnv, remote, installer, realInstaller, calls, lease, storeAt, planFor };
}

const marker = (generation) => fs.readFileSync(path.join(generation.nodeModulesPath, 'markerpkg', 'index.js'), 'utf8').trim();
const manifestOf = (store, generation) => JSON.parse(fs.readFileSync(path.join(store.paths.objects, generation.objectId, 'manifest.json'), 'utf8'));

test('dependency store npm: exact equal-version commits install distinguishable bytes with matching provenance', { skip: !AVAILABLE && 'npm or git unavailable', timeout: 300_000 }, (t) => {
    const { remote, gEnv, installer, calls, lease, storeAt, planFor } = realSetup(t);
    const store = storeAt('deps');
    const spec = { markerpkg: `${remote.url}#main` };

    // First start: no update, no ls-remote; record what npm actually installed.
    const first = store.ensureGeneration(lease, planFor(spec), { installer, consumer: CONSUMER });
    assert.equal(first.status, 'built');
    assert.equal(marker(first), 'module.exports = "MARKER_ONE";');
    const firstManifest = manifestOf(store, first);
    assert.deepEqual(firstManifest.provenance.map((item) => [item.commit, item.verification]), [[remote.first, 'observed-at-install']]);
    assert.equal(readHiddenLock(first.payloadPath).packages['node_modules/markerpkg'].resolved, `${remote.url}#${remote.first}`);

    // The branch moves, but without an update the same key is reused.
    git(remote.remote, ['update-ref', 'refs/heads/main', remote.second], gEnv);
    const again = store.ensureGeneration(lease, planFor(spec), { installer, consumer: CONSUMER });
    assert.equal(again.status, 'hit');
    assert.equal(calls.length, 1);

    // Update: bounded ls-remote discovery produces a remote-verified pin.
    const plan = planFor(spec);
    const { entries, unsupported } = collectGitInputs(plan.effectiveManifest, { scope: 'global' });
    const discovery = discoverGitPins(entries, { unsupported, env: gEnv });
    assert.deepEqual(discovery.results.map((result) => [result.status, result.commit]), [['resolved', remote.second]]);
    store.updatePins(lease, (pins) => mergeDiscoveredPins(pins, entries, discovery.results, { bindings: [{ scope: 'global' }] }).pins);
    const pinnedPlan = planFor(spec, store.readPins().pins);
    assert.notEqual(pinnedPlan.inputKey, plan.inputKey);
    const second = store.ensureGeneration(lease, pinnedPlan, { installer, consumer: CONSUMER });
    assert.equal(second.status, 'built');
    assert.equal(JSON.parse(fs.readFileSync(path.join(second.payloadPath, 'package.json'), 'utf8')).dependencies.markerpkg,
        `${remote.url}#${remote.second}`, 'requested exact SHA');
    assert.equal(readHiddenLock(second.payloadPath).packages['node_modules/markerpkg'].resolved, `${remote.url}#${remote.second}`, 'recorded resolution');
    assert.equal(marker(second), 'module.exports = "MARKER_TWO";', 'actual installed bytes');
    assert.deepEqual(manifestOf(store, second).provenance.map((item) => [item.commit, item.verification]), [[remote.second, 'remote-verified']]);
    assert.equal(marker(first), 'module.exports = "MARKER_ONE";', 'the earlier object is unchanged');
    assert.equal(store.validateObject(first.objectId, { inputKey: plan.inputKey }).valid, true);

    // Explicit full SHA back to the first commit: requested, recorded and installed agree.
    const exact = store.ensureGeneration(lease, planFor({ markerpkg: `${remote.url}#${remote.first}` }), { installer, consumer: CONSUMER });
    assert.equal(marker(exact), 'module.exports = "MARKER_ONE";');
    assert.deepEqual(manifestOf(store, exact).provenance.map((item) => [item.commit, item.verification]), [[remote.first, 'exact-spec']]);

    // Corrupting the tree while the hidden lock stays unchanged is detected.
    fs.writeFileSync(path.join(second.nodeModulesPath, 'markerpkg', 'index.js'), 'module.exports = "MARKER_ONE";\n');
    assert.equal(store.validateObject(second.objectId, { inputKey: pinnedPlan.inputKey }).reason, 'installed tree hash mismatch');
});

test('dependency store npm: stale npm state, missing metadata and resolution failure prevent publication', { skip: !AVAILABLE && 'npm or git unavailable', timeout: 300_000 }, (t) => {
    const { root, remote, installer, realInstaller, calls, lease, storeAt, planFor } = realSetup(t);
    const store = storeAt('deps');
    const firstPlan = planFor({ markerpkg: `${remote.url}#${remote.first}` });
    const first = store.ensureGeneration(lease, firstPlan, { installer, consumer: CONSUMER });

    // Stale npm state (an existing tree npm considers up to date after the
    // spec changed) must never pass verification.
    const expectedSecond = [{
        section: 'dependencies', name: 'markerpkg', source: `file://${remote.remote}`, commit: remote.second, supported: true, presence: 'required',
    }];
    const scratch = path.join(root, 'stale');
    fs.cpSync(first.payloadPath, scratch, { recursive: true, verbatimSymlinks: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(scratch, 'package.json'), 'utf8'));
    pkg.dependencies.markerpkg = `${remote.url}#${remote.second}`;
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify(pkg));
    const scratchMarker = () => fs.readFileSync(path.join(scratch, 'node_modules', 'markerpkg', 'index.js'), 'utf8').trim();
    assert.equal(scratchMarker(), 'module.exports = "MARKER_ONE";');
    assert.throws(() => verifyDirectGitProvenance(scratch, expectedSecond, { hiddenLock: readHiddenLock(scratch) }),
        { code: 'PLOINKY_DEPS_PROVENANCE_MISMATCH' });
    // A real in-place npm run over existing state may or may not refresh the
    // package; either way the verdict must agree with the actual bytes.
    const work = path.join(root, 'stale-work');
    fs.mkdirSync(work);
    realInstaller.install({ payloadDir: scratch, workDir: work, options: {} });
    if (scratchMarker() === 'module.exports = "MARKER_TWO";') {
        assert.equal(verifyDirectGitProvenance(scratch, expectedSecond, { hiddenLock: readHiddenLock(scratch) })[0].commit, remote.second);
    } else {
        assert.throws(() => verifyDirectGitProvenance(scratch, expectedSecond, { hiddenLock: readHiddenLock(scratch) }),
            { code: 'PLOINKY_DEPS_PROVENANCE_MISMATCH' });
    }

    // Missing installer metadata prevents publication.
    const noLock = {
        kind: 'host-npm',
        describe: () => realInstaller.describe(),
        install(args) {
            const result = realInstaller.install(args);
            fs.rmSync(path.join(args.payloadDir, 'node_modules', '.package-lock.json'), { force: true });
            return result;
        },
    };
    const missingPlan = planFor({ markerpkg: `${remote.url}#${remote.second}` });
    assert.throws(() => store.ensureGeneration(lease, missingPlan, { installer: noLock, consumer: CONSUMER }),
        (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED' && error.cause.code === 'PLOINKY_DEPS_PROVENANCE_MISMATCH');
    assert.equal(store.readIndex(missingPlan.inputKey), null);

    // A commit that does not exist fails resolution; the retry is bounded and nothing is published.
    const before = calls.length;
    const missingCommit = planFor({ markerpkg: `${remote.url}#${'f'.repeat(40)}` });
    assert.throws(() => store.ensureGeneration(lease, missingCommit, { installer, consumer: CONSUMER }),
        (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED' && error.cause.code === 'PLOINKY_DEPS_INSTALL_FAILED');
    assert.equal(calls.length - before, 2);
    assert.equal(store.readIndex(missingCommit.inputKey), null);
    assert.equal(store.readIndex(firstPlan.inputKey).objectId, first.objectId, 'previous state untouched');
});
