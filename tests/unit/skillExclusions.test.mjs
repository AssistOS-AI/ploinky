import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as tx from '../../cli/utils/skills/exportTransaction.mjs';
import {
    assessGeneratedIgnoreState,
    createSkillExclusionPlanner,
    escapeIgnorePattern,
    runGit,
    IGNORE_MARKER_START,
    IGNORE_MARKER_END,
} from '../../cli/utils/skills/exportExclusions.mjs';
import { simulatedCrash, liveness } from './fixtures/skillExportConformanceScenarios.mjs';

// Never read the global, system or XDG Git policy of the machine running this.
const isolation = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-exclusions-env-')));
const xdgIgnore = path.join(isolation, 'xdg', 'git', 'ignore');
fs.writeFileSync(path.join(isolation, 'gitconfig'), '');
Object.assign(process.env, {
    XDG_CONFIG_HOME: path.join(isolation, 'xdg'),
    GIT_CONFIG_GLOBAL: path.join(isolation, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
// Composition consent comes only from each test, never from the ambient shell.
delete process.env.PLOINKY_SKILL_EXCLUDES_COMPOSE;
delete process.env.GIT_CONFIG_SYSTEM;
test.after(() => fs.rmSync(isolation, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const status = cwd => git(cwd, 'status', '--porcelain', '--untracked-files=all');
const ignoredBy = (cwd, target) => {
    try { return git(cwd, 'check-ignore', '-v', '--', target); } catch (_) { return ''; }
};
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;

function base(t) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-exclusions-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.rmSync(xdgIgnore, { force: true });
    fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
    return directory;
}

function repo(directory) {
    fs.mkdirSync(directory, { recursive: true });
    git(directory, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(directory, 'README.md'), '# repo\n');
    git(directory, 'add', 'README.md');
    git(directory, 'commit', '-q', '-m', 'initial');
    return directory;
}

function skill(root, name) {
    const directory = path.join(root, 'sources', name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), `# ${name}\n`);
    return directory;
}

function exporter(root, options = {}) {
    return (folder, names, extra = {}) => tx.syncManagedSkillExports({
        folder, owner: 'manifest', claude: 'root-or-skills',
        sources: names.map(name => ({ name, path: path.join(root, 'sources', name) })),
        exclusions: createSkillExclusionPlanner(options), ...extra,
    });
}

test('patterns are literal, escaped and anchored', () => {
    assert.equal(escapeIgnorePattern('proj[1]/.agents/skills/a*b'), '/proj\\[1\\]/.agents/skills/a\\*b');
    assert.equal(escapeIgnorePattern('x/why?'), '/x/why\\?');
    assert.equal(escapeIgnorePattern('back\\slash'), '/back\\\\slash');
    assert.equal(escapeIgnorePattern('trailing  '), '/trailing\\ \\ ');
    assert.equal(escapeIgnorePattern('line\nbreak'), null);
});

test('clean repositories stay clean across two updates with private rules and no persistent rewrite', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const sync = exporter(root);
    const infoExclude = read(path.join(project, '.git', 'info', 'exclude'));
    const first = sync(project, ['demo']);
    assert.equal(first.exclusions.status, 'published');
    assert.equal(status(project), '');
    assert.equal(fs.existsSync(path.join(project, '.gitignore')), false, 'no tracked rule is written');
    assert.equal(read(path.join(project, '.git', 'info', 'exclude')), infoExclude, 'shared info/exclude is untouched');
    assert.equal(git(project, 'config', '--get', 'extensions.worktreeConfig').trim(), 'true');
    assert.match(git(project, 'config', '--show-origin', '--get', 'core.excludesFile'), /config\.worktree\t.*ploinky-skill-exports\.exclude/);
    assert.match(ignoredBy(project, '.agents/skills/demo'), /ploinky-skill-exports\.exclude:\d+:\/\.agents\/skills\/demo\t/);
    // The whole .agents is never hidden: an authored skill stays visible.
    fs.mkdirSync(path.join(project, '.agents', 'skills', 'authored'));
    fs.writeFileSync(path.join(project, '.agents', 'skills', 'authored', 'SKILL.md'), 'mine');
    assert.equal(status(project), '?? .agents/skills/authored/SKILL.md\n');
    fs.rmSync(path.join(project, '.agents', 'skills', 'authored'), { recursive: true });

    const files = ['.git/ploinky-skill-exports.exclude', '.git/ploinky-skill-exports.exclusions.json', '.git/config.worktree', '.git/config', '.agents/.ploinky-skill-exports.json']
        .map(file => path.join(project, file));
    const before = files.map(file => { const stat = fs.statSync(file); return [stat.ino, stat.mtimeMs]; });
    const second = sync(project, ['demo']);
    assert.equal(second.transaction.status, 'unchanged');
    assert.equal(second.exclusions.status, 'unchanged');
    assert.deepEqual(files.map(file => { const stat = fs.statSync(file); return [stat.ino, stat.mtimeMs]; }), before);
    assert.equal(status(project), '');
});

test('a relocated repository re-resolves its private exclusions instead of relinquishing them', t => {
    const root = base(t);
    const original = repo(path.join(root, 'original'));
    skill(root, 'demo');
    exporter(root)(original, ['demo']);
    const moved = path.join(root, 'moved');
    fs.renameSync(original, moved);
    const result = exporter(root)(moved, ['demo']);
    assert.equal(result.exclusions.status, 'published');
    assert.equal(git(moved, 'config', '--worktree', '--get', 'core.excludesFile').trim(), path.join(moved, '.git', 'ploinky-skill-exports.exclude'));
    assert.equal(status(moved), '');
});

test('nested literal targets match only their own path, never a sibling glob match', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const nested = path.join(project, 'proj[1]');
    fs.mkdirSync(nested);
    exporter(root)(nested, ['demo']);
    fs.mkdirSync(path.join(project, 'proj1', '.agents', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(project, 'proj1', '.agents', 'skills', 'demo', 'SKILL.md'), 'authored');
    assert.equal(status(project), '?? proj1/.agents/skills/demo/SKILL.md\n');
    assert.match(read(path.join(project, '.git', 'ploinky-skill-exports.exclude')), /^\/proj\\\[1\\\]\/\.agents\/skills\/demo$/m);
});

test('another linked worktree keeps authored files with the same names visible', t => {
    const root = base(t);
    const main = repo(path.join(root, 'main'));
    const linked = path.join(root, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'other', linked);
    skill(root, 'demo');
    exporter(root)(linked, ['demo']);
    assert.equal(status(linked), '');
    assert.equal(fs.existsSync(path.join(main, '.git', 'ploinky-skill-exports.exclude')), false);
    fs.mkdirSync(path.join(main, '.agents', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(main, '.agents', 'skills', 'demo', 'SKILL.md'), 'authored in main');
    fs.symlinkSync('.agents', path.join(main, '.claude'));
    assert.equal(status(main), '?? .agents/skills/demo/SKILL.md\n?? .claude\n');
});

test('a live external excludes policy is deferred unless composition is authorized, and then composed', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    fs.mkdirSync(path.dirname(xdgIgnore), { recursive: true });
    fs.writeFileSync(xdgIgnore, '*.log\n!keep.log\n');
    const commonConfig = read(path.join(project, '.git', 'config'));
    const deferred = exporter(root)(project, ['demo']);
    assert.equal(deferred.exclusions.status, 'deferred');
    assert.equal(deferred.exclusions.code, 'exclusions-deferred');
    assert.match(deferred.exclusions.reason, /PLOINKY_SKILL_EXCLUDES_COMPOSE=1/);
    assert.equal(read(path.join(project, '.git', 'config')), commonConfig, 'nothing is written when deferred');
    assert.equal(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports.exclude')), false);
    assert.match(status(project), /\?\? \.agents\/skills\/demo/);

    const composed = exporter(root, { authorizeComposition: true })(project, ['demo']);
    assert.equal(composed.exclusions.status, 'published');
    assert.equal(composed.exclusions.composed, true);
    const managed = read(path.join(project, '.git', 'ploinky-skill-exports.exclude'));
    assert.ok(managed.indexOf('/.agents/skills/demo') < managed.indexOf('*.log\n!keep.log\n'), 'generated rules come first, user bytes after');
    fs.writeFileSync(path.join(project, 'debug.log'), 'x');
    fs.writeFileSync(path.join(project, 'keep.log'), 'x');
    assert.equal(status(project), '?? keep.log\n', 'user negations still apply');

    // Consent belongs to this invocation, not the workspace-writable record.
    fs.appendFileSync(xdgIgnore, '*.tmp\n');
    const withoutConsent = exporter(root)(project, ['demo']);
    assert.equal(withoutConsent.exclusions.code, 'exclusions-deferred');
    assert.equal(withoutConsent.exclusions.relinquished, true);
    assert.doesNotMatch(read(path.join(project, '.git', 'ploinky-skill-exports.exclude')), /\*\.tmp/);
    assert.throws(() => git(project, 'config', '--worktree', '--get', 'core.excludesFile'));
    assert.equal(exporter(root, { authorizeComposition: true })(project, ['demo']).exclusions.status, 'published');
    assert.match(read(path.join(project, '.git', 'ploinky-skill-exports.exclude')), /\*\.tmp/);

    // A changed configured path is a new policy: control is handed back.
    const other = path.join(root, 'other-ignore');
    fs.writeFileSync(other, '*.bak\n');
    git(project, 'config', '--global', 'core.excludesFile', other);
    const handedBack = exporter(root)(project, ['demo']);
    assert.equal(handedBack.exclusions.code, 'exclusions-deferred');
    assert.equal(handedBack.exclusions.relinquished, true);
    assert.equal(git(project, 'config', '--show-origin', '--get', 'core.excludesFile').includes(other), true);
});

test('a symlinked user policy stays effective without consent and composes with explicit consent', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const policy = path.join(root, 'real-ignore');
    const alias = path.join(root, 'ignore-link');
    fs.writeFileSync(policy, '*.private\n');
    fs.symlinkSync(policy, alias);
    git(project, 'config', '--global', 'core.excludesFile', alias);
    fs.writeFileSync(path.join(project, 'notes.private'), 'fixture');
    const before = ignoredBy(project, 'notes.private');
    assert.match(before, /ignore-link/);
    const deferred = exporter(root)(project, ['demo']);
    assert.equal(deferred.exclusions.code, 'exclusions-deferred');
    assert.equal(ignoredBy(project, 'notes.private'), before);
    assert.equal(fs.existsSync(path.join(project, '.git', 'config.worktree')), false);
    const composed = exporter(root, { authorizeComposition: true })(project, ['demo']);
    assert.equal(composed.exclusions.composed, true);
    assert.match(read(path.join(project, '.git', 'ploinky-skill-exports.exclude')), /\*\.private/);
    assert.match(ignoredBy(project, 'notes.private'), /ploinky-skill-exports\.exclude/);
    assert.equal(fs.readlinkSync(alias), policy);
});

for (const kind of ['directory', 'dangling symlink', 'unreadable file']) {
    test(`an inherited ${kind} is preserved rather than shadowed`, t => {
        const root = base(t);
        const project = repo(path.join(root, 'project'));
        skill(root, 'demo');
        const policy = path.join(root, 'user-ignore');
        if (kind === 'directory') fs.mkdirSync(policy);
        else if (kind === 'dangling symlink') fs.symlinkSync(path.join(root, 'missing'), policy);
        else {
            fs.writeFileSync(policy, '*.private\n');
            const open = fs.openSync;
            t.mock.method(fs, 'openSync', function (file, ...args) {
                if (file === policy) throw Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
                return open.call(this, file, ...args);
            });
        }
        git(project, 'config', '--global', 'core.excludesFile', policy);
        const config = read(path.join(project, '.git', 'config'));
        const result = exporter(root, { authorizeComposition: true })(project, ['demo']);
        assert.equal(result.exclusions.code, 'exclusions-source-unavailable');
        assert.equal(read(path.join(project, '.git', 'config')), config);
        assert.equal(fs.existsSync(path.join(project, '.git', 'config.worktree')), false);
        assert.equal(git(project, 'config', '--get', 'core.excludesFile').trim(), policy);
    });
}

for (const consent of [false, true]) {
    test(`host refresh never copies an external repository-selected policy with consent=${consent}`, t => {
        const root = base(t);
        const workspace = path.join(root, 'workspace');
        const project = repo(path.join(workspace, 'project'));
        skill(root, 'demo');
        const external = path.join(root, 'outside-ignore');
        fs.writeFileSync(external, 'outside-fixture-marker\n');
        git(project, 'config', 'core.excludesFile', external);
        // A receipt is writable by the workspace; it cannot authorize reads.
        fs.writeFileSync(path.join(project, '.git', 'ploinky-skill-exports.exclusions.json'), JSON.stringify({
            protocol: 'ploinky-skill-exclusions', authorized: true, inherited: { path: external },
        }));
        const open = fs.openSync;
        let externalReads = 0;
        t.mock.method(fs, 'openSync', function (file, ...args) {
            if (file === external) externalReads++;
            return open.call(this, file, ...args);
        });
        const result = exporter(root, { gitDirBoundary: workspace, authorizeComposition: consent })(project, ['demo']);
        assert.equal(result.exclusions.code, 'exclusions-source-outside-boundary');
        assert.equal(externalReads, 0);
        assert.equal(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports.exclude')), false);
        assert.equal(git(project, 'config', '--get', 'core.excludesFile').trim(), external);
    });
}

test('host refresh rejects a repository-selected policy symlink outside its workspace', t => {
    const root = base(t);
    const workspace = path.join(root, 'workspace');
    const project = repo(path.join(workspace, 'project'));
    skill(root, 'demo');
    const external = path.join(root, 'outside-ignore');
    const alias = path.join(workspace, 'ignore-link');
    fs.writeFileSync(external, 'outside-fixture-marker\n');
    fs.symlinkSync(external, alias);
    git(project, 'config', 'core.excludesFile', alias);
    const result = exporter(root, { gitDirBoundary: workspace, authorizeComposition: true })(project, ['demo']);
    assert.equal(result.exclusions.code, 'exclusions-source-outside-boundary');
    assert.equal(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports.exclude')), false);
});

for (const scope of ['global', 'default']) {
    test(`host refresh can compose a genuine ${scope} policy with current consent`, t => {
        const root = base(t);
        const workspace = path.join(root, 'workspace');
        const project = repo(path.join(workspace, 'project'));
        skill(root, 'demo');
        const policy = scope === 'global' ? path.join(root, 'host-ignore') : xdgIgnore;
        fs.mkdirSync(path.dirname(policy), { recursive: true });
        fs.writeFileSync(policy, '*.host-policy\n');
        if (scope === 'global') git(project, 'config', '--global', 'core.excludesFile', policy);
        const without = exporter(root, { gitDirBoundary: workspace })(project, ['demo']);
        assert.equal(without.exclusions.code, 'exclusions-deferred');
        const result = exporter(root, { gitDirBoundary: workspace, authorizeComposition: true })(project, ['demo']);
        assert.equal(result.exclusions.composed, true);
        assert.match(read(path.join(project, '.git', 'ploinky-skill-exports.exclude')), /\*\.host-policy/);
    });
}

test('host refresh does not trust an included global configuration as composition authority', t => {
    const root = base(t);
    const workspace = path.join(root, 'workspace');
    const project = repo(path.join(workspace, 'project'));
    skill(root, 'demo');
    const external = path.join(root, 'outside-ignore');
    const included = path.join(workspace, 'included-config');
    fs.writeFileSync(external, 'outside-fixture-marker\n');
    fs.writeFileSync(included, `[core]\n\texcludesFile = ${external}\n`);
    git(project, 'config', '--global', 'include.path', included);
    const result = exporter(root, { gitDirBoundary: workspace, authorizeComposition: true })(project, ['demo']);
    assert.equal(result.exclusions.code, 'exclusions-origin-unverified');
    assert.equal(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports.exclude')), false);
});

test('edited managed files and user-set worktree excludes are relinquished and preserved', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    skill(root, 'second');
    exporter(root)(project, ['demo']);
    const managed = path.join(project, '.git', 'ploinky-skill-exports.exclude');
    fs.appendFileSync(managed, '/mine\n');
    const edited = exporter(root)(project, ['demo', 'second']);
    assert.equal(edited.exclusions.status, 'relinquished');
    assert.equal(edited.exclusions.code, 'managed-excludes-edited');
    assert.match(read(managed), /\/mine\n$/);
    assert.doesNotMatch(read(managed), /second/);

    const other = repo(path.join(root, 'other'));
    git(other, 'config', 'extensions.worktreeConfig', 'true');
    git(other, 'config', '--worktree', 'core.excludesFile', path.join(root, 'user-excludes'));
    const user = exporter(root)(other, ['demo']);
    assert.equal(user.exclusions.code, 'worktree-excludes-user-managed');
    assert.equal(git(other, 'config', '--worktree', '--get', 'core.excludesFile').trim(), path.join(root, 'user-excludes'));
});

test('enabling worktree config migrates main-worktree core.worktree and bare-repository core.bare', t => {
    const root = base(t);
    const main = repo(path.join(root, 'main'));
    git(main, 'config', 'core.worktree', main);
    const linked = path.join(root, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'other', linked);
    skill(root, 'demo');
    exporter(root)(linked, ['demo']);
    assert.equal(git(main, 'config', '--file', path.join(main, '.git', 'config.worktree'), '--get', 'core.worktree').trim(), main);
    assert.throws(() => git(main, 'config', '--file', path.join(main, '.git', 'config'), '--get', 'core.worktree'));
    assert.equal(fs.realpathSync(git(main, 'rev-parse', '--show-toplevel').trim()), main);
    assert.equal(fs.realpathSync(git(linked, 'rev-parse', '--show-toplevel').trim()), linked);
    assert.equal(status(linked), '');

    const source = repo(path.join(root, 'source'));
    const bare = path.join(root, 'bare.git');
    git(root, 'clone', '-q', '--bare', source, bare);
    const work = path.join(root, 'bare-work');
    git(bare, 'worktree', 'add', '-q', work, 'main');
    exporter(root)(work, ['demo']);
    assert.equal(git(bare, 'config', '--file', path.join(bare, 'config.worktree'), '--get', 'core.bare').trim(), 'true');
    assert.equal(git(bare, 'rev-parse', '--is-bare-repository').trim(), 'true');
    assert.equal(git(work, 'rev-parse', '--is-bare-repository').trim(), 'false');
    assert.equal(status(work), '');
});

test('conflicting, disabled or read-only Git configuration is preserved and reported', t => {
    const root = base(t);
    skill(root, 'demo');
    const conflict = repo(path.join(root, 'conflict'));
    git(conflict, 'config', 'core.worktree', conflict);
    git(conflict, 'config', '--file', path.join(conflict, '.git', 'config.worktree'), 'core.worktree', path.join(root, 'elsewhere'));
    assert.equal(exporter(root)(conflict, ['demo']).exclusions.code, 'worktree-config-migration-conflict');
    assert.equal(git(conflict, 'config', '--file', path.join(conflict, '.git', 'config'), '--get', 'core.worktree').trim(), conflict);

    const disabled = repo(path.join(root, 'disabled'));
    git(disabled, 'config', 'extensions.worktreeConfig', 'false');
    assert.equal(exporter(root)(disabled, ['demo']).exclusions.code, 'worktree-config-disabled');

    const readOnly = repo(path.join(root, 'read-only'));
    const config = path.join(readOnly, '.git', 'config');
    const bytes = read(config);
    fs.chmodSync(config, 0o444);
    t.after(() => { try { fs.chmodSync(config, 0o644); } catch (_) {} });
    assert.equal(exporter(root)(readOnly, ['demo']).exclusions.code, 'git-config-read-only');
    assert.equal(read(config), bytes);
    assert.equal(fs.existsSync(path.join(readOnly, '.git', 'config.worktree')), false);
});

test('.claude modes exclude only owned compatibility links', t => {
    const root = base(t);
    skill(root, 'demo');
    const owned = repo(path.join(root, 'owned'));
    exporter(root)(owned, ['demo']);
    assert.match(ignoredBy(owned, '.claude'), /ploinky-skill-exports\.exclude/);

    const unowned = repo(path.join(root, 'unowned'));
    fs.symlinkSync('.agents', path.join(unowned, '.claude'));
    exporter(root)(unowned, ['demo']);
    assert.equal(ignoredBy(unowned, '.claude'), '', 'an identical pre-existing link is not adopted');
    assert.equal(status(unowned), '?? .claude\n');

    const skillsMode = repo(path.join(root, 'skills-mode'));
    fs.mkdirSync(path.join(skillsMode, '.claude'));
    fs.writeFileSync(path.join(skillsMode, '.claude', 'settings.json'), '{}');
    const result = exporter(root)(skillsMode, ['demo']);
    assert.equal(result.artifacts.claude.mode, 'skills');
    assert.equal(status(skillsMode), '?? .claude/settings.json\n');

    const preserved = repo(path.join(root, 'preserved'));
    fs.mkdirSync(path.join(preserved, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(preserved, '.claude', 'skills', 'mine.md'), 'x');
    exporter(root)(preserved, ['demo']);
    assert.equal(status(preserved), '?? .claude/skills/mine.md\n');
});

test('edited, retargeted and removed owned output is no longer excluded', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    skill(root, 'other');
    const sync = exporter(root);
    sync(project, ['demo', 'other']);
    const link = path.join(project, '.agents', 'skills', 'demo');
    fs.unlinkSync(link);
    fs.symlinkSync('../../sources/other', link);
    sync(project, ['demo']);
    assert.equal(ignoredBy(project, '.agents/skills/demo'), '');
    assert.match(status(project), /\?\? \.agents\/skills\/demo/);
    assert.doesNotMatch(read(path.join(project, '.git', 'ploinky-skill-exports.exclude')), /\/\.agents\/skills\/other$/m);
});

test('broad committed rules remain repository policy and are reported once', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    fs.writeFileSync(path.join(project, '.gitignore'), '.agents\n');
    git(project, 'add', '.gitignore');
    git(project, 'commit', '-q', '-m', 'ignore agents');
    skill(root, 'demo');
    skill(root, 'second');
    const first = exporter(root)(project, ['demo']);
    assert.equal(first.exclusions.warnings[0].code, 'broad-ignore-rule');
    assert.equal(read(path.join(project, '.gitignore')), '.agents\n');
    const second = exporter(root)(project, ['demo', 'second']);
    assert.deepEqual(second.exclusions.warnings, []);
});

test('non-git folders keep a receipt-backed block and migrate it after git init', t => {
    const root = base(t);
    const folder = path.join(root, 'plain');
    fs.mkdirSync(folder);
    skill(root, 'demo');
    skill(root, 'second');
    const sync = exporter(root, { nonGitBlock: true });
    const first = sync(folder, ['demo']);
    assert.equal(first.exclusions.mode, 'non-git');
    const gitignore = read(path.join(folder, '.gitignore'));
    assert.match(gitignore, /^\/\.agents\/skills\/demo$/m);
    assert.match(gitignore, /^\/\.claude$/m);
    assert.doesNotMatch(gitignore, /^\/?\.agents\/?$/m);
    assert.ok(fs.existsSync(path.join(folder, '.agents', '.ploinky-ignore-receipt.json')));
    assert.equal(sync(folder, ['demo']).transaction.status, 'unchanged');
    sync(folder, ['demo', 'second']);
    assert.match(read(path.join(folder, '.gitignore')), /^\/\.agents\/skills\/second$/m);

    // A later git init removes the untracked generated block and switches to private rules.
    git(folder, 'init', '-q');
    const migrated = sync(folder, ['demo', 'second']);
    assert.equal(migrated.exclusions.mode, 'git');
    assert.equal(fs.existsSync(path.join(folder, '.gitignore')), false);
    assert.equal(status(folder), '');

    // A user edit inside the block keeps the block unmanaged.
    const other = path.join(root, 'plain-edited');
    fs.mkdirSync(other);
    sync(other, ['demo']);
    fs.writeFileSync(path.join(other, '.gitignore'), read(path.join(other, '.gitignore')).replace(IGNORE_MARKER_END, `/mine\n${IGNORE_MARKER_END}`));
    const preserved = sync(other, ['demo', 'second']);
    assert.equal(preserved.exclusions.code, 'unverified-ignore-block-preserved');
    assert.match(read(path.join(other, '.gitignore')), /\/mine/);
});

test('exclusion artifacts roll forward after a crash and the journal records the config snapshot', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    let journal = null;
    const crash = simulatedCrash(tx, 'after-private-file');
    assert.throws(() => exporter(root)(project, ['demo'], {
        lock: { liveness: liveness(200) },
        hooks: { crash(point) { if (point === 'after-private-file' && !journal) journal = JSON.parse(read(path.join(project, '.agents', '.ploinky-skill-exports.journal.json'))); crash.crash(point); } },
    }), /simulated crash/);
    assert.equal(journal.config.mode, 'git');
    assert.equal(journal.config.identity.commonDir, fs.realpathSync(path.join(project, '.git')));
    assert.ok(journal.config.composedDigest && journal.config.configFingerprint);
    assert.ok(journal.artifacts.some(artifact => artifact.kind === 'git-config' && artifact.key === 'core.excludesFile'));
    // The crashed holder also left the common Git config lock; a later
    // participant reclaims it from the dead owner before the export lock.
    assert.ok(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports-config.lock', 'owner.json')));
    const recovery = tx.withSkillExportLocks([project], ([handle]) => handle.recovery,
        { liveness: liveness(300, [200]), exclusions: createSkillExclusionPlanner() });
    assert.equal(recovery.status, 'rolled-forward');
    assert.equal(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports-config.lock')), false);
    assert.equal(status(project), '');

    // A journal naming Git config outside the target's Git directories is refused.
    const bad = { ...journal, transaction: crypto.randomUUID(), staging: '', artifacts: [{ kind: 'git-config', path: path.join(root, 'elsewhere.config'), key: 'core.excludesFile', before: { type: 'config', values: [] }, after: { type: 'config', values: ['/x'] } }] };
    bad.staging = path.join('.agents', '.ploinky-export-staging', `tx-${bad.transaction}`);
    fs.writeFileSync(path.join(project, '.agents', '.ploinky-skill-exports.journal.json'), JSON.stringify(bad));
    assert.throws(() => tx.withSkillExportLocks([project], () => null, { liveness: liveness(300) }), error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED');
    assert.equal(fs.existsSync(path.join(root, 'elsewhere.config')), false);
});

// ---------------------------------------------------------------------------
// Pre-pull assessment.

const RECEIPTLESS_BLOCK = `${IGNORE_MARKER_START}\n.claude\n.agents/skills/demo/\n${IGNORE_MARKER_END}\n`;

function trackedIgnore(root, committed) {
    const project = repo(path.join(root, `project-${crypto.randomUUID()}`));
    fs.writeFileSync(path.join(project, '.gitignore'), committed);
    git(project, 'add', '.gitignore');
    git(project, 'commit', '-q', '-m', 'ignore');
    return project;
}

test('assessment reports none for clean repositories and unrelated changes', t => {
    const root = base(t);
    const project = trackedIgnore(root, 'node_modules\n');
    assert.deepEqual(assessGeneratedIgnoreState({ repoPath: project }), { status: 'none' });
    fs.appendFileSync(path.join(project, '.gitignore'), 'dist\n');
    assert.deepEqual(assessGeneratedIgnoreState({ repoPath: project }), { status: 'none' });
});

for (const [label, content] of [
    ['a receipt-less block', `node_modules\n${RECEIPTLESS_BLOCK}`],
    ['a receipt-less block with CRLF line endings', `node_modules\r\n${RECEIPTLESS_BLOCK.replace(/\n/g, '\r\n')}`],
    ['a receipt-less block without a final newline', `node_modules\n${RECEIPTLESS_BLOCK.trimEnd()}`],
    ['multiple receipt-less blocks', `node_modules\n${RECEIPTLESS_BLOCK}${RECEIPTLESS_BLOCK}`],
    ['a user edit inside the block', `node_modules\n${RECEIPTLESS_BLOCK.replace('.claude\n', '.claude\n/mine\n')}`],
    ['a user edit outside the block', `node_modules\ndist\n${RECEIPTLESS_BLOCK}`],
]) {
    test(`assessment preserves ${label} without a write receipt`, t => {
        const project = trackedIgnore(base(t), 'node_modules\n');
        fs.writeFileSync(path.join(project, '.gitignore'), content);
        const result = assessGeneratedIgnoreState({ repoPath: project });
        assert.equal(result.status, 'preserve');
        assert.equal(result.code, 'unverified-ignore-block-preserved');
        assert.match(result.reason, /git restore -- \.gitignore/);
        assert.equal(read(path.join(project, '.gitignore')), content);
    });
}

// A block written by new code in a non-git folder that later became a
// repository whose committed .gitignore is the pre-block content.
function receiptRepository(root, before) {
    const folder = path.join(root, `receipt-${crypto.randomUUID()}`);
    fs.mkdirSync(folder);
    if (before !== null) fs.writeFileSync(path.join(folder, '.gitignore'), before);
    skill(root, 'demo');
    exporter(root, { nonGitBlock: true })(folder, ['demo']);
    git(folder, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(folder, 'README.md'), 'x');
    git(folder, 'add', 'README.md');
    if (before !== null) {
        const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: folder, input: before, encoding: 'utf8' }).trim();
        git(folder, 'update-index', '--add', '--cacheinfo', `100644,${blob},.gitignore`);
    }
    git(folder, 'commit', '-q', '-m', 'initial');
    return folder;
}

test('assessment restores a receipt-proven block only when bytes and index match', t => {
    const root = base(t);
    const folder = receiptRepository(root, 'node_modules\n');
    assert.match(read(path.join(folder, '.gitignore')), /ploinky default-skills/);
    const result = assessGeneratedIgnoreState({ repoPath: folder });
    assert.deepEqual(result, { status: 'restored', paths: ['.gitignore'] });
    assert.equal(read(path.join(folder, '.gitignore')), 'node_modules\n');
    assert.equal(git(folder, 'status', '--porcelain', '--untracked-files=no'), '');

    for (const edit of [content => content.replace(IGNORE_MARKER_END, `/mine\n${IGNORE_MARKER_END}`), content => `dist\n${content}`]) {
        const edited = receiptRepository(root, 'node_modules\n');
        const file = path.join(edited, '.gitignore');
        fs.writeFileSync(file, edit(read(file)));
        const bytes = read(file);
        assert.equal(assessGeneratedIgnoreState({ repoPath: edited }).code, 'unverified-ignore-block-preserved');
        assert.equal(read(file), bytes);
    }
});

test('assessment preserves staged and conflicted ignore files and restores unborn generated files', t => {
    const root = base(t);
    const staged = receiptRepository(root, 'node_modules\n');
    git(staged, 'add', '.gitignore');
    assert.equal(assessGeneratedIgnoreState({ repoPath: staged }).code, 'staged-ignore-change-preserved');

    const conflicted = trackedIgnore(root, 'base\n');
    git(conflicted, 'checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(conflicted, '.gitignore'), 'side\n');
    git(conflicted, 'commit', '-q', '-am', 'side');
    git(conflicted, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(conflicted, '.gitignore'), 'main\n');
    git(conflicted, 'commit', '-q', '-am', 'main');
    assert.throws(() => git(conflicted, 'merge', '-q', 'side'));
    fs.appendFileSync(path.join(conflicted, '.gitignore'), RECEIPTLESS_BLOCK);
    assert.equal(assessGeneratedIgnoreState({ repoPath: conflicted }).code, 'ignore-file-conflicted');

    const unborn = path.join(root, 'unborn');
    fs.mkdirSync(unborn);
    exporter(root, { nonGitBlock: true })(unborn, ['demo']);
    git(unborn, 'init', '-q');
    assert.deepEqual(assessGeneratedIgnoreState({ repoPath: unborn }), { status: 'restored', paths: ['.gitignore'] });
    assert.equal(fs.existsSync(path.join(unborn, '.gitignore')), false);
});

test('a Git failure inside a repository defers instead of writing a non-git block', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    const nested = path.join(project, 'nested');
    fs.mkdirSync(nested);
    skill(root, 'demo');
    const refusing = (args, options) => args[0] === 'rev-parse'
        ? { status: 128, stdout: Buffer.alloc(0), stderr: "fatal: detected dubious ownership in repository at '/x'" }
        : { status: 1, stdout: Buffer.alloc(0), stderr: '' };
    const result = tx.syncManagedSkillExports({ folder: nested, owner: 'manifest', sources: [{ name: 'demo', path: path.join(root, 'sources', 'demo') }],
        exclusions: createSkillExclusionPlanner({ nonGitBlock: true, git: refusing }) });
    assert.equal(result.exclusions.code, 'git-identity-unavailable');
    assert.equal(fs.existsSync(path.join(nested, '.gitignore')), false);
    assert.deepEqual(result.installed, ['demo'], 'the export itself still publishes');

    const notRepository = () => ({ status: 128, stdout: Buffer.alloc(0), stderr: 'fatal: not a git repository (or any of the parent directories): .git' });
    const ceiling = tx.syncManagedSkillExports({ folder: nested, owner: 'manifest', sources: [],
        exclusions: createSkillExclusionPlanner({ nonGitBlock: true, git: notRepository }) });
    assert.equal(ceiling.exclusions.code, 'git-identity-unavailable', 'a .git above the target overrides a negative discovery');

    const missing = () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
    const noGit = tx.syncManagedSkillExports({ folder: nested, owner: 'manifest', sources: [],
        exclusions: createSkillExclusionPlanner({ nonGitBlock: true, git: missing }) });
    assert.equal(noGit.exclusions.code, 'git-identity-unavailable');
});

test('container executors never publish private Git exclusions', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const config = read(path.join(project, '.git', 'config'));
    const result = exporter(root, { containerExecutor: true })(project, ['demo']);
    assert.equal(result.exclusions.code, 'exclusions-executor-view-unverified');
    assert.equal(read(path.join(project, '.git', 'config')), config);
    assert.equal(fs.existsSync(path.join(project, '.git', 'ploinky-skill-exports.exclude')), false);
});

test('an unwritable Git directory defers exclusions while links still publish', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const gitDir = path.join(project, '.git');
    fs.chmodSync(gitDir, 0o555);
    t.after(() => { try { fs.chmodSync(gitDir, 0o755); } catch (_) {} });
    const result = exporter(root)(project, ['demo']);
    fs.chmodSync(gitDir, 0o755);
    assert.deepEqual(result.installed, ['demo']);
    assert.equal(result.exclusions.status, 'deferred');
    assert.throws(() => git(project, 'config', '--get-all', 'extensions.worktreeConfig'), 'nothing changed in Git config');
});

test('recovery of Git config changes takes the common Git lock, or stays pending without it', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    assert.throws(() => exporter(root)(project, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-git-config') }), /simulated crash/);
    fs.rmSync(path.join(project, '.git', 'ploinky-skill-exports-config.lock'), { recursive: true });
    const gitDir = path.join(project, '.git');
    fs.chmodSync(gitDir, 0o555);
    t.after(() => { try { fs.chmodSync(gitDir, 0o755); } catch (_) {} });
    assert.throws(() => tx.syncManagedSkillExports({ folder: project, owner: 'manifest', sources: [], lock: { liveness: liveness(300, [200]) } }),
        error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED');
    fs.chmodSync(gitDir, 0o755);
    // A plain export without an exclusions planner still orders the Git lock first.
    const plain = tx.syncManagedSkillExports({ folder: project, owner: 'manifest', sources: [{ name: 'demo', path: path.join(root, 'sources', 'demo') }], lock: { liveness: liveness(300, [200]) } });
    assert.equal(plain.recovery.status, 'rolled-forward');
    assert.equal(status(project), '');
});

// ---------------------------------------------------------------------------
// Exclusions owned by every export folder of one worktree.

const joinPath = (...parts) => parts.filter(part => part && part !== '.').join('/');
// Every generated output a folder's export owns, root-relative.
const generatedBy = (prefix, names) => [
    ...names.map(name => joinPath(prefix, '.agents', 'skills', name)),
    joinPath(prefix, '.agents', '.ploinky-skill-exports.json'),
    joinPath(prefix, '.claude'),
];
const isIgnored = (cwd, target) => ignoredBy(cwd, target) !== '';
const assertAllIgnored = (cwd, targets, message = '') => {
    for (const target of targets) assert.ok(isIgnored(cwd, target), `${target} must stay ignored${message ? ` (${message})` : ''}`);
};
const recordOf = project => JSON.parse(read(path.join(project, '.git', 'ploinky-skill-exports.exclusions.json')));
const managedOf = project => read(path.join(project, '.git', 'ploinky-skill-exports.exclude'));
const gitMetadata = project => ({ managed: managedOf(project), record: read(path.join(project, '.git', 'ploinky-skill-exports.exclusions.json')) });

for (const order of [['.', 'child'], ['child', '.'], ['alpha', 'beta']]) {
    test(`every export folder keeps its generated output ignored: ${order.join(' then ')}`, t => {
        const root = base(t);
        const project = repo(path.join(root, 'project'));
        skill(root, 'demo');
        const sync = exporter(root);
        const folders = order.map(name => name === '.' ? project : path.join(project, name));
        for (const folder of folders) fs.mkdirSync(folder, { recursive: true });
        const outcomes = folders.map(folder => sync(folder, ['demo']));
        for (const outcome of outcomes) assert.equal(outcome.exclusions.status, 'published');
        assertAllIgnored(project, order.flatMap(name => generatedBy(name, ['demo'])));
        assert.equal(status(project), '', 'nothing generated shows as untracked');
        assert.deepEqual(Object.keys(recordOf(project).owners).sort(), [...order].sort());
    });
}

const patternsFor = paths => paths.map(relative => escapeIgnorePattern(relative)).sort();

test('the recorded contributions are exactly the escaped, anchored owned paths of each folder', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    skill(root, 'second');
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{}');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    sync(project, ['demo', 'second']);
    sync(child, ['demo']);
    const record = recordOf(project);
    assert.equal(record.version, 2);
    assert.deepEqual(Object.keys(record.owners), ['.', 'child']);
    // Drift guard: the grammar this module validates against is the one the transaction owns.
    for (const [key, folder] of [['.', project], ['child', child]]) {
        const owned = tx.listOwnedExportPaths(folder).map(relative => joinPath(key, relative));
        assert.deepEqual(record.owners[key].patterns, patternsFor(owned), key);
    }
    assert.ok(record.owners['.'].patterns.includes('/.claude/skills'), 'skills-mode compatibility link is owned');
    assert.ok(record.owners.child.patterns.includes('/child/.claude'));
    assert.equal(managedOf(project).split('\n').filter(line => line.startsWith('/')).join('\n'),
        [...new Set(Object.values(record.owners).flatMap(owner => owner.patterns))].sort().join('\n'));
});

test('independent .claude content and locally authored skills stay visible across folders', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{}');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    sync(project, ['demo']);
    sync(child, ['demo']);
    for (const authored of ['.agents/skills/mine/SKILL.md', 'child/.agents/skills/mine/SKILL.md', 'child/.agents/skills/demo2/SKILL.md']) {
        fs.mkdirSync(path.dirname(path.join(project, authored)), { recursive: true });
        fs.writeFileSync(path.join(project, authored), 'authored');
    }
    assert.equal(status(project), [
        '?? .agents/skills/mine/SKILL.md', '?? .claude/settings.json', '?? child/.agents/skills/demo2/SKILL.md', '?? child/.agents/skills/mine/SKILL.md', '',
    ].join('\n'));
    assertAllIgnored(project, ['.agents/skills/demo', '.claude/skills', 'child/.agents/skills/demo', 'child/.claude']);
    assert.equal(isIgnored(project, '.claude/settings.json'), false);
});

test('repeating an operation is byte-stable in every order, with no rewrite', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    sync(project, ['demo']);
    sync(child, ['demo']);
    const files = ['.git/ploinky-skill-exports.exclude', '.git/ploinky-skill-exports.exclusions.json', '.git/config.worktree', '.git/config'].map(file => path.join(project, file));
    const fingerprint = () => files.map(file => { const stat = fs.statSync(file); return [fs.readFileSync(file, 'utf8'), stat.ino, stat.mtimeMs]; });
    const before = fingerprint();
    for (const folder of [child, project, child, project]) {
        const repeat = sync(folder, ['demo']);
        assert.equal(repeat.transaction.status, 'unchanged');
        assert.equal(repeat.exclusions.status, 'unchanged');
        assert.deepEqual(fingerprint(), before);
    }
});

