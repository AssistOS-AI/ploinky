import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-fault-hooks-'));
const previous = {
    root: process.env.PLOINKY_WORKSPACE_ROOT,
    router: process.env.PLOINKY_ROUTER_HOST_PORT,
    media: process.env.PLOINKY_MEDIA_HOST_PORT,
};
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
process.env.PLOINKY_MEDIA_HOST_PORT = '17891';

const hooks = await import('../../cli/utils/testFaultHooks.js');
const edge = await import('../../cli/sandbox/edgeGeneration.js');
const routing = await import('../../cli/server/routingFile.js');

test.after(() => {
    for (const [key, value] of [['PLOINKY_WORKSPACE_ROOT', previous.root], ['PLOINKY_ROUTER_HOST_PORT', previous.router], ['PLOINKY_MEDIA_HOST_PORT', previous.media]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function fixtureDir() {
    const ploinkyDir = fs.mkdtempSync(path.join(workspace, 'ws-'));
    const dir = path.join(ploinkyDir, 'test-faults');
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    return { ploinkyDir, dir, file: path.join(dir, 'restart.json') };
}

function write(file, body, mode = 0o644) {
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    fs.chmodSync(file, mode);
}

const ACTIVE = { activation: hooks.TEST_FAULT_HOOKS_ACTIVATION, forceUnprovableWithdrawal: true, forceUnprovableReopen: true, holdInactiveMs: 50 };

function load(ploinkyDir, env = {}) {
    const lines = [];
    const result = hooks.loadRestartFaultHooks({ env, ploinkyDir, warn: (line) => lines.push(line) });
    return { result, lines };
}

test('a present but unmarked fault file is inert and silent', () => {
    const f = fixtureDir();
    write(f.file, { forceUnprovableWithdrawal: true, holdInactiveMs: 1000 });
    const { result, lines } = load(f.ploinkyDir);
    assert.equal(result, null);
    assert.deepEqual(lines, []);
});

test('no file and no setting is inert', () => {
    const f = fixtureDir();
    fs.rmSync(f.dir, { recursive: true });
    assert.deepEqual(load(f.ploinkyDir), { result: null, lines: [] });
});

test('a marked file in the workspace directory activates with one warning naming the hook', () => {
    const f = fixtureDir();
    write(f.file, ACTIVE);
    const { result, lines } = load(f.ploinkyDir);
    assert.deepEqual({ ...result }, { forceUnprovableWithdrawal: true, forceUnprovableReopen: true, holdInactiveMs: 50 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[test-fault-hook\] ACTIVE test-only restart fault hook/);
});

test('the environment setting selects a file inside the directory only', () => {
    const f = fixtureDir();
    const named = path.join(f.dir, 'other.json');
    write(named, ACTIVE);
    assert.equal(load(f.ploinkyDir, { PLOINKY_TEST_FAULT_HOOKS: named }).result.holdInactiveMs, 50);
});

test('malformed, out-of-directory, relative, symlinked, unknown-key, out-of-range and unsafe settings stay inert for their specific reason', () => {
    const f = fixtureDir();
    const outside = path.join(workspace, 'outside.json');
    write(outside, ACTIVE);
    const set = (name, body, mode) => { const p = path.join(f.dir, `${name}.json`); write(p, body, mode); return p; };
    write(path.join(f.ploinkyDir, 'up.json'), ACTIVE);
    const sibling = set('sibling', ACTIVE);
    const inDirLink = path.join(f.dir, 'sibling-link.json');
    fs.symlinkSync(sibling, inDirLink);
    const outLink = path.join(f.dir, 'out-link.json');
    fs.symlinkSync(outside, outLink);
    const cases = [
        ['malformed', set('bad', '{not json'), /unreadable/],
        ['outside', outside, /outside/],
        // A real file one level up, reached through a `..` segment that survives into the setting.
        ['dotdot', `${f.dir}/../up.json`, /outside/],
        ['relative', 'restart.json', /not absolute/],
        ['unknown key', set('unknown', { ...ACTIVE, extra: true }), /unknown key 'extra'/],
        ['negative hold', set('neg', { ...ACTIVE, holdInactiveMs: -1 }), /holdInactiveMs must be/],
        ['over max', set('max', { ...ACTIVE, holdInactiveMs: hooks.MAX_HOLD_INACTIVE_MS + 1 }), /holdInactiveMs must be/],
        ['fractional hold', set('frac', { ...ACTIVE, holdInactiveMs: 1.5 }), /holdInactiveMs must be/],
        ['non-boolean', set('bool', { ...ACTIVE, forceUnprovableReopen: 'yes' }), /forceUnprovableReopen must be a boolean/],
        ['missing marker', set('nomarker', { forceUnprovableReopen: true }), /activation marker missing/],
        ['group writable', set('gw', ACTIVE, 0o664), /group\/world writable/],
        ['missing', path.join(f.dir, 'missing.json'), /cannot stat/],
        ['symlink to outside file', outLink, /outside|regular file/],
        ['in-directory symlink to a sibling', inDirLink, /regular file/],
    ];
    // The dotdot target really exists outside test-faults/ and is activatable on its own.
    const dotdot = cases.find(([name]) => name === 'dotdot')[1];
    assert.ok(dotdot.includes('/../'));
    assert.equal(fs.existsSync(dotdot), true);
    assert.ok(path.dirname(fs.realpathSync(dotdot)) !== fs.realpathSync(f.dir));
    for (const [name, setting, reason] of cases) {
        const { result, lines } = load(f.ploinkyDir, { PLOINKY_TEST_FAULT_HOOKS: setting });
        assert.equal(result, null, name);
        assert.equal(lines.length, 1, name);
        assert.match(lines[0], /ignored \(inert\)/, name);
        assert.match(lines[0], reason, `${name}: ${lines[0]}`);
    }
    // A world-writable directory also disables the default file.
    write(f.file, ACTIVE);
    fs.chmodSync(f.dir, 0o777);
    assert.equal(load(f.ploinkyDir).result, null);
    fs.chmodSync(f.dir, 0o755);
});

async function heldMerge(options) {
    const start = Date.now();
    await routing.mergeRoutingConfig((current) => ({ ...current, proof: Date.now() }), { reason: 'fault-hook-merge', ...options });
    return Date.now() - start;
}

function sampleSelector(states) {
    return setInterval(() => {
        try { states.push(edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector?.state); } catch (_) {}
    }, 10);
}

const inactiveCount = (states) => states.filter((s) => s === 'inactive').length;

test('a plain merge is short and an activated hold keeps the selector inactive', async () => {
    edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'fault-hook-predecessor' });
    const states = [];
    const poll = sampleSelector(states);
    try {
        await heldMerge({});
        states.length = 0;
        const plain = await heldMerge({});
        const plainInactive = inactiveCount(states);
        states.length = 0;
        const held = await heldMerge({ holdInactiveMs: 1000 });
        assert.ok(plain < 500, `plain merge took ${plain} ms`);
        assert.ok(held >= 1000, `held merge took ${held} ms`);
        assert.ok(inactiveCount(states) >= 40, `held inactive samples: ${inactiveCount(states)}`);
        assert.ok(plainInactive < 40, `plain inactive samples: ${plainInactive}`);
        assert.equal(edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector?.state, 'active');
    } finally {
        clearInterval(poll);
    }
});

test('a held merge ends early when the hook file is removed mid-hold and completes the apply', async () => {
    edge.initializeFreshEdgeRoutingSources({ workspaceRoot: workspace });
    edge.applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'fault-hook-predecessor-2' });
    const f = fixtureDir();
    write(f.file, { ...ACTIVE, holdInactiveMs: 20000 });
    const live = hooks.loadRestartFaultHooks({ env: {}, ploinkyDir: f.ploinkyDir, warn: () => {} });
    assert.equal(live.holdInactiveMs, 20000);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    setTimeout(() => fs.rmSync(f.file), 300);
    try {
        const took = await heldMerge({ holdInactiveMs: live.holdInactiveMs, holdContinues: live.stillActive });
        assert.ok(took < 3000, `merge took ${took} ms`);
        assert.ok(took >= 250, `merge ended before the first slice: ${took} ms`);
    } finally {
        console.warn = originalWarn;
    }
    assert.equal(warnings.filter((line) => line.includes('[test-fault-hook] inactive hold ended early')).length, 1);
    assert.equal(edge.readEdgeRoutingSelection({ workspaceRoot: workspace }).selector?.state, 'active');
});
