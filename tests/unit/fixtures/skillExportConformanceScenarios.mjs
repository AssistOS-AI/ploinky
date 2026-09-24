// Shared conformance scenarios for the skill export transaction protocol.
// Ploinky keeps this file at tests/unit/fixtures/skillExportConformanceScenarios.mjs
// and Explorer a byte-identical copy at
// explorer/tests/unit/skillExportConformanceScenarios.mjs. Each scenario
// receives one copy of the protocol module; both repositories run the table.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const identity = pid => ({ pid, start: `start-${pid}`, boot: 'boot-a', namespace: 'pidns-a', hostname: 'host-a', container: false });

// Injected liveness: `self` is the acting process, `dead` the processes with
// affirmative same-namespace termination evidence.
export function liveness(self, dead = [], starts = {}) {
    const gone = new Set(dead);
    return {
        current: () => identity(self),
        alive: pid => !gone.has(pid),
        start: pid => starts[pid] ?? `start-${pid}`,
    };
}

export function simulatedCrash(mod, point) {
    return {
        crash(current) {
            if (current === point) throw Object.assign(new Error(`simulated crash at ${point}`), { [mod.SIMULATED_CRASH]: true });
        },
    };
}

function write(file, content, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (mode) fs.chmodSync(file, mode);
}

function skillSource(base, name, content) {
    const directory = path.join(base, 'sources', name);
    write(path.join(directory, 'SKILL.md'), `# ${content}\n`);
    return directory;
}

// Idempotent, like the real managed-block update.
const addGenerated = content => content.includes('generated\n') ? content : `${content}generated\n`;
const lstat = target => fs.lstatSync(target, { throwIfNoEntry: false });
const read = target => lstat(target) ? fs.readFileSync(target, 'utf8') : null;

function ledgerOf(folder) {
    const text = read(path.join(folder, '.agents', '.ploinky-skill-exports.json'));
    return text === null ? null : JSON.parse(text);
}

function crashFixture(mod, tmp) {
    const base = tmp('crash');
    const folder = path.join(base, 'target');
    fs.mkdirSync(folder);
    const sources = {
        keep: skillSource(base, 'keep', 'keep'),
        replace: skillSource(base, 'replace', 'replace v1'),
        drop: skillSource(base, 'drop', 'drop'),
        fresh: skillSource(base, 'fresh', 'fresh'),
    };
    const entry = name => ({ name, path: sources[name], source: { name: 'fixture' } });
    const manifest = path.join(folder, 'manifest.json');
    write(manifest, 'v1\n');
    const run = (self, extra = {}) => mod.syncManagedSkillExports({
        folder, owner: 'manifest', lock: { liveness: liveness(self, extra.dead || []), waitMs: 0 },
        sources: (extra.names || ['keep', 'replace', 'fresh']).map(entry),
        manifest: extra.manifest === undefined ? { path: manifest, expected: read(manifest), next: 'v2\n' } : extra.manifest,
        claude: extra.claude === undefined ? 'root-or-skills' : extra.claude,
        gitignore: extra.gitignore === undefined ? { update: addGenerated } : extra.gitignore,
        hooks: extra.hooks || {},
    });
    // Establish the prior committed state without the later artifacts.
    run(100, { names: ['keep', 'replace', 'drop'], manifest: null, claude: null, gitignore: null });
    write(path.join(sources.replace, 'SKILL.md'), '# replace v2\n');
    const skills = path.join(folder, '.agents', 'skills');
    const before = {
        ledger: read(path.join(folder, '.agents', '.ploinky-skill-exports.json')),
        replace: mod.skillTreeDigest(path.join(skills, 'replace')),
    };
    return { base, folder, sources, manifest, run, skills, before };
}

function assertBeforeState(mod, fixture) {
    const { folder, skills, manifest, before } = fixture;
    assert.equal(read(path.join(folder, '.agents', '.ploinky-skill-exports.json')), before.ledger);
    assert.equal(mod.skillTreeDigest(path.join(skills, 'replace')), before.replace);
    assert.equal(read(path.join(skills, 'replace', 'SKILL.md')), '# replace v1\n');
    assert.ok(lstat(path.join(skills, 'drop')));
    assert.equal(lstat(path.join(skills, 'fresh')), undefined);
    assert.equal(read(manifest), 'v1\n');
    assert.equal(lstat(path.join(folder, '.claude')), undefined);
    assert.equal(lstat(path.join(folder, '.gitignore')), undefined);
}

