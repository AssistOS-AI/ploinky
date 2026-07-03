import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const ploinkyBin = path.join(repoRoot, 'bin', 'ploinky');
const bootRepos = ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents'];

function createWorkspace(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-cli-exit-'));
    for (const repoName of bootRepos) {
        fs.mkdirSync(path.join(workspace, '.ploinky', 'repos', repoName), { recursive: true });
    }
    t.after(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return workspace;
}

function runPloinky(t, args) {
    const workspace = createWorkspace(t);
    return spawnSync(ploinkyBin, args, {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '5'.repeat(64),
        },
    });
}

test('one-shot enable agent failure exits nonzero', (t) => {
    const result = runPloinky(t, ['enable', 'agent', 'nonexistent-agent-xyz']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Agent 'nonexistent-agent-xyz' not found/);
});

test('one-shot start failure exits nonzero', (t) => {
    const result = runPloinky(t, ['start', 'demo', '18080']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Agent 'demo' not found/);
});

test('one-shot start without initial configuration exits nonzero', (t) => {
    const result = runPloinky(t, ['start']);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /missing static agent or port/);
});
