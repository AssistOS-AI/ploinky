import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
    canonicalLockJson,
    DEPENDENCY_MARKER_NAME,
    installPinnedDependencies,
    inspectInstalledAgentlibIdentity,
    readDependencyLock,
    runInstallerCli,
    validateDependencyLock,
} from '../../ploinky-box/entrypoint/install-dependencies.mjs';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

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

function writeLocalArchive(targetRoot, bytes) {
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const directory = path.join(targetRoot, '.ploinky-local-agentlib');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, `${sha}.tgz`), bytes);
    return sha;
}

function fakeLocalInstaller(counter, { fail = false } = {}) {
    return ({ sha256, destination }) => {
        counter.push(sha256);
        if (fail) throw new Error('simulated local extraction failure');
        fs.mkdirSync(destination);
        fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
            name: 'ploinky-agent-lib',
            type: 'module',
            main: 'index.mjs',
        }));
        fs.writeFileSync(path.join(destination, 'index.mjs'), `export const sha = '${sha256}';\n`);
    };
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

test('local Achilles replacement preserves valid mcp-sdk and same SHA is a no-op', (t) => {
    const state = fixture(t);
    const repositoryInstalls = [];
    const baseOptions = {
        ...state,
        installRepository: fakeInstaller(repositoryInstalls),
        readInstalledHead: readHead,
    };
    installPinnedDependencies({ ...baseOptions, token: 'production-base' });
    const lockedMcpHead = readHead(path.join(state.targetRoot, 'mcp-sdk'));
    const sha = writeLocalArchive(state.targetRoot, Buffer.from('local-archive-one'));
    const localInstalls = [];
    repositoryInstalls.length = 0;
    const local = installPinnedDependencies({
        ...baseOptions,
        localAgentlibSha: sha,
        installLocalAgentlib: fakeLocalInstaller(localInstalls),
        token: 'local-one',
    });
    assert.equal(local.changed, true);
    assert.deepEqual(repositoryInstalls, []);
    assert.deepEqual(localInstalls, [sha]);
    assert.equal(readHead(path.join(state.targetRoot, 'mcp-sdk')), lockedMcpHead);
    assert.equal(local.marker.repositories.achillesAgentLib, `local:${sha}`);
    assert.equal(inspectInstalledAgentlibIdentity({ ...baseOptions }), `local:${sha}`);

    localInstalls.length = 0;
    const repeated = installPinnedDependencies({
        ...baseOptions,
        localAgentlibSha: sha,
        installLocalAgentlib: fakeLocalInstaller(localInstalls),
        token: 'local-repeat',
    });
    assert.equal(repeated.changed, false);
    assert.deepEqual(localInstalls, []);
});

test('ordinary preparation preserves local Achilles while repairing another dependency', (t) => {
    const state = fixture(t);
    const repositoryInstalls = [];
    const options = {
        ...state,
        installRepository: fakeInstaller(repositoryInstalls),
        readInstalledHead: readHead,
    };
    installPinnedDependencies({ ...options, token: 'preserve-production-base' });
    const sha = writeLocalArchive(state.targetRoot, Buffer.from('preserved-local-archive'));
    installPinnedDependencies({
        ...options,
        localAgentlibSha: sha,
        installLocalAgentlib: fakeLocalInstaller([]),
        token: 'preserve-local-base',
    });
    const agentlibEntry = path.join(state.targetRoot, 'achillesAgentLib', 'index.mjs');
    const beforeAgentlib = fs.readFileSync(agentlibEntry, 'utf8');

    fs.rmSync(path.join(state.targetRoot, 'mcp-sdk'), { recursive: true });
    repositoryInstalls.length = 0;
    const prepared = runInstallerCli(['--preserve-agentlib'], {
        ...options,
        token: 'preserve-command-preparation',
    });

    assert.equal(prepared.changed, true);
    assert.deepEqual(repositoryInstalls, ['mcp-sdk']);
    assert.equal(prepared.marker.repositories.achillesAgentLib, `local:${sha}`);
    assert.equal(fs.readFileSync(agentlibEntry, 'utf8'), beforeAgentlib);
    assert.equal(inspectInstalledAgentlibIdentity(options), `local:${sha}`);
});

test('ordinary preparation never replaces an existing unvalidated Achilles identity', (t) => {
    const state = fixture(t);
    const repositoryInstalls = [];
    const options = {
        ...state,
        installRepository: fakeInstaller(repositoryInstalls),
        readInstalledHead: readHead,
    };
    installPinnedDependencies({ ...options, token: 'preserve-invalid-production-base' });
    const sha = writeLocalArchive(state.targetRoot, Buffer.from('preserve-invalid-local'));
    installPinnedDependencies({
        ...options,
        localAgentlibSha: sha,
        installLocalAgentlib: fakeLocalInstaller([]),
        token: 'preserve-invalid-local-base',
    });
    const agentlibEntry = path.join(state.targetRoot, 'achillesAgentLib', 'index.mjs');
    const beforeAgentlib = fs.readFileSync(agentlibEntry, 'utf8');
    fs.writeFileSync(path.join(state.targetRoot, DEPENDENCY_MARKER_NAME), '{invalid json\n');
    fs.rmSync(path.join(state.targetRoot, 'mcp-sdk'), { recursive: true });
    repositoryInstalls.length = 0;

    assert.throws(
        () => runInstallerCli(['--preserve-agentlib'], {
            ...options,
            token: 'preserve-invalid-command-preparation',
        }),
        /Refusing ordinary Box preparation because the existing AchillesAgentLib identity cannot be validated/,
    );
    assert.deepEqual(repositoryInstalls, []);
    assert.equal(fs.readFileSync(agentlibEntry, 'utf8'), beforeAgentlib);
});

