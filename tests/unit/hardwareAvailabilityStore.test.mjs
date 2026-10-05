// M-NW-01 D1: the durable hardware-availability store, its external witness, the
// reader, init/upgrade/restore under the edge apply lock, the single-rename commit
// and the dead-owner temp sweep. Real filesystem; real SIGKILL through a driver.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { initializeFreshEdgeRoutingSources } from '../../cli/sandbox/edgeGeneration.js';
import {
    MAX_HARDWARE_AVAILABILITY_POLICY_BYTES,
    commitHardwareAvailabilityPolicy,
    computeHardwareAvailabilityRevision,
    installHardwareAvailabilityStore,
    readHardwareAvailabilityPolicy,
    restoreHardwareAvailabilityWitness,
    serializeHardwareAvailabilityPolicy,
    sweepHardwareAvailabilityTemps,
} from '../../cli/sandbox/hardwareAvailabilityStore.mjs';
import {
    DEAD_UUID,
    SCHEMA,
    commit,
    deadPid,
    entryFor,
    fsError,
    inode,
    lockAssertion,
    makeWorkspace,
    sha256,
    spyFs,
    underApplyLock,
    uuid,
} from './hardwareAvailabilityFixtures.mjs';

const DRIVER = path.resolve(import.meta.dirname, 'hardwareAvailabilityStoreDriver.mjs');
const ROOT = path.resolve(import.meta.dirname, '../..');
const href = (relative) => pathToFileURL(path.join(ROOT, relative)).href;
const UNREADABLE = 'HARDWARE_AVAILABILITY_POLICY_UNREADABLE';
const SOURCE_UNAVAILABLE = 'EDGE_GENERATION_SOURCE_UNAVAILABLE';

const init = (root, hooks) => initializeFreshEdgeRoutingSources({
    workspaceRoot: root,
    ...(hooks ? { testHooks: { hardwareAvailability: hooks } } : {}),
});
const readStore = (paths) => readHardwareAvailabilityPolicy({ paths });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const storeNames = (paths) => fs.readdirSync(paths.availabilityStoreDir).sort();
const edgeTemps = (paths) => fs.readdirSync(paths.edgeDir).filter((name) => name.endsWith('.tmp'));

function entriesOf(...routeKeys) {
    return Object.fromEntries(routeKeys.map((routeKey) => [routeKey, entryFor(routeKey)]));
}

function initWithEntries(t, ...routeKeys) {
    const workspace = makeWorkspace(t);
    init(workspace.root);
    if (routeKeys.length) {
        const current = readStore(workspace.paths);
        commit(workspace.root, workspace.paths, { expectedRevision: current.revision, entries: entriesOf(...routeKeys) });
    }
    return workspace;
}

// A recursive picture of the edge directory: relative path, kind, content digest or link target.
function snapshotTree(directory, relative = '') {
    const result = {};
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
        if (name === 'apply.lock') continue;
        const rel = path.join(relative, name);
        const full = path.join(directory, rel);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) result[rel] = `link:${fs.readlinkSync(full)}`;
        else if (stat.isDirectory()) {
            result[rel] = 'dir';
            Object.assign(result, snapshotTree(directory, rel));
        } else result[rel] = `file:${sha256(full)}`;
    }
    return result;
}

function driverNodeArgs(...args) {
    return [
        '--import', href('tests/helpers/agentlibTestContract.mjs'),
        '--import', href('tests/helpers/engineSpawnGuard.mjs'),
        ...(process.env.C5_MUTATION ? ['--import', href('tests/hardware-limits/c5MutationRegister.mjs')] : []),
        DRIVER,
        ...args,
    ];
}

function runDriver(phase, root, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, driverNodeArgs(phase, root, JSON.stringify(options)), { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', () => {
            const line = stdout.trim().split('\n').filter(Boolean).at(-1);
            try { resolve(JSON.parse(line)); } catch (_) { reject(new Error(`driver ${phase} gave no result: ${stdout}\n${stderr}`)); }
        });
    });
}

