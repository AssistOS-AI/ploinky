import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import { admitManifestRuntimeCapabilities } from '../../cli/sandbox/runtimeCapabilities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(repoRoot, 'tests', 'fixtures', 'box-policy-repo');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');

function treeSnapshot(root) {
    const snapshot = {};
    function visit(current, relative = '') {
        const entries = fs.readdirSync(current, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            const key = path.join(relative, entry.name);
            const stat = fs.lstatSync(absolute);
            if (entry.isDirectory()) {
                snapshot[`${key}/`] = { mode: stat.mode & 0o777 };
                visit(absolute, key);
            } else if (entry.isSymbolicLink()) {
                snapshot[key] = { mode: stat.mode & 0o777, link: fs.readlinkSync(absolute) };
            } else {
                snapshot[key] = {
                    mode: stat.mode & 0o777,
                    digest: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
                };
            }
        }
    }
    visit(root);
    return snapshot;
}

test('clean explicit fixture repository rejects privilege in Box with zero admission mutation or Podman invocation', (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-policy-fixture-'));
    const marker = path.join(workspace, 'ploinky-box-marker');
    const sourceRepo = path.join(workspace, 'fixture-source');
    const installedRepo = path.join(workspace, '.ploinky', 'repos', 'box-policy-repo');
    const fakeBin = path.join(workspace, 'fake-bin');
    const podmanCalled = path.join(workspace, 'podman-called');
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

    fs.cpSync(fixtureRoot, sourceRepo, { recursive: true, verbatimSymlinks: true });
    execFileSync('git', ['init', '-q'], { cwd: sourceRepo });
    execFileSync('git', ['config', 'user.name', 'Ploinky Fixture'], { cwd: sourceRepo });
    execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: sourceRepo });
    execFileSync('git', ['add', '--', '.'], { cwd: sourceRepo });
    execFileSync('git', ['commit', '-q', '-m', 'test-only privileged policy fixture'], { cwd: sourceRepo });
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRepo, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: sourceRepo, encoding: 'utf8' }).trim();
    assert.match(commit, /^[a-f0-9]{40}$/);
    assert.match(tree, /^[a-f0-9]{40}$/);
    assert.equal(execFileSync('git', ['status', '--porcelain'], {
        cwd: sourceRepo,
        encoding: 'utf8',
    }), '');

    for (const repoName of ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents']) {
        fs.mkdirSync(path.join(workspace, '.ploinky', 'repos', repoName), { recursive: true });
    }

    const install = spawnSync(process.execPath, [
        cliEntry,
        'install',
        'repo',
        `file://${sourceRepo}`,
        'box-policy-repo',
    ], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '7'.repeat(64),
        },
    });
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: installedRepo,
        encoding: 'utf8',
    }).trim(), commit);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
        cwd: installedRepo,
        encoding: 'utf8',
    }).trim(), tree);
    assert.equal(execFileSync('git', ['status', '--porcelain'], {
        cwd: installedRepo,
        encoding: 'utf8',
    }), '');

    fs.writeFileSync(marker, BOX_MARKER_CONTENT);
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'podman'), `#!/bin/sh\nprintf invoked > ${JSON.stringify(podmanCalled)}\nexit 99\n`, { mode: 0o755 });
    const before = treeSnapshot(path.join(workspace, '.ploinky'));

    const manifestPath = path.join(installedRepo, 'privilegedAgent', 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.throws(
        () => admitManifestRuntimeCapabilities(manifest, {
            manifestBytes,
            manifestPath,
            agentId: 'box-policy-repo/privilegedAgent',
            boxMarkerOptions: { markerPath: marker },
            workspaceRoot: workspace,
        }),
        (error) => error.code === 'PLOINKY_BOX_RUNTIME_CAPABILITY_UNSUPPORTED'
            && /privileged/.test(error.message),
    );
    assert.equal(fs.existsSync(podmanCalled), false);
    const monitorProbe = spawnSync(process.execPath, [
        '--input-type=module',
        '-e', [
            "const m=await import('./cli/server/containerMonitor.js');",
            'const monitor=m.createContainerMonitor({config:{CONTAINER_CHECK_INTERVAL_MS:25,INITIAL_BACKOFF_MS:25}});',
            'm.syncManagedContainers(monitor);',
            "process.stdout.write(JSON.stringify({targets:monitor.targets.size,pending:[...monitor.targets.values()].filter(v=>v.pendingRestartTimer).length,terminal:monitor.terminalLedger.size}));",
        ].join(''),
    ], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
        },
    });
    assert.equal(monitorProbe.status, 0, monitorProbe.stderr);
    assert.deepEqual(JSON.parse(monitorProbe.stdout), { targets: 0, pending: 0, terminal: 0 });
    assert.deepEqual(treeSnapshot(path.join(workspace, '.ploinky')), before);
});
