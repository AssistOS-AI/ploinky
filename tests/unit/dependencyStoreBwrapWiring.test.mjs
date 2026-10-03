// Behavioral bwrap reuse proof: the production ensureBwrapService runs in a
// child process against a temporary workspace. The host has no Bubblewrap,
// so the driver runs under dependencyStoreBwrapHostShim.mjs, which redirects
// only bwrapServiceManager.js's spawn of the absolute /usr/bin/bwrap to a
// fake `bwrap` (records its argv, stays alive like a sandbox) and answers its
// /proc/<pid>/status launch check from real liveness when procfs is absent.
// Dependency preparation, the reuse decision, PID records and process
// identity all run unmodified.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CONTAINER,
    driveWiring,
    registration,
    stepValue,
    wiringWorkspace,
} from './dependencyStoreWiringHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.join(HERE, 'dependencyStoreBwrapHostShim.mjs');
const MANIFEST = { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } };

function fakeBwrap(root) {
    const file = path.join(root, 'fake-bwrap');
    const log = path.join(root, 'fake-bwrap-launches.jsonl');
    fs.writeFileSync(file, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
setTimeout(() => {}, 60000);
`, { mode: 0o755 });
    // PIDs are remembered in memory: the temporary root (and this log) is
    // removed by an earlier-registered cleanup hook.
    const pids = new Set();
    return {
        file,
        pids,
        launches() {
            const entries = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
            for (const entry of entries) pids.add(entry.pid);
            return entries;
        },
    };
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function bindsSource(argv, source) {
    for (let i = 0; i < argv.length - 2; i++) {
        if (/^--(ro-)?bind$/.test(argv[i]) && argv[i + 1] === source) return true;
    }
    return false;
}

test('dependency store wiring (bwrap): an unchanged sandbox is reused and a changed dependency generation is replaced exactly once', (t) => {
    const w = wiringWorkspace(t, { manifest: MANIFEST, prefix: 'depstore-bwrap-' });
    const bwrap = fakeBwrap(w.root);
    t.after(() => {
        bwrap.launches();
        for (const pid of bwrap.pids) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
            try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        }
    });
    const drive = (steps) => {
        try {
            return driveWiring(w, steps, { nodeArgs: ['--import', SHIM], env: { FAKE_BWRAP: bwrap.file } });
        } finally {
            bwrap.launches();
        }
    };
    const record = { ...registration(), runtime: 'bwrap', projectPath: path.join(w.ws, '.data', 'demo') };

    const started = drive([
        { action: 'init-edge' },
        { action: 'register', containerName: CONTAINER, record },
        { label: 'first', action: 'bwrap-ensure', containerName: CONTAINER },
        { label: 'unchanged', action: 'bwrap-ensure', containerName: CONTAINER },
    ]);
    const first = stepValue(started, 'first');
    assert.equal(first.runtime, 'bwrap');
    assert.equal(first.dependencies.mode, 'store');
    assert.equal(first.dependencies.family, 'bwrap');
    assert.equal(bwrap.launches().length, 1, 'the first ensure launches one sandbox');
    const [launch1] = bwrap.launches();
    assert.equal(first.pid, launch1.pid);
    assert.ok(bindsSource(launch1.argv, first.dependencies.nodeModulesPath), 'the sandbox binds the admitted payload');
    assert.ok(alive(launch1.pid));

    const unchanged = stepValue(started, 'unchanged');
    assert.equal(unchanged.createdByThisLaunch, false, 'an unchanged sandbox is reused');
    assert.equal(bwrap.launches().length, 1, 'reuse launches nothing');
    assert.deepEqual(unchanged.dependencies, first.dependencies);
    assert.ok(alive(launch1.pid), 'the reused sandbox keeps running');

    fs.writeFileSync(path.join(w.agentDir, 'code', 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.1' } }));
    const changed = drive([
        { label: 'replace', action: 'bwrap-ensure', containerName: CONTAINER },
        { label: 'after-replace', action: 'bwrap-ensure', containerName: CONTAINER },
    ]);
    const replaced = stepValue(changed, 'replace');
    assert.notEqual(replaced.dependencies.objectId, first.dependencies.objectId, 'the replacement uses the new generation');
    assert.deepEqual(replaced.stored, replaced.dependencies);
    const launches = bwrap.launches();
    assert.equal(launches.length, 2, 'a changed dependency generation is replaced exactly once');
    assert.equal(replaced.pid, launches[1].pid);
    assert.ok(bindsSource(launches[1].argv, replaced.dependencies.nodeModulesPath), 'the new sandbox binds the new payload');
    assert.ok(!bindsSource(launches[1].argv, first.dependencies.nodeModulesPath));
    assert.equal(alive(launch1.pid), false, 'the stale sandbox was stopped');

    const settled = stepValue(changed, 'after-replace');
    assert.equal(settled.createdByThisLaunch, false, 'the replacement is then reused');
    assert.equal(bwrap.launches().length, 2);
});