// Start a driver that pauses at `pauseAt`, wait until it is paused, SIGKILL it.
async function killAt(t, phase, root, options, pauseAt) {
    const signalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwa-sig-'));
    t.after(() => fs.rmSync(signalDir, { recursive: true, force: true }));
    const child = spawn(process.execPath, driverNodeArgs(phase, root, JSON.stringify({ ...options, pauseAt, signalDir })), { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const marker = path.join(signalDir, `paused.${pauseAt}`);
    const deadline = Date.now() + 60_000;
    let early = null;
    exited.then((value) => { early = value; });
    while (!fs.existsSync(marker)) {
        if (early) throw new Error(`driver ended before pausing at ${pauseAt}: ${JSON.stringify(early)}\n${output}`);
        if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error(`driver did not reach ${pauseAt}\n${output}`); }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill('SIGKILL');
    const result = await exited;
    assert.equal(result.signal, 'SIGKILL');
    return { pid: child.pid };
}

test('NW1.D1-fresh-init-installs-the-store-and-witness-before-the-four-sources', (t) => {
    const happy = makeWorkspace(t);
    let sourcesAtWitness = null;
    const result = init(happy.root, {
        faults: { afterWitnessLink: () => { sourcesAtWitness = fs.existsSync(happy.paths.routingFile); } },
    });
    assert.equal(sourcesAtWitness, false, 'the witness is written before any source exists');
    assert.equal(result.initialized, true);
    assert.equal(result.hardwareAvailability, 'installed-fresh');
    const witness = readJson(happy.paths.availabilityWitnessFile);
    assert.equal(witness.initializedBy, 'fresh');
    const snapshot = readStore(happy.paths);
    assert.deepEqual([snapshot.state, snapshot.storeId, snapshot.diagnostic], ['valid', witness.storeId, null]);
    assert.deepEqual(snapshot.entries, {});
    assert.deepEqual(snapshot.slots, {});
    assert.equal(snapshot.revision, computeHardwareAvailabilityRevision({ schema: SCHEMA, storeId: witness.storeId, entries: {}, slots: {} }));
    assert.equal(fs.statSync(happy.paths.availabilityStoreDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(happy.paths.availabilityPolicyFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(happy.paths.availabilityWitnessFile).mode & 0o777, 0o600);

    // A fault after the directory rename and before the witness: the next init
    // restores the witness with the same storeId, then installs the sources.
    const faulted = makeWorkspace(t);
    assert.throws(() => init(faulted.root, { faults: { afterDirectoryRename: () => { throw new Error('injected'); } } }), /injected/);
    const storeId = readJson(faulted.paths.availabilityPolicyFile).storeId;
    assert.equal(fs.existsSync(faulted.paths.availabilityWitnessFile), false);
    assert.equal(fs.existsSync(faulted.paths.routingFile), false);
    const second = init(faulted.root);
    assert.equal(second.initialized, true);
    assert.equal(second.hardwareAvailability, 'witness-restored');
    const restored = readJson(faulted.paths.availabilityWitnessFile);
    assert.deepEqual([restored.storeId, restored.initializedBy], [storeId, 'restored']);
    assert.equal(fs.existsSync(faulted.paths.routingFile), true);
});

test('NW1.D1-upgrade-installs-only-when-both-witness-and-store-directory-are-absent', (t) => {
    // A workspace of the base revision: four sources and generation evidence, no witness, no store.
    const upgrade = makeWorkspace(t);
    init(upgrade.root);
    fs.rmSync(upgrade.paths.availabilityWitnessFile);
    fs.rmSync(upgrade.paths.availabilityStoreDir, { recursive: true });
    fs.mkdirSync(path.join(upgrade.paths.edgeDir, 'generations'), { recursive: true });
    fs.writeFileSync(path.join(upgrade.paths.edgeDir, 'generations', 'evidence.json'), '{}');
    const result = init(upgrade.root);
    assert.deepEqual([result.initialized, result.hardwareAvailability], [false, 'installed-upgrade']);
    assert.equal(readJson(upgrade.paths.availabilityWitnessFile).initializedBy, 'upgrade');
    const snapshot = readStore(upgrade.paths);
    assert.deepEqual([snapshot.state, snapshot.entries, snapshot.slots], ['valid', {}, {}]);

    // Witness present with the directory absent is never an install.
    const lost = initWithEntries(t, 'alpha');
    fs.rmSync(lost.paths.availabilityStoreDir, { recursive: true });
    assert.throws(() => init(lost.root), (error) => error.code === SOURCE_UNAVAILABLE);
    assert.equal(fs.existsSync(lost.paths.availabilityStoreDir), false);

    // Directory present with the witness absent restores the witness and keeps the store.
    const kept = initWithEntries(t, 'alpha');
    const policyInode = inode(kept.paths.availabilityPolicyFile);
    const storeId = readJson(kept.paths.availabilityPolicyFile).storeId;
    fs.rmSync(kept.paths.availabilityWitnessFile);
    assert.equal(init(kept.root).hardwareAvailability, 'witness-restored');
    assert.equal(inode(kept.paths.availabilityPolicyFile), policyInode);
    assert.equal(readJson(kept.paths.availabilityWitnessFile).storeId, storeId);

    // Partial sources keep the existing refusal and install nothing.
    const partial = makeWorkspace(t);
    init(partial.root);
    fs.rmSync(partial.paths.availabilityWitnessFile);
    fs.rmSync(partial.paths.availabilityStoreDir, { recursive: true });
    fs.rmSync(partial.paths.desiredFile);
    assert.throws(() => init(partial.root), /edge routing sources are incomplete/);
    assert.equal(fs.existsSync(partial.paths.availabilityStoreDir), false);
    assert.equal(fs.existsSync(partial.paths.availabilityWitnessFile), false);
});

test('NW1.D1-init-never-replaces-or-empties-a-present-store', (t) => {
    const picture = ({ paths }) => ({
        policy: sha256(paths.availabilityPolicyFile),
        policyInode: inode(paths.availabilityPolicyFile),
        directoryInode: inode(paths.availabilityStoreDir),
    });
    // All four sources present, with the witness, and without it.
    const complete = initWithEntries(t, 'alpha', 'beta');
    const before = picture(complete);
    assert.equal(init(complete.root).hardwareAvailability, 'kept');
    assert.deepEqual(picture(complete), before);
    fs.rmSync(complete.paths.availabilityWitnessFile);
    assert.equal(init(complete.root).hardwareAvailability, 'witness-restored');
    assert.deepEqual(picture(complete), before);
    assert.deepEqual(Object.keys(readStore(complete.paths).entries), ['alpha', 'beta']);

    // No sources and no generation evidence, with the witness, and without it.
    const empty = initWithEntries(t, 'alpha', 'beta');
    const emptyBefore = picture(empty);
    for (const source of [empty.paths.routingFile, empty.paths.agentsFile, empty.paths.policyFile, empty.paths.desiredFile]) fs.rmSync(source);
    const first = init(empty.root);
    assert.deepEqual([first.initialized, first.hardwareAvailability], [true, 'kept']);
    assert.deepEqual(picture(empty), emptyBefore);
    fs.rmSync(empty.paths.availabilityWitnessFile);
    for (const source of [empty.paths.routingFile, empty.paths.agentsFile, empty.paths.policyFile, empty.paths.desiredFile]) fs.rmSync(source);
    const second = init(empty.root);
    assert.deepEqual([second.initialized, second.hardwareAvailability], [true, 'witness-restored']);
    assert.deepEqual(picture(empty), emptyBefore);
});

function reseal(document) {
    const { schema, storeId, entries, slots } = document;
    return { ...document, revision: computeHardwareAvailabilityRevision({ schema, storeId, entries, slots }) };
}
const MARKER = 'SECRET-MARKER-DO-NOT-ECHO';

test('NW1.D1-missing-emptied-or-corrupt-store-refuses-init-and-fails-the-reader-closed', async (t) => {
    const variants = {
        'a deleted policy.json': ({ paths }) => { fs.rmSync(paths.availabilityPolicyFile); fs.writeFileSync(path.join(paths.availabilityStoreDir, 'stray'), 'x'); },
        'a2 deleted policy.json and no witness': ({ paths }) => { fs.rmSync(paths.availabilityPolicyFile); fs.rmSync(paths.availabilityWitnessFile); fs.writeFileSync(path.join(paths.availabilityStoreDir, 'stray'), 'x'); },
        'b2 emptied directory and no witness': ({ paths }) => {
            for (const name of fs.readdirSync(paths.availabilityStoreDir)) fs.rmSync(path.join(paths.availabilityStoreDir, name), { recursive: true });
            fs.rmSync(paths.availabilityWitnessFile);
        },
        'b emptied directory': ({ paths }) => { for (const name of fs.readdirSync(paths.availabilityStoreDir)) fs.rmSync(path.join(paths.availabilityStoreDir, name), { recursive: true }); },
        'c truncated policy': ({ paths }) => { const bytes = fs.readFileSync(paths.availabilityPolicyFile); fs.writeFileSync(paths.availabilityPolicyFile, bytes.subarray(0, bytes.length / 2)); },
        'd unknown key': ({ paths }) => { fs.writeFileSync(paths.availabilityPolicyFile, JSON.stringify({ ...readJson(paths.availabilityPolicyFile), [MARKER]: MARKER })); },
        'e policy storeId differs from the witness': ({ paths }) => {
            fs.writeFileSync(paths.availabilityPolicyFile, JSON.stringify(reseal({ ...readJson(paths.availabilityPolicyFile), storeId: 'a'.repeat(32) })));
        },
        'f revision mismatch': ({ paths }) => { fs.writeFileSync(paths.availabilityPolicyFile, JSON.stringify({ ...readJson(paths.availabilityPolicyFile), revision: `sha256:${'0'.repeat(64)}` })); },
        'g policy.json is a symlink': ({ paths }) => {
            fs.renameSync(paths.availabilityPolicyFile, `${paths.availabilityPolicyFile}.real`);
            fs.symlinkSync(`${paths.availabilityPolicyFile}.real`, paths.availabilityPolicyFile);
        },
        'h oversize policy': ({ paths }) => { fs.writeFileSync(paths.availabilityPolicyFile, Buffer.alloc(MAX_HARDWARE_AVAILABILITY_POLICY_BYTES + 1, 0x20)); },
        'i policy.json is a directory': ({ paths }) => { fs.rmSync(paths.availabilityPolicyFile); fs.mkdirSync(paths.availabilityPolicyFile); },
        'j unknown schema': ({ paths }) => {
            fs.writeFileSync(paths.availabilityPolicyFile, JSON.stringify(reseal({ ...readJson(paths.availabilityPolicyFile), schema: 'ploinky.hardware-availability/v2' })));
        },
        'k store directory is a symlink to a real directory': ({ paths }) => {
            fs.renameSync(paths.availabilityStoreDir, `${paths.availabilityStoreDir}.real`);
            fs.symlinkSync(`${paths.availabilityStoreDir}.real`, paths.availabilityStoreDir);
        },
        'l whole store directory removed with the witness present': ({ paths }) => { fs.rmSync(paths.availabilityStoreDir, { recursive: true }); },
        'm witness storeId mismatch': ({ paths }) => {
            fs.writeFileSync(paths.availabilityWitnessFile, JSON.stringify({ ...readJson(paths.availabilityWitnessFile), storeId: 'b'.repeat(32) }));
        },
        'n corrupt witness': ({ paths }) => { fs.writeFileSync(paths.availabilityWitnessFile, '{"schema":1,'); },
        'n2 witness with an extra key': ({ paths }) => { fs.writeFileSync(paths.availabilityWitnessFile, JSON.stringify({ ...readJson(paths.availabilityWitnessFile), extra: MARKER })); },
    };
    for (const [label, damage] of Object.entries(variants)) {
        await t.test(label, () => {
            const workspace = initWithEntries(t, 'alpha', 'beta');
            damage(workspace);
            const before = snapshotTree(workspace.paths.ploinkyDir);
            assert.throws(() => readStore(workspace.paths), (error) => (
                error.code === UNREADABLE
                && error.message.includes(workspace.paths.edgeDir)
                && !error.message.includes(MARKER)
            ));
            assert.throws(() => init(workspace.root), (error) => error.code === SOURCE_UNAVAILABLE && !error.message.includes(MARKER));
            assert.deepEqual(snapshotTree(workspace.paths.ploinkyDir), before, 'init changes no byte');
        });
    }
});

test('NW1.D1-an-absent-store-without-a-witness-reads-as-the-absent-revision', (t) => {
    const workspace = makeWorkspace(t);
    assert.deepEqual(readStore(workspace.paths), { state: 'absent', revision: 'absent', entries: {}, slots: {} });
    fs.mkdirSync(workspace.paths.edgeDir, { recursive: true });
    assert.equal(readStore(workspace.paths).state, 'absent');

    // A witness alone is never "absent".
    const witnessOnly = makeWorkspace(t);
    init(witnessOnly.root);
    fs.rmSync(witnessOnly.paths.availabilityStoreDir, { recursive: true });
    assert.throws(() => readStore(witnessOnly.paths), (error) => error.code === UNREADABLE && /missing after initialization/.test(error.message));

    // A directory alone is the store (its witness is restored by init).
    const directoryOnly = makeWorkspace(t);
    init(directoryOnly.root);
    fs.rmSync(directoryOnly.paths.availabilityWitnessFile);
    assert.equal(readStore(directoryOnly.paths).state, 'valid');
});

test('NW1.D1-an-interrupted-install-is-swept-reinstalled-or-completed', (t) => {
    // KI-1: an install killed before the directory rename left a dead-owner staging directory.
    const killed = makeWorkspace(t);
    fs.mkdirSync(killed.paths.edgeDir, { recursive: true });
    const dead = deadPid();
    const deadStaging = path.join(killed.paths.edgeDir, `.hardware-availability.${dead}.${uuid()}.tmp`);
    fs.mkdirSync(deadStaging, { mode: 0o700 });
    fs.writeFileSync(path.join(deadStaging, 'policy.json'), 'partial');
    const deadWitnessTemp = path.join(killed.paths.edgeDir, `.hardware-availability.witness.json.${dead}.${uuid()}.tmp`);
    fs.writeFileSync(deadWitnessTemp, 'partial');
    // A live owner's staging directory is kept.
    const liveStaging = path.join(killed.paths.edgeDir, `.hardware-availability.${process.pid}.${uuid()}.tmp`);
    fs.mkdirSync(liveStaging, { mode: 0o700 });
    const result = init(killed.root);
    assert.equal(result.hardwareAvailability, 'installed-fresh');
    assert.equal(fs.existsSync(deadStaging), false);
    assert.equal(fs.existsSync(deadWitnessTemp), false);
    assert.equal(fs.existsSync(liveStaging), true);
    assert.equal(readStore(killed.paths).state, 'valid');

    // KI-2: an install killed after the directory rename and before the witness.
    const completed = makeWorkspace(t);
    assert.throws(() => init(completed.root, { faults: { afterEdgeDirectoryFsync: () => { throw new Error('injected'); } } }), /injected/);
    const storeId = readJson(completed.paths.availabilityPolicyFile).storeId;
    assert.deepEqual([readStore(completed.paths).state, readStore(completed.paths).diagnostic], ['valid', 'witness-missing']);
    assert.equal(init(completed.root).hardwareAvailability, 'witness-restored');
    assert.equal(readJson(completed.paths.availabilityWitnessFile).storeId, storeId);
    assert.equal(readStore(completed.paths).diagnostic, null);
});

test('NW1.D1-concurrent-init-installs-exactly-one-store', async (t) => {
    const workspace = makeWorkspace(t);
    const barrier = path.join(workspace.root, 'go');
    const runs = [runDriver('init', workspace.root, { barrier }), runDriver('init', workspace.root, { barrier })];
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(barrier, '');
    const results = await Promise.all(runs);
    for (const result of results) {
        assert.ok(result.ok || result.code === 'EDGE_GENERATION_BUSY', JSON.stringify(result));
    }
    assert.ok(results.some((result) => result.ok), 'at least one init completed');
    // The loser (if any) simply retries.
    init(workspace.root);
    const witness = readJson(workspace.paths.availabilityWitnessFile);
    assert.equal(witness.storeId, readJson(workspace.paths.availabilityPolicyFile).storeId);
    assert.equal(fs.readdirSync(workspace.paths.edgeDir).filter((name) => name.startsWith('hardware-availability')).sort().join(), 'hardware-availability,hardware-availability.witness.json');
    assert.deepEqual(edgeTemps(workspace.paths), []);
});

test('NW1.D1-a-commit-is-one-rename-and-thrown-pre-rename-failures-keep-the-old-policy', (t) => {
    const workspace = initWithEntries(t, 'alpha');
    const { paths, root } = workspace;
    const policyRenames = (calls) => calls.filter((call) => call.op === 'rename' && call.to === paths.availabilityPolicyFile);

    // A successful commit: temp fsync, then exactly one rename of policy.json, then the directory fsync.
    const spy = spyFs();
    const base = readStore(paths);
    const result = commit(root, paths, { expectedRevision: base.revision, entries: entriesOf('alpha', 'beta'), fsApi: spy.api });
    assert.equal(result.committed, true);
    const renames = policyRenames(spy.calls);
    assert.equal(renames.length, 1);
    assert.match(path.basename(renames[0].from), /^\.policy\.json\.\d+\.[0-9a-f-]{36}\.tmp$/);
    const order = spy.calls.map((call) => `${call.op}:${call.path ?? call.to ?? ''}`);
    const tempFsync = spy.calls.findIndex((call) => call.op === 'fsync' && call.path === renames[0].from);
    const renameAt = spy.calls.findIndex((call) => call.op === 'rename' && call.to === paths.availabilityPolicyFile);
    const directoryFsync = spy.calls.findIndex((call) => call.op === 'fsync' && call.path === paths.availabilityStoreDir);
    assert.ok(tempFsync >= 0 && tempFsync < renameAt && renameAt < directoryFsync, order.join('\n'));
    assert.deepEqual(storeNames(paths), ['policy.json']);

    // Failures before the rename keep the old bytes, remove the own temp and rename nothing.
    const failures = {
        'beforeTemp throws': () => ({ beforeTemp: () => { throw new Error('before-temp'); } }),
        'beforeRename throws': () => ({ beforeRename: () => { throw new Error('before-rename'); } }),
        'ENOSPC on the temp write': () => ({ overrides: { writeFileSync: (target, data, options, resolved) => { if (/\.policy\.json\./.test(resolved || '')) throw fsError('ENOSPC'); return fs.writeFileSync(target, data, options); } } }),
        'EIO on the temp fsync': () => ({ overrides: { fsyncSync: (descriptor, resolved) => { if (/\.policy\.json\./.test(resolved || '')) throw fsError('EIO'); return fs.fsyncSync(descriptor); } } }),
        'EXDEV on the rename': () => ({ overrides: { renameSync: () => { throw fsError('EXDEV'); } } }),
    };
    for (const [label, build] of Object.entries(failures)) {
        const { overrides, ...hooks } = build();
        const failing = spyFs(overrides);
        const bytes = sha256(paths.availabilityPolicyFile);
        const current = readStore(paths);
        assert.throws(() => commit(root, paths, {
            expectedRevision: current.revision,
            entries: entriesOf('alpha', 'beta', 'gamma'),
            fsApi: failing.api,
            ...hooks,
        }), /before-temp|before-rename|ENOSPC|EIO|EXDEV/, label);
        assert.equal(sha256(paths.availabilityPolicyFile), bytes, label);
        assert.deepEqual(storeNames(paths), ['policy.json'], `${label}: the own temp is removed`);
        assert.equal(policyRenames(failing.calls).length, /EXDEV/.test(label) ? 1 : 0, `${label}: only the refused EXDEV rename was attempted`);
    }
    // A stale expected revision is a conflict and writes nothing.
    assert.throws(() => commit(root, paths, { expectedRevision: base.revision, entries: entriesOf('zeta') }), (error) => (
        error.code === 'HARDWARE_AVAILABILITY_REVISION_CONFLICT' && error.committed === false
    ));
});

test('NW1.D1-a-post-rename-fsync-failure-is-committed-and-never-rolled-back', (t) => {
    const workspace = initWithEntries(t, 'alpha');
    const { paths, root } = workspace;
    const spy = spyFs({
        fsyncSync: (descriptor, resolved) => {
            if (resolved === paths.availabilityStoreDir) throw fsError('EIO');
            return fs.fsyncSync(descriptor);
        },
    });
    const base = readStore(paths);
    const entries = entriesOf('alpha', 'beta');
    let thrown;
    try { commit(root, paths, { expectedRevision: base.revision, entries, fsApi: spy.api }); } catch (error) { thrown = error; }
    assert.equal(thrown?.code, 'HARDWARE_AVAILABILITY_DURABILITY_UNCONFIRMED');
    assert.equal(thrown.committed, true);
    const onDisk = readStore(paths);
    assert.equal(thrown.revision, onDisk.revision);
    assert.notEqual(onDisk.revision, base.revision);
    assert.deepEqual(Object.keys(onDisk.entries), ['alpha', 'beta']);
    assert.equal(spy.calls.filter((call) => call.op === 'rename' && call.to === paths.availabilityPolicyFile).length, 1);
    assert.deepEqual(storeNames(paths), ['policy.json']);
    // The identical content is a no-op afterwards: nothing is re-renamed.
    assert.equal(commit(root, paths, { expectedRevision: onDisk.revision, entries: onDisk.entries }).committed, false);
});

test('NW1.D1-dead-owner-temps-are-swept-and-live-owner-temps-are-kept', (t) => {
    const workspace = initWithEntries(t, 'alpha');
    const { paths, root } = workspace;
    const dead = deadPid();
    const eperm = 4_194_000;
    const killImpl = (pid, signal) => {
        if (pid === eperm) throw fsError('EPERM');
        return process.kill(pid, signal);
    };
    const policyTemp = (pid, id = uuid()) => path.join(paths.availabilityStoreDir, `.policy.json.${pid}.${id}.tmp`);
    const staging = (pid) => path.join(paths.edgeDir, `.hardware-availability.${pid}.${uuid()}.tmp`);
    const witnessTemp = (pid) => path.join(paths.edgeDir, `.hardware-availability.witness.json.${pid}.${uuid()}.tmp`);
    const removed = [policyTemp(dead), witnessTemp(dead), staging(dead)];
    const kept = [
        policyTemp(process.pid), witnessTemp(process.pid), staging(process.pid),
        policyTemp(eperm), witnessTemp(eperm), staging(eperm),
        path.join(paths.availabilityStoreDir, '.policy.json.tmp'),
        path.join(paths.availabilityStoreDir, `.policy.json.${dead}.not-a-uuid.tmp`),
        path.join(paths.availabilityStoreDir, `policy.json.${dead}.${uuid()}.tmp`),
        path.join(paths.availabilityStoreDir, `.policy.json.${dead}.${uuid().toUpperCase()}.tmp`),
        path.join(paths.edgeDir, `.hardware-availability.${dead}.${uuid()}.tmp.bak`),
        path.join(paths.edgeDir, `.hardware-availability.witness.json.${dead}.${DEAD_UUID}.extra`),
    ];
    for (const target of [...removed, ...kept]) {
        if (path.basename(target).startsWith('.hardware-availability.') && target.endsWith('.tmp') && !path.basename(target).includes('witness')) {
            fs.mkdirSync(target, { mode: 0o700 });
            fs.writeFileSync(path.join(target, 'policy.json'), 'x');
        } else fs.writeFileSync(target, 'x');
    }
    underApplyLock(root, ({ assertApplyLock }) => sweepHardwareAvailabilityTemps({ paths, assertApplyLock, killImpl }));
    for (const target of removed) assert.equal(fs.existsSync(target), false, `${target} is swept`);
    for (const target of kept) assert.equal(fs.existsSync(target), true, `${target} is kept`);

    // Every commit sweeps too.
    const late = policyTemp(dead);
    fs.writeFileSync(late, 'x');
    commit(root, paths, { expectedRevision: readStore(paths).revision, entries: entriesOf('alpha', 'beta') });
    assert.equal(fs.existsSync(late), false);
    assert.equal(fs.existsSync(kept[0]), true);
});

test('NW1.D1-identical-replay-writes-nothing', (t) => {
    const workspace = initWithEntries(t, 'alpha', 'beta');
    const { paths, root } = workspace;
    const current = readStore(paths);
    const before = fs.statSync(paths.availabilityPolicyFile);
    const directory = fs.statSync(paths.availabilityStoreDir);
    const spy = spyFs();
    const replay = commit(root, paths, { expectedRevision: current.revision, entries: { ...current.entries }, fsApi: spy.api });
    assert.deepEqual([replay.committed, replay.revision], [false, current.revision]);
    const after = fs.statSync(paths.availabilityPolicyFile);
    assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs]);
    assert.equal(fs.statSync(paths.availabilityStoreDir).mtimeMs, directory.mtimeMs);
    const writing = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT;
    assert.deepEqual(spy.calls.filter((call) => (call.op === 'open' && (call.flags & writing)) || call.op === 'rename' || call.op === 'write'), []);
    assert.deepEqual(storeNames(paths), ['policy.json']);
});

test('NW1.D1-a-restarted-reader-sees-the-committed-revision', async (t) => {
    const workspace = initWithEntries(t, 'alpha', 'beta');
    const current = readStore(workspace.paths);
    const child = await runDriver('read', workspace.root);
    assert.equal(child.ok, true, JSON.stringify(child));
    assert.deepEqual([child.result.state, child.result.revision, child.result.storeId], ['valid', current.revision, current.storeId]);
    assert.deepEqual(Object.keys(child.result.entries), ['alpha', 'beta']);
});

const INSTALL_POINTS = [
    ['afterSweep', 'absent'], ['afterStagingMkdir', 'absent'], ['afterPolicyFsync', 'absent'], ['afterStagingFsync', 'absent'],
    ['beforeDirectoryRename', 'absent'], ['afterDirectoryRename', 'directory'], ['afterEdgeDirectoryFsync', 'directory'],
    ['afterWitnessTemp', 'directory'], ['afterWitnessLink', 'both'],
];

test('NW1.D1-sigkill-at-each-install-point-never-leaves-a-witness-without-a-store', async (t) => {
    for (const [point, expected] of INSTALL_POINTS) {
        await t.test(point, async (subtest) => {
            const workspace = makeWorkspace(subtest);
            await killAt(subtest, 'init', workspace.root, {}, point);
            const { paths } = workspace;
            const witness = fs.existsSync(paths.availabilityWitnessFile);
            const directory = fs.existsSync(paths.availabilityStoreDir);
            assert.equal(witness && !directory, false, 'never a witness without its store');
            assert.deepEqual([witness, directory], { absent: [false, false], directory: [false, true], both: [true, true] }[expected], point);
            const read = readStore(paths);
            assert.equal(read.state, expected === 'absent' ? 'absent' : 'valid');
            assert.equal(read.diagnostic ?? null, expected === 'directory' ? 'witness-missing' : null);
            const storeId = directory ? readJson(paths.availabilityPolicyFile).storeId : null;
            // The next init (reclaiming the dead owner's lock) converges to one complete store.
            const result = init(workspace.root);
            assert.equal(result.hardwareAvailability, { absent: 'installed-fresh', directory: 'witness-restored', both: 'kept' }[expected]);
            const final = readStore(paths);
            assert.deepEqual([final.state, final.diagnostic], ['valid', null]);
            assert.equal(readJson(paths.availabilityWitnessFile).storeId, final.storeId);
            if (storeId) assert.equal(final.storeId, storeId);
            assert.equal(fs.existsSync(paths.routingFile), true);
            assert.deepEqual(edgeTemps(paths).filter((name) => !name.includes(String(process.pid))), []);
        });
    }
});

test('NW1.D1-sigkill-before-the-policy-rename-keeps-the-old-policy', async (t) => {
    const workspace = initWithEntries(t, 'alpha');
    const { paths, root } = workspace;
    const base = readStore(paths);
    const bytes = sha256(paths.availabilityPolicyFile);
    const { pid } = await killAt(t, 'commit', root, { entries: entriesOf('alpha', 'beta') }, 'beforeRename');
    assert.equal(sha256(paths.availabilityPolicyFile), bytes);
    assert.equal(readStore(paths).revision, base.revision);
    const temps = storeNames(paths).filter((name) => name !== 'policy.json');
    assert.equal(temps.length, 1);
    assert.ok(temps[0].startsWith(`.policy.json.${pid}.`), 'the dead owner left its temp');
    // A later commit sweeps the dead owner's temp (A9).
    const result = commit(root, paths, { expectedRevision: base.revision, entries: entriesOf('alpha', 'gamma') });
    assert.equal(result.committed, true);
    assert.deepEqual(storeNames(paths), ['policy.json']);
});

test('NW1.D1-sigkill-after-the-policy-rename-keeps-the-new-policy', async (t) => {
    const workspace = initWithEntries(t, 'alpha');
    const { paths, root } = workspace;
    const base = readStore(paths);
    const entries = entriesOf('alpha', 'beta');
    await killAt(t, 'commit', root, { entries }, 'afterRename');
    const after = readStore(paths);
    assert.notEqual(after.revision, base.revision);
    assert.deepEqual(Object.keys(after.entries), ['alpha', 'beta']);
    assert.deepEqual(storeNames(paths), ['policy.json']);
    const child = await runDriver('read', root);
    assert.equal(child.result.revision, after.revision);
    // The identical content is a no-op for the next committer.
    assert.equal(commit(root, paths, { expectedRevision: after.revision, entries: after.entries }).committed, false);
});

function sizedEntries(target, { extra = 0 } = {}) {
    const sizeOf = (entries) => Buffer.byteLength(serializeHardwareAvailabilityPolicy({
        schema: SCHEMA, storeId: '0'.repeat(32), revision: `sha256:${'0'.repeat(64)}`, entries, slots: {},
    }), 'utf8');
    for (let fixedReason = 1300; fixedReason <= 2040; fixedReason += 10) {
        const build = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`r${String(index).padStart(3, '0')}`, entryFor(`r${String(index).padStart(3, '0')}`, { reason: 'x'.repeat(fixedReason) })]));
        let count = 0;
        while (count < 255) {
            const probe = { ...build(count + 1), [`r${String(count + 1).padStart(3, '0')}`]: entryFor(`r${String(count + 1).padStart(3, '0')}`, { reason: 'x'.repeat(10), alias: 'a' }) };
            if (sizeOf(probe) > target) break;
            count += 1;
        }
        const lastKey = `r${String(count).padStart(3, '0')}`;
        const withLast = (reasonLength, aliasLength) => ({
            ...build(count),
            [lastKey]: entryFor(lastKey, { reason: 'x'.repeat(reasonLength), alias: 'a'.repeat(aliasLength) }),
        });
        const delta = target + extra - sizeOf(withLast(10, 1));
        const reasonLength = 10 + Math.floor(delta / 2);
        const aliasLength = 1 + (delta % 2);
        if (delta < 0 || reasonLength > 2040 || count >= 255) continue;
        const entries = withLast(reasonLength, aliasLength);
        if (sizeOf(entries) === target + extra) return { entries, size: sizeOf(entries) };
    }
    throw new Error('could not size the policy');
}

