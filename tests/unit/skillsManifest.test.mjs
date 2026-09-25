import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

const originalCwd = process.cwd();
const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const suiteWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-manifest-suite-'));
fs.mkdirSync(path.join(suiteWorkspace, '.ploinky'), { recursive: true });
process.chdir(suiteWorkspace);
process.env.PLOINKY_WORKSPACE_ROOT = suiteWorkspace;
// Never read or compose the global, system or XDG Git policy of this machine.
const gitIsolation = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-manifest-git-')));
fs.writeFileSync(path.join(gitIsolation, 'gitconfig'), '');
delete process.env.PLOINKY_SKILL_EXCLUDES_COMPOSE;
delete process.env.GIT_CONFIG_SYSTEM;
Object.assign(process.env, {
    XDG_CONFIG_HOME: path.join(gitIsolation, 'xdg'), GIT_CONFIG_GLOBAL: path.join(gitIsolation, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
});
test.after(() => fs.rmSync(gitIsolation, { recursive: true, force: true }));

const [{
    SKILLS_MANIFEST_FILE,
    installSkillsFromManifest,
    readSkillsManifest,
    findWorkspaceFoldersWithSkillsManifest,
}, { REPOS_DIR }, { REPO_SOURCES_FILE }] = await Promise.all([
    import('../../cli/commands/skills.js'),
    import('../../cli/utils/config.js'),
    import('../../cli/utils/repos.js'),
]);

test.after(() => {
    process.chdir(originalCwd);
    if (originalWorkspaceRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = originalWorkspaceRoot;
    fs.rmSync(suiteWorkspace, { recursive: true, force: true });
});

function writeSkill(root, name, files) {
    const skillRoot = path.join(root, name);
    fs.mkdirSync(skillRoot, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
        const filePath = path.join(skillRoot, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function createSkillRepo(root, skills) {
    const skillsRoot = path.join(root, 'skills');
    for (const [name, files] of Object.entries(skills)) {
        writeSkill(skillsRoot, name, files);
    }
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
    return root;
}

function createManifest(root, links) {
    const manifestPath = path.join(root, SKILLS_MANIFEST_FILE);
    fs.writeFileSync(manifestPath, JSON.stringify(links, null, 2));
    return manifestPath;
}

function manifestEntry(repoPath, name, skills) {
    return {
        url: repoPath,
        name,
        branch: null,
        skills,
    };
}

function removeCachedRepo(name) {
    fs.rmSync(path.join(REPOS_DIR, name), { recursive: true, force: true });
    try {
        const rawSources = fs.readFileSync(REPO_SOURCES_FILE, 'utf8');
        const sources = JSON.parse(rawSources || '{}');
        if (sources && typeof sources === 'object' && !Array.isArray(sources) && Object.hasOwn(sources, name)) {
            delete sources[name];
            fs.writeFileSync(REPO_SOURCES_FILE, JSON.stringify(sources, null, 2));
        }
    } catch (_) {}
}

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function withCachedSource(name, action) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-cache-'));
    const source = path.join(workspace, 'source');
    const target = path.join(workspace, 'target');
    const cache = path.join(REPOS_DIR, name);
    removeCachedRepo(name);
    try {
        createSkillRepo(source, { shared: { 'SKILL.md': '# original\n' } });
        git(source, 'branch', '-M', 'main');
        fs.mkdirSync(target, { recursive: true });
        const entry = { ...manifestEntry(source, name, ['shared']), branch: 'main' };
        const manifest = createManifest(target, [entry]);
        const skillPath = path.join(target, '.agents', 'skills', 'shared', 'SKILL.md');
        const install = () => installSkillsFromManifest(manifest, { targetRoot: target });
        const updateManifest = (next) => createManifest(target, Array.isArray(next) ? next : [next]);
        action({ workspace, source, target, cache, entry, manifest, skillPath, install, updateManifest });
    } finally {
        removeCachedRepo(name);
        fs.rmSync(workspace, { recursive: true, force: true });
    }
}

test('readSkillsManifest parses repository object entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-'));
    try {
        const manifestPath = createManifest(root, [
            {
                url: 'https://example.invalid/repo-a.git',
                name: 'repo-a',
                branch: null,
                skills: ['alpha'],
            },
            {
                url: 'https://example.invalid/repo-b.git',
                name: 'repo-b',
                branch: 'main',
                skills: ['beta', 'beta'],
            },
        ]);
        assert.deepEqual(readSkillsManifest(manifestPath), [
            {
                url: 'https://example.invalid/repo-a.git',
                name: 'repo-a',
                branch: null,
                skills: ['alpha'],
            },
            {
                url: 'https://example.invalid/repo-b.git',
                name: 'repo-b',
                branch: 'main',
                skills: ['beta'],
            },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('readSkillsManifest rejects invalid content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-invalid-'));
    try {
        const manifestPath = path.join(root, SKILLS_MANIFEST_FILE);
        fs.writeFileSync(manifestPath, JSON.stringify({ foo: 'bar' }));
        assert.throws(() => readSkillsManifest(manifestPath), /expected an array/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('installSkillsFromManifest installs requested skills and preserves unrelated local skills', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-install-'));
    const reposRoot = path.join(workspace, 'repo-sources');
    const repoA = path.join(reposRoot, 'repoA');
    const repoB = path.join(reposRoot, 'repoB');

    try {
        removeCachedRepo('ManifestRepoAInstall');
        removeCachedRepo('ManifestRepoBInstall');
        createSkillRepo(repoA, {
            owned: {
                'SKILL.md': '# repoA owned\n',
                stale: 'stale old\n',
            },
        });
        createSkillRepo(repoB, {
            owned: {
                'SKILL.md': '# repoB owned\n',
            },
            fresh: {
                'SKILL.md': '# fresh\n',
            },
        });

        const manifestPath = createManifest(workspace, [
            manifestEntry(repoA, 'ManifestRepoAInstall', []),
            manifestEntry(repoB, 'ManifestRepoBInstall', ['owned', 'fresh']),
        ]);

        const target = path.join(workspace, 'target');
        fs.mkdirSync(path.join(target, '.agents', 'skills', 'localOnly'), { recursive: true });
        fs.writeFileSync(path.join(target, '.agents', 'skills', 'localOnly', 'SKILL.md'), '# local\n');

        const result = installSkillsFromManifest(manifestPath, { targetRoot: target });

        assert.equal(result.repoCount, 2);
        assert.deepEqual(result.repos.map(r => r.name), ['ManifestRepoAInstall', 'ManifestRepoBInstall']);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'owned', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'owned', 'stale')), false);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'fresh', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'localOnly', 'SKILL.md')), true);
        assert.equal(fs.lstatSync(path.join(target, '.claude')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(target, '.claude')), '.agents');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        removeCachedRepo('ManifestRepoAInstall');
        removeCachedRepo('ManifestRepoBInstall');
    }
});

