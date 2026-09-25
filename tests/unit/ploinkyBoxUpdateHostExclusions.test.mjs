import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { createSkillExclusionPlanner } from '../../cli/utils/skills/exportExclusions.mjs';
import * as tx from '../../cli/utils/skills/exportTransaction.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { refreshDeferredHostExclusions } from '../../ploinky-box/update/hostExclusions.mjs';
import { createMemoryUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
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
    const [record] = refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.phase, record.id, record.outcome, record.required], ['skills-manifest', 'exclusions:project', 'changed', false]);
    assert.equal(record.details.folder, w.project, 'the refresh ran on the canonical host folder');
    assert.equal(status(w.project), '', 'the private worktree exclusion is effective on the host');
    assert.equal(fs.existsSync(path.join(w.project, '.gitignore')), false);
    assert.equal(fs.readFileSync(path.join(w.project, '.agents', '.ploinky-skill-exports.json'), 'utf8'), ledger,
        'exclusions only: no skill publication');
    const [again] = refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.equal(again.outcome, 'unchanged');
});

test('a live external excludes policy stays deferred with its code', async (t) => {
    const w = workspace(t);
    fs.mkdirSync(path.dirname(xdgIgnore), { recursive: true });
    fs.writeFileSync(xdgIgnore, '*.log\n');
    const [record] = refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['deferred', 'exclusions-deferred']);
    assert.match(status(w.project), /\?\? \.agents\//, 'nothing was written');
});

test('escaping, unclean, missing and linked-out folders are refused before any refresh', async (t) => {
    const w = workspace(t);
    const outside = path.join(w.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(w.real, 'link-out'), 'dir');
    const calls = [];
    const records = refreshDeferredHostExclusions({
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
    const records = refreshDeferredHostExclusions({
        folders: [`${root}/project`, `${root}/project`, `${root}/a`, `${root}/b`],
        identity: w.identity,
        refresh,
        limit: 2,
    });
    assert.deepEqual(calls, [path.join(w.real, 'a'), path.join(w.real, 'b')], 'sorted, unique, bounded');
    const overflow = records.find(record => record.id === 'exclusions:overflow');
    assert.deepEqual([overflow.outcome, overflow.code, overflow.required], ['uncertain', 'deferred-exclusion-folders-exceeded', false]);
    assert.deepEqual(refreshDeferredHostExclusions({ folders: 'not-a-list', identity: w.identity }).map(record => record.code),
        ['deferred-exclusion-folders-invalid']);
    assert.deepEqual(refreshDeferredHostExclusions({ identity: w.identity }), []);
    const thrown = refreshDeferredHostExclusions({
        folders: [`${root}/a`], identity: w.identity,
        refresh: () => { throw Object.assign(new Error('export lock is held'), { code: 'EXPORT_LOCK_BLOCKED' }); },
    });
    assert.deepEqual([thrown[0].outcome, thrown[0].code], ['failed', 'EXPORT_LOCK_BLOCKED']);
});

function supervisorFor(t, w, { folders, refresh = undefined }) {
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
        updateHostState: createMemoryUpdateHostState(),
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
            onCall() { events.push('core-update'); },
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
    const [record] = refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['deferred', 'git-directory-outside-boundary']);
    assert.equal(fs.readFileSync(path.join(victim, '.git', 'config'), 'utf8'), victimConfig, 'victim config untouched');
    assert.deepEqual(fs.readdirSync(path.join(victim, '.git')).filter(name => name.startsWith('ploinky') || name === 'config.worktree'), []);
});

test('host refresh preserves a symlinked Git configuration without writing its target', t => {
    const w = workspace(t);
    const config = path.join(w.project, '.git', 'config');
    const outside = path.join(w.root, 'outside-config');
    const before = fs.readFileSync(config);
    fs.writeFileSync(outside, before);
    fs.unlinkSync(config);
    fs.symlinkSync(outside, config);
    const [record] = refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['deferred', 'git-metadata-not-private-regular']);
    assert.deepEqual(fs.readFileSync(outside), before);
    assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(w.project, '.git', tx.GIT_CONFIG_LOCK || 'ploinky-skill-exports-config.lock')), false);
});

test('host refresh refuses pending recovery before inspecting journal-selected lock locations', t => {
    const w = workspace(t);
    const outside = path.join(w.root, 'outside-metadata');
    fs.mkdirSync(outside);
    const journal = path.join(w.project, '.agents', tx.EXPORT_JOURNAL);
    const bytes = JSON.stringify({ protocol: tx.EXPORT_PROTOCOL, config: { identity: { commonDir: outside } } });
    fs.writeFileSync(journal, bytes);
    const [record] = refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
    assert.deepEqual([record.outcome, record.code], ['uncertain', 'SKILL_EXPORT_RECOVERY_REQUIRED']);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.equal(fs.readFileSync(journal, 'utf8'), bytes);
    assert.equal(fs.existsSync(path.join(w.project, '.agents', tx.EXPORT_LOCK)), false);
});

test('host refresh defers repository Git includes before loading their policy', t => {
    const w = workspace(t);
    const config = path.join(w.project, '.git', 'config');
    fs.appendFileSync(config, '\n[include]\n    path = ../absent-policy\n');
    const before = fs.readFileSync(config);
    const [record] = refreshDeferredHostExclusions({ folders: [w.boxProject], identity: w.identity });
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

test('a host refresh whose lock release fails is failed when settled and uncertain when its result needs recovery', t => {
    const w = workspace(t);
    const liveness = strayLockLiveness(w.project);
    const lock = path.join(w.project, '.agents', tx.EXPORT_LOCK);
    // The real refresh publishes and settles its exclusions, then the release fails.
    const [settled] = refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity,
        refresh: (folder, options) => tx.refreshSkillExportExclusions(folder, { ...options, lock: { liveness } }),
    });
    assert.deepEqual([settled.outcome, settled.code], ['failed', 'SKILL_EXPORT_LOCK_RELEASE_FAILED']);
    assert.equal(status(w.project), '', 'the settled exclusions were published before the release failed');
    fs.rmSync(lock, { recursive: true });
    // The same release failure after a completed result that still needs
    // recovery keeps that result's uncertain outcome.
    const quarantined = { id: '00000000-0000-4000-8000-000000000000', status: 'quarantined', unexpected: [{ name: 'receipt' }] };
    const [uncertain] = refreshDeferredHostExclusions({
        folders: [w.boxProject], identity: w.identity,
        refresh: folder => tx.withSkillExportLocks([folder], ([handle]) => ({ folder: handle.root, exclusions: { status: 'preserved' }, transaction: quarantined, recovery: handle.recovery }), { liveness }),
    });
    assert.deepEqual([uncertain.outcome, uncertain.code], ['uncertain', 'SKILL_EXPORT_RECOVERY_REQUIRED']);
    assert.equal(uncertain.details.errorCode, 'SKILL_EXPORT_LOCK_RELEASE_FAILED');
    assert.deepEqual(uncertain.details.transaction, quarantined);
    assert.match(uncertain.reason, /transaction quarantined.*lock could not be released/s);
    fs.rmSync(lock, { recursive: true });
});
