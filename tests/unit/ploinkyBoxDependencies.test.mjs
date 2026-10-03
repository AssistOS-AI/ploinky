import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BOX_INSTALLED_DEPENDENCIES,
    DEPENDENCY_MARKER_NAME,
    DEPENDENCY_MARKER_SCHEMA,
    prepareImageDependencies,
    validateMountedAgentLib,
} from '../../ploinky-box/entrypoint/install-dependencies.mjs';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import { createProcessRunner } from '../../ploinky-box/process.mjs';
import {
    AGENTLIB_ENV,
    AGENTLIB_STABLE_MOUNT_PATH,
    BOX_IMAGE_ID_ENV,
    imageSourceIdHash,
    imageSourceIdentity,
} from '../../agentlib/contract.mjs';
import {
    NESTED_IMAGE_ID_FIXTURE,
    OUTER_IMAGE_ID_FIXTURE,
    writeAgentLibCheckout,
} from '../helpers/agentlibFixture.mjs';

// The Box installs only mcp-sdk, copied from the package the Box image supplies.
// achillesAgentLib arrives as a selected source the supervisor established,
// which the installer validates but never creates.
const INSTALLED_DEPENDENCIES = ['mcp-sdk'];
const MOUNT_FINGERPRINT = 'b2'.repeat(32);
const OTHER_OUTER_IMAGE = `sha256:${'d4'.repeat(32)}`;

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
    const env = {
        [AGENTLIB_ENV.dir]: agentLibPath,
        [AGENTLIB_ENV.mode]: 'local',
        [AGENTLIB_ENV.fingerprint]: MOUNT_FINGERPRINT,
        [AGENTLIB_ENV.commit]: '',
        [BOX_IMAGE_ID_ENV]: OUTER_IMAGE_ID_FIXTURE,
    };
    const bundledMcpSdkPath = path.join(root, 'bundled-mcp-sdk');
    fs.mkdirSync(bundledMcpSdkPath);
    fs.writeFileSync(path.join(bundledMcpSdkPath, 'package.json'), JSON.stringify({
        name: '@modelcontextprotocol/sdk',
        version: '1.19.1',
        type: 'module',
        exports: { '.': './index.mjs' },
    }));
    fs.writeFileSync(path.join(bundledMcpSdkPath, 'index.mjs'), 'export const bundled = true;\n');
    return { root, targetRoot, markerPath, agentLibPath, env, bundledMcpSdkPath };
}

function expectedMarker(supplyingImageId = OUTER_IMAGE_ID_FIXTURE) {
    return {
        schema: DEPENDENCY_MARKER_SCHEMA,
        providedLibraries: { 'mcp-sdk': { kind: 'image', library: 'mcp-sdk', supplyingImageId } },
    };
}

function fakeInstaller(counter, { failName = '' } = {}) {
    return ({ name, destination, sourcePath }) => {
        counter.push(name);
        if (name === failName) throw new Error('simulated install failure');
        fs.cpSync(sourcePath, destination, { recursive: true });
        fs.writeFileSync(path.join(destination, 'payload'), `installed:${name}`);
    };
}

function installedPayload(directory) {
    try { return fs.readFileSync(path.join(directory, 'payload'), 'utf8'); } catch { return ''; }
}

test('the Box marker records the supplying image identity, never a lock fingerprint or commit', (t) => {
    const state = fixture(t);
    const installs = [];
    const options = { ...state, installLibrary: fakeInstaller(installs), token: 'first' };
    const first = prepareImageDependencies(options);
    assert.equal(first.changed, true);
    assert.deepEqual(BOX_INSTALLED_DEPENDENCIES, INSTALLED_DEPENDENCIES);
    // achillesAgentLib is deliberately absent: it is a selected source, never installed.
    assert.deepEqual(installs.sort(), ['mcp-sdk']);
    assert.equal(fs.existsSync(path.join(state.targetRoot, 'mcp-sdk')), true);
    assert.equal(fs.existsSync(path.join(state.targetRoot, 'achillesAgentLib')), false);
    const marker = JSON.parse(fs.readFileSync(path.join(state.targetRoot, DEPENDENCY_MARKER_NAME), 'utf8'));
    assert.deepEqual(marker, expectedMarker());
    assert.deepEqual(first.marker, expectedMarker());

    installs.length = 0;
    const second = prepareImageDependencies({ ...options, token: 'second' });
    assert.equal(second.changed, false);
    assert.deepEqual(installs, []);
});

