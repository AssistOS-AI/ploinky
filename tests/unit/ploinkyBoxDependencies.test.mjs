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
import {
    createMcpSdkBundleMetadata,
    MCP_SDK_BUNDLE_METADATA_NAME,
    validateMcpSdkBundle,
} from '../../ploinky-box/mcp-sdk-bundle.mjs';
import { createProcessRunner } from '../../ploinky-box/process.mjs';
import { AGENTLIB_ENV, AGENTLIB_STABLE_MOUNT_PATH } from '../../agentlib/contract.mjs';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

// The Box installs only mcp-sdk now; achillesAgentLib arrives as a direct mount
// the supervisor established, which the installer validates but never creates.
const INSTALLED_DEPENDENCIES = ['mcp-sdk'];
const MOUNT_FINGERPRINT = 'b2'.repeat(32);

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-deps-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const targetRoot = path.join(root, 'node_modules');
    fs.mkdirSync(targetRoot);
    const markerPath = path.join(root, 'ploinky-box');
    fs.writeFileSync(markerPath, BOX_MARKER_CONTENT);
    const agentLibPath = path.join(root, 'mounted-agentlib');
    fs.mkdirSync(agentLibPath);
    writeAgentLibCheckout(agentLibPath);
    const agentLibEnv = {
        [AGENTLIB_ENV.dir]: agentLibPath,
        [AGENTLIB_ENV.mode]: 'local',
        [AGENTLIB_ENV.fingerprint]: MOUNT_FINGERPRINT,
        [AGENTLIB_ENV.commit]: '',
    };
    const lock = readDependencyLock();
    const bundledMcpSdkPath = path.join(root, 'bundled-mcp-sdk');
    fs.mkdirSync(bundledMcpSdkPath);
    fs.writeFileSync(path.join(bundledMcpSdkPath, 'package.json'), JSON.stringify({
        name: '@modelcontextprotocol/sdk',
        version: '1.19.1',
        type: 'module',
        exports: { '.': './index.mjs' },
    }));
    fs.writeFileSync(
        path.join(bundledMcpSdkPath, 'index.mjs'),
        'export const bundled = true;\n',
    );
    const bundleMetadata = createMcpSdkBundleMetadata({
        sourceRoot: bundledMcpSdkPath,
        repository: lock.repositories['mcp-sdk'],
    });
    fs.writeFileSync(
        path.join(bundledMcpSdkPath, MCP_SDK_BUNDLE_METADATA_NAME),
        `${JSON.stringify(bundleMetadata)}\n`,
    );
    return {
        root,
        targetRoot,
        markerPath,
        agentLibPath,
        agentLibEnv,
        bundledMcpSdkPath,
        lock,
    };
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
    // achillesAgentLib is deliberately absent: it is direct-mounted, never installed.
    assert.deepEqual(installs.sort(), ['mcp-sdk']);
    assert.equal(fs.existsSync(path.join(state.targetRoot, 'mcp-sdk')), true);
    assert.equal(fs.existsSync(path.join(state.targetRoot, 'achillesAgentLib')), false);
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

test('default install copies the verified image bundle without Git or npm', (t) => {
    const state = fixture(t);
    const commands = [];
    const processRunner = createProcessRunner();
    const runner = {
        run(command, args, options) {
            commands.push(command);
            return processRunner.run(command, args, options);
        },
        query(command, args, options) {
            commands.push(command);
            return processRunner.query(command, args, options);
        },
    };
    const first = installPinnedDependencies({
        ...state,
        runner,
        token: 'bundled-first',
    });
    assert.equal(first.changed, true);
    assert.deepEqual(commands, ['cp', 'chmod']);
    const installed = path.join(state.targetRoot, 'mcp-sdk');
    assert.equal(fs.readFileSync(path.join(installed, 'index.mjs'), 'utf8'), 'export const bundled = true;\n');
    assert.equal(fs.existsSync(path.join(installed, '.git')), false);
    assert.notEqual(fs.statSync(installed).mode & 0o200, 0);
    const verified = validateMcpSdkBundle({
        sourceRoot: installed,
        expectedRepository: state.lock.repositories['mcp-sdk'],
    });
    assert.equal(verified.repository.commit, state.lock.repositories['mcp-sdk'].commit);

    commands.length = 0;
    const second = installPinnedDependencies({
        ...state,
        runner,
        token: 'bundled-second',
    });
    assert.equal(second.changed, false);
    assert.deepEqual(commands, []);

    fs.writeFileSync(path.join(installed, 'index.mjs'), 'tampered\n');
    const repaired = installPinnedDependencies({
        ...state,
        runner,
        token: 'bundled-repair',
    });
    assert.equal(repaired.changed, true);
    assert.deepEqual(commands, ['cp', 'chmod']);
    assert.equal(fs.readFileSync(path.join(installed, 'index.mjs'), 'utf8'), 'export const bundled = true;\n');
});

test('missing or tampered image bundle fails before cache mutation', (t) => {
    const state = fixture(t);
    const missing = path.join(state.root, 'missing-bundle');
    assert.throws(
        () => installPinnedDependencies({
            ...state,
            bundledMcpSdkPath: missing,
            token: 'missing-bundle',
        }),
        /no valid bundled MCP SDK/,
    );
    assert.deepEqual(fs.readdirSync(state.targetRoot), []);

    fs.appendFileSync(path.join(state.bundledMcpSdkPath, 'index.mjs'), '// tampered\n');
    assert.throws(
        () => installPinnedDependencies({ ...state, token: 'tampered-bundle' }),
        /no valid bundled MCP SDK/,
    );
    assert.deepEqual(fs.readdirSync(state.targetRoot), []);
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
    for (const name of INSTALLED_DEPENDENCIES) {
        const directory = path.join(state.targetRoot, name);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '.head'), '0'.repeat(40));
        fs.writeFileSync(path.join(directory, 'payload'), `original:${name}`);
    }
    const protectedDirectory = path.join(state.targetRoot, 'mcp-sdk');
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
    for (const name of INSTALLED_DEPENDENCIES) {
        assert.equal(readHead(path.join(state.targetRoot, name)), result.marker.repositories[name]);
    }
});

