import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity, materializeIdentityAnchor } from '../../ploinky-box/identity.mjs';
import {
    retireDestroyedBoxNoWaitMarkers,
    retireQuiescentBoxWorkspaceStartLock,
} from '../../ploinky-box/noWaitCleanup.mjs';
import { retireQuiescentBoxEdgePreparation } from '../../ploinky-box/edgePreparationCleanup.mjs';
import { retireNoWaitRunMarker } from '../../cli/commands/noWaitMarkerLifecycle.js';
import { writeNoWaitWorkerStatus, writeStatus } from '../../cli/commands/noWaitWorker.js';
import { ensureVerifiedProducerDirectory } from '../../cli/utils/verifiedReadOnlyFile.js';

const CONTAINER = 'ploinky_demo_worker';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
const MARKER = Object.freeze({
    containerName: CONTAINER,
    instanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    enableGeneration: 'ffffffff-1111-4222-8333-444444444444',
    repoName: 'demo',
    shortAgent: 'worker',
    alias: '',
    routeKey: 'worker',
    runId: RUN_ID,
    runStartedAtMs: 1_700_000_000_000,
    waveIndex: 0,
    statusFile: `${CONTAINER}.${RUN_ID}.json`,
});

function tempRoot(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-directory-permissions-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function permissionMode(target) {
    return fs.statSync(target).mode & 0o7777;
}

function lockFor(identity) {
    return { assertHeld(instance) { assert.equal(instance, identity.instance); } };
}

function fixture(t, mode = 0o775) {
    const workspaceRoot = path.join(tempRoot(t), 'workspace');
    const stateDirectory = path.join(workspaceRoot, '.ploinky');
    const runningDir = path.join(stateDirectory, 'running');
    const markerDirectory = path.join(runningDir, 'no-wait');
    const dataDirectory = path.join(stateDirectory, 'data');
    const edgeDirectory = path.join(dataDirectory, 'edge-routing');
    fs.mkdirSync(markerDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(edgeDirectory, { recursive: true, mode: 0o700 });
    const directories = [workspaceRoot, stateDirectory, runningDir, markerDirectory, dataDirectory, edgeDirectory];
    for (const directory of directories) fs.chmodSync(directory, mode);
    const identity = buildWorkspaceIdentity(workspaceRoot, { markerFound: true });
    return {
        workspaceRoot, runningDir, markerDirectory, edgeDirectory, directories, identity,
        lock: lockFor(identity),
        markerPath: path.join(markerDirectory, `${CONTAINER}.current.json`),
        startLockPath: path.join(runningDir, 'workspace-start.json'),
        leasePath: path.join(edgeDirectory, 'preparation-lease.json'),
    };
}

function writePrivateFile(target, value) {
    fs.writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
}

test('fresh umask 0002 workspace reaches background status publication without chmod repairs', (t) => {
    const root = tempRoot(t);
    const previousUmask = process.umask(0o002);
    try {
        const workspaceRoot = path.join(root, 'workspace');
        fs.mkdirSync(workspaceRoot);
        const identity = buildWorkspaceIdentity(workspaceRoot);
        const lock = lockFor(identity);
        assert.equal(materializeIdentityAnchor(identity, lock).created, true);
        assert.equal(permissionMode(workspaceRoot), 0o775);
        assert.equal(permissionMode(identity.anchorPath), 0o775);

        // Host startup checks the anchor before an inner running directory or lock exists.
        retireQuiescentBoxWorkspaceStartLock({ identity, lock });
        const runningDir = path.join(identity.anchorPath, 'running');
        assert.equal(fs.existsSync(runningDir), false);
        fs.mkdirSync(runningDir);
        retireQuiescentBoxWorkspaceStartLock({ identity, lock });
        assert.equal(permissionMode(runningDir), 0o775);

        const statusDirectory = ensureVerifiedProducerDirectory({
            trustedRoot: workspaceRoot,
            relativeSegments: ['.ploinky', 'running', 'no-wait'],
        });
        assert.equal(permissionMode(statusDirectory), 0o700);
        const canonicalStatus = path.join(statusDirectory, `${CONTAINER}.json`);
        writeStatus(CONTAINER, { state: 'starting' }, { runningDir });
        assert.deepEqual(JSON.parse(fs.readFileSync(canonicalStatus, 'utf8')), { state: 'starting' });
        const statusFile = path.join(statusDirectory, MARKER.statusFile);
        const published = writeNoWaitWorkerStatus(CONTAINER, { state: 'running' }, {
            identity: MARKER,
            runId: RUN_ID,
            runStartedAtMs: MARKER.runStartedAtMs,
            waveIndex: MARKER.waveIndex,
            statusFile,
            runningDir,
        });
        for (const target of [canonicalStatus, statusFile]) {
            assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), published);
            assert.equal(permissionMode(target), 0o600);
        }
        assert.deepEqual(fs.readdirSync(statusDirectory).sort(), [path.basename(canonicalStatus), MARKER.statusFile].sort());
        for (const directory of [workspaceRoot, identity.anchorPath, runningDir]) {
            assert.equal(permissionMode(directory), 0o775);
        }
    } finally {
        process.umask(previousUmask);
    }
});