function assertAfterState(mod, fixture) {
    const { folder, skills, manifest } = fixture;
    const ledger = ledgerOf(folder);
    assert.deepEqual(Object.keys(ledger.entries).sort(), ['fresh', 'keep', 'replace']);
    assert.equal(read(path.join(skills, 'replace', 'SKILL.md')), '# replace v2\n');
    assert.equal(ledger.entries.replace.digest, mod.skillTreeDigest(path.join(skills, 'replace')));
    assert.equal(read(path.join(skills, 'fresh', 'SKILL.md')), '# fresh\n');
    assert.equal(lstat(path.join(skills, 'drop')), undefined);
    assert.equal(read(manifest), 'v2\n');
    assert.equal(fs.readlinkSync(path.join(folder, '.claude')), '.agents');
    assert.equal(read(path.join(folder, '.gitignore')), 'generated\n');
}

const recoverWith = (mod, folder, self, dead) => mod.withSkillExportLocks([folder], ([handle]) => handle.recovery, { liveness: liveness(self, dead), waitMs: 0 });

const GIT_ISOLATION = ['XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

const ROLLED_BACK = new Set(['before-journal', 'after-journal', 'after-backup', 'after-link', 'before-metadata']);

// Every entry below the folder: type plus bytes or link text.
function snapshot(root) {
    const result = {};
    const visit = (target, relative) => {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) result[relative] = `link:${fs.readlinkSync(target)}`;
        else if (stat.isFile()) result[relative] = `file:${fs.readFileSync(target, 'utf8')}`;
        else {
            result[relative] = 'dir';
            for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), path.join(relative, name));
        }
    };
    visit(root, '.');
    return result;
}

function craftedJournalFixture(mod, tmp) {
    const base = tmp('crafted');
    const folder = path.join(base, 'target');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside);
    write(path.join(folder, 'README.md'), 'readme\n');
    const demo = skillSource(base, 'demo', 'demo');
    mod.syncManagedSkillExports({ folder, owner: 'manifest', mode: 'symlink', sources: [{ name: 'demo', path: demo }], lock: { liveness: liveness(10) } });
    const transaction = crypto.randomUUID();
    const staging = path.join('.agents', '.ploinky-export-staging', `tx-${transaction}`);
    const link = { type: 'symlink', target: fs.readlinkSync(path.join(folder, '.agents', 'skills', 'demo')), digest: mod.skillTreeDigest(path.join(folder, '.agents', 'skills', 'demo')) };
    const journal = extra => ({
        protocol: mod.EXPORT_PROTOCOL, version: mod.EXPORT_PROTOCOL_VERSION, kind: 'pending-skill-export', transaction,
        lockToken: 'crafted', owner: 'manifest', policy: 'sync', folder, createdAt: new Date(0).toISOString(), phase: 'prepared',
        staging, ledger: { before: { type: 'absent' } }, config: { before: null, after: null }, paths: [], artifacts: [], ...extra,
    });
    const install = (destination, extra = {}) => ({ name: 'demo', action: 'install', destination, before: { type: 'absent' }, after: link, staged: null, backup: null, outcome: 'published', ...extra });
    return { base, folder, outside, transaction, staging, link, journal, install };
}

const CRAFTED_JOURNALS = [
    ['staging at the export root', f => f.journal({ staging: '.' })],
    ['staging at the skills directory', f => f.journal({ staging: path.join('.agents', 'skills') })],
    ['a destination outside the skills directory', f => f.journal({ paths: [f.install('README.md')] })],
    ['a backup outside the backups directory', f => f.journal({ paths: [f.install(path.join('.agents', 'skills', 'demo'), { action: 'replace', before: f.link, after: { type: 'absent' }, backup: path.join('.agents', 'skills', 'demo') })] })],
    ['a staged path outside its staging directory', f => f.journal({ paths: [f.install(path.join('.agents', 'skills', 'demo'), { staged: 'README.md' })] })],
    ['a gitignore artifact at another path', f => f.journal({ phase: 'metadata', artifacts: [{ kind: 'gitignore', path: path.join('src', 'x'), before: { type: 'absent' }, after: { type: 'file', digest: 'x' }, staged: path.join(f.staging, 'artifact-gitignore'), mode: 420 }] })],
    ['an unknown artifact kind', f => f.journal({ phase: 'metadata', artifacts: [{ kind: 'script', path: 'run.sh', before: { type: 'absent' }, after: { type: 'file', digest: 'x' }, staged: path.join(f.staging, 'artifact-script') }] })],
    ['a claude link to another target', f => f.journal({ phase: 'metadata', artifacts: [{ kind: 'claude', path: '.claude', before: { type: 'absent' }, after: { type: 'symlink', target: f.outside } }] })],
    ['a backups root planted as a symlink', f => {
        fs.rmSync(path.join(f.folder, '.agents', '.ploinky-export-backups'), { recursive: true, force: true });
        fs.symlinkSync(f.outside, path.join(f.folder, '.agents', '.ploinky-export-backups'));
        return f.journal({ paths: [f.install(path.join('.agents', 'skills', 'demo'), { action: 'replace', before: f.link, after: { type: 'absent' }, backup: path.join('.agents', '.ploinky-export-backups', `demo-prior-tx-${f.transaction}`) })] });
    }],
    ['an unknown phase', f => f.journal({ phase: 'committed' })],
];

