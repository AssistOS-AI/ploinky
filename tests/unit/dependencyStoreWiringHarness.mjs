// Shared harness for the dependency store runtime-wiring tests (not a test
// file): a temporary workspace with one agent source, the stateful fake
// engine on PATH, and a child-process driver running production entry points.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installFakeEngine } from './dependencyStoreFakeEngine.mjs';
import { tempRoot } from './dependencyStoreFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WIRING_DRIVER = path.join(HERE, 'dependencyStoreWiringDriver.mjs');
export const CONTAINER = 'ploinky_repo_demo';

export function wiringWorkspace(t, {
    runtime = 'podman',
    manifest = null,
    packageJson = { name: 'demo', dependencies: { 'left-pad': '1.3.0' } },
    prefix = 'depstore-wiring-',
} = {}) {
    const root = tempRoot(t, prefix);
    const ws = path.join(root, 'ws');
    const agentDir = path.join(ws, '.ploinky', 'repos', 'repo', 'demo');
    fs.mkdirSync(path.join(agentDir, 'code'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.ploinky', 'data'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.ploinky', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest || {
        container: 'node:20', start: 'node index.js', network: { mode: 'none' }, readiness: { protocol: 'none' },
    }));
    fs.writeFileSync(path.join(agentDir, 'code', 'index.js'), 'console.log(1)\n');
    if (packageJson) fs.writeFileSync(path.join(agentDir, 'code', 'package.json'), JSON.stringify(packageJson));
    const engine = installFakeEngine(root, { engines: [runtime] });
    const env = {
        ...process.env,
        ...engine.env,
        PLOINKY_WORKSPACE_ROOT: ws,
        PLOINKY_ROOT: ws,
        CONTAINER_RUNTIME: runtime,
        HOME: path.join(root, 'home'),
        PLOINKY_AGENTLIB_FINGERPRINT: 'fixture-fingerprint',
        PLOINKY_AGENTLIB_MODE: 'local',
        PLOINKY_AGENTLIB_SOURCE_ID: 'd'.repeat(64),
    };
    return { root, ws, agentDir, engine, env };
}

export function driveWiring(w, steps, { refresh = null, env = {}, driver = WIRING_DRIVER, nodeArgs = [] } = {}) {
    const out = path.join(w.root, `out-${crypto.randomUUID()}.json`);
    const config = path.join(w.root, `config-${crypto.randomUUID()}.json`);
    fs.writeFileSync(config, JSON.stringify({ steps, out, refresh }));
    const run = spawnSync(process.execPath, [...nodeArgs, driver, config], {
        cwd: w.ws,
        env: { ...w.env, ...env, ...(process.env.DEPENDENCY_STORE_DEBUG ? { PLOINKY_DEBUG: '1' } : {}) },
        encoding: 'utf8',
        timeout: 120_000,
    });
    if (process.env.DEPENDENCY_STORE_DEBUG) console.log(run.stdout, run.stderr);
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    return Object.fromEntries(JSON.parse(fs.readFileSync(out, 'utf8')).map((entry) => [entry.step, entry]));
}

export function stepValue(steps, name) {
    assert.equal(steps[name]?.ok, true, `${name}: ${JSON.stringify(steps[name])}`);
    return steps[name].value;
}

export function registration(overrides = {}) {
    return {
        type: 'agent', repoName: 'repo', agentName: 'demo', runMode: 'isolated', profile: 'default',
        instanceId: 'inst-1', enableGeneration: 'gen-1', ...overrides,
    };
}

export function storeDir(w) {
    return path.join(w.ws, '.ploinky', 'deps', 'store');
}

export function readerReceiptsDir(w) {
    return path.join(storeDir(w), 'receipts', 'readers');
}

/** Payload bytes of one published object, for immutability comparisons. */
export function payloadSnapshot(dependencies) {
    const files = {};
    const walk = (dir, rel = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            const key = path.posix.join(rel, entry.name);
            if (entry.isSymbolicLink()) files[key] = `link:${fs.readlinkSync(full)}`;
            else if (entry.isDirectory()) walk(full, key);
            else files[key] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        }
    };
    walk(dependencies.payloadPath);
    return files;
}
