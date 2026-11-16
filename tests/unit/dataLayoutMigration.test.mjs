import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    DATA_LAYOUT_FILE,
    DATA_LAYOUT_VERSION,
    assertDataLayoutCurrent,
    ensureDataLayout,
    readDataLayoutVersion,
} from '../../cli/utils/dataLayoutMigration.js';
import {
    controllerGuardMounts,
    controllerGuardTargets,
} from '../../cli/utils/runtime/controllerStateGuards.js';

const quiet = { log: () => {}, assertMigrationAllowed: () => {} };

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'data-layout-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function write(file, content = 'x') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

test('a new workspace starts on the current layout without moving anything', (t) => {
    const root = workspace(t);
    assert.equal(ensureDataLayout(root, quiet), DATA_LAYOUT_VERSION);
    assert.deepEqual(fs.readdirSync(path.join(root, '.data')).sort(), [DATA_LAYOUT_FILE, 'agents']);
    assert.equal(readDataLayoutVersion(root), DATA_LAYOUT_VERSION);
});

test('the flat layout moves into .data/agents, keeping reserved stores and dot entries', (t) => {
    const root = workspace(t);
    const data = path.join(root, '.data');
    write(path.join(data, 'explorer', 'plugin-settings.json'), '{}');
    write(path.join(data, 'shared', 'blob'));
    write(path.join(data, 'dpu-data', 'state.json'), '{}');
    write(path.join(data, '.private', 'roboWorkAgent', 'robots', 'robot-1', 'home', 'f'));
    fs.symlinkSync('/nonexistent-target', path.join(data, 'dangling'));
    const explorerInode = fs.statSync(path.join(data, 'explorer')).ino;
    const messages = [];

    assert.equal(ensureDataLayout(root, { ...quiet, log: message => messages.push(message) }), 4);

    assert.deepEqual(fs.readdirSync(data).sort(), ['.layout.json', 'agents', 'dpu-data', 'robots']);
    assert.deepEqual(fs.readdirSync(path.join(data, 'agents')).sort(), ['dangling', 'explorer', 'shared']);
    // Renames preserve the original data inode.
    assert.equal(fs.statSync(path.join(data, 'agents', 'explorer')).ino, explorerInode);
    assert.equal(fs.readlinkSync(path.join(data, 'agents', 'dangling')), '/nonexistent-target');
    assert.equal(fs.readFileSync(path.join(data, 'dpu-data', 'state.json'), 'utf8'), '{}');
    assert.ok(fs.existsSync(path.join(data, 'robots', 'robot-1', 'home', 'f')));
    assert.match(messages.join('\n'), /Moved 3 entries/);
    // Idempotent.
    assert.equal(ensureDataLayout(root, quiet), 4);
});

test('registry homes and binds follow the move; other paths are untouched', (t) => {
    const root = workspace(t);
    write(path.join(root, '.data', 'demo', 'state'));
    const registry = path.join(root, '.ploinky', 'agents.json');
    write(registry, JSON.stringify({
        demo: {
            projectPath: path.join(root, '.data', 'demo'),
            config: { binds: [
                { source: path.join(root, '.data', 'demo'), target: '/root' },
                { source: path.join(root, '.data', 'dpu-data'), target: '/dpu' },
                { source: root, target: root },
            ] },
        },
        _config: { static: { agent: 'demo' } },
    }));
    fs.chmodSync(registry, 0o600);

    ensureDataLayout(root, quiet);

    const updated = JSON.parse(fs.readFileSync(registry, 'utf8'));
    assert.equal(updated.demo.projectPath, path.join(root, '.data', 'agents', 'demo'));
    assert.deepEqual(updated.demo.config.binds.map(bind => bind.source), [
        path.join(root, '.data', 'agents', 'demo'), path.join(root, '.data', 'dpu-data'), root,
    ]);
    assert.deepEqual(updated._config, { static: { agent: 'demo' } });
    assert.equal(fs.statSync(registry).mode & 0o777, 0o600);
});

