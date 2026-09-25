import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync as spawnSyncReal } from 'node:child_process';

import { createCacheStore, defaultCopySeed, generationIdFor } from '../../cli/utils/dependencies/store/objectStore.mjs';
import { buildAgentInstallPlan, buildSeedInstallPlan } from '../../cli/utils/dependencies/store/installContract.mjs';
import { PIN_VERIFICATION, buildPin, recordObservedPins } from '../../cli/utils/dependencies/store/gitPins.mjs';
import { hashInstalledTree } from '../../cli/utils/dependencies/store/treeHash.mjs';
import { fakeInstaller, fakeLease, hostProvider, makeAgentLib, tempRoot } from './dependencyStoreFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GLOBAL = Object.freeze({ name: 'ploinky-global-deps', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } });
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const CONSUMER = Object.freeze({ kind: 'test-consumer', process: { pid: 1, processStart: 'x', bootScope: 'y' } });

function setup(t, { storeOptions = {}, globalPackage = GLOBAL, agentLib: givenLib = null } = {}) {
    const root = tempRoot(t);
    const agentLib = givenLib || makeAgentLib(root);
    const provider = hostProvider({ agentLib });
    const { lease, assertLease } = fakeLease();
    const store = createCacheStore({
        depsDir: path.join(root, '.ploinky', 'deps'),
        workspaceRoot: root,
        assertLease,
        checkDiskSpace: () => ({ ok: true, availableBytes: 1e12 }),
        ...storeOptions,
    });
    const seedPlan = (overrides = {}) => buildSeedInstallPlan({ provider, globalPackage, agentLibSelection: agentLib, ...overrides });
    const agentPlan = ({ registration = 'repo/agent', manifest = null, rebuildToken = null, pinState = {} } = {}) => buildAgentInstallPlan({
        provider,
        globalPackage,
        agentPackage: manifest ? { selection: 'code', relativePath: `${registration}/code/package.json`, sha256: 'f'.repeat(64), manifest } : null,
        registration,
        rebuildToken,
        agentLibSelection: agentLib,
        pinState,
    });
    return { root, agentLib, provider, lease, assertLease, store, seedPlan, agentPlan };
}

function listFiles(dir) {
    const out = [];
    const walk = (current, rel) => {
        for (const name of fs.readdirSync(current).sort()) {
            const abs = path.join(current, name);
            const relName = rel ? `${rel}/${name}` : name;
            const stat = fs.lstatSync(abs);
            out.push({ rel: relName, stat, link: stat.isSymbolicLink() ? fs.readlinkSync(abs) : null });
            if (stat.isDirectory()) walk(abs, relName);
        }
    };
    walk(dir, '');
    return out;
}

test('dependency store: a build publishes a verified immutable object and a second call is a hit', (t) => {
    const { store, lease, seedPlan } = setup(t);
    const installer = fakeInstaller();
    const plan = seedPlan();
    const built = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER, operation: 'start' });
    assert.equal(built.status, 'built');
    assert.equal(installer.calls.length, 1);
    assert.equal(built.payloadPath, path.join(store.paths.objects, built.objectId, 'payload'));
    assert.equal(fs.readFileSync(path.join(built.nodeModulesPath, 'left-pad', 'index.js'), 'utf8'), 'module.exports = "left-pad:m1";\n');
    assert.equal(fs.readlinkSync(path.join(built.nodeModulesPath, 'achillesAgentLib')), plan.providers.agentLib.linkTarget);
    const manifest = JSON.parse(fs.readFileSync(path.join(store.paths.objects, built.objectId, 'manifest.json'), 'utf8'));
    assert.equal(manifest.inputKey, plan.inputKey);
    assert.equal(manifest.generationId, generationIdFor(plan.inputKey, manifest.resolution.hash, manifest.tree.hash));
    assert.equal(store.readIndex(plan.inputKey).objectId, built.objectId);
    assert.deepEqual(fs.readdirSync(store.paths.buildReceipts), [], 'the build receipt is released once a reader owns the object');
    assert.equal(fs.existsSync(path.join(store.paths.objects, built.objectId, 'work')), false, 'transient npm state removed');

    const hit = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER, operation: 'start' });
    assert.equal(hit.status, 'hit');
    assert.equal(hit.objectId, built.objectId);
    assert.equal(hit.generationId, built.generationId);
    assert.equal(installer.calls.length, 1, 'no installer call on a hit');
    assert.equal(fs.readdirSync(store.paths.readerReceipts).length, 2, 'each returned path has a reader receipt');
    const receipt = JSON.parse(fs.readFileSync(hit.readerReceipt.path, 'utf8'));
    assert.equal(receipt.objectId, built.objectId);
    assert.equal(receipt.consumer.kind, 'test-consumer');
    assert.equal(store.releaseReaderReceipt(hit.readerReceipt), true);
    assert.equal(store.releaseReaderReceipt(hit.readerReceipt), false);
});