test('installSkillsFromManifest excludes owned output privately in git repositories without tracked rules', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-git-ignore-'));
    const saved = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
    fs.writeFileSync(path.join(workspace, 'gitconfig'), '');
    Object.assign(process.env, { XDG_CONFIG_HOME: path.join(workspace, 'xdg'), GIT_CONFIG_GLOBAL: path.join(workspace, 'gitconfig') });
    const reposRoot = path.join(workspace, 'repo-sources');
    const repoA = path.join(reposRoot, 'repoA');

    try {
        removeCachedRepo('ManifestRepoGitIgnore');
        createSkillRepo(repoA, {
            owned: {
                'SKILL.md': '# repoA owned\n',
            },
        });

        const target = path.join(workspace, 'repo-target');
        fs.mkdirSync(target, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' });

        const manifestPath = createManifest(target, [
            manifestEntry(repoA, 'ManifestRepoGitIgnore', ['owned']),
        ]);

        const result = installSkillsFromManifest(manifestPath, { targetRoot: target });
        assert.equal(result.exclusions.status, 'published');
        assert.equal(fs.existsSync(path.join(target, '.gitignore')), false);
        // Only the user's own manifest remains visible; the whole .agents is never hidden.
        assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }), '?? ploinky-skills-manifest.json\n');
        assert.throws(() => execFileSync('git', ['check-ignore', '.agents/skills/authored'], { cwd: target, stdio: 'pipe' }));
        assert.equal(installSkillsFromManifest(manifestPath, { targetRoot: target }).exclusions.status, 'unchanged');
    } finally {
        for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        fs.rmSync(workspace, { recursive: true, force: true });
        removeCachedRepo('ManifestRepoGitIgnore');
    }
});

