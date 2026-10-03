// The post-admission collector with its PRODUCTION defaults: the real
// registry file, edge selector, workspace lease, default receipt proofs and
// engine inspector, run in a child process against a temporary workspace and
// a fake engine at the process boundary (a `podman` executable on PATH).
// Test-supplied stand-ins for inspectMounts/loadAgents/readEdgeState are not
// used anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';
import { tempRoot } from './dependencyStoreFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, 'dependencyStoreCollectorDriver.mjs');
const LIVE_ID = 'a'.repeat(64);

// A `podman` in front of the fake engine that can simulate an engine that is
// down or whose listing and inspection disagree (a container listed by `ps`
// that `inspect` cannot report).
const WRAPPER = `#!/bin/sh
mode=$(cat "$WRAP_MODE_FILE" 2>/dev/null)
if [ "$mode" = down ]; then echo "Error: cannot connect to the engine" >&2; exit 125; fi
if [ "$mode" = phantom ] && [ "$1" = ps ]; then "$REAL_PODMAN" "$@"; status=$?; echo phantom0000; exit $status; fi
exec "$REAL_PODMAN" "$@"
`;

function workspace(t, { engine: withEngine = true } = {}) {
    const root = tempRoot(t, 'depstore-gc-defaults-');
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.ploinky'), { recursive: true });
    const engine = installFakeEngine(root, { engines: ['podman'] });
    const wrapDir = path.join(root, 'wrap-bin');
    fs.mkdirSync(wrapDir);
    fs.writeFileSync(path.join(wrapDir, 'podman'), WRAPPER, { mode: 0o755 });
    const modeFile = path.join(root, 'engine-mode');
    const enginePath = [wrapDir, engine.env.PATH].join(path.delimiter);
    const bareDirs = String(process.env.PATH || '').split(path.delimiter).filter((dir) => dir
        && !['podman', 'docker'].some((name) => fs.existsSync(path.join(dir, name))));
    const env = {
        ...process.env,
        ...engine.env,
        PATH: withEngine ? enginePath : [path.dirname(process.execPath), ...bareDirs].join(path.delimiter),
        REAL_PODMAN: path.join(engine.binDir, 'podman'),
        WRAP_MODE_FILE: modeFile,
        PLOINKY_WORKSPACE_ROOT: ws,
        PLOINKY_ROOT: ws,
        HOME: path.join(root, 'home'),
    };
    delete env.CONTAINER_RUNTIME;
    return { root, ws, engine, env, modeFile, agentsFile: path.join(ws, '.ploinky', 'agents.json') };
}

