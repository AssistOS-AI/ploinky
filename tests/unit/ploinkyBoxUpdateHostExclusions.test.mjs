import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { createSkillExclusionPlanner } from '../../cli/utils/skills/exportExclusions.mjs';
import * as tx from '../../cli/utils/skills/exportTransaction.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import {
    HOST_EXCLUSIONS_AUTHORITY,
    HOST_EXCLUSIONS_INTENT_KIND,
    recoverInterruptedHostExclusions,
    refreshDeferredHostExclusions,
} from '../../ploinky-box/update/hostExclusions.mjs';
import { createMemoryUpdateHostState, createUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';
import { fakeRestartCore, fakeUpdateCore, verifiedRecord } from '../helpers/fakeUpdateCore.mjs';

// Never read the global, system or XDG Git policy of the machine running this.
const isolation = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-exclusions-env-')));
const xdgIgnore = path.join(isolation, 'xdg', 'git', 'ignore');
fs.writeFileSync(path.join(isolation, 'gitconfig'), '');
const savedEnv = Object.fromEntries(['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PLOINKY_SKILL_EXCLUDES_COMPOSE']
    .map(key => [key, process.env[key]]));
Object.assign(process.env, {
    XDG_CONFIG_HOME: path.join(isolation, 'xdg'),
    GIT_CONFIG_GLOBAL: path.join(isolation, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
delete process.env.PLOINKY_SKILL_EXCLUDES_COMPOSE;
test.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(isolation, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const status = cwd => git(cwd, 'status', '--porcelain', '--untracked-files=all');

// A workspace selected through an alias spelling, holding one Git project
// whose skill export was published in-Box with exclusions deferred.
function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-host-exclusions-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.rmSync(xdgIgnore, { force: true });
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    const real = path.join(root, 'real-workspace');
    fs.mkdirSync(path.join(real, '.ploinky'), { recursive: true });
    const selected = path.join(root, 'selected');
    fs.symlinkSync(real, selected, 'dir');
    const project = path.join(real, 'project');
    fs.mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(project, 'README.md'), '# project\n');
    git(project, 'add', 'README.md');
    git(project, 'commit', '-q', '-m', 'initial');
    const source = path.join(root, 'sources', 'demo');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# demo\n');
    const inBox = tx.syncManagedSkillExports({
        folder: project, owner: 'manifest', claude: 'root-or-skills',
        sources: [{ name: 'demo', path: source }],
        exclusions: createSkillExclusionPlanner({ containerExecutor: true }),
    });
    assert.equal(inBox.exclusions.code, 'exclusions-executor-view-unverified');
    assert.match(status(project), /\?\? \.agents\//);
    const identity = buildWorkspaceIdentity(selected, { markerFound: true });
    return { root, real, selected, project, identity, boxProject: `${identity.workspaceRoot}/project` };
}

test('a deferred Git export folder becomes privately excluded on the host through the Box spelling', async (t) => {
    const w = workspace(t);
    const ledger = fs.readFileSync(path.join(w.project, '.agents', '.ploinky-skill-exports.json'), 'utf8');
    const [record] = await refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.phase, record.id, record.outcome, record.required], ['skills-manifest', 'exclusions:project', 'changed', false]);
    assert.equal(record.details.folder, w.project, 'the refresh ran on the canonical host folder');
    assert.equal(status(w.project), '', 'the private worktree exclusion is effective on the host');
    assert.equal(fs.existsSync(path.join(w.project, '.gitignore')), false);
    assert.equal(fs.readFileSync(path.join(w.project, '.agents', '.ploinky-skill-exports.json'), 'utf8'), ledger,
        'exclusions only: no skill publication');
    const [again] = await refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.equal(again.outcome, 'unchanged');
});

test('a live external excludes policy stays deferred with its code', async (t) => {
    const w = workspace(t);
    fs.mkdirSync(path.dirname(xdgIgnore), { recursive: true });
    fs.writeFileSync(xdgIgnore, '*.log\n');
    const [record] = await refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['deferred', 'exclusions-deferred']);
    assert.match(status(w.project), /\?\? \.agents\//, 'nothing was written');
});

test('escaping, unclean, missing and linked-out folders are refused before any refresh', async (t) => {
    const w = workspace(t);
    const outside = path.join(w.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(w.real, 'link-out'), 'dir');
    const calls = [];
    const records = await refreshDeferredHostExclusions({
        folders: [
            outside,
            `${w.identity.workspaceRoot}/project/../../outside`,
            `${w.identity.workspaceRoot}/missing`,
            `${w.identity.workspaceRoot}/link-out`,
            'relative/path',
        ],
        identity: w.identity,
        refresh: (...args) => { calls.push(args); return { exclusions: { status: 'published' } }; },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(records.map(record => [record.outcome, record.code]).sort(), [
        ['failed', 'exclusion-folder-missing'],
        ['failed', 'exclusion-folder-refused'],
        ['failed', 'exclusion-folder-refused'],
        ['failed', 'exclusion-folder-refused'],
        ['failed', 'exclusion-folder-refused'],
    ]);
    assert.equal(records.every(record => record.required === false), true);
});

test('duplicate folders are refreshed once and an oversized list is bounded with a named record', async (t) => {
    const w = workspace(t);
    fs.mkdirSync(path.join(w.real, 'a'));
    fs.mkdirSync(path.join(w.real, 'b'));
    const calls = [];
    const refresh = (folder) => { calls.push(folder); return { exclusions: { status: 'unchanged' } }; };
    const root = w.identity.workspaceRoot;
    const records = await refreshDeferredHostExclusions({
        folders: [`${root}/project`, `${root}/project`, `${root}/a`, `${root}/b`],
        identity: w.identity,
        refresh,
        limit: 2,
    });
    assert.deepEqual(calls, [path.join(w.real, 'a'), path.join(w.real, 'b')], 'sorted, unique, bounded');
    const overflow = records.find(record => record.id === 'exclusions:overflow');
    assert.deepEqual([overflow.outcome, overflow.code, overflow.required], ['uncertain', 'deferred-exclusion-folders-exceeded', false]);
    assert.deepEqual((await refreshDeferredHostExclusions({ folders: 'not-a-list', identity: w.identity })).map(record => record.code),
        ['deferred-exclusion-folders-invalid']);
    assert.deepEqual(await refreshDeferredHostExclusions({ identity: w.identity }), []);
    const thrown = await refreshDeferredHostExclusions({
        folders: [`${root}/a`], identity: w.identity,
        refresh: () => { throw Object.assign(new Error('export lock is held'), { code: 'EXPORT_LOCK_BLOCKED' }); },
    });
    assert.deepEqual([thrown[0].outcome, thrown[0].code], ['failed', 'EXPORT_LOCK_BLOCKED']);
});

function supervisorFor(t, w, { folders, refresh = undefined, store = createMemoryUpdateHostState(), onCore = null }) {
    const events = [];
    const selection = agentLibFixture(w.identity.workspaceRoot);
    const ownership = () => ({
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: { container: { id: 'a'.repeat(64), runtime: { running: true } } },
    });
    let lockHeld = false;
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => w.identity,
        launchCwd: w.identity.workspaceRoot,
        lockManager: {
            async acquire() {
                lockHeld = true;
                return { assertHeld() {}, release() { lockHeld = false; events.push('release'); } };
            },
        },
        discover: () => ownership(),
        env: process.env,
        stdout: { write() {} },
        stderr: { write() {} },
        updateHostState: store,
        runner: {
            run() {},
            query: () => ({ ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: true }) }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        updateWorkspacePloinky: async () => null,
        updateAgentLib: async () => ({ selection, changed: false, previous: selection }),
        reconcile: async () => ({
            action: 'reused', ownership: ownership(), hostPort: 8080, mediaHostPort: 7882, finalize() {},
        }),
        runUpdateCore: fakeUpdateCore({
            onCall() { events.push('core-update'); onCore?.(); },
            records: () => [verifiedRecord()],
            resultExtra: { deferredExclusionFolders: folders },
        }),
        runRestartCore: fakeRestartCore(async (_engine, _id, argv) => { events.push(argv[0]); }),
        ...(refresh ? {
            refreshHostExclusions: (options) => {
                assert.equal(lockHeld, true, 'the host refresh runs under the workspace lock');
                events.push('refresh-exclusions');
                return refresh(options);
            },
        } : {}),
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => {},
        revalidateAgentLibSource() {},
        commitAgentLibSelection() {},
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
    });
    return { supervisor, events };
}

test('the update transaction refreshes deferred exclusions on the host and merges optional records', async (t) => {
    const w = workspace(t);
    const { supervisor, events } = supervisorFor(t, w, {
        folders: [w.boxProject],
        refresh: options => refreshDeferredHostExclusions(options),
    });
    const result = await supervisor.runUpdateTransaction(['update']);
    assert.ok(events.indexOf('core-update') < events.indexOf('refresh-exclusions'));
    assert.ok(events.indexOf('refresh-exclusions') < events.indexOf('release'));
    const record = result.records.find(entry => entry.id === 'exclusions:project');
    assert.equal(record.outcome, 'changed');
    assert.equal(result.decision.exitCode, 0);
    assert.equal(result.activation.outcome, 'restarted');
    assert.equal(status(w.project), '');
});

test('a failed host exclusion refresh makes the update nonzero but never blocks activation', async (t) => {
    const w = workspace(t);
    const { supervisor, events } = supervisorFor(t, w, {
        folders: [w.boxProject],
        refresh: () => [createOperationRecord({
            phase: 'skills-manifest', id: 'exclusions:project', outcome: 'failed', required: false, code: 'EXPORT_LOCK_BLOCKED',
        })],
    });
    const result = await supervisor.runUpdateTransaction(['update']);
    assert.equal(result.decision.exitCode, 1);
    assert.equal(result.decision.activationAllowed, true);
    assert.equal(result.activation.outcome, 'restarted');
    assert.ok(events.includes('restart'));
});

test('a planted .git file redirecting outside the workspace is never followed by the host refresh', async (t) => {
    const w = workspace(t);
    const victim = path.join(w.root, 'outside-victim');
    fs.mkdirSync(victim);
    git(victim, 'init', '-q', '-b', 'main');
    const victimConfig = fs.readFileSync(path.join(victim, '.git', 'config'), 'utf8');
    // Replace the project's Git directory with a Box-writable redirect.
    fs.rmSync(path.join(w.project, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(w.project, '.git'), `gitdir: ${path.join(victim, '.git')}\n`);
    const [record] = await refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['deferred', 'git-directory-outside-boundary']);
    assert.equal(fs.readFileSync(path.join(victim, '.git', 'config'), 'utf8'), victimConfig, 'victim config untouched');
    assert.deepEqual(fs.readdirSync(path.join(victim, '.git')).filter(name => name.startsWith('ploinky') || name === 'config.worktree'), []);
});

test('host refresh preserves a symlinked Git configuration without writing its target', async t => {
    const w = workspace(t);
    const config = path.join(w.project, '.git', 'config');
    const outside = path.join(w.root, 'outside-config');
    const before = fs.readFileSync(config);
    fs.writeFileSync(outside, before);
    fs.unlinkSync(config);
    fs.symlinkSync(outside, config);
    const [record] = await refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['deferred', 'git-metadata-not-private-regular']);
    assert.deepEqual(fs.readFileSync(outside), before);
    assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(w.project, '.git', tx.GIT_CONFIG_LOCK || 'ploinky-skill-exports-config.lock')), false);
});