test('installSkillsFromManifest does not create or update .gitignore for non-git destinations', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-no-gitignore-'));
    const reposRoot = path.join(workspace, 'repo-sources');
    const repoA = path.join(reposRoot, 'repoA');

    try {
        removeCachedRepo('ManifestRepoNoGitignore');
        createSkillRepo(repoA, {
            owned: {
                'SKILL.md': '# repoA owned\n',
            },
        });

        const target = path.join(workspace, 'non-git-target');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, SKILLS_MANIFEST_FILE), JSON.stringify([
            manifestEntry(repoA, 'ManifestRepoNoGitignore', ['owned']),
        ]));

        const manifestPath = path.join(target, SKILLS_MANIFEST_FILE);
        installSkillsFromManifest(manifestPath, { targetRoot: target });

        assert.equal(fs.existsSync(path.join(target, '.gitignore')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        removeCachedRepo('ManifestRepoNoGitignore');
    }
});

test('installSkillsFromManifest rejects ambiguous duplicate names before exporting', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-dup-'));
    const reposRoot = path.join(workspace, 'repo-sources');
    const first = path.join(reposRoot, 'first');
    const second = path.join(reposRoot, 'second');

    try {
        removeCachedRepo('ManifestRepoFirstDup');
        removeCachedRepo('ManifestRepoSecondDup');
        createSkillRepo(first, {
            shared: {
                'SKILL.md': '# first\n',
            },
            firstOnly: {
                'SKILL.md': '# firstOnly\n',
            },
        });
        createSkillRepo(second, {
            shared: {
                'SKILL.md': '# second\n',
            },
            secondOnly: {
                'SKILL.md': '# secondOnly\n',
            },
        });

        const manifestPath = createManifest(workspace, [
            manifestEntry(first, 'ManifestRepoFirstDup', ['shared', 'firstOnly']),
            manifestEntry(second, 'ManifestRepoSecondDup', ['shared', 'secondOnly']),
        ]);

        const target = path.join(workspace, 'target');
        assert.throws(() => installSkillsFromManifest(manifestPath, { targetRoot: target }), /Duplicate skill 'shared'/);
        assert.equal(fs.existsSync(path.join(target, '.agents')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        removeCachedRepo('ManifestRepoFirstDup');
        removeCachedRepo('ManifestRepoSecondDup');
    }
});

test('installSkillsFromManifest removes skills from repositories deleted from manifest', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-delete-repo-'));
    const reposRoot = path.join(workspace, 'repo-sources');
    const repoA = path.join(reposRoot, 'repoA');
    const repoB = path.join(reposRoot, 'repoB');

    try {
        removeCachedRepo('ManifestRepoRemovedLater');
        removeCachedRepo('ManifestRepoKeptLater');
        createSkillRepo(repoA, {
            removedRepoSkill: {
                'SKILL.md': '# removed repo skill\n',
            },
        });
        createSkillRepo(repoB, {
            keptRepoSkill: {
                'SKILL.md': '# kept repo skill\n',
            },
        });

        const target = path.join(workspace, 'target');
        fs.mkdirSync(target, { recursive: true });
        const manifestPath = path.join(target, SKILLS_MANIFEST_FILE);
        fs.writeFileSync(manifestPath, JSON.stringify([
            manifestEntry(repoA, 'ManifestRepoRemovedLater', ['removedRepoSkill']),
            manifestEntry(repoB, 'ManifestRepoKeptLater', ['keptRepoSkill']),
        ], null, 2));

        installSkillsFromManifest(manifestPath, { targetRoot: target });
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'removedRepoSkill', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'keptRepoSkill', 'SKILL.md')), true);

        fs.writeFileSync(manifestPath, JSON.stringify([
            manifestEntry(repoB, 'ManifestRepoKeptLater', ['keptRepoSkill']),
        ], null, 2));

        const result = installSkillsFromManifest(manifestPath, { targetRoot: target });
        assert.deepEqual(result.skills, ['keptRepoSkill']);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'removedRepoSkill', 'SKILL.md')), false);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'keptRepoSkill', 'SKILL.md')), true);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        removeCachedRepo('ManifestRepoRemovedLater');
        removeCachedRepo('ManifestRepoKeptLater');
    }
});