test('writable and setgid directory modes survive publication and quiescent Box cleanup', (t) => {
    for (const mode of [0o770, 0o775, 0o777, 0o2775, 0o2777]) {
        const f = fixture(t, mode);
        const context = { identity: f.identity, lock: f.lock };
        assert.equal(ensureVerifiedProducerDirectory({
            trustedRoot: f.workspaceRoot,
            relativeSegments: ['.ploinky', 'running', 'no-wait'],
        }), f.markerDirectory);
        writeStatus(CONTAINER, { state: 'running' }, { runningDir: f.runningDir });
        const retainedStatus = path.join(f.markerDirectory, `${CONTAINER}.json`);
        assert.equal(permissionMode(retainedStatus), 0o600);
        writePrivateFile(f.startLockPath, 'expired inner workspace lock');
        retireQuiescentBoxWorkspaceStartLock(context);
        assert.equal(fs.existsSync(f.startLockPath), false);

        writePrivateFile(f.markerPath, MARKER);
        writePrivateFile(f.startLockPath, 'expired inner workspace lock');
        retireDestroyedBoxNoWaitMarkers(context);
        assert.equal(fs.existsSync(f.markerPath), false);
        assert.equal(fs.existsSync(f.startLockPath), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(retainedStatus, 'utf8')), { state: 'running' });

        writePrivateFile(f.leasePath, 'unfinished edge preparation');
        const retainedRoute = path.join(f.edgeDirectory, 'active.json');
        writePrivateFile(retainedRoute, { generation: 'retained' });
        retireQuiescentBoxEdgePreparation(context);
        assert.equal(fs.existsSync(f.leasePath), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(retainedRoute, 'utf8')), { generation: 'retained' });
        for (const directory of f.directories) {
            assert.equal(permissionMode(directory), mode, `directory mode changed for ${directory}`);
        }
    }
});

test('symlinked state directories support publication and cleanup at their existing external targets', (t) => {
    for (const relative of ['.ploinky', '.ploinky/running', '.ploinky/running/no-wait',
        '.ploinky/data', '.ploinky/data/edge-routing']) {
        const f = fixture(t);
        const selected = path.join(f.workspaceRoot, relative);
        const external = path.join(tempRoot(t), 'existing-state');
        fs.renameSync(selected, external);
        fs.symlinkSync(external, selected);
        const context = { identity: f.identity, lock: f.lock };
        ensureVerifiedProducerDirectory({
            trustedRoot: f.workspaceRoot,
            relativeSegments: ['.ploinky', 'running', 'no-wait'],
        });
        writeStatus(CONTAINER, { state: 'running' }, { runningDir: f.runningDir });
        writePrivateFile(f.startLockPath, 'expired inner workspace lock');
        retireQuiescentBoxWorkspaceStartLock(context);
        assert.equal(fs.existsSync(f.startLockPath), false);
        writePrivateFile(f.markerPath, MARKER);
        retireDestroyedBoxNoWaitMarkers(context);
        assert.equal(fs.existsSync(f.markerPath), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.markerDirectory, `${CONTAINER}.json`), 'utf8')),
            { state: 'running' });

        writePrivateFile(f.leasePath, 'unfinished edge preparation');
        retireQuiescentBoxEdgePreparation(context);
        assert.equal(fs.existsSync(f.leasePath), false);
        assert.equal(fs.lstatSync(selected).isSymbolicLink(), true);
        assert.equal(fs.realpathSync(selected), fs.realpathSync(external));
        assert.equal(permissionMode(external), 0o775);
    }
});

