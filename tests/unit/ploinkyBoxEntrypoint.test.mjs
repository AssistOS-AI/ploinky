import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import {
    BOX_MARKER_CONTENT,
    BOX_READY_LINE,
    BOX_RUNTIME_UID,
} from '../../ploinky-box/constants.mjs';
import {
    BOX_RESERVED_PARENTS,
    BOX_RESERVED_SUBTREES,
} from '../../ploinky-box/contract/workspace-root.mjs';
import {
    entrypointPaths,
    formatEntrypointFailure,
    prepareEntrypoint,
    resetTransientNestedRuntime,
    retireStoppedManagedContainers,
    runEntrypoint,
    verifyEntrypointWorkspaceRoot,
} from '../../ploinky-box/entrypoint/entrypoint.mjs';
import {
    configureBoxTransport,
    parseExactTransport,
    writeTransportPair,
} from '../../ploinky-box/entrypoint/transport.mjs';

// The production Box path of a host-selected workspace. Fixtures place every
// production path under a synthetic root exactly once.
const BOX_WORKSPACE = '/srv/ploinky projects/proiect ăîș $(id)';

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-entrypoint-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = entrypointPaths(root, { workspaceRoot: BOX_WORKSPACE });
    for (const directory of [
        path.dirname(paths.marker),
        paths.workspace,
        paths.dependencies,
        paths.imageStore,
        paths.graphRoot,
        path.dirname(paths.ploinky),
        paths.tmp,
    ]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.marker, BOX_MARKER_CONTENT, { mode: 0o644 });
    fs.writeFileSync(paths.ploinky, '#!/usr/bin/env bash\n', { mode: 0o755 });
    // The reserved environment and working directory the host gives the Box.
    const box = {
        root,
        env: { PLOINKY_WORKSPACE_ROOT: BOX_WORKSPACE },
        cwd: () => paths.workspace,
    };
    return { root, paths, box };
}

// Shaped from real `podman info --format json` output captured against the
// pinned Podman 5.8.2 Box image; see
// tests/fixtures/ploinky-box/podman-info-storage-5.8.2.json.
function podmanStorageInfo(paths, overrides = {}) {
    return {
        store: {
            configFile: paths.storageConf,
            graphDriverName: 'overlay',
            graphRoot: paths.graphRoot,
            runRoot: paths.storageRunRoot,
            volumePath: path.join(paths.graphRoot, 'volumes'),
            imageCopyTmpDir: '/var/tmp',
            imageStore: { number: 0 },
            transientStore: true,
            ...overrides,
        },
    };
}

function routeRunner({
    routes = [{ dst: '198.51.100.1', prefsrc: '10.88.0.17', dev: 'eth0' }],
    addresses = [{
        ifname: 'eth0',
        addr_info: [{ family: 'inet', local: '10.88.0.17', prefixlen: 16 }],
    }],
    paths = null,
    storeOverrides = {},
} = {}) {
    const calls = [];
    return {
        calls,
        query(command, args) {
            calls.push([command, ...args]);
            if (command === 'podman' && args[0] === 'info') {
                if (!paths) throw new Error('Unexpected podman info query');
                // Real Podman lays the image store out on first contact.
                fs.mkdirSync(path.join(paths.imageStore, 'overlay-images'), { recursive: true });
                return {
                    ok: true,
                    stdout: JSON.stringify(podmanStorageInfo(paths, storeOverrides)),
                    stderr: '',
                };
            }
            if (args[2] === 'route') {
                return { ok: true, stdout: JSON.stringify(routes), stderr: '' };
            }
            if (args[2] === 'address') {
                return { ok: true, stdout: JSON.stringify(addresses), stderr: '' };
            }
            throw new Error(`Unexpected query: ${command} ${args.join(' ')}`);
        },
    };
}

function mode(target) {
    return fs.statSync(target).mode & 0o777;
}

