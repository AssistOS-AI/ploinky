import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runBoundedRestartCommand } from '../../ploinky-box/supervisor.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from '../../ploinky-box/process.mjs';
import {
    IN_BOX_OPERATION_WRITERS_PROBE_SCRIPT,
    selectOperationWriters,
} from '../../ploinky-box/update/coreRunner.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';

// A cancelled or timed-out graph restart must stop the restart itself, never
// the graph it already started. Every process below inherited the restart's
// marker, as observed in a live Box after an update activation restart.
const row = (pid, ppid, pgid, comm, marked = true) => ({ pid, ppid, pgid, comm, marked });
const GRAPH = [
    row(1, 0, 1, 'podman-init', false),
    row(23, 1, 22, 'catatonit'),
    row(600, 501, 600, 'MainThread'), // Watchdog, detached by the restart
    row(601, 600, 600, 'MainThread'), // Router, child of the Watchdog
    row(700, 501, 700, 'node'), // detached no-wait worker
    row(701, 700, 700, 'podman'), // its engine client
    row(800, 1, 800, 'conmon'),
    row(801, 1, 801, 'fuse-overlayfs'),
    row(802, 1, 802, 'pasta'),
    row(803, 1, 803, 'aardvark-dns'),
    row(804, 1, 804, 'rootlessport'),
    row(805, 804, 804, 'exe'),
];

test('restart writers are the exec\'d command and its process group, not the graph it started', () => {
    const table = [
        ...GRAPH,
        row(500, 0, 500, 'bash'), // the command the engine exec'd
        row(501, 500, 500, 'node'),
        row(502, 501, 500, 'podman'), // an engine client still waiting on a container
        row(503, 501, 500, 'git', false), // same group without the marker
    ];
    assert.deepEqual(selectOperationWriters(table), [500, 501, 502, 503]);
});

test('after the exec\'d command died its orphaned group is still found; the graph is not', () => {
    const table = [
        ...GRAPH.map(entry => (entry.ppid === 501 ? { ...entry, ppid: 1 } : entry)),
        row(501, 1, 500, 'node'),
        row(503, 501, 500, 'git', false),
    ];
    assert.deepEqual(selectOperationWriters(table), [501, 503]);
});

test('a finished restart leaves no writers, so its recovery record can be cleared', () => {
    assert.deepEqual(selectOperationWriters(GRAPH.map(entry => (entry.ppid === 501 ? { ...entry, ppid: 1 } : entry))), []);
    assert.deepEqual(selectOperationWriters([row(900, 0, 900, 'node', false)]), [], 'an unmarked exec is not this operation');
});

test('the in-Box writer probe reads real process groups from /proc', (t) => {
    if (!fs.existsSync('/proc/self/stat')) {
        t.skip('requires Linux /proc; the Box runs Linux');
        return;
    }
    const marker = `PLOINKY_UPDATE_OPERATION=${crypto.randomBytes(16).toString('hex')}`;
    const env = { ...process.env, PLOINKY_UPDATE_OPERATION: marker.split('=')[1] };
    // A daemon leading its own live group, and a process whose group leader
    // has already exited (what remains of a dead exec'd command).
    const daemon = spawn('sleep', ['30'], { env, detached: true, stdio: 'ignore' });
    const orphanPidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'restart-writers-')), 'pid');
    spawnSync('sh', ['-c', `sleep 30 & echo $! > ${JSON.stringify(orphanPidFile)}`], { env, detached: true, stdio: 'ignore' });
    const orphan = Number(fs.readFileSync(orphanPidFile, 'utf8'));
    try {
        const listed = spawnSync(process.execPath, ['-e', IN_BOX_OPERATION_WRITERS_PROBE_SCRIPT, marker], { encoding: 'utf8' });
        const pids = JSON.parse(listed.stdout);
        assert.ok(pids.includes(orphan), 'the orphaned writer is listed');
        assert.equal(pids.includes(daemon.pid), false, 'the detached daemon is not listed');
    } finally {
        try { process.kill(daemon.pid, 'SIGKILL'); } catch {}
        try { process.kill(orphan, 'SIGKILL'); } catch {}
        fs.rmSync(path.dirname(orphanPidFile), { recursive: true, force: true });
    }
});

