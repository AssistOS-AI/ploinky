// Lease order for lifecycle commands: the workspace mutation lease is taken
// (or reused) before any maintenance lock, and a briefly held lease is waited
// for instead of failing dependency preparation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tempRoot } from './dependencyStoreFixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const LOCKS = path.join(ROOT, 'cli/utils/runtime/maintenanceLocks.js');

function env(root) {
    return { ...process.env, PLOINKY_WORKSPACE_ROOT: root, PLOINKY_ROOT: root };
}

test('dependency store lease order: a restart-style operation waits for a briefly held lease and never holds its maintenance lock while waiting', { timeout: 60_000 }, async (t) => {
    const root = tempRoot(t, 'depstore-lease-order-');
    fs.mkdirSync(path.join(root, '.ploinky'), { recursive: true });
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `
        const locks = await import(${JSON.stringify(LOCKS)});
        const lease = locks.createWorkspaceMutationLease({ operation: 'no-wait-worker' });
        process.stdout.write('held\\n');
        setTimeout(() => { locks.releaseWorkspaceMutationLease(lease); process.stdout.write('released\\n'); }, 1200);
    `], { env: env(root), stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => { try { holder.kill('SIGKILL'); } catch { /* gone */ } });
    await new Promise((resolve) => holder.stdout.once('data', resolve));

    const maintenanceFile = path.join(root, '.ploinky', 'running', 'maintenance', 'ploinky_repo_demo.json');
    const waiter = spawn(process.execPath, ['--input-type=module', '-e', `
        const locks = await import(${JSON.stringify(LOCKS)});
        const started = Date.now();
        await locks.withHeldOrAcquiredWorkspaceMutationLease({ operation: 'restart:ploinky_repo_demo', retryIntervalMs: 20 }, async (lease) => {
            await locks.withMaintenanceLock('ploinky_repo_demo', { operation: 'restart' }, async () => {
                process.stdout.write(JSON.stringify({ waitedMs: Date.now() - started, held: locks.heldWorkspaceMutationLease() === lease }));
            });
        });
    `], { env: env(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    waiter.stdout.on('data', (chunk) => { output += chunk; });
    waiter.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolve) => waiter.on('exit', resolve));

    // While the lease is held elsewhere, the waiter must not own its maintenance lock.
    const sawMaintenanceWhileWaiting = await new Promise((resolve) => {
        let seen = false;
        const poll = setInterval(() => { if (fs.existsSync(maintenanceFile)) seen = true; }, 20);
        holder.stdout.once('data', () => { clearInterval(poll); resolve(seen); });
    });
    assert.equal(sawMaintenanceWhileWaiting, false, 'no maintenance lock is held while waiting for the workspace lease');
    assert.equal(await exited, 0, stderr);
    const result = JSON.parse(output);
    assert.ok(result.waitedMs >= 500, `waited for the holder (${result.waitedMs}ms) instead of failing`);
    assert.equal(result.held, true, 'dependency preparation inside finds the held lease');
});

test('dependency store lease order: a nested lifecycle call reuses the held lease without waiting', { timeout: 30_000 }, (t) => {
    const root = tempRoot(t, 'depstore-lease-reuse-');
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
        const locks = await import(${JSON.stringify(LOCKS)});
        const out = await locks.withWorkspaceMutationLease({ operation: 'workspace-start' }, async (outer) => {
            const started = Date.now();
            return locks.withHeldOrAcquiredWorkspaceMutationLease({ operation: 'agent-enable', waitTimeoutMs: 5000 }, async (inner) => ({
                same: inner === outer, ms: Date.now() - started,
            }));
        });
        process.stdout.write(JSON.stringify(out));
    `], { env: env(root), encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.equal(out.same, true);
    assert.ok(out.ms < 1000);
});

test('dependency store lease order: restart, enable and reinstall take the workspace lease before any maintenance lock', () => {
    const cli = fs.readFileSync(path.join(ROOT, 'cli/commands/cli.js'), 'utf8');
    assert.match(cli, /function withRestartLocks\(containerName, lockOptions, fn\) \{\s*return withHeldOrAcquiredWorkspaceMutationLease\([\s\S]*?\(\) => withMaintenanceLock\(containerName, lockOptions, fn\)/);
    assert.equal((cli.match(/await withRestartLocks\(containerName, \{/g) || []).length, 3, 'every restart dispatch path');
    assert.equal((cli.match(/withMaintenanceLock\(/g) || []).length, 1, 'no other maintenance lock is taken directly');
    const agents = fs.readFileSync(path.join(ROOT, 'cli/utils/agents.js'), 'utf8');
    const enable = agents.slice(agents.indexOf('export async function enableAgent('));
    assert.match(enable, /^export async function enableAgent\([^)]*\) \{\s*(?:\/\/[^\n]*\n\s*)*return withHeldOrAcquiredWorkspaceMutationLease\(\{ operation: 'agent-enable' \}/);
    const workspace = fs.readFileSync(path.join(ROOT, 'cli/commands/workspaceUtil.js'), 'utf8');
    const reinstall = workspace.slice(workspace.indexOf('async function reinstallAgent('));
    assert.ok(reinstall.indexOf("withWorkspaceMutationLease({ operation: 'reinstall' }") < reinstall.indexOf('withMaintenanceLock(containerName'));
});