test('NW1.D1-entry-byte-and-text-bounds-refuse-without-a-partial-write', (t) => {
    // 256 entries are accepted; 257 are refused with the old policy intact.
    const many = (count) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, entryFor(`k${index}`)]));
    const full = initWithEntries(t);
    commit(full.root, full.paths, { expectedRevision: readStore(full.paths).revision, entries: many(256) });
    assert.equal(Object.keys(readStore(full.paths).entries).length, 256);
    const bytes = sha256(full.paths.availabilityPolicyFile);
    assert.throws(() => commit(full.root, full.paths, { expectedRevision: readStore(full.paths).revision, entries: many(257) }), (error) => error.code === 'HARDWARE_AVAILABILITY_POLICY_FULL');
    assert.equal(sha256(full.paths.availabilityPolicyFile), bytes);
    assert.deepEqual(storeNames(full.paths), ['policy.json']);

    // Exactly 1 MiB is accepted, 1 MiB + 1 byte is refused.
    const limit = MAX_HARDWARE_AVAILABILITY_POLICY_BYTES;
    const exact = sizedEntries(limit);
    const over = sizedEntries(limit, { extra: 1 });
    assert.equal(exact.size, limit);
    assert.equal(over.size, limit + 1);
    const at = initWithEntries(t);
    commit(at.root, at.paths, { expectedRevision: readStore(at.paths).revision, entries: exact.entries });
    assert.equal(fs.statSync(at.paths.availabilityPolicyFile).size, limit);
    assert.equal(Object.keys(readStore(at.paths).entries).length, Object.keys(exact.entries).length);
    const beyond = initWithEntries(t);
    const beyondBytes = sha256(beyond.paths.availabilityPolicyFile);
    assert.throws(() => commit(beyond.root, beyond.paths, { expectedRevision: readStore(beyond.paths).revision, entries: over.entries }), (error) => error.code === 'HARDWARE_AVAILABILITY_POLICY_FULL');
    assert.equal(sha256(beyond.paths.availabilityPolicyFile), beyondBytes);
    assert.deepEqual(storeNames(beyond.paths), ['policy.json']);

    // Text is bounded by the existing outcome validator: NUL and a reason over 2048 bytes never reach a commit.
    assert.throws(() => entryFor('alpha', { reason: 'bad\u0000text' }), /NUL/);
    assert.throws(() => entryFor('alpha', { reason: 'é'.repeat(1025) }), /exceeds 2048 bytes/);
    // Multibyte, control and bidi characters at the bound round-trip byte-exactly.
    const text = `${'é'.repeat(1000)}\n\u0007‮\u{1F600}`;
    const unicode = initWithEntries(t);
    const entry = entryFor('alpha', { reason: text });
    commit(unicode.root, unicode.paths, { expectedRevision: readStore(unicode.paths).revision, entries: { alpha: entry } });
    assert.deepEqual(readStore(unicode.paths).entries.alpha, entry);
});

