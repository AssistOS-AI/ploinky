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

// Like boxRun, but with a controlled working directory — cwd inference tests.
function boxRunIn(cwd, engine, ...args) {
    const r = spawnSync(BOX, args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

// Fixed-basename child inside a random temp parent: deterministic inference,
// no collision with real containers. Callers clean up the returned parent.
function makeCwd(basename) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-cwd-'));
    const dir = path.join(parent, basename);
    fs.mkdirSync(dir);
    return { parent, dir };
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

test('inferred up: cwd basename drives names; isolation contract holds', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out } = boxRunIn(dir, 'podman', '--dry-run', 'up');
        checkIncludes(out, 'DRY-RUN: podman', 'inferred up uses podman');
        checkIncludes(out, '--name ploinky-box-testExplorerFresh', 'cwd basename names the instance');
        checkIncludes(out, '--user podman', 'inferred up runs rootless user');
        checkIncludes(out, '--device /dev/fuse', 'inferred up passes /dev/fuse');
        checkIncludes(out, '--device /dev/net/tun', 'inferred up passes /dev/net/tun');
        checkIncludes(out, 'seccomp=unconfined', 'inferred up unconfines seccomp');
        checkIncludes(out, '127.0.0.1:8080:8080', 'inferred up publishes loopback 8080');
        checkIncludes(out, 'ploinky-box-testExplorerFresh-workspace:/workspace', 'inferred up mounts workspace volume');
        checkIncludes(out, 'ploinky-box-testExplorerFresh-containers:/home/podman/.local/share/containers', 'inferred up mounts containers volume');
        checkIncludes(out, '-e PLOINKY_BOX=1', 'inferred up marks box runtime');
        checkIncludes(out, 'docker.io/assistos/ploinky-box:podman-node24', 'inferred up uses default image');
        checkIncludes(out, '--init', 'inferred up reaps zombies');
        checkAbsent(out, '--privileged', 'no --privileged, ever');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
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
    const { out } = boxRun('podman', '--name', 'qa', '--dry-run', 'run', 'start', 'demo', '8080');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start demo 8080', 'run passes through to ploinky');
});

test('cp maps box: prefix to instance', () => {
    const { out } = boxRun('podman', '--name', 'qa', '--dry-run', 'cp', '/tmp/f', 'box:/workspace/f');
    checkIncludes(out, 'cp /tmp/f ploinky-box-qa:/workspace/f', 'cp maps box: prefix to instance');
});

// --- Added with the Node implementation: syntax + import-level unit tests ---
import {
    parseCli,
    buildRunArgs,
    instanceName,
    volumeNames,
    mapCpPath,
    usageText,
    sanitizeBoxSuffix,
    resolveInstanceIdentity,
} from './ploinky-box.mjs';

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
    for (const word of ['up', 'start', 'cli', 'run', 'cp', 'status', 'logs', 'stop', 'update', 'destroy',
        '--name', '--port', '--publish', '--webmeet-ports', '--image', '--mount',
        '--listen-lan', '--engine', '--dry-run']) {
        assert.ok(u.includes(word), `usage() lost mention of ${word}`);
    }
});

test('sanitizeBoxSuffix: engine-safe suffixes', () => {
    assert.equal(sanitizeBoxSuffix('testExplorerFresh'), 'testExplorerFresh');
    assert.equal(sanitizeBoxSuffix('my repo!'), 'my_repo_');
    assert.equal(sanitizeBoxSuffix('a.b-c_d'), 'a.b-c_d');
    assert.equal(sanitizeBoxSuffix('x'.repeat(80)), 'x'.repeat(63));
    assert.equal(sanitizeBoxSuffix(''), '');
});

test('resolveInstanceIdentity: cwd inference and --name override', () => {
    const inferred = resolveInstanceIdentity(parseCli(['up'], {}), '/home/u/testExplorer2');
    assert.equal(inferred.name, 'testExplorer2');
    assert.equal(inferred.nameSource, 'cwd');
    assert.equal(instanceName(inferred), 'ploinky-box-testExplorer2');

    const flagged = resolveInstanceIdentity(parseCli(['--name', 'qa', 'up'], {}), '/home/u/testExplorer2');
    assert.equal(flagged.name, 'qa');
    assert.equal(flagged.nameSource, 'flag');
});

test('parseCli: explicit-port tracking for start', () => {
    assert.equal(parseCli(['--port', '9090', 'up'], {}).portExplicit, true);
    assert.equal(parseCli(['up'], {}).portExplicit, false);
});

