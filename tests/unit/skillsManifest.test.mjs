import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const originalCwd = process.cwd();
const originalWorkspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const suiteWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-manifest-suite-'));
fs.mkdirSync(path.join(suiteWorkspace, '.ploinky'), { recursive: true });
process.chdir(suiteWorkspace);
process.env.PLOINKY_WORKSPACE_ROOT = suiteWorkspace;

const [{
    SKILLS_MANIFEST_FILE,
    installSkillsFromManifest,
    readSkillsManifest,
    findWorkspaceFoldersWithSkillsManifest,
}, { REPOS_DIR }, { REPO_SOURCES_FILE }] = await Promise.all([
    import('../../cli/services/skills.js'),
    import('../../cli/services/config.js'),
    import('../../cli/services/repos.js'),
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

test('installSkillsFromManifest replaces all skills from listed repos', () => {
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
            manifestEntry(repoA, 'ManifestRepoAInstall', ['owned']),
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
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'localOnly', 'SKILL.md')), false);
        assert.equal(fs.lstatSync(path.join(target, '.claude')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(target, '.claude')), '.agents');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        removeCachedRepo('ManifestRepoAInstall');
        removeCachedRepo('ManifestRepoBInstall');
    }
});

test('installSkillsFromManifest adds .agents and .claude to gitignore for git repositories', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-git-ignore-'));
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

        installSkillsFromManifest(manifestPath, { targetRoot: target });

        const gitignorePath = path.join(target, '.gitignore');
        const gitignore = fs.readFileSync(gitignorePath, 'utf8');
        assert.equal(/(^|[\n\r])\.agents([\n\r]|$)/m.test(gitignore), true);
        assert.equal(/(^|[\n\r])\.claude([\n\r]|$)/m.test(gitignore), true);
    } finally {
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

test('installSkillsFromManifest resolves duplicate skill names using manifest order (last wins)', () => {
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
        const result = installSkillsFromManifest(manifestPath, { targetRoot: target });

        assert.equal(result.duplicateSkills.length, 1);
        assert.equal(result.duplicateSkills[0].skill, 'shared');
        assert.equal(result.duplicateSkills[0].previousSource, 'ManifestRepoFirstDup');
        assert.equal(result.duplicateSkills[0].chosenSource, 'ManifestRepoSecondDup');
        assert.equal(fs.readFileSync(path.join(target, '.agents', 'skills', 'shared', 'SKILL.md'), 'utf8'), '# second\n');
        assert.equal(result.skills.includes('shared'), true);
        assert.equal(result.skills.includes('firstOnly'), true);
        assert.equal(result.skills.includes('secondOnly'), true);
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