test('directory owner differences do not prevent accessible state publication and cleanup', (t) => {
    const f = fixture(t);
    const originalStat = fs.statSync;
    const originalLstat = fs.lstatSync;
    const foreignUid = fs.statSync(f.workspaceRoot).uid + 1;
    const withForeignDirectoryOwner = (inspect) => (target, ...args) => {
        const stat = inspect(target, ...args);
        if (stat.isDirectory()) stat.uid = foreignUid;
        return stat;
    };
    const mocks = [
        t.mock.method(fs, 'statSync', withForeignDirectoryOwner(originalStat)),
        t.mock.method(fs, 'lstatSync', withForeignDirectoryOwner(originalLstat)),
    ];
    try {
        assert.equal(fs.statSync(f.workspaceRoot).uid, foreignUid);
        ensureVerifiedProducerDirectory({
            trustedRoot: f.workspaceRoot,
            relativeSegments: ['.ploinky', 'running', 'no-wait'],
        });
        writeStatus(CONTAINER, { state: 'running' }, { runningDir: f.runningDir });
        writePrivateFile(f.markerPath, MARKER);
        assert.equal(retireNoWaitRunMarker(CONTAINER, { runningDir: f.runningDir }).retired, true);
        const context = { identity: f.identity, lock: f.lock };
        writePrivateFile(f.startLockPath, 'expired inner workspace lock');
        retireQuiescentBoxWorkspaceStartLock(context);
        assert.equal(fs.existsSync(f.startLockPath), false);
        writePrivateFile(f.markerPath, MARKER);
        retireDestroyedBoxNoWaitMarkers(context);
        assert.equal(fs.existsSync(f.markerPath), false);
        writePrivateFile(f.leasePath, 'unfinished edge preparation');
        retireQuiescentBoxEdgePreparation(context);
        assert.equal(fs.existsSync(f.leasePath), false);
    } finally {
        for (const mock of mocks) mock.mock.restore();
    }
});

test('cleanup detects replaced directory targets even when the symlink and contained files are unchanged', (t) => {
    for (const symlink of [false, true]) {
        for (const cleanup of [retireQuiescentBoxEdgePreparation,
            retireQuiescentBoxWorkspaceStartLock, retireDestroyedBoxNoWaitMarkers]) {
            const f = fixture(t);
            const isEdge = cleanup === retireQuiescentBoxEdgePreparation;
            const selected = path.join(f.workspaceRoot, '.ploinky', ...(isEdge ? ['data'] : []));
            const childName = isEdge ? 'edge-routing' : 'running';
            const retainedFile = isEdge ? f.leasePath : f.startLockPath;
            const target = symlink ? path.join(tempRoot(t), 'existing-state') : selected;
            if (symlink) {
                fs.renameSync(selected, target);
                fs.symlinkSync(target, selected);
            }
            writePrivateFile(retainedFile, 'retained after directory replacement');
            writePrivateFile(f.markerPath, MARKER);
            const directoryBefore = fs.statSync(selected);
            const selectedBefore = fs.lstatSync(selected);
            const fileBefore = fs.statSync(retainedFile);
            let checks = 0;
            const lock = { assertHeld(instance) {
                assert.equal(instance, f.identity.instance);
                if (++checks !== 2) return;
                const saved = `${target}-saved`;
                fs.renameSync(target, saved);
                fs.mkdirSync(target);
                fs.renameSync(path.join(saved, childName), path.join(target, childName));
            } };
            // The destroy case checks its host snapshots after its child returns.
            assert.throws(() => cleanup({ identity: f.identity, lock, spawn: () => ({ status: 0 }) }),
                /directories changed/);
            assert.equal(checks, 2);
            assert.notEqual(fs.statSync(selected).ino, directoryBefore.ino);
            if (symlink) assert.equal(fs.lstatSync(selected).ino, selectedBefore.ino);
            const fileAfter = fs.statSync(retainedFile);
            for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
                assert.equal(fileAfter[field], fileBefore[field], `${field} changed for retained file`);
            }
            assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'retained after directory replacement');
            assert.deepEqual(JSON.parse(fs.readFileSync(f.markerPath, 'utf8')), MARKER);
        }
    }
});