test('host refresh refuses pending recovery before inspecting journal-selected lock locations', async t => {
    const w = workspace(t);
    const outside = path.join(w.root, 'outside-metadata');
    fs.mkdirSync(outside);
    const journal = path.join(w.project, '.agents', tx.EXPORT_JOURNAL);
    const bytes = JSON.stringify({ protocol: tx.EXPORT_PROTOCOL, config: { identity: { commonDir: outside } } });
    fs.writeFileSync(journal, bytes);
    const [record] = await refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['uncertain', 'SKILL_EXPORT_RECOVERY_REQUIRED']);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.readFileSync(journal, 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(w.project, '.agents', tx.EXPORT_LOCK)), false);
});

test('host refresh defers repository Git includes before loading their policy', async t => {
    const w = workspace(t);
    const config = path.join(w.project, '.git', 'config');
    fs.appendFileSync(config, '\n[include]\n    path = ../absent-policy\n');
    const before = fs.readFileSync(config);
    const [record] = await refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['deferred', 'git-config-include-unverified']);
    assert.deepEqual(fs.readFileSync(config), before);
});

// A stray file in the freshly created export lock directory makes its release
// fail (ENOTEMPTY) whatever the refresh itself does.
function strayLockLiveness(folder) {
    const lock = path.join(folder, '.agents', tx.EXPORT_LOCK);
    return { current: () => {
        if (fs.existsSync(lock)) fs.writeFileSync(path.join(lock, 'stray'), 'stray\n');
        return tx.currentSkillExportIdentity();
    } };
}