test('exact route and assigned address produce one private atomic transport pair', (t) => {
    const { paths } = fixture(t);
    const runner = routeRunner();
    const result = configureBoxTransport({
        runner,
        transportFile: paths.transport,
        containersConf: paths.containersConf,
    });
    assert.deepEqual(runner.calls, [
        ['ip', '-j', '-4', 'route', 'get', '198.51.100.1'],
        ['ip', '-j', '-4', 'address', 'show', 'dev', 'eth0'],
    ]);
    assert.equal(result.address, '10.88.0.17');
    assert.equal(fs.readFileSync(paths.transport, 'utf8'),
        '{"address":"10.88.0.17","interface":"eth0"}\n');
    assert.equal(fs.readFileSync(paths.containersConf, 'utf8'),
        '[containers]\ndefault_sysctls=[]\n');
    assert.doesNotMatch(fs.readFileSync(paths.containersConf, 'utf8'), /\/proc:\/proc/,
        'nested containers must receive procfs from their own PID namespace');
    assert.equal(mode(paths.transport), 0o600);
    assert.equal(mode(paths.containersConf), 0o600);
    assert.equal(mode(path.dirname(paths.transport)), 0o700);
    assert.equal(mode(path.dirname(paths.containersConf)), 0o700);
    if (typeof process.getuid === 'function') {
        assert.equal(fs.statSync(paths.transport).uid, process.getuid());
        assert.equal(fs.statSync(paths.containersConf).uid, process.getuid());
    }
});

test('ambiguous routes and address/interface mismatches fail before either output exists', (t) => {
    for (const scenario of [
        { routes: [
            { prefsrc: '10.88.0.17', dev: 'eth0' },
            { prefsrc: '10.89.0.17', dev: 'eth1' },
        ] },
        { addresses: [{ ifname: 'eth0', addr_info: [{ family: 'inet', local: '10.88.0.99' }] }] },
    ]) {
        const { paths } = fixture(t);
        assert.throws(() => configureBoxTransport({
            runner: routeRunner(scenario),
            transportFile: paths.transport,
            containersConf: paths.containersConf,
        }), /exactly one|not assigned/);
        assert.equal(fs.existsSync(paths.transport), false);
        assert.equal(fs.existsSync(paths.containersConf), false);
    }
    assert.throws(() => parseExactTransport('not-json', '[]'), /valid JSON/);
});

test('failure between final commits leaves neither new file when no prior pair existed', (t) => {
    const { paths } = fixture(t);
    assert.throws(() => writeTransportPair({
        transport: { address: '10.88.0.17', interface: 'eth0' },
        transportFile: paths.transport,
        containersConf: paths.containersConf,
        token: 'a'.repeat(20),
        afterFirstCommit() { throw new Error('injected between commits'); },
    }), /Transport pair update failed/);
    assert.equal(fs.existsSync(paths.transport), false);
    assert.equal(fs.existsSync(paths.containersConf), false);
});

test('failure between final commits restores the complete prior transport pair', (t) => {
    const { paths } = fixture(t);
    fs.mkdirSync(path.dirname(paths.transport), { recursive: true });
    fs.mkdirSync(path.dirname(paths.containersConf), { recursive: true });
    fs.writeFileSync(paths.transport, 'old transport\n', { mode: 0o640 });
    fs.writeFileSync(paths.containersConf, 'old containers\n', { mode: 0o640 });
    assert.throws(() => writeTransportPair({
        transport: { address: '10.88.0.17', interface: 'eth0' },
        transportFile: paths.transport,
        containersConf: paths.containersConf,
        token: 'b'.repeat(20),
        afterFirstCommit() { throw new Error('injected between commits'); },
    }), /Transport pair update failed/);
    assert.equal(fs.readFileSync(paths.transport, 'utf8'), 'old transport\n');
    assert.equal(fs.readFileSync(paths.containersConf, 'utf8'), 'old containers\n');
    assert.equal(mode(paths.transport), 0o640);
    assert.equal(mode(paths.containersConf), 0o640);
});