test('cached skills switch to the requested branch and pull it even with a different upstream', () => {
    withCachedSource('ManifestBranchSwitch', ({ source, cache, entry, skillPath, install, updateManifest }) => {
        install();
        git(source, 'checkout', '-b', 'next');
        fs.writeFileSync(path.join(source, 'skills', 'shared', 'SKILL.md'), '# next branch\n');
        git(source, 'commit', '-am', 'next branch skill');
        updateManifest({ ...entry, branch: 'next' });

        const switched = install();
        assert.equal(git(cache, 'branch', '--show-current'), 'next');
        assert.equal(switched.repos[0].branch, 'next');
        assert.equal(switched.repos[0].source, source);
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# next branch\n');

        git(cache, 'branch', '--set-upstream-to=origin/main', 'next');
        fs.writeFileSync(path.join(source, 'skills', 'shared', 'SKILL.md'), '# next branch updated\n');
        git(source, 'commit', '-am', 'update next branch');
        install();
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# next branch updated\n');
        assert.equal(git(cache, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'next'));
        install();
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# next branch updated\n');
    });
});

test('cached source URL conflicts include context and preserve the source and installed skills', () => {
    withCachedSource('ManifestUrlConflict', ({ workspace, source, cache, entry, manifest, skillPath, install, updateManifest }) => {
        install();
        const originalHead = git(cache, 'rev-parse', 'HEAD');
        const otherSource = createSkillRepo(path.join(workspace, 'other-source'), { shared: { 'SKILL.md': '# different repository\n' } });
        git(otherSource, 'branch', '-M', 'main');
        updateManifest({ ...entry, url: otherSource });
        assert.throws(install, error => {
            for (const detail of [manifest, 'ManifestUrlConflict', source, otherSource, cache, "requested branch 'main'", 'different manifest name']) {
                assert.ok(error.message.includes(detail), `Missing error context: ${detail}`);
            }
            return true;
        });
        assert.equal(git(cache, 'config', '--get', 'remote.origin.url'), source);
        assert.equal(git(cache, 'rev-parse', 'HEAD'), originalHead);
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
        updateManifest(entry);
        install();
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
    });
});

test('single-branch caches fetch an explicitly requested branch outside their configured refspec', () => {
    withCachedSource('ManifestNarrowCache', ({ workspace, source, cache, entry, skillPath, install, updateManifest }) => {
        git(source, 'checkout', '-b', 'feature');
        fs.writeFileSync(path.join(source, 'skills', 'shared', 'SKILL.md'), '# feature branch\n');
        git(source, 'commit', '-am', 'feature skill');
        git(source, 'checkout', 'main');
        fs.mkdirSync(path.dirname(cache), { recursive: true });
        git(workspace, 'clone', '--single-branch', '--branch', 'main', source, cache);
        assert.equal(git(cache, 'config', '--get', 'remote.origin.fetch'), '+refs/heads/main:refs/remotes/origin/main');
        updateManifest({ ...entry, branch: 'feature' });

        const result = install();
        assert.equal(result.repos[0].branch, 'feature');
        assert.equal(git(cache, 'branch', '--show-current'), 'feature');
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# feature branch\n');
        assert.equal(git(cache, 'config', '--get', 'remote.origin.fetch'), '+refs/heads/main:refs/remotes/origin/main');
        install();
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# feature branch\n');
    });
});

test('equivalent local paths, symlinks, and file URLs reuse the same skills cache', () => {
    withCachedSource('ManifestEquivalentLocal', ({ workspace, source, cache, entry, skillPath, install, updateManifest }) => {
        install();
        const alias = path.join(workspace, 'source-alias');
        fs.symlinkSync(source, alias);
        for (const url of [source + '/', path.join(source, '..', 'source'), alias, pathToFileURL(source).href, path.relative(process.cwd(), source)]) {
            updateManifest({ ...entry, url });
            const result = install();
            assert.equal(result.repos[0].source, source);
            assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
        }
        const caseVariant = path.join(workspace, 'SOURCE');
        if (fs.existsSync(caseVariant)) {
            updateManifest({ ...entry, url: caseVariant });
            install();
            assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
        }
        // An origin recorded relative to its checkout refers to the same source.
        git(cache, 'remote', 'set-url', 'origin', path.relative(cache, source));
        updateManifest(entry);
        install();
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
    });
});

