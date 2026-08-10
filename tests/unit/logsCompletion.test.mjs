import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The completer resolves the registry through PLOINKY_WORKSPACE_ROOT, which
// `utils/config.js` reads once at import time, so the workspace has to exist
// before `main.js` is loaded.
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-logs-completion-'));
fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, '.ploinky', 'agents.json'), JSON.stringify({
    _config: { static: { agent: 'demo/shared' } },
    blue_container: { type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'blue' },
    green_container: { type: 'agent', repoName: 'demo', agentName: 'shared', alias: 'green' },
    solo_container: { type: 'agent', repoName: 'demo', agentName: 'solo' },
    reserved_container: { type: 'agent', repoName: 'demo', agentName: 'gateway', alias: 'router' },
}));
process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
process.on('exit', () => {
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch (_) {}
});

const { completer, enabledAgentLogTargets } = await import('../../cli/main.js');

function hits(line) {
    return completer(line)[0];
}

test('log targets offer Router and one preferred usable reference per agent', () => {
    const targets = enabledAgentLogTargets();
    assert.equal(targets[0], 'router');
    // Aliases win when present; otherwise the qualified spelling is preferred.
    assert.ok(targets.includes('blue'));
    assert.ok(targets.includes('green'));
    assert.ok(targets.includes('demo/solo'));
    assert.equal(targets.includes('solo'), false);
    assert.ok(targets.includes('demo/gateway'));
});

test('an ambiguous qualified name or bare name is never offered', () => {
    const targets = enabledAgentLogTargets();
    // `demo/shared` maps to two records, so it would fail if suggested.
    assert.equal(targets.includes('demo/shared'), false);
    assert.equal(targets.includes('shared'), false);
    assert.equal(targets.includes('_config'), false);
});

test('the reserved router spelling is offered once, for Router logs only', () => {
    const targets = enabledAgentLogTargets();
    // The agent aliased `router` is reachable by its qualified name, and the
    // bare spelling appears exactly once -- as the reserved Router target.
    assert.equal(targets.filter((value) => value === 'router').length, 1);
    assert.ok(targets.includes('demo/gateway'));
});

test('logs tail completes Router and agent targets', () => {
    const completions = hits('logs tail ');
    assert.ok(completions.includes('router'));
    assert.ok(completions.includes('blue'));
    assert.ok(completions.includes('demo/solo'));

    // A typed prefix narrows the same set.
    assert.deepEqual(hits('logs tail gr'), ['green']);
    assert.deepEqual(hits('logs tail demo/s'), ['demo/solo']);
});

test('logs last completes a target in both the count and no-count positions', () => {
    // No count typed yet: the first positional may be the target.
    assert.ok(hits('logs last ').includes('blue'));
    assert.deepEqual(hits('logs last gr'), ['green']);

    // A count was given, so the target belongs in the next position.
    assert.ok(hits('logs last 200 ').includes('blue'));
    assert.deepEqual(hits('logs last 200 gr'), ['green']);
});

test('logs last stops offering targets once one is already given', () => {
    assert.deepEqual(hits('logs last 200 blue '), []);
    assert.deepEqual(hits('logs last blue '), []);
});

test('logs tail stops offering targets once one is already given', () => {
    assert.deepEqual(hits('logs tail blue '), []);
});