test('transport rollback preserves prior inodes without requiring privilege to recreate their ownership', (t) => {
    const { paths } = fixture(t);
    const targets = [paths.transport, paths.containersConf];
    for (const target of targets) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `prior ${path.basename(target)}\n`, { mode: 0o640 });
    }
    const before = targets.map(target => ({ stat: fs.statSync(target), bytes: fs.readFileSync(target, 'utf8') }));
    let rollback = false;
    assert.throws(() => writeTransportPair({
        transport: { address: '10.88.0.17', interface: 'eth0' },
        transportFile: paths.transport,
        containersConf: paths.containersConf,
        fsApi: { ...fs, fchownSync(...args) {
            if (rollback) throw Object.assign(new Error('prior group cannot be assigned by this user'), { code: 'EPERM' });
            return fs.fchownSync(...args);
        } },
        afterFirstCommit() { rollback = true; throw new Error('injected'); },
    }), error => /Transport pair update failed/.test(error.message) && !/rollback failures/.test(error.message));
    targets.forEach((target, index) => {
        const after = fs.statSync(target);
        assert.equal(fs.readFileSync(target, 'utf8'), before[index].bytes);
        for (const field of ['ino', 'uid', 'gid', 'mode']) assert.equal(after[field], before[index].stat[field], field);
        assert.equal(after.nlink, 1);
    });
});

test('failure reserving the second prior transport file leaves both original files and no hardlink residue', (t) => {
    const { paths } = fixture(t);
    for (const target of [paths.transport, paths.containersConf]) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'prior\n');
    }
    let links = 0;
    assert.throws(() => writeTransportPair({
        transport: { address: '10.88.0.17', interface: 'eth0' },
        transportFile: paths.transport, containersConf: paths.containersConf,
        fsApi: { ...fs, linkSync(...args) {
            if (++links === 2) throw Object.assign(new Error('cannot reserve second backup'), { code: 'EIO' });
            return fs.linkSync(...args);
        } },
    }), /Transport pair update failed/);
    for (const target of [paths.transport, paths.containersConf]) {
        assert.equal(fs.readFileSync(target, 'utf8'), 'prior\n');
        assert.equal(fs.statSync(target).nlink, 1);
        assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
    }
});

test('entrypoint validates its marker and mounts before its first persistent write', (t) => {
    const { paths, box } = fixture(t);
    fs.writeFileSync(paths.marker, 'wrong\n');
    let initialized = false;
    assert.throws(() => prepareEntrypoint({
        ...box,
        initialize() { initialized = true; },
        configureTransport() { throw new Error('must not configure'); },
        installDependencies() { throw new Error('must not install'); },
    }), /marker has invalid content/i);
    assert.equal(initialized, false);
    assert.equal(fs.existsSync(path.join(paths.workspace, '.ploinky', 'data', 'master-key')), false);

    fs.writeFileSync(paths.marker, BOX_MARKER_CONTENT);
    fs.rmSync(paths.dependencies, { recursive: true });
    fs.symlinkSync(paths.workspace, paths.dependencies);
    assert.throws(() => prepareEntrypoint({ ...box }), /mount target|mount is missing/);
    assert.equal(fs.existsSync(path.join(paths.workspace, '.ploinky', 'data', 'master-key')), false);
});

test('transient cleanup removes only UID-keyed children and retains the tmpfs parent', (t) => {
    const { paths } = fixture(t);
    const calls = [];
    resetTransientNestedRuntime(paths, {
        fsApi: {
            rmSync(target, options) { calls.push([target, options]); },
        },
    });
    assert.deepEqual(calls, [
        [paths.storageRunRoot, { recursive: true, force: true }],
        [path.join(paths.tmp, `podman-run-${BOX_RUNTIME_UID}`), {
            recursive: true,
            force: true,
        }],
    ]);
    assert.equal(calls.some(([target]) => target === paths.tmp), false);

    const source = fs.readFileSync(
        path.join(import.meta.dirname, '../../ploinky-box/entrypoint/entrypoint.mjs'),
        'utf8',
    );
    assert.doesNotMatch(source, /\b(?:chown|sudo|setuid)\b|process\.setuid/);
});

