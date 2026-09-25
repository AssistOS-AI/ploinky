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

// Crash at the `occurrence`-th time `point` is reached (points such as
// after-git-config fire once per artifact).
export function simulatedCrash(mod, point, occurrence = 1) {
    let seen = 0;
    return {
        crash(current) {
            if (current === point && ++seen === occurrence) throw Object.assign(new Error(`simulated crash at ${point} #${occurrence}`), { [mod.SIMULATED_CRASH]: true });
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

// User-authored bytes placed in every fixture; no run, crash or recovery may
// change them.
const USER_FILES = { 'notes.txt': 'user notes\n', [path.join('.agents', 'skills', 'mine', 'SKILL.md')]: '# mine, not exported\n' };

function writeUserFiles(folder) {
    for (const [relative, content] of Object.entries(USER_FILES)) write(path.join(folder, relative), content);
}

function assertUserFiles(folder) {
    for (const [relative, content] of Object.entries(USER_FILES)) assert.equal(read(path.join(folder, relative)), content, `user file ${relative}`);
}

// Exports are links, so a new version is a new source directory.
function crashFixture(mod, tmp) {
    const base = tmp('crash');
    const folder = path.join(base, 'target');
    fs.mkdirSync(folder);
    writeUserFiles(folder);
    const sources = {
        keep: skillSource(base, 'keep', 'keep'),
        replace: skillSource(base, 'replace', 'replace v1'),
        drop: skillSource(base, 'drop', 'drop'),
        fresh: skillSource(base, 'fresh', 'fresh'),
        replaceV2: skillSource(base, 'replace-v2', 'replace v2'),
    };
    const next = { keep: sources.keep, replace: sources.replaceV2, fresh: sources.fresh };
    const manifest = path.join(folder, 'manifest.json');
    write(manifest, 'v1\n');
    const run = (self, extra = {}) => mod.syncManagedSkillExports({
        folder, owner: 'manifest', lock: { liveness: liveness(self, extra.dead || []), waitMs: 0 },
        sources: Object.entries(extra.sources || next).map(([name, directory]) => ({ name, path: directory, source: { name: 'fixture' } })),
        manifest: extra.manifest === undefined ? { path: manifest, expected: read(manifest), next: 'v2\n' } : extra.manifest,
        claude: extra.claude === undefined ? 'root-or-skills' : extra.claude,
        gitignore: extra.gitignore === undefined ? { update: addGenerated } : extra.gitignore,
        hooks: extra.hooks || {},
    });
    // Establish the prior committed state without the later artifacts.
    run(100, { sources: { keep: sources.keep, replace: sources.replace, drop: sources.drop }, manifest: null, claude: null, gitignore: null });
    const skills = path.join(folder, '.agents', 'skills');
    const before = {
        ledger: read(path.join(folder, '.agents', '.ploinky-skill-exports.json')),
        replace: fs.readlinkSync(path.join(skills, 'replace')),
    };
    return { base, folder, sources, manifest, run, skills, before };
}

const resolvesTo = (link, directory) => fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(directory);

function assertSourcesUntouched(fixture) {
    for (const [name, content] of [['keep', 'keep'], ['replace', 'replace v1'], ['drop', 'drop'], ['fresh', 'fresh'], ['replace-v2', 'replace v2']]) {
        assert.equal(read(path.join(fixture.base, 'sources', name, 'SKILL.md')), `# ${content}\n`, `source ${name}`);
    }
}

function assertBeforeState(mod, fixture) {
    const { folder, skills, manifest, before, sources } = fixture;
    assert.equal(read(path.join(folder, '.agents', '.ploinky-skill-exports.json')), before.ledger);
    assert.equal(fs.readlinkSync(path.join(skills, 'replace')), before.replace);
    assert.ok(resolvesTo(path.join(skills, 'replace'), sources.replace));
    assert.ok(resolvesTo(path.join(skills, 'drop'), sources.drop));
    assert.ok(resolvesTo(path.join(skills, 'keep'), sources.keep));
    assert.equal(lstat(path.join(skills, 'fresh')), undefined);
    assert.equal(read(manifest), 'v1\n');
    assert.equal(lstat(path.join(folder, '.claude')), undefined);
    assert.equal(lstat(path.join(folder, '.gitignore')), undefined);
    assertUserFiles(folder);
    assertSourcesUntouched(fixture);
}

function assertAfterState(mod, fixture) {
    const { folder, skills, manifest, sources } = fixture;
    const ledger = ledgerOf(folder);
    assert.deepEqual(Object.keys(ledger.entries).sort(), ['fresh', 'keep', 'replace']);
    for (const [name, directory] of [['keep', sources.keep], ['replace', sources.replaceV2], ['fresh', sources.fresh]]) {
        assert.ok(resolvesTo(path.join(skills, name), directory), name);
        assert.equal(ledger.entries[name].kind, 'symlink');
        assert.equal(ledger.entries[name].digest, mod.skillTreeDigest(path.join(skills, name)));
    }
    assert.equal(lstat(path.join(skills, 'drop')), undefined);
    assert.equal(read(manifest), 'v2\n');
    assert.equal(fs.readlinkSync(path.join(folder, '.claude')), '.agents');
    assert.equal(read(path.join(folder, '.gitignore')), 'generated\n');
    assertUserFiles(folder);
    assertSourcesUntouched(fixture);
}

const recoverWith = (mod, folder, self, dead, extra = {}) => mod.withSkillExportLocks([folder], ([handle]) => handle.recovery, { liveness: liveness(self, dead), waitMs: 0, ...extra });

const GIT_ISOLATION = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

// Run `body` with Git reading no global, system or XDG policy of this machine.
function withIsolatedGit(base, body) {
    const saved = Object.fromEntries(GIT_ISOLATION.map(key => [key, process.env[key]]));
    fs.writeFileSync(path.join(base, 'gitconfig'), '');
    delete process.env.GIT_CONFIG_SYSTEM;
    Object.assign(process.env, {
        HOME: base, XDG_CONFIG_HOME: path.join(base, 'xdg'), GIT_CONFIG_GLOBAL: path.join(base, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    });
    try {
        return body();
    } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
}

// A committed Git project exported with private exclusions. Enabling
// extensions.worktreeConfig must also move a shared core.worktree
// (variant 'core.worktree') or core.bare=true (variant 'bare': the project is
// a linked worktree of a bare repository) to the main config.worktree, so one
// export writes several Git config artifacts.
function gitFixture(mod, exclusions, base, { variant = 'plain' } = {}) {
    const project = path.join(base, 'project');
    const git = (...args) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const config = (file, key) => { try { return git('config', '--file', file, '--get-all', key).trim(); } catch (_) { return null; } };
    let repository = project;
    if (variant === 'bare') {
        const seed = path.join(base, 'seed');
        fs.mkdirSync(seed);
        const seedGit = (...args) => execFileSync('git', args, { cwd: seed, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        seedGit('init', '-q', '-b', 'main');
        writeUserFiles(seed);
        seedGit('add', '.');
        seedGit('commit', '-q', '-m', 'initial');
        repository = path.join(base, 'repository.git');
        execFileSync('git', ['clone', '-q', '--bare', seed, repository], { stdio: 'ignore' });
        execFileSync('git', ['worktree', 'add', '-q', project, 'main'], { cwd: repository, stdio: 'ignore' });
    } else {
        fs.mkdirSync(project);
        git('init', '-q');
        writeUserFiles(project);
        git('add', '.');
        git('commit', '-q', '-m', 'initial');
    }
    git('config', 'user.marker', 'kept');
    if (variant === 'core.worktree') git('config', 'core.worktree', project);
    const gitDir = fs.realpathSync(git('rev-parse', '--absolute-git-dir').trim());
    const commonDir = fs.realpathSync(path.resolve(project, git('rev-parse', '--git-common-dir').trim()));
    const common = path.join(commonDir, 'config');
    const mainWorktreeConfig = path.join(commonDir, 'config.worktree');
    const worktreeConfig = path.join(gitDir, 'config.worktree');
    const userExclude = path.join(commonDir, 'info', 'exclude');
    const excludeBytes = read(userExclude);
    const source = skillSource(base, 'demo', 'demo');
    const planner = () => exclusions.createSkillExclusionPlanner({ containerExecutor: false });
    const sync = (self, extra = {}) => mod.syncManagedSkillExports({
        folder: project, owner: 'manifest', claude: 'root-or-skills', sources: [{ name: 'demo', path: source }],
        exclusions: planner(), lock: { liveness: liveness(self, extra.dead || []), waitMs: 0 }, hooks: extra.hooks || {},
    });
    const recover = (self, dead, extra = {}) => mod.withSkillExportLocks([project], ([handle]) => handle.recovery,
        { liveness: liveness(self, dead), waitMs: 0, exclusions: planner(), ...extra });
    const assertUser = () => {
        assertUserFiles(project);
        assert.equal(read(userExclude), excludeBytes, 'the shared info/exclude is never written');
        assert.equal(config(common, 'user.marker'), 'kept');
        assert.equal(read(path.join(source, 'SKILL.md')), '# demo\n');
    };
    const assertPublished = () => {
        assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
        assert.equal(config(common, 'extensions.worktreeConfig'), 'true');
        if (variant === 'core.worktree') {
            assert.equal(config(common, 'core.worktree'), null, 'core.worktree left the shared config');
            assert.equal(config(mainWorktreeConfig, 'core.worktree'), project);
        }
        if (variant === 'bare') {
            assert.equal(config(common, 'core.bare'), null, 'core.bare left the shared config');
            assert.equal(config(mainWorktreeConfig, 'core.bare'), 'true');
            assert.equal(execFileSync('git', ['rev-parse', '--is-bare-repository'], { cwd: repository, encoding: 'utf8' }).trim(), 'true');
        }
        assert.equal(config(worktreeConfig, 'core.excludesFile'), path.join(gitDir, 'ploinky-skill-exports.exclude'));
        assert.equal(git('rev-parse', '--is-inside-work-tree').trim(), 'true');
        assert.equal(git('rev-parse', '--show-toplevel').trim(), project);
        assert.ok(resolvesTo(path.join(project, '.agents', 'skills', 'demo'), source));
        assertUser();
    };
    return { project, git, common, sync, recover, assertUser, assertPublished };
}

const ROLLED_BACK = new Set(['before-journal', 'after-journal', 'after-backup', 'after-link', 'before-metadata']);
// Points reached by a publication without exclusions; the exclusion points
// run against a non-git folder (after-receipt) and Git projects below.
const CRASH_MATRIX = ['before-journal', 'after-journal', 'after-backup', 'after-link', 'before-metadata',
    'after-metadata-journal', 'after-ledger', 'after-manifest', 'after-claude', 'after-gitignore', 'before-commit', 'after-commit'];
// [point, occurrence, gitFixture variant]. With a shared core.worktree or
// core.bare=true the artifacts are: the key into the main config.worktree,
// extensions.worktreeConfig, unset the shared key, the two private files,
// then core.excludesFile.
const GIT_CRASHES = [
    ['after-git-config', 1, 'plain'], ['after-private-file', 1, 'plain'], ['after-private-file', 2, 'plain'],
    ...['core.worktree', 'bare'].flatMap(variant => [1, 2, 3, 4].map(occurrence => ['after-git-config', occurrence, variant])),
];

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
    mod.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'demo', path: demo }], lock: { liveness: liveness(10) } });
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
    ['a published directory, which this protocol never writes', f => f.journal({ paths: [f.install(path.join('.agents', 'skills', 'demo'), { after: { type: 'directory', digest: f.link.digest } })] })],
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
            // A writer that only creates the directory is excluded as well.
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
        name: 'ownerless locks and other-namespace owners are preserved, never reclaimed',
        run({ mod, tmp }) {
            const folder = tmp('ownerless');
            const lockPath = path.join(fs.realpathSync(folder), '.agents', '.ploinky-skill-exports.lock');
            // An exporter stopped between creating the lock and recording its owner.
            fs.mkdirSync(lockPath, { recursive: true });
            fs.utimesSync(lockPath, new Date(0), new Date(0));
            assert.throws(() => mod.acquireSkillExportLock(folder, { liveness: liveness(10), waitMs: 20, pollMs: 5 }),
                error => error.code === 'SKILL_EXPORT_LOCK_OWNERLESS' && error.outcome === 'blocked-ownerless-lock');
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
    ...GIT_CRASHES.map(([point, occurrence, variant]) => ({
        name: `crash at ${point} #${occurrence}${{ plain: '', 'core.worktree': ' while core.worktree moves to config.worktree', bare: ' while core.bare of a bare repository moves to config.worktree' }[variant]} rolls forward to private exclusions and a clean worktree`,
        run({ mod, tmp, exclusions }) {
            assert.ok(exclusions, 'the paired exclusions module is required');
            const base = tmp('git-crash');
            withIsolatedGit(base, () => {
                const f = gitFixture(mod, exclusions, base, { variant });
                assert.throws(() => f.sync(200, { hooks: simulatedCrash(mod, point, occurrence) }), new RegExp(`simulated crash at ${point} #${occurrence}`));
                assert.equal(mod.readSkillExportTransactionState(f.project, { liveness: liveness(300) }).pending.phase, 'metadata', 'publication stopped part-way');
                f.assertUser();
                assert.equal(f.recover(300, [200]).status, 'rolled-forward');
                assert.equal(mod.readSkillExportTransactionState(f.project, { liveness: liveness(300) }).pending, null);
                f.assertPublished();
                assert.equal(f.sync(300, { dead: [200] }).transaction.status, 'unchanged');
                f.assertPublished();
            });
        },
    })),
    {
        name: 'a crash during recovery is itself recovered to the complete new state',
        run({ mod, tmp }) {
            const fixture = crashFixture(mod, tmp);
            assert.throws(() => fixture.run(200, { hooks: simulatedCrash(mod, 'after-ledger') }), /simulated crash/);
            assert.throws(() => recoverWith(mod, fixture.folder, 300, [200], { recoveryHooks: simulatedCrash(mod, 'after-manifest') }), /simulated crash at after-manifest/);
            assert.equal(mod.readSkillExportTransactionState(fixture.folder, { liveness: liveness(400, [200, 300]) }).pending.phase, 'metadata');
            assert.equal(mod.inspectSkillExportLock(fixture.folder, { liveness: liveness(400, [200, 300]) }).state, 'dead', 'the crashed recovery left its lock');
            assert.equal(recoverWith(mod, fixture.folder, 400, [200, 300]).status, 'rolled-forward');
            assertAfterState(mod, fixture);
            assert.equal(fixture.run(400, { dead: [200, 300] }).transaction.status, 'unchanged');
            assertAfterState(mod, fixture);
        },
    },
    {
        name: 'a crash during recovery between Git config artifacts is itself recovered',
        run({ mod, tmp, exclusions }) {
            const base = tmp('git-recovery-crash');
            withIsolatedGit(base, () => {
                const f = gitFixture(mod, exclusions, base, { variant: 'core.worktree' });
                assert.throws(() => f.sync(200, { hooks: simulatedCrash(mod, 'after-ledger') }), /simulated crash/);
                assert.throws(() => f.recover(300, [200], { recoveryHooks: simulatedCrash(mod, 'after-git-config', 2) }), /simulated crash at after-git-config #2/);
                f.assertUser();
                assert.equal(f.recover(400, [200, 300]).status, 'rolled-forward');
                f.assertPublished();
            });
        },
    },
    {
        name: 'recovery never removes or overwrites a native Git config lock and stays pending',
        run({ mod, tmp, exclusions }) {
            const base = tmp('git-native-lock');
            withIsolatedGit(base, () => {
                const f = gitFixture(mod, exclusions, base);
                assert.throws(() => f.sync(200, { hooks: simulatedCrash(mod, 'after-ledger') }), /simulated crash/);
                const lock = `${f.common}.lock`;
                fs.writeFileSync(lock, '[foreign]\n\twriter = in-progress\n');
                const inode = fs.statSync(lock).ino;
                const configBefore = read(f.common);
                assert.throws(() => f.recover(300, [200]), error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED'
                    && error.outcome === 'recovery-required' && error.cause?.code === 'SKILL_EXPORT_GIT_CONFIG_BUSY');
                assert.equal(fs.statSync(lock).ino, inode, 'the foreign lock keeps its inode');
                assert.equal(read(lock), '[foreign]\n\twriter = in-progress\n', 'the foreign lock keeps its bytes');
                assert.equal(read(f.common), configBefore, 'the locked config is not written');
                assert.equal(mod.readSkillExportTransactionState(f.project, { liveness: liveness(300) }).pending.phase, 'metadata');
                f.assertUser();
                // The native writer finishes; the next participant completes recovery.
                fs.unlinkSync(lock);
                assert.equal(f.recover(300, [200]).status, 'rolled-forward');
                f.assertPublished();
            });
        },
    },
    {
        name: 'crash after-receipt in a non-git folder rolls forward the managed block and keeps user rules',
        run({ mod, tmp, exclusions }) {
            const base = tmp('receipt');
            withIsolatedGit(base, () => {
                const folder = path.join(base, 'target');
                writeUserFiles(folder);
                write(path.join(folder, '.gitignore'), 'node_modules\n');
                const source = skillSource(base, 'demo', 'demo');
                const sync = (self, extra = {}) => mod.syncManagedSkillExports({
                    folder, owner: 'manifest', claude: 'root-or-skills', sources: [{ name: 'demo', path: source }],
                    exclusions: exclusions.createSkillExclusionPlanner({ nonGitBlock: true, containerExecutor: false }),
                    lock: { liveness: liveness(self, extra.dead || []), waitMs: 0 }, hooks: extra.hooks || {},
                });
                assert.throws(() => sync(200, { hooks: simulatedCrash(mod, 'after-receipt') }), /simulated crash at after-receipt/);
                assert.equal(recoverWith(mod, folder, 300, [200]).status, 'rolled-forward');
                const gitignore = read(path.join(folder, '.gitignore'));
                assert.ok(gitignore.startsWith(`node_modules\n${exclusions.IGNORE_MARKER_START}\n`), gitignore);
                assert.match(gitignore, /^\/\.agents\/skills\/demo$/m);
                const receipt = JSON.parse(read(path.join(folder, '.agents', '.ploinky-ignore-receipt.json')));
                assert.equal(receipt.after, crypto.createHash('sha256').update(gitignore).digest('hex'));
                assert.equal(receipt.beforeAbsent, false);
                assert.ok(resolvesTo(path.join(folder, '.agents', 'skills', 'demo'), source));
                assertUserFiles(folder);
                assert.equal(sync(300, { dead: [200] }).transaction.status, 'unchanged');
                assert.equal(read(path.join(folder, '.gitignore')), gitignore);
            });
        },
    },
    {
        name: 'every crash point is exercised in link mode',
        run({ mod }) {
            const covered = [...CRASH_MATRIX, 'after-receipt', ...GIT_CRASHES.map(([point]) => point)];
            assert.deepEqual([...new Set(covered)].sort(), [...mod.CRASH_POINTS].sort());
        },
    },
    {
        name: 'a ledger entry of an unsupported kind is preserved, reported and never adopted',
        run({ mod, tmp }) {
            const base = tmp('unsupported');
            const folder = path.join(base, 'target');
            const copied = skillSource(base, 'copied', 'copied');
            const skills = path.join(folder, '.agents', 'skills');
            // A directory export and a record whose output is gone.
            fs.mkdirSync(skills, { recursive: true });
            write(path.join(skills, 'copied', 'SKILL.md'), '# copied\n');
            write(path.join(skills, 'copied', 'helper.sh'), 'user bytes\n', 0o755);
            const ledgerFile = path.join(folder, '.agents', '.ploinky-skill-exports.json');
            const entries = {
                copied: { owner: 'manifest', digest: mod.skillTreeDigest(path.join(skills, 'copied')), kind: 'directory', source: null },
                gone: { owner: 'manifest', digest: 'x', kind: 'directory', source: null },
            };
            write(ledgerFile, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
            const tree = snapshot(skills);
            const unsupported = diagnostics => diagnostics.filter(item => item.reason === 'unsupported-ledger-entry-preserved').map(item => item.name).sort();
            const sync = sources => mod.syncManagedSkillExports({ folder, owner: 'manifest', sources, lock: { liveness: liveness(10) } });
            assert.deepEqual(unsupported(sync([]).diagnostics), ['copied', 'gone']);
            assert.deepEqual(unsupported(sync([{ name: 'copied', path: copied }, { name: 'gone', path: copied }]).diagnostics), ['copied', 'gone']);
            const market = policy => mod.withSkillExportLocks([folder], ([handle]) => mod.publishSkillExports(handle, {
                owner: 'manifest', policy, removeNames: ['copied', 'gone'], sources: [{ name: 'copied', path: copied }, { name: 'gone', path: copied }],
            }), { liveness: liveness(10) });
            for (const policy of ['remove', 'additive']) {
                assert.deepEqual(market(policy).statuses.map(item => [item.name, item.status, item.reason]),
                    [['copied', 'conflict', 'unsupported-ledger-entry-preserved'], ['gone', 'conflict', 'unsupported-ledger-entry-preserved']]);
            }
            assert.deepEqual(snapshot(skills), tree, 'unsupported output is untouched');
            assert.equal((fs.statSync(path.join(skills, 'copied', 'helper.sh')).mode & 0o777), 0o755);
            assert.deepEqual(ledgerOf(folder).entries, entries, 'unsupported records are never forgotten or rewritten');
            assert.equal(mod.listOwnedExportPaths(folder).filter(item => item.startsWith('.agents/skills/')).length, 0, 'unsupported output is not owned');
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
            // The user points the published link at their own skill.
            const replace = path.join(fixture.skills, 'replace');
            const human = path.join(fixture.base, 'human');
            write(path.join(human, 'SKILL.md'), 'human bytes\n');
            fs.unlinkSync(replace);
            fs.symlinkSync(human, replace);
            const recovery = recoverWith(mod, fixture.folder, 300, [200]);
            assert.equal(recovery.status, 'quarantined');
            assert.equal(recovery.direction, 'back');
            assert.equal(fs.readlinkSync(replace), human);
            assert.equal(read(path.join(human, 'SKILL.md')), 'human bytes\n');
            const state = mod.readSkillExportTransactionState(fixture.folder, { liveness: liveness(300) });
            assert.equal(state.pending, null);
            assert.equal(state.quarantined.length, 1);
            assert.equal(state.quarantined[0].reasons[0].name, 'replace');
            // The prior output stays retained; the ledger keeps its prior record.
            assert.equal(ledgerOf(fixture.folder).entries.replace.digest, fixture.before.ledger && JSON.parse(fixture.before.ledger).entries.replace.digest);
            const next = fixture.run(300, { manifest: null, claude: null, gitignore: null });
            assert.ok(next.diagnostics.some(item => item.name === 'replace' && item.reason === 'edited-output-preserved'));
            assert.equal(fs.readlinkSync(replace), human);
            assert.equal(read(path.join(human, 'SKILL.md')), 'human bytes\n');
            assertUserFiles(fixture.folder);
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
            mod.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'gamma', path: gamma }], lock: { liveness: liveness(10) } });
            const install = () => mod.withSkillExportLocks([folder], ([handle]) => mod.publishSkillExports(handle, {
                owner: mod.MARKETPLACE_OWNER, policy: 'additive', claude: 'root-strict',
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
            const versions = ['one-v1', 'one-v2', 'one-v3'].map(name => skillSource(base, name, name));
            const sync = (self, version) => mod.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'one', path: versions[version] }], lock: { liveness: liveness(self, [66]) } });
            sync(10, 0);
            sync(10, 1);
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
            // Names this protocol never writes are reported as unknown and kept.
            write(path.join(staging, 'export-unknown', 'one', 'SKILL.md'), 'unknown staging');
            const unknownBackup = path.join(agents, '.ploinky-export-backups', `one-${crypto.randomUUID()}`);
            write(path.join(unknownBackup, 'SKILL.md'), 'unknown backup');
            const result = sync(10, 2);
            assert.deepEqual(result.retention.staging.collected, [dead]);
            const retained = Object.fromEntries(result.retention.staging.retained.map(item => [item.name, item.reason]));
            assert.equal(retained[foreign], 'owner-not-proven-dead');
            assert.equal(retained[`tx-${referenced}`], 'journal-referenced');
            assert.equal(retained['export-unknown'], 'unknown-name');
            assert.equal(result.retention.backups.prior.count, 2);
            assert.ok(result.retention.backups.prior.bytes > 0);
            assert.deepEqual(Object.keys(result.retention.backups).sort(), ['concurrent', 'prior', 'unknown']);
            assert.equal(result.retention.backups.unknown.count, 1);
            assert.ok(result.retention.retainedBytes >= result.retention.backups.prior.bytes + result.retention.backups.unknown.bytes);
            assert.equal(read(path.join(unknownBackup, 'SKILL.md')), 'unknown backup');
            assert.equal(read(path.join(staging, 'export-unknown', 'one', 'SKILL.md')), 'unknown staging');
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
            const sync = extra => mod.syncManagedSkillExports({ folder, owner: 'manifest', lock: { liveness: liveness(10) }, ...extra });
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
            const sync = () => mod.syncManagedSkillExports({ folder, owner: 'manifest', sources: [{ name: 'one', path: source }], claude: 'root-or-skills', lock: { liveness: liveness(10) } });
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
    return CRASH_MATRIX.map(point => ({
        name: `crash ${point} recovers to the complete ${ROLLED_BACK.has(point) ? 'prior' : 'new'} state`,
        run({ mod, tmp }) {
            assert.ok(mod.CRASH_POINTS.includes(point));
            const fixture = crashFixture(mod, tmp);
            assert.throws(() => fixture.run(200, { hooks: simulatedCrash(mod, point) }), new RegExp(`simulated crash at ${point}`));
            assertUserFiles(fixture.folder);
            assert.equal(mod.inspectSkillExportLock(fixture.folder, { liveness: liveness(300, [200]) }).state, 'dead');
            const recovery = recoverWith(mod, fixture.folder, 300, [200]);
            if (ROLLED_BACK.has(point)) assertBeforeState(mod, fixture);
            else assertAfterState(mod, fixture);
            const expected = point === 'before-journal' || point === 'after-commit' ? 'none' : ROLLED_BACK.has(point) ? 'rolled-back' : 'rolled-forward';
            assert.equal(recovery.status, expected);
            assert.equal(mod.readSkillExportTransactionState(fixture.folder, { liveness: liveness(300) }).pending, null);
            // A later run converges on the new state and collects abandoned staging.
            const next = fixture.run(300, { dead: [200] });
            assert.equal(next.retention.staging.retained.length, 0, JSON.stringify(next.retention.staging));
            assertAfterState(mod, fixture);
        },
    }));
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