test('equivalent HTTP .git and trailing slash URLs reuse the cache without exposing credentials', () => {
    withCachedSource('ManifestEquivalentHttp', ({ source, cache, entry, install, updateManifest }) => {
        install();
        const origin = 'https://reader:unit-test-secret@example.invalid/team/skills.git/';
        git(cache, 'remote', 'set-url', 'origin', origin);
        // Keep this a real Git pull while routing the test-only URL to its local fixture.
        git(cache, 'config', `url.${source}.insteadOf`, origin);
        updateManifest({ ...entry, url: 'https://example.invalid/team/skills' });
        const result = install();
        assert.equal(result.repos[0].branch, 'main');
        assert.ok(!JSON.stringify(result).includes('unit-test-secret'));

        updateManifest({ ...entry, url: 'https://other-user:other-secret@example.invalid/team/other-skills' });
        assert.throws(install, error => {
            assert.ok(error.message.includes('example.invalid/team/skills'));
            assert.ok(error.message.includes('example.invalid/team/other-skills'));
            assert.ok(!error.message.includes('unit-test-secret'));
            assert.ok(!error.message.includes('other-secret'));
            return true;
        });
    });
});

test('different local repositories with and without a .git suffix are not conflated', () => {
    withCachedSource('ManifestLocalSuffix', ({ workspace, entry, skillPath, install, updateManifest }) => {
        install();
        const otherSource = createSkillRepo(path.join(workspace, 'source.git'), { shared: { 'SKILL.md': '# other\n' } });
        updateManifest({ ...entry, url: otherSource });
        assert.throws(install, /does not match requested URL/);
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
    });
});

test('dirty cache branch changes fail without resetting changes or replacing installed skills', () => {
    withCachedSource('ManifestDirtyBranch', ({ source, cache, entry, manifest, skillPath, install, updateManifest }) => {
        install();
        git(source, 'branch', 'next');
        const changedFile = path.join(cache, 'skills', 'shared', 'SKILL.md');
        fs.writeFileSync(changedFile, '# local changes\n');
        updateManifest({ ...entry, branch: 'next' });
        assert.throws(install, error => {
            assert.ok(error.message.includes(manifest));
            assert.ok(error.message.includes(cache));
            assert.ok(error.message.includes("requested branch 'next'"));
            assert.match(error.message, /uncommitted changes/);
            return true;
        });
        assert.equal(git(cache, 'branch', '--show-current'), 'main');
        assert.equal(fs.readFileSync(changedFile, 'utf8'), '# local changes\n');
        assert.ok(fs.lstatSync(path.dirname(skillPath)).isSymbolicLink());
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# local changes\n');
    });
});