test('full preparation creates one stable key, resets only transient runtime, and initializes pins', (t) => {
    const { paths, box } = fixture(t);
    // Keyed to the Box runtime UID, not the live process UID, so the reset that
    // is proven here is the exact runroot storage.conf configures.
    const transient = [
        paths.storageRunRoot,
        path.join(paths.tmp, `podman-run-${BOX_RUNTIME_UID}`),
    ];
    assert.equal(transient[0], path.join(paths.tmp, `storage-run-${BOX_RUNTIME_UID}`));
    for (const directory of transient) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'stale'), 'stale');
    }
    const persistent = path.join(paths.imageStore, 'persistent-canary');
    fs.writeFileSync(persistent, 'retain');
    const events = [];
    const options = {
        ...box,
        runner: routeRunner({ paths }),
        installDependencies({ targetRoot, markerPath }) {
            events.push('install');
            assert.equal(targetRoot, paths.dependencies);
            assert.equal(markerPath, paths.marker);
        },
    };
    const envPath = path.join(paths.workspace, '.env');
    fs.writeFileSync(envPath, 'APPLICATION_SETTING=preserve-me\n', { mode: 0o640 });
    const envBytes = fs.readFileSync(envPath);
    prepareEntrypoint(options);
    const keyPath = path.join(paths.workspace, '.ploinky', 'data', 'master-key');
    const keyBytes = fs.readFileSync(keyPath);
    assert.match(keyBytes.toString('utf8'), /^[a-f0-9]{64}\n$/);
    assert.equal(mode(keyPath), 0o600);
    assert.deepEqual(fs.readFileSync(envPath), envBytes);
    assert.equal(mode(envPath), 0o640);
    assert.deepEqual(events, ['install']);
    assert.equal(transient.some((target) => fs.existsSync(target)), false);
    assert.equal(fs.readFileSync(persistent, 'utf8'), 'retain');
    assert.equal(fs.readFileSync(paths.storageConf, 'utf8'), [
        '[storage]',
        'driver = "overlay"',
        `graphroot = "${paths.graphRoot}"`,
        `runroot = "${paths.storageRunRoot}"`,
        `imagestore = "${paths.imageStore}"`,
        'transient_store = true',
        '',
        '[storage.options.overlay]',
        'mount_program = "/usr/bin/fuse-overlayfs"',
        'force_mask = "0700"',
        '',
    ].join('\n'));
    assert.equal(mode(paths.storageConf), 0o600);

    prepareEntrypoint(options);
    assert.deepEqual(fs.readFileSync(keyPath), keyBytes);
    assert.deepEqual(fs.readFileSync(envPath), envBytes);
});

test('transport cleanup warnings are reported before readiness without failing the Box', (t) => {
    const { box } = fixture(t);
    const events = [];
    runEntrypoint({
        ...box,
        runner: routeRunner(),
        initialize() {},
        configureTransport() {
            return { address: '10.88.0.17', interface: 'eth0', warnings: ['transport backup /run/x.backup could not be removed: EIO'] };
        },
        configureStorage() { return { storageConf: '/home/podman/.config/containers/storage.conf' }; },
        resetRuntime() {},
        retireContainers() {},
        installDependencies() {},
        selfCheck() { events.push('self-check'); },
        errorOutput: { write(chunk) { events.push(`error:${String(chunk).trim()}`); } },
        output: { write(chunk) { events.push(`output:${String(chunk).trim()}`); } },
    });
    assert.deepEqual(events, [
        '[ploinky-box] WARNING: transport backup /run/x.backup could not be removed: EIO',
        'self-check',
        `output:${BOX_READY_LINE}`,
    ].map((event) => (event.startsWith('[ploinky-box]') ? `error:${event}` : event)));
});