export const scenarios = [
    {
        name: 'the lock is a directory with an exact owner record and blocks mkdir-only exporters',
        run({ mod, tmp }) {
            const folder = tmp('lock');
            const handle = mod.acquireSkillExportLock(folder, { liveness: liveness(10), authority: { kind: 'test' }, executor: { box: 'box-1' } });
            const lockPath = path.join(fs.realpathSync(folder), '.agents', '.ploinky-skill-exports.lock');
            assert.ok(fs.lstatSync(lockPath).isDirectory());
            const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
            assert.equal(owner.protocol, mod.EXPORT_PROTOCOL);
            assert.equal(owner.version, mod.EXPORT_PROTOCOL_VERSION);
            assert.equal(owner.token, handle.token);
            assert.equal(owner.folder, fs.realpathSync(folder));
            assert.match(owner.folderId, /^\d+:\d+$/);
            assert.deepEqual([owner.pid, owner.start, owner.boot, owner.namespace], [10, 'start-10', 'boot-a', 'pidns-a']);
            assert.deepEqual(owner.executor, { box: 'box-1' });
            assert.deepEqual(owner.authority, { kind: 'test' });
            // The pre-transaction exporter used a bare mkdir on the same path.
            assert.throws(() => fs.mkdirSync(lockPath), { code: 'EEXIST' });
            handle.release();
            assert.equal(lstat(lockPath), undefined);
        },
    },
    {
        name: 'a live owner blocks with a named busy outcome after the bounded wait',
        run({ mod, tmp }) {
            const folder = tmp('busy');
            const held = mod.acquireSkillExportLock(folder, { liveness: liveness(10) });
            const started = Date.now();
            assert.throws(() => mod.acquireSkillExportLock(folder, { liveness: liveness(11), waitMs: 60, pollMs: 10 }),
                error => error.code === 'SKILL_EXPORT_LOCK_BUSY' && error.outcome === 'blocked-busy' && /already active/.test(error.message));
            assert.ok(Date.now() - started >= 50, 'the wait is bounded, not immediate');
            held.release();
            mod.acquireSkillExportLock(folder, { liveness: liveness(11), waitMs: 0 }).release();
        },
    },
    {
        name: 'ownerless legacy locks and other-namespace owners are preserved, never reclaimed',
        run({ mod, tmp }) {
            const folder = tmp('legacy');
            const lockPath = path.join(fs.realpathSync(folder), '.agents', '.ploinky-skill-exports.lock');
            fs.mkdirSync(lockPath, { recursive: true });
            fs.utimesSync(lockPath, new Date(0), new Date(0));
            assert.throws(() => mod.acquireSkillExportLock(folder, { liveness: liveness(10), waitMs: 20, pollMs: 5 }),
                error => error.code === 'SKILL_EXPORT_LOCK_OWNERLESS' && error.outcome === 'blocked-legacy-lock');
            assert.ok(fs.lstatSync(lockPath).isDirectory(), 'an old ownerless lock is not reclaimed by age');
            fs.rmdirSync(lockPath);

            const foreign = mod.acquireSkillExportLock(folder, { liveness: { ...liveness(10), current: () => ({ ...identity(10), boot: 'boot-b' }) } });
            // Local PID absence is not evidence for another boot or namespace.
            assert.throws(() => mod.acquireSkillExportLock(folder, { liveness: liveness(11, [10]), waitMs: 0 }),
                error => error.code === 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER' && error.outcome === 'blocked-unknown-owner');
            assert.equal(mod.inspectSkillExportLock(folder, { liveness: liveness(11, [10]) }).state, 'unknown');
            assert.ok(fs.existsSync(path.join(lockPath, 'owner.json')));
            assert.equal(foreign.token, JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token);
        },
    },
    {
        name: 'same-namespace death or PID reuse is affirmative evidence for reclaim',
        run({ mod, tmp }) {
            const folder = tmp('dead');
            mod.acquireSkillExportLock(folder, { liveness: liveness(10) });
            const reclaimed = mod.acquireSkillExportLock(folder, { liveness: liveness(11, [10]), waitMs: 0 });
            reclaimed.release();
            mod.acquireSkillExportLock(folder, { liveness: liveness(12) });
            // PID 12 is alive again but started at another time: reused PID.
            const reused = mod.acquireSkillExportLock(folder, { liveness: liveness(13, [], { 12: 'start-other' }), waitMs: 0 });
            reused.release();
        },
    },
    {
        name: 'a pending reclaim or a fresh lock appearing mid-reclaim is never removed',
        run({ mod, tmp }) {
            const folder = tmp('reclaim');
            mod.acquireSkillExportLock(folder, { liveness: liveness(10) });
            const lockPath = path.join(fs.realpathSync(folder), '.agents', '.ploinky-skill-exports.lock');
            fs.mkdirSync(path.join(lockPath, '.reclaim'));
            assert.throws(() => mod.acquireSkillExportLock(folder, { liveness: liveness(11, [10]), waitMs: 0 }),
                error => error.code === 'SKILL_EXPORT_LOCK_RECOVERY_REQUIRED');
            fs.rmdirSync(path.join(lockPath, '.reclaim'));

            let fresh = null;
            const hooks = {
                beforeReclaim() {
                    if (fresh) return;
                    // Another exporter reclaims first and takes a new lock.
                    fs.unlinkSync(path.join(lockPath, 'owner.json'));
                    fs.rmdirSync(lockPath);
                    fresh = mod.acquireSkillExportLock(folder, { liveness: liveness(12, [10]) });
                },
            };
            assert.throws(() => mod.acquireSkillExportLock(folder, { liveness: liveness(11, [10]), waitMs: 0, hooks }),
                error => error.code === 'SKILL_EXPORT_LOCK_BUSY');
            assert.equal(JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')).token, fresh.token);
            fresh.release();
        },
    },
    {
        name: 'release requires the same token and lock inode',
        run({ mod, tmp }) {
            const folder = tmp('release');
            const handle = mod.acquireSkillExportLock(folder, { liveness: liveness(10) });
            const lockPath = handle.lockPath;
            const owner = fs.readFileSync(path.join(lockPath, 'owner.json'));
            fs.renameSync(lockPath, `${lockPath}.moved`);
            fs.mkdirSync(lockPath);
            fs.writeFileSync(path.join(lockPath, 'owner.json'), owner);
            assert.throws(() => handle.release(), error => error.code === 'SKILL_EXPORT_LOCK_LOST');
            assert.ok(fs.existsSync(path.join(lockPath, 'owner.json')), 'a lock with another inode is not removed');
        },
    },
    ...mapCrashPoints(),
    ...CRAFTED_JOURNALS.map(([label, craft]) => ({
        name: `recovery refuses a journal with ${label} and changes nothing`,
        run({ mod, tmp }) {
            const f = craftedJournalFixture(mod, tmp);
            const journal = craft(f);
            write(path.join(f.folder, '.agents', '.ploinky-skill-exports.journal.json'), `${JSON.stringify(journal)}\n`);
            const before = snapshot(f.base);
            assert.throws(() => recoverWith(mod, f.folder, 11, []), error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED');
            assert.deepEqual(snapshot(f.base), before);
            assert.throws(() => mod.syncManagedSkillExports({ folder: f.folder, owner: 'manifest', sources: [], lock: { liveness: liveness(11) } }),
                error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED', 'new publication stays blocked');
            assert.deepEqual(snapshot(f.base), before);
        },
    })),
    {
        name: 'private exclusion artifacts roll forward after a crash and leave a clean worktree',
        run({ mod, tmp, exclusions }) {
            assert.ok(exclusions, 'the paired exclusions module is required');
            const base = tmp('exclusions');
            const saved = Object.fromEntries(GIT_ISOLATION.map(key => [key, process.env[key]]));
            fs.writeFileSync(path.join(base, 'gitconfig'), '');
            Object.assign(process.env, {
                XDG_CONFIG_HOME: path.join(base, 'xdg'), GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
                GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
            });
            try {
                const project = path.join(base, 'project');
                fs.mkdirSync(project);
                const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
                git('init', '-q');
                write(path.join(project, 'README.md'), 'x\n');
                git('add', 'README.md');
                git('commit', '-q', '-m', 'initial');
                const source = skillSource(base, 'demo', 'demo');
                const sync = (self, extra = {}) => mod.syncManagedSkillExports({
                    folder: project, owner: 'manifest', mode: 'symlink', claude: 'root-or-skills', sources: [{ name: 'demo', path: source }],
                    exclusions: exclusions.createSkillExclusionPlanner(), lock: { liveness: liveness(self, extra.dead || []) }, hooks: extra.hooks || {},
                });
                assert.throws(() => sync(200, { hooks: simulatedCrash(mod, 'after-git-config') }), /simulated crash/);
                assert.match(git('status', '--porcelain'), /\?\? /, 'publication stopped part-way');
                const recovered = mod.withSkillExportLocks([project], ([handle]) => handle.recovery,
                    { liveness: liveness(300, [200]), exclusions: exclusions.createSkillExclusionPlanner() });
                assert.equal(recovered.status, 'rolled-forward');
                assert.equal(git('status', '--porcelain'), '');
                assert.equal(sync(300).transaction.status, 'unchanged');
            } finally {
                for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
            }
        },
    },
    {
        name: 'recovery never writes a manifest outside the export folder',
        run({ mod, tmp }) {
            const f = craftedJournalFixture(mod, tmp);
            const target = path.join(f.outside, 'created-by-recovery');
            const staged = path.join(f.staging, 'artifact-manifest');
            write(path.join(f.folder, staged), 'payload\n');
            const digest = crypto.createHash('sha256').update('payload\n').digest('hex');
            write(path.join(f.folder, '.agents', '.ploinky-skill-exports.journal.json'), `${JSON.stringify(f.journal({
                phase: 'metadata', artifacts: [{ kind: 'manifest', path: target, before: { type: 'absent' }, after: { type: 'file', digest }, staged, mode: 420 }],
            }))}\n`);
            const recovery = recoverWith(mod, f.folder, 11, []);
            assert.equal(recovery.status, 'quarantined');
            assert.deepEqual(recovery.unexpected.map(item => item.reason), ['manifest-outside-folder-preserved']);
            assert.equal(lstat(target), undefined);
        },
    },
    {
        name: 'recovery quarantines a transaction whose published output was edited and keeps the edit',
        run({ mod, tmp }) {
            const fixture = crashFixture(mod, tmp);
            assert.throws(() => fixture.run(200, { hooks: simulatedCrash(mod, 'after-link') }), /simulated crash/);
            const replace = path.join(fixture.skills, 'replace');
            write(path.join(replace, 'human.txt'), 'human bytes');
            const recovery = recoverWith(mod, fixture.folder, 300, [200]);
            assert.equal(recovery.status, 'quarantined');
            assert.equal(recovery.direction, 'back');
            assert.equal(read(path.join(replace, 'human.txt')), 'human bytes');
            const state = mod.readSkillExportTransactionState(fixture.folder, { liveness: liveness(300) });
            assert.equal(state.pending, null);
            assert.equal(state.quarantined.length, 1);
            assert.equal(state.quarantined[0].reasons[0].name, 'replace');
            // The prior output stays retained; the ledger keeps its prior record.
            assert.equal(ledgerOf(fixture.folder).entries.replace.digest, fixture.before.ledger && JSON.parse(fixture.before.ledger).entries.replace.digest);
            const next = fixture.run(300, { manifest: null, claude: null, gitignore: null });
            assert.ok(next.diagnostics.some(item => item.name === 'replace' && item.reason === 'edited-output-preserved'));
            assert.equal(read(path.join(replace, 'human.txt')), 'human bytes');
            assert.ok(next.retention.staging.retained.some(item => item.reason === 'journal-referenced'), 'quarantined staging stays referenced');
        },
    },
    {
        name: 'roll-forward preserves a manifest edited after the commit point',
        run({ mod, tmp }) {
            const fixture = crashFixture(mod, tmp);
            assert.throws(() => fixture.run(200, { hooks: simulatedCrash(mod, 'after-ledger') }), /simulated crash/);
            write(fixture.manifest, 'human manifest\n');
            const recovery = recoverWith(mod, fixture.folder, 300, [200]);
            assert.equal(recovery.status, 'quarantined');
            assert.equal(recovery.direction, 'forward');
            assert.equal(read(fixture.manifest), 'human manifest\n');
            assert.deepEqual(Object.keys(ledgerOf(fixture.folder).entries).sort(), ['fresh', 'keep', 'replace']);
        },
    },
    {
        name: 'a concurrent manifest change fails the transaction before any publication',
        run({ mod, tmp }) {
            const fixture = crashFixture(mod, tmp);
            assert.throws(() => fixture.run(200, { manifest: { path: fixture.manifest, expected: 'stale\n', next: 'v2\n', changedMessage: 'manifest moved' } }),
                error => error.code === 'SKILL_EXPORT_SNAPSHOT_CHANGED' && error.message === 'manifest moved');
            assertBeforeState(mod, fixture);
            // An absent expected manifest is created exclusively, never over a concurrent one.
            const created = path.join(fixture.folder, 'new-manifest.json');
            const result = fixture.run(200, { manifest: { path: created, expected: null, next: 'created\n' } });
            assert.equal(result.artifacts.manifest, 'published');
            assert.equal(read(created), 'created\n');
        },
    },
    {
        name: 'marketplace install owns only links it creates and removal touches only owned output',
        run({ mod, tmp }) {
            const base = tmp('market');
            const folder = path.join(base, 'target');
            const alpha = skillSource(base, 'alpha', 'alpha');
            const beta = skillSource(base, 'beta', 'beta');
            const gamma = skillSource(base, 'gamma', 'gamma');
            const skills = path.join(folder, '.agents', 'skills');
            fs.mkdirSync(skills, { recursive: true });
            const real = fs.realpathSync(skills);
            // An identical pre-existing user link and a manifest-owned link.
            fs.symlinkSync(path.relative(real, fs.realpathSync(beta)), path.join(skills, 'beta'));
            mod.syncManagedSkillExports({ folder, owner: 'manifest', mode: 'symlink', sources: [{ name: 'gamma', path: gamma }], lock: { liveness: liveness(10) } });
            const install = () => mod.withSkillExportLocks([folder], ([handle]) => mod.publishSkillExports(handle, {
                owner: mod.MARKETPLACE_OWNER, policy: 'additive', mode: 'symlink', claude: 'root-strict',
                sources: ['alpha', 'beta', 'gamma'].map(name => ({ name, path: path.join(base, 'sources', name), source: { name: 'market' } })),
                lock: { liveness: liveness(10) },
            }), { liveness: liveness(10) });
            const first = install();
            const status = name => first.statuses.find(item => item.name === name);
            assert.equal(status('alpha').status, 'installed');
            assert.equal(status('beta').status, 'present');
            assert.equal(status('gamma').status, 'present');
            assert.equal(first.artifacts.claude.mode, 'root');
            const ledger = ledgerOf(folder).entries;
            assert.equal(ledger.alpha.owner, mod.MARKETPLACE_OWNER);
            assert.equal(ledger.beta, undefined, 'an identical existing link stays unowned');
            assert.equal(ledger.gamma.owner, 'manifest');
            assert.ok(install().statuses.every(item => item.status === 'present'));

            const remove = names => mod.withSkillExportLocks([folder], ([handle]) => mod.publishSkillExports(handle, {
                owner: mod.MARKETPLACE_OWNER, policy: 'remove', removeNames: names,
            }), { liveness: liveness(10), create: false });
            const removed = remove(['beta', 'gamma', 'missing']);
            assert.deepEqual(removed.statuses.map(item => [item.name, item.status, item.reason || null]), [
                ['beta', 'conflict', 'unrecorded-output-preserved'],
                ['gamma', 'conflict', 'owned-by-other-export'],
                ['missing', 'absent', null],
            ]);
            assert.ok(lstat(path.join(skills, 'beta')) && lstat(path.join(skills, 'gamma')));
            // A user-retargeted owned link is preserved.
            fs.unlinkSync(path.join(skills, 'alpha'));
            fs.symlinkSync(path.relative(real, fs.realpathSync(beta)), path.join(skills, 'alpha'));
            assert.equal(remove(['alpha']).statuses[0].reason, 'edited-output-preserved');
            fs.unlinkSync(path.join(skills, 'alpha'));
            fs.symlinkSync(path.relative(real, fs.realpathSync(alpha)), path.join(skills, 'alpha'));
            assert.deepEqual(remove(['alpha']).statuses.map(item => item.status), ['removed']);
            assert.equal(lstat(path.join(skills, 'alpha')), undefined);
            assert.equal(ledgerOf(folder).entries.alpha, undefined);
            assert.ok(fs.existsSync(path.join(alpha, 'SKILL.md')), 'removal never follows the link');
        },
    },
    {
        name: 'retention collects only dead-owner unreferenced staging and reports retained storage',
        run({ mod, tmp }) {
            const base = tmp('retention');
            const folder = path.join(base, 'target');
            const source = skillSource(base, 'one', 'one');
            const sync = self => mod.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'one', path: source }], lock: { liveness: liveness(self, [66]) } });
            sync(10);
            write(path.join(source, 'SKILL.md'), '# one v2\n');
            sync(10);
            const agents = path.join(fs.realpathSync(folder), '.agents');
            const staging = path.join(agents, '.ploinky-export-staging');
            const owner = (pid, extra = {}) => JSON.stringify({ protocol: mod.EXPORT_PROTOCOL, version: mod.EXPORT_PROTOCOL_VERSION, token: crypto.randomUUID(), ...identity(pid), ...extra });
            const dead = `tx-${crypto.randomUUID()}`;
            const foreign = `tx-${crypto.randomUUID()}`;
            const referenced = crypto.randomUUID();
            write(path.join(staging, dead, 'owner.json'), owner(66));
            write(path.join(staging, dead, 'one', 'SKILL.md'), 'staged');
            write(path.join(staging, foreign, 'owner.json'), owner(67, { boot: 'boot-b' }));
            write(path.join(staging, `tx-${referenced}`, 'owner.json'), owner(66));
            write(path.join(agents, '.ploinky-export-quarantine', `${referenced}.json`), '{}');
            write(path.join(staging, 'export-legacy', 'one', 'SKILL.md'), 'legacy staging');
            write(path.join(agents, '.ploinky-export-backups', `one-${crypto.randomUUID()}`, 'SKILL.md'), 'legacy backup');
            write(path.join(source, 'SKILL.md'), '# one v3\n');
            const result = sync(10);
            assert.deepEqual(result.retention.staging.collected, [dead]);
            const retained = Object.fromEntries(result.retention.staging.retained.map(item => [item.name, item.reason]));
            assert.equal(retained[foreign], 'owner-not-proven-dead');
            assert.equal(retained[`tx-${referenced}`], 'journal-referenced');
            assert.equal(retained['export-legacy'], 'unknown-legacy');
            assert.equal(result.retention.backups.prior.count, 2);
            assert.ok(result.retention.backups.prior.bytes > 0);
            assert.equal(result.retention.backups.legacy.count, 1);
            assert.ok(result.retention.retainedBytes >= result.retention.backups.prior.bytes + result.retention.backups.legacy.bytes);
            assert.ok(fs.existsSync(path.join(agents, '.ploinky-export-backups')), 'backups are never pruned by age');
        },
    },
    {
        name: 'lock order is Git metadata then every target in canonical order, released in reverse',
        run({ mod, tmp }) {
            const base = tmp('order');
            const events = [];
            const folders = ['zeta', 'alpha', 'mid'].map(name => { fs.mkdirSync(path.join(base, name)); return path.join(base, name); });
            mod.withSkillExportLocks([...folders, folders[1]], handles => {
                events.push(...handles.map(handle => `target:${path.basename(handle.root)}`));
            }, {
                liveness: liveness(10),
                gitMetadataLocks: ['/git/b', '/git/a'],
                acquireGitMetadataLock(key) { events.push(`git:${key}`); return { release: () => events.push(`release:${key}`) }; },
            });
            assert.deepEqual(events, ['git:/git/a', 'git:/git/b', 'target:alpha', 'target:mid', 'target:zeta', 'release:/git/b', 'release:/git/a']);
        },
    },
    {
        name: 'retained names of unavailable sources are neither refreshed nor pruned, and consumer policy is recorded',
        run({ mod, tmp }) {
            const base = tmp('retain');
            const folder = path.join(base, 'target');
            const one = skillSource(base, 'one', 'one');
            const two = skillSource(base, 'two', 'two');
            const sync = extra => mod.syncManagedSkillExports({ folder, owner: 'manifest', mode: 'symlink', lock: { liveness: liveness(10) }, ...extra });
            sync({ sources: [{ name: 'one', path: one }, { name: 'two', path: two }], consumer: { selection: 'explicit', policy: 'manifest' } });
            const result = sync({ sources: [{ name: 'two', path: two }], retain: ['one'], consumer: { selection: 'explicit', policy: 'manifest' } });
            assert.deepEqual(result.removed, []);
            assert.deepEqual(result.retained, ['one']);
            assert.ok(lstat(path.join(folder, '.agents', 'skills', 'one')));
            const ledger = ledgerOf(folder);
            assert.equal(ledger.entries.one.owner, 'manifest');
            assert.deepEqual(ledger.consumers.manifest, { selection: 'explicit', policy: 'manifest' });
            assert.deepEqual(sync({ sources: [{ name: 'two', path: two }] }).removed, ['one'], 'without retention the owner set is authoritative');
            const before = read(path.join(folder, '.agents', '.ploinky-skill-exports.json'));
            assert.equal(mod.refreshSkillExportExclusions(folder, { exclusions: { plan: () => ({ outcome: { status: 'unchanged' }, artifacts: [] }) }, lock: { liveness: liveness(10) } }).exclusions.status, 'unchanged');
            assert.equal(read(path.join(folder, '.agents', '.ploinky-skill-exports.json')), before, 'an exclusions-only refresh never touches the ledger');
        },
    },
    {
        name: 'unchanged refreshes publish nothing persistent',
        run({ mod, tmp }) {
            const base = tmp('idempotent');
            const folder = path.join(base, 'target');
            const source = skillSource(base, 'one', 'one');
            const sync = () => mod.syncManagedSkillExports({ folder, owner: 'manifest', mode: 'symlink', sources: [{ name: 'one', path: source }], claude: 'root-or-skills', lock: { liveness: liveness(10) } });
            assert.equal(sync().transaction.status, 'committed');
            const ledger = path.join(fs.realpathSync(folder), '.agents', '.ploinky-skill-exports.json');
            const before = fs.statSync(ledger);
            const second = sync();
            assert.equal(second.transaction.status, 'unchanged');
            assert.deepEqual(second.unchanged, ['one']);
            assert.equal(fs.statSync(ledger).ino, before.ino);
        },
    },
];

