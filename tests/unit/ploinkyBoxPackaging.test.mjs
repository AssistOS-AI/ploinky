import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const BASE_SHA = 'c8f38927dd2741da9635debe61c64c39358aa8f9';
const repositoryRoot = path.resolve(import.meta.dirname, '../..');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        ...options,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stderr}`);
    return result;
}

function mode(target) {
    return fs.statSync(target).mode & 0o777;
}

function controlledNodeFixture(root) {
    const bin = path.join(root, 'controlled-bin');
    const capture = path.join(root, 'node-argv.json');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), [
        '#!/usr/bin/env bash',
        'printf \'%s\\n\' "$@" > "$PLOINKY_TEST_NODE_CAPTURE"',
        '',
    ].join('\n'), { mode: 0o755 });
    return {
        capture,
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH || '/usr/bin:/bin'}`,
            PLOINKY_TEST_NODE_CAPTURE: capture,
        },
    };
}

test('package metadata changes only the exact bin map and immutable postinstall', () => {
    const current = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
    const baseline = JSON.parse(run('git', ['show', `${BASE_SHA}:package.json`]).stdout);
    const { bin: currentBin, ...currentRest } = current;
    const { bin: baselineBin, ...baselineRest } = baseline;
    const expectedRest = structuredClone(baselineRest);
    expectedRest.scripts.postinstall = 'node ./ploinky-box/entrypoint/install-dependencies.mjs';
    assert.deepEqual(currentRest, expectedRest);
    assert.notDeepEqual(currentBin, baselineBin);
    assert.deepEqual(currentBin, {
        ploinky: './bin/ploinky',
        'ploinky-local': './bin/ploinky-local',
    });
});

test('packaging binaries preserve helper bytes, modes, and the local Darwin hard boundary', () => {
    const localEntrypoint = fs.readFileSync(
        path.join(repositoryRoot, 'bin/ploinky-local'),
        'utf8',
    );
    assert.match(localEntrypoint, /uname -s/);
    assert.match(localEntrypoint, /refuses execution outside its managed Linux Box boundary/);
    assert.match(localEntrypoint, /\/usr\/bin\/uname -s/);
    for (const name of ['p-cli', 'ploinky-shell']) {
        assert.deepEqual(
            fs.readFileSync(path.join(repositoryRoot, 'bin', name)),
            Buffer.from(run('git', ['show', `${BASE_SHA}:bin/${name}`], { encoding: null }).stdout),
        );
    }
    for (const name of [
        'ploinky', 'ploinky-local', 'p-cli', 'psh', 'ploinky-shell', 'ploinky-install-deps',
    ]) {
        assert.equal(mode(path.join(repositoryRoot, 'bin', name)), 0o755, `${name} mode`);
    }
});

test('npm pack exports working boxed and local commands without running postinstall', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-pack-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const packed = JSON.parse(run('npm', [
        'pack', '--ignore-scripts', '--json', '--pack-destination', root,
    ]).stdout);
    assert.equal(packed.length, 1);
    const archive = path.join(root, packed[0].filename);
    const archiveEntries = run('tar', ['-tzf', archive]).stdout.split(/\r?\n/).filter(Boolean);
    assert.equal(archiveEntries.some((entry) => (
        /(?:^|\/)candidate-proxy(?:\/|$)/.test(entry)
        || /(?:^|\/)ploinky-box\/testing(?:\/|$)/.test(entry)
        || /(?:^|\/)podman$/.test(entry)
    )), false, 'the candidate-selection proxy must not be packaged');
    run('tar', ['-xzf', archive, '-C', root]);
    const packageRoot = path.join(root, 'package');
    const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(metadata.bin, {
        ploinky: './bin/ploinky',
        'ploinky-local': './bin/ploinky-local',
    });
    assert.equal(mode(path.join(packageRoot, 'bin/ploinky')), 0o755);
    assert.equal(mode(path.join(packageRoot, 'bin/ploinky-local')), 0o755);

    const boxed = run(path.join(packageRoot, 'bin/ploinky'), ['help'], { cwd: packageRoot });
    assert.match(boxed.stdout, /run Ploinky through its managed outer Box/);

    fs.mkdirSync(path.join(packageRoot, 'node_modules/achillesAgentLib'), { recursive: true });
    const controlled = controlledNodeFixture(root);
    const local = spawnSync(path.join(packageRoot, 'bin/ploinky-local'), ['status', '--fixture'], {
        cwd: packageRoot,
        env: controlled.env,
        encoding: 'utf8',
    });
    if (process.platform === 'darwin') {
        assert.equal(local.status, 78);
        assert.match(local.stderr, /refuses execution outside its managed Linux Box boundary/);
        assert.equal(fs.existsSync(controlled.capture), false);
    } else {
        assert.equal(local.status, 0, local.stderr);
        const captured = fs.readFileSync(controlled.capture, 'utf8').trim().split('\n');
        assert.equal(captured.at(-2), 'status');
        assert.equal(captured.at(-1), '--fixture');
        assert.match(captured[0], /cli\/index\.js$/);
    }
});

test('repository aliases retain boxed versus local routing and helper rejects non-Box use', () => {
    const ploinkyHelp = run(path.join(repositoryRoot, 'bin/ploinky'), ['help']).stdout;
    const pCliHelp = run(path.join(repositoryRoot, 'bin/p-cli'), ['help']).stdout;
    assert.equal(pCliHelp, ploinkyHelp);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-aliases-'));
    try {
        const controlled = controlledNodeFixture(root);
        run(path.join(repositoryRoot, 'bin/ploinky-shell'), ['shell-fixture'], {
            env: controlled.env,
        });
        assert.match(fs.readFileSync(controlled.capture, 'utf8'), /cli\/shell\.js/);
        const psh = spawnSync(path.join(repositoryRoot, 'bin/psh'), ['psh-fixture'], {
            env: controlled.env,
            encoding: 'utf8',
        });
        if (process.platform === 'darwin') {
            assert.equal(psh.status, 78);
            assert.match(psh.stderr, /refuses execution outside its managed Linux Box boundary/);
        } else {
            assert.equal(psh.status, 0, psh.stderr);
            const pshCapture = fs.readFileSync(controlled.capture, 'utf8');
            assert.match(pshCapture, /cli\/shell\.js/);
            assert.match(pshCapture, /psh-fixture/);
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }

    const helper = spawnSync(path.join(repositoryRoot, 'bin/ploinky-install-deps'), [], {
        cwd: repositoryRoot,
        encoding: 'utf8',
    });
    assert.notEqual(helper.status, 0);
    assert.match(helper.stderr, /Box marker|dependency initialization failed/i);
});