test('ready line is emitted exactly once and only after every required stage', (t) => {
    const { box } = fixture(t);
    const events = [];
    const output = {
        write(chunk) { events.push(`output:${String(chunk).trim()}`); },
    };
    runEntrypoint({
        ...box,
        runner: routeRunner(),
        initialize() { events.push('initialize'); },
        configureTransport() {
            events.push('transport');
            return { address: '10.88.0.17', interface: 'eth0' };
        },
        configureStorage() {
            events.push('storage');
            return { storageConf: '/home/podman/.config/containers/storage.conf' };
        },
        resetRuntime() { events.push('reset'); },
        retireContainers() { events.push('retire-containers'); },
        installDependencies() { events.push('dependencies'); },
        selfCheck() { events.push('self-check'); },
        output,
    });
    // Storage configuration must precede every stage that can reach inner
    // Podman, and the transient runroot is reset before it is configured.
    assert.deepEqual(events, [
        'reset', 'storage', 'initialize', 'transport', 'retire-containers', 'dependencies',
        'self-check', `output:${BOX_READY_LINE}`,
    ]);
});

function retainedContainerFixture(t, {
    running = false,
    status = 'exited',
    includeRegistry = true,
    mutateRegistry = (record) => record,
    mutateLabels = (labels) => labels,
} = {}) {
    const { paths } = fixture(t);
    const containerId = 'a'.repeat(64);
    const instanceId = 'instance-a';
    const enableGeneration = 'generation-a';
    const workspaceHash = crypto.createHash('sha256')
        .update(fs.realpathSync(paths.workspace))
        .digest('hex')
        .slice(0, 12);
    fs.mkdirSync(path.join(paths.workspace, '.ploinky'));
    const registryRecord = mutateRegistry({
        type: 'agent',
        runtime: 'podman',
        containerId,
        instanceId,
        enableGeneration,
    });
    fs.writeFileSync(path.join(paths.workspace, '.ploinky', 'agents.json'), JSON.stringify(
        includeRegistry ? { ploinky_demo: registryRecord } : {},
    ));
    const labels = mutateLabels({
        'io.assistos.ploinky.managed': '1',
        'io.assistos.ploinky.resource': 'agent',
        'io.assistos.ploinky.network-schema': NETWORK_SCHEMA_VERSION,
        'io.assistos.ploinky.workspace': workspaceHash,
        'io.assistos.ploinky.network-contract': 'b'.repeat(64),
        'io.assistos.ploinky.instance-id': instanceId,
        'io.assistos.ploinky.enable-generation': enableGeneration,
    });
    const calls = [];
    const runner = {
        query(command, args) {
            calls.push(['query', command, ...args]);
            if (args[1] === 'ps') return { ok: true, stdout: `${containerId}\n`, stderr: '' };
            if (args[1] === 'inspect') {
                return {
                    ok: true,
                    stdout: JSON.stringify([{
                        Id: containerId,
                        Name: 'ploinky_demo',
                        Config: { Labels: labels },
                        State: { Running: running, Status: status },
                    }]),
                    stderr: '',
                };
            }
            throw new Error(`Unexpected query: ${command} ${args.join(' ')}`);
        },
        run(command, args) {
            calls.push(['run', command, ...args]);
        },
    };
    return { paths, containerId, runner, calls };
}

test('entrypoint retires only an exact stopped managed container without touching retained data', (t) => {
    const { paths, containerId, runner, calls } = retainedContainerFixture(t);

    assert.deepEqual(retireStoppedManagedContainers(paths, { runner }), [containerId]);
    assert.equal(calls[0].includes('--no-trunc'), true);
    assert.deepEqual(calls.at(-1), ['run', 'podman', 'container', 'rm', containerId]);
    assert.equal(calls.some((call) => call.includes('-f') || call.includes('--volumes')), false);
});

test('entrypoint refuses and preserves a registered container without lifecycle labels', (t) => {
    const unlabeled = retainedContainerFixture(t, {
        mutateLabels(labels) {
            const copy = { ...labels };
            delete copy['io.assistos.ploinky.instance-id'];
            delete copy['io.assistos.ploinky.enable-generation'];
            return copy;
        },
    });

    assert.throws(
        () => retireStoppedManagedContainers(unlabeled.paths, { runner: unlabeled.runner }),
        /exact registry ownership \(lifecycle-ownership-labels\)/,
    );
    assert.equal(unlabeled.calls.some((call) => call[0] === 'run'), false);
});

