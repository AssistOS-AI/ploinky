// Behavioral no-wait adoption proof: the real no-wait worker process
// (cli/commands/noWaitWorker.js, spawned with the exact argv workspace start
// uses) runs its capture/ensure lifecycle against a temporary workspace whose
// ready podman host-network runtime was admitted through the real start path
// with the fake engine on PATH. Adoption must require the admitted dependency
// generation to still be the desired one.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    CONTAINER,
    driveWiring,
    registration,
    stepValue,
    wiringWorkspace,
} from './dependencyStoreWiringHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.resolve(HERE, '../../cli/commands/noWaitWorker.js');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const MANIFEST = { container: 'node:20', start: 'node index.js', network: { mode: 'host' }, profiles: { default: { openPorts: [`${PORT}:${PORT}`] } }, readiness: { protocol: 'none' } };

function readyHostRuntime(t) {
    const w = wiringWorkspace(t, { manifest: MANIFEST, prefix: 'depstore-nowait-' });
    const first = stepValue(driveWiring(w, [
        { action: 'init-edge' },
        { action: 'set-router-port', port: 8080 },
        { action: 'register', containerName: CONTAINER, record: { ...registration(), projectPath: path.join(w.ws, '.data', 'demo') } },
        { action: 'prepare-lease' },
        { label: 'first', action: 'ensure-with-lease', containerName: CONTAINER, startPath: true, activate: true, hostRouter: true },
    ]), 'first');
    return { w, first };
}

function runWorker(w, { forceRecreate = false } = {}) {
    const agents = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'));
    const record = agents[CONTAINER];
    const runId = crypto.randomUUID();
    const statusDir = path.join(w.ws, '.ploinky', 'running', 'no-wait');
    fs.mkdirSync(statusDir, { recursive: true });
    const statusFile = path.join(statusDir, `${CONTAINER}.${runId}.json`);
    const agentPath = path.join(w.ws, '.ploinky', 'repos', 'repo', 'demo');
    const args = [
        WORKER,
        '--container', CONTAINER,
        '--instance-id', record.instanceId,
        '--enable-generation', record.enableGeneration,
        '--short-agent', 'demo',
        '--repo', 'repo',
        '--alias', '',
        '--manifest-path', path.join(agentPath, 'manifest.json'),
        '--agent-path', agentPath,
        '--route-key', 'demo',
        '--run-id', runId,
        '--run-started-at-ms', String(Date.now()),
        '--wave-index', '0',
        '--status-file', statusFile,
        '--wait-for-statuses', '[]',
        ...(record.profile ? ['--profile', record.profile] : []),
        ...(forceRecreate ? ['--force-recreate', '1'] : []),
    ];
    const run = spawnSync(process.execPath, args, {
        cwd: w.ws,
        env: { ...w.env, PLOINKY_NO_WAIT_EDGE_TIMEOUT_MS: '5000', PLOINKY_NO_WAIT_LIFECYCLE_LEASE_TIMEOUT_MS: '20000' },
        encoding: 'utf8',
        timeout: 120_000,
    });
    const status = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : null;
    return { run, status, output: `${run.stdout}\n${run.stderr}` };
}

test('dependency store wiring (no-wait): an unchanged ready runtime is adopted, a stale dependency generation is never adopted', (t) => {
    const { w, first } = readyHostRuntime(t);
    assert.equal(first.dependencies.mode, 'store');
    const route = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'routing.json'), 'utf8')).routes.demo;
    assert.equal(route.hostPort, PORT, 'the ready host-network runtime publishes its private host port');
    const installsBefore = w.engine.state().installs.length;
    const containersBefore = Object.values(w.engine.state().containers).map((c) => c.Id);

    // Positive control: the worker reaches capture and adopts the unchanged runtime.
    const unchanged = runWorker(w);
    assert.equal(unchanged.run.status, 0, unchanged.output);
    assert.equal(unchanged.status?.state, 'running', unchanged.output);
    assert.equal(unchanged.status?.adopted, true, 'the unchanged ready runtime is adopted without ensure');
    assert.equal(w.engine.state().installs.length, installsBefore);
    assert.deepEqual(Object.values(w.engine.state().containers).map((c) => c.Id), containersBefore);

    // The package changes; the ready runtime still mounts the old generation.
    fs.writeFileSync(path.join(w.agentDir, 'code', 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.1' } }));
    const stale = runWorker(w);
    assert.ok(stale.status, stale.output);
    assert.notEqual(stale.status.adopted, true, `a stale dependency generation must never be adopted: ${stale.output}`);
    // Not adopted means capture required ensure: the host-network replacement
    // path then (correctly) refuses to replace a published target in place,
    // so the stale runtime is left untouched and the run fails closed.
    assert.equal(stale.status.state, 'failed', stale.output);
    assert.match(stale.status.error.message, /requires one exact target-less staged route for 'demo'/);
    assert.match(stale.status.error.stack, /launchNoWaitHostRuntime/, 'the failure comes from the ensure (replacement) path');
    const record = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'))[CONTAINER];
    assert.equal(record.dependencies.objectId, first.dependencies.objectId, 'the admitted record is not rewritten');
    assert.deepEqual(Object.values(w.engine.state().containers).map((c) => c.Id), containersBefore);
});