test('failed swap restores a dependency mode changed only for backup', (t) => {
    const state = fixture(t);
    for (const name of INSTALLED_DEPENDENCIES) {
        const directory = path.join(state.targetRoot, name);
        fs.mkdirSync(directory);
        fs.writeFileSync(path.join(directory, '.head'), '0'.repeat(40));
        fs.writeFileSync(path.join(directory, 'payload'), `original:${name}`);
    }
    const protectedDirectory = path.join(state.targetRoot, 'mcp-sdk');
    fs.chmodSync(protectedDirectory, 0o500);
    const fsApi = new Proxy(fs, {
        get(target, property) {
            if (property === 'renameSync') {
                return (source, destination) => {
                    if (path.basename(String(destination)) === '.backup-mcp-sdk') {
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
    for (const name of INSTALLED_DEPENDENCIES) {
        assert.equal(
            fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'),
            `original:${name}`,
        );
    }
    fs.chmodSync(protectedDirectory, 0o700);
});

test('failed repair preserves established dependency directories for retry', (t) => {
    const state = fixture(t);
    for (const name of INSTALLED_DEPENDENCIES) {
        fs.mkdirSync(path.join(state.targetRoot, name));
        fs.writeFileSync(path.join(state.targetRoot, name, '.head'), '0'.repeat(40));
        fs.writeFileSync(path.join(state.targetRoot, name, 'payload'), `original:${name}`);
    }
    const before = Object.fromEntries(INSTALLED_DEPENDENCIES.map((name) => [
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
    for (const name of INSTALLED_DEPENDENCIES) {
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
    for (const name of INSTALLED_DEPENDENCIES) {
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

// --- direct-mounted achillesAgentLib ---------------------------------------

test('installation requires the supervisor-provided direct mount', (t) => {
    const state = fixture(t);
    const installs = [];
    const attempt = (agentLibEnv, agentLibPath = state.agentLibPath) => installPinnedDependencies({
        ...state,
        agentLibEnv,
        agentLibPath,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
    });

    // A missing contract is an error, not permission to obtain a copy in-Box.
    assert.throws(() => attempt({}), new RegExp(`${AGENTLIB_ENV.dir} must be`));
    assert.throws(
        () => attempt({ ...state.agentLibEnv, [AGENTLIB_ENV.dir]: '/somewhere/else' }),
        new RegExp(`${AGENTLIB_ENV.dir} must be`),
    );
    assert.throws(
        () => attempt({ ...state.agentLibEnv, [AGENTLIB_ENV.fingerprint]: 'not-a-digest' }),
        new RegExp(`${AGENTLIB_ENV.fingerprint} must carry`),
    );
    assert.deepEqual(installs, [], 'nothing may be installed before the mount is proven');

    const missingMount = path.join(state.root, 'absent-agentlib');
    assert.throws(
        () => attempt({ ...state.agentLibEnv, [AGENTLIB_ENV.dir]: missingMount }, missingMount),
        /direct mount is missing/,
    );

    const wrongPackage = path.join(state.root, 'wrong-agentlib');
    fs.mkdirSync(wrongPackage);
    writeAgentLibCheckout(wrongPackage);
    fs.writeFileSync(path.join(wrongPackage, 'package.json'), JSON.stringify({ name: 'something-else' }));
    assert.throws(
        () => attempt({ ...state.agentLibEnv, [AGENTLIB_ENV.dir]: wrongPackage }, wrongPackage),
        /declares package name 'something-else'/,
    );
    assert.deepEqual(installs, []);
});

test('a leftover Box-installed achillesAgentLib is removed rather than loaded', (t) => {
    const state = fixture(t);
    const stale = path.join(state.targetRoot, 'achillesAgentLib');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'payload'), 'stale copy');
    const result = installPinnedDependencies({
        ...state,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
        token: 'stale-agentlib',
    });
    assert.equal(result.changed, true);
    assert.equal(fs.existsSync(stale), false, 'the retired Box copy must not survive');
    assert.equal(fs.existsSync(path.join(state.targetRoot, 'mcp-sdk')), true);
});

test('an ambiguous achillesAgentLib entry fails with a cleanup instruction', (t) => {
    const state = fixture(t);
    fs.symlinkSync(state.agentLibPath, path.join(state.targetRoot, 'achillesAgentLib'), 'dir');
    const installs = [];
    assert.throws(() => installPinnedDependencies({
        ...state,
        installRepository: fakeInstaller(installs),
        readInstalledHead: readHead,
    }), new RegExp(`direct-mounted at ${AGENTLIB_STABLE_MOUNT_PATH}`));
    assert.deepEqual(installs, [], 'a suspicious entry blocks installation instead of being consumed');
});

test('the marker covers only the dependencies the Box installs', (t) => {
    const state = fixture(t);
    const result = installPinnedDependencies({
        ...state,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
        token: 'marker-scope',
    });
    assert.deepEqual(Object.keys(result.marker.repositories), INSTALLED_DEPENDENCIES);
});