test('entrypoint retires a stopped predecessor with a complete stale lifecycle pair', (t) => {
    const predecessor = retainedContainerFixture(t, {
        mutateLabels(labels) {
            return {
                ...labels,
                'io.assistos.ploinky.instance-id': 'predecessor-instance',
                'io.assistos.ploinky.enable-generation': 'predecessor-generation',
            };
        },
    });

    assert.deepEqual(
        retireStoppedManagedContainers(predecessor.paths, { runner: predecessor.runner }),
        [predecessor.containerId],
    );
    assert.deepEqual(
        predecessor.calls.at(-1),
        ['run', 'podman', 'container', 'rm', predecessor.containerId],
    );
});

test('entrypoint retires only a fully superseded staged predecessor', (t) => {
    const predecessor = retainedContainerFixture(t, {
        mutateRegistry(record) {
            return {
                ...record,
                containerId: 'c'.repeat(64),
                instanceId: 'successor-instance',
                enableGeneration: 'successor-generation',
            };
        },
    });

    assert.deepEqual(
        retireStoppedManagedContainers(predecessor.paths, { runner: predecessor.runner }),
        [predecessor.containerId],
    );

    const duplicateIdentity = retainedContainerFixture(t, {
        mutateRegistry(record) {
            return { ...record, containerId: 'c'.repeat(64) };
        },
    });
    assert.throws(
        () => retireStoppedManagedContainers(duplicateIdentity.paths, {
            runner: duplicateIdentity.runner,
        }),
        /registry-container-id/,
    );
    assert.equal(duplicateIdentity.calls.some((call) => call[0] === 'run'), false);
});

test('entrypoint retires only a stopped interrupted helper with the exact managed label', (t) => {
    const helper = retainedContainerFixture(t, {
        includeRegistry: false,
        mutateLabels() {
            return { 'io.assistos.ploinky.managed': '1' };
        },
    });

    assert.deepEqual(
        retireStoppedManagedContainers(helper.paths, { runner: helper.runner }),
        [helper.containerId],
    );
    assert.deepEqual(
        helper.calls.at(-1),
        ['run', 'podman', 'container', 'rm', helper.containerId],
    );

    const running = retainedContainerFixture(t, {
        includeRegistry: false,
        running: true,
        status: 'running',
        mutateLabels() {
            return { 'io.assistos.ploinky.managed': '1' };
        },
    });
    assert.throws(
        () => retireStoppedManagedContainers(running.paths, { runner: running.runner }),
        /exact non-running removable state/,
    );
    assert.equal(running.calls.some((call) => call[0] === 'run'), false);

    const configured = retainedContainerFixture(t, {
        includeRegistry: false,
        status: 'configured',
        mutateLabels() {
            return { 'io.assistos.ploinky.managed': '1' };
        },
    });
    assert.deepEqual(
        retireStoppedManagedContainers(configured.paths, { runner: configured.runner }),
        [configured.containerId],
    );

    const paused = retainedContainerFixture(t, {
        includeRegistry: false,
        status: 'paused',
        mutateLabels() {
            return { 'io.assistos.ploinky.managed': '1' };
        },
    });
    assert.throws(
        () => retireStoppedManagedContainers(paused.paths, { runner: paused.runner }),
        /exact non-running removable state/,
    );
    assert.equal(paused.calls.some((call) => call[0] === 'run'), false);

    const extraLabel = retainedContainerFixture(t, {
        includeRegistry: false,
        mutateLabels() {
            return {
                'io.assistos.ploinky.managed': '1',
                'io.assistos.ploinky.unrecognized': '1',
            };
        },
    });
    assert.throws(
        () => retireStoppedManagedContainers(extraLabel.paths, { runner: extraLabel.runner }),
        /exact registry ownership/,
    );
    assert.equal(extraLabel.calls.some((call) => call[0] === 'run'), false);
});