test('deselecting a skill removes only that folder\'s no-longer-owned rules', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    skill(root, 'second');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    sync(project, ['demo', 'second']);
    sync(child, ['demo', 'second']);
    const childBefore = recordOf(project).owners.child;
    const next = sync(project, ['demo']);
    assert.equal(next.exclusions.status, 'published');
    const record = recordOf(project);
    assert.ok(!record.owners['.'].patterns.includes('/.agents/skills/second'));
    assert.ok(record.owners['.'].patterns.includes('/.agents/skills/demo'));
    assert.deepEqual(record.owners.child, childBefore, 'the other folder\'s contribution is untouched');
    assert.doesNotMatch(managedOf(project), /^\/\.agents\/skills\/second$/m);
    assert.match(managedOf(project), /^\/child\/\.agents\/skills\/second$/m);
    assertAllIgnored(project, ['.agents/skills/demo', 'child/.agents/skills/demo', 'child/.agents/skills/second', ...generatedBy('', []), ...generatedBy('child', [])]);
    assert.equal(status(project), '');
});

test('a folder that disappears keeps its recorded contribution until it is exported again, then is revalidated', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    skill(root, 'second');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    sync(project, ['demo']);
    sync(child, ['demo']);
    fs.rmSync(child, { recursive: true });
    const refreshed = sync(project, ['demo', 'second']);
    assert.equal(refreshed.exclusions.status, 'published');
    assert.deepEqual(recordOf(project).owners.child.patterns, patternsFor(['child/.agents/skills/demo', ...['.ploinky-skill-exports.json', '.ploinky-skill-exports.lock', '.ploinky-skill-exports.journal.json', '.ploinky-export-staging', '.ploinky-export-backups', '.ploinky-export-quarantine', '.ploinky-ignore-receipt.json'].map(name => `child/.agents/${name}`), 'child/.claude']),
        'no implicit deletion');
    const warning = refreshed.exclusions.warnings.find(item => item.code === 'retained-export-owner-missing');
    assert.deepEqual(warning?.folders, ['child'], 'the retained stale entry is reported');
    // No adoption: a user folder reusing the path is not claimed by the old record's owner.
    fs.mkdirSync(path.join(child, '.agents', 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(child, '.agents', 'skills', 'mine', 'SKILL.md'), 'authored');
    assert.equal(status(project), '?? child/.agents/skills/mine/SKILL.md\n');
    // The next export of that folder replaces the stale contribution with its own verified one.
    const again = sync(child, ['second']);
    assert.equal(again.exclusions.status, 'published');
    assert.ok(!recordOf(project).owners.child.patterns.includes('/child/.agents/skills/demo'));
    assert.ok(recordOf(project).owners.child.patterns.includes('/child/.agents/skills/second'));
    assert.equal(refreshed.exclusions.warnings.length, 1);
});