test('a host refresh whose lock release fails is failed when settled and uncertain when its result needs recovery', async t => {
    const w = workspace(t);
    const liveness = strayLockLiveness(w.project);
    const lock = path.join(w.project, '.agents', tx.EXPORT_LOCK);
    // The real refresh publishes and settles its exclusions, then the release fails.
    const [settled] = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity,
        refresh: (folder, options) => tx.refreshSkillExportExclusions(folder, { ...options, lock: { liveness } }),
    });
    assert.deepEqual([settled.outcome, settled.code], ['failed', 'SKILL_EXPORT_LOCK_RELEASE_FAILED']);
    assert.equal(status(w.project), '', 'the settled exclusions were published before the release failed');
    fs.rmSync(lock, { recursive: true });
    // The same release failure after a completed result that still needs
    // recovery keeps that result's uncertain outcome.
    const quarantined = { id: '00000000-0000-4000-8000-000000000000', status: 'quarantined', unexpected: [{ name: 'receipt' }] };
    const [uncertain] = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity,
        refresh: folder => tx.withSkillExportLocks([folder], ([handle]) => ({ folder: handle.root, exclusions: { status: 'preserved' }, transaction: quarantined, recovery: handle.recovery }), { liveness }),
    });
    assert.deepEqual([uncertain.outcome, uncertain.code], ['uncertain', 'SKILL_EXPORT_RECOVERY_REQUIRED']);
    assert.equal(uncertain.details.errorCode, 'SKILL_EXPORT_LOCK_RELEASE_FAILED');
    assert.deepEqual(uncertain.details.transaction, quarantined);
    assert.match(uncertain.reason, /transaction quarantined.*lock could not be released/s);
    fs.rmSync(lock, { recursive: true });
});

