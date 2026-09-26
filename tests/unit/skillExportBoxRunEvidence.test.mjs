import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { boxRunLockEvidence } from '../../cli/utils/git/checkoutLock.js';
import { boxRunFromReportContext } from '../../cli/commands/updateCommand.js';
import * as tx from '../../cli/utils/skills/exportTransaction.mjs';
import { syncManagedSkillExports } from '../../cli/utils/skills/managedExports.js';
import { createSkillExclusionPlanner } from '../../cli/utils/skills/exportExclusions.mjs';

// The skill-export locks of a host-driven in-Box update bind to the Box run
// the host attests (the update context), and a later Box run proves them
// released with the same rules as the update's checkout locks: the owner ran
// in an earlier run of the acquirer's own container, or in another container
// of the same workspace and engine that no longer exists while the host lists
// the acquirer's container as the workspace's only one. Anything else stays
// unknown. A Box run is modeled by its PID-namespace identity.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = relative => pathToFileURL(path.join(projectRoot, relative)).href;
const WORKSPACE = `ploinky-box-fixture-${'f'.repeat(16)}`;
const OTHER_WORKSPACE = `ploinky-box-other-${'e'.repeat(16)}`;
const ENGINE = 'engine-store';
const X = 'a'.repeat(64);
const Y = 'c'.repeat(64);

function contextFor({ workspace = WORKSPACE, containerId, engine = ENGINE, listed = [containerId] }) {
    return {
        schema: 'ploinky-update-context', version: 1,
        workspace: { instance: workspace, workspaceRoot: '/workspace' },
        box: { containerId, engine, action: 'reused', imageId: null, workspaceContainers: listed },
    };
}

// The export-lock evidence of an in-Box update exec'd with this context.
const evidenceFor = (context, insideBox = true) => boxRunLockEvidence(boxRunFromReportContext(context, { insideBox }));

const self = tx.currentSkillExportIdentity();
const run = name => ({ current: () => ({ ...self, namespace: `pid:[${name}]` }) });

function temporary(t, label) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `skill-export-box-run-${label}-`)));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('an in-Box update binds both skill-export locks to the attested Box run; other exporters bind nothing', (t) => {
    const base = temporary(t, 'binding');
    execFileSync('git', ['init', '-q', path.join(base, 'project')]);
    const project = path.join(base, 'project');
    const runEvidence = evidenceFor(contextFor({ containerId: X }));
    const config = tx.acquireGitConfigLock(path.join(project, '.git'), { runEvidence });
    const folder = tx.acquireSkillExportLock(project, { runEvidence });
    for (const lock of [config, folder]) {
        const owner = JSON.parse(fs.readFileSync(path.join(lock.lockPath, 'owner.json'), 'utf8'));
        assert.deepEqual(owner.box, { workspace: WORKSPACE, containerId: X, engine: ENGINE });
        assert.equal(owner.pid, process.pid);
    }
    folder.release();
    config.release();
    // A process outside the Box, or without a complete attestation, binds nothing.
    for (const evidence of [evidenceFor(contextFor({ containerId: X }), false), evidenceFor(contextFor({ containerId: 'x' })), evidenceFor(null)]) {
        assert.equal(evidence, null);
        const lock = tx.acquireSkillExportLock(project, { runEvidence: evidence });
        assert.equal(JSON.parse(fs.readFileSync(path.join(lock.lockPath, 'owner.json'), 'utf8')).box, null);
        lock.release();
    }
});