test('unavailable requested branches fail without fallback or replacing installed skills', () => {
    withCachedSource('ManifestMissingBranch', ({ cache, entry, skillPath, install, updateManifest }) => {
        install();
        updateManifest({ ...entry, branch: 'does-not-exist' });
        assert.throws(install, /requested branch 'does-not-exist'.*couldn't find remote ref refs\/heads\/does-not-exist/s);
        assert.equal(git(cache, 'branch', '--show-current'), 'main');
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
    });
});

test('new source branch errors retain manifest and Git details without a default fallback', () => {
    withCachedSource('ManifestMissingColdBranch', ({ cache, entry, manifest, install, updateManifest }) => {
        updateManifest({ ...entry, branch: 'does-not-exist' });
        assert.throws(install, error => {
            assert.ok(error.message.includes(manifest));
            assert.ok(error.message.includes(cache));
            assert.match(error.message, /[Rr]emote branch does-not-exist not found/);
            return true;
        });
        assert.equal(fs.existsSync(cache), false);
    });
});

test('option-like requested branches are rejected before modifying the skills cache', () => {
    withCachedSource('ManifestInvalidBranch', ({ cache, entry, install, updateManifest }) => {
        updateManifest({ ...entry, branch: '--detach' });
        assert.throws(install, /--detach/);
        assert.equal(fs.existsSync(cache), false);
    });
});

test('non-Git cache directories are preserved and identified for manual recovery', () => {
    withCachedSource('ManifestNonGitCache', ({ cache, install }) => {
        fs.mkdirSync(cache, { recursive: true });
        const localFile = path.join(cache, 'local.txt');
        fs.writeFileSync(localFile, 'preserve this');
        assert.throws(install, error => {
            assert.match(error.message, /Cached source is not a Git repository/);
            assert.ok(error.message.includes(cache));
            assert.match(error.message, /move it aside/);
            return true;
        });
        assert.equal(fs.readFileSync(localFile, 'utf8'), 'preserve this');
    });
});

test('strict manifest installation reports removed upstream skills without changing selections', () => {
    withCachedSource('ManifestRenamedSkill', ({ source, entry, manifest, skillPath, install, updateManifest }) => {
        install();
        git(source, 'mv', 'skills/shared', 'skills/renamed');
        git(source, 'commit', '-m', 'rename skill');
        for (let attempt = 0; attempt < 2; attempt += 1) {
            assert.throws(install, error => {
                assert.ok(error.message.includes(manifest));
                assert.ok(error.message.includes(source));
                assert.match(error.message, /Skill 'shared' was not found/);
                assert.match(error.message, /Available skills: renamed/);
                return true;
            });
            assert.ok(fs.lstatSync(path.dirname(skillPath)).isSymbolicLink());
            assert.equal(fs.existsSync(skillPath), false);
        }
        updateManifest({ ...entry, skills: ['renamed'] });
        const result = install();
        assert.deepEqual(result.skills, ['renamed']);
        assert.equal(fs.existsSync(skillPath), false);
    });
});

test('unspecified branches report the actual cached branch', () => {
    withCachedSource('ManifestActualBranch', ({ entry, install, updateManifest }) => {
        install();
        updateManifest({ ...entry, branch: null });
        assert.equal(install().repos[0].branch, 'main');
    });
});

test('multiple branch entries cannot copy from a cache changed by a later entry', () => {
    withCachedSource('ManifestSharedCacheBranches', ({ source, entry, skillPath, install, updateManifest }) => {
        install();
        git(source, 'branch', 'next');
        updateManifest([entry, { ...entry, branch: 'next' }]);
        assert.throws(install, /Use a distinct name for each branch/);
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
    });
});

test('cache aliases through symlinks reject conflicting branches before either checkout changes', () => {
    withCachedSource('ManifestPhysicalCache', ({ source, cache, entry, skillPath, install, updateManifest }) => {
        install();
        git(source, 'branch', 'feature');
        const aliasName = 'ManifestPhysicalCacheAlias';
        const alias = path.join(REPOS_DIR, aliasName);
        fs.symlinkSync(cache, alias);
        try {
            updateManifest([{ ...entry, branch: 'feature' }, { ...entry, name: aliasName, skills: [] }]);
            assert.throws(install, /share cache.*different branches/);
            assert.equal(git(cache, 'branch', '--show-current'), 'main');
            assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
        } finally {
            fs.unlinkSync(alias);
        }
    });
});

test('cache name case variants follow physical filesystem identity before changing branches', () => {
    withCachedSource('ManifestCaseCache', ({ source, cache, entry, skillPath, install, updateManifest }) => {
        install();
        git(source, 'checkout', '-b', 'feature');
        fs.writeFileSync(path.join(source, 'skills', 'shared', 'SKILL.md'), '# feature branch\n');
        git(source, 'commit', '-am', 'feature skill');
        const aliasName = entry.name.toLowerCase();
        const aliasPath = path.join(REPOS_DIR, aliasName);
        updateManifest([{ ...entry, branch: 'feature' }, { ...entry, name: aliasName, skills: [] }]);
        if (fs.existsSync(aliasPath)) {
            assert.throws(install, /share cache.*different branches/);
            assert.equal(git(cache, 'branch', '--show-current'), 'main');
            assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
        } else {
            // Case-sensitive systems have two independent caches, so both are valid.
            try {
                install();
                assert.equal(git(cache, 'branch', '--show-current'), 'feature');
                assert.equal(git(aliasPath, 'branch', '--show-current'), 'main');
                assert.equal(fs.readFileSync(skillPath, 'utf8'), '# feature branch\n');
            } finally {
                removeCachedRepo(aliasName);
            }
        }
    });
});

test('newly cloned caches are checked for case aliases before a later branch can replace them', () => {
    withCachedSource('ManifestColdCaseCache', ({ workspace, source, cache, entry, skillPath, install, updateManifest }) => {
        git(source, 'branch', 'feature');
        const caseProbe = path.join(workspace, 'case-probe');
        fs.writeFileSync(caseProbe, '');
        const caseInsensitive = fs.existsSync(path.join(workspace, 'CASE-PROBE'));
        const aliasName = entry.name.toLowerCase();
        updateManifest([entry, { ...entry, name: aliasName, branch: 'feature', skills: [] }]);
        if (caseInsensitive) {
            assert.throws(install, /share cache.*different branches/);
            assert.equal(git(cache, 'branch', '--show-current'), 'main');
            assert.equal(fs.existsSync(skillPath), false);
        } else {
            try {
                install();
                assert.equal(git(cache, 'branch', '--show-current'), 'main');
                assert.equal(git(path.join(REPOS_DIR, aliasName), 'branch', '--show-current'), 'feature');
            } finally {
                removeCachedRepo(aliasName);
            }
        }
    });
});

test('skills caches reject multiple origin URLs before fetching from an ambiguous source', () => {
    withCachedSource('ManifestMultipleOrigins', ({ workspace, source, cache, skillPath, install }) => {
        install();
        const originalHead = git(cache, 'rev-parse', 'HEAD');
        const foreign = path.join(workspace, 'foreign');
        createSkillRepo(foreign, { shared: { 'SKILL.md': '# foreign\n' } });
        git(foreign, 'branch', '-M', 'main');
        git(cache, 'config', '--replace-all', 'remote.origin.url', foreign);
        git(cache, 'config', '--add', 'remote.origin.url', source);
        assert.throws(install, /must have exactly one fetch URL/);
        assert.equal(git(cache, 'rev-parse', 'HEAD'), originalHead);
        assert.equal(fs.readFileSync(skillPath, 'utf8'), '# original\n');
    });
});

test('findWorkspaceFoldersWithSkillsManifest finds manifest files recursively', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-discovery-'));

    try {
        const rootManifest = path.join(workspace, SKILLS_MANIFEST_FILE);
        const nestedFolder = path.join(workspace, 'nested');
        const deepFolder = path.join(nestedFolder, 'deeper');
        fs.mkdirSync(deepFolder, { recursive: true });
        fs.writeFileSync(rootManifest, '[]', 'utf8');
        fs.writeFileSync(path.join(deepFolder, SKILLS_MANIFEST_FILE), '[]', 'utf8');

        const folders = findWorkspaceFoldersWithSkillsManifest(workspace);
        const expected = [path.resolve(workspace), path.resolve(deepFolder)];
        assert.deepEqual(folders, expected);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('findWorkspaceFoldersWithSkillsManifest skips hidden and ignored workspace directories', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-skip-'));

    try {
        fs.writeFileSync(path.join(workspace, SKILLS_MANIFEST_FILE), '[]', 'utf8');
        fs.mkdirSync(path.join(workspace, '.hidden', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(workspace, '.hidden', SKILLS_MANIFEST_FILE), '[]', 'utf8');
        fs.mkdirSync(path.join(workspace, 'node_modules', 'deps', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'node_modules', 'deps', SKILLS_MANIFEST_FILE), '[]', 'utf8');
        fs.mkdirSync(path.join(workspace, '.git', 'modules'), { recursive: true });
        fs.writeFileSync(path.join(workspace, '.git', SKILLS_MANIFEST_FILE), '[]', 'utf8');
        fs.mkdirSync(path.join(workspace, 'public', 'proj'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'public', 'proj', SKILLS_MANIFEST_FILE), '[]', 'utf8');

        const folders = findWorkspaceFoldersWithSkillsManifest(workspace).sort();
        const expected = [path.resolve(workspace), path.resolve(path.join(workspace, 'public', 'proj'))].sort();
        assert.deepEqual(folders, expected);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('manifest exports prefer dirty workspace skills over the managed copy without pulling', () => {
    const name = 'WorkspacePreferredSkills';
    const local = path.join(suiteWorkspace, name);
    const cached = path.join(REPOS_DIR, name);
    const target = path.join(suiteWorkspace, 'workspace-preferred-target');
    try {
        createSkillRepo(local, { example: { 'SKILL.md': '---\nname: example\ndescription: Local skill\n---\nlocal\n' } });
        createSkillRepo(cached, { example: { 'SKILL.md': 'cached version\n' } });
        const file = path.join(local, 'skills/example/SKILL.md');
        fs.appendFileSync(file, 'Uncommitted local edit\n');
        fs.mkdirSync(target);
        const manifest = createManifest(target, [{ url: 'https://example.invalid/WorkspacePreferredSkills.git', name, skills: ['example'] }]);
        const result = installSkillsFromManifest(manifest, { targetRoot: target });
        assert.equal(result.repos[0].source, local);
        assert.match(fs.readFileSync(path.join(target, '.agents/skills/example/SKILL.md'), 'utf8'), /Uncommitted local edit/);
        assert.equal(fs.readFileSync(path.join(cached, 'skills/example/SKILL.md'), 'utf8'), 'cached version\n');
        execFileSync('git', ['checkout', '--detach'], { cwd: local, stdio: 'ignore' });
        assert.equal(installSkillsFromManifest(manifest, { targetRoot: target }).repos[0].source, local);
    } finally {
        for (const directory of [local, cached, target]) fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('update pruning removes missing selections and their dangling symlinks, including the final skill', () => {
    const name = 'PrunedWorkspaceSkills';
    const source = path.join(suiteWorkspace, name);
    const target = path.join(suiteWorkspace, 'pruned-workspace-target');
    try {
        createSkillRepo(source, {
            keep: { 'SKILL.md': '# Keep\n' },
            removed: { 'SKILL.md': '# Removed\n' },
        });
        fs.mkdirSync(target);
        const manifest = createManifest(target, [{ name, url: source, skills: ['keep', 'removed'], note: 'preserved' }]);
        const install = options => installSkillsFromManifest(manifest, { targetRoot: target, ...options });
        install();
        const link = path.join(target, '.agents/skills/removed');
        assert.ok(fs.lstatSync(link).isSymbolicLink());
        const original = fs.readFileSync(manifest, 'utf8');
        fs.rmSync(path.join(source, 'skills/removed'), { recursive: true });
        assert.throws(() => install(), /was not found/);
        assert.equal(fs.readFileSync(manifest, 'utf8'), original);
        const result = install({ pruneMissing: true });
        assert.deepEqual(result.prunedSkills, [{ repository: name, skill: 'removed' }]);
        assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), [
            { name, url: source, skills: ['keep'], note: 'preserved' },
        ]);
        assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
        assert.ok(fs.lstatSync(path.join(target, '.agents/skills/keep')).isSymbolicLink());
        fs.rmSync(path.join(source, 'skills'), { recursive: true });
        install({ pruneMissing: true });
        assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8'))[0].skills, []);
        assert.deepEqual(fs.readdirSync(path.join(target, '.agents/skills')), []);
    } finally {
        fs.rmSync(source, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
    }
});

test('update pruning preserves manifests and links when a source cannot be read', () => {
    const name = 'UnavailableWorkspaceSkills';
    const source = path.join(suiteWorkspace, name);
    const target = path.join(suiteWorkspace, 'unavailable-workspace-target');
    try {
        createSkillRepo(source, { keep: { 'SKILL.md': '# Keep\n' } });
        fs.mkdirSync(target);
        const manifest = createManifest(target, [{ name, url: source, skills: ['keep'] }]);
        installSkillsFromManifest(manifest, { targetRoot: target });
        const original = fs.readFileSync(manifest, 'utf8');
        fs.rmSync(path.join(source, 'skills'), { recursive: true });
        fs.writeFileSync(path.join(source, 'skills'), 'not a directory');
        assert.throws(() => installSkillsFromManifest(manifest, { targetRoot: target, pruneMissing: true }), /No skills/);
        assert.equal(fs.readFileSync(manifest, 'utf8'), original);
        assert.ok(fs.lstatSync(path.join(target, '.agents/skills/keep')).isSymbolicLink());
    } finally {
        fs.rmSync(source, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
    }
});