test('a folder whose ledger vanished is not adopted: its next export replaces only its own contribution', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    sync(project, ['demo']);
    sync(child, ['demo']);
    const rootBefore = recordOf(project).owners['.'];
    fs.rmSync(path.join(child, '.agents', '.ploinky-skill-exports.json'));
    const result = sync(child, []);
    assert.equal(result.installed.length, 0);
    assert.deepEqual(recordOf(project).owners['.'], rootBefore);
    assert.ok(!recordOf(project).owners.child.patterns.includes('/child/.agents/skills/demo'), 'unverified output is no longer claimed');
    assert.ok(isIgnored(project, '.agents/skills/demo'));
});

test('host refresh of a deferred folder merges into the shared file and keeps every other folder', t => {
    const root = base(t);
    const workspace = path.join(root, 'workspace');
    const project = repo(path.join(workspace, 'project'));
    skill(root, 'demo');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    exporter(root)(project, ['demo']);
    const deferred = exporter(root, { containerExecutor: true })(child, ['demo']);
    assert.equal(deferred.exclusions.code, 'exclusions-executor-view-unverified');
    assert.equal(isIgnored(project, 'child/.agents/skills/demo'), false);
    const refreshed = tx.refreshSkillExportExclusions(child, { exclusions: createSkillExclusionPlanner({ gitDirBoundary: workspace, containerExecutor: false }) });
    assert.equal(refreshed.exclusions.status, 'published');
    assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('child', ['demo'])]);
});