test('default preparation copies the supplied package without Git, npm or reading library bytes', (t) => {
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
    const readPaths = [];
    const fsApi = new Proxy(fs, {
        get(target, property) {
            if (property === 'readFileSync') {
                return (file, ...rest) => { readPaths.push(String(file)); return target.readFileSync(file, ...rest); };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const first = prepareImageDependencies({ ...state, fsApi, runner, token: 'bundled-first' });
    assert.equal(first.changed, true);
    assert.deepEqual(commands, ['cp', 'chmod']);
    const installed = path.join(state.targetRoot, 'mcp-sdk');
    assert.equal(fs.readFileSync(path.join(installed, 'index.mjs'), 'utf8'), 'export const bundled = true;\n');
    assert.equal(fs.existsSync(path.join(installed, '.git')), false);
    assert.notEqual(fs.statSync(installed).mode & 0o200, 0);
    const libraryReads = readPaths.filter((file) => file.startsWith(state.bundledMcpSdkPath)
        || file.startsWith(installed) || file.includes('.ploinky-box-deps-stage'));
    assert.ok(libraryReads.length > 0);
    assert.ok(libraryReads.every((file) => path.basename(file) === 'package.json'),
        `only package.json is read, never a library body: ${libraryReads.join(', ')}`);

    commands.length = 0;
    const second = prepareImageDependencies({ ...state, runner, token: 'bundled-second' });
    assert.equal(second.changed, false);
    assert.deepEqual(commands, []);

    // A functional, same-shape edit of the installed copy is not a content-digest failure.
    fs.writeFileSync(path.join(installed, 'index.mjs'), 'export const bundled = "edited";\n');
    assert.equal(prepareImageDependencies({ ...state, runner, token: 'bundled-edit' }).changed, false);
    assert.deepEqual(commands, []);

    // A matching marker never bypasses the structural checks: a hard-linked
    // entry point, a symlink or Git metadata inside the copy is repaired, and
    // still nothing is hashed.
    const external = path.join(state.root, 'external-entry.mjs');
    fs.writeFileSync(external, 'export const bundled = "external";\n');
    for (const [label, tamper] of [
        ['a hard link to an external file as the entry point', () => {
            fs.rmSync(path.join(installed, 'index.mjs'));
            fs.linkSync(external, path.join(installed, 'index.mjs'));
        }],
        ['a hard link inside the copy', () => fs.linkSync(path.join(installed, 'index.mjs'), path.join(installed, 'second-name.mjs'))],
        ['a symlink inside the copy', () => fs.symlinkSync('index.mjs', path.join(installed, 'linked.mjs'))],
        ['a nested escaping symlink', () => {
            fs.mkdirSync(path.join(installed, 'nested'));
            fs.symlinkSync(os.tmpdir(), path.join(installed, 'nested', 'escape'));
        }],
        ['Git metadata', () => fs.mkdirSync(path.join(installed, '.git'))],
    ]) {
        tamper();
        commands.length = 0;
        const structural = prepareImageDependencies({ ...state, runner, token: `structural-${commands.length}` });
        assert.equal(structural.changed, true, label);
        assert.deepEqual(commands, ['cp', 'chmod'], label);
        assert.equal(fs.readFileSync(path.join(installed, 'index.mjs'), 'utf8'), 'export const bundled = true;\n', label);
        assert.equal(fs.existsSync(path.join(installed, 'linked.mjs')), false, label);
        assert.equal(fs.existsSync(path.join(installed, '.git')), false, label);
        commands.length = 0;
        assert.equal(prepareImageDependencies({ ...state, runner, token: 'settled' }).changed, false, `${label}: settled again`);
    }

    // A package that is no longer usable is repaired as one transaction.
    fs.rmSync(path.join(installed, 'index.mjs'));
    const repaired = prepareImageDependencies({ ...state, runner, token: 'bundled-repair' });
    assert.equal(repaired.changed, true);
    assert.deepEqual(commands, ['cp', 'chmod']);
    assert.equal(fs.readFileSync(path.join(installed, 'index.mjs'), 'utf8'), 'export const bundled = true;\n');
});

test('a changed supplying Box image refreshes the copy transactionally and rewrites the marker last', (t) => {
    const state = fixture(t);
    const installs = [];
    const options = { ...state, installLibrary: fakeInstaller(installs) };
    prepareImageDependencies({ ...options, token: 'image-a' });
    fs.writeFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'installed-for-image-a');

    installs.length = 0;
    const refreshed = prepareImageDependencies({
        ...options,
        env: { ...state.env, [BOX_IMAGE_ID_ENV]: OTHER_OUTER_IMAGE },
        token: 'image-b',
    });
    assert.equal(refreshed.changed, true);
    assert.deepEqual(installs, ['mcp-sdk']);
    assert.equal(installedPayload(path.join(state.targetRoot, 'mcp-sdk')), 'installed:mcp-sdk');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.targetRoot, DEPENDENCY_MARKER_NAME), 'utf8')),
        expectedMarker(OTHER_OUTER_IMAGE));
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
});