test('an empty home created early is replaced; a non-empty conflict stops the migration', (t) => {
    const root = workspace(t);
    write(path.join(root, '.data', 'early', 'state'));
    fs.mkdirSync(path.join(root, '.data', 'agents', 'early'), { recursive: true });
    ensureDataLayout(root, quiet);
    assert.ok(fs.existsSync(path.join(root, '.data', 'agents', 'early', 'state')));

    const other = workspace(t);
    write(path.join(other, '.data', 'clash', 'old'));
    write(path.join(other, '.data', 'agents', 'clash', 'new'));
    assert.throws(() => ensureDataLayout(other, quiet), /already exists and is not empty/);
    assert.equal(readDataLayoutVersion(other), 1);
    assert.ok(fs.existsSync(path.join(other, '.data', 'clash', 'old')));
});

test('a symlinked .data/agents is refused', (t) => {
    const root = workspace(t);
    const elsewhere = workspace(t);
    write(path.join(root, '.data', 'demo', 'state'));
    fs.symlinkSync(elsewhere, path.join(root, '.data', 'agents'));
    assert.throws(() => ensureDataLayout(root, quiet), /must be a real directory/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('launch admission refuses old layouts but initializes fresh data without moving anything', (t) => {
    const root = workspace(t);
    write(path.join(root, '.data', 'demo', 'state'));
    assert.throws(() => assertDataLayoutCurrent(root), /still uses the old layout/);
    assert.ok(fs.existsSync(path.join(root, '.data', 'demo', 'state')), 'a launch never moves data');

    const clean = workspace(t);
    fs.mkdirSync(path.join(clean, '.data', 'agents', 'demo'), { recursive: true });
    fs.mkdirSync(path.join(clean, '.data', 'dpu-data'), { recursive: true });
    assert.equal(assertDataLayoutCurrent(clean), DATA_LAYOUT_VERSION);
    assert.equal(readDataLayoutVersion(clean), DATA_LAYOUT_VERSION);
});

test('a newer layout than this ploinky supports is refused', (t) => {
    const root = workspace(t);
    write(path.join(root, '.data', DATA_LAYOUT_FILE), JSON.stringify({ version: DATA_LAYOUT_VERSION + 1 }));
    assert.throws(() => ensureDataLayout(root, quiet), /newer than this ploinky supports/);
});

test('a broad workspace bind masks .data and shows only the launch home at its real path', (t) => {
    const root = workspace(t);
    const home = path.join(root, '.data', 'agents', 'demo');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(root, '.data', 'agents', 'other'), { recursive: true });
    fs.mkdirSync(path.join(root, '.data', 'dpu-data'), { recursive: true });
    fs.mkdirSync(path.join(root, '.data', '.private'), { recursive: true });
    fs.mkdirSync(path.join(root, '.ploinky-box'));
    const bindings = [
        { hostPath: root, runtimePath: root },
        { hostPath: home, runtimePath: '/root' },
    ];
    const targets = controllerGuardTargets(bindings, { workspaceRoot: root });
    const mounts = controllerGuardMounts(targets, { workspaceRoot: root, bindings, agentDataDir: home });

    const mask = mounts.find(mount => mount.target === path.join(root, '.data'));
    assert.equal(mask.readOnly, true);
    assert.equal(mask.source.startsWith(`${root}${path.sep}`), false, 'the view lives outside the workspace');
    assert.deepEqual(fs.readdirSync(mask.source), ['agents']);
    assert.deepEqual(fs.readdirSync(path.join(mask.source, 'agents')), ['demo']);
    assert.deepEqual(fs.readdirSync(path.join(mask.source, 'agents', 'demo')), []);
    const projection = mounts.find(mount => mount.target === path.join(root, '.data', 'agents', 'demo'));
    assert.deepEqual([projection.source, projection.readOnly], [home, false]);
    assert.equal(mounts.some(mount => mount.target.includes('.private')), false);
    // Planning twice reuses the same view.
    const again = controllerGuardMounts(targets, { workspaceRoot: root, bindings, agentDataDir: home });
    assert.equal(again.find(mount => mount.target === path.join(root, '.data')).source, mask.source);
});


function v2(root) { write(path.join(root, '.data', DATA_LAYOUT_FILE), '{"version":2}'); }

test('v2 moves robots, credentials, runs, stubs and service state; preserves cache and invalidates descriptors', t => {
    const root = workspace(t); v2(root);
    const data = path.join(root, '.data');
    const old = path.join(data, '.private', 'roboWorkAgent');
    const home = path.join(data, 'agents', 'roboWorkAgent');
    write(path.join(old, 'robots', 'robot-1', 'home', 'secret'), 'robot-data');
    write(path.join(old, 'runs', 'run1', 'meta.json'), '{"robotId":"robot-1"}');
    write(path.join(old, 'runs', 'orphan', 'meta.json'), '{"robotId":"../../escape"}');
    write(path.join(old, 'runs', 'missing', 'meta.json'), '{"robotId":"unknown"}');
    write(path.join(old, 'credentials', 'robot-1.json'), 'credentials');
    write(path.join(old, 'tool-cache', 'tool'), 'cache');
    write(path.join(old, 'podman', 'images', 'layer'), 'layer');
    write(path.join(old, 'server-state', 'terminal', 'robot-1.default.json'), '{"home":"/data/robots/robot-1/home"}');
    write(path.join(home, '.codex', 'config'), 'settings');
    fs.mkdirSync(path.join(home, 'terminal', 'robot-1'), { recursive: true });
    write(path.join(data, '.private', '.git-credentials', 'default.json'), 'default');
    const inode = fs.statSync(path.join(old, 'robots', 'robot-1')).ino;
    ensureDataLayout(root, quiet);
    assert.equal(fs.statSync(path.join(data, 'robots', 'robot-1')).ino, inode);
    for (const name of ['robots/robot-1/home/secret', 'robots/robot-1/runs/run1/meta.json', 'robots/robot-1/terminal',
        'robots/.credentials/robot-1.json', 'dpu-data/git-credentials/default.json',
        'agents/roboWorkAgent/orphan-runs/orphan/meta.json', 'agents/roboWorkAgent/orphan-runs/missing/meta.json',
        'agents/roboWorkAgent/.codex/config', 'agents/roboWorkAgent/tool-cache/tool',
        'agents/roboWorkAgent/podman/images/layer']) assert.ok(fs.existsSync(path.join(data, name)), name);
    assert.equal(fs.existsSync(path.join(data, '.private')), false);
    assert.deepEqual(fs.readdirSync(path.join(home, 'server-state', 'terminal')), []);
    assert.equal(ensureDataLayout(root, quiet), 4);
});

test('a partial v2 migration remains refused at launch and resumes after conflict resolution', t => {
    const root = workspace(t); v2(root);
    const data = path.join(root, '.data');
    write(path.join(data, '.private', 'roboWorkAgent', 'robots', 'robot-1', 'home', 'file'));
    write(path.join(data, '.private', 'roboWorkAgent', 'tool-cache', 'old'));
    write(path.join(data, 'agents', 'roboWorkAgent', 'tool-cache', 'new'));
    assert.throws(() => ensureDataLayout(root, quiet), /already exists/);
    assert.equal(readDataLayoutVersion(root), 2);
    assert.ok(fs.existsSync(path.join(data, 'robots', 'robot-1', 'home', 'file')));
    assert.throws(() => assertDataLayoutCurrent(root), /ploinky destroy/);
    fs.renameSync(path.join(data, 'agents', 'roboWorkAgent', 'tool-cache'), path.join(root, 'saved-cache'));
    assert.equal(ensureDataLayout(root, quiet), 4);
});

test('migration requires host admission before writing; old v2 with no private entries still requires admission', t => {
    const root = workspace(t); v2(root);
    const before = fs.readdirSync(path.join(root, '.data'));
    assert.throws(() => ensureDataLayout(root), /host workspace lock/);
    assert.throws(() => ensureDataLayout(root, { assertMigrationAllowed: () => { throw Error('runtime active'); } }), /runtime active/);
    assert.deepEqual(fs.readdirSync(path.join(root, '.data')), before);
    assert.throws(() => assertDataLayoutCurrent(root), /ploinky destroy/);
});

for (const unsafe of ['.private', '.private/roboWorkAgent', 'robots', 'agents', 'dpu-data']) {
    test(`v2 refuses symlink migration ancestor ${unsafe}`, t => {
        const root = workspace(t); v2(root);
        const outside = workspace(t);
        const data = path.join(root, '.data');
        const link = path.join(data, unsafe);
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(outside, link);
        if (unsafe === 'agents') write(path.join(data, '.private', 'roboWorkAgent', 'tool-cache', 'file'));
        if (unsafe === 'dpu-data') write(path.join(data, '.private', '.git-credentials', 'file'));
        if (unsafe === 'robots') write(path.join(data, '.private', 'roboWorkAgent', 'robots', 'robot-1', 'file'));
        assert.throws(() => ensureDataLayout(root, quiet), /unsafe migration path|real directory/);
        assert.deepEqual(fs.readdirSync(outside), []);
        assert.equal(readDataLayoutVersion(root), 2);
    });
}

test('unknown private entries block completion and are retained', t => {
    const root = workspace(t); v2(root);
    write(path.join(root, '.data', '.private', 'unknown', 'data'), 'retained');
    assert.throws(() => ensureDataLayout(root, quiet), /unmigrated.*unknown/);
    assert.equal(readDataLayoutVersion(root), 2);
    assert.equal(fs.readFileSync(path.join(root, '.data', '.private', 'unknown', 'data'), 'utf8'), 'retained');
});

test('v2 registry paths follow robots, per-robot runs, orphan runs, credentials and terminal stubs', t => {
    const root = workspace(t); v2(root);
    const data = path.join(root, '.data');
    const old = path.join(data, '.private', 'roboWorkAgent');
    write(path.join(old, 'robots', 'robot-1', 'home', 'file'));
    write(path.join(old, 'runs', 'run1', 'meta.json'), '{"robotId":"robot-1"}');
    write(path.join(old, 'runs', 'orphan', 'meta.json'), '{}');
    const registry = path.join(root, '.ploinky', 'agents.json');
    write(registry, JSON.stringify({ paths: [
        path.join(old, 'robots', 'robot-1', 'home'), path.join(old, 'runs', 'run1', 'output'),
        path.join(old, 'runs', 'orphan'), path.join(old, 'credentials', 'robot-1.json'),
        path.join(data, '.private', '.git-credentials'), path.join(data, 'agents', 'roboWorkAgent', 'terminal', 'robot-1'),
    ] }));
    fs.chmodSync(registry, 0o600);
    ensureDataLayout(root, quiet);
    assert.deepEqual(JSON.parse(fs.readFileSync(registry)).paths, [
        path.join(data, 'robots', 'robot-1', 'home'), path.join(data, 'robots', 'robot-1', 'runs', 'run1', 'output'),
        path.join(data, 'agents', 'roboWorkAgent', 'orphan-runs', 'orphan'), path.join(data, 'robots', '.credentials', 'robot-1.json'),
        path.join(data, 'dpu-data', 'git-credentials'), path.join(data, 'robots', 'robot-1', 'terminal'),
    ]);
    assert.equal(fs.statSync(registry).mode & 0o777, 0o600);
});

test('destroy-interrupted terminal wrappers and temporary descriptors are preserved outside the active store', t => {
    const root = workspace(t); v2(root);
    const old = path.join(root, '.data/.private/roboWorkAgent/server-state/terminal');
    write(path.join(old, 'launch-aB1234/launch.sh'), 'old absolute paths');
    const temporary = '.11111111-2222-3333-4444-555555555555';
    write(path.join(old, temporary), 'partial descriptor');
    ensureDataLayout(root, quiet);
    const state = path.join(root, '.data/agents/roboWorkAgent/server-state');
    assert.deepEqual(fs.readdirSync(path.join(state, 'terminal')), []);
    assert.equal(fs.readFileSync(path.join(state, 'terminal-layout-v2/launch-aB1234/launch.sh'), 'utf8'), 'old absolute paths');
    assert.equal(fs.readFileSync(path.join(state, 'terminal-layout-v2', temporary), 'utf8'), 'partial descriptor');
    assert.equal(ensureDataLayout(root, quiet), DATA_LAYOUT_VERSION);
});

for (const kind of ['layout', 'registry', 'meta', 'descriptor']) {
    test(`v2 refuses a symlinked ${kind} without touching its target`, t => {
        const root = workspace(t); v2(root);
        const outside = path.join(workspace(t), 'file');
        write(outside, '{"version":2,"robotId":"robot-1"}');
        const target = {
            layout: '.data/.layout.json', registry: '.ploinky/agents.json',
            meta: '.data/.private/roboWorkAgent/runs/run1/meta.json',
            descriptor: '.data/.private/roboWorkAgent/server-state/terminal/robot-1.default.json',
        }[kind];
        const file = path.join(root, target);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (kind === 'layout') fs.unlinkSync(file);
        fs.symlinkSync(outside, file);
        assert.throws(() => ensureDataLayout(root, quiet), /unsafe/);
        assert.equal(fs.readFileSync(outside, 'utf8'), '{"version":2,"robotId":"robot-1"}');
    });
}

test('v3 master key copy is byte-stable, tombstoned and resumable; conflicts fail closed', t => {
    const root = workspace(t);
    const old = path.join(root, '.ploinky/data/master-key');
    const target = path.join(root, '.data/dpu-data/master-key');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(root, '.data/.layout.json'), JSON.stringify({ version: 3 }));
    const seed = 'ab'.repeat(32) + '\n';
    fs.writeFileSync(old, seed, { mode: 0o600 });
    fs.writeFileSync(target, 'cd'.repeat(32) + '\n', { mode: 0o600 });
    assert.throws(() => ensureDataLayout(root, quiet), /conflicting master keys/);
    assert.equal(fs.readFileSync(old, 'utf8'), seed);
    fs.writeFileSync(target, seed);
    assert.equal(ensureDataLayout(root, quiet), 4);
    assert.equal(fs.readFileSync(target, 'utf8'), seed);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(old, 'utf8'), '');
    fs.writeFileSync(path.join(root, '.data/.layout.json'), JSON.stringify({ version: 3 }));
    assert.equal(ensureDataLayout(root, quiet), 4);
});

