import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    canonicalLockJson,
    installPinnedDependencies,
    readDependencyLock,
    validateDependencyLock,
} from '../../ploinky-box/entrypoint/install-dependencies.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-deps-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const targetRoot = path.join(root, 'node_modules');
    fs.mkdirSync(targetRoot);
    const contractPath = path.join(root, 'contract');
    fs.writeFileSync(contractPath, '6\n');
    return { root, targetRoot, contractPath };
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
    for (const repository of Object.values(lock.repositories)) {
        assert.match(repository.commit, /^[a-f0-9]{40}$/);
    }
    assert.equal(canonicalLockJson(lock), canonicalLockJson(JSON.parse(JSON.stringify(lock))));
    const invalid = structuredClone(lock);
    invalid.repositories['mcp-sdk'].commit = 'main';
    assert.throws(() => validateDependencyLock(invalid), /invalid immutable pin/);
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
        '.ploinky-box-dependencies-v6.json',
    ), 'utf8'));
    assert.equal(marker.contract, 6);
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

test('contract mismatch and symlink volume roots fail before installation', (t) => {
    const state = fixture(t);
    fs.writeFileSync(state.contractPath, '5\n');
    const installs = [];
    assert.throws(() => installPinnedDependencies({
        ...state,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
    }), /must contain exactly 6/);
    assert.deepEqual(installs, []);

    fs.writeFileSync(state.contractPath, '6\n');
    const realRoot = path.join(state.root, 'real-root');
    fs.mkdirSync(realRoot);
    const linkedRoot = path.join(state.root, 'linked-root');
    fs.symlinkSync(realRoot, linkedRoot, 'dir');
    assert.throws(() => installPinnedDependencies({
        targetRoot: linkedRoot,
        contractPath: state.contractPath,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
    }), /not a real directory/);
});