test('marker retirement detects replacement of its directory target before retiring the unchanged marker inode', (t) => {
    for (const symlink of [false, true]) {
        const f = fixture(t);
        const selected = f.markerDirectory;
        const target = symlink ? path.join(tempRoot(t), 'existing-markers') : selected;
        if (symlink) {
            fs.renameSync(selected, target);
            fs.symlinkSync(target, selected);
        }
        writePrivateFile(f.markerPath, MARKER);
        const directoryBefore = fs.statSync(selected);
        const selectedBefore = fs.lstatSync(selected);
        const markerBefore = fs.statSync(f.markerPath);
        let replaced = false;
        const fsApi = { ...fs, readSync(...args) {
            const bytesRead = fs.readSync(...args);
            if (!replaced) {
                replaced = true;
                const saved = `${target}-saved`;
                fs.renameSync(target, saved);
                fs.mkdirSync(target);
                fs.renameSync(path.join(saved, path.basename(f.markerPath)), f.markerPath);
            }
            return bytesRead;
        } };
        assert.throws(() => retireNoWaitRunMarker(CONTAINER, { runningDir: f.runningDir, fsApi }),
            /directory .* changed during retirement/);
        assert.equal(replaced, true);
        assert.notEqual(fs.statSync(selected).ino, directoryBefore.ino);
        if (symlink) assert.equal(fs.lstatSync(selected).ino, selectedBefore.ino);
        assert.equal(fs.statSync(f.markerPath).ino, markerBefore.ino);
        assert.deepEqual(JSON.parse(fs.readFileSync(f.markerPath, 'utf8')), MARKER);
        assert.deepEqual(fs.readdirSync(selected), [path.basename(f.markerPath)]);
    }
});

test('directory permission flexibility does not allow writable lock, marker, or lease files', (t) => {
    for (const mode of [0o660, 0o666]) {
        const f = fixture(t, 0o777);
        const context = { identity: f.identity, lock: f.lock };
        writePrivateFile(f.markerPath, MARKER);
        writePrivateFile(f.startLockPath, 'retained lock');
        fs.chmodSync(f.startLockPath, mode);
        for (const cleanup of [retireQuiescentBoxWorkspaceStartLock, retireDestroyedBoxNoWaitMarkers]) {
            assert.throws(() => cleanup(context), /lock is not a secure owned regular file/);
            assert.equal(fs.readFileSync(f.startLockPath, 'utf8'), 'retained lock');
            assert.deepEqual(JSON.parse(fs.readFileSync(f.markerPath, 'utf8')), MARKER);
        }

        fs.chmodSync(f.startLockPath, 0o600);
        fs.chmodSync(f.markerPath, mode);
        assert.throws(() => retireNoWaitRunMarker(CONTAINER, { runningDir: f.runningDir }),
            /marker .* is group- or other-writable/);
        assert.throws(() => retireDestroyedBoxNoWaitMarkers(context), /no-wait marker cleanup failed/);
        assert.equal(fs.existsSync(f.markerPath), true);
        assert.equal(fs.existsSync(f.startLockPath), true);

        writePrivateFile(f.leasePath, 'retained preparation');
        fs.chmodSync(f.leasePath, mode);
        assert.throws(() => retireQuiescentBoxEdgePreparation(context),
            /lease is not a bounded secure owned regular file/);
        assert.equal(fs.readFileSync(f.leasePath, 'utf8'), 'retained preparation');
    }
});
