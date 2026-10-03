// `enable agent demo as demo2` followed by `enable agent demo` leaves the alias
// record first in the registry. The canonical instance must still resolve its
// own data directory, never the alias instance's.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    CONTAINER,
    driveWiring,
    registration,
    stepValue,
    wiringWorkspace,
} from './dependencyStoreWiringHarness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const COMMON_URL = pathToFileURL(path.join(ROOT, 'cli/sandbox/docker/common.js')).href;
const SHIM = path.join(HERE, 'dependencyStoreBwrapHostShim.mjs');
const MANIFEST = { 'lite-sandbox': true, start: 'node index.js', network: { mode: 'host' }, readiness: { protocol: 'none' } };

function record(overrides = {}) {
    return { type: 'agent', repoName: 'repo', agentName: 'demo', runMode: 'isolated', profile: 'default', ...overrides };
}

function resolveProjectPaths(agents, staticAgent = '') {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alias-first-')));
    try {
        fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
        fs.writeFileSync(path.join(root, '.ploinky', 'agents.json'), JSON.stringify({
            ...(staticAgent ? { _config: { static: { agent: staticAgent } } } : {}),
            ...agents,
        }));
        const script = `
            const { getConfiguredProjectPath } = await import(${JSON.stringify(COMMON_URL)});
            console.log(JSON.stringify({
                canonical: getConfiguredProjectPath('demo', 'repo'),
                canonicalExplicit: getConfiguredProjectPath('demo', 'repo', undefined),
                alias: getConfiguredProjectPath('demo', 'repo', 'demo2'),
            }));
        `;
        const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
            cwd: root,
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root },
            encoding: 'utf8',
        });
        assert.equal(run.status, 0, run.stderr);
        return { root, ...JSON.parse(run.stdout.trim().split('\n').at(-1)) };
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('getConfiguredProjectPath without an alias skips alias records registered first', () => {
    const result = resolveProjectPaths({
        ploinky_repo_demo2: record({ alias: 'demo2', instanceId: 'a' }),
        ploinky_repo_demo: record({ instanceId: 'b' }),
    });
    assert.equal(result.canonical, path.join(result.root, '.data', 'demo'));
    assert.equal(result.canonicalExplicit, path.join(result.root, '.data', 'demo'));
    assert.equal(result.alias, path.join(result.root, '.data', 'demo2'));
});

test('getConfiguredProjectPath keeps the canonical record when the alias comes second', () => {
    const result = resolveProjectPaths({
        ploinky_repo_demo: record({ instanceId: 'b' }),
        ploinky_repo_demo2: record({ alias: 'demo2', instanceId: 'a' }),
    });
    assert.equal(result.canonical, path.join(result.root, '.data', 'demo'));
    assert.equal(result.alias, path.join(result.root, '.data', 'demo2'));
});

test('getConfiguredProjectPath does not hand an alias-only agent the alias home as canonical', () => {
    const result = resolveProjectPaths({
        ploinky_repo_demo2: record({ alias: 'demo2', instanceId: 'a' }),
    });
    assert.equal(result.canonical, path.join(result.root, '.data', 'demo'));
    assert.equal(result.alias, path.join(result.root, '.data', 'demo2'));
});

test('getConfiguredProjectPath still gives the static agent the workspace root', () => {
    const result = resolveProjectPaths({
        ploinky_repo_demo2: record({ alias: 'demo2', instanceId: 'a' }),
        ploinky_repo_demo: record({ instanceId: 'b' }),
    }, 'demo');
    assert.equal(result.canonical, result.root);
});

function readLaunches(log) {
    if (!fs.existsSync(log)) return [];
    return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; } // a line still being written
    });
}