test('an interrupted image change never leaves the previous marker naming the new copy', (t) => {
    const state = fixture(t);
    const options = { ...state, installLibrary: fakeInstaller([]) };
    prepareImageDependencies({ ...options, token: 'image-a' });
    fs.writeFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'installed-for-image-a');
    const markerFile = path.join(state.targetRoot, DEPENDENCY_MARKER_NAME);
    const destination = path.join(state.targetRoot, 'mcp-sdk');
    // No bytes are compared, so the marker is the only claim about the copy. While
    // the new copy is in place and its marker is not yet written, none may exist:
    // a crash in that window must read as a miss on the next start.
    const markerPresentAtSwap = [];
    const interrupted = {
        ...fs,
        renameSync(from, to) {
            fs.renameSync(from, to);
            // Only the staged copy moving in, not the rollback restoring the backup.
            if (to === destination && from.includes('image-b') && path.basename(from) === 'mcp-sdk') {
                markerPresentAtSwap.push(fs.existsSync(markerFile));
            }
        },
        writeFileSync(file, ...rest) {
            if (path.basename(file) === DEPENDENCY_MARKER_NAME) throw new Error('simulated interruption before the marker write');
            return fs.writeFileSync(file, ...rest);
        },
    };
    assert.throws(() => prepareImageDependencies({
        ...options, fsApi: interrupted, env: { ...state.env, [BOX_IMAGE_ID_ENV]: OTHER_OUTER_IMAGE }, token: 'image-b',
    }), /Box dependency preparation failed/);
    assert.deepEqual(markerPresentAtSwap, [false], 'the previous marker still named image A while image B\'s copy was in place');
    // The failed change rolled back to image A's copy and marker, so image A reuses it.
    assert.equal(installedPayload(destination), 'installed-for-image-a');
    assert.deepEqual(JSON.parse(fs.readFileSync(markerFile, 'utf8')), expectedMarker());
    assert.equal(prepareImageDependencies({ ...options, token: 'image-a-again' }).changed, false);
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
});