test('the real local installer extracts, installs, and loads the achillesAgentLib alias', async (t) => {
    const state = fixture(t);
    const options = {
        ...state,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
    };
    installPinnedDependencies({ ...options, token: 'real-local-base' });

    const packageRoot = path.join(state.root, 'local-package');
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
        name: 'ploinky-agent-lib',
        version: '1.0.0',
        type: 'module',
        main: 'index.mjs',
    }));
    fs.writeFileSync(
        path.join(packageRoot, 'index.mjs'),
        'export const localMarker = "real-local-installer";\n',
    );
    const archiveDirectory = path.join(state.targetRoot, '.ploinky-local-agentlib');
    fs.mkdirSync(archiveDirectory);
    const packed = spawnSync('npm', [
        'pack', '--ignore-scripts', '--json', '--pack-destination', archiveDirectory,
    ], { cwd: packageRoot, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const generated = path.join(archiveDirectory, JSON.parse(packed.stdout)[0].filename);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(generated)).digest('hex');
    fs.renameSync(generated, path.join(archiveDirectory, `${sha}.tgz`));

    const installed = installPinnedDependencies({
        ...options,
        localAgentlibSha: sha,
        token: 'real-local-install',
    });
    assert.equal(installed.marker.repositories.achillesAgentLib, `local:${sha}`);
    const module = await import(pathToFileURL(path.join(
        state.targetRoot, 'achillesAgentLib', 'index.mjs',
    )).href);
    assert.equal(module.localMarker, 'real-local-installer');
});

test('new local SHA replaces only Achilles and production restores only the locked Achilles pin', (t) => {
    const state = fixture(t);
    const repositories = [];
    const options = {
        ...state,
        installRepository: fakeInstaller(repositories),
        readInstalledHead: readHead,
    };
    installPinnedDependencies({ ...options, token: 'base' });
    const mcpPayload = fs.readFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'utf8');
    const firstSha = writeLocalArchive(state.targetRoot, Buffer.from('first-local'));
    installPinnedDependencies({
        ...options,
        localAgentlibSha: firstSha,
        installLocalAgentlib: fakeLocalInstaller([]),
        token: 'first-local',
    });
    const secondBytes = Buffer.from('second-local');
    const secondSha = crypto.createHash('sha256').update(secondBytes).digest('hex');
    fs.writeFileSync(
        path.join(state.targetRoot, '.ploinky-local-agentlib', `${secondSha}.tgz`),
        secondBytes,
    );
    const localInstalls = [];
    repositories.length = 0;
    installPinnedDependencies({
        ...options,
        localAgentlibSha: secondSha,
        installLocalAgentlib: fakeLocalInstaller(localInstalls),
        token: 'second-local',
    });
    assert.deepEqual(localInstalls, [secondSha]);
    assert.deepEqual(repositories, []);
    assert.equal(fs.readFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'utf8'), mcpPayload);

    repositories.length = 0;
    const production = installPinnedDependencies({ ...options, token: 'restore-production' });
    assert.deepEqual(repositories, ['achillesAgentLib']);
    assert.equal(production.marker.repositories.achillesAgentLib, readDependencyLock().repositories.achillesAgentLib.commit);
    assert.equal(inspectInstalledAgentlibIdentity({ ...options }), production.marker.repositories.achillesAgentLib);
    assert.equal(fs.readFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'utf8'), mcpPayload);
});

test('local install failures preserve the prior dependency and marker', (t) => {
    const state = fixture(t);
    const options = {
        ...state,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
    };
    installPinnedDependencies({ ...options, token: 'base' });
    const markerPath = path.join(state.targetRoot, DEPENDENCY_MARKER_NAME);
    const beforeMarker = fs.readFileSync(markerPath, 'utf8');
    const beforePayload = fs.readFileSync(path.join(state.targetRoot, 'achillesAgentLib', 'payload'), 'utf8');
    const sha = writeLocalArchive(state.targetRoot, Buffer.from('will-fail'));
    assert.throws(() => installPinnedDependencies({
        ...options,
        localAgentlibSha: sha,
        installLocalAgentlib: fakeLocalInstaller([], { fail: true }),
        token: 'failing-local',
    }), /Pinned dependency installation failed/);
    assert.equal(fs.readFileSync(markerPath, 'utf8'), beforeMarker);
    assert.equal(fs.readFileSync(path.join(state.targetRoot, 'achillesAgentLib', 'payload'), 'utf8'), beforePayload);
});

test('identity inspection and CLI parsing are read-only and fail closed', (t) => {
    const state = fixture(t);
    const options = {
        ...state,
        installRepository: fakeInstaller([]),
        readInstalledHead: readHead,
    };
    assert.equal(inspectInstalledAgentlibIdentity(options), 'unknown');
    const before = fs.readdirSync(state.targetRoot);
    let output = '';
    assert.equal(runInstallerCli(['--print-agentlib-identity'], {
        ...options,
        stdout: { write(chunk) { output += String(chunk); } },
    }), 'unknown');
    assert.equal(output, 'unknown\n');
    assert.deepEqual(fs.readdirSync(state.targetRoot), before);
    for (const sha of ['A'.repeat(64), '0'.repeat(63), '']) {
        assert.throws(
            () => runInstallerCli(['--local-agentlib-sha', sha], options),
            /64 lowercase hexadecimal/,
        );
    }
    assert.throws(() => runInstallerCli(['--unknown'], options), /Usage:/);
});