// ---------------------------------------------------------------------------
// Cancellation and recovery. The host refresh holds each folder's export lock
// and common Git configuration lock as this host process, an owner that no
// in-Box exporter can prove dead.

const intentFor = (w, folders) => ({ schema: 'ploinky-host-exclusions-refresh', version: 1, instance: w.identity.instance, folders });

// A private record adapter that logs its writes and removals.
function memoryIntent(record = null) {
    const intent = {
        calls: [],
        record,
        read: () => intent.record,
        write(next) { intent.calls.push('write'); intent.record = JSON.parse(JSON.stringify(next)); },
        remove() { intent.calls.push('remove'); intent.record = null; },
    };
    return intent;
}

const exportLockPath = w => path.join(w.project, '.agents', tx.EXPORT_LOCK);
const configLockPath = w => path.join(w.project, '.git', 'ploinky-skill-exports-config.lock');
const lockContents = lock => fs.readdirSync(lock).sort().map(name => [name, fs.readFileSync(path.join(lock, name), 'utf8')]);

// A process of this boot and PID namespace that has ended.
const endedPid = () => spawnSync(process.execPath, ['-e', '']).pid;

// Take both locks of a folder (the project by default) as the described
// owner and never release them, as a host refresh killed while holding them would.
function holdLocks(w, { pid, authority = HOST_EXCLUSIONS_AUTHORITY, namespace = null, folder = w.project }) {
    const self = { ...tx.currentSkillExportIdentity(), pid, start: '', ...(namespace ? { namespace } : {}) };
    const options = { liveness: { current: () => self }, authority, waitMs: 0 };
    tx.acquireGitConfigLock(path.join(folder, '.git'), options);
    tx.acquireSkillExportLock(folder, options);
}

test('the refresh records its folders before taking any lock and forgets them once every lock is released', async t => {
    const w = workspace(t);
    const intent = memoryIntent();
    const seen = [];
    const [record] = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity, intent,
        refresh: (folder, options) => {
            seen.push({ recorded: intent.record?.folders, locked: fs.existsSync(exportLockPath(w)) || fs.existsSync(configLockPath(w)) });
            return tx.refreshSkillExportExclusions(folder, options);
        },
    });
    assert.equal(record.outcome, 'changed');
    assert.deepEqual(seen, [{ recorded: [w.project], locked: false }]);
    assert.deepEqual([intent.calls, intent.record], [['write', 'remove'], null]);
});

test('a lock the refresh could not release keeps its folder recorded for the next update', async t => {
    const w = workspace(t);
    const intent = memoryIntent();
    const liveness = strayLockLiveness(w.project);
    const [record] = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity, intent,
        refresh: (folder, options) => tx.refreshSkillExportExclusions(folder, { ...options, lock: { liveness } }),
    });
    assert.equal(record.code, 'SKILL_EXPORT_LOCK_RELEASE_FAILED');
    assert.deepEqual([intent.calls, intent.record.folders], [['write', 'write'], [w.project]]);
    fs.rmSync(exportLockPath(w), { recursive: true });
});

test('no folder is refreshed when its record cannot be written first', async t => {
    const w = workspace(t);
    const calls = [];
    const records = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity,
        intent: { write() { throw new Error('host state is read-only'); }, remove() { calls.push('remove'); } },
        refresh: (...args) => { calls.push(args); return { exclusions: { status: 'published' } }; },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code, record.required]),
        [['exclusions:intent', 'uncertain', 'exclusions-intent-unwritable', false]]);
    assert.match(records[0].reason, /host state is read-only/);
});

