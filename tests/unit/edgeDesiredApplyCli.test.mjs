import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cliEntry = path.join(repoRoot, 'cli', 'index.js');
const bootRepos = ['basic', 'AchillesIDE', 'AchillesCLI', 'copilot-agents'];

function createWorkspace(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-edge-cli-'));
    const ploinky = path.join(workspace, '.ploinky');
    for (const repoName of bootRepos) {
        fs.mkdirSync(path.join(ploinky, 'repos', repoName), { recursive: true });
    }
    fs.writeFileSync(path.join(ploinky, 'routing.json'), JSON.stringify({
        static: { agent: '', port: 8080 },
        routes: {},
    }));
    fs.writeFileSync(path.join(ploinky, 'agents.json'), '{}');
    fs.mkdirSync(path.join(ploinky, 'data', 'router-security'), { recursive: true });
    fs.writeFileSync(
        path.join(ploinky, 'data', 'router-security', 'policy-state.json'),
        JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }),
    );
    fs.mkdirSync(path.join(ploinky, 'data', 'edge-routing'), { recursive: true });
    fs.writeFileSync(path.join(ploinky, 'data', 'edge-routing', 'desired.json'), JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: { hostNetworkAllowedInstances: [], internalServiceConsumers: {} },
    }));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    return workspace;
}

function runCli(workspace, args) {
    return spawnSync(process.execPath, [cliEntry, ...args], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
            ...process.env,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_MASTER_KEY: '6'.repeat(64),
        },
    });
}

test('edge apply is the single strict CLI path and activates exact staged bytes', (t) => {
    const workspace = createWorkspace(t);
    const candidate = path.join(workspace, 'desired.json');
    const bytes = Buffer.from(`${JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: {
            hostNetworkAllowedInstances: [],
            internalServiceConsumers: {},
        },
    }, null, 2)}\n`);
    fs.writeFileSync(candidate, bytes);

    for (const args of [['edge'], ['edge', 'publish', candidate], ['edge', 'apply', candidate, '--force']]) {
        const rejected = runCli(workspace, args);
        assert.notEqual(rejected.status, 0, `${args.join(' ')} unexpectedly succeeded`);
        assert.match(`${rejected.stdout}\n${rejected.stderr}`, /Usage: edge apply <json-file>/);
    }

    const result = runCli(workspace, ['edge', 'apply', candidate]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Edge desired state active: sha256:[a-f0-9]{64} \(local-ready\)/);
    const edgeDir = path.join(workspace, '.ploinky', 'data', 'edge-routing');
    assert.equal(fs.readFileSync(path.join(edgeDir, 'desired.json')).equals(bytes), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(edgeDir, 'active.json'), 'utf8')).state, 'active');
});

test('CLI invalid candidate persists the failed staging input and leaves no active fallback', (t) => {
    const workspace = createWorkspace(t);
    const candidate = path.join(workspace, 'desired.json');
    fs.writeFileSync(candidate, JSON.stringify({
        schemaVersion: 1,
        hosts: {},
        security: { hostNetworkAllowedInstances: [], internalServiceConsumers: {} },
    }));
    const baseline = runCli(workspace, ['edge', 'apply', candidate]);
    assert.equal(baseline.status, 0, `${baseline.stdout}\n${baseline.stderr}`);

    const invalidBytes = Buffer.from('{"schemaVersion":1,"hosts":');
    fs.writeFileSync(candidate, invalidBytes);
    const failed = runCli(workspace, ['edge', 'apply', candidate]);
    assert.notEqual(failed.status, 0);
    assert.match(`${failed.stdout}\n${failed.stderr}`, /not valid JSON/);

    const edgeDir = path.join(workspace, '.ploinky', 'data', 'edge-routing');
    assert.equal(fs.readFileSync(path.join(edgeDir, 'desired.json')).equals(invalidBytes), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(edgeDir, 'active.json'), 'utf8')).state, 'inactive');
});