test('dependency store: every npm run starts from an empty payload node_modules', (t) => {
    const { store, lease, seedPlan } = setup(t);
    const observed = [];
    const installer = fakeInstaller({
        extra: () => {},
    });
    const original = installer.install;
    installer.install = (args) => {
        observed.push(fs.readdirSync(path.join(args.payloadDir, 'node_modules')));
        return original(args);
    };
    const plan = seedPlan();
    const first = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    fs.appendFileSync(path.join(first.nodeModulesPath, 'left-pad', 'index.js'), '// corrupt\n');
    store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    assert.deepEqual(observed, [[], []]);
});

test('dependency store: first and second starts share a key; only an update-verified pin changes it', (t) => {
    const url = 'git+file:///srv/tool.git';
    const globalPackage = { name: 'g', version: '1.0.0', dependencies: { tool: `${url}#main` } };
    const { store, lease, seedPlan } = setup(t, { globalPackage });
    const resolveGit = (_name, spec) => (spec.endsWith('#main') ? `${url}#${SHA_A}` : spec);
    const installer = fakeInstaller({ resolveGit });
    const first = store.ensureGeneration(lease, seedPlan(), { installer, consumer: CONSUMER });
    assert.equal(first.status, 'built');
    const manifest = JSON.parse(fs.readFileSync(path.join(store.paths.objects, first.objectId, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.provenance.map((item) => [item.name, item.commit, item.verification]), [['tool', SHA_A, 'observed-at-install']]);
    const plan = seedPlan();
    store.updatePins(lease, (pins) => recordObservedPins(pins, plan.gitEntries,
        manifest.provenance.map((item) => ({ pinId: plan.gitEntries[0].pinId, source: item.source, commit: item.commit }))));
    const second = store.ensureGeneration(lease, seedPlan({ pinState: store.readPins().pins }), { installer, consumer: CONSUMER });
    assert.equal(second.status, 'hit', 'the observed pin does not force a second build');
    assert.equal(installer.calls.length, 1);

    const entry = plan.gitEntries[0];
    store.updatePins(lease, (pins) => ({ ...pins, [entry.pinId]: buildPin(entry, { commit: SHA_B, verification: PIN_VERIFICATION.remote }) }));
    const updated = store.ensureGeneration(lease, seedPlan({ pinState: store.readPins().pins }), { installer, consumer: CONSUMER });
    assert.equal(updated.status, 'built');
    assert.notEqual(updated.objectId, first.objectId);
    const pkg = JSON.parse(fs.readFileSync(path.join(updated.payloadPath, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.tool, `${url}#${SHA_B}`, 'the desired pin is installed as a full SHA');
    const updatedManifest = JSON.parse(fs.readFileSync(path.join(store.paths.objects, updated.objectId, 'manifest.json'), 'utf8'));
    assert.deepEqual(updatedManifest.provenance.map((item) => [item.commit, item.verification]), [[SHA_B, 'remote-verified']]);
});

test('dependency store: a cwd-embedding installer stays valid because payloads are never relocated', (t) => {
    const { store, lease, seedPlan } = setup(t);
    const installer = fakeInstaller({
        extra: ({ payloadDir }) => {
            const dir = path.join(payloadDir, 'node_modules', 'cwdpkg');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'where.txt'), payloadDir);
            fs.symlinkSync(path.join(payloadDir, 'node_modules', 'left-pad'), path.join(dir, 'abs-link'));
        },
    });
    const built = store.ensureGeneration(lease, seedPlan(), { installer, consumer: CONSUMER });
    const embedded = fs.readFileSync(path.join(built.nodeModulesPath, 'cwdpkg', 'where.txt'), 'utf8');
    assert.equal(embedded, built.payloadPath);
    assert.equal(fs.realpathSync(path.join(built.nodeModulesPath, 'cwdpkg', 'abs-link')), path.join(built.nodeModulesPath, 'left-pad'));
    const hit = store.ensureGeneration(lease, seedPlan(), { installer, consumer: CONSUMER });
    assert.equal(hit.payloadPath, embedded, 'the published path equals the install-time cwd');
});

test('dependency store: a build script reading AgentLib bytes changes output only through the key', (t) => {
    const root = tempRoot(t);
    const libA = makeAgentLib(root, { name: 'lib', fingerprint: 'fp-1', content: 'BYTES-ONE' });
    const provider = (lib) => hostProvider({ agentLib: lib });
    const { lease, assertLease } = fakeLease();
    const store = createCacheStore({ depsDir: path.join(root, 'deps'), workspaceRoot: root, assertLease, checkDiskSpace: () => ({ ok: true }) });
    const installer = fakeInstaller({
        extra: ({ payloadDir, options }) => {
            const dir = path.join(payloadDir, 'node_modules', 'probe');
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'agentlib.txt'), fs.readFileSync(path.join(options.agentLibSourceDir, 'data.txt')));
        },
    });
    const plan = (lib) => buildSeedInstallPlan({ provider: provider(lib), globalPackage: GLOBAL, agentLibSelection: lib });
    const one = store.ensureGeneration(lease, plan(libA), { installer, consumer: CONSUMER });
    assert.equal(fs.readFileSync(path.join(one.nodeModulesPath, 'probe', 'agentlib.txt'), 'utf8'), 'BYTES-ONE');
    fs.writeFileSync(path.join(libA.sourceDir, 'data.txt'), 'BYTES-TWO');
    const libB = { ...libA, fingerprint: 'fp-2' };
    const two = store.ensureGeneration(lease, plan(libB), { installer, consumer: CONSUMER });
    assert.notEqual(two.objectId, one.objectId);
    assert.equal(fs.readFileSync(path.join(two.nodeModulesPath, 'probe', 'agentlib.txt'), 'utf8'), 'BYTES-TWO');
    assert.equal(fs.readFileSync(path.join(one.nodeModulesPath, 'probe', 'agentlib.txt'), 'utf8'), 'BYTES-ONE', 'the old object is never rewritten');
    const same = store.ensureGeneration(lease, plan(libA), { installer, consumer: CONSUMER });
    assert.equal(same.status, 'hit', 'an unchanged fingerprint is the identity the key trusts');
    assert.equal(same.objectId, one.objectId);
    assert.equal(installer.calls.length, 2);
});