test('NW1.D1-a-missing-witness-beside-a-valid-store-is-read-as-valid-and-restored-by-init', (t) => {
    const workspace = initWithEntries(t, 'alpha', 'beta');
    const { paths } = workspace;
    const bytes = sha256(paths.availabilityPolicyFile);
    const policyInode = inode(paths.availabilityPolicyFile);
    const storeId = readJson(paths.availabilityWitnessFile).storeId;
    fs.rmSync(paths.availabilityWitnessFile);
    const read = readStore(paths);
    assert.deepEqual([read.state, read.diagnostic, Object.keys(read.entries)], ['valid', 'witness-missing', ['alpha', 'beta']]);
    assert.equal(init(workspace.root).hardwareAvailability, 'witness-restored');
    const witness = readJson(paths.availabilityWitnessFile);
    assert.deepEqual([witness.storeId, witness.initializedBy], [storeId, 'restored']);
    assert.equal(sha256(paths.availabilityPolicyFile), bytes);
    assert.equal(inode(paths.availabilityPolicyFile), policyInode);
    assert.equal(readStore(paths).diagnostic, null);
    // The restore never rewrites a witness that already exists.
    assert.throws(() => underApplyLock(workspace.root, ({ assertApplyLock }) => restoreHardwareAvailabilityWitness({ paths, assertApplyLock })), /requires a valid store with no witness/);
    assert.throws(() => underApplyLock(workspace.root, ({ assertApplyLock }) => installHardwareAvailabilityStore({ paths, assertApplyLock, initializedBy: 'fresh' })), /already exists/);
});

