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
const MJS = path.join(HERE, 'ploinky-box.mjs');
const PLOINKY = path.join(HERE, '..', 'bin', 'ploinky');
const PCLI = path.join(HERE, '..', 'bin', 'p-cli');
const PSH = path.join(HERE, '..', 'bin', 'psh');

function makeFakeNodeCapture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-node-'));
    const capture = path.join(dir, 'capture.json');
    const node = path.join(dir, 'node');
    const realNode = process.execPath;
    fs.writeFileSync(node, `#!/usr/bin/env bash
printf '{"argv":[' > ${JSON.stringify(capture)}
first=1
for arg in "$@"; do
  if [ "$first" -eq 0 ]; then printf ',' >> ${JSON.stringify(capture)}; fi
  first=0
  ${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.argv[1]))' -- "$arg" >> ${JSON.stringify(capture)}
done
printf '],"PLOINKY_PUBLIC_ENTRYPOINT":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_PUBLIC_ENTRYPOINT || ""))' >> ${JSON.stringify(capture)}
printf ',"PLOINKY_BOX":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_BOX || ""))' >> ${JSON.stringify(capture)}
printf ',"PLOINKY_DIRECT":' >> ${JSON.stringify(capture)}
${JSON.stringify(realNode)} -e 'process.stdout.write(JSON.stringify(process.env.PLOINKY_DIRECT || ""))' >> ${JSON.stringify(capture)}
printf '}' >> ${JSON.stringify(capture)}
exit 0
`);
    fs.chmodSync(node, 0o755);
    return { dir, capture };
}

function addReadlinkWithoutDashF(dir) {
    const readlink = path.join(dir, 'readlink');
    fs.writeFileSync(readlink, `#!/usr/bin/env bash
if [ "\${1-}" = "-f" ]; then
  exit 1
fi
/usr/bin/readlink "$@"
`);
    fs.chmodSync(readlink, 0o755);
}

function readCapture(capture) {
    return JSON.parse(fs.readFileSync(capture, 'utf8'));
}

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