// Real engine: the production restart runner times out against a container of
// the Box image whose `ploinky-local restart` starts a detached daemon and a
// same-group writer, then hangs. Never pulls; skipped without the local image.
const BOX_IMAGE = 'docker.io/assistos/ploinky-box:latest';
function localBoxImage() {
    if (spawnSync('podman', ['--version'], { stdio: 'ignore' }).status !== 0) return false;
    return spawnSync('podman', ['image', 'exists', BOX_IMAGE], { stdio: 'ignore' }).status === 0;
}

test('a timed-out graph restart stops its own writers and leaves the started graph running', {
    skip: localBoxImage() ? false : `requires Podman and a local ${BOX_IMAGE}`,
    timeout: 120_000,
}, async (t) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-restart-writers-')));
    const workspace = path.join(root, 'workspace');
    const ploinkyRoot = path.join(root, 'opt-ploinky');
    fs.mkdirSync(workspace, { mode: 0o777 });
    fs.chmodSync(workspace, 0o777);
    fs.mkdirSync(path.join(ploinkyRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(ploinkyRoot, 'bin', 'ploinky-local'), [
        '#!/bin/bash',
        'setsid sleep 600 & echo "daemon $!" >> "$PWD/pids"',
        'sleep 600 & echo "writer $!" >> "$PWD/pids"',
        'echo "root $$" >> "$PWD/pids"',
        'echo ready',
        'wait',
        '',
    ].join('\n'), { mode: 0o755 });
    const name = `ploinky-restart-writers-${crypto.randomBytes(4).toString('hex')}`;
    const podman = (...args) => spawnSync('podman', args, { encoding: 'utf8' });
    t.after(() => {
        podman('rm', '-f', '-t', '0', name);
        fs.rmSync(root, { recursive: true, force: true });
    });
    // Like the Box, the container has an init that reaps what the restart leaves behind.
    const started = podman('run', '-d', '--init', '--name', name, '--user', 'podman', '--entrypoint', '/usr/bin/sleep',
        '-v', `${workspace}:${workspace}`, '-v', `${ploinkyRoot}:/opt/ploinky:ro`, BOX_IMAGE, 'infinity');
    assert.equal(started.status, 0, started.stderr);
    const containerId = started.stdout.trim();

    const result = await runBoundedRestartCommand({ name: 'podman' }, containerId, ['restart'], 8080, 7882,
        createProcessRunner({ env: buildEngineProcessEnvironment() }), {
            workspaceRoot: workspace,
            agentLib: agentLibFixture(workspace),
            operationId: crypto.randomBytes(16).toString('hex'),
            stdout: { write() {} },
            stderr: { write() {} },
            runnerOptions: { timeoutMs: 8_000, termGraceMs: 3_000, killGraceMs: 3_000, probeIntervalMs: 200 },
        });

    const pids = Object.fromEntries(fs.readFileSync(path.join(workspace, 'pids'), 'utf8').trim().split('\n')
        .map(line => line.split(' ')).map(([role, pid]) => [role, Number(pid)]));
    // Running means present and not a zombie awaiting its reaper.
    const alive = (pid) => {
        const stat = podman('exec', '--user', 'podman', containerId, 'cat', `/proc/${pid}/stat`);
        return stat.status === 0 && stat.stdout.slice(stat.stdout.lastIndexOf(')') + 2, stat.stdout.lastIndexOf(')') + 3) !== 'Z';
    };
    assert.equal(result.cause, 'timeout');
    assert.equal(result.quiescence.state, 'confirmed');
    assert.equal(result.quiescence.method, 'engine-probe-after-TERM');
    assert.equal(alive(pids.root), false, 'the exec\'d restart still runs');
    assert.equal(alive(pids.writer), false, 'the restart\'s same-group writer still runs');
    assert.equal(alive(pids.daemon), true, 'the detached daemon the restart started was signalled');
});