test('only an ended Box run of the same workspace proves a bound export lock owner of another run dead', (t) => {
    const cases = [
        ['the same container restarted', { containerId: X }, 'dead'],
        ['the same container restarted while the host lists another one', { containerId: X, listed: [X, Y] }, 'dead'],
        ['a replacement listed as the only container', { containerId: Y }, 'dead'],
        ['a replacement while the old container is still listed', { containerId: Y, listed: [Y, X] }, 'unknown'],
        ['a replacement with an inexact listing', { containerId: Y, listed: null }, 'unknown'],
        ['a replacement in another engine', { containerId: Y, engine: 'engine-other' }, 'unknown'],
        ['a replacement whose engine is unknown', { containerId: Y, engine: '' }, 'unknown'],
        ['a Box of another workspace', { containerId: X, workspace: OTHER_WORKSPACE }, 'unknown'],
    ];
    for (const lockKind of ['folder', 'config']) {
        for (const [label, next, expected] of cases) {
            const base = temporary(t, 'rules');
            const project = path.join(base, 'project');
            execFileSync('git', ['init', '-q', project]);
            const acquire = options => (lockKind === 'folder'
                ? tx.acquireSkillExportLock(project, options)
                : tx.acquireGitConfigLock(path.join(project, '.git'), options));
            const held = acquire({ liveness: run('run-1'), runEvidence: evidenceFor(contextFor({ containerId: X })) });
            const options = { liveness: run('run-2'), runEvidence: evidenceFor(contextFor(next)) };
            assert.equal(tx.classifyLockOwner(held.owner, options), expected, `${lockKind}: ${label}`);
            if (expected === 'dead') acquire({ ...options, waitMs: 0 }).release();
            else assert.throws(() => acquire({ ...options, waitMs: 0 }), { code: 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER' }, `${lockKind}: ${label}`);
        }
    }
});

test('unbound, unattested, same-run or damaged export lock owners are never proven dead by a Box run', (t) => {
    const project = temporary(t, 'fail-closed');
    const lockPath = path.join(project, '.agents', tx.EXPORT_LOCK);
    const attested = { liveness: run('run-2'), runEvidence: evidenceFor(contextFor({ containerId: X })) };
    // An owner without a binding: a direct CLI run, Explorer, or a host process.
    tx.acquireSkillExportLock(project, { liveness: run('run-1') });
    assert.equal(tx.inspectSkillExportLock(project, attested).state, 'unknown');
    assert.equal(tx.readSkillExportTransactionState(project, attested).lock, 'unknown');
    fs.rmSync(lockPath, { recursive: true });

    const held = tx.acquireSkillExportLock(project, { liveness: run('run-1'), runEvidence: evidenceFor(contextFor({ containerId: X })) });
    // No attestation, or an update outside the Box.
    assert.equal(tx.inspectSkillExportLock(project, { liveness: run('run-2') }).state, 'unknown');
    assert.equal(tx.inspectSkillExportLock(project, { liveness: run('run-2'), runEvidence: evidenceFor(contextFor({ containerId: X }), false) }).state, 'unknown');
    // An acquirer that cannot read its own scope proves nothing.
    assert.equal(tx.inspectSkillExportLock(project, { ...attested, liveness: { current: () => ({ ...self, namespace: '' }) } }).state, 'unknown');
    // The same run: the owner process is alive, so it is busy whatever the evidence says.
    assert.equal(tx.inspectSkillExportLock(project, { ...attested, liveness: run('run-1') }).state, 'live');
    assert.throws(() => tx.acquireSkillExportLock(project, { ...attested, liveness: run('run-1'), waitMs: 0 }), { code: 'SKILL_EXPORT_LOCK_BUSY' });
    // Damaged records: no scope, no valid PID, or a malformed binding.
    const recorded = held.owner;
    for (const damaged of [
        { namespace: '' }, { boot: '' }, { pid: -1 }, { box: null },
        { box: { ...recorded.box, containerId: 'x'.repeat(64) } },
        { box: { ...recorded.box, workspace: '' } },
    ]) {
        fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({ ...recorded, ...damaged })}\n`);
        assert.equal(tx.inspectSkillExportLock(project, attested).state, 'unknown', JSON.stringify(damaged));
    }
    fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify(recorded, null, 2)}\n`);
    assert.equal(tx.readSkillExportTransactionState(project, attested).lock, 'dead');
});

// Real exporter processes. Each writes in the Box's shape: a Git target whose
// exclusions an in-Box writer defers, the production link factory and entry
// point, and the lock options the update derives from its host context. A
// hook parks the writer at a named step so SIGKILL lands exactly there.
const CHILD = String.raw`
    import fs from 'node:fs';
    const tx = await import(process.env.TX_MODULE);
    const { syncManagedSkillExports } = await import(process.env.EXPORT_MODULE);
    const { createSkillExclusionPlanner } = await import(process.env.EXCLUSIONS_MODULE);
    const { boxRunLockEvidence } = await import(process.env.CHECKOUT_LOCK_MODULE);
    const park = () => {
        fs.writeFileSync(process.env.PARKED, String(process.pid));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);
    };
    const hook = phase => ({ crash(point) { if (phase === process.env.PARK_IN && point === process.env.PARK_AT) park(); } });
    const identity = tx.currentSkillExportIdentity();
    const lock = {
        waitMs: 5000,
        runEvidence: boxRunLockEvidence(JSON.parse(process.env.BOX_RUN)),
        recoveryHooks: hook('recovery'),
        ...(process.env.RUN ? { liveness: { current: () => ({ ...identity, namespace: 'pid:[' + process.env.RUN + ']' }) } } : {}),
    };
    if (process.env.PARK_IN === 'config-lock') {
        tx.acquireGitConfigLock(process.env.COMMON_DIR, lock);
        park();
    }
    syncManagedSkillExports({
        folder: process.env.FOLDER,
        owner: 'manifest',
        sources: JSON.parse(process.env.SOURCES).map(([name, directory]) => ({ name, path: directory, source: { name: 'fixture' } })),
        claude: 'root-or-skills',
        exclusions: createSkillExclusionPlanner({ containerExecutor: true }),
        lock,
        hooks: hook('publish'),
    });
    process.stdout.write('FINISHED\n');
`;

function processFixture(t) {
    const base = temporary(t, 'process');
    const env = { ...process.env };
    for (const key of ['PLOINKY_SKILL_EXCLUDES_COMPOSE', 'GIT_DIR', 'GIT_WORK_TREE', 'NODE_TEST_CONTEXT']) delete env[key];
    fs.writeFileSync(path.join(base, 'gitconfig'), '');
    Object.assign(env, {
        HOME: base, XDG_CONFIG_HOME: path.join(base, 'xdg'), GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
        PLOINKY_WORKSPACE_ROOT: base,
        TX_MODULE: moduleUrl('cli/utils/skills/exportTransaction.mjs'),
        EXPORT_MODULE: moduleUrl('cli/utils/skills/managedExports.js'),
        EXCLUSIONS_MODULE: moduleUrl('cli/utils/skills/exportExclusions.mjs'),
        CHECKOUT_LOCK_MODULE: moduleUrl('cli/utils/git/checkoutLock.js'),
    });
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    const git = (...args) => execFileSync('git', args, { cwd: project, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const userFiles = { 'README.md': '# user readme\n', '.gitignore': 'node_modules\n' };
    for (const [relative, content] of Object.entries(userFiles)) fs.writeFileSync(path.join(project, relative), content);
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    fs.mkdirSync(path.join(project, '.agents', 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(project, '.agents', 'skills', 'mine', 'SKILL.md'), '# mine\n');
    fs.writeFileSync(path.join(project, 'notes.txt'), 'untracked user notes\n');
    const sources = ['alpha', 'beta'].map(name => {
        const directory = path.join(base, 'sources', name);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'SKILL.md'), `# ${name}\n`);
        return [name, directory];
    });
    const configBefore = fs.readFileSync(path.join(project, '.git', 'config'));
    const writer = async ({ runName = '', context, parkIn, parkAt = '' }) => {
        const parked = path.join(base, `parked-${runName || 'real'}-${parkIn}-${parkAt}`);
        const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
            cwd: base,
            env: {
                ...env, FOLDER: project, COMMON_DIR: path.join(project, '.git'), SOURCES: JSON.stringify(sources),
                BOX_RUN: JSON.stringify(boxRunFromReportContext(context, { insideBox: true })),
                RUN: runName, PARK_IN: parkIn, PARK_AT: parkAt, PARKED: parked,
            },
            detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
        t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} });
        const deadline = Date.now() + 30_000;
        while (!fs.existsSync(parked)) {
            const early = await Promise.race([exited, delay(20).then(() => null)]);
            if (early) assert.fail(`the writer exited before it parked at ${parkIn}/${parkAt}: ${JSON.stringify(early)}\n${output}`);
            if (Date.now() > deadline) assert.fail(`the writer did not park at ${parkIn}/${parkAt}:\n${output}`);
        }
        process.kill(-child.pid, 'SIGKILL');
        assert.equal((await exited).signal, 'SIGKILL');
        return child.pid;
    };
    const nextRun = (name, context, extra = {}) => syncManagedSkillExports({
        folder: project, owner: 'manifest',
        sources: sources.map(([name, directory]) => ({ name, path: directory, source: { name: 'fixture' } })),
        claude: 'root-or-skills',
        exclusions: createSkillExclusionPlanner({ containerExecutor: true }),
        lock: { waitMs: 200, liveness: run(name), runEvidence: context ? evidenceFor(context) : null, ...extra },
    });
    const owner = relative => JSON.parse(fs.readFileSync(path.join(project, relative, 'owner.json'), 'utf8'));
    const assertRecovered = () => {
        assert.deepEqual(['.git/ploinky-skill-exports-config.lock', `.agents/${tx.EXPORT_LOCK}`, `.agents/${tx.EXPORT_JOURNAL}`, `.agents/${tx.EXPORT_QUARANTINE}`]
            .filter(relative => fs.existsSync(path.join(project, relative))), [], 'no lock, journal or quarantine is left');
        assert.deepEqual(fs.readdirSync(path.join(project, '.agents', tx.EXPORT_STAGING)), [], 'no staging is left');
        const { ledger } = tx.readExportLedger(path.join(project, '.agents'));
        assert.deepEqual(Object.keys(ledger.entries).sort(), ['alpha', 'beta']);
        for (const [name, directory] of sources) {
            assert.equal(ledger.entries[name].owner, 'manifest');
            assert.equal(fs.realpathSync(path.join(project, '.agents', 'skills', name)), fs.realpathSync(directory));
        }
        assert.deepEqual(fs.readdirSync(path.join(project, '.agents', 'skills')).sort(), ['alpha', 'beta', 'mine']);
        assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'no tracked file changed');
        for (const [relative, content] of Object.entries({ ...userFiles, 'notes.txt': 'untracked user notes\n', '.agents/skills/mine/SKILL.md': '# mine\n' })) {
            assert.equal(fs.readFileSync(path.join(project, relative), 'utf8'), content, relative);
        }
        assert.ok(fs.readFileSync(path.join(project, '.git', 'config')).equals(configBefore), 'Git config is unchanged');
        assert.deepEqual(['index.lock', 'config.lock', 'config.worktree.lock'].filter(name => fs.existsSync(path.join(project, '.git', name))), []);
    };
    return { base, project, writer, nextRun, owner, assertRecovered };
}

