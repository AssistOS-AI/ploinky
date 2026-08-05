import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const INITIALIZER = path.join(ROOT, 'ploinky-box', 'entrypoint', 'initialize-edge-routing.mjs');

function workspaceFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-edge-initialize-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function runInitializer(root) {
    return spawnSync(process.execPath, [INITIALIZER], {
        encoding: 'utf8',
        env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root },
    });
}

function edgeSources(root) {
    return {
        routing: path.join(root, '.ploinky', 'routing.json'),
        agents: path.join(root, '.ploinky', 'agents.json'),
        policy: path.join(root, '.ploinky', 'data', 'router-security', 'policy-state.json'),
        desired: path.join(root, '.ploinky', 'data', 'edge-routing', 'desired.json'),
    };
}

test('Box edge initializer creates the complete first-boot baseline and remains idempotent', (t) => {
    const root = workspaceFixture(t);
    const sources = edgeSources(root);

    const first = runInitializer(root);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /baseline initialized/);
    assert.deepEqual(JSON.parse(fs.readFileSync(sources.routing, 'utf8')), { routes: {} });
    assert.deepEqual(JSON.parse(fs.readFileSync(sources.agents, 'utf8')), {});
    assert.deepEqual(JSON.parse(fs.readFileSync(sources.policy, 'utf8')), {
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(sources.desired, 'utf8')), { hosts: {} });

    const before = Object.fromEntries(
        Object.entries(sources).map(([name, file]) => [name, fs.readFileSync(file)]),
    );
    const second = runInitializer(root);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /baseline already complete/);
    for (const [name, file] of Object.entries(sources)) {
        assert.deepEqual(fs.readFileSync(file), before[name], `${name} changed on idempotent rerun`);
    }
});

test('Box edge initializer rejects partial state without replacing existing authority', (t) => {
    const root = workspaceFixture(t);
    const sources = edgeSources(root);
    const desired = Buffer.from(JSON.stringify({ hosts: { existing: { routes: [] } } }));
    fs.mkdirSync(path.dirname(sources.desired), { recursive: true });
    fs.writeFileSync(sources.desired, desired, { mode: 0o600 });

    const result = runInitializer(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EDGE ROUTING BASELINE FAILED: edge routing sources are incomplete/);
    assert.match(result.stderr, /missing routing\.json, agents\.json, policy-state\.json/);
    assert.deepEqual(fs.readFileSync(sources.desired), desired);
    assert.equal(fs.existsSync(sources.routing), false);
    assert.equal(fs.existsSync(sources.agents), false);
    assert.equal(fs.existsSync(sources.policy), false);
});