function drive(w, steps) {
    const out = path.join(w.root, `out-${crypto.randomUUID()}.json`);
    const config = path.join(w.root, `config-${crypto.randomUUID()}.json`);
    fs.writeFileSync(config, JSON.stringify({ steps, out }));
    const run = spawnSync(process.execPath, [DRIVER, config], { cwd: w.ws, env: w.env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, `driver exited ${run.status}\n${run.stdout}\n${run.stderr}`);
    const results = JSON.parse(fs.readFileSync(out, 'utf8'));
    for (const entry of results) assert.equal(entry.ok, true, `${entry.step}: ${entry.error}`);
    return Object.fromEntries(results.map((entry) => [entry.step, entry.value]));
}

function setMode(w, mode) {
    fs.writeFileSync(w.modeFile, mode);
}

function retainedReasons(report) {
    return new Map(report.retained.map((item) => [item.objectId, item.reasons]));
}

test('dependency store collection with production defaults retains live readers, reclaims retired ones, and skips on uncertain engine evidence', (t) => {
    const w = workspace(t);
    setMode(w, 'normal');
    const built = drive(w, [
        { action: 'init-edge' },
        { label: 'edge', action: 'activate-edge' },
        {
            label: 'live', action: 'build', registration: 'ploinky_repo_live',
            consumer: { kind: 'container', key: 'container:live', engine: 'podman', containerName: 'ploinky_repo_live', containerId: LIVE_ID, phase: 'created' },
        },
        {
            // A launcher that never settled its container creation: the
            // receipt stays in `creating` without a container ID.
            label: 'stuck', action: 'build', registration: 'ploinky_repo_stuck',
            consumer: { kind: 'container', key: 'container:stuck', engine: 'podman', containerName: 'ploinky_repo_stuck', phase: 'creating' },
        },
    ]);
    assert.deepEqual(built.edge, { selector: 'active', preparationOutstanding: false });
    const live = built.live;
    const stuck = built.stuck;
    // The admitted runtime: its registry record and its actual container.
    const agents = JSON.parse(fs.readFileSync(w.agentsFile, 'utf8'));
    agents.ploinky_repo_live = {
        type: 'agent', runtime: 'podman', containerName: 'ploinky_repo_live', containerId: LIVE_ID,
        dependencies: {
            schema: 1, mode: 'store', objectId: live.objectId, inputKey: live.inputKey, generationId: live.generationId,
            payloadPath: live.payloadPath, nodeModulesPath: live.nodeModulesPath,
        },
        config: { binds: [{ source: live.nodeModulesPath, target: '/code/node_modules', ro: true }] },
    };
    fs.writeFileSync(w.agentsFile, JSON.stringify(agents, null, 2));
    fs.writeFileSync(w.engine.stateFile, JSON.stringify({ installs: [], containers: {
        ploinky_repo_live: {
            Id: LIVE_ID, Name: 'ploinky_repo_live', Labels: {}, State: { Running: true },
            Mounts: [{ Type: 'bind', Source: live.nodeModulesPath, Destination: '/code/node_modules', RW: false }],
        },
        // An unrelated container that stays, so a phantom listing entry makes
        // inspection incomplete rather than empty.
        bystander: { Id: 'e'.repeat(64), Name: 'bystander', Labels: {}, State: { Running: false }, Mounts: [] },
    } }));

    // (a) An active reader is retained and its path still opens and hashes.
    const first = drive(w, [
        { label: 'collect', action: 'collect' },
        { label: 'open', action: 'open', objectId: live.objectId, inputKey: live.inputKey, nodeModulesPath: live.nodeModulesPath },
    ]);
    assert.equal(first.collect.skipped, null, JSON.stringify(first.collect));
    assert.deepEqual(first.collect.removed, []);
    assert.deepEqual(retainedReasons(first.collect).get(live.objectId),
        ['admitted-record', 'container-mount', 'reader:container', 'registry-bind']);
    assert.deepEqual(retainedReasons(first.collect).get(stuck.objectId), ['reader:container'],
        'a reservation whose container creation never settled is retained');
    assert.equal(first.open.bytes, 'module.exports = "left-pad:m1";\n');
    assert.equal(first.open.treeMatches, true);
    assert.equal(first.open.validation, 'ok');

    // Positively retire the reader: registry record gone, engine removes it.
    delete agents.ploinky_repo_live;
    fs.writeFileSync(w.agentsFile, JSON.stringify(agents, null, 2));
    const removed = spawnSync(path.join(w.engine.binDir, 'podman'), ['rm', '-f', LIVE_ID], { env: w.env, encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stderr);
    const inspected = spawnSync(path.join(w.engine.binDir, 'podman'), ['container', 'inspect', '--format', '{{.Id}}', LIVE_ID], { env: w.env, encoding: 'utf8' });
    assert.notEqual(inspected.status, 0, 'the engine reports the retired container absent');

    // (c) Uncertain engine evidence skips the whole run, even for the retired object.
    setMode(w, 'down');
    const down = drive(w, [{ label: 'collect', action: 'collect' }]).collect;
    assert.match(down.skipped, /^container engine unavailable: engine listing failed/);
    setMode(w, 'phantom');
    const phantom = drive(w, [{ label: 'collect', action: 'collect' }]).collect;
    assert.match(phantom.skipped, /^container engine unavailable: engine inspection was incomplete/);
    for (const report of [down, phantom]) assert.deepEqual(report.removed, []);
    assert.ok(fs.existsSync(live.payloadPath), 'nothing is removed while engine evidence is uncertain');

    // (b) With certain evidence the retired object is actually reclaimed.
    setMode(w, 'normal');
    const after = drive(w, [{ label: 'collect', action: 'collect' }]).collect;
    assert.equal(after.skipped, null, JSON.stringify(after));
    assert.deepEqual(after.removed, [live.objectId]);
    assert.equal(fs.existsSync(path.dirname(live.payloadPath)), false);
    assert.deepEqual(retainedReasons(after).get(stuck.objectId), ['reader:container'], 'the unsettled reservation is still retained');
    assert.ok(fs.existsSync(stuck.payloadPath));
});

test('dependency store collection with production defaults skips, and never exits, when no container engine is installed', (t) => {
    const w = workspace(t, { engine: false });
    const results = drive(w, [
        { action: 'init-edge' },
        { label: 'edge', action: 'activate-edge' },
        {
            label: 'orphan', action: 'build', registration: 'ploinky_repo_orphan',
            consumer: { kind: 'bwrap-service', key: 'bwrap:orphan', containerName: 'ploinky_repo_orphan', process: { pid: 1, processStart: 'x', bootScope: 'y' } },
        },
        { label: 'collect', action: 'collect' },
    ]);
    assert.match(results.collect.skipped, /^container engine unavailable: no container engine/);
    assert.deepEqual(results.collect.removed, []);
    assert.ok(fs.existsSync(results.orphan.payloadPath));
});