for (const [label, names] of [
    ['spaces', ['sp ace', 'two  spaces']],
    ['Unicode', ['unicode-üñî', '日本語']],
    ['Git glob characters', ['glob[1]', 'star*', 'what?', 'back\\slash', '[!x]', '#hash', '!bang']],
    ['a trailing space', ['trailing ']],
]) {
    test(`folder names with ${label} are literal anchored rules that match only themselves`, t => {
        const root = base(t);
        const project = repo(path.join(root, 'project'));
        skill(root, 'demo');
        const sync = exporter(root);
        for (const name of names) { fs.mkdirSync(path.join(project, name)); sync(path.join(project, name), ['demo']); }
        sync(project, ['demo']);
        for (const name of names) assertAllIgnored(project, generatedBy(name, ['demo']), name);
        // Lookalikes a glob would have matched keep their own authored skills visible.
        const lookalikes = ['glob1', 'stars', 'whatX', 'x', 'sp', 'trailing', 'hash', 'bang'];
        for (const name of lookalikes) {
            if (names.includes(name)) continue;
            fs.mkdirSync(path.join(project, name, '.agents', 'skills', 'demo'), { recursive: true });
            fs.writeFileSync(path.join(project, name, '.agents', 'skills', 'demo', 'SKILL.md'), 'authored');
            assert.equal(isIgnored(project, `${name}/.agents/skills/demo/SKILL.md`), false, `${name} lookalike stays visible`);
        }
        assert.deepEqual(Object.keys(recordOf(project).owners).sort(), ['.', ...names].sort());
    });
}