async function waitForLaunches(log, pid, { timeoutMs = 15_000, intervalMs = 25 } = {}) {
    assert.ok(Number.isInteger(pid) && pid > 0, `the start returned a pid (${pid})`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const launches = readLaunches(log);
        if (launches.some(entry => entry.pid === pid)) return launches;
        if (Date.now() >= deadline) {
            assert.fail(`no launch record for pid ${pid} in ${log} within ${timeoutMs} ms (saw ${JSON.stringify(launches.map(entry => entry.pid))})`);
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

function bindSources(args, target) {
    const sources = [];
    for (let index = 0; index < args.length - 2; index += 1) {
        if (/^--(ro-)?bind$/.test(args[index]) && args[index + 2] === target) sources.push(args[index + 1]);
    }
    return sources;
}

// Starts the canonical instance, registered after an alias instance of the
// same agent, from a prepared record carrying `projectPath(workspace)`. (A
// prepared start rejects a record whose projectPath changes after preparation.)
async function startCanonical(t, projectPath) {
    const w = wiringWorkspace(t, { runtime: 'bwrap', manifest: MANIFEST, packageJson: null, prefix: 'bwrap-alias-first-' });
    const log = path.join(w.root, 'fake-bwrap-launches.jsonl');
    const fake = path.join(w.root, 'fake-bwrap');
    fs.writeFileSync(fake, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
setTimeout(() => {}, 60000);
`, { mode: 0o755 });
    t.after(() => {
        for (const entry of readLaunches(log)) {
            try { process.kill(entry.pid, 'SIGKILL'); } catch { /* gone */ }
        }
    });
    const home = path.join(w.ws, '.data', 'demo');
    const aliasHome = path.join(w.ws, '.data', 'demo2');
    const steps = driveWiring(w, [
        { action: 'init-edge' },
        // The alias instance was enabled first, then the canonical one.
        { action: 'register', containerName: 'ploinky_repo_demo2', record: registration({
            alias: 'demo2', instanceId: 'inst-alias', enableGeneration: 'gen-alias', projectPath: aliasHome,
        }) },
        { action: 'register', containerName: CONTAINER, record: registration({ projectPath: projectPath(w), runtime: 'bwrap' }) },
        { label: 'start', action: 'bwrap-ensure', containerName: CONTAINER, options: { preservePreparedRegistryRecord: true } },
    ], { nodeArgs: ['--import', SHIM], env: { FAKE_BWRAP: fake } });
    const started = stepValue(steps, 'start');
    // The launcher can prove liveness before the fake process has run its
    // first line, so wait (bounded) for the launch record of the pid the
    // start returned instead of reading the log immediately.
    const launches = await waitForLaunches(log, started.pid);
    assert.equal(launches.length, 1);
    const agents = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'));
    return { w, home, aliasHome, started, argv: launches[0].argv, recorded: agents[CONTAINER].projectPath };
}

function setenv(argv, name) {
    const index = argv.findIndex((value, at) => value === name && argv[at - 1] === '--setenv');
    return index < 0 ? undefined : argv[index + 1];
}

test('bwrap start of the canonical instance mounts its own home', async (t) => {
    const { home, aliasHome, started, argv, recorded } = await startCanonical(t, (w) => path.join(w.ws, '.data', 'demo'));
    assert.deepEqual(bindSources(argv, '/root'), [home], 'the canonical home is the only /root bind');
    assert.equal(argv.includes(aliasHome), false, 'the alias instance data is never mounted');
    assert.equal(started.runtime, 'bwrap');
    assert.equal(recorded, home, 'the recorded project is the canonical home');
    assert.equal(setenv(argv, 'HOME'), '/root');
});

// The registry lookup alone would answer `.data/demo` here (no static agent is
// configured), so only honouring the prepared record yields the workspace.
test('bwrap start uses the prepared record\'s project path over the registry lookup', async (t) => {
    const { w, home, argv, recorded } = await startCanonical(t, (workspace) => workspace.ws);
    assert.deepEqual(bindSources(argv, '/root'), [w.ws], 'the prepared project is mounted at /root');
    assert.deepEqual(bindSources(argv, '/home/agent'), [home], 'the home moves to /home/agent');
    assert.equal(setenv(argv, 'HOME'), '/home/agent');
    assert.equal(recorded, w.ws, 'the recorded project is the prepared one');
});
