import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(TEST_FILE, '../../..');
const SOURCE = path.join(REPO_ROOT, 'ploinky-box/native/ploinky-bwrap-launch.c');
const TEST_SHA = '0123456789abcdef0123456789abcdef01234567';
const RECORD = Object.freeze({
    ARG: 1,
    WORKSPACE: 2,
    WORKDIR: 3,
    HOME: 4,
    RO_PATH: 5,
    DIR: 6,
    TMPFS: 7,
    PROC: 8,
    DEV: 9,
    SYMLINK: 10,
    PREEXEC_BARRIER: 11,
    RO_DATA_PATH: 12,
});

let fixtureRoot;
let helper;

function cc() {
    return process.env.CC || 'cc';
}

function compile(output, {
    sha = TEST_SHA,
    defineSha = true,
    workspaceRoot,
    bwrapPath,
} = {}) {
    const args = ['-std=c11', '-Wall', '-Wextra', '-Werror'];
    if (defineSha) args.push(`-DPLOINKY_SOURCE_SHA="${sha}"`);
    if (workspaceRoot) args.push(`-DPLOINKY_WORKSPACE_ROOT="${workspaceRoot}"`);
    if (bwrapPath) args.push(`-DPLOINKY_BWRAP_PATH="${bwrapPath}"`);
    args.push(SOURCE, '-o', output);
    return spawnSync(cc(), args, { encoding: 'utf8' });
}

function record(type, payload) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const header = Buffer.alloc(8);
    header[0] = type;
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
}

function descriptor(records) {
    const header = Buffer.alloc(16);
    header.write('PLBWLP02', 0, 'ascii');
    header.writeUInt32BE(records.length, 8);
    return Buffer.concat([header, ...records]);
}

function homeRecord(sourceKind, homeKey = '') {
    return record(RECORD.HOME, Buffer.concat([
        Buffer.from([sourceKind]),
        Buffer.from(homeKey),
    ]));
}

function homeMarker(homeKey, createdByGeneration = 'generation:phase-4') {
    return `${JSON.stringify({
        abi: 'ploinky-home-v2',
        createdByGeneration,
        homeKey,
        schemaVersion: 2,
    })}\n`;
}

function argsDescriptor(args, extraRecords = []) {
    return descriptor([
        ...args.map((arg) => record(RECORD.ARG, arg)),
        ...extraRecords,
    ]);
}

function credentialDescriptor(args, extraRecords = []) {
    return descriptor([
        record(RECORD.TMPFS, '/run'),
        record(RECORD.DIR, '/run/ploinky-agent'),
        ...extraRecords,
        ...args.map((arg) => record(RECORD.ARG, arg)),
    ]);
}

function roPathRecord(source, target, sourceType = 1) {
    const sourceBytes = Buffer.from(source);
    const targetBytes = Buffer.from(target);
    const payload = Buffer.alloc(5 + sourceBytes.length + targetBytes.length);
    payload[0] = sourceType;
    payload.writeUInt16BE(sourceBytes.length, 1);
    payload.writeUInt16BE(targetBytes.length, 3);
    sourceBytes.copy(payload, 5);
    targetBytes.copy(payload, 5 + sourceBytes.length);
    return record(RECORD.RO_PATH, payload);
}

function roDataPathRecord(source, target) {
    const sourceBytes = Buffer.from(source);
    const targetBytes = Buffer.from(target);
    const payload = Buffer.alloc(4 + sourceBytes.length + targetBytes.length);
    payload.writeUInt16BE(sourceBytes.length, 0);
    payload.writeUInt16BE(targetBytes.length, 2);
    sourceBytes.copy(payload, 4);
    targetBytes.copy(payload, 4 + sourceBytes.length);
    return record(RECORD.RO_DATA_PATH, payload);
}

function launchWithDescriptor(bytes, {
    executable = helper,
    env = process.env,
    fd4 = false,
    fd5 = false,
    argv = [],
    fd4Input = 'credential-fixture',
    fd5Input = '',
} = {}) {
    return new Promise((resolve, reject) => {
        const stdio = ['ignore', 'pipe', 'pipe', 'pipe'];
        if (fd4) stdio.push(fd4 === true ? 'pipe' : fd4);
        if (fd5) stdio.push(fd5 === true ? 'pipe' : fd5);
        const child = spawn(executable, argv, { stdio, env });
        const stdout = [];
        const stderr = [];
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.on('error', reject);
        child.stdio[3].on('error', () => {});
        child.stdio[3].end(bytes);
        if (fd4 === true) {
            child.stdio[4].on('error', () => {});
            child.stdio[4].end(fd4Input);
        }
        if (fd5 === true) {
            child.stdio[5].on('error', () => {});
            child.stdio[5].end(fd5Input);
        }
        child.on('close', (status, signal) => resolve({
            status,
            signal,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
        }));
    });
}

