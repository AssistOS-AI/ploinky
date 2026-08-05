import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    canonicalLockJson,
    DEPENDENCY_MARKER_NAME,
    installPinnedDependencies,
    readDependencyLock,
    validateDependencyLock,
} from '../../ploinky-box/entrypoint/install-dependencies.mjs';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

const EXPECTED_AGENTLIB_COMMIT = 'dd94929443033c0a43bf7569068ec1d2926dba35';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-deps-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const targetRoot = path.join(root, 'node_modules');
    fs.mkdirSync(targetRoot);
    const markerPath = path.join(root, 'ploinky-box');
    fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
    return { root, targetRoot, markerPath };
}

function fakeInstaller(counter, { failName = '' } = {}) {
    return ({ name, repository, destination }) => {
        counter.push(name);
        if (name === failName) throw new Error('simulated install failure');
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, '.head'), repository.commit);
        fs.writeFileSync(path.join(destination, 'payload'), `installed:${name}`);
    };
}

function readHead(directory) {
    try { return fs.readFileSync(path.join(directory, '.head'), 'utf8'); } catch { return ''; }
}

test('dependency lock contains exactly two immutable 40-hex pins', () => {
    const lock = readDependencyLock();
    assert.deepEqual(Object.keys(lock.repositories).sort(), ['achillesAgentLib', 'mcp-sdk']);
    assert.equal(lock.repositories.achillesAgentLib.commit, EXPECTED_AGENTLIB_COMMIT);
    for (const repository of Object.values(lock.repositories)) {
        assert.match(repository.commit, /^[a-f0-9]{40}$/);
    }
    assert.equal(canonicalLockJson(lock), canonicalLockJson(JSON.parse(JSON.stringify(lock))));
    const invalid = structuredClone(lock);
    invalid.repositories['mcp-sdk'].commit = 'main';
    assert.throws(() => validateDependencyLock(invalid), /invalid immutable pin/);
    const unexpected = structuredClone(lock);
    unexpected.staleMetadata = true;
    assert.throws(() => validateDependencyLock(unexpected), /declare pinned repositories/);
    const unexpectedRepositoryField = structuredClone(lock);
    unexpectedRepositoryField.repositories['mcp-sdk'].staleMetadata = true;
    assert.throws(
        () => validateDependencyLock(unexpectedRepositoryField),
        /invalid immutable pin/,
    );
});

test('empty-volume install is transactional and repeat runs are no-ops', (t) => {
    const state = fixture(t);
    const installs = [];
    const options = {
        ...state,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
        token: 'first',
    };
    const first = installPinnedDependencies(options);
    assert.equal(first.changed, true);
    assert.deepEqual(installs.sort(), ['achillesAgentLib', 'mcp-sdk']);
    assert.equal(fs.existsSync(path.join(state.targetRoot, 'mcp-sdk')), true);
    assert.equal(fs.existsSync(path.join(state.targetRoot, 'achillesAgentLib')), true);
    const marker = JSON.parse(fs.readFileSync(path.join(
        state.targetRoot,
        DEPENDENCY_MARKER_NAME,
    ), 'utf8'));
    assert.deepEqual(Object.keys(marker).sort(), ['fingerprint', 'repositories']);
    assert.match(marker.fingerprint, /^[a-f0-9]{64}$/);

    installs.length = 0;
    const second = installPinnedDependencies({ ...options, token: 'second' });
    assert.equal(second.changed, false);
    assert.deepEqual(installs, []);
});

test('partial or wrong-pin installs are repaired as one replacement', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.targetRoot, 'mcp-sdk'));
    fs.writeFileSync(path.join(state.targetRoot, 'mcp-sdk', '.head'), '0'.repeat(40));
    const installs = [];
    const result = installPinnedDependencies({
        ...state,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
        token: 'repair',
    });
    assert.equal(result.changed, true);
    assert.notEqual(readHead(path.join(state.targetRoot, 'mcp-sdk')), '0'.repeat(40));
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
});

