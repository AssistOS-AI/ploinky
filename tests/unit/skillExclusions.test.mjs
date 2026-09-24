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
    IGNORE_MARKER_START,
    IGNORE_MARKER_END,
} from '../../cli/utils/skills/exportExclusions.mjs';
import { installRepositoryLinks, removeRepositoryLinks } from '../../cli/utils/repositoryInstall.mjs';
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
        folder, owner: 'manifest', mode: 'symlink', claude: 'root-or-skills',
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
    assert.equal(preserved.exclusions.code, 'legacy-ignore-block-preserved');
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

test('marketplace install and removal refresh private exclusions', t => {
    const root = base(t);
    const workspace = repo(path.join(root, 'workspace'));
    const docs = path.join(workspace, 'Docs');
    fs.mkdirSync(path.join(docs, 'skills', 'example'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'skills', 'example', 'SKILL.md'), 'Example');
    git(workspace, 'add', 'Docs');
    git(workspace, 'commit', '-q', '-m', 'docs');
    const options = { workspaceRoot: workspace, resolveRepository: () => ({ source: docs }) };
    const robot = path.join(workspace, 'robot');
    installRepositoryLinks({ skillRepos: [{ repoName: 'Docs', destination: robot, skills: ['example'] }] }, options);
    assert.equal(status(workspace), '');
    removeRepositoryLinks([path.join(robot, '.agents', 'skills', 'example')], options);
    assert.doesNotMatch(read(path.join(workspace, '.git', 'ploinky-skill-exports.exclude')), /example/);
    assert.equal(status(workspace), '');
});

// ---------------------------------------------------------------------------
// Pre-pull assessment.

const LEGACY_BLOCK = `${IGNORE_MARKER_START}\n.claude\n.agents/skills/demo/\n${IGNORE_MARKER_END}\n`;

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
    ['a legacy block', `node_modules\n${LEGACY_BLOCK}`],
    ['a legacy block with CRLF line endings', `node_modules\r\n${LEGACY_BLOCK.replace(/\n/g, '\r\n')}`],
    ['a legacy block without a final newline', `node_modules\n${LEGACY_BLOCK.trimEnd()}`],
    ['multiple legacy blocks', `node_modules\n${LEGACY_BLOCK}${LEGACY_BLOCK}`],
    ['a user edit inside the block', `node_modules\n${LEGACY_BLOCK.replace('.claude\n', '.claude\n/mine\n')}`],
    ['a user edit outside the block', `node_modules\ndist\n${LEGACY_BLOCK}`],
]) {
    test(`assessment preserves ${label} without a write receipt`, t => {
        const project = trackedIgnore(base(t), 'node_modules\n');
        fs.writeFileSync(path.join(project, '.gitignore'), content);
        const result = assessGeneratedIgnoreState({ repoPath: project });
        assert.equal(result.status, 'preserve');
        assert.equal(result.code, 'legacy-ignore-block-preserved');
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
        assert.equal(assessGeneratedIgnoreState({ repoPath: edited }).code, 'legacy-ignore-block-preserved');
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
    fs.appendFileSync(path.join(conflicted, '.gitignore'), LEGACY_BLOCK);
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
    const result = tx.syncManagedSkillExports({ folder: nested, owner: 'manifest', mode: 'symlink', sources: [{ name: 'demo', path: path.join(root, 'sources', 'demo') }],
        exclusions: createSkillExclusionPlanner({ nonGitBlock: true, git: refusing }) });
    assert.equal(result.exclusions.code, 'git-identity-unavailable');
    assert.equal(fs.existsSync(path.join(nested, '.gitignore')), false);
    assert.deepEqual(result.installed, ['demo'], 'the export itself still publishes');

    const notRepository = () => ({ status: 128, stdout: Buffer.alloc(0), stderr: 'fatal: not a git repository (or any of the parent directories): .git' });
    const ceiling = tx.syncManagedSkillExports({ folder: nested, owner: 'manifest', mode: 'symlink', sources: [],
        exclusions: createSkillExclusionPlanner({ nonGitBlock: true, git: notRepository }) });
    assert.equal(ceiling.exclusions.code, 'git-identity-unavailable', 'a .git above the target overrides a negative discovery');

    const missing = () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); };
    const noGit = tx.syncManagedSkillExports({ folder: nested, owner: 'manifest', mode: 'symlink', sources: [],
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
    const plain = tx.syncManagedSkillExports({ folder: project, owner: 'manifest', mode: 'symlink', sources: [{ name: 'demo', path: path.join(root, 'sources', 'demo') }], lock: { liveness: liveness(300, [200]) } });
    assert.equal(plain.recovery.status, 'rolled-forward');
    assert.equal(status(project), '');
});