// Each mutation proves the apply lock before its first write, and the proof is bound to the store being written:
// a missing or non-callable assertion, one that throws, a released capability and another workspace's lock all
// refuse, by their own error, with the edge directory byte-identical.
test('NW1.D1-every-mutation-refuses-with-zero-bytes-written-when-the-apply-lock-assertion-is-missing-throws-is-released-or-foreign', (t) => {
    const OPERATIONS = {
        commit: {
            prepare(ws) {
                init(ws.root);
                ws.revision = readStore(ws.paths).revision;
                ws.temp = path.join(ws.paths.availabilityStoreDir, `.policy.json.${deadPid()}.${uuid()}.tmp`);
                fs.writeFileSync(ws.temp, 'x');
            },
            call: (ws, assertApplyLock) => commitHardwareAvailabilityPolicy({ paths: ws.paths, assertApplyLock, expectedRevision: ws.revision, entries: entriesOf('alpha') }),
            done: (ws) => assert.deepEqual(Object.keys(readStore(ws.paths).entries), ['alpha']),
        },
        install: {
            prepare: (ws) => fs.mkdirSync(ws.paths.edgeDir, { recursive: true }),
            call: (ws, assertApplyLock) => installHardwareAvailabilityStore({ paths: ws.paths, assertApplyLock, initializedBy: 'fresh' }),
            done: (ws) => assert.equal(readStore(ws.paths).state, 'valid'),
        },
        restore: {
            prepare(ws) {
                init(ws.root);
                fs.rmSync(ws.paths.availabilityWitnessFile);
            },
            call: (ws, assertApplyLock) => restoreHardwareAvailabilityWitness({ paths: ws.paths, assertApplyLock }),
            done: (ws) => assert.equal(fs.existsSync(ws.paths.availabilityWitnessFile), true),
        },
        sweep: {
            prepare(ws) {
                init(ws.root);
                ws.temp = path.join(ws.paths.availabilityStoreDir, `.policy.json.${deadPid()}.${uuid()}.tmp`);
                fs.writeFileSync(ws.temp, 'x');
            },
            call: (ws, assertApplyLock) => sweepHardwareAvailabilityTemps({ paths: ws.paths, assertApplyLock }),
            done: (ws) => assert.equal(fs.existsSync(ws.temp), false),
        },
    };
    const CASES = {
        missing: { code: 'HARDWARE_AVAILABILITY_POLICY_INVALID', message: /requires an apply-lock assertion/ },
        'not-callable': { code: 'HARDWARE_AVAILABILITY_POLICY_INVALID', message: /requires an apply-lock assertion/ },
        throws: { code: 'TEST_LOCK_NOT_HELD', message: /lock not held/ },
        released: { code: 'EDGE_GENERATION_CAPABILITY_REQUIRED', message: /exact live apply-lock capability/ },
        foreign: { code: 'EDGE_GENERATION_CAPABILITY_REQUIRED', message: /outside the workspace that holds the apply lock/ },
    };
    for (const [operation, spec] of Object.entries(OPERATIONS)) {
        const ws = makeWorkspace(t);
        spec.prepare(ws);
        const before = snapshotTree(ws.paths.edgeDir);
        for (const [kind, expected] of Object.entries(CASES)) {
            const label = `${operation}/${kind}`;
            let attempt;
            if (kind === 'missing') attempt = () => spec.call(ws, undefined);
            else if (kind === 'not-callable') attempt = () => spec.call(ws, 'held');
            else if (kind === 'throws') {
                attempt = () => spec.call(ws, () => { throw Object.assign(new Error('lock not held'), { code: 'TEST_LOCK_NOT_HELD' }); });
            } else if (kind === 'released') {
                let held;
                underApplyLock(ws.root, ({ capability }) => { held = capability; });
                attempt = () => spec.call(ws, lockAssertion(ws.root, held));
            } else {
                // A live lock of ANOTHER workspace, with an assertion that is valid for that workspace.
                const other = makeWorkspace(t);
                attempt = () => underApplyLock(other.root, ({ assertApplyLock }) => spec.call(ws, assertApplyLock));
            }
            assert.throws(attempt, (error) => {
                assert.equal(error.code, expected.code, `${label}: ${error.code} ${error.message}`);
                assert.match(error.message, expected.message, label);
                return true;
            }, label);
            assert.deepEqual(snapshotTree(ws.paths.edgeDir), before, `${label}: zero bytes written`);
        }
        // The control: the same call under the workspace's own live lock does write, so the refusals above are not vacuous.
        underApplyLock(ws.root, ({ assertApplyLock }) => spec.call(ws, assertApplyLock));
        assert.notDeepEqual(snapshotTree(ws.paths.edgeDir), before, `${operation}: the lawful call writes`);
        spec.done(ws);
    }
});