test('a writer SIGKILLed after its metadata journal is rolled forward only by the next attested Box run', async (t) => {
    const f = processFixture(t);
    const pid = await f.writer({ context: contextFor({ containerId: X }), parkIn: 'publish', parkAt: 'after-metadata-journal' });
    for (const relative of ['.git/ploinky-skill-exports-config.lock', `.agents/${tx.EXPORT_LOCK}`]) {
        assert.equal(f.owner(relative).pid, pid);
        assert.deepEqual(f.owner(relative).box, { workspace: WORKSPACE, containerId: X, engine: ENGINE });
    }
    assert.equal(tx.readSkillExportTransactionState(f.project).pending.phase, 'metadata');
    assert.throws(() => f.nextRun('run-2', null), { code: 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER' });
    assert.throws(() => f.nextRun('run-2', contextFor({ containerId: Y, listed: [Y, X] })), { code: 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER' });
    assert.equal(tx.readSkillExportTransactionState(f.project).pending.phase, 'metadata', 'nothing was recovered without proof');

    // The Box was replaced: the host lists the new container as the only one.
    const result = f.nextRun('run-2', contextFor({ containerId: Y }));
    assert.equal(result.recovery.status, 'rolled-forward');
    assert.equal(result.transaction.status, 'unchanged', 'the recovered state is already the desired state');
    f.assertRecovered();
});

test('a writer SIGKILLed during journal recovery in the next Box run is recovered by the run after it', async (t) => {
    const f = processFixture(t);
    await f.writer({ context: contextFor({ containerId: X }), parkIn: 'publish', parkAt: 'after-metadata-journal' });
    // Run 2 of the same container reclaims both locks and is SIGKILLed while
    // it redoes the committed transaction.
    const second = await f.writer({ runName: 'run-2', context: contextFor({ containerId: X }), parkIn: 'recovery', parkAt: 'after-ledger' });
    for (const relative of ['.git/ploinky-skill-exports-config.lock', `.agents/${tx.EXPORT_LOCK}`]) {
        assert.equal(f.owner(relative).pid, second);
        assert.equal(f.owner(relative).namespace, 'pid:[run-2]');
    }
    assert.equal(tx.readSkillExportTransactionState(f.project).pending.phase, 'metadata', 'the interrupted recovery left the transaction pending');
    assert.throws(() => f.nextRun('run-3', null), { code: 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER' });
    const result = f.nextRun('run-3', contextFor({ containerId: X }));
    assert.equal(result.recovery.status, 'rolled-forward');
    f.assertRecovered();
});

test('a lone common Git configuration lock of a SIGKILLed writer is reclaimed only with the attestation', async (t) => {
    const f = processFixture(t);
    await f.writer({ context: contextFor({ containerId: X }), parkIn: 'config-lock' });
    const commonDir = path.join(f.project, '.git');
    assert.throws(() => tx.acquireGitConfigLock(commonDir, { waitMs: 0, liveness: run('run-2') }), { code: 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER' });
    const lock = tx.acquireGitConfigLock(commonDir, { waitMs: 0, liveness: run('run-2'), runEvidence: evidenceFor(contextFor({ containerId: X })) });
    lock.release();
    assert.deepEqual(fs.readdirSync(commonDir).filter(name => name.startsWith('ploinky-skill-exports-config.lock')), []);
});

test('staging of a writer SIGKILLed before its journal is collected once its Box run is proven ended', async (t) => {
    const f = processFixture(t);
    await f.writer({ context: contextFor({ containerId: X }), parkIn: 'publish', parkAt: 'before-journal' });
    const staged = fs.readdirSync(path.join(f.project, '.agents', tx.EXPORT_STAGING));
    assert.equal(staged.length, 1);
    assert.equal(tx.readSkillExportTransactionState(f.project).pending, null, 'no journal was written');
    const result = f.nextRun('run-2', contextFor({ containerId: X }));
    assert.equal(result.recovery, undefined, 'there was nothing to recover');
    assert.equal(result.transaction.status, 'committed');
    assert.deepEqual(result.retention.staging.collected, staged);
    f.assertRecovered();
});