test('a received signal stops the refresh before its next folder and names every folder it skipped', async t => {
    const w = workspace(t);
    fs.mkdirSync(path.join(w.real, 'a'));
    fs.mkdirSync(path.join(w.real, 'b'));
    const root = w.identity.workspaceRoot;
    const calls = [];
    const intent = memoryIntent();
    const records = await refreshDeferredHostExclusions({
        folders: [`${root}/project`, `${root}/b`, `${root}/a`], identity: w.identity, intent,
        cancellation: { signalReceived: async () => (calls.length ? 'SIGTERM' : '') },
        refresh: (folder) => { calls.push(folder); return { exclusions: { status: 'unchanged' } }; },
    });
    assert.deepEqual(calls, [path.join(w.real, 'a')], 'the folder in progress finished; no later folder started');
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code, record.required]), [
        ['exclusions:a', 'unchanged', '', false],
        ['exclusions:b', 'skipped', 'cancelled', false],
        ['exclusions:project', 'skipped', 'cancelled', false],
    ]);
    assert.match(records[1].reason, /cancelled by SIGTERM before the host refreshed these exclusions/);
    assert.deepEqual([intent.calls, intent.record], [['write', 'remove'], null]);
    const early = await refreshDeferredHostExclusions({
        folders: [`${root}/a`], identity: w.identity,
        cancellation: { signalReceived: async () => 'SIGINT' },
        refresh: () => assert.fail('no folder starts after a signal'),
    });
    assert.deepEqual(early.map(record => [record.outcome, record.code]), [['skipped', 'cancelled']]);
});

test('recovery releases the locks a killed host refresh left, with same-scope proof, and leaves its journal and Git lock', t => {
    const w = workspace(t);
    const pid = endedPid();
    holdLocks(w, { pid });
    const journal = path.join(w.project, '.agents', tx.EXPORT_JOURNAL);
    fs.writeFileSync(journal, '{"pending":"host exclusions-only transaction"}\n');
    const gitLock = path.join(w.project, '.git', 'config.lock');
    fs.writeFileSync(gitLock, '[core]\n');
    const intent = memoryIntent(intentFor(w, [w.project]));
    const { records, warnings } = recoverInterruptedHostExclusions({ intent, identity: w.identity });
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code, record.required]),
        [['exclusions-recovery:project', 'changed', 'interrupted-refresh-locks-released', false]]);
    assert.deepEqual(records[0].details.released, [configLockPath(w), exportLockPath(w)]);
    assert.deepEqual([fs.existsSync(configLockPath(w)), fs.existsSync(exportLockPath(w))], [false, false]);
    assert.equal(fs.readFileSync(journal, 'utf8'), '{"pending":"host exclusions-only transaction"}\n', 'the journal is left for the confined executor');
    assert.equal(fs.readFileSync(gitLock, 'utf8'), '[core]\n', "Git's own lock is never touched");
    assert.match(warnings.join('\n'), new RegExp(`\\(pid ${pid}\\) ended and released them; its pending export journal is left`));
    assert.deepEqual([intent.calls, intent.record], [['remove'], null]);
});

for (const [label, state, hold] of [
    ['still runs', 'live', w => holdLocks(w, { pid: process.pid })],
    ['ran in another PID namespace', 'unknown', w => holdLocks(w, { pid: endedPid(), namespace: 'pid:[another-namespace]' })],
    ['is another writer', 'dead-other-writer', w => holdLocks(w, { pid: endedPid(), authority: { kind: 'ploinky-cli', operation: 'skills-export' } })],
    ['left no owner record', 'ownerless', w => { fs.mkdirSync(configLockPath(w)); fs.mkdirSync(exportLockPath(w)); }],
]) {
    test(`recovery preserves and reports a lock whose owner ${label}, and keeps the record`, t => {
        const w = workspace(t);
        hold(w);
        const before = [configLockPath(w), exportLockPath(w)].map(lockContents);
        const intent = memoryIntent(intentFor(w, [w.project]));
        const { records, warnings } = recoverInterruptedHostExclusions({ intent, identity: w.identity });
        assert.deepEqual(records.map(record => [record.id, record.outcome, record.code]),
            [['exclusions-recovery:project', 'uncertain', 'interrupted-refresh-locks-unproven']]);
        // Observed and preserved, never handed to an acquisition attempt.
        for (const lock of [configLockPath(w), exportLockPath(w)]) {
            assert.match(records[0].reason, new RegExp(`${lock.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: \\(owner pid \\d+\\))? is ${state}[;.]`));
        }
        assert.deepEqual([configLockPath(w), exportLockPath(w)].map(lockContents), before, 'both locks are untouched');
        assert.deepEqual(intent.record.folders, [w.project]);
        assert.match(warnings.join('\n'), /could not be proven released.*remove them by hand/s);
    });
}

test('recovery never creates a missing skills directory to release an export lock', t => {
    const w = workspace(t);
    holdLocks(w, { pid: endedPid() });
    const skills = path.join(w.project, '.agents', 'skills');
    fs.renameSync(skills, path.join(w.root, 'skills-moved'));
    const intent = memoryIntent(intentFor(w, [w.project]));
    const { records } = recoverInterruptedHostExclusions({ intent, identity: w.identity });
    assert.deepEqual(records.map(record => [record.outcome, record.code]),
        [['changed', 'interrupted-refresh-locks-released'], ['uncertain', 'interrupted-refresh-locks-unproven']]);
    assert.match(records[1].reason, /skills-directory-missing/);
    assert.deepEqual([fs.existsSync(configLockPath(w)), fs.existsSync(exportLockPath(w)), fs.existsSync(skills)], [false, true, false]);
    assert.deepEqual(intent.record.folders, [w.project]);
});