function mapCrashPoints() {
    return ['copy', 'symlink'].flatMap(mode => ['before-journal', 'after-journal', 'after-backup', 'after-link', 'before-metadata',
        'after-metadata-journal', 'after-ledger', 'after-manifest', 'after-claude', 'after-gitignore', 'before-commit', 'after-commit']
        .filter(point => mode === 'copy' || ['after-link', 'after-ledger'].includes(point))
        .map(point => ({
            name: `crash ${point} (${mode}) recovers to the complete ${ROLLED_BACK.has(point) ? 'prior' : 'new'} state`,
            run({ mod, tmp }) {
                assert.ok(mod.CRASH_POINTS.includes(point));
                const fixture = crashFixture(mod, tmp);
                // Symlink mode also migrates the prior copies to links.
                const run = (self, extra = {}) => mode === 'symlink'
                    ? mod.syncManagedSkillExports({
                        folder: fixture.folder, owner: 'manifest', mode: 'symlink', lock: { liveness: liveness(self, extra.dead || []), waitMs: 0 },
                        sources: ['keep', 'replace', 'fresh'].map(name => ({ name, path: fixture.sources[name] })),
                        manifest: { path: fixture.manifest, expected: read(fixture.manifest), next: 'v2\n' },
                        claude: 'root-or-skills', gitignore: { update: addGenerated }, hooks: extra.hooks || {},
                    })
                    : fixture.run(self, extra);
                assert.throws(() => run(200, { hooks: simulatedCrash(mod, point) }), /simulated crash/);
                assert.equal(mod.inspectSkillExportLock(fixture.folder, { liveness: liveness(300, [200]) }).state, 'dead');
                const recovery = recoverWith(mod, fixture.folder, 300, [200]);
                if (mode === 'copy') {
                    if (ROLLED_BACK.has(point)) assertBeforeState(mod, fixture);
                    else assertAfterState(mod, fixture);
                } else {
                    assert.equal(read(fixture.manifest), ROLLED_BACK.has(point) ? 'v1\n' : 'v2\n');
                    assert.equal(lstat(path.join(fixture.skills, 'fresh'))?.isSymbolicLink() ?? false, !ROLLED_BACK.has(point));
                }
                const expected = point === 'before-journal' || point === 'after-commit' ? 'none' : ROLLED_BACK.has(point) ? 'rolled-back' : 'rolled-forward';
                assert.equal(recovery.status, expected);
                assert.equal(mod.readSkillExportTransactionState(fixture.folder, { liveness: liveness(300) }).pending, null);
                // A later run converges on the new state and collects abandoned staging.
                const next = run(300, { dead: [200] });
                assert.equal(next.retention.staging.retained.length, 0, JSON.stringify(next.retention.staging));
                if (mode === 'copy') assertAfterState(mod, fixture);
                else assert.equal(fs.realpathSync(path.join(fixture.skills, 'fresh')), fs.realpathSync(fixture.sources.fresh));
            },
        })));
}

// Run one protocol copy against another in the same folder.
export function contentionScenario({ first, second, tmp }) {
    const base = tmp('contention');
    const folder = path.join(base, 'target');
    const source = skillSource(base, 'one', 'one');
    const held = first.acquireSkillExportLock(folder);
    assert.throws(() => second.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'one', path: source }], lock: { waitMs: 0 } }),
        error => error.code === 'SKILL_EXPORT_LOCK_BUSY');
    held.release();
    // A transaction abandoned by one copy is recovered by the other.
    assert.throws(() => first.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'one', path: source }], lock: { liveness: liveness(200) }, hooks: simulatedCrash(first, 'after-link') }), /simulated crash/);
    const recovered = second.withSkillExportLocks([folder], ([handle]) => handle.recovery, { liveness: liveness(300, [200]) });
    assert.equal(recovered.status, 'rolled-back');
    assert.deepEqual(second.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'one', path: source }], lock: { liveness: liveness(300) } }).installed, ['one']);
}