test('inferred up: cwd basename is sanitized', () => {
    const { parent, dir } = makeCwd('my repo!');
    try {
        const { out } = boxRunIn(dir, 'podman', '--dry-run', 'up');
        checkIncludes(out, '--name ploinky-box-my_repo_', 'unsafe chars become underscores');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('--name overrides the cwd basename', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out } = boxRunIn(dir, 'podman', '--name', 'qa', '--dry-run', 'up');
        checkIncludes(out, '--name ploinky-box-qa', 'explicit --name wins');
        checkAbsent(out, 'testExplorerFresh', 'cwd basename ignored when --name is given');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('un-inferable cwd dies with guidance', () => {
    const { parent, dir } = makeCwd('___');
    try {
        const { out, status } = boxRunIn(dir, 'podman', '--dry-run', 'up');
        assert.equal(status, 1, out);
        checkIncludes(out, 'cannot infer an instance name', 'un-inferable cwd is an error');
        checkIncludes(out, 'pass --name X', 'error points at the escape hatch');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('status targets the inferred instance', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out, status } = boxRunIn(dir, 'podman', '--dry-run', 'status');
        assert.equal(status, 1, out);
        checkIncludes(out, "'ploinky-box-testExplorerFresh' does not exist.", 'status resolves the inferred name');
        checkIncludes(out, 'name inferred from the current directory', 'status explains where the name came from');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('destroy targets the inferred instance and says so', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out } = boxRunIn(dir, 'podman', '--dry-run', 'destroy');
        checkIncludes(out, "targeting 'ploinky-box-testExplorerFresh' (name inferred from the current directory)", 'destroy announces the inferred target');
        checkIncludes(out, "'ploinky-box-testExplorerFresh' and its volumes removed.", 'destroy resolves the inferred name');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

// --- start command: up + in-box `ploinky start <agent> 8080` ---

test('start: up then in-box ploinky start on 8080', () => {
    const { out } = boxRun('podman', '--name', 'qa', '--dry-run', 'start', 'explorer');
    checkIncludes(out, 'DRY-RUN: podman run -d', 'start creates the box first');
    checkIncludes(out, '127.0.0.1:8080:8080', 'default host port is 8080');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start explorer 8080', 'start runs ploinky start on 8080 inside');
});

test('start: --port publishes N:8080, router stays on 8080', () => {
    const { out } = boxRun('podman', '--name', 'qa', '--port', '8081', '--dry-run', 'start', 'explorer');
    checkIncludes(out, '127.0.0.1:8081:8080', 'host 8081 maps to box 8080');
    checkIncludes(out, 'ploinky start explorer 8080', 'in-box router still on 8080');
    checkAbsent(out, '8081:8081', 'the box side never follows the host port');
    checkAbsent(out, 'ploinky start explorer 8081', 'the in-box port never follows the host port');
});

test('start: positional port sets the host port', () => {
    const { out } = boxRun('podman', '--name', 'qa', '--dry-run', 'start', 'explorer', '9191');
    checkIncludes(out, '127.0.0.1:9191:8080', 'positional port is the host port');
    checkIncludes(out, 'ploinky start explorer 8080', 'in-box router still on 8080');
});

test('start: matching --port and positional port are accepted', () => {
    const { out, status } = boxRun('podman', '--name', 'qa', '--port', '9191', '--dry-run', 'start', 'explorer', '9191');
    assert.equal(status, 0, out);
    checkIncludes(out, '127.0.0.1:9191:8080', 'agreeing ports are fine');
});

test('start: conflicting --port and positional port die', () => {
    const { out, status } = boxRun('podman', '--name', 'qa', '--port', '8081', '--dry-run', 'start', 'explorer', '9191');
    assert.equal(status, 1, out);
    checkIncludes(out, 'conflicting host ports', 'double-specified port is rejected');
});

test('start: requires an agent', () => {
    const { out, status } = boxRun('podman', '--name', 'qa', '--dry-run', 'start');
    assert.equal(status, 1, out);
    checkIncludes(out, 'usage: ploinky-box start <agent> [port]', 'missing agent shows usage');
});

test('start: non-numeric port dies', () => {
    const { out, status } = boxRun('podman', '--name', 'qa', '--dry-run', 'start', 'explorer', '80a8');
    assert.equal(status, 1, out);
    checkIncludes(out, 'host port must be a number', 'junk port is rejected');
});

test('start: non-numeric --port dies', () => {
    const { out, status } = boxRun('podman', '--name', 'qa', '--port', 'nope', '--dry-run', 'start', 'explorer');
    assert.equal(status, 1, out);
    checkIncludes(out, 'host port must be a number', 'junk --port is rejected');
});

test('start: infers the instance from the cwd', () => {
    const { parent, dir } = makeCwd('testExplorer2');
    try {
        const { out } = boxRunIn(dir, 'podman', '--port', '8081', '--dry-run', 'start', 'explorer');
        checkIncludes(out, '--name ploinky-box-testExplorer2', 'instance inferred from cwd');
        checkIncludes(out, '127.0.0.1:8081:8080', 'host 8081 maps to box 8080');
        checkIncludes(out, 'exec -w /workspace ploinky-box-testExplorer2 ploinky start explorer 8080', 'in-box start against the inferred instance');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});