test('a nested agent image ID is never the supplier identity', (t) => {
    const state = fixture(t);
    const installs = [];
    prepareImageDependencies({ ...state, installLibrary: fakeInstaller(installs), token: 'outer' });
    installs.length = 0;
    // Only the outer Box image ID matters: an unrelated nested image ID in the
    // environment neither changes the identity nor forces a refresh.
    const result = prepareImageDependencies({
        ...state,
        env: { ...state.env, PLOINKY_NESTED_IMAGE_ID: NESTED_IMAGE_ID_FIXTURE },
        installLibrary: fakeInstaller(installs),
        token: 'nested',
    });
    assert.equal(result.changed, false);
    assert.deepEqual(installs, []);
});

test('a marker of any other shape is a miss and the copy is replaced transactionally', (t) => {
    for (const previous of [
        // The shape earlier versions wrote.
        { fingerprint: 'e'.repeat(64), repositories: { 'mcp-sdk': 'a'.repeat(40) } },
        { schema: DEPENDENCY_MARKER_SCHEMA, providedLibraries: {} },
        { ...expectedMarker(), extra: true },
        'not json',
    ]) {
        const state = fixture(t);
        const installs = [];
        fs.mkdirSync(path.join(state.targetRoot, 'mcp-sdk'));
        fs.writeFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'old');
        fs.writeFileSync(path.join(state.targetRoot, DEPENDENCY_MARKER_NAME),
            typeof previous === 'string' ? previous : JSON.stringify(previous));
        const result = prepareImageDependencies({ ...state, installLibrary: fakeInstaller(installs), token: 'miss' });
        assert.equal(result.changed, true);
        assert.deepEqual(installs, ['mcp-sdk']);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state.targetRoot, DEPENDENCY_MARKER_NAME), 'utf8')),
            expectedMarker());
    }
});

test('a missing, mutable or noncanonical Box image ID fails before any cleanup or mutation', (t) => {
    for (const [label, boxId] of [
        ['missing', undefined],
        ['a mutable reference', 'docker.io/assistos/ploinky-box:latest'],
        ['bare hex', 'b2'.repeat(32)],
    ]) {
        const state = fixture(t);
        // An owned leftover the existing cleanup would remove after valid admission.
        const stale = path.join(state.targetRoot, 'achillesAgentLib');
        fs.mkdirSync(stale);
        fs.writeFileSync(path.join(stale, 'payload'), 'owned artifact');
        const installs = [];
        const env = { ...state.env };
        if (boxId === undefined) delete env[BOX_IMAGE_ID_ENV]; else env[BOX_IMAGE_ID_ENV] = boxId;
        assert.throws(() => prepareImageDependencies({
            ...state, env, installLibrary: fakeInstaller(installs),
        }), new RegExp(`${BOX_IMAGE_ID_ENV} must carry`), label);
        assert.deepEqual(installs, [], label);
        assert.equal(fs.existsSync(path.join(stale, 'payload')), true,
            `${label}: an owned artifact must survive an invalid admission`);
        assert.deepEqual(fs.readdirSync(state.targetRoot), ['achillesAgentLib']);
    }
});

test('an unusable supplied package fails before cache mutation or cleanup', (t) => {
    const state = fixture(t);
    const stale = path.join(state.targetRoot, 'achillesAgentLib');
    fs.mkdirSync(stale);
    const missing = path.join(state.root, 'missing-bundle');
    assert.throws(
        () => prepareImageDependencies({ ...state, bundledMcpSdkPath: missing, token: 'missing-bundle' }),
        /no usable bundled MCP SDK/,
    );
    assert.deepEqual(fs.readdirSync(state.targetRoot), ['achillesAgentLib']);

    for (const damage of [
        () => fs.writeFileSync(path.join(state.bundledMcpSdkPath, 'package.json'), JSON.stringify({ name: 'other', version: '1' })),
        () => fs.writeFileSync(path.join(state.bundledMcpSdkPath, 'package.json'), JSON.stringify({
            name: '@modelcontextprotocol/sdk', version: '1.19.1', exports: { '.': './index.mjs' },
        })) || fs.rmSync(path.join(state.bundledMcpSdkPath, 'index.mjs')),
    ]) {
        damage();
        assert.throws(
            () => prepareImageDependencies({ ...state, token: 'damaged-bundle' }),
            /no usable bundled MCP SDK/,
        );
        assert.deepEqual(fs.readdirSync(state.targetRoot), ['achillesAgentLib']);
    }
});

