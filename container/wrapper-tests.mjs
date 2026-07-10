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
import { getCommandRegistry } from '../cli/services/commandRegistry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const BOX = path.join(HERE, 'ploinky-box');
const MJS = path.join(HERE, 'ploinky-box.mjs');
const PLOINKY = path.join(HERE, '..', 'bin', 'ploinky');
const PCLI = path.join(HERE, '..', 'bin', 'p-cli');
const PSH = path.join(HERE, '..', 'bin', 'psh');
const INSTALL_DEPS = path.join(HERE, '..', 'bin', 'ploinky-install-deps');

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

function publicRunWithEnv(extraEnv, engine, ...args) {
    const r = spawnSync(MJS, args, {
        encoding: 'utf8',
        env: {
            ...process.env,
            ...extraEnv,
            PLOINKY_BOX_ENGINE: engine,
            PLOINKY_PUBLIC_ENTRYPOINT: '1',
        },
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

function countOccurrences(out, needle) {
    return out.split(needle).length - 1;
}

function makeFakePloinkyGraphSource({
    webPublishingOpenPorts = ['127.0.0.1:8081:8081'],
    webPublishingProfiles = null,
} = {}) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-graph-source-'));
    const sourceDir = path.join(workspaceRoot, 'ploinky');
    fs.mkdirSync(path.join(sourceDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'cli'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'container'), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, 'globalDeps'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'bin', 'ploinky'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(sourceDir, 'cli', 'index.js'), '');
    fs.writeFileSync(path.join(sourceDir, 'container', 'ploinky-box-marker'), 'assistos/ploinky-box\n');
    fs.writeFileSync(path.join(sourceDir, 'globalDeps', 'package.json'), '{"name":"globalDeps"}\n');

    function writeManifest(repoDir, agentName, manifest) {
        const agentDir = path.join(workspaceRoot, repoDir, agentName);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }

    writeManifest('AssistOSExplorer', 'explorer', {
        enable: [
            'basic/webtty global',
            'webmeetInfra/liveKitServerAgent no-wait',
            'onlyOffice global no-wait',
        ],
        profiles: {
            default: {
                enable: [
                    {
                        agent: 'basic/web-publishing global',
                    },
                ],
            },
        },
    });
    writeManifest('basic', 'web-publishing', {
        profiles: webPublishingProfiles || {
            default: {
                openPorts: webPublishingOpenPorts,
            },
        },
    });
    writeManifest('basic', 'webtty', {
        profiles: {
            default: {
                env: {
                    PORT: { default: '7681' },
                },
            },
        },
    });
    writeManifest('AssistOSExplorer', 'onlyOffice', {
        profiles: {
            default: {
                env: [
                    { name: 'ONLYOFFICE_JWT_SECRET', required: true },
                ],
            },
        },
    });
    writeManifest('webmeetInfra', 'liveKitServerAgent', {
        profiles: {
            default: {
                openPorts: [
                    '127.0.0.1:7881:7881',
                    '127.0.0.1:3478:3478/tcp',
                    '127.0.0.1:3478:3478/udp',
                    '127.0.0.1:7882-7892:7882-7892/udp',
                    '127.0.0.1:20000-20010:20000-20010/udp',
                ],
            },
        },
    });

    return {
        sourceDir,
        cleanup() {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        },
    };
}

// Fake checkout + fake npm: asserts the exact install flags and that the
// script verifies both dependency dirs afterwards.
function makeFakeCheckout({ npmCreatesDeps, npmBody = '' }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-root-'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.copyFileSync(INSTALL_DEPS, path.join(root, 'bin', 'ploinky-install-deps'));
    fs.chmodSync(path.join(root, 'bin', 'ploinky-install-deps'), 0o755);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fake"}\n');
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-npm-'));
    const argsFile = path.join(binDir, 'npm-args.txt');
    fs.writeFileSync(path.join(binDir, 'npm'), `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(argsFile)}
${npmBody || (npmCreatesDeps ? `mkdir -p "$PWD/node_modules/achillesAgentLib" "$PWD/node_modules/mcp-sdk"` : 'true')}
`);
    fs.chmodSync(path.join(binDir, 'npm'), 0o755);
    return { root, binDir, argsFile };
}

function makeFakePodmanForMissingDeps() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fake-podman-'));
    const calls = path.join(dir, 'calls.log');
    const state = path.join(dir, 'state');
    const podman = path.join(dir, 'podman');
    fs.writeFileSync(podman, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
state_file=${JSON.stringify(state)}
case "$1 $2" in
  "machine inspect")
    echo running
    exit 0
    ;;
  "container inspect")
    if [ -f "$state_file" ]; then
      if [ "$3" = "--format" ]; then echo running; fi
      exit 0
    fi
    exit 1
    ;;
  "image inspect")
    exit 0
    ;;
  "info --format")
    echo false
    exit 0
    ;;
  "run -d")
    echo running > "$state_file"
    echo fake-container-id
    exit 0
    ;;
  "logs ploinky-box-qa")
    echo "self-check OK"
    exit 0
    ;;
  "exec ploinky-box-qa")
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);
    fs.chmodSync(podman, 0o755);
    return { dir, calls };
}