test('a folder name with a newline is never recorded or written, and other folders are unaffected', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const sync = exporter(root);
    sync(project, ['demo']);
    const hostile = path.join(project, 'bad\nname');
    fs.mkdirSync(hostile);
    const before = gitMetadata(project);
    const result = sync(hostile, ['demo']);
    assert.ok(result.exclusions.unrepresentable.length > 0);
    assert.deepEqual(Object.keys(recordOf(project).owners), ['.']);
    assert.ok(!managedOf(project).includes('bad'), 'no rule is written for the unrepresentable folder');
    assert.equal(managedOf(project), before.managed);
    assert.equal(managedOf(project).split('\n').some(line => line.includes('\r')), false);
});

test('a folder reached through a symlink is recorded under its canonical path, never the link name', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    fs.mkdirSync(path.join(project, 'real'));
    fs.symlinkSync(path.join(project, 'real'), path.join(project, 'alias'));
    exporter(root)(path.join(project, 'alias'), ['demo']);
    assert.deepEqual(Object.keys(recordOf(project).owners), ['real']);
    assertAllIgnored(project, generatedBy('real', ['demo']));
});

test('a folder that symlinks out of the worktree never writes into the worktree\'s record', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    exporter(root)(project, ['demo']);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(project, 'escape'));
    const before = gitMetadata(project);
    const result = exporter(root)(path.join(project, 'escape'), ['demo']);
    assert.notEqual(result.exclusions.mode, 'git');
    assert.deepEqual(gitMetadata(project), before);
    assert.deepEqual(Object.keys(recordOf(project).owners), ['.']);
});