test('partial installs are repaired as one replacement', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.targetRoot, 'mcp-sdk'));
    fs.writeFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'partial');
    const installs = [];
    const result = prepareImageDependencies({
        ...state,
        installLibrary: fakeInstaller(installs),
        token: 'repair',
    });
    assert.equal(result.changed, true);
    assert.equal(installedPayload(path.join(state.targetRoot, 'mcp-sdk')), 'installed:mcp-sdk');
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
});

test('repair backs up a real owner-read-only dependency without losing unrelated data', (t) => {
    const state = fixture(t);
    for (const name of INSTALLED_DEPENDENCIES) {
        const directory = path.join(state.targetRoot, name);
        fs.mkdirSync(directory);
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
    const result = prepareImageDependencies({
        ...state,
        fsApi,
        installLibrary: fakeInstaller([]),
        token: 'readonly-repair',
    });
    assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(path.join(state.targetRoot, 'unrelated-canary'), 'utf8'), 'retain');
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
    for (const name of INSTALLED_DEPENDENCIES) {
        assert.equal(installedPayload(path.join(state.targetRoot, name)), `installed:${name}`);
    }
});

test('failed swap restores a dependency mode changed only for backup', (t) => {
    const state = fixture(t);
    for (const name of INSTALLED_DEPENDENCIES) {
        const directory = path.join(state.targetRoot, name);
        fs.mkdirSync(directory);
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
    assert.throws(() => prepareImageDependencies({
        ...state,
        fsApi,
        installLibrary: fakeInstaller([]),
        token: 'rollback-mode',
    }), /Box dependency preparation failed/);
    assert.equal(fs.statSync(protectedDirectory).mode & 0o777, 0o500);
    for (const name of INSTALLED_DEPENDENCIES) {
        assert.equal(
            fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'),
            `original:${name}`,
        );
    }
    fs.chmodSync(protectedDirectory, 0o700);
});

test('failed repair preserves established dependency directories and never stamps completion', (t) => {
    const state = fixture(t);
    for (const name of INSTALLED_DEPENDENCIES) {
        fs.mkdirSync(path.join(state.targetRoot, name));
        fs.writeFileSync(path.join(state.targetRoot, name, 'payload'), `original:${name}`);
    }
    const before = Object.fromEntries(INSTALLED_DEPENDENCIES.map((name) => [
        name,
        fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'),
    ]));
    assert.throws(() => prepareImageDependencies({
        ...state,
        installLibrary: fakeInstaller([], { failName: 'mcp-sdk' }),
        token: 'failure',
    }), /Box dependency preparation failed/);
    for (const [name, payload] of Object.entries(before)) {
        assert.equal(fs.readFileSync(path.join(state.targetRoot, name, 'payload'), 'utf8'), payload);
    }
    assert.equal(fs.existsSync(path.join(state.targetRoot, DEPENDENCY_MARKER_NAME)), false);
});

test('a staged copy that is not a usable package is never committed', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.targetRoot, 'mcp-sdk'));
    fs.writeFileSync(path.join(state.targetRoot, 'mcp-sdk', 'payload'), 'original');
    assert.throws(() => prepareImageDependencies({
        ...state,
        installLibrary: ({ destination }) => {
            fs.mkdirSync(destination);
            fs.writeFileSync(path.join(destination, 'payload'), 'empty shell');
        },
        token: 'unusable-stage',
    }), /not a usable package/);
    assert.equal(installedPayload(path.join(state.targetRoot, 'mcp-sdk')), 'original');
    assert.equal(fs.existsSync(path.join(state.targetRoot, DEPENDENCY_MARKER_NAME)), false);
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
});