test('entrypoint rejects running or ownership-drifted retained managed containers', (t) => {
    const running = retainedContainerFixture(t, { running: true, status: 'running' });
    assert.throws(
        () => retireStoppedManagedContainers(running.paths, { runner: running.runner }),
        /exact non-running removable state/,
    );
    assert.equal(running.calls.some((call) => call[0] === 'run'), false);

    const drifted = retainedContainerFixture(t, {
        mutateLabels(labels) {
            return { ...labels, 'io.assistos.ploinky.instance-id': 'foreign' };
        },
    });
    assert.throws(
        () => retireStoppedManagedContainers(drifted.paths, { runner: drifted.runner }),
        /exact registry ownership/,
    );
    assert.equal(drifted.calls.some((call) => call[0] === 'run'), false);

    const partiallyLabeled = retainedContainerFixture(t, {
        mutateLabels(labels) {
            const copy = { ...labels };
            delete copy['io.assistos.ploinky.enable-generation'];
            return copy;
        },
    });
    assert.throws(
        () => retireStoppedManagedContainers(partiallyLabeled.paths, {
            runner: partiallyLabeled.runner,
        }),
        /lifecycle-ownership-labels/,
    );
    assert.equal(partiallyLabeled.calls.some((call) => call[0] === 'run'), false);

    const statusSchema = retainedContainerFixture(t, {
        mutateLabels(labels) {
            return { ...labels, 'io.assistos.ploinky.network-schema': '3' };
        },
    });
    assert.throws(
        () => retireStoppedManagedContainers(statusSchema.paths, { runner: statusSchema.runner }),
        /schema-label/,
    );
    assert.equal(statusSchema.calls.some((call) => call[0] === 'run'), false);
});

test('entrypoint failure diagnostics preserve a bounded normalized cause chain', () => {
    const native = new Error('EACCES: permission denied,\nrename /deps/old -> /deps/backup');
    const wrapped = new Error('Pinned dependency installation failed', { cause: native });
    assert.equal(
        formatEntrypointFailure(wrapped),
        'Pinned dependency installation failed; cause: EACCES: permission denied, rename /deps/old -> /deps/backup',
    );
    assert.equal(formatEntrypointFailure(wrapped, { limit: 32 }).length, 32);
    assert.match(formatEntrypointFailure(wrapped, { limit: 32 }), /…$/);
});