// ---- A damaged, edited or foreign record is preserved and reported.

const twoFolderState = t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    skill(root, 'second');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    sync(project, ['demo']);
    sync(child, ['demo']);
    return { root, project, child, sync };
};
const recordFileOf = project => path.join(project, '.git', 'ploinky-skill-exports.exclusions.json');
const edits = {
    'owner key with a parent segment': (record) => { record.owners['../outside'] = record.owners.child; delete record.owners.child; },
    'owner key with a leading slash': (record) => { record.owners['/abs'] = record.owners.child; delete record.owners.child; },
    'owner key with an empty segment': (record) => { record.owners['a//b'] = record.owners.child; delete record.owners.child; },
    'a pattern hiding all of .agents': (record) => { record.owners.child.patterns = ['/child/.agents', ...record.owners.child.patterns].sort(); },
    'a pattern hiding every skill': (record) => { record.owners.child.patterns = ['/child/.agents/skills/*', ...record.owners.child.patterns].sort(); },
    'a pattern of another folder': (record) => { record.owners.child.patterns = ['/.agents/skills/demo']; },
    'a pattern with an unescaped glob': (record) => { record.owners.child.patterns = ['/child/.agents/skills/de*']; },
    'a pattern outside the grammar': (record) => { record.owners.child.patterns = ['/child/README.md']; },
    'patterns that are not canonical': (record) => { record.owners.child.patterns = [...record.owners.child.patterns].reverse(); },
    'an owners map that is not an object': (record) => { record.owners = ['child']; },
    'an entry with extra authority fields': (record) => { record.owners.child.adopt = true; },
    'an empty contribution': (record) => { record.owners.child.patterns = []; },
    'another record version': (record) => { record.version = 3; },
    'broad-rule memory that is not a map': (record) => { record.broadRules = [{ source: '.gitignore', line: 1, pattern: '.agents' }]; },
    'broad-rule memory under an invalid folder': (record) => { record.broadRules = { '../x': [{ source: '.gitignore', line: 1, pattern: '.agents' }] }; },
};
for (const [label, edit] of Object.entries(edits)) {
    test(`an edited record (${label}) is preserved, reported and never guessed into authority`, t => {
        const { project, child, sync } = twoFolderState(t);
        const record = recordOf(project);
        edit(record);
        fs.writeFileSync(recordFileOf(project), `${JSON.stringify(record, null, 2)}\n`);
        const before = { ...gitMetadata(project), config: read(path.join(project, '.git', 'config.worktree')) };
        const result = sync(child, ['demo', 'second']);
        assert.equal(result.exclusions.status, 'relinquished');
        assert.equal(result.exclusions.code, 'managed-excludes-record-invalid');
        assert.deepEqual({ ...gitMetadata(project), config: read(path.join(project, '.git', 'config.worktree')) }, before);
        assert.deepEqual(result.installed, ['second'], 'the export itself still completes');
    });
}

test('a record that no longer describes the managed file is preserved and reported', t => {
    const { project, child, sync } = twoFolderState(t);
    const record = recordOf(project);
    record.owners.child.patterns = patternsFor(['child/.agents/skills/other']);
    fs.writeFileSync(recordFileOf(project), `${JSON.stringify(record, null, 2)}\n`);
    const before = gitMetadata(project);
    const result = sync(child, ['demo']);
    assert.equal(result.exclusions.code, 'managed-excludes-record-invalid');
    assert.deepEqual(gitMetadata(project), before);
});

test('a version 1 record is relinquished with a distinct code and recreate instructions, and is never adopted', t => {
    const { project, child, sync } = twoFolderState(t);
    const record = recordOf(project);
    delete record.owners;
    record.version = 1;
    fs.writeFileSync(recordFileOf(project), `${JSON.stringify(record, null, 2)}\n`);
    const before = gitMetadata(project);
    for (const folder of [child, project]) {
        const result = sync(folder, ['demo']);
        assert.equal(result.exclusions.status, 'relinquished');
        assert.equal(result.exclusions.code, 'managed-excludes-record-legacy');
        assert.match(result.exclusions.reason, /unset core\.excludesFile/);
        assert.match(result.exclusions.reason, /delete .*ploinky-skill-exports\.exclusions\.json/);
        assert.deepEqual(gitMetadata(project), before);
    }
    // The documented recreate path works and rebuilds from each folder's own export.
    git(project, 'config', '--worktree', '--unset', 'core.excludesFile');
    fs.rmSync(recordFileOf(project));
    fs.rmSync(path.join(project, '.git', 'ploinky-skill-exports.exclude'));
    assert.equal(sync(project, ['demo']).exclusions.status, 'published');
    assert.equal(sync(child, ['demo']).exclusions.status, 'published');
    assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('child', ['demo'])]);
});

for (const [label, bytes] of [['non-JSON', '{not json'], ['a foreign protocol', JSON.stringify({ protocol: 'something-else', version: 2, owners: {} })], ['an empty file', '']]) {
    test(`a record that is ${label} is treated as an edit: preserved and relinquished`, t => {
        const { project, child, sync } = twoFolderState(t);
        fs.writeFileSync(recordFileOf(project), bytes);
        const before = gitMetadata(project);
        const result = sync(child, ['demo']);
        assert.equal(result.exclusions.status, 'relinquished');
        assert.equal(result.exclusions.code, 'managed-excludes-edited');
        assert.deepEqual(gitMetadata(project), before);
    });
}

test('guard: a stale legacy record without a managed key is replaced by a fresh version 2 record', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    fs.writeFileSync(recordFileOf(project), JSON.stringify({ protocol: 'ploinky-skill-exclusions', version: 1, previous: { present: true, values: ['/user'] } }));
    const result = exporter(root)(project, ['demo']);
    assert.equal(result.exclusions.status, 'published');
    assert.deepEqual(recordOf(project).previous, { present: false, values: [] }, 'nothing is adopted from the legacy record');
    assert.deepEqual(Object.keys(recordOf(project).owners), ['.']);
});

test('read-only Git metadata defers the second folder and leaves the shared state unchanged', t => {
    const { project, child, sync } = twoFolderState(t);
    for (const target of [recordFileOf(project), path.join(project, '.git', 'ploinky-skill-exports.exclude')]) {
        fs.chmodSync(target, 0o444);
        t.after(() => { try { fs.chmodSync(target, 0o644); } catch (_) {} });
        const before = gitMetadata(project);
        const result = sync(child, ['demo', 'second']);
        assert.equal(result.exclusions.status, 'deferred');
        assert.equal(result.exclusions.code, 'git-config-read-only');
        assert.deepEqual(gitMetadata(project), before);
        assert.deepEqual(result.installed, ['second'], 'links still publish');
        fs.chmodSync(target, 0o644);
        sync(child, ['demo']);
    }
});