test('dependency store: tree corruption with an unchanged hidden lock is detected and rebuilt without touching the old object', (t) => {
    const { store, lease, seedPlan } = setup(t);
    const installer = fakeInstaller();
    const plan = seedPlan();
    const first = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    const lockBefore = fs.readFileSync(path.join(first.nodeModulesPath, '.package-lock.json'), 'utf8');
    const target = path.join(first.nodeModulesPath, 'left-pad', 'index.js');
    fs.writeFileSync(target, 'module.exports = "tampered";\n');
    assert.equal(fs.readFileSync(path.join(first.nodeModulesPath, '.package-lock.json'), 'utf8'), lockBefore);
    const validation = store.validateObject(first.objectId, { inputKey: plan.inputKey });
    assert.equal(validation.valid, false);
    assert.equal(validation.reason, 'installed tree hash mismatch');
    const repaired = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    assert.equal(repaired.status, 'repaired');
    assert.notEqual(repaired.objectId, first.objectId);
    assert.deepEqual(repaired.corruption, { objectId: first.objectId, reason: 'installed tree hash mismatch' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'module.exports = "tampered";\n', 'old object neither repaired nor deleted');
    assert.ok(fs.existsSync(path.join(store.paths.unusable, `${first.objectId}.json`)));
    assert.equal(store.readIndex(plan.inputKey).objectId, repaired.objectId);
    assert.equal(store.readIndex(plan.inputKey).previousObjectId, first.objectId);
});

test('dependency store: a failed rebuild is bounded and leaves the index untouched', (t) => {
    const { store, lease, seedPlan } = setup(t);
    const plan = seedPlan();
    const first = store.ensureGeneration(lease, plan, { installer: fakeInstaller(), consumer: CONSUMER });
    fs.rmSync(path.join(first.nodeModulesPath, 'left-pad', 'index.js'));
    let calls = 0;
    const broken = { describe: () => ({ kind: 'fake-npm' }), install() { calls += 1; throw Object.assign(new Error('registry down'), { code: 'E_FAKE' }); } };
    assert.throws(() => store.ensureGeneration(lease, plan, { installer: broken, consumer: CONSUMER }), (error) => {
        assert.equal(error.code, 'PLOINKY_DEPS_BUILD_FAILED');
        assert.equal(error.details.corruption.objectId, first.objectId);
        return true;
    });
    assert.equal(calls, 2, 'bounded retry');
    assert.equal(store.readIndex(plan.inputKey).objectId, first.objectId, 'admitted index entry untouched');
    const failedReceipts = fs.readdirSync(store.paths.buildReceipts).map((name) => JSON.parse(fs.readFileSync(path.join(store.paths.buildReceipts, name), 'utf8')));
    assert.deepEqual(failedReceipts.map((receipt) => receipt.state), ['failed', 'failed'], 'failed objects keep their receipts');
    assert.ok(store.describeObjects().filter((item) => item.buildReceipt?.state === 'failed').every((item) => item.retain));
});

test('dependency store: a competing index entry is accepted only after full validation', (t) => {
    const { store, lease, seedPlan, root } = setup(t);
    const plan = seedPlan();
    const installer = fakeInstaller();
    const winner = store.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    const indexFile = path.join(store.paths.index, `${plan.inputKey}.json`);
    const saved = fs.readFileSync(indexFile);
    fs.rmSync(indexFile);
    const racing = createCacheStore({
        depsDir: path.join(root, '.ploinky', 'deps'), workspaceRoot: root, assertLease: () => true, checkDiskSpace: () => ({ ok: true }),
        hooks: { at: (stage) => { if (stage === 'completion-written') fs.writeFileSync(indexFile, saved); } },
    });
    const result = racing.ensureGeneration(lease, plan, { installer, consumer: CONSUMER });
    assert.equal(result.status, 'winner-accepted');
    assert.equal(result.objectId, winner.objectId);
    assert.ok(result.supersededObjectId);
    const superseded = racing.describeObjects().find((item) => item.objectId === result.supersededObjectId);
    assert.equal(superseded.buildReceipt.state, 'superseded');
    assert.equal(superseded.retain, true);

    // An empty directory or a missing manifest is never accepted as a winner.
    const bogusId = '00000000-0000-4000-8000-000000000000';
    const plan2 = seedPlan({ globalPackage: { ...GLOBAL, dependencies: { other: '1.0.0' } } });
    const index2 = path.join(store.paths.index, `${plan2.inputKey}.json`);
    const bogus = createCacheStore({
        depsDir: path.join(root, '.ploinky', 'deps'), workspaceRoot: root, assertLease: () => true, checkDiskSpace: () => ({ ok: true }),
        hooks: {
            at: (stage) => {
                if (stage !== 'completion-written') return;
                fs.mkdirSync(path.join(store.paths.objects, bogusId, 'payload'), { recursive: true });
                fs.writeFileSync(index2, JSON.stringify({ objectId: bogusId, inputKey: plan2.inputKey }));
            },
        },
    });
    const published = bogus.ensureGeneration(lease, plan2, { installer, consumer: CONSUMER });
    assert.equal(published.status, 'built');
    assert.equal(store.readIndex(plan2.inputKey).objectId, published.objectId);
    assert.ok(fs.existsSync(path.join(store.paths.unusable, `${bogusId}.json`)));
});

test('dependency store: an index entry whose object was built for another key is a miss', (t) => {
    const { store, lease, seedPlan } = setup(t);
    const installer = fakeInstaller();
    const planA = seedPlan();
    const planB = seedPlan({ globalPackage: { ...GLOBAL, dependencies: { 'right-pad': '1.0.0' } } });
    const a = store.ensureGeneration(lease, planA, { installer, consumer: CONSUMER });
    fs.writeFileSync(path.join(store.paths.index, `${planB.inputKey}.json`), JSON.stringify({ objectId: a.objectId, inputKey: planB.inputKey }));
    const b = store.ensureGeneration(lease, planB, { installer, consumer: CONSUMER });
    assert.equal(b.status, 'repaired');
    assert.equal(b.corruption.reason, 'full input key mismatch');
    assert.notEqual(b.objectId, a.objectId);
});

test('dependency store: agents without npm copy an exact seed; a valid agent hit does no seed work', (t) => {
    const { store, lease, seedPlan, agentPlan } = setup(t);
    const installer = fakeInstaller({
        extra: ({ payloadDir }) => {
            fs.mkdirSync(path.join(payloadDir, 'node_modules', '.bin'), { recursive: true });
            fs.symlinkSync('../left-pad/index.js', path.join(payloadDir, 'node_modules', '.bin', 'left-pad'));
        },
    });
    const agent = store.ensureAgentGeneration(lease, { agentPlan: agentPlan(), seedPlan: seedPlan(), installer, consumer: CONSUMER });
    assert.equal(agent.status, 'built');
    assert.equal(agent.seedDecision, 'exact seed contract');
    assert.equal(installer.calls.length, 1, 'only the seed ran npm');
    const seedObject = store.readIndex(seedPlan().inputKey).objectId;
    const seedModules = path.join(store.paths.objects, seedObject, 'payload', 'node_modules');
    const seedEntries = listFiles(seedModules);
    const agentEntries = listFiles(agent.nodeModulesPath);
    assert.deepEqual(agentEntries.map((entry) => [entry.rel, entry.link]), seedEntries.map((entry) => [entry.rel, entry.link]),
        'symlink text is preserved exactly');
    for (const entry of agentEntries.filter((item) => item.stat.isFile())) {
        const seedStat = seedEntries.find((item) => item.rel === entry.rel).stat;
        assert.notEqual(entry.stat.ino, seedStat.ino, `${entry.rel} is copied, not hardlinked`);
        assert.equal(entry.stat.nlink, 1);
    }
    assert.equal(fs.readdirSync(store.paths.readerReceipts).length, 1, 'the seed-copy receipt is released after copying');
    // Corrupt the seed: a valid agent hit must not even look at it.
    fs.appendFileSync(path.join(seedModules, 'left-pad', 'index.js'), '//x');
    const hit = store.ensureAgentGeneration(lease, { agentPlan: agentPlan(), seedPlan: seedPlan(), installer, consumer: CONSUMER });
    assert.equal(hit.status, 'hit');
    assert.equal(fs.existsSync(path.join(store.paths.unusable, `${seedObject}.json`)), false, 'seed untouched');
    // Another agent needing the seed repairs it automatically.
    const other = store.ensureAgentGeneration(lease, { agentPlan: agentPlan({ registration: 'repo/other', rebuildToken: 'other-token' }), seedPlan: seedPlan(), installer, consumer: CONSUMER });
    assert.equal(other.seed.status, 'repaired');
    assert.equal(installer.calls.length, 2);
    assert.ok(fs.existsSync(path.join(store.paths.unusable, `${seedObject}.json`)));
});

test('dependency store: reinstall builds the target from empty state without seeds and leaves other aliases intact', (t) => {
    const { store, lease, seedPlan, agentPlan } = setup(t);
    const installer = fakeInstaller();
    const alias = store.ensureAgentGeneration(lease, { agentPlan: agentPlan({ registration: 'repo/agent#b' }), seedPlan: seedPlan(), installer, consumer: CONSUMER });
    const target = store.ensureAgentGeneration(lease, { agentPlan: agentPlan(), seedPlan: seedPlan(), installer, consumer: CONSUMER });
    const aliasHash = hashInstalledTree(alias.payloadPath, { approvedExternalTargets: [seedPlan().providers.agentLib.linkTarget] }).hash;
    const seedId = store.readIndex(seedPlan().inputKey).objectId;
    const seedHash = hashInstalledTree(path.join(store.paths.objects, seedId, 'payload'), { approvedExternalTargets: [seedPlan().providers.agentLib.linkTarget] }).hash;
    const callsBefore = installer.calls.length;
    const rebuilt = store.ensureAgentGeneration(lease, {
        agentPlan: agentPlan({ rebuildToken: 'rebuild-1' }), seedPlan: seedPlan(), installer, consumer: CONSUMER, reinstall: true,
    });
    assert.equal(rebuilt.status, 'reinstalled');
    assert.equal(rebuilt.seed, null);
    assert.equal(rebuilt.seedDecision, 'target reinstall bypasses seeds');
    assert.equal(installer.calls.length, callsBefore + 1, 'npm ran for the target from an empty payload');
    assert.notEqual(rebuilt.objectId, target.objectId);
    assert.equal(hashInstalledTree(alias.payloadPath, { approvedExternalTargets: [seedPlan().providers.agentLib.linkTarget] }).hash, aliasHash);
    assert.equal(hashInstalledTree(path.join(store.paths.objects, seedId, 'payload'), { approvedExternalTargets: [seedPlan().providers.agentLib.linkTarget] }).hash, seedHash);
    assert.equal(store.validateObject(target.objectId, { inputKey: agentPlan().inputKey }).valid, true, 'previous admitted object kept');
});

test('dependency store: provenance mismatches, missing metadata and unsafe trees prevent publication without retries', (t) => {
    const url = 'git+file:///srv/tool.git';
    const globalPackage = { name: 'g', version: '1.0.0', dependencies: { tool: `${url}#${SHA_A}` } };
    const { store, lease, seedPlan } = setup(t, { globalPackage });
    const plan = seedPlan();
    const wrong = fakeInstaller({ resolveGit: () => `${url}#${SHA_B}` });
    assert.throws(() => store.ensureGeneration(lease, plan, { installer: wrong, consumer: CONSUMER }),
        (error) => error.code === 'PLOINKY_DEPS_BUILD_FAILED' && error.cause.code === 'PLOINKY_DEPS_PROVENANCE_MISMATCH');
    assert.equal(wrong.calls.length, 1);
    const otherSource = fakeInstaller({ resolveGit: () => `git+file:///srv/fork.git#${SHA_A}` });
    assert.throws(() => store.ensureGeneration(lease, plan, { installer: otherSource, consumer: CONSUMER }), /resolved from file:\/\/\/srv\/fork\.git/);
    const missing = fakeInstaller({ resolveGit: () => null });
    assert.throws(() => store.ensureGeneration(lease, plan, { installer: missing, consumer: CONSUMER }), /no matching installer resolution metadata/);
    const escaping = fakeInstaller({ extra: ({ payloadDir }) => fs.symlinkSync('/etc', path.join(payloadDir, 'node_modules', 'escape')) });
    assert.throws(() => store.ensureGeneration(lease, seedPlan({ globalPackage: GLOBAL }), { installer: escaping, consumer: CONSUMER }),
        (error) => error.cause.code === 'PLOINKY_DEPS_TREE_UNSAFE');
    assert.equal(escaping.calls.length, 1);
    assert.equal(store.readIndex(plan.inputKey), null);
    assert.ok(store.describeObjects().every((item) => !item.complete));
});

test('dependency store: disk space, lease capability and unknown formats fail before any object is created', (t) => {
    const { store, lease, seedPlan, root } = setup(t, { storeOptions: { checkDiskSpace: () => ({ ok: false, availableBytes: 10 }) } });
    const installer = fakeInstaller();
    assert.throws(() => store.ensureGeneration(lease, seedPlan(), { installer, consumer: CONSUMER }),
        (error) => error.cause.code === 'PLOINKY_DEPS_DISK_SPACE');
    assert.equal(installer.calls.length, 0);
    assert.deepEqual(fs.readdirSync(store.paths.objects), []);
    assert.throws(() => store.ensureGeneration({ token: 'forged' }, seedPlan(), { installer, consumer: CONSUMER }),
        { code: 'PLOINKY_WORKSPACE_MUTATION_CAPABILITY_REQUIRED' });
    fs.writeFileSync(store.paths.format, JSON.stringify({ format: 'ploinky-deps-cache', version: 99 }));
    const ok = createCacheStore({ depsDir: path.join(root, '.ploinky', 'deps'), workspaceRoot: root, assertLease: () => true, checkDiskSpace: () => ({ ok: true }) });
    assert.throws(() => ok.ensureGeneration(lease, seedPlan(), { installer, consumer: CONSUMER }), { code: 'PLOINKY_DEPS_STORE_FORMAT_UNKNOWN' });
});

test('dependency store: objects from another workspace are never adopted', (t) => {
    const { store, lease, seedPlan, root } = setup(t);
    const installer = fakeInstaller();
    const built = store.ensureGeneration(lease, seedPlan(), { installer, consumer: CONSUMER });
    const otherRoot = tempRoot(t);
    const foreign = createCacheStore({ depsDir: path.join(root, '.ploinky', 'deps'), workspaceRoot: otherRoot, assertLease: () => true });
    assert.equal(foreign.validateObject(built.objectId, { inputKey: seedPlan().inputKey }).reason, 'object belongs to another workspace');
});

test('dependency store: stale receipts are removed only with positive quiescence proof', (t) => {
    const { store, lease, seedPlan } = setup(t);
    const built = store.ensureGeneration(lease, seedPlan(), { installer: fakeInstaller(), consumer: { kind: 'container', engine: 'podman', containerName: 'agent_x' } });
    const retained = store.removeStaleReceipt(lease, built.readerReceipt.path, { proof: () => ({ quiescent: false, reason: 'container present' }) });
    assert.deepEqual(retained, { removed: false, reason: 'container present' });
    assert.ok(fs.existsSync(built.readerReceipt.path));
    store.updateReaderReceipt(lease, built.readerReceipt, { containerId: 'abc123', phase: 'running' });
    assert.equal(JSON.parse(fs.readFileSync(built.readerReceipt.path, 'utf8')).consumer.phase, 'running');
    const removed = store.removeStaleReceipt(lease, built.readerReceipt.path, { proof: () => ({ quiescent: true, reason: 'container absent' }) });
    assert.equal(removed.removed, true);
    assert.throws(() => store.removeStaleReceipt(lease, path.join(store.paths.objects, 'x.json')), { code: 'PLOINKY_DEPS_RECEIPT_INVALID' });
});

test('dependency store: build and lookup paths never perform moving-ref discovery', () => {
    const source = fs.readFileSync(path.join(HERE, '../../cli/utils/dependencies/store/objectStore.mjs'), 'utf8');
    assert.equal(/discoverGitPins|defaultRunGit|ls-remote/.test(source), false);
    const contract = fs.readFileSync(path.join(HERE, '../../cli/utils/dependencies/store/installContract.mjs'), 'utf8');
    assert.equal(/discoverGitPins|defaultRunGit/.test(contract), false);
});

test('dependency store: a retried reinstall with the same token reuses its object instead of duplicating it', (t) => {
    const { store, lease, seedPlan, agentPlan } = setup(t);
    const installer = fakeInstaller();
    const request = { agentPlan: agentPlan({ rebuildToken: 'rebuild-7' }), seedPlan: seedPlan(), installer, consumer: CONSUMER, reinstall: true };
    const first = store.ensureAgentGeneration(lease, request);
    assert.equal(first.status, 'reinstalled');
    const calls = installer.calls.length;
    const retry = store.ensureAgentGeneration(lease, request);
    assert.equal(retry.status, 'hit');
    assert.equal(retry.objectId, first.objectId);
    assert.equal(installer.calls.length, calls);
    assert.equal(store.describeObjects().some((item) => item.buildReceipt?.state === 'superseded'), false);
});

test('dependency store: the in-Box seed copy uses cp -a, preserving symlink text without hardlinks', { skip: process.platform === 'win32' }, (t) => {
    const root = tempRoot(t);
    const source = path.join(root, 'seed');
    fs.mkdirSync(path.join(source, 'pkg', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'pkg', 'index.js'), 'x');
    fs.symlinkSync('../index.js', path.join(source, 'pkg', '.bin', 'cli'));
    fs.symlinkSync('/opt/ploinky-agentlib', path.join(source, 'achillesAgentLib'));
    const destination = path.join(root, 'agent', 'node_modules');
    fs.mkdirSync(destination, { recursive: true });
    let used = null;
    defaultCopySeed(source, destination, {
        insideBox: true,
        spawn: (command, args, options) => { used = [command, ...args]; return spawnSyncReal(command, args, options); },
    });
    assert.deepEqual(used, ['cp', '-a', source, destination]);
    assert.equal(fs.readlinkSync(path.join(destination, 'pkg', '.bin', 'cli')), '../index.js');
    assert.equal(fs.readlinkSync(path.join(destination, 'achillesAgentLib')), '/opt/ploinky-agentlib');
    assert.notEqual(fs.statSync(path.join(destination, 'pkg', 'index.js')).ino, fs.statSync(path.join(source, 'pkg', 'index.js')).ino);
    assert.throws(() => defaultCopySeed(path.join(root, 'missing'), destination, { insideBox: true }), { code: 'PLOINKY_DEPS_SEED_COPY_FAILED' });
});
