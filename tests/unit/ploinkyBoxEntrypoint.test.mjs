import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BOX_MARKER_CONTENT,
    BOX_READY_LINE,
} from '../../ploinky-box/constants.mjs';
import {
    entrypointPaths,
    prepareEntrypoint,
    runEntrypoint,
} from '../../ploinky-box/entrypoint/entrypoint.mjs';
import {
    configureBoxTransport,
    parseExactTransport,
    writeTransportPair,
} from '../../ploinky-box/entrypoint/transport.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-entrypoint-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = entrypointPaths(root);
    for (const directory of [
        path.dirname(paths.marker),
        paths.workspace,
        paths.dependencies,
        paths.nestedStore,
        path.dirname(paths.ploinky),
        paths.tmp,
    ]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.marker, BOX_MARKER_CONTENT, { mode: 0o644 });
    fs.writeFileSync(paths.ploinky, '#!/usr/bin/env bash\n', { mode: 0o755 });
    return { root, paths };
}

function routeRunner({
    routes = [{ dst: '198.51.100.1', prefsrc: '10.88.0.17', dev: 'eth0' }],
    addresses = [{
        ifname: 'eth0',
        addr_info: [{ family: 'inet', local: '10.88.0.17', prefixlen: 16 }],
    }],
} = {}) {
    const calls = [];
    return {
        calls,
        query(command, args) {
            calls.push([command, ...args]);
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
        '[containers]\nvolumes=["/proc:/proc"]\ndefault_sysctls=[]\n');
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

test('entrypoint validates its marker and mounts before its first persistent write', (t) => {
    const { root, paths } = fixture(t);
    fs.writeFileSync(paths.marker, 'wrong\n');
    let initialized = false;
    assert.throws(() => prepareEntrypoint({
        root,
        initialize() { initialized = true; },
        configureTransport() { throw new Error('must not configure'); },
        installDependencies() { throw new Error('must not install'); },
    }), /marker has invalid content/i);
    assert.equal(initialized, false);
    assert.equal(fs.existsSync(path.join(paths.workspace, '.env')), false);

    fs.writeFileSync(paths.marker, BOX_MARKER_CONTENT);
    fs.rmSync(paths.dependencies, { recursive: true });
    fs.symlinkSync(paths.workspace, paths.dependencies);
    assert.throws(() => prepareEntrypoint({ root }), /mount target|mount is missing/);
    assert.equal(fs.existsSync(path.join(paths.workspace, '.env')), false);
});

test('full preparation creates one stable key, resets only transient runtime, and initializes pins', (t) => {
    const { root, paths } = fixture(t);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const transient = [
        path.join(paths.tmp, `storage-run-${uid}`),
        path.join(paths.tmp, `podman-run-${uid}`),
    ];
    for (const directory of transient) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'stale'), 'stale');
    }
    const persistent = path.join(paths.nestedStore, 'persistent-canary');
    fs.writeFileSync(persistent, 'retain');
    const events = [];
    const options = {
        root,
        runner: routeRunner(),
        installDependencies({ targetRoot, markerPath }) {
            events.push('install');
            assert.equal(targetRoot, paths.dependencies);
            assert.equal(markerPath, paths.marker);
        },
    };
    prepareEntrypoint(options);
    const keyBytes = fs.readFileSync(path.join(paths.workspace, '.env'));
    assert.match(keyBytes.toString('utf8'), /^PLOINKY_MASTER_KEY=[a-f0-9]{64}\n$/);
    assert.equal(mode(path.join(paths.workspace, '.env')), 0o600);
    assert.deepEqual(events, ['install']);
    assert.equal(transient.some((target) => fs.existsSync(target)), false);
    assert.equal(fs.readFileSync(persistent, 'utf8'), 'retain');

    prepareEntrypoint(options);
    assert.deepEqual(fs.readFileSync(path.join(paths.workspace, '.env')), keyBytes);
});

test('ready line is emitted exactly once and only after every required stage', (t) => {
    const { root } = fixture(t);
    const events = [];
    const output = {
        write(chunk) { events.push(`output:${String(chunk).trim()}`); },
    };
    runEntrypoint({
        root,
        runner: routeRunner(),
        initialize() { events.push('initialize'); },
        configureTransport() {
            events.push('transport');
            return { address: '10.88.0.17', interface: 'eth0' };
        },
        resetRuntime() { events.push('reset'); },
        installDependencies() { events.push('dependencies'); },
        selfCheck() { events.push('self-check'); },
        output,
    });
    assert.deepEqual(events, [
        'initialize', 'transport', 'reset', 'dependencies', 'self-check',
        `output:${BOX_READY_LINE}`,
    ]);
});