test('a worktree-local Git lock in an existing state defers a later folder without touching shared metadata', t => {
    const { project, child, sync } = twoFolderState(t);
    const lock = path.join(project, '.git', 'config.worktree.lock');
    fs.writeFileSync(lock, 'foreign writer');
    const before = gitMetadata(project);
    const result = sync(child, ['demo', 'second']);
    assert.equal(result.exclusions.code, 'git-config-busy');
    assert.deepEqual(gitMetadata(project), before);
    assert.equal(read(lock), 'foreign writer');
});

// ---- Linked worktrees share a common Git directory but never rules.

test('linked worktrees sharing one common Git directory keep their own per-folder records and no rules leak', t => {
    const root = base(t);
    const main = repo(path.join(root, 'main'));
    const linked = path.join(root, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'other', linked);
    skill(root, 'demo');
    skill(root, 'second');
    const sync = exporter(root);
    const mainChild = path.join(main, 'child');
    const linkedChild = path.join(linked, 'inner');
    fs.mkdirSync(mainChild);
    fs.mkdirSync(linkedChild);
    sync(main, ['demo']);
    sync(linked, ['second']);
    sync(linkedChild, ['demo']);
    sync(mainChild, ['demo']);
    sync(linked, ['second']);
    const mainRecord = JSON.parse(read(path.join(main, '.git', 'ploinky-skill-exports.exclusions.json')));
    const linkedGit = git(linked, 'rev-parse', '--path-format=absolute', '--absolute-git-dir').trim();
    const linkedRecord = JSON.parse(read(path.join(linkedGit, 'ploinky-skill-exports.exclusions.json')));
    assert.deepEqual(Object.keys(mainRecord.owners).sort(), ['.', 'child']);
    assert.deepEqual(Object.keys(linkedRecord.owners).sort(), ['.', 'inner']);
    assertAllIgnored(main, [...generatedBy('', ['demo']), ...generatedBy('child', ['demo'])]);
    assertAllIgnored(linked, [...generatedBy('', ['second']), ...generatedBy('inner', ['demo'])]);
    assert.equal(isIgnored(main, 'inner/.agents/skills/demo'), false, 'no rule from the linked worktree');
    assert.equal(isIgnored(linked, 'child/.agents/skills/demo'), false, 'no rule from the main worktree');
    assert.equal(isIgnored(linked, '.agents/skills/demo'), false, 'the linked root did not export demo');
    assert.equal(status(main), '');
    assert.equal(status(linked), '');
    assert.equal(fs.existsSync(path.join(main, '.git', 'ploinky-skill-exports-config.lock')), false, 'the shared lock is released');
});

// ---- Crashes between the file and record writes, and another folder publishing.

test('a crash between the managed file and its record leaves the completed folders intact; the other publisher is refused until recovery', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const [one, two] = ['one', 'two'].map(name => { const folder = path.join(project, name); fs.mkdirSync(folder); return folder; });
    const sync = exporter(root);
    sync(project, ['demo']);
    assert.throws(() => sync(one, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-private-file') }), /simulated crash/);
    const torn = gitMetadata(project);
    assert.notEqual(torn.managed, '', 'the managed file moved ahead of its record');
    const refused = sync(two, ['demo'], { lock: { liveness: liveness(300, [200]) } });
    assert.equal(refused.exclusions.status, 'relinquished');
    assert.equal(refused.exclusions.code, 'managed-excludes-edited');
    assert.deepEqual(gitMetadata(project), torn, 'nothing was replaced');
    assertAllIgnored(project, generatedBy('', ['demo']), 'the completed root stays ignored');
    // The crashed folder's next export recovers its journal first.
    const recovered = sync(one, ['demo'], { lock: { liveness: liveness(300, [200]) } });
    assert.equal(recovered.recovery.status, 'rolled-forward');
    assert.equal(sync(two, ['demo']).exclusions.status, 'published');
    assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('one', ['demo']), ...generatedBy('two', ['demo'])]);
    assert.equal(status(project), '');
});

test('recovery from old bytes never replaces another folder\'s completed contribution', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const [one, two] = ['one', 'two'].map(name => { const folder = path.join(project, name); fs.mkdirSync(folder); return folder; });
    const sync = exporter(root);
    sync(project, ['demo']);
    assert.throws(() => sync(one, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-metadata-journal') }), /simulated crash/);
    // Nothing of the pending transaction reached the shared files yet.
    assert.equal(sync(two, ['demo'], { lock: { liveness: liveness(300, [200]) } }).exclusions.status, 'published');
    const published = gitMetadata(project);
    const recovery = tx.withSkillExportLocks([one], ([handle]) => handle.recovery, { liveness: liveness(400, [200]) });
    assert.equal(recovery.status, 'quarantined');
    assert.ok(recovery.unexpected.some(item => item.name === 'private-file'));
    assert.deepEqual(gitMetadata(project), published, 'the newer contribution was not overwritten');
    assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('two', ['demo'])]);
    // The folder whose transaction was set aside re-adds its own verified contribution.
    assert.equal(sync(one, ['demo']).exclusions.status, 'published');
    assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('one', ['demo']), ...generatedBy('two', ['demo'])]);
});

test('the managed file and record move together: a record-only change since the crash holds both back', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const one = path.join(project, 'one');
    fs.mkdirSync(one);
    exporter(root)(project, ['demo']);
    assert.throws(() => exporter(root)(one, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-metadata-journal') }), /simulated crash/);
    // Authorization changes the record only; the rendered rules are the same bytes.
    const toggled = exporter(root, { authorizeComposition: true })(project, ['demo'], { lock: { liveness: liveness(300, [200]) } });
    assert.equal(toggled.exclusions.status, 'published');
    const settled = gitMetadata(project);
    const recovery = tx.withSkillExportLocks([one], ([handle]) => handle.recovery, { liveness: liveness(400, [200]) });
    assert.equal(recovery.status, 'quarantined');
    assert.deepEqual(gitMetadata(project), settled, 'neither file of the pending pair was written');
    const next = exporter(root, { authorizeComposition: true })(project, ['demo']);
    assert.notEqual(next.exclusions.status, 'relinquished', 'the pair is still consistent');
});

// ---- Private-file-only journals and recovery without a planner.

test('a private-file-only journal takes the common Git lock for recovery even without an exclusions planner', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const one = path.join(project, 'one');
    fs.mkdirSync(one);
    const sync = exporter(root);
    sync(project, ['demo']);
    assert.throws(() => sync(one, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-metadata-journal') }), /simulated crash/);
    const journal = JSON.parse(read(path.join(one, '.agents', '.ploinky-skill-exports.journal.json')));
    assert.deepEqual([...new Set(journal.artifacts.map(artifact => artifact.kind))].sort(), ['claude', 'ledger', 'private-file']);
    fs.rmSync(path.join(project, '.git', 'ploinky-skill-exports-config.lock'), { recursive: true });
    const acquired = [];
    const recovery = tx.withSkillExportLocks([one], ([handle]) => handle.recovery, {
        liveness: liveness(300, [200]),
        acquireGitMetadataLock: key => { acquired.push(key); return tx.acquireGitConfigLock(key, { liveness: liveness(300, [200]) }); },
    });
    assert.deepEqual(acquired, [fs.realpathSync(path.join(project, '.git'))], 'the common Git lock was discovered from the journal');
    assert.equal(recovery.status, 'rolled-forward');
    assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('one', ['demo'])]);
});

test('a private-file-only journal stays pending, unwritten, when the common Git lock cannot be taken', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const one = path.join(project, 'one');
    fs.mkdirSync(one);
    const sync = exporter(root);
    sync(project, ['demo']);
    assert.throws(() => sync(one, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-metadata-journal') }), /simulated crash/);
    fs.rmSync(path.join(project, '.git', 'ploinky-skill-exports-config.lock'), { recursive: true });
    const journalFile = path.join(one, '.agents', '.ploinky-skill-exports.journal.json');
    const journalBytes = read(journalFile);
    const before = gitMetadata(project);
    const gitDir = path.join(project, '.git');
    fs.chmodSync(gitDir, 0o555);
    t.after(() => { try { fs.chmodSync(gitDir, 0o755); } catch (_) {} });
    assert.throws(() => tx.syncManagedSkillExports({ folder: one, owner: 'manifest', sources: [], lock: { liveness: liveness(300, [200]) } }),
        error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED' && /common Git configuration lock/.test(error.message));
    fs.chmodSync(gitDir, 0o755);
    assert.equal(read(journalFile), journalBytes, 'the journal is kept');
    assert.deepEqual(gitMetadata(project), before, 'nothing was written');
    // A busy common lock fails the same way and keeps the journal.
    assert.throws(() => tx.withSkillExportLocks([one], () => null, { liveness: liveness(300, [200]),
        acquireGitMetadataLock: () => { throw tx.skillExportError('SKILL_EXPORT_LOCK_BUSY', 'busy'); } }), { code: 'SKILL_EXPORT_LOCK_BUSY' });
    assert.equal(read(journalFile), journalBytes);
    // With the lock available again the same journal rolls forward.
    assert.equal(tx.withSkillExportLocks([one], ([handle]) => handle.recovery, { liveness: liveness(300, [200]) }).status, 'rolled-forward');
    assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('one', ['demo'])]);
});