test('entrypoint bash syntax check (bash -n)', () => {
    const r = spawnSync('bash', ['-n', BOX], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
});

test('ploinky-install-deps bash syntax check (bash -n)', () => {
    const r = spawnSync('bash', ['-n', INSTALL_DEPS], { encoding: 'utf8' });
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

test('p-cli still delegates through bin/ploinky', () => {
    const fake = makeFakeNodeCapture();
    try {
        addReadlinkWithoutDashF(fake.dir);
        const env = {
            ...process.env,
            PATH: `${fake.dir}:${process.env.PATH || ''}`,
            PLOINKY_BOX_ENGINE: 'podman',
        };
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
        checkIncludes(out, '--privileged', 'inferred up grants nested podman networking');
        checkIncludes(out, '--user podman', 'inferred up runs as the podman user inside the box');
        checkIncludes(out, '--device /dev/fuse', 'inferred up passes /dev/fuse');
        checkIncludes(out, '--device /dev/net/tun', 'inferred up passes /dev/net/tun');
        checkIncludes(out, 'seccomp=unconfined', 'inferred up unconfines seccomp');
        checkIncludes(out, '127.0.0.1:8080:8080', 'inferred up publishes loopback 8080');
        checkIncludes(out, 'ploinky-box-testExplorerFresh-workspace:/workspace', 'inferred up mounts workspace volume');
        checkIncludes(out, 'ploinky-box-testExplorerFresh-containers:/home/podman/.local/share/containers', 'inferred up mounts containers volume');
        checkIncludes(out, `-v ${path.resolve(HERE, '..')}:/opt/ploinky:ro`, 'inferred up mounts the host checkout read-only');
        checkIncludes(out, `-v ${path.resolve(HERE, '..', 'container', 'ploinky-box-marker')}:/etc/ploinky-box:ro`, 'inferred up supplies the box marker file');
        checkIncludes(out, 'ploinky-box-testExplorerFresh-ploinky-deps:/opt/ploinky/node_modules:U', 'inferred up mounts the writable deps volume');
        checkAbsent(out, 'PLOINKY_BOX=', 'in-box routing uses the image marker file, not an env var');
        checkIncludes(out, 'docker.io/assistos/ploinky-box:podman-node24', 'inferred up uses default image');
        checkIncludes(out, '--init', 'inferred up reaps zombies');
    } finally {
        fs.rmSync(parent, { recursive: true, force: true });
    }
});

test('named up: docker engine, instance prefixes, LAN bind', () => {
    const { out } = boxRun('docker', '--dry-run', '--name', 'qa', '--port', '9090', '--listen-lan', 'up');
    checkIncludes(out, 'DRY-RUN: docker', 'named up uses docker when forced');
    checkIncludes(out, '--name ploinky-box-qa', 'named up names the instance');
    checkIncludes(out, 'ploinky-box-qa-workspace:/workspace', 'named up prefixes volumes');
    checkIncludes(out, 'ploinky-box-qa-ploinky-deps:/opt/ploinky/node_modules', 'named up mounts deps volume');
    checkIncludes(out, '0.0.0.0:9090:8080', 'lan flag binds all interfaces');
    checkIncludes(out, '--privileged', 'named up grants nested podman networking');
});

test('image override respected', () => {
    const { out } = boxRun('podman', '--dry-run', '--image', 'example.org/x/y:z', 'up');
    checkIncludes(out, 'example.org/x/y:z', 'image override respected');
});

test('publish and expose flags add extra ports in order', () => {
    const { out } = boxRun(
        'podman',
        '--dry-run',
        '--publish', '127.0.0.1:7880:7880',
        '--expose', '127.0.0.1:7881:7881',
        'up',
    );
    checkIncludes(out, '-p 127.0.0.1:7880:7880', 'publish flag adds extra port');
    checkIncludes(out, '-p 127.0.0.1:7881:7881', 'expose flag aliases publish');
    assert.ok(
        out.indexOf('-p 127.0.0.1:7880:7880') < out.indexOf('-p 127.0.0.1:7881:7881'),
        'publish/expose port order is preserved',
    );
});

test('--webmeet-ports is no longer a wrapper flag', () => {
    const { out, status } = boxRun('podman', '--dry-run', '--webmeet-ports', 'up');
    assert.equal(status, 1, out);
    checkIncludes(
        out,
        "unknown command '--webmeet-ports' (see: ploinky-box --help)",
        'removed webmeet shortcut is not accepted as a wrapper flag',
    );

    const trailing = boxRun('podman', '--dry-run', 'up', '--webmeet-ports');
    assert.equal(trailing.status, 1, trailing.out);
    checkIncludes(
        trailing.out,
        "unknown command '--webmeet-ports' (see: ploinky-box --help)",
        'removed webmeet shortcut is not accepted after a wrapper command',
    );
});

test('run passes through to ploinky', () => {
    const { out } = boxRun('podman', '--name', 'qa', '--dry-run', 'run', 'start', 'demo', '8080');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start demo 8080', 'run passes through to ploinky');
});

test('cp maps box: prefix to instance', () => {
    const { out } = boxRun('podman', '--name', 'qa', '--dry-run', 'cp', '/tmp/f', 'box:/workspace/f');
    checkIncludes(out, 'cp /tmp/f ploinky-box-qa:/workspace/f', 'cp maps box: prefix to instance');
});

test('ploinky-install-deps installs with read-only-safe npm flags and verifies deps', () => {
    const { root, binDir, argsFile } = makeFakeCheckout({ npmCreatesDeps: true });
    try {
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        const npmArgs = fs.readFileSync(argsFile, 'utf8');
        assert.ok(npmArgs.includes('install --no-package-lock --no-audit --no-fund'), npmArgs);
        assert.ok(fs.statSync(path.join(root, 'node_modules', 'achillesAgentLib')).isDirectory());
        assert.ok(fs.statSync(path.join(root, 'node_modules', 'mcp-sdk')).isDirectory());
        // second run: already installed, npm must not run again
        const r2 = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r2.status, 0, `${r2.stdout}${r2.stderr}`);
        assert.ok(r2.stdout.includes('already present'), r2.stdout);
        assert.equal(fs.readFileSync(argsFile, 'utf8'), npmArgs, 'npm not re-invoked when deps exist');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps fails loudly when npm leaves deps missing', () => {
    const { root, binDir } = makeFakeCheckout({ npmCreatesDeps: false });
    try {
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
        assert.ok(`${r.stdout}${r.stderr}`.includes('still missing after npm install'), `${r.stdout}${r.stderr}`);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps preserves an existing AchillesAgentLib checkout while installing missing mcp-sdk', () => {
    const { root, binDir, argsFile } = makeFakeCheckout({
        npmCreatesDeps: false,
        npmBody: 'mkdir -p "$PWD/node_modules/mcp-sdk"',
    });
    try {
        const localChange = path.join(root, 'node_modules', 'achillesAgentLib', 'local-change.txt');
        fs.mkdirSync(path.dirname(localChange), { recursive: true });
        fs.writeFileSync(localChange, 'do not delete\n');
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}` };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        assert.equal(fs.readFileSync(localChange, 'utf8'), 'do not delete\n');
        const npmArgs = fs.readFileSync(argsFile, 'utf8');
        assert.ok(npmArgs.includes('install --ignore-scripts --no-package-lock --no-audit --no-fund'), npmArgs);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
});

test('ploinky-install-deps resets a partial achillesAgentLib before installing when reset is explicitly allowed', () => {
    const { root, binDir } = makeFakeCheckout({ npmCreatesDeps: true });
    try {
        // partial state: achillesAgentLib exists (would break postinstall's git clone), mcp-sdk missing
        fs.mkdirSync(path.join(root, 'node_modules', 'achillesAgentLib', '.git'), { recursive: true });
        const env = { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}`, PLOINKY_INSTALL_DEPS_ALLOW_RESET: '1' };
        const r = spawnSync(path.join(root, 'bin', 'ploinky-install-deps'), [], { encoding: 'utf8', env });
        assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
        assert.ok(!fs.existsSync(path.join(root, 'node_modules', 'achillesAgentLib', '.git')), 'partial dir was reset');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(binDir, { recursive: true, force: true });
    }
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
    resolveHostPloinkySource,
    shouldInstallDeps,
    inferPublicStartBranchArgs,
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

test('public start infers non-default source branch unless branch flags are explicit', () => {
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer'], { PLOINKY_BOX_BRANCH: 'feature-x' }, REPO_ROOT),
        ['--branch', 'feature-x'],
    );
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer'], { PLOINKY_BOX_BRANCH: 'main' }, REPO_ROOT),
        [],
    );
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer', '--branch', 'manual'], { PLOINKY_BOX_BRANCH: 'feature-x' }, REPO_ROOT),
        [],
    );
    assert.deepEqual(
        inferPublicStartBranchArgs(['explorer'], { PLOINKY_BOX_BRANCH: 'feature-x', PLOINKY_BOX_AUTO_BRANCH: '0' }, REPO_ROOT),
        [],
    );
});

test('resolveHostPloinkySource: PLOINKY_BOX_SOURCE override wins, defaults to the checkout', () => {
    assert.equal(resolveHostPloinkySource({}), REPO_ROOT);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-src-'));
    try {
        for (const marker of ['bin', 'cli', 'globalDeps']) fs.mkdirSync(path.join(tmp, marker));
        fs.writeFileSync(path.join(tmp, 'bin', 'ploinky'), '#!/usr/bin/env bash\n');
        fs.writeFileSync(path.join(tmp, 'cli', 'index.js'), '// stub\n');
        fs.writeFileSync(path.join(tmp, 'globalDeps', 'package.json'), '{}\n');
        assert.equal(resolveHostPloinkySource({ PLOINKY_BOX_SOURCE: tmp }), path.resolve(tmp));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('up dies with guidance when PLOINKY_BOX_SOURCE is not a ploinky checkout', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-notsrc-'));
    try {
        const r = spawnSync(BOX, ['--name', 'qa', '--dry-run', 'up'], {
            encoding: 'utf8',
            env: { ...process.env, PLOINKY_BOX_ENGINE: 'podman', PLOINKY_BOX_SOURCE: tmp },
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert.equal(r.status, 1, out);
        checkIncludes(out, 'ploinky source not found', 'invalid source dies');
        checkIncludes(out, 'PLOINKY_BOX_SOURCE', 'error names the escape hatch');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('parseCli: repeatable --publish and --expose accumulate in order', () => {
    const cfg = parseCli([
        '--publish', '127.0.0.1:1:1',
        '--expose', '127.0.0.1:2:2',
        '--publish', '127.0.0.1:3:3',
        'up',
    ], {});
    assert.deepEqual(cfg.publish, ['127.0.0.1:1:1', '127.0.0.1:2:2', '127.0.0.1:3:3']);
    assert.equal(Object.hasOwn(cfg, 'webmeetPorts'), false);
});

test('up rejects explicit publishes outside the TCP and UDP range', () => {
    const { out, status } = boxRun(
        'podman',
        '--name', 'qa',
        '--dry-run',
        '--publish', '0.0.0.0:70000:70000',
        'up',
    );
    assert.equal(status, 1, out);
    checkIncludes(out, "invalid --publish '0.0.0.0:70000:70000'", 'invalid publish is rejected');
});

test('instance and volume naming', () => {
    const named = parseCli(['--name', 'qa', 'up'], {});
    assert.equal(instanceName(named), 'ploinky-box-qa');
    assert.deepEqual(volumeNames(named), {
        workspace: 'ploinky-box-qa-workspace',
        containers: 'ploinky-box-qa-containers',
        deps: 'ploinky-box-qa-ploinky-deps',
    });
});

test('volume naming includes the deps volume', () => {
    const named = parseCli(['--name', 'qa', 'up'], {});
    assert.deepEqual(volumeNames(named), {
        workspace: 'ploinky-box-qa-workspace',
        containers: 'ploinky-box-qa-containers',
        deps: 'ploinky-box-qa-ploinky-deps',
    });
});

test('buildRunArgs: selinux label only when the engine reports it; image is last', () => {
    const cfg = parseCli(['up'], {});
    const plain = buildRunArgs(cfg, { selinux: false });
    const labeled = buildRunArgs(cfg, { selinux: true });
    assert.ok(!plain.join(' ').includes('label=disable'));
    assert.ok(labeled.join(' ').includes('--security-opt label=disable'));
    assert.equal(plain[plain.length - 1], 'docker.io/assistos/ploinky-box:podman-node24');
    assert.ok(plain.includes('--privileged'));
});

test('buildRunArgs: read-only source mount plus writable deps volume', () => {
    const podmanCfg = parseCli(['--engine', 'podman', 'up'], {});
    const podmanArgs = buildRunArgs(podmanCfg, { selinux: false }).join(' ');
    assert.ok(podmanArgs.includes(`-v ${REPO_ROOT}:/opt/ploinky:ro`), podmanArgs);
    assert.ok(podmanArgs.includes(`-v ${path.join(REPO_ROOT, 'container', 'ploinky-box-marker')}:/etc/ploinky-box:ro`), podmanArgs);
    assert.ok(podmanArgs.includes('-ploinky-deps:/opt/ploinky/node_modules:U'), podmanArgs);
    assert.ok(!podmanArgs.includes('/workspace:ro'), 'workspace stays writable');
    assert.ok(!podmanArgs.includes('PLOINKY_BOX='), 'no PLOINKY_BOX env injection');

    const dockerCfg = parseCli(['--engine', 'docker', 'up'], {});
    const dockerArgs = buildRunArgs(dockerCfg, { selinux: false }).join(' ');
    assert.ok(dockerArgs.includes('-ploinky-deps:/opt/ploinky/node_modules '), dockerArgs);
    assert.ok(!dockerArgs.includes(':U'), 'docker gets no :U volume option');
});

test('docker up fixes deps-volume ownership; podman relies on :U', () => {
    const docker = boxRun('docker', '--dry-run', '--name', 'qa', 'up');
    checkIncludes(docker.out, 'exec --user root ploinky-box-qa chown podman:podman /opt/ploinky/node_modules',
        'docker up chowns the fresh deps volume');
    const podman = boxRun('podman', '--dry-run', '--name', 'qa', 'up');
    checkAbsent(podman.out, 'chown podman:podman /opt/ploinky/node_modules', 'podman up needs no chown (:U)');
});

test('shouldInstallDeps: explicit env opt-in, TTY confirm, default no', () => {
    assert.equal(shouldInstallDeps({ PLOINKY_BOX_INSTALL_DEPS: '1' }, false, null), true);
    assert.equal(shouldInstallDeps({}, true, 'y'), true);
    assert.equal(shouldInstallDeps({}, true, 'Y'), true);
    assert.equal(shouldInstallDeps({}, true, 'n'), false);
    assert.equal(shouldInstallDeps({}, true, ''), false);
    assert.equal(shouldInstallDeps({}, true, null), false);
    assert.equal(shouldInstallDeps({}, false, 'y'), false); // non-TTY never installs from a piped reply
});

test('dependency flow source contract: fatal public decline, docker chown is mandatory', () => {
    const source = fs.readFileSync(MJS, 'utf8');
    checkIncludes(source, 'async function cmdUp(cfg, { fatalOnDepsDecline = false } = {})',
        'cmdUp accepts fatal dependency-decline option');
    checkIncludes(source, 'if (fatalOnDecline) process.exit(1);',
        'declined public ploinky command exits before forwarding');
    checkIncludes(source, 'await cmdUp(cfg, { fatalOnDepsDecline: true });',
        'public ploinky startup passes fatal dependency-decline option');
    checkIncludes(source, 'fixDepsOwnership(cfg);\n        if (!await ensureDepsInstalled(cfg, { fatalOnDecline: fatalOnDepsDecline })) process.exit(1);',
        'already-running boxes repair docker deps ownership before prompting and exit on decline');
    checkAbsent(source, "chown', 'podman:podman', '/opt/ploinky/node_modules'], { allowFail: true",
        'docker deps chown failures are not ignored');
});

test('box up exits nonzero when dependency install is declined noninteractively', () => {
    const fake = makeFakePodmanForMissingDeps();
    try {
        const r = spawnSync(BOX, ['--name', 'qa', '--port', '18349', 'up'], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fake.dir}:${process.env.PATH || ''}`,
                PLOINKY_BOX_ENGINE: 'podman',
                PLOINKY_BOX_INSTALL_DEPS: '',
            },
            input: '',
        });
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert.equal(r.status, 1, out);
        checkIncludes(out, 'WARNING: Ploinky cannot run until dependencies are installed.', 'declined deps warning is emitted');
        const calls = fs.readFileSync(fake.calls, 'utf8');
        checkAbsent(calls, '/opt/ploinky/bin/ploinky-install-deps', 'decline must not run the installer');
    } finally {
        fs.rmSync(fake.dir, { recursive: true, force: true });
    }
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
        '--name', '--port', '--publish', '--expose', '--image', '--mount',
        '--listen-lan', '--engine', '--dry-run']) {
        assert.ok(u.includes(word), `usage() lost mention of ${word}`);
    }
    assert.ok(!u.includes('--webmeet-ports'), 'usage() still documents removed --webmeet-ports flag');
});

test('public usage describes ploinky and box namespace', () => {
    const r = spawnSync(process.execPath, [MJS, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_PUBLIC_ENTRYPOINT: '1' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('Usage: ploinky [flags] [command] [args]'), r.stdout);
    assert.ok(r.stdout.includes('ploinky box status'), r.stdout);
    assert.ok(r.stdout.includes('ploinky start <agent> [port] [--profile <name>]'), r.stdout);
    assert.ok(r.stdout.includes('--expose SPEC'), r.stdout);
    assert.ok(!r.stdout.includes('--webmeet-ports'), r.stdout);
    assert.ok(!r.stdout.includes('PLOINKY_DIRECT'), r.stdout);
});

test('bin/ploinky bash syntax and single-entry contract', () => {
    const r = spawnSync('bash', ['-n', PLOINKY], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const entry = fs.readFileSync(PLOINKY, 'utf8');
    assert.ok(entry.includes('/etc/ploinky-box'), 'entry routes on the image marker file');
    assert.ok(entry.includes('PLOINKY_WORKSPACE_ROOT'), 'entry supports older images that lack the marker file');
    assert.ok(entry.includes('/opt/ploinky'), 'entry limits marker fallback to the mounted box source path');
    assert.ok(entry.includes('Ploinky dependencies are not installed. Install them now? [y/N]'), 'entry carries the confirm prompt');
    assert.ok(entry.includes('Ploinky cannot run until dependencies are installed.'), 'entry carries the decline warning');
    assert.ok(entry.includes('ploinky-install-deps'), 'entry points at the installer');
    assert.ok(entry.includes('cli/index.js'), 'in-box branch execs the CLI');
    assert.ok(!entry.includes('PLOINKY_DIRECT'), 'PLOINKY_DIRECT is gone');
    assert.ok(!entry.includes('PLOINKY_BOX'), 'PLOINKY_BOX routing is gone');
    assert.ok(!entry.includes('ploinky-direct'), 'ploinky-direct is gone');
});

test('bin/ploinky-install-deps recognizes the same in-box context', () => {
    const installer = fs.readFileSync(path.join(HERE, '..', 'bin', 'ploinky-install-deps'), 'utf8');
    assert.ok(installer.includes('/etc/ploinky-box'), 'installer honors the image marker file');
    assert.ok(installer.includes('PLOINKY_WORKSPACE_ROOT'), 'installer supports older images that lack the marker file');
    assert.ok(installer.includes('/opt/ploinky'), 'installer limits marker fallback to the mounted box source path');
    assert.ok(installer.includes('PLOINKY_INSTALL_DEPS_ALLOW_RESET'), 'installer keeps the explicit reset override');
});

test('bin/ploinky-direct is deleted', () => {
    assert.ok(!fs.existsSync(path.join(HERE, '..', 'bin', 'ploinky-direct')), 'ploinky-direct must not exist');
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

test('public destroy targets the outer volume destroy command', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'destroy');
    assert.equal(status, 0, out);
    checkIncludes(out, 'volume rm ploinky-box-qa-workspace ploinky-box-qa-containers ploinky-box-qa-ploinky-deps', 'public destroy removes outer volumes');
    checkIncludes(out, "'ploinky-box-qa' and its volumes removed.", 'public destroy uses outer destroy behavior');
    checkAbsent(out, 'DRY-RUN: podman run -d', 'public destroy does not create/start the box first');
    checkAbsent(out, 'exec -w /workspace ploinky-box-qa ploinky destroy', 'public destroy does not run in-box destroy');
});

test('public destroy honors --name after the command for the outer box', () => {
    const { out, status } = publicRun('podman', '--dry-run', 'destroy', '--name', 'qa');
    assert.equal(status, 0, out);
    checkIncludes(out, 'volume rm ploinky-box-qa-workspace ploinky-box-qa-containers ploinky-box-qa-ploinky-deps', 'post-command --name selects outer volumes');
    checkIncludes(out, "'ploinky-box-qa' and its volumes removed.", 'post-command --name uses outer destroy behavior');
    checkAbsent(out, 'ploinky destroy --name qa', 'post-command --name is not forwarded in-box');
    checkAbsent(out, 'exec -w /workspace ploinky-box-qa ploinky destroy', 'post-command --name does not run in-box destroy');
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

test('public box rejects removed --webmeet-ports after lifecycle command', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'box', 'up', '--webmeet-ports');
    assert.equal(status, 1, out);
    checkIncludes(
        out,
        "unknown command '--webmeet-ports' (see: ploinky box --help)",
        'public box rejects removed webmeet shortcut after lifecycle command',
    );
});

test('public no-arg command opens in-box p-cli', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run');
    assert.equal(status, 0, out);
    checkIncludes(out, 'DRY-RUN: podman run -d', 'no-arg public command ensures box');
    checkIncludes(out, 'exec -it -w /workspace ploinky-box-qa p-cli', 'no-arg public command opens p-cli');
});

test('public start preserves branch flags while forcing in-box router to 8080', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
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
            'exec -w /workspace ploinky-box-qa ploinky start explorer 8080 --profile default --branch feature-x --repo-branch AssistOSExplorer=peristo-user --branch-fallback fail',
            'public start forwards branch flags after in-box port',
        );
        checkAbsent(out, 'ploinky start explorer 9191', 'public start never uses host port inside');
    } finally {
        source.cleanup();
    }
});

test('public start forwards inferred source branch when no branch flag is supplied', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            {
                PLOINKY_BOX_BRANCH: 'feature-default',
                PLOINKY_BOX_SOURCE: source.sourceDir,
            },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(
            out,
            'exec -w /workspace ploinky-box-qa ploinky start explorer 8080 --profile default --branch feature-default',
            'public start appends the inferred branch after the fixed in-box port',
        );
    } finally {
        source.cleanup();
    }
});

test('public start explorer publishes graph-derived openPorts only', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 127.0.0.1:8081:8081', 'Explorer start publishes Web Publishing nginx');
        checkIncludes(out, '-p 127.0.0.1:7881:7881', 'Explorer start publishes LiveKit direct TCP media-plane port');
        checkIncludes(out, '-p 127.0.0.1:3478:3478', 'Explorer start publishes TURN TCP');
        checkIncludes(out, '-p 127.0.0.1:3478:3478/udp', 'Explorer start publishes TURN UDP');
        checkIncludes(out, '-p 127.0.0.1:7882-7892:7882-7892/udp', 'Explorer start publishes LiveKit UDP media range');
        checkIncludes(out, '-p 127.0.0.1:20000-20010:20000-20010/udp', 'Explorer start publishes TURN relay range');
        checkAbsent(out, '-p 127.0.0.1:8082:8082', 'Explorer start does not publish OnlyOffice directly');
        checkAbsent(out, '-p 127.0.0.1:7681:7681', 'Explorer start does not publish webtty directly');
        checkAbsent(out, '-p 127.0.0.1:17000:17000', 'Explorer start does not publish LiveKit health directly');
        checkAbsent(out, '-p 127.0.0.1:7880:7880', 'Explorer start does not publish LiveKit signaling directly');
        checkAbsent(out, '-p 127.0.0.1:6379:6379', 'Explorer start does not publish Redis by default');
    } finally {
        source.cleanup();
    }
});

test('public start only adds Explorer default publishes for the explorer agent', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'start', 'demo');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start demo 8080', 'non-Explorer start still runs inside');
    checkAbsent(out, '-p 127.0.0.1:7880:7880', 'non-Explorer start does not get Explorer LiveKit publish');
    checkAbsent(out, '-p 127.0.0.1:8081:8081', 'non-Explorer start does not get Explorer Web Publishing publish');
});

test('public start explorer preserves explicit publishes and skips conflicting defaults', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', '0.0.0.0:3478:3478/udp',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 0.0.0.0:3478:3478/udp', 'explicit TURN UDP publish is preserved');
        checkAbsent(out, '-p 127.0.0.1:3478:3478/udp', 'derived TURN UDP publish is skipped for the same target');
        checkIncludes(out, '-p 127.0.0.1:3478:3478', 'same port with a different protocol is still added');
    } finally {
        source.cleanup();
    }
});

test('public start explorer does not duplicate an exact explicit default publish', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', '127.0.0.1:3478:3478/udp',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        assert.equal(countOccurrences(out, '-p 127.0.0.1:3478:3478/udp'), 1, out);
    } finally {
        source.cleanup();
    }
});

test('public start preserves every supported explicit publish form and suppresses the canonical TCP target', () => {
    const cases = [
        '8081',
        '18081:8081',
        '127.0.0.1:18081:8081',
    ];
    for (const explicit of cases) {
        const source = makeFakePloinkyGraphSource();
        try {
            const { out, status } = publicRunWithEnv(
                { PLOINKY_BOX_SOURCE: source.sourceDir },
                'podman',
                '--name', 'qa',
                '--dry-run',
                '--publish', explicit,
                'start', 'explorer',
            );
            assert.equal(status, 0, out);
            checkIncludes(out, `-p ${explicit}`, `explicit publish '${explicit}' is passed through byte-for-byte`);
            checkAbsent(out, '-p 127.0.0.1:8081:8081', `explicit publish '${explicit}' suppresses generated 8081/tcp`);
        } finally {
            source.cleanup();
        }
    }
});

test('public start preserves an engine protocol outside the manifest TCP/UDP policy', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const explicit = '127.0.0.1:18081:8081/sctp';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'explicit SCTP publish is left for the engine to interpret');
        checkIncludes(out, '-p 127.0.0.1:8081:8081', 'SCTP does not suppress generated TCP at the same target');
    } finally {
        source.cleanup();
    }
});

test('public start canonicalizes leading zeroes only for suppression and never rewrites the raw explicit value', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const explicit = '127.0.0.1:18081:08081';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'the engine receives the exact leading-zero publish');
        checkAbsent(out, '-p 127.0.0.1:8081:8081', 'leading zeroes cannot bypass generated-target suppression');
    } finally {
        source.cleanup();
    }
});

test('public start suppresses an overlapping generated single port when the explicit target is a range', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const explicit = '18080-18090:8080-8090';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'the explicit range is preserved');
        checkAbsent(out, '-p 127.0.0.1:8081:8081', 'the overlapping generated single port is suppressed');
    } finally {
        source.cleanup();
    }
});

test('public start suppresses the whole generated range when an explicit single target overlaps it', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingOpenPorts: ['127.0.0.1:9000-9010:9000-9010'],
    });
    try {
        const explicit = '19001:9001';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'the explicit single-port publish is preserved');
        checkAbsent(out, '127.0.0.1:9000-9010:9000-9010', 'the overlapping generated range is not emitted');
        checkAbsent(out, '127.0.0.1:9000:9000', 'the generated range is not split below the overlap');
        checkAbsent(out, '127.0.0.1:9002-9010:9002-9010', 'the generated range is not split above the overlap');
    } finally {
        source.cleanup();
    }
});

test('public start keeps generated UDP when an explicit TCP target uses the same port', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingOpenPorts: ['127.0.0.1:8081:8081/udp'],
    });
    try {
        const explicit = '18081:8081/tcp';
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            '--publish', explicit,
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, `-p ${explicit}`, 'the explicit TCP publish is preserved');
        checkIncludes(out, '-p 127.0.0.1:8081:8081/udp', 'same-number UDP remains independent');
    } finally {
        source.cleanup();
    }
});

test('public qualified Explorer start plans and forwards one explicit development profile', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingProfiles: {
            default: {
                openPorts: ['127.0.0.1:8081:8081'],
            },
            dev: {
                openPorts: ['127.0.0.1:9081:8081'],
            },
        },
    });
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'AchillesIDE/explorer', '8080', '--profile', 'DEV',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 127.0.0.1:9081:9081', 'the dev openPorts mapping is selected');
        checkAbsent(out, '-p 127.0.0.1:8081:8081', 'the default-only mapping is replaced');
        checkIncludes(
            out,
            'exec -w /workspace ploinky-box-qa ploinky start AchillesIDE/explorer 8080 --profile dev',
            'the normalized planner profile reaches the in-box start command',
        );
    } finally {
        source.cleanup();
    }
});

test('public bare Explorer start ignores host profile state and plans and forwards default', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingProfiles: {
            default: {
                openPorts: ['127.0.0.1:8081:8081'],
            },
            dev: {
                openPorts: ['127.0.0.1:9081:8081'],
            },
        },
    });
    try {
        const { out, status } = publicRunWithEnv(
            {
                PLOINKY_BOX_SOURCE: source.sourceDir,
                PLOINKY_PROFILE: 'dev',
            },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '-p 127.0.0.1:8081:8081', 'omission selects the default publish graph');
        checkAbsent(out, '-p 127.0.0.1:9081:9081', 'host profile state does not select dev');
        checkIncludes(
            out,
            'exec -w /workspace ploinky-box-qa ploinky start explorer 8080 --profile default',
            'omission explicitly forwards default in-box',
        );
    } finally {
        source.cleanup();
    }
});

test('public start accepts --profile=value before the agent and does not treat it as positional', () => {
    const source = makeFakePloinkyGraphSource({
        webPublishingProfiles: {
            default: { openPorts: ['127.0.0.1:8081:8081'] },
            dev: { openPorts: ['127.0.0.1:9081:8081'] },
        },
    });
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', '--profile=dev', 'AssistOSExplorer/explorer', '9191',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '127.0.0.1:9191:8080', 'the positional host port remains aligned');
        checkIncludes(
            out,
            'ploinky start AssistOSExplorer/explorer 8080 --profile dev',
            'the profile option is consumed and forwarded canonically',
        );
        checkAbsent(out, 'ploinky start dev 8080', 'the profile value never becomes the agent positional');
    } finally {
        source.cleanup();
    }
});

test('ploinky-box source does not hardcode Explorer publish topology', () => {
    const source = fs.readFileSync(MJS, 'utf8');
    const oldPublishConstant = ['EXPLORER', 'START', 'PUBLISH', 'SPECS'].join('_');
    const oldExplorerEnv = ['PLOINKY', 'BOX', 'EXPLORER', 'PORTS'].join('_');
    const oldPortMetadata = ['box', 'Publish'].join('');
    assert.equal(source.includes(oldPublishConstant), false);
    assert.equal(source.includes(oldExplorerEnv), false);
    assert.equal(source.includes('127.0.0.1:8082:8082'), false);
    assert.equal(source.includes(oldPortMetadata), false);
});

test('public start accepts --port before the agent without forwarding it in-box', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', '--port', '9191', 'explorer',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '127.0.0.1:9191:8080', 'post-command --port before agent is the host port');
        checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start explorer 8080', 'agent remains explorer');
        checkAbsent(out, 'ploinky start 9191 8080 --port explorer', 'post-command --port does not reorder into in-box args');
    } finally {
        source.cleanup();
    }
});

test('public start accepts --port after the agent without forwarding it in-box', () => {
    const source = makeFakePloinkyGraphSource();
    try {
        const { out, status } = publicRunWithEnv(
            { PLOINKY_BOX_SOURCE: source.sourceDir },
            'podman',
            '--name', 'qa',
            '--dry-run',
            'start', 'explorer', '--port', '9192',
        );
        assert.equal(status, 0, out);
        checkIncludes(out, '127.0.0.1:9192:8080', 'post-command --port after agent is the host port');
        checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start explorer 8080', 'agent remains explorer');
        checkAbsent(out, 'ploinky start explorer 8080 --port 9192', 'post-command --port is not forwarded in-box');
    } finally {
        source.cleanup();
    }
});

test('public start without an agent forwards in-box start instead of wrapper failing', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'start');
    assert.equal(status, 0, out);
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky start', 'start with no args is forwarded');
    checkAbsent(out, 'usage:', 'public start without args is not rejected by the wrapper');
});

test('public command hoists --expose after the command without forwarding it in-box', () => {
    const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', 'status', '--expose', '127.0.0.1:9090:9090');
    assert.equal(status, 0, out);
    checkIncludes(out, '-p 127.0.0.1:9090:9090', 'public post-command --expose publishes an outer box port');
    checkIncludes(out, 'exec -w /workspace ploinky-box-qa ploinky status', 'public status still runs in-box status');
    checkAbsent(out, 'ploinky status --expose 127.0.0.1:9090:9090', 'post-command --expose is not forwarded in-box');
});

test('public command rejects removed --webmeet-ports instead of forwarding it in-box', () => {
    const trailing = publicRun('podman', '--name', 'qa', '--dry-run', 'status', '--webmeet-ports');
    assert.equal(trailing.status, 1, trailing.out);
    checkIncludes(
        trailing.out,
        "unknown command '--webmeet-ports' (see: ploinky --help)",
        'public post-command webmeet shortcut is rejected',
    );
    checkAbsent(trailing.out, 'ploinky status --webmeet-ports', 'removed wrapper flag is not forwarded in-box');

    const leading = publicRun('podman', '--name', 'qa', '--dry-run', '--webmeet-ports', 'status');
    assert.equal(leading.status, 1, leading.out);
    checkIncludes(
        leading.out,
        "unknown command '--webmeet-ports' (see: ploinky --help)",
        'public leading webmeet shortcut is rejected',
    );
});

test('public ploinky forwards registered top-level CLI commands into the box except host-side destroy', () => {
    const registry = getCommandRegistry();
    assert.equal(registry.box, undefined, 'box is reserved for outer lifecycle commands');

    for (const command of Object.keys(registry)) {
        if (command === 'destroy') continue;
        const { out, status } = publicRun('podman', '--name', 'qa', '--dry-run', command);
        assert.equal(status, 0, `${command}\n${out}`);
        checkIncludes(out, 'DRY-RUN: podman run -d', `${command}: public command ensures the box`);

        const ttyFlag = (command === 'cli' || command === 'shell') ? '-it ' : '';
        checkIncludes(
            out,
            `exec ${ttyFlag}-w /workspace ploinky-box-qa ploinky ${command}`,
            `${command}: public command forwards to in-box ploinky`,
        );
    }
});

test('public parser preserves normal command flags after the command', () => {
    const cfg = parseCli(['client', 'tool', 'process', '--dry-run'], {}, { publicEntrypoint: true });
    assert.equal(cfg.command, 'client');
    assert.deepEqual(cfg.args, ['tool', 'process', '--dry-run']);
    assert.equal(cfg.dryRun, false);
});

test('public parser hoists box selector flags after the command', () => {
    const cfg = parseCli(['destroy', '--name', 'qa', '--expose', '127.0.0.1:9090:9090'], {}, { publicEntrypoint: true });
    assert.equal(cfg.command, 'destroy');
    assert.equal(cfg.name, 'qa');
    assert.deepEqual(cfg.publish, ['127.0.0.1:9090:9090']);
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

test('docs describe boxed-by-default ploinky and the host-mounted core', () => {
    const rootReadme = fs.readFileSync(path.join(HERE, '..', 'README.md'), 'utf8');
    const boxReadme = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
    assert.ok(rootReadme.includes('ploinky box status'), rootReadme);
    assert.ok(rootReadme.includes('mounted read-only'), rootReadme);
    assert.ok(rootReadme.includes('node cli/index.js'), rootReadme);
    assert.ok(!rootReadme.includes('PLOINKY_DIRECT'), 'the direct-mode escape is gone');
    assert.ok(boxReadme.includes('ploinky box destroy'), boxReadme);
    assert.ok(boxReadme.includes('Graph-driven Explorer publishes'), boxReadme);
    assert.ok(boxReadme.includes('openPorts'), boxReadme);
    assert.ok(boxReadme.includes('/opt/ploinky'), boxReadme);
    assert.ok(boxReadme.includes('read-only'), boxReadme);
    assert.ok(boxReadme.includes('ploinky-deps'), boxReadme);
    assert.ok(boxReadme.includes('PLOINKY_BOX_SOURCE'), boxReadme);
    assert.ok(boxReadme.includes('PLOINKY_BOX_INSTALL_DEPS'), boxReadme);
    assert.ok(boxReadme.includes('Install them now?'), boxReadme);
    assert.ok(boxReadme.includes('/etc/ploinky-box'), boxReadme);
    assert.ok(!boxReadme.includes('PLOINKY_DIRECT'), 'the direct-mode escape is gone');
});

test('package metadata advertises the Node 20 runtime floor', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(packageJson.engines.node, '>=20.0.0');
});

test('package metadata exposes ploinky as the public binary', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    assert.equal(packageJson.bin.ploinky, './bin/ploinky');
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
        checkIncludes(out, 'volume rm ploinky-box-testExplorerFresh-workspace ploinky-box-testExplorerFresh-containers ploinky-box-testExplorerFresh-ploinky-deps', 'destroy removes all three volumes');
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