test('recovery drops a recorded folder that no longer is that workspace folder without inspecting it', t => {
    const w = workspace(t);
    const outside = path.join(w.root, 'outside');
    fs.mkdirSync(path.join(outside, '.agents', tx.EXPORT_LOCK), { recursive: true });
    const swapped = path.join(w.real, 'swapped');
    fs.symlinkSync(outside, swapped, 'dir');
    // A recorded path that is now a link to another workspace folder.
    holdLocks(w, { pid: endedPid() });
    const alias = path.join(w.real, 'alias');
    fs.symlinkSync(w.project, alias, 'dir');
    const intent = memoryIntent(intentFor(w, [path.join(w.real, 'gone'), swapped, alias]));
    const { records, warnings } = recoverInterruptedHostExclusions({ intent, identity: w.identity });
    assert.deepEqual(records, []);
    assert.equal(warnings.length, 3);
    assert.match(warnings.join('\n'), /no longer a folder of this workspace/);
    assert.deepEqual(fs.readdirSync(path.join(outside, '.agents', tx.EXPORT_LOCK)), [], 'nothing outside was touched');
    assert.deepEqual([fs.existsSync(configLockPath(w)), fs.existsSync(exportLockPath(w))], [true, true], 'nothing was inspected through the link');
    assert.deepEqual([intent.calls, intent.record], [['remove'], null]);
});

test('recovery never follows a linked .agents directory to an export lock', t => {
    const w = workspace(t);
    holdLocks(w, { pid: endedPid() });
    const outsideAgents = path.join(w.root, 'outside-agents');
    fs.renameSync(path.join(w.project, '.agents'), outsideAgents);
    fs.symlinkSync(outsideAgents, path.join(w.project, '.agents'), 'dir');
    const outsideLock = lockContents(path.join(outsideAgents, tx.EXPORT_LOCK));
    const intent = memoryIntent(intentFor(w, [w.project]));
    const { records } = recoverInterruptedHostExclusions({ intent, identity: w.identity });
    assert.deepEqual(records.map(record => [record.outcome, record.code]),
        [['changed', 'interrupted-refresh-locks-released'], ['uncertain', 'interrupted-refresh-locks-unproven']]);
    assert.match(records[1].reason, /\.agents is not a real directory/);
    assert.equal(fs.existsSync(configLockPath(w)), false, 'the configuration lock inside the workspace was released');
    assert.deepEqual(lockContents(path.join(outsideAgents, tx.EXPORT_LOCK)), outsideLock, 'the linked lock is untouched');
    assert.deepEqual(intent.record.folders, [w.project]);
});

test('a malformed refresh record is reported once and forgotten; one that cannot be read is reported and kept', t => {
    const w = workspace(t);
    for (const stored of [
        { schema: 'another-record' },
        intentFor(w, ['relative/path']),
        { ...intentFor(w, [w.project]), instance: 'ploinky-box-other-000000000000' },
    ]) {
        const intent = memoryIntent(stored);
        const { records } = recoverInterruptedHostExclusions({ intent, identity: w.identity });
        assert.deepEqual(records.map(record => [record.id, record.outcome, record.code]),
            [['exclusions-recovery:record', 'uncertain', 'exclusions-intent-invalid']]);
        assert.deepEqual(intent.calls, ['remove']);
    }
    const unreadable = { removed: false, read() { throw new Error('record is not private'); }, write() { assert.fail('nothing is written'); }, remove() { unreadable.removed = true; } };
    const { records } = recoverInterruptedHostExclusions({ intent: unreadable, identity: w.identity });
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code]),
        [['exclusions-recovery:record', 'uncertain', 'exclusions-intent-unreadable']]);
    assert.match(records[0].reason, /record is not private.*it is kept/);
    assert.equal(unreadable.removed, false, 'a record that could not be read is never removed');
    assert.deepEqual(recoverInterruptedHostExclusions({ intent: memoryIntent(), identity: w.identity }), { records: [], warnings: [] });
});

test('an update releases the locks an interrupted host refresh left before its in-Box step meets them', async t => {
    const w = workspace(t);
    const pid = endedPid();
    holdLocks(w, { pid });
    const store = createMemoryUpdateHostState();
    store.write(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance, intentFor(w, [w.project]));
    const atCore = [];
    const { supervisor } = supervisorFor(t, w, {
        folders: [w.boxProject], store,
        onCore: () => atCore.push([fs.existsSync(configLockPath(w)), fs.existsSync(exportLockPath(w))]),
    });
    const result = await supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(atCore, [[false, false]], 'both locks were released before the in-Box step');
    const released = result.records.find(record => record.id === 'exclusions-recovery:project');
    assert.deepEqual([released.outcome, released.code], ['changed', 'interrupted-refresh-locks-released']);
    assert.ok(result.warnings.some(warning => warning.includes(`(pid ${pid}) ended`)));
    assert.equal(result.records.find(record => record.id === 'exclusions:project').outcome, 'changed', 'the refresh then ran again');
    assert.equal(store.read(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance), null);
    assert.equal(result.decision.exitCode, 0);
});