function publicRun(engine, ...args) {
    const r = spawnSync(MJS, args, {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine, PLOINKY_PUBLIC_ENTRYPOINT: '1' },
    });
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function publicRunIn(cwd, engine, ...args) {
    const r = spawnSync(MJS, args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_BOX_ENGINE: engine, PLOINKY_PUBLIC_ENTRYPOINT: '1' },
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

test('public bin/ploinky delegates to the box wrapper on the host', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        delete env.PLOINKY_BOX;
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(PLOINKY, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/container/ploinky-box.mjs'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('bin/ploinky runs direct CLI inside the box', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX: '1',
        };
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(PLOINKY, ['status'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/cli/index.js'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['status']);
        assert.equal(captured.PLOINKY_BOX, '1');
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('bin/ploinky supports explicit PLOINKY_DIRECT escape on the host', () => {
    const fake = makeFakeNodeCapture();
    try {
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_DIRECT: '1',
        };
        delete env.PLOINKY_BOX;
        const r = spawnSync(PLOINKY, ['list', 'agents'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/cli/index.js'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['list', 'agents']);
        assert.equal(captured.PLOINKY_DIRECT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('bin/ploinky resolves its repo root when invoked through a symlink', () => {
    const fake = makeFakeNodeCapture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-link-'));
    const link = path.join(linkDir, 'ploinky');
    try {
        fs.symlinkSync(PLOINKY, link);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        delete env.PLOINKY_BOX;
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(link, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
    }
});

test('bin/ploinky direct mode resolves through a symlink', () => {
    const fake = makeFakeNodeCapture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-link-'));
    const link = path.join(linkDir, 'ploinky');
    try {
        fs.symlinkSync(PLOINKY, link);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_DIRECT: '1',
        };
        delete env.PLOINKY_BOX;
        const r = spawnSync(link, ['status'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], path.join(HERE, '..', 'cli', 'index.js'));
        assert.deepEqual(captured.argv.slice(1), ['status']);
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
    }
});

test('p-cli still delegates through bin/ploinky', () => {
    const fake = makeFakeNodeCapture();
    try {
        addReadlinkWithoutDashF(fake.dir);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        delete env.PLOINKY_BOX;
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(PCLI, ['status', '--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.ok(captured.argv[0].endsWith('/container/ploinky-box.mjs'), captured.argv);
        assert.deepEqual(captured.argv.slice(1), ['status', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
});

test('p-cli resolves its repo root when invoked through a symlink', () => {
    const fake = makeFakeNodeCapture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p-cli-link-'));
    const link = path.join(linkDir, 'p-cli');
    try {
        addReadlinkWithoutDashF(fake.dir);
        fs.symlinkSync(PCLI, link);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        delete env.PLOINKY_BOX;
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(link, ['status'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['status']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
    }
});

test('psh delegates to ploinky sh through a symlink', () => {
    const fake = makeFakeNodeCapture();
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'psh-link-'));
    const link = path.join(linkDir, 'psh');
    try {
        addReadlinkWithoutDashF(fake.dir);
        fs.symlinkSync(PSH, link);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
        delete env.PLOINKY_BOX;
        delete env.PLOINKY_DIRECT;
        const r = spawnSync(link, ['--dry-run'], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const captured = readCapture(fake.capture);
        assert.equal(captured.argv[0], MJS);
        assert.deepEqual(captured.argv.slice(1), ['sh', '--dry-run']);
        assert.equal(captured.PLOINKY_PUBLIC_ENTRYPOINT, '1');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
        fs.rmSync(linkDir, { recursive: true, force: true });
    }
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
    isPublicEntrypoint,
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

test('public usage describes ploinky and box namespace', () => {
    const r = spawnSync(process.execPath, [MJS, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_PUBLIC_ENTRYPOINT: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('Usage: ploinky [flags] [command] [args]'), r.stdout);
    assert.ok(r.stdout.includes('ploinky box status'), r.stdout);
    assert.ok(r.stdout.includes('PLOINKY_DIRECT=1'), r.stdout);
});

test('isPublicEntrypoint reads the public mode environment marker', () => {
    assert.equal(isPublicEntrypoint({ PLOINKY_PUBLIC_ENTRYPOINT: '1' }), true);
    assert.equal(isPublicEntrypoint({ PLOINKY_PUBLIC_ENTRYPOINT: '' }), false);
});

test('public status routes to in-box ploinky status, not outer box status', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    try {
        const { out, status } = publicRunIn(dir, 'podman', '--dry-run', 'status');
        assert.equal(status, 0, out);
        checkIncludes(out, 'DRY-RUN: podman run -d', 'public status creates/starts the box first');
        checkIncludes(out, 'exec -w /workspace ploinky-box-testExplorerFresh ploinky status', 'public status runs in-box status');
        checkAbsent(out, "'ploinky-box-testExplorerFresh' does not exist.", 'public status is not outer status');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('public destroy routes to in-box ploinky destroy, not outer volume removal', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'destroy');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky destroy', 'public destroy runs in-box destroy');
    checkAbsent(out, 'volume rm ploinky-box-qa-workspace', 'public destroy does not remove outer volumes');
});

test('public destroy honors --name after the command without forwarding it in-box', () => {
    const { out, status } = publicRun('podman', '--dry-run', 'destroy', '--name', 'qa');
    assert.equal(status, 0, out);
    checkIncludes(out, '--name ploinky-box-qa', 'post-command --name selects the outer box instance');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky destroy', 'post-command --name still runs in-box destroy');
    checkAbsent(out, 'ploinky destroy --name qa', 'post-command --name is not forwarded as a misleading in-box arg');
    checkAbsent(out, 'volume rm ploinky-box-qa-workspace', 'public destroy does not remove outer volumes');
});

test('public box status targets the outer box status command', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'box', 'status');
    assert.equal(status, 1, out);
    checkIncludes(out, "'ploinky-box-qa' does not exist.", 'box status uses outer status behavior');
    checkAbsent(out, 'ploinky status', 'box status does not forward to in-box status');
});

test('public box destroy targets the outer volume destroy command', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'box', 'destroy');
    assert.equal(status, 0, out);
    checkIncludes(out, "'ploinky-box-qa' and its volumes removed.", 'box destroy uses outer destroy behavior');
    checkAbsent(out, 'ploinky destroy', 'box destroy does not run in-box destroy');
});

test('public no-arg command opens in-box p-cli', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run');
    assert.equal(status, 0, out);
    checkIncludes(out, 'DRY-RUN: podman run -d', 'no-arg public command ensures box');
    checkIncludes(out, 'exec -it -w /workspace ploinky-box-qa p-cli', 'no-arg public command opens p-cli');
});

test('public start preserves branch flags while forcing in-box router to 8080', () => {
    const { out, status } = publicRun(
        'podman',
        '--name', 'qa',
        '--dry-run',
        'start', 'explorer',
        '--branch', 'feature-x',
        '9191',
        '--repo-branch', 'AssistOSExplorer=peristo-user',
        '--branch-fallback', 'fail',
    );
    assert.equal(status, 0, out);
    checkIncludes(out, '127.0.0.1:9191:8080', 'public start positional port is host port');
    checkIncludes(
        out,
        'exec -w /workspace ploinky-box-qa ploinky start explorer 8080 --branch feature-x --repo-branch AssistOSExplorer=peristo-user --branch-fallback fail',
        'public start forwards branch flags after in-box port',
    );
    checkAbsent(out, 'ploinky start explorer 9191', 'public start never uses host port inside');
});

test('public start accepts --port before the agent without forwarding it in-box', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'start', '--port', '9191', 'explorer');
    assert.equal(status, 0, out);
    checkIncludes(out, '127.0.0.1:9191:8080', 'post-command --port before agent is the host port');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start explorer 8080', 'agent remains explorer');
    checkAbsent(out, 'ploinky start 9191 8080 --port explorer', 'post-command --port does not reorder into in-box args');
});

test('public start accepts --port after the agent without forwarding it in-box', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'start', 'explorer', '--port', '9192');
    assert.equal(status, 0, out);
    checkIncludes(out, '127.0.0.1:9192:8080', 'post-command --port after agent is the host port');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start explorer 8080', 'agent remains explorer');
    checkAbsent(out, 'ploinky start explorer 8080 --port 9192', 'post-command --port is not forwarded in-box');
});

test('public start without an agent forwards in-box start instead of wrapper failing', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'start');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start', 'start with no args is forwarded');
    checkAbsent(out, 'usage:', 'public start without args is not rejected by the wrapper');
});

test('public parser preserves normal command flags after the command', () => {
    const cfg = parseCli(['client', 'tool', 'process', '--dry-run'], {}, { publicEntrypoint: true });
    assert.equal(cfg.command, 'client');
    assert.deepEqual(cfg.args, ['tool', 'process', '--dry-run']);
    assert.equal(cfg.dryRun, false);
});

test('public parser hoists box selector flags after the command', () => {
    const cfg = parseCli(['destroy', '--name', 'qa'], {}, { publicEntrypoint: true });
    assert.equal(cfg.command, 'destroy');
    assert.equal(cfg.name, 'qa');
    assert.deepEqual(cfg.args, []);
});

test('public cli forwards with interactive exec', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'cli');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -it -w /workspace ploinky-box-qa ploinky cli', 'public cli keeps a TTY');
});

test('public sh forwards with interactive exec', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'sh');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -it -w /workspace ploinky-box-qa ploinky sh', 'public sh keeps a TTY');
});

test('public box help shows wrapper help', () => {
    const { out, status } = publicRun('podman', 'box', '--help');
    assert.equal(status, 0, out);
    checkIncludes(out, 'Usage: ploinky-box [flags] <command> [args]', 'box --help shows wrapper help');
});

test('ploinky-box unknown command keeps compatibility help guidance', () => {
    const { out, status } = boxRun('podman', 'nosuch');
    assert.equal(status, 1, out);
    checkIncludes(out, "unknown command 'nosuch' (see: ploinky-box --help)", 'compat unknown command points at ploinky-box help');
});

test('smoke script documents optional public ploinky path', () => {
    const smokeText = fs.readFileSync(path.join(HERE, 'smoke-box.mjs'), 'utf8');
    assert.ok(smokeText.includes('SMOKE_PUBLIC_PLOINKY'), smokeText);
    assert.ok(smokeText.includes('bin/ploinky'), smokeText);
});

test('docs describe boxed-by-default ploinky and direct escape', () => {
    const rootReadme = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
    const boxReadme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    assert.ok(rootReadme.includes('PLOINKY_DIRECT=1'), rootReadme);
    assert.ok(rootReadme.includes('ploinky box status'), rootReadme);
    assert.ok(boxReadme.includes('ploinky box destroy'), boxReadme);
    assert.ok(boxReadme.includes('ploinky-box compatibility'), boxReadme);
});

test('package metadata advertises the Node 20 runtime floor', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(packageJson.engines.node, '>=20.0.0');
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

test('dry-run status is engine-free when inferring the instance', () => {
    const { parent, dir } = makeCwd('testExplorerFresh');
    const env = { ...process.env, PATH: '/usr/bin:/bin' };
    delete env.PLOINKY_BOX_ENGINE;
    try {
        const r = spawnSync(process.execPath, [MJS, '--dry-run', 'status'], {
            cwd: dir,
            encoding: 'utf8',
            env,
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert.equal(r.status, 1, out);
        checkIncludes(out, "'ploinky-box-testExplorerFresh' does not exist.", 'dry-run status resolves the inferred name');
        checkIncludes(out, 'name inferred from the current directory', 'dry-run status explains where the name came from');
        checkAbsent(out, 'neither podman nor docker found', 'dry-run status does not detect container engines');
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