test('post-commit backup cleanup failure cannot roll back the installed dependency set', (t) => {
    const state = fixture(t);
    for (const name of INSTALLED_DEPENDENCIES) {
        fs.mkdirSync(path.join(state.targetRoot, name));
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
    const result = prepareImageDependencies({
        ...state,
        fsApi,
        installLibrary: fakeInstaller([]),
        token: 'cleanup-failure',
    });
    assert.equal(result.changed, true);
    assert.equal(failedCleanup, true);
    for (const name of INSTALLED_DEPENDENCIES) {
        assert.equal(installedPayload(path.join(state.targetRoot, name)), `installed:${name}`);
    }
    assert.equal(fs.readdirSync(state.targetRoot).some((name) => name.includes('stage')), false);
});

test('marker mismatch and symlink volume roots fail before installation', (t) => {
    const state = fixture(t);
    fs.writeFileSync(state.markerPath, 'wrong\n');
    const installs = [];
    assert.throws(() => prepareImageDependencies({
        ...state,
        installLibrary: fakeInstaller(installs),
    }), /marker has invalid content/i);
    assert.deepEqual(installs, []);

    fs.writeFileSync(state.markerPath, BOX_MARKER_CONTENT);
    const realRoot = path.join(state.root, 'real-root');
    fs.mkdirSync(realRoot);
    const linkedRoot = path.join(state.root, 'linked-root');
    fs.symlinkSync(realRoot, linkedRoot, 'dir');
    assert.throws(() => prepareImageDependencies({
        targetRoot: linkedRoot,
        markerPath: state.markerPath,
        installLibrary: fakeInstaller(installs),
    }), /not a real directory/);
});

// --- selected achillesAgentLib ---------------------------------------------

test('preparation requires the supervisor-selected AgentLib source', (t) => {
    const state = fixture(t);
    const installs = [];
    const attempt = (env, agentLibPath = state.agentLibPath) => prepareImageDependencies({
        ...state,
        env,
        agentLibPath,
        installLibrary: fakeInstaller(installs),
    });

    // A missing contract is an error, not permission to obtain a copy in-Box.
    assert.throws(() => attempt({}), new RegExp(`${AGENTLIB_ENV.dir} must be`));
    assert.throws(
        () => attempt({ ...state.env, [AGENTLIB_ENV.dir]: '/somewhere/else' }),
        new RegExp(`${AGENTLIB_ENV.dir} must be`),
    );
    assert.throws(
        () => attempt({ ...state.env, [AGENTLIB_ENV.fingerprint]: 'not-a-digest' }),
        new RegExp(`${AGENTLIB_ENV.fingerprint} must carry`),
    );
    assert.deepEqual(installs, [], 'nothing may be installed before the source is proven');

    const missingMount = path.join(state.root, 'absent-agentlib');
    assert.throws(
        () => attempt({ ...state.env, [AGENTLIB_ENV.dir]: missingMount }, missingMount),
        /direct mount is missing/,
    );

    const wrongPackage = path.join(state.root, 'wrong-agentlib');
    fs.mkdirSync(wrongPackage);
    writeAgentLibCheckout(wrongPackage);
    fs.writeFileSync(path.join(wrongPackage, 'package.json'), JSON.stringify({ name: 'something-else' }));
    assert.throws(
        () => attempt({ ...state.env, [AGENTLIB_ENV.dir]: wrongPackage }, wrongPackage),
        /declares package name 'something-else'/,
    );
    assert.deepEqual(installs, []);
});

test('an image AgentLib is validated against the Box image and as a package, never hashed', (t) => {
    const state = fixture(t);
    const imageEnv = {
        [AGENTLIB_ENV.dir]: state.agentLibPath,
        [AGENTLIB_ENV.mode]: 'image',
        [AGENTLIB_ENV.sourceId]: imageSourceIdHash(imageSourceIdentity(OUTER_IMAGE_ID_FIXTURE)),
        [BOX_IMAGE_ID_ENV]: OUTER_IMAGE_ID_FIXTURE,
    };
    const readPaths = [];
    const fsApi = new Proxy(fs, {
        get(target, property) {
            if (property === 'readFileSync') {
                return (file, ...rest) => { readPaths.push(String(file)); return target.readFileSync(file, ...rest); };
            }
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    const validated = validateMountedAgentLib({ fsApi, env: imageEnv, sourcePath: state.agentLibPath });
    assert.equal(validated.mode, 'image');
    assert.equal(validated.supplyingImageId, OUTER_IMAGE_ID_FIXTURE);
    assert.equal(Object.hasOwn(validated, 'fingerprint'), false);
    assert.deepEqual(readPaths, [path.join(state.agentLibPath, 'package.json')],
        'only the package manifest is read: no library body is hashed at Box start or on an install exec');

    for (const [label, env, expected] of [
        ['a source identity for another image', { ...imageEnv, [BOX_IMAGE_ID_ENV]: OTHER_OUTER_IMAGE }, /does not match the Box image/],
        ['a missing Box image ID', { ...imageEnv, [BOX_IMAGE_ID_ENV]: undefined }, new RegExp(`${BOX_IMAGE_ID_ENV} must carry`)],
        ['a legacy fingerprint-only image contract', { ...imageEnv, [AGENTLIB_ENV.sourceId]: 'b'.repeat(64) }, /does not match the Box image/],
    ]) {
        assert.throws(() => validateMountedAgentLib({ env, sourcePath: state.agentLibPath }), expected, label);
    }

    fs.unlinkSync(path.join(state.agentLibPath, 'LLMAgents/openAiAgenticResponder.mjs'));
    assert.throws(() => validateMountedAgentLib({ env: imageEnv, sourcePath: state.agentLibPath }),
        /missing required entry point LLMAgents\/openAiAgenticResponder\.mjs/);
});

test('image and local Achilles both prepare the SDK from the same outer image identity', (t) => {
    const state = fixture(t);
    const imageEnv = {
        [AGENTLIB_ENV.dir]: state.agentLibPath,
        [AGENTLIB_ENV.mode]: 'image',
        [AGENTLIB_ENV.sourceId]: imageSourceIdHash(imageSourceIdentity(OUTER_IMAGE_ID_FIXTURE)),
        [BOX_IMAGE_ID_ENV]: OUTER_IMAGE_ID_FIXTURE,
    };
    const installs = [];
    const local = prepareImageDependencies({ ...state, installLibrary: fakeInstaller(installs), token: 'local' });
    const image = prepareImageDependencies({ ...state, env: imageEnv, installLibrary: fakeInstaller(installs), token: 'image' });
    assert.deepEqual(local.marker, image.marker);
    assert.equal(image.changed, false, 'the SDK copy is keyed by the outer image, independently of Achilles mode');
});

test('a leftover Box-installed achillesAgentLib is removed rather than loaded', (t) => {
    const state = fixture(t);
    const stale = path.join(state.targetRoot, 'achillesAgentLib');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'payload'), 'stale copy');
    const result = prepareImageDependencies({
        ...state,
        installLibrary: fakeInstaller([]),
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
    assert.throws(() => prepareImageDependencies({
        ...state,
        installLibrary: fakeInstaller(installs),
    }), new RegExp(`direct-mounted at ${AGENTLIB_STABLE_MOUNT_PATH}`));
    assert.deepEqual(installs, [], 'a suspicious entry blocks installation instead of being consumed');
});

test('the marker covers only the libraries the Box copies from its image', (t) => {
    const state = fixture(t);
    const result = prepareImageDependencies({
        ...state,
        installLibrary: fakeInstaller([]),
        token: 'marker-scope',
    });
    assert.deepEqual(Object.keys(result.marker.providedLibraries), INSTALLED_DEPENDENCIES);
});