test('v3 migration preserves secrets and SSO decryption and moves custom monitor state', async t => {
    const { default: crypto } = await import('node:crypto');
    const { deriveSubkeyFromSeed } = await import('../../cli/utils/security/masterKey.js');
    const { decryptSecretsText } = await import('../../cli/utils/security/secretsFileCodec.js');
    const { encodeSessionsFile, decodeSessionsFile } = await import('../../cli/server/auth/sessionPersistence.js');
    const { readWorkspaceMasterKey } = await import('../../ploinky-box/entrypoint/initialize-workspace.mjs');
    const root = workspace(t);
    const seed = crypto.randomBytes(32).toString('hex');
    write(path.join(root, '.ploinky/data/master-key'), seed + '\n');
    write(path.join(root, '.data/.layout.json'), JSON.stringify({ version: 3 }));
    const monitor = path.join(root, '.data/agents/workspace-monitor/history.sqlite');
    write(monitor, 'preserved-monitor-data');
    const inode = fs.statSync(monitor).ino;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveSubkeyFromSeed(seed, 'storage/secrets'), iv);
    const payload = { version: 1, secrets: { TEST_ONLY: 'fixture-value' } };
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    const sessions = { version: 1, sessions: {} };
    const encryptedSessions = encodeSessionsFile(sessions, () => deriveSubkeyFromSeed(seed, 'storage/router-sso-sessions'));
    ensureDataLayout(root, quiet);
    const currentSeed = readWorkspaceMasterKey({ workspaceRoot: root }).key;
    assert.deepEqual(decryptSecretsText(packed, deriveSubkeyFromSeed(currentSeed, 'storage/secrets')), payload.secrets);
    assert.deepEqual(decodeSessionsFile(encryptedSessions, () => deriveSubkeyFromSeed(currentSeed, 'storage/router-sso-sessions')), sessions);
    assert.equal(fs.statSync(path.join(root, '.data/agents/workspaceMonitorAgent/history.sqlite')).ino, inode);
    assert.equal(fs.existsSync(monitor), false);
});