test('guard: a journal naming a private file outside the worktree\'s Git directory is refused', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const one = path.join(project, 'one');
    fs.mkdirSync(one);
    const sync = exporter(root);
    sync(project, ['demo']);
    assert.throws(() => sync(one, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-metadata-journal') }), /simulated crash/);
    const journalFile = path.join(one, '.agents', '.ploinky-skill-exports.journal.json');
    const journal = JSON.parse(read(journalFile));
    const target = journal.artifacts.find(artifact => artifact.kind === 'private-file');
    target.path = path.join(root, 'elsewhere.exclude');
    fs.writeFileSync(journalFile, JSON.stringify(journal));
    fs.rmSync(path.join(project, '.git', 'ploinky-skill-exports-config.lock'), { recursive: true });
    assert.throws(() => tx.withSkillExportLocks([one], () => null, { liveness: liveness(300, [200]) }), error => error.code === 'SKILL_EXPORT_RECOVERY_REQUIRED');
    assert.equal(fs.existsSync(path.join(root, 'elsewhere.exclude')), false);
});

// ---------------------------------------------------------------------------
// Review fixes: owner keys follow Git's spelling, a bad key never reaches disk,
// an unverifiable owner folder never aborts planning, and shared bytes stay
// stable with a per-folder broad rule present.

// True when `alias` reaches the entry created as `actual` on this filesystem.
const sameEntry = (parent, actual, alias) => {
    const probe = path.join(parent, actual);
    fs.mkdirSync(probe);
    const reached = fs.existsSync(path.join(parent, alias));
    fs.rmdirSync(probe);
    return reached;
};

const spellings = [
    ['a mis-cased ancestor', 'Workspace', 'workspace', 'case-insensitive'],
    ['an NFD ancestor spelling of an NFC directory', 'café', 'café', 'normalization-insensitive'],
    ['an NFC ancestor spelling of an NFD directory', 'café', 'café', 'normalization-insensitive'],
];
for (const [label, onDisk, alias, capability] of spellings) {
    test(`${label} yields valid owner keys and keeps every folder ignored`, t => {
        const root = base(t);
        const probeParent = path.join(root, 'probe');
        fs.mkdirSync(probeParent);
        if (!sameEntry(probeParent, onDisk, alias)) { t.skip(`this filesystem is not ${capability}`); return; }
        const workspace = path.join(root, onDisk);
        const project = repo(path.join(workspace, 'project'));
        fs.mkdirSync(path.join(project, 'child'));
        skill(root, 'demo');
        const sync = exporter(root);
        const viaAlias = path.join(root, alias, 'project');
        const first = sync(viaAlias, ['demo']);
        assert.equal(first.exclusions.status, 'published');
        assert.deepEqual(Object.keys(recordOf(project).owners), ['.'], 'the key is relative to Git\'s own top level');
        // The canonical spelling and a nested folder then work against the same record.
        const canonical = sync(path.join(project, 'child'), ['demo']);
        assert.equal(canonical.exclusions.status, 'published', canonical.exclusions.reason);
        assert.equal(sync(viaAlias, ['demo']).exclusions.status, 'unchanged');
        assert.deepEqual(Object.keys(recordOf(project).owners).sort(), ['.', 'child']);
        assertAllIgnored(project, [...generatedBy('', ['demo']), ...generatedBy('child', ['demo'])]);
        assert.equal(status(project), '');
    });
}

test('an owner key or pattern that fails validation is deferred and never reaches disk', t => {
    const { project, child, sync, root } = twoFolderState(t);
    skill(root, 'second');
    const before = { ...gitMetadata(project), config: read(path.join(project, '.git', 'config.worktree')) };
    // A Git that reports a prefix outside the worktree.
    const hostile = args => {
        const result = runGit(args, { cwd: child });
        return args.includes('--show-prefix') ? { ...result, stdout: Buffer.from(result.stdout.toString('utf8').replace(/child\/?\n?$/, '') + '../outside/\n') } : result;
    };
    const lying = (args, options) => options?.cwd === child ? hostile(args) : runGit(args, options);
    const result = exporter(root, { git: lying })(child, ['demo', 'second']);
    assert.equal(result.exclusions.status, 'deferred');
    assert.equal(result.exclusions.code, 'exclusions-owner-key-invalid');
    assert.deepEqual({ ...gitMetadata(project), config: read(path.join(project, '.git', 'config.worktree')) }, before);
    assert.deepEqual(result.installed, ['second'], 'the export itself still completes');
});

test('an owner folder replaced by a regular file never aborts planning for the others', t => {
    const { root, project, child, sync } = twoFolderState(t);
    skill(root, 'second');
    fs.rmSync(child, { recursive: true });
    fs.writeFileSync(child, 'now a file');
    const result = sync(project, ['demo', 'second']);
    assert.equal(result.exclusions.status, 'published');
    assert.ok(isIgnored(project, '.agents/skills/second'));
    assert.deepEqual(result.exclusions.warnings.find(item => item.code === 'retained-export-owner-missing')?.folders, ['child']);
    assert.ok(recordOf(project).owners.child, 'the recorded contribution is retained');
});

test('an owner folder that cannot be inspected never aborts planning and is reported as unverifiable', t => {
    const { root, project, child, sync } = twoFolderState(t);
    skill(root, 'second');
    fs.chmodSync(child, 0o000);
    t.after(() => { try { fs.chmodSync(child, 0o755); } catch (_) {} });
    const result = sync(project, ['demo', 'second']);
    fs.chmodSync(child, 0o755);
    assert.equal(result.exclusions.status, 'published');
    assert.ok(isIgnored(project, '.agents/skills/second'));
    assert.deepEqual(result.exclusions.warnings.find(item => item.code === 'retained-export-owner-unverifiable')?.folders, ['child']);
    assert.ok(recordOf(project).owners.child, 'the recorded contribution is retained');
});

test('shared bytes stay stable with a per-folder broad rule present, alternating root and child', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    fs.writeFileSync(path.join(project, '.gitignore'), '/.agents/skills/\n');
    git(project, 'add', '.gitignore');
    git(project, 'commit', '-q', '-m', 'ignore root skills');
    skill(root, 'demo');
    const child = path.join(project, 'child');
    fs.mkdirSync(child);
    const sync = exporter(root);
    const first = sync(project, ['demo']);
    assert.equal(first.exclusions.warnings.filter(item => item.code === 'broad-ignore-rule').length, 1);
    sync(child, ['demo']);
    const files = ['.git/ploinky-skill-exports.exclude', '.git/ploinky-skill-exports.exclusions.json', '.git/config.worktree', '.git/config'].map(file => path.join(project, file));
    const fingerprint = () => files.map(file => { const stat = fs.statSync(file); return [fs.readFileSync(file, 'utf8'), stat.ino, stat.mtimeMs]; });
    const before = fingerprint();
    for (const folder of [project, child, project, child]) {
        const repeat = sync(folder, ['demo']);
        assert.equal(repeat.transaction.status, 'unchanged', folder);
        assert.equal(repeat.exclusions.status, 'unchanged', folder);
        assert.deepEqual(repeat.exclusions.warnings, [], 'the broad rule is reported once');
        assert.deepEqual(fingerprint(), before);
    }
});

test('the advisory for a torn pair points at re-exporting the interrupted folder', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    skill(root, 'demo');
    const [one, two] = ['one', 'two'].map(name => { const folder = path.join(project, name); fs.mkdirSync(folder); return folder; });
    const sync = exporter(root);
    sync(project, ['demo']);
    assert.throws(() => sync(one, ['demo'], { lock: { liveness: liveness(200) }, hooks: simulatedCrash(tx, 'after-private-file') }), /simulated crash/);
    const refused = sync(two, ['demo'], { lock: { liveness: liveness(300, [200]) } });
    assert.equal(refused.exclusions.code, 'managed-excludes-edited');
    assert.match(refused.exclusions.reason, /interrupted/);
    assert.match(refused.exclusions.reason, /export that folder again/);
});

test('a newline-named folder under an unanchored broad rule is deferred without recording anything, and later folders still publish', t => {
    const root = base(t);
    const project = repo(path.join(root, 'project'));
    fs.writeFileSync(path.join(project, '.gitignore'), '.agents/\n');
    git(project, 'add', '.gitignore');
    git(project, 'commit', '-q', '-m', 'ignore agents');
    skill(root, 'demo');
    const sync = exporter(root);
    assert.equal(sync(project, ['demo']).exclusions.status, 'published');
    const hostile = path.join(project, 'bad\nname');
    const third = path.join(project, 'third');
    fs.mkdirSync(hostile);
    fs.mkdirSync(third);
    const before = gitMetadata(project);
    const result = sync(hostile, ['demo']);
    assert.equal(result.exclusions.status, 'deferred');
    assert.equal(result.exclusions.code, 'exclusions-owner-key-invalid');
    assert.deepEqual(gitMetadata(project), before, 'nothing is written for the unrepresentable folder');
    assert.deepEqual(Object.keys(recordOf(project).broadRules || {}), ['.']);
    const next = sync(third, ['demo']);
    assert.equal(next.exclusions.status, 'published', next.exclusions.reason);
    assert.deepEqual(Object.keys(recordOf(project).owners).sort(), ['.', 'third']);
    assert.match(managedOf(project), /^\/third\/\.claude$/m);
});