test('entrypoint paths place the selected production workspace path under a test root once', (t) => {
    const { root } = fixture(t);
    assert.equal(entrypointPaths('/', { workspaceRoot: BOX_WORKSPACE }).workspace, BOX_WORKSPACE);
    assert.equal(
        entrypointPaths(root, { workspaceRoot: BOX_WORKSPACE }).workspace,
        path.join(root, 'srv', 'ploinky projects', 'proiect ăîș $(id)'),
    );
    assert.throws(() => entrypointPaths(root), (error) => error.code === 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID');
    assert.throws(() => entrypointPaths(root, { workspaceRoot: '/workspace/../etc' }), /clean absolute form/);
    // Every Box-owned preparation path is protected from a workspace bind.
    const production = entrypointPaths('/', { workspaceRoot: BOX_WORKSPACE });
    for (const [name, location] of Object.entries(production)) {
        if (name === 'workspace') continue;
        const reserved = BOX_RESERVED_SUBTREES.some((entry) => location === entry || location.startsWith(`${entry}/`))
            || BOX_RESERVED_PARENTS.includes(location);
        assert.equal(reserved, true, `${name} ${location}`);
    }
});

test('entrypoint rejects a missing, invalid, or disagreeing workspace root before any write', (t) => {
    const scenarios = [
        ['missing environment', (box) => ({ ...box, env: {} }), /PLOINKY_WORKSPACE_ROOT is not set/],
        ['empty environment', (box) => ({ ...box, env: { PLOINKY_WORKSPACE_ROOT: '' } }), /PLOINKY_WORKSPACE_ROOT is not set/],
        ['unmountable root', (box) => ({ ...box, env: { PLOINKY_WORKSPACE_ROOT: '/srv/pro:ject' } }), /contains ':'/],
        ['reserved root', (box) => ({ ...box, env: { PLOINKY_WORKSPACE_ROOT: '/home/podman' } }), /Box-owned location/],
        ['working directory elsewhere', (box, paths) => ({ ...box, cwd: () => path.dirname(paths.workspace) }),
            /working directory must be the workspace root/],
        ['non-canonical destination', (box, paths, root) => {
            const parent = path.dirname(paths.workspace);
            const elsewhere = path.join(root, 'elsewhere');
            fs.renameSync(parent, elsewhere);
            fs.symlinkSync(elsewhere, parent, 'dir');
            return box;
        }, /must resolve to itself inside the Box/],
    ];
    for (const [name, mutate, pattern] of scenarios) {
        const { root, paths, box } = fixture(t);
        const stale = path.join(paths.tmp, `storage-run-${BOX_RUNTIME_UID}`);
        fs.mkdirSync(stale, { recursive: true });
        const events = [];
        const options = mutate(box, paths, root);
        assert.throws(() => prepareEntrypoint({
            ...options,
            resetRuntime() { events.push('reset'); },
            configureStorage() { events.push('storage'); },
            initialize() { events.push('initialize'); },
            configureTransport() { events.push('transport'); },
            retireContainers() { events.push('retire'); },
            installDependencies() { events.push('install'); },
        }), pattern, name);
        assert.deepEqual(events, [], name);
        assert.equal(fs.existsSync(stale), true, name);
    }
});

test('entrypoint root verification requires the exact canonical working directory', (t) => {
    const { paths } = fixture(t);
    assert.doesNotThrow(() => verifyEntrypointWorkspaceRoot(paths, { cwd: () => paths.workspace }));
    assert.throws(() => verifyEntrypointWorkspaceRoot(paths, { cwd: () => `${paths.workspace}-other` }),
        /working directory must be the workspace root/);
    fs.rmSync(paths.workspace, { recursive: true });
    assert.throws(() => verifyEntrypointWorkspaceRoot(paths, { cwd: () => paths.workspace }),
        /Unable to inspect the mounted workspace root/);
});

function shellEntrypointSource() {
    return fs.readFileSync(path.resolve(import.meta.dirname, '../../ploinky-box/entrypoint/ploinky-box-entrypoint'), 'utf8');
}

function runShellRootPreflight(cwd, env) {
    const source = shellEntrypointSource();
    const functionText = (name) => {
        const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm'));
        assert.ok(match, `${name} is defined`);
        return match[0];
    };
    const script = [functionText('fail'), functionText('require_workspace_root'), 'require_workspace_root', 'echo preflight-ok'].join('\n');
    return spawnSync('bash', ['-c', script], { cwd, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

test('the image shell entrypoint proves the dynamic workspace root before preparation', (t) => {
    const { root } = fixture(t);
    const workspace = path.join(root, "selected ăîș $(touch owned);'");
    const link = path.join(root, 'selected link');
    fs.mkdirSync(workspace);
    fs.symlinkSync(workspace, link, 'dir');

    const ok = runShellRootPreflight(workspace, { PLOINKY_WORKSPACE_ROOT: workspace });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'preflight-ok');
    assert.equal(fs.existsSync(path.join(root, 'owned')), false);
    for (const [env, cwd, pattern] of [
        [{}, workspace, /PLOINKY_WORKSPACE_ROOT is not set/],
        [{ PLOINKY_WORKSPACE_ROOT: 'relative' }, workspace, /must be an absolute path/],
        [{ PLOINKY_WORKSPACE_ROOT: workspace }, root, /working directory .* must be PLOINKY_WORKSPACE_ROOT/],
        [{ PLOINKY_WORKSPACE_ROOT: link }, link, /working directory .* must be PLOINKY_WORKSPACE_ROOT/],
    ]) {
        const failed = runShellRootPreflight(cwd, env);
        assert.notEqual(failed.status, 0);
        assert.match(failed.stderr, pattern);
    }

    const source = shellEntrypointSource();
    assert.ok(source.indexOf('\nrequire_workspace_root\n') < source.indexOf('node "$PREPARE_HELPER" --prepare-only'));
    assert.doesNotMatch(source, /\/workspace\b/);
});