test('the host refresh owns the update signals and runs with its folders recorded in private host state', async t => {
    const w = workspace(t);
    const store = createMemoryUpdateHostState();
    const seen = [];
    const { supervisor } = supervisorFor(t, w, {
        folders: [w.boxProject], store,
        refresh: options => refreshDeferredHostExclusions({
            ...options,
            refresh: (folder, refreshOptions) => {
                seen.push([typeof options.cancellation?.signalReceived, store.read(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance)?.folders]);
                return tx.refreshSkillExportExclusions(folder, refreshOptions);
            },
        }),
    });
    const result = await supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(seen, [['function', [w.project]]]);
    assert.equal(store.read(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance), null);
    assert.equal(result.records.find(record => record.id === 'exclusions:project').outcome, 'changed');
});

test('the refresh keeps the folders an earlier update could not settle, while it runs and after it', async t => {
    const w = workspace(t);
    const kept = path.join(w.real, 'kept');
    const intent = memoryIntent(intentFor(w, [kept]));
    const seen = [];
    const [record] = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity, intent,
        refresh: (folder, options) => {
            seen.push(intent.record?.folders);
            return tx.refreshSkillExportExclusions(folder, options);
        },
    });
    assert.equal(record.outcome, 'changed');
    assert.deepEqual(seen, [[kept, w.project]]);
    assert.deepEqual(intent.record?.folders, [kept], 'the folder whose locks were not proven released stays recorded');
});

test('an update keeps a folder whose locks it could not prove released recorded, whatever else it refreshes', async t => {
    const w = workspace(t);
    const other = path.join(w.real, 'other');
    fs.mkdirSync(path.join(other, '.agents', 'skills'), { recursive: true });
    git(other, 'init', '-q', '-b', 'main');
    holdLocks(w, { pid: endedPid(), namespace: 'pid:[another-namespace]', folder: other });
    const store = createMemoryUpdateHostState();
    store.write(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance, intentFor(w, [other]));
    const { supervisor } = supervisorFor(t, w, { folders: [w.boxProject], store });
    const result = await supervisor.runUpdateTransaction(['update']);
    assert.deepEqual(result.records.filter(record => record.id.startsWith('exclusions')).map(record => [record.id, record.outcome, record.code]), [
        ['exclusions-recovery:other', 'uncertain', 'interrupted-refresh-locks-unproven'],
        ['exclusions:project', 'changed', ''],
    ]);
    assert.deepEqual(store.read(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance)?.folders, [other],
        'the unproven folder is still recorded after the refresh of another folder');
    assert.deepEqual([fs.existsSync(path.join(other, '.git', 'ploinky-skill-exports-config.lock')),
        fs.existsSync(path.join(other, '.agents', tx.EXPORT_LOCK))], [true, true]);
});

test('recovery releases only the exact lock it observed, never one another writer put there before the reclaim', t => {
    const w = workspace(t);
    holdLocks(w, { pid: endedPid() });
    const lock = configLockPath(w);
    const ownerFile = path.join(lock, 'owner.json');
    const readFileSync = fs.readFileSync;
    t.after(() => { fs.readFileSync = readFileSync; });
    let replacement = null;
    // Right after recovery reads the dead host refresh's owner, another host
    // writer reclaims that lock, takes it and dies before the reclaim follows.
    fs.readFileSync = function (file, ...rest) {
        const result = readFileSync.call(this, file, ...rest);
        if (replacement === null && file === ownerFile) {
            replacement = 'pending';
            fs.unlinkSync(ownerFile);
            fs.rmdirSync(lock);
            const self = { ...tx.currentSkillExportIdentity(), pid: endedPid(), start: '' };
            tx.acquireGitConfigLock(path.join(w.project, '.git'), {
                liveness: { current: () => self }, authority: { kind: 'ploinky-cli', operation: 'skills-export' }, waitMs: 0,
            });
            replacement = readFileSync.call(fs, ownerFile, 'utf8');
        }
        return result;
    };
    const intent = memoryIntent(intentFor(w, [w.project]));
    const { records } = recoverInterruptedHostExclusions({ intent, identity: w.identity });
    fs.readFileSync = readFileSync;
    assert.equal(JSON.parse(replacement).authority.operation, 'skills-export', "the race put another writer's dead lock there");
    assert.equal(fs.existsSync(ownerFile) && fs.readFileSync(ownerFile, 'utf8'), replacement, 'that lock is preserved');
    assert.deepEqual(records.map(record => [record.outcome, record.code]),
        [['changed', 'interrupted-refresh-locks-released'], ['uncertain', 'interrupted-refresh-locks-unproven']]);
    assert.deepEqual(records[0].details.released, [exportLockPath(w)], 'only the unchanged export lock was released');
    assert.match(records[1].reason, /Git configuration lock .* is changed-after-observation/);
    assert.deepEqual(intent.record.folders, [w.project]);
});