test('repair backs up a real owner-read-only dependency without losing unrelated data', (t) => {
    const state = fixture(t);
    for (const name of ['mcp-sdk', 'achillesAgentLib']) {
        const directory = path.join(state.targetRoot, name);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '.head'), '0'.repeat(40));
        fs.writeFileSync(path.join(directory, 'payload'), `original:${name}`);
    }
    const protectedDirectory = path.join(state.targetRoot, 'achillesAgentLib');
    fs.chmodSync(protectedDirectory, 0o500);
    fs.writeFileSync(path.join(state.targetRoot, 'unrelated-canary'), 'retain');
    const fsApi = new Proxy(fs, {
        get(target, property) {
            if (property === 'renameSync') {
                return (source, destination) => {
                    if (path.basename(String(destination)).startsWith('.backup-')) {
                        const stat = fs.lstatSync(source);
                        if (stat.isDirectory() && (stat.mode & 0o200) === 0) {
                            const error = new Error(`EACCES: permission denied, rename '${source}'`);
                            error.code = 'EACCES';
                            throw error;
                        }
                    }
                    return fs.renameSync(source, destination);
                };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const result = installPinnedDependencies({
        ...state,
        fsApi,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
        token: 'readonly-repair',
    });
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(path.join(state.targetRoot, 'unrelated-canary'), 'utf8'), 'retain');
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
    for (const name of ['mcp-sdk', 'achillesAgentLib']) {
        assert.equal(readHead(path.join(state.targetRoot, name)), result.marker.repositories[name]);
    }
});

test('failed swap restores a dependency mode changed only for backup', (t) => {
    const state = fixture(t);
    for (const name of ['mcp-sdk', 'achillesAgentLib']) {
        const directory = path.join(state.targetRoot, name);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '.head'), '0'.repeat(40));
        fs.writeFileSync(path.join(directory, 'payload'), `original:${name}`);
    }
    const protectedDirectory = path.join(state.targetRoot, 'achillesAgentLib');
    fs.chmodSync(protectedDirectory, 0o500);
    const fsApi = new Proxy(fs, {
        get(target, property) {
            if (property === 'renameSync') {
                return (source, destination) => {
                    if (path.basename(String(destination)) === '.backup-achillesAgentLib') {
                        const error = new Error('simulated second backup failure');
                        error.code = 'EIO';
                        throw error;
                    }
                    return fs.renameSync(source, destination);
                };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    assert.throws(() => installPinnedDependencies({
        ...state,
        fsApi,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
        token: 'rollback-mode',
    }), /Pinned dependency installation failed/);
    assert.equal(fs.statSync(protectedDirectory).mode & 0o777, 0o500);
    for (const name of ['mcp-sdk', 'achillesAgentLib']) {
        assert.equal(
            fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'),
            `original:${name}`,
        );
    }
    fs.chmodSync(protectedDirectory, 0o700);
});

test('failed repair preserves established dependency directories for retry', (t) => {
    const state = fixture(t);
    for (const name of ['mcp-sdk', 'achillesAgentLib']) {
        fs.mkdirSync(path.join(state.targetRoot, name));
        fs.writeFileSync(path.join(state.targetRoot, name, '.head'), '0'.repeat(40));
        fs.writeFileSync(path.join(state.targetRoot, name, 'payload'), `original:${name}`);
    }
    const before = Object.fromEntries(['mcp-sdk', 'achillesAgentLib'].map((name) => [
        name,
        fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'),
    ]));
    assert.throws(() => installPinnedDependencies({
        ...state,
        installRepository: fakeInstaller([], { failName: 'mcp-sdk' }),
        readInstalledHead: readHead,
        token: 'failure',
    }), /Pinned dependency installation failed/);
    for (const [name, payload] of Object.entries(before)) {
        assert.equal(fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'), payload);
    }
});

test('post-commit backup cleanup failure cannot roll back the installed dependency set', (t) => {
    const state = fixture(t);
    for (const name of ['mcp-sdk', 'achillesAgentLib']) {
        fs.mkdirSync(path.join(state.targetRoot, name));
        fs.writeFileSync(path.join(state.targetRoot, name, '.head'), '0'.repeat(40));
        fs.writeFileSync(path.join(state.targetRoot, name, 'payload'), `original:${name}`);
    }
    let failedCleanup = false;
    const fsApi = new Proxy(fs, {
        get(target, property) {
            if (property === 'rmSync') {
                return (selectedPath, options) => {
                    if (!failedCleanup && path.basename(String(selectedPath)).startsWith('.backup-')) {
                        failedCleanup = true;
                        throw new Error('simulated post-commit cleanup failure');
                    }
                    return fs.rmSync(selectedPath, options);
                };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const result = installPinnedDependencies({
        ...state,
        fsApi,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
        token: 'cleanup-failure',
    });
    assert.equal(result.changed, true);
    assert.equal(failedCleanup, true);
    for (const name of ['mcp-sdk', 'achillesAgentLib']) {
        assert.equal(readHead(path.join(state.targetRoot, name)), result.marker.repositories[name]);
        assert.equal(
            fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'),
            `installed:${name}`,
        );
    }
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
});

test('marker mismatch and symlink volume roots fail before installation', (t) => {
    const state = fixture(t);
    fs.writeFileSync(state.markerPath, 'wrong\n');
    const installs = [];
    assert.throws(() => installPinnedDependencies({
        ...state,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
    }), /marker has invalid content/i);
    assert.deepEqual(installs, []);

    fs.writeFileSync(state.markerPath, BOX_MARKER_CONTENT);
    const realRoot = path.join(state.root, 'real-root');
    fs.mkdirSync(realRoot);
    const linkedRoot = path.join(state.root, 'linked-root');
    fs.symlinkSync(realRoot, linkedRoot, 'dir');
    assert.throws(() => installPinnedDependencies({
        targetRoot: linkedRoot,
        markerPath: state.markerPath,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
    }), /not a real directory/);
});
