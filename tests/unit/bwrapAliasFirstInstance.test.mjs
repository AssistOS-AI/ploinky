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

function bindSources(args, target) {
    const sources = [];
    for (let index = 0; index < args.length - 2; index += 1) {
        if (/^--(ro-)?bind$/.test(args[index]) && args[index + 2] === target) sources.push(args[index + 1]);
    }
    return sources;
}

// The prepared record names the project and is used as is, like containers.
// (The registry lookup itself is covered above; a prepared start rejects a
// record whose projectPath changes after preparation.)
{
    test('bwrap start of the canonical instance mounts its own home', (t) => {
        const w = wiringWorkspace(t, { runtime: 'bwrap', manifest: MANIFEST, packageJson: null, prefix: 'bwrap-alias-first-' });
        const log = path.join(w.root, 'fake-bwrap-launches.jsonl');
        const fake = path.join(w.root, 'fake-bwrap');
        fs.writeFileSync(fake, `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + '\\n');
setTimeout(() => {}, 60000);
`, { mode: 0o755 });
        t.after(() => {
            if (!fs.existsSync(log)) return;
            for (const line of fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)) {
                try { process.kill(JSON.parse(line).pid, 'SIGKILL'); } catch { /* gone */ }
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
            { action: 'register', containerName: CONTAINER, record: registration({ projectPath: home, runtime: 'bwrap' }) },
            { label: 'start', action: 'bwrap-ensure', containerName: CONTAINER, options: { preservePreparedRegistryRecord: true } },
        ], { nodeArgs: ['--import', SHIM], env: { FAKE_BWRAP: fake } });
        const started = stepValue(steps, 'start');
        const launches = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        assert.equal(launches.length, 1);
        const argv = launches[0].argv;
        assert.deepEqual(bindSources(argv, '/root'), [home], 'the canonical home is the only /root bind');
        assert.equal(argv.includes(aliasHome), false, 'the alias instance data is never mounted');
        assert.equal(started.runtime, 'bwrap');
        const agents = JSON.parse(fs.readFileSync(path.join(w.ws, '.ploinky', 'agents.json'), 'utf8'));
        assert.equal(agents[CONTAINER].projectPath, home, 'the recorded project is the canonical home');
        assert.equal(argv[argv.indexOf('HOME') - 1], '--setenv');
        assert.equal(argv[argv.indexOf('HOME') + 1], '/root');
    });
}