function barrierRecord(readyFd, releaseFd) {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(readyFd, 0);
    payload.writeUInt32BE(releaseFd, 4);
    return record(RECORD.PREEXEC_BARRIER, payload);
}

before(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-bwrap-helper-'));
    helper = path.join(fixtureRoot, 'ploinky-bwrap-launch');
    const result = compile(helper);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('source requires an immutable full source SHA at compilation', () => {
    const output = path.join(fixtureRoot, 'missing-source-sha');
    const missing = compile(output, { defineSha: false });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /PLOINKY_SOURCE_SHA must be the approved/);

    const malformedOutput = path.join(fixtureRoot, 'malformed-source-sha');
    const malformed = compile(malformedOutput, {
        sha: '0123456789ABCDEF0123456789ABCDEF01234567',
    });
    assert.equal(malformed.status, 0, malformed.stderr);
    const reported = spawnSync(malformedOutput, ['--version'], { encoding: 'utf8' });
    assert.equal(reported.status, 66);
    assert.match(reported.stderr, /^PLOINKY_HELPER_SOURCE_SHA_INVALID:/);
});

test('version and capability output expose the fixed source and fd ABI', () => {
    const version = spawnSync(helper, ['--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0);
    assert.equal(version.stdout,
        `ploinky-bwrap-launch-v2 source-sha=${TEST_SHA}\n`);

    const capabilities = spawnSync(helper, ['--capabilities'], { encoding: 'utf8' });
    assert.equal(capabilities.status, 0);
    assert.match(capabilities.stdout, /protocol=2 descriptor-fd=3/);
    assert.match(capabilities.stdout,
        /path-resolution=openat2-beneath-no-magiclinks-no-symlinks/);
    assert.match(capabilities.stdout,
        /bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms/);
    assert.match(capabilities.stdout,
        /typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file/);
    assert.match(capabilities.stdout, /ro-data-path-hardening=sealed-memfd-ro-bind-data/);
    assert.match(capabilities.stdout, /preexec-barrier=R\/G/);
    assert.match(capabilities.stdout, /credential-bound=4096/);
    assert.match(capabilities.stdout,
        /home-sources=sandbox-workspace-v2,container-native/);
    assert.match(capabilities.stdout, /home-marker=ploinky-home-v2-schema-2/);
    assert.match(capabilities.stdout, /home-revalidation=post-barrier-G/);
});

test('normal launch accepts only its bounded versioned descriptor on fd 3', async () => {
    const option = await launchWithDescriptor(Buffer.alloc(0), { argv: ['--launch', '3'] });
    assert.equal(option.status, 64);
    assert.match(option.stderr, /^PLOINKY_BWRAP_PROTOCOL_INVALID:/);

    const malformed = await launchWithDescriptor(Buffer.from('not-a-descriptor'));
    assert.equal(malformed.status, 64);
    assert.match(malformed.stderr, /invalid versioned launch header/);

    const unknown = await launchWithDescriptor(descriptor([record(99, '')]));
    assert.equal(unknown.status, 64);
    assert.match(unknown.stderr, /unknown launch record type 99/);

    const oversized = await launchWithDescriptor(Buffer.alloc(256 * 1024 + 1));
    assert.equal(oversized.status, 65);
    assert.match(oversized.stderr, /^PLOINKY_BWRAP_PROTOCOL_TOO_LARGE:/);
});

test('protocol v2 HOME is typed and rejects caller paths and malformed source contracts', async () => {
    const invalidPayloads = [
        Buffer.alloc(0),
        Buffer.from([0]),
        Buffer.from([3]),
        Buffer.from([2, 0x78]),
        Buffer.from([1]),
        Buffer.concat([Buffer.from([1]), Buffer.from('.data/codex.sandbox-v2')]),
        Buffer.concat([Buffer.from([1]), Buffer.from('codex')]),
        Buffer.concat([Buffer.from([1]), Buffer.from('../codex.sandbox-v2')]),
        Buffer.concat([Buffer.from([1]), Buffer.from('codex/escape.sandbox-v2')]),
        Buffer.concat([Buffer.from([1]), Buffer.from('codex\0.sandbox-v2')]),
        Buffer.concat([Buffer.from([1]), Buffer.from('codex+unsafe.sandbox-v2')]),
        Buffer.concat([Buffer.from([1]), Buffer.alloc(256, 0x61)]),
    ];

    for (const payload of invalidPayloads) {
        const result = await launchWithDescriptor(descriptor([
            record(RECORD.HOME, payload),
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]));
        assert.equal(result.status, 76, `${payload.toString('hex')}: ${result.stderr}`);
        assert.match(result.stderr, /^PLOINKY_HOME_STATE_INCOMPATIBLE:/);
    }

    for (const valid of [
        homeRecord(1, 'codex.sandbox-v2'),
        homeRecord(2),
    ]) {
        const result = await launchWithDescriptor(descriptor([
            valid,
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]));
        assert.doesNotMatch(result.stderr, /^PLOINKY_BWRAP_PROTOCOL_INVALID:/);
        if (process.platform !== 'linux') {
            assert.equal(result.status, 70, result.stderr);
        }
    }
});

test('sandbox HOME validates its fd-pinned directory and exact ABI marker before exec', {
    skip: process.platform !== 'linux',
}, async () => {
    const workspaceRoot = path.join(fixtureRoot, 'workspace-home-fixture');
    const dataRoot = path.join(workspaceRoot, '.data');
    const fakeBwrap = path.join(fixtureRoot, 'fake-bwrap');
    const stateHelper = path.join(fixtureRoot, 'ploinky-bwrap-home-state');
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(fakeBwrap, [
        '#!/bin/sh',
        'while [ "$#" -ge 3 ]; do',
        '  if [ "$1" = "--bind-fd" ] && [ "$3" = "/home/agent" ]; then',
        '    actual=$(readlink "/proc/self/fd/$2") || exit 92',
        '    [ "$actual" = "$PLOINKY_TEST_EXPECTED_HOME" ] || exit 93',
        '    exit 0',
        '  fi',
        '  shift',
        'done',
        'exit 91',
        '',
    ].join('\n'), { mode: 0o700 });
    const compiled = compile(stateHelper, { workspaceRoot, bwrapPath: fakeBwrap });
    assert.equal(compiled.status, 0, compiled.stderr);

    async function launchHomeRecord(home, expectedHome) {
        return launchWithDescriptor(descriptor([
            home,
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]), {
            executable: stateHelper,
            env: { ...process.env, PLOINKY_TEST_EXPECTED_HOME: expectedHome },
        });
    }

    async function launchHome(homeKey) {
        return launchHomeRecord(homeRecord(1, homeKey), path.join(dataRoot, homeKey));
    }

    function launchHomeAcrossBarrier(homeKey, mutateAfterReady) {
        return new Promise((resolve, reject) => {
            const expectedHome = path.join(dataRoot, homeKey);
            const child = spawn(stateHelper, [], {
                env: { ...process.env, PLOINKY_TEST_EXPECTED_HOME: expectedHome },
                stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
            });
            const stdout = [];
            const stderr = [];
            child.stdout.on('data', (chunk) => stdout.push(chunk));
            child.stderr.on('data', (chunk) => stderr.push(chunk));
            child.on('error', reject);
            child.stdio[3].on('error', () => {});
            child.stdio[3].end(descriptor([
                homeRecord(1, homeKey),
                barrierRecord(4, 5),
                record(RECORD.ARG, '--'),
                record(RECORD.ARG, '/bin/true'),
            ]));
            child.stdio[4].once('data', (ready) => {
                try {
                    assert.equal(ready.toString('utf8'), 'R');
                    mutateAfterReady();
                    child.stdio[5].end('G');
                } catch (error) {
                    child.kill();
                    reject(error);
                }
            });
            child.on('close', (status, signal) => resolve({
                status,
                signal,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            }));
        });
    }

    function makeHome(homeKey, marker = homeMarker(homeKey), {
        homeMode = 0o700,
        markerMode = 0o600,
    } = {}) {
        const homePath = path.join(dataRoot, homeKey);
        fs.mkdirSync(homePath, { mode: homeMode });
        if (marker !== null) {
            fs.writeFileSync(path.join(homePath, '.ploinky-home-abi.json'), marker, {
                mode: markerMode,
            });
        }
        return homePath;
    }

    makeHome('valid.sandbox-v2');
    const valid = await launchHome('valid.sandbox-v2');
    assert.equal(valid.status, 0, valid.stderr);

    const boundaryGenerationKey = 'boundary-generation.sandbox-v2';
    makeHome(boundaryGenerationKey,
        homeMarker(boundaryGenerationKey, `A${'b'.repeat(254)}`));
    const boundaryGeneration = await launchHome(boundaryGenerationKey);
    assert.equal(boundaryGeneration.status, 0, boundaryGeneration.stderr);

    const containerNative = await launchHomeRecord(homeRecord(2), '/root');
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
        assert.equal(containerNative.status, 0, containerNative.stderr);
    } else {
        assert.equal(containerNative.status, 76, containerNative.stderr);
        assert.match(containerNative.stderr, /^PLOINKY_HOME_STATE_INCOMPATIBLE:/);
    }

    const barrierValidKey = 'barrier-valid.sandbox-v2';
    makeHome(barrierValidKey);
    const barrierValid = await launchHomeAcrossBarrier(barrierValidKey, () => {});
    assert.equal(barrierValid.status, 0, barrierValid.stderr);

    const barrierRaceKey = 'barrier-race.sandbox-v2';
    const barrierRaceHome = makeHome(barrierRaceKey);
    const barrierRace = await launchHomeAcrossBarrier(barrierRaceKey, () => {
        const markerPath = path.join(barrierRaceHome, '.ploinky-home-abi.json');
        fs.rmSync(markerPath);
        fs.writeFileSync(markerPath, 'replaced-after-first-validation\n', { mode: 0o600 });
    });
    assert.equal(barrierRace.status, 76, barrierRace.stderr);
    assert.match(barrierRace.stderr, /^PLOINKY_HOME_STATE_INCOMPATIBLE:/);

    const fixtures = [
        {
            key: 'open-mode.sandbox-v2',
            options: { homeMode: 0o755 },
        },
        {
            key: 'missing-marker.sandbox-v2',
            marker: null,
        },
        {
            key: 'marker-mode.sandbox-v2',
            options: { markerMode: 0o644 },
        },
        {
            key: 'wrong-key.sandbox-v2',
            marker: homeMarker('different.sandbox-v2'),
        },
        {
            key: 'bad-generation.sandbox-v2',
            marker: homeMarker('bad-generation.sandbox-v2', 'bad generation'),
        },
        {
            key: 'bad-generation-first.sandbox-v2',
            marker: homeMarker('bad-generation-first.sandbox-v2', ':bad'),
        },
        {
            key: 'long-generation.sandbox-v2',
            marker: homeMarker('long-generation.sandbox-v2', `A${'b'.repeat(255)}`),
        },
        {
            key: 'noncanonical.sandbox-v2',
            marker: `${JSON.stringify({
                schemaVersion: 2,
                homeKey: 'noncanonical.sandbox-v2',
                createdByGeneration: 'generation:phase-4',
                abi: 'ploinky-home-v2',
            })}\n`,
        },
        {
            key: 'extra-key.sandbox-v2',
            marker: '{"abi":"ploinky-home-v2","createdByGeneration":"generation:phase-4","homeKey":"extra-key.sandbox-v2","schemaVersion":2,"extra":true}\n',
        },
        {
            key: 'oversized-marker.sandbox-v2',
            marker: 'x'.repeat(4097),
        },
    ];

    for (const fixture of fixtures) {
        makeHome(fixture.key, fixture.marker === undefined
            ? homeMarker(fixture.key)
            : fixture.marker, fixture.options);
        const result = await launchHome(fixture.key);
        assert.equal(result.status, 76, `${fixture.key}: ${result.stderr}`);
        assert.match(result.stderr, /^PLOINKY_HOME_STATE_INCOMPATIBLE:/);
    }

    const hardlinkedKey = 'hardlinked-marker.sandbox-v2';
    const hardlinkedHome = makeHome(hardlinkedKey);
    fs.linkSync(
        path.join(hardlinkedHome, '.ploinky-home-abi.json'),
        path.join(hardlinkedHome, 'marker-link'),
    );
    const hardlinked = await launchHome(hardlinkedKey);
    assert.equal(hardlinked.status, 76, hardlinked.stderr);
    assert.match(hardlinked.stderr, /^PLOINKY_HOME_STATE_INCOMPATIBLE:/);

    const symlinkMarkerKey = 'symlink-marker.sandbox-v2';
    const symlinkMarkerHome = makeHome(symlinkMarkerKey, null);
    fs.writeFileSync(path.join(symlinkMarkerHome, 'marker-target'),
        homeMarker(symlinkMarkerKey), { mode: 0o600 });
    fs.symlinkSync('marker-target',
        path.join(symlinkMarkerHome, '.ploinky-home-abi.json'));
    const symlinkMarker = await launchHome(symlinkMarkerKey);
    assert.equal(symlinkMarker.status, 76, symlinkMarker.stderr);
    assert.match(symlinkMarker.stderr, /^PLOINKY_HOME_STATE_INCOMPATIBLE:/);

    const symlinkHomeKey = 'symlink-home.sandbox-v2';
    const externalHome = path.join(fixtureRoot, 'external-sandbox-home');
    fs.mkdirSync(externalHome, { mode: 0o700 });
    fs.writeFileSync(path.join(externalHome, '.ploinky-home-abi.json'),
        homeMarker(symlinkHomeKey), { mode: 0o600 });
    fs.symlinkSync(externalHome, path.join(dataRoot, symlinkHomeKey));
    const symlinkHome = await launchHome(symlinkHomeKey);
    assert.equal(symlinkHome.status, 76, symlinkHome.stderr);
    assert.match(symlinkHome.stderr, /^PLOINKY_HOME_STATE_INCOMPATIBLE:/);
});

test('workspace root, traversal, protected state, and duplicate targets fail before openat2', async () => {
    for (const root of ['', '.', '/workspace']) {
        const result = await launchWithDescriptor(descriptor([
            record(RECORD.WORKDIR, root),
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]));
        assert.equal(result.status, 71, `${root}: ${result.stderr}`);
        assert.match(result.stderr, /^PLOINKY_WORKDIR_ROOT_FORBIDDEN:/);
    }

    for (const invalid of ['../escape', 'repo/../escape', '.data/agent', '.ploinky/run']) {
        const result = await launchWithDescriptor(descriptor([
            record(RECORD.WORKDIR, invalid),
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]));
        assert.equal(result.status, 72, `${invalid}: ${result.stderr}`);
        assert.match(result.stderr, /^PLOINKY_WORKDIR_INVALID:/);
    }

    const duplicate = await launchWithDescriptor(descriptor([
        record(RECORD.WORKSPACE, Buffer.from([1])),
        record(RECORD.WORKSPACE, Buffer.from([1])),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]));
    assert.equal(duplicate.status, 64);
    assert.match(duplicate.stderr, /^PLOINKY_BWRAP_DUPLICATE_MOUNT:/);

    const managedRepo = await launchWithDescriptor(descriptor([
        record(RECORD.WORKSPACE, Buffer.from([1])),
        record(RECORD.TMPFS, '/workspace/.ploinky'),
        record(RECORD.TMPFS, '/workspace/.data'),
        record(RECORD.DIR, '/workspace/.ploinky/repos'),
        record(RECORD.DIR, '/workspace/.ploinky/repos/example repo'),
        record(RECORD.WORKDIR, '.ploinky/repos/example repo/src'),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]));
    if (process.platform !== 'linux') {
        assert.equal(managedRepo.status, 70);
        assert.match(managedRepo.stderr, /^PLOINKY_PATHFD_UNAVAILABLE:/);
    } else {
        assert.notEqual(managedRepo.status, 71);
        assert.notEqual(managedRepo.status, 72);
    }
});

test('credential data fd is singular, mode 0400, and fixed to its private target', async () => {
    const cases = [
        {
            name: 'missing perms',
            args: ['--ro-bind-data', '4', '/run/ploinky-agent/credential.json', '--', '/bin/true'],
        },
        {
            name: 'wrong perms',
            args: ['--perms', '0444', '--ro-bind-data', '4', '/run/ploinky-agent/credential.json', '--', '/bin/true'],
        },
        {
            name: 'alternate target',
            args: ['--perms', '0400', '--ro-bind-data', '4', '/tmp/credential.json', '--', '/bin/true'],
            fd4: true,
        },
        {
            name: 'duplicate data mount',
            args: [
                '--perms', '0400', '--ro-bind-data', '4', '/run/ploinky-agent/credential.json',
                '--perms', '0400', '--ro-bind-data', '4', '/run/ploinky-agent/credential.json',
                '--', '/bin/true',
            ],
            fd4: true,
        },
    ];

    for (const fixture of cases) {
        const result = await launchWithDescriptor(credentialDescriptor(fixture.args), {
            fd4: fixture.fd4,
        });
        assert.equal(result.status, 64, `${fixture.name}: ${result.stderr}`);
        assert.match(result.stderr, /^PLOINKY_BWRAP_PROTOCOL_INVALID:/);
    }

    const collision = await launchWithDescriptor(descriptor([
        roPathRecord('/tmp/source', '/run/ploinky-agent/credential.json'),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]));
    assert.equal(collision.status, 73);
    assert.match(collision.stderr, /^PLOINKY_MOUNT_DESTINATION_UNSUPPORTED:/);

    const regularPath = path.join(fixtureRoot, 'credential-file');
    fs.writeFileSync(regularPath, '{}');
    const regularFd = fs.openSync(regularPath, 'r');
    try {
        const regular = await launchWithDescriptor(credentialDescriptor([
            '--perms', '0400', '--ro-bind-data', '4',
            '/run/ploinky-agent/credential.json', '--', '/bin/true',
        ]), { fd4: regularFd });
        assert.equal(regular.status, 64);
        assert.match(regular.stderr, /credential data fd must be a FIFO or connected unnamed/);
    } finally {
        fs.closeSync(regularFd);
    }

    const fifoPath = path.join(fixtureRoot, 'named-credential-fifo');
    const madeFifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(madeFifo.status, 0, madeFifo.stderr);
    const fifoFd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    try {
        const namedFifo = await launchWithDescriptor(credentialDescriptor([
            '--perms', '0400', '--ro-bind-data', '4',
            '/run/ploinky-agent/credential.json', '--', '/bin/true',
        ]), { fd4: fifoFd });
        assert.equal(namedFifo.status, 64);
        assert.match(namedFifo.stderr, /credential data fd must be a FIFO or connected unnamed/);
    } finally {
        fs.closeSync(fifoFd);
    }
});

test('typed filesystem records enforce exact destinations, collisions, and parent-first order', async () => {
    const valid = await launchWithDescriptor(descriptor([
        record(RECORD.WORKSPACE, Buffer.from([1])),
        record(RECORD.TMPFS, '/workspace/.ploinky'),
        record(RECORD.TMPFS, '/workspace/.data'),
        record(RECORD.TMPFS, '/tmp'),
        record(RECORD.TMPFS, '/tmp/cache'),
        record(RECORD.TMPFS, '/run'),
        record(RECORD.DIR, '/run/ploinky-agent'),
        record(RECORD.DIR, '/opt'),
        record(RECORD.DIR, '/home'),
        homeRecord(1, 'codex.sandbox-v2'),
        roPathRecord('/tmp', '/home/agent/.local'),
        record(RECORD.PROC, ''),
        record(RECORD.DEV, ''),
        record(RECORD.SYMLINK, Buffer.from([1])),
        record(RECORD.SYMLINK, Buffer.from([2])),
        record(RECORD.SYMLINK, Buffer.from([3])),
        record(RECORD.SYMLINK, Buffer.from([4])),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]));
    if (process.platform !== 'linux') {
        assert.equal(valid.status, 70, valid.stderr);
    } else {
        assert.doesNotMatch(valid.stderr, /PROTOCOL_INVALID|DESTINATION_UNSUPPORTED/);
    }

    const shorterPriorTarget = await launchWithDescriptor(descriptor([
        roPathRecord('/tmp', '/opt'),
        roPathRecord('/tmp', '/opt/tooling'),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]));
    assert.doesNotMatch(shorterPriorTarget.stderr,
        /PLOINKY_BWRAP_MOUNT_ORDER_INVALID|PLOINKY_BWRAP_PROTOCOL_INVALID/);

    const invalidFixtures = [
        {
            records: [record(RECORD.DIR, '/workspace')],
            status: 73,
            code: 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED',
        },
        {
            records: [record(RECORD.TMPFS, '/tmp/cache')],
            status: 64,
            code: 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
        },
        {
            records: [record(RECORD.TMPFS, '/workspace/.data')],
            status: 64,
            code: 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
        },
        {
            records: [record(RECORD.DIR, '/opt'), record(RECORD.DIR, '/opt')],
            status: 64,
            code: 'PLOINKY_BWRAP_DUPLICATE_MOUNT',
        },
        {
            records: [record(RECORD.PROC, 'unexpected')],
            status: 64,
            code: 'PLOINKY_BWRAP_PROTOCOL_INVALID',
        },
        {
            records: [record(RECORD.SYMLINK, Buffer.from([5]))],
            status: 64,
            code: 'PLOINKY_BWRAP_PROTOCOL_INVALID',
        },
        {
            records: [record(RECORD.DIR, '/proc/self')],
            status: 73,
            code: 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED',
        },
        {
            records: [roPathRecord('/tmp', '/home/agent')],
            status: 73,
            code: 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED',
        },
        {
            records: [roPathRecord('/tmp', '/home/agent/.local')],
            status: 64,
            code: 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
        },
        {
            records: [
                homeRecord(1, 'codex.sandbox-v2'),
                roPathRecord('/tmp', '/home/agent/.local/bin/codex', 2),
                roPathRecord('/tmp', '/home/agent/.local'),
            ],
            status: 64,
            code: 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
        },
        {
            records: [record(RECORD.DIR, '/workspace/project')],
            status: 73,
            code: 'PLOINKY_MOUNT_DESTINATION_UNSUPPORTED',
        },
        {
            records: [record(RECORD.DIR, '/workspace/readiness')],
            status: 64,
            code: 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
        },
        {
            records: [
                record(RECORD.WORKSPACE, Buffer.from([1])),
                record(RECORD.DIR, '/workspace/readiness'),
            ],
            status: 64,
            code: 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
        },
        {
            records: [
                record(RECORD.TMPFS, '/workspace'),
                record(RECORD.WORKDIR, 'project-a'),
            ],
            status: 64,
            code: 'PLOINKY_BWRAP_MOUNT_ORDER_INVALID',
        },
        {
            records: [
                record(RECORD.TMPFS, '/workspace'),
                record(RECORD.WORKSPACE, Buffer.from([1])),
            ],
            status: 64,
            code: 'PLOINKY_BWRAP_DUPLICATE_MOUNT',
        },
        {
            records: [
                record(RECORD.WORKSPACE, Buffer.from([1])),
                record(RECORD.TMPFS, '/workspace'),
            ],
            status: 64,
            code: 'PLOINKY_BWRAP_DUPLICATE_MOUNT',
        },
        {
            records: [
                record(RECORD.WORKSPACE, Buffer.from([1])),
                record(RECORD.WORKDIR, 'project-a'),
                record(RECORD.WORKDIR, 'project-b'),
            ],
            status: 64,
            code: 'PLOINKY_BWRAP_PROTOCOL_INVALID',
        },
    ];
    for (const fixture of invalidFixtures) {
        const result = await launchWithDescriptor(descriptor([
            ...fixture.records,
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]));
        assert.equal(result.status, fixture.status, result.stderr);
        assert.match(result.stderr, new RegExp(`^${fixture.code}:`));
    }
});

test('read-only data records admit only fixed system mappings through helper-owned fds', async () => {
    const valid = await launchWithDescriptor(descriptor([
        roDataPathRecord('/etc/hosts', '/etc/hosts'),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]));
    if (process.platform !== 'linux') {
        assert.equal(valid.status, 70, valid.stderr);
    } else {
        assert.notEqual(valid.status, 64, valid.stderr);
        assert.notEqual(valid.status, 73, valid.stderr);
    }

    for (const invalid of [
        roDataPathRecord('/etc/hosts', '/tmp/hosts'),
        roDataPathRecord('/etc/passwd', '/etc/hosts'),
    ]) {
        const result = await launchWithDescriptor(descriptor([
            invalid,
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]));
        assert.equal(result.status, 73, result.stderr);
        assert.match(result.stderr, /^PLOINKY_MOUNT_DESTINATION_UNSUPPORTED:/);
    }
});

test('private readiness uses an exact empty workspace tmpfs and ordered readiness directory', async () => {
    const result = await launchWithDescriptor(descriptor([
        record(RECORD.TMPFS, '/workspace'),
        record(RECORD.DIR, '/workspace/readiness'),
        record(RECORD.ARG, '--chdir'),
        record(RECORD.ARG, '/workspace/readiness'),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]));

    assert.notEqual(result.status, 64, result.stderr);
    assert.notEqual(result.status, 73, result.stderr);
    assert.doesNotMatch(result.stderr,
        /PLOINKY_BWRAP_(?:PROTOCOL_INVALID|MOUNT_ORDER_INVALID|DUPLICATE_MOUNT)|PLOINKY_MOUNT_DESTINATION_UNSUPPORTED/);
});

test('pre-exec barrier accepts only distinct anonymous IPC fds and cannot alias credentials', async () => {
    const sameFd = await launchWithDescriptor(descriptor([
        barrierRecord(4, 4),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]), { fd4: true });
    assert.equal(sameFd.status, 64);
    assert.match(sameFd.stderr, /pre-exec barrier fds must be distinct/);

    const duplicate = await launchWithDescriptor(descriptor([
        barrierRecord(4, 5),
        barrierRecord(4, 5),
        record(RECORD.ARG, '--'),
        record(RECORD.ARG, '/bin/true'),
    ]), { fd4: true, fd5: true });
    assert.equal(duplicate.status, 64);
    assert.match(duplicate.stderr, /invalid or duplicate pre-exec barrier/);

    const alias = await launchWithDescriptor(credentialDescriptor([
        '--perms', '0400', '--ro-bind-data', '4',
        '/run/ploinky-agent/credential.json', '--', '/bin/true',
    ], [barrierRecord(4, 5)]), { fd4: true, fd5: true });
    assert.equal(alias.status, 64);
    assert.match(alias.stderr, /credential data fd aliases a pre-exec barrier fd/);

    const regularPath = path.join(fixtureRoot, 'barrier-file');
    fs.writeFileSync(regularPath, 'not-an-ipc-endpoint');
    const regularFd = fs.openSync(regularPath, 'r');
    try {
        const regular = await launchWithDescriptor(descriptor([
            barrierRecord(4, 5),
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]), { fd4: regularFd, fd5: true });
        assert.equal(regular.status, 64);
        assert.match(regular.stderr, /pre-exec ready fd must be a FIFO or connected unnamed/);
    } finally {
        fs.closeSync(regularFd);
    }

    const fifoPath = path.join(fixtureRoot, 'named-barrier-fifo');
    const madeFifo = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(madeFifo.status, 0, madeFifo.stderr);
    const fifoFd = fs.openSync(fifoPath, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    try {
        const namedFifo = await launchWithDescriptor(descriptor([
            barrierRecord(4, 5),
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]), { fd4: fifoFd, fd5: true });
        assert.equal(namedFifo.status, 64);
        assert.match(namedFifo.stderr, /pre-exec ready fd must be a FIFO or connected unnamed/);
    } finally {
        fs.closeSync(fifoFd);
    }
});

test('path-backed AF_UNIX sockets are rejected as credential and barrier transports', async () => {
    const socketPath = path.join('/tmp', `ploinky-helper-${process.pid}.sock`);
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer();
    server.listen(socketPath);
    await once(server, 'listening');
    const acceptedPromise = once(server, 'connection');
    const client = net.createConnection(socketPath);
    await once(client, 'connect');
    const [accepted] = await acceptedPromise;
    const acceptedFd = accepted._handle.fd;
    try {
        const credential = await launchWithDescriptor(credentialDescriptor([
            '--perms', '0400', '--ro-bind-data', '4',
            '/run/ploinky-agent/credential.json', '--', '/bin/true',
        ]), { fd4: acceptedFd });
        assert.equal(credential.status, 64);
        assert.match(credential.stderr, /credential data fd must be a FIFO or connected unnamed/);

        const barrier = await launchWithDescriptor(descriptor([
            barrierRecord(4, 5),
            record(RECORD.ARG, '--'),
            record(RECORD.ARG, '/bin/true'),
        ]), { fd4: acceptedFd, fd5: true });
        assert.equal(barrier.status, 64);
        assert.match(barrier.stderr, /pre-exec ready fd must be a FIFO or connected unnamed/);
    } finally {
        accepted.destroy();
        client.destroy();
        server.close();
        fs.rmSync(socketPath, { force: true });
    }
});

test('raw path binds and fd-injection forms cannot bypass retained mount records', async () => {
    for (const injected of [
        ['--bind', '/tmp/source', '/tmp/target'],
        ['--bind=/tmp/source', '/tmp/target'],
        ['--ro-bind-fd', '9', '/tmp/target'],
        ['--args=9'],
        ['--userns', '9'],
        ['--overlay-src=9'],
        ['--lock-file', '/workspace/.ploinky/run/helper.lock'],
        ['--tmpfs', '/workspace/.data'],
        ['--tmpfs=/workspace/.data'],
        ['--dir', '/workspace/.ploinky'],
        ['--proc', '/workspace/.data'],
        ['--dev=/workspace/.ploinky'],
        ['--mqueue', '/workspace/.data'],
        ['--symlink', '/workspace/.data', '/tmp/state'],
        ['--chmod=0777', '/workspace/.data'],
        ['--remount-ro', '/workspace'],
        ['--size=4096'],
        ['--file-label', 'system_u:object_r:tmp_t:s0'],
        ['--cap-add=ALL'],
        ['--keep-fd', '9'],
        ['--unshare-user-try'],
        ['--unshare-cgroup-try=true'],
        ['--ro-bind-data=9', '/run/ploinky-agent/credential.json'],
    ]) {
        const result = await launchWithDescriptor(argsDescriptor([
            ...injected,
            '--',
            '/bin/true',
        ]));
        assert.equal(result.status, 64, `${injected[0]}: ${result.stderr}`);
        assert.match(result.stderr, /^PLOINKY_BWRAP_OPTION_FORBIDDEN:/);
    }
});

test('source pins every path with openat2 flags and has no pathname fallback', () => {
    const source = fs.readFileSync(SOURCE, 'utf8');
    assert.match(source, /SYS_openat2/);
    assert.match(source, /RESOLVE_BENEATH \| RESOLVE_NO_MAGICLINKS \| RESOLVE_NO_SYMLINKS/);
    assert.match(source, /O_PATH \| O_CLOEXEC/);
    assert.match(source, /"--bind-fd" : "--ro-bind-fd"/);
    assert.match(source, /MOUNT_RO_DATA_PATH/);
    assert.match(source, /MOUNT_RO_DATA_PATH[\s\S]+"--ro-bind-data"/);
    assert.match(source, /reopen_pinned_regular_readonly/);
    assert.match(source, /memfd_create\("ploinky-ro-data", MFD_CLOEXEC \| MFD_ALLOW_SEALING\)/);
    assert.match(source, /F_SEAL_SEAL \| F_SEAL_SHRINK/);
    assert.doesNotMatch(source, /mount->kind == MOUNT_RO_DATA_PATH[\s\S]+argv\[count\+\+\] = "--file"/);
    assert.doesNotMatch(source, /\brealpath\s*\(/);
    assert.doesNotMatch(source, /\blstat\s*\(/);
    assert.doesNotMatch(source, /PLOINKY_DISABLE_HOST_SANDBOX/);
    assert.match(source, /geteuid\(\) != getuid\(\)/);
});