// A durable record whose file cannot be opened once (EMFILE), then can.
function flakyStore(w) {
    const stateRoot = path.join(w.root, 'host-state');
    const record = path.join(stateRoot, HOST_EXCLUSIONS_INTENT_KIND, `${w.identity.instance}.json`);
    const control = { failures: 0 };
    const fsApi = { ...fs, constants: fs.constants, openSync(file, ...rest) {
        if (control.failures > 0 && file === record) {
            control.failures -= 1;
            throw Object.assign(new Error(`EMFILE: too many open files, open '${file}'`), { code: 'EMFILE' });
        }
        return fs.openSync(file, ...rest);
    } };
    const store = createUpdateHostState({ stateRoot, fsApi });
    const intent = {
        read: () => store.read(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance),
        write: value => store.write(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance, value),
        remove: () => store.remove(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance),
    };
    return { control, intent, file: record, recorded: () => store.read(HOST_EXCLUSIONS_INTENT_KIND, w.identity.instance)?.folders ?? null };
}

test('a record that cannot be read now is kept and reported, never discarded, and a later update recovers from it', t => {
    const w = workspace(t);
    const pid = endedPid();
    holdLocks(w, { pid });
    const flaky = flakyStore(w);
    flaky.intent.write(intentFor(w, [w.project]));
    flaky.control.failures = 1;
    const first = recoverInterruptedHostExclusions({ intent: flaky.intent, identity: w.identity });
    assert.deepEqual(first.records.map(record => [record.id, record.outcome, record.code]),
        [['exclusions-recovery:record', 'uncertain', 'exclusions-intent-unreadable']]);
    assert.match(first.records[0].reason, /EMFILE/);
    assert.deepEqual(flaky.recorded(), [w.project], 'the record is kept');
    assert.deepEqual([fs.existsSync(configLockPath(w)), fs.existsSync(exportLockPath(w))], [true, true], 'nothing was touched');
    const second = recoverInterruptedHostExclusions({ intent: flaky.intent, identity: w.identity });
    assert.deepEqual(second.records.map(record => [record.outcome, record.code]), [['changed', 'interrupted-refresh-locks-released']]);
    assert.match(second.warnings.join('\n'), new RegExp(`\\(pid ${pid}\\) ended`));
    assert.equal(flaky.recorded(), null);
});

test('the refresh takes no lock and leaves the record alone when the record of earlier folders cannot be read', async t => {
    const w = workspace(t);
    const flaky = flakyStore(w);
    const kept = path.join(w.real, 'kept');
    flaky.intent.write(intentFor(w, [kept]));
    flaky.control.failures = 1;
    const calls = [];
    const records = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity, intent: flaky.intent,
        refresh: () => { calls.push('refresh'); return { exclusions: { status: 'published' } }; },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code, record.required]),
        [['exclusions:intent', 'uncertain', 'exclusions-intent-unreadable', false]]);
    assert.match(records[0].reason, /EMFILE/);
    assert.deepEqual(flaky.recorded(), [kept], 'the earlier folders are still recorded');
});

test('a record file that is not JSON is corrupt: reported once and removed, and a refresh that meets it records its own folders', async t => {
    const w = workspace(t);
    const flaky = flakyStore(w);
    flaky.intent.write(intentFor(w, [w.project]));
    fs.writeFileSync(flaky.file, '{ not json');
    const { records } = recoverInterruptedHostExclusions({ intent: flaky.intent, identity: w.identity });
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code]),
        [['exclusions-recovery:record', 'uncertain', 'exclusions-intent-invalid']]);
    assert.match(records[0].reason, /not valid JSON/);
    assert.equal(fs.existsSync(flaky.file), false, 'the corrupt record is removed');

    flaky.intent.write(intentFor(w, [w.project]));
    fs.writeFileSync(flaky.file, '{ not json');
    const seen = [];
    const [record] = await refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity, intent: flaky.intent,
        refresh: (folder, options) => { seen.push(flaky.recorded()); return tx.refreshSkillExportExclusions(folder, options); },
    });
    assert.equal(record.outcome, 'changed');
    assert.deepEqual(seen, [[w.project]], 'the refresh replaced the corrupt record with its own folders');
    assert.equal(flaky.recorded(), null);
});
