#!/usr/bin/env node
// Engine-free tests for the ploinky-box wrapper. Uses --dry-run, which prints
// the engine command instead of executing it, so no podman/docker is needed.
// Runs standalone (`node container/wrapper-tests.mjs`) and via the unit suite
// (imported by tests/unit/ploinkyBoxWrapper.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOX = path.join(HERE, 'ploinky-box');

// Combined stdout+stderr, like the `2>&1` captures in the old wrapper-tests.sh.
function boxRun(engine, ...args) {
    const r = spawnSync(BOX, args, {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function checkIncludes(out, needle, description) {
    assert.ok(out.includes(needle), `${description}\n  wanted: ${needle}\n  in: ${out}`);
}

function checkAbsent(out, needle, description) {
    assert.ok(!out.includes(needle), `${description} (found forbidden '${needle}')\n  in: ${out}`);
}

test('entrypoint bash syntax check (bash -n)', () => {
    const r = spawnSync('bash', ['-n', BOX], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});

test('default up: isolation contract and defaults', () => {
    const { out } = boxRun('podman', '--dry-run', 'up');
    checkIncludes(out, 'DRY-RUN: podman', 'default up uses podman');
    checkIncludes(out, '--user podman', 'default up runs rootless user');
    checkIncludes(out, '--device /dev/fuse', 'default up passes /dev/fuse');
    checkIncludes(out, '--device /dev/net/tun', 'default up passes /dev/net/tun');
    checkIncludes(out, 'seccomp=unconfined', 'default up unconfines seccomp');
    checkIncludes(out, '127.0.0.1:8080:8080', 'default up publishes loopback 8080');
    checkIncludes(out, 'ploinky-box-workspace:/workspace', 'default up mounts workspace volume');
    checkIncludes(out, 'ploinky-box-containers:/home/podman/.local/share/containers', 'default up mounts containers volume');
    checkIncludes(out, '-e PLOINKY_BOX=1', 'default up marks box runtime');
    checkIncludes(out, 'docker.io/assistos/ploinky-box:podman-node24', 'default up uses default image');
    checkIncludes(out, '--init', 'default up reaps zombies');
    checkAbsent(out, '--privileged', 'no --privileged, ever');
});

test('named up: docker engine, instance prefixes, LAN bind', () => {
    const { out } = boxRun('docker', '--dry-run', '--name', 'qa', '--port', '9090', '--listen-lan', 'up');
    checkIncludes(out, 'DRY-RUN: docker', 'named up uses docker when forced');
    checkIncludes(out, '--name ploinky-box-qa', 'named up names the instance');
    checkIncludes(out, 'ploinky-box-qa-workspace:/workspace', 'named up prefixes volumes');
    checkIncludes(out, '0.0.0.0:9090:8080', 'lan flag binds all interfaces');
    checkAbsent(out, '--privileged', 'named up still not privileged');
});

test('image override respected', () => {
    const { out } = boxRun('podman', '--dry-run', '--image', 'example.org/x/y:z', 'up');
    checkIncludes(out, 'example.org/x/y:z', 'image override respected');
});

test('publish flag adds extra port', () => {
    const { out } = boxRun('podman', '--dry-run', '--publish', '127.0.0.1:7880:7880', 'up');
    checkIncludes(out, '-p 127.0.0.1:7880:7880', 'publish flag adds extra port');
});

test('webmeet ports publish the LiveKit/TURN set', () => {
    const { out } = boxRun('podman', '--dry-run', '--webmeet-ports', 'up');
    checkIncludes(out, '-p 127.0.0.1:7880:7880', 'webmeet ports publish livekit websocket');
    checkIncludes(out, '-p 127.0.0.1:7881:7881', 'webmeet ports publish livekit tcp');
    checkIncludes(out, '-p 127.0.0.1:7882-7892:7882-7892/udp', 'webmeet ports publish livekit udp');
    checkIncludes(out, '-p 127.0.0.1:3478:3478/tcp', 'webmeet ports publish turn tcp');
    checkIncludes(out, '-p 127.0.0.1:3478:3478/udp', 'webmeet ports publish turn udp');
    checkIncludes(out, '-p 127.0.0.1:20000-20010:20000-20010/udp', 'webmeet ports publish turn relay');
});

test('run passes through to ploinky', () => {
    const { out } = boxRun('podman', '--dry-run', 'run', 'start', 'demo', '8080');
    checkIncludes(out, 'exec -w /workspace ploinky-box ploinky start demo 8080', 'run passes through to ploinky');
});

test('cp maps box: prefix to instance', () => {
    const { out } = boxRun('podman', '--dry-run', 'cp', '/tmp/f', 'box:/workspace/f');
    checkIncludes(out, 'cp /tmp/f ploinky-box:/workspace/f', 'cp maps box: prefix to instance');
});

// --- Added with the Node implementation: syntax + import-level unit tests ---
import { parseCli, buildRunArgs, instanceName, volumeNames, mapCpPath, usageText } from './ploinky-box.mjs';

test('ploinky-box.mjs syntax check (node --check)', () => {
    const r = spawnSync(process.execPath, ['--check', path.join(HERE, 'ploinky-box.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});

test('ploinky-box.mjs main guard works through a symlink', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-test-'));
    const link = path.join(tmp, 'box-link.mjs');
    try {
        fs.symlinkSync(path.join(HERE, 'ploinky-box.mjs'), link);
        const r = spawnSync(process.execPath, [link, '-h'], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.stdout.includes('Usage: ploinky-box [flags] <command> [args]'), r.stdout);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('parseCli: flags anywhere, first non-flag is the command', () => {
    const cfg = parseCli(['--name', 'qa', 'run', 'start', 'demo', '8080', '--dry-run'], {});
    assert.equal(cfg.command, 'run');
    assert.deepEqual(cfg.args, ['start', 'demo', '8080']);
    assert.equal(cfg.name, 'qa');
    assert.equal(cfg.dryRun, true);
});

test('parseCli: PLOINKY_BOX_ENGINE env seeds the engine, --engine overrides', () => {
    assert.equal(parseCli(['up'], { PLOINKY_BOX_ENGINE: 'docker' }).engine, 'docker');
    assert.equal(parseCli(['--engine', 'podman', 'up'], { PLOINKY_BOX_ENGINE: 'docker' }).engine, 'podman');
});

test('parseCli: repeatable --publish accumulates in order', () => {
    const cfg = parseCli(['--publish', 'a:1:1', '--publish', 'b:2:2', 'up'], {});
    assert.deepEqual(cfg.publish, ['a:1:1', 'b:2:2']);
});

test('instance and volume naming', () => {
    assert.equal(instanceName(parseCli(['up'], {})), 'ploinky-box');
    const named = parseCli(['--name', 'qa', 'up'], {});
    assert.equal(instanceName(named), 'ploinky-box-qa');
    assert.deepEqual(volumeNames(named), {
        workspace: 'ploinky-box-qa-workspace',
        containers: 'ploinky-box-qa-containers',
    });
});

test('buildRunArgs: selinux label only when the engine reports it; image is last', () => {
    const cfg = parseCli(['up'], {});
    const plain = buildRunArgs(cfg, { selinux: false });
    const labeled = buildRunArgs(cfg, { selinux: true });
    assert.ok(!plain.join(' ').includes('label=disable'));
    assert.ok(labeled.join(' ').includes('--security-opt label=disable'));
    assert.equal(plain[plain.length - 1], 'docker.io/assistos/ploinky-box:podman-node24');
    assert.ok(!plain.includes('--privileged'));
});

test('buildRunArgs: mount is appended only when set, before the image', () => {
    const cfg = parseCli(['--mount', '/tmp', 'up'], {});
    cfg.mountDirResolved = '/tmp';
    const args = buildRunArgs(cfg, { selinux: false });
    assert.equal(args[args.length - 3], '-v');
    assert.equal(args[args.length - 2], '/tmp:/workspace/mounted');
});

test('mapCpPath: leading box: prefix only', () => {
    assert.equal(mapCpPath('box:/workspace/f', 'ploinky-box'), 'ploinky-box:/workspace/f');
    assert.equal(mapCpPath('/tmp/box:file', 'ploinky-box'), '/tmp/box:file');
});

test('usage text still documents every command and flag', () => {
    const u = usageText();
    for (const word of ['up', 'cli', 'run', 'cp', 'status', 'logs', 'stop', 'update', 'destroy',
        '--name', '--port', '--publish', '--webmeet-ports', '--image', '--mount',
        '--listen-lan', '--engine', '--dry-run']) {
        assert.ok(u.includes(word), `usage() lost mention of ${word}`);
    }
});
