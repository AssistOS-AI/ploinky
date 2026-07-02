import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { PLOINKY_DIR, REPOS_DIR } from '../../cli/services/config.js';
import {
    refreshDefaultSkillsInPloinkyRepos,
} from '../../cli/commands/repoAgentCommands.js';
import { copySkill, installDefaultSkills } from '../../cli/services/skills.js';

function writeSkill(root, name, files) {
    const skillRoot = path.join(root, name);
    fs.mkdirSync(skillRoot, { recursive: true });
    for (const [relPath, content] of Object.entries(files)) {
        const filePath = path.join(skillRoot, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

function createRepo(repoName, skills) {
    const repoRoot = path.join(REPOS_DIR, repoName);
    const skillsRoot = path.join(repoRoot, 'skills');
    fs.rmSync(repoRoot, { recursive: true, force: true });
    for (const [name, files] of Object.entries(skills)) {
        writeSkill(skillsRoot, name, files);
    }
    return repoRoot;
}

function initGitRepo(repoPath) {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, stdio: 'ignore' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# repo\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: repoPath, stdio: 'ignore' });
}

function removeRepo(repoName) {
    fs.rmSync(path.join(REPOS_DIR, repoName), { recursive: true, force: true });
}

test('copySkill replaces destination so removed source files do not linger', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-'));
    try {
        const src = path.join(root, 'src-skill');
        const dest = path.join(root, 'dest-skill');

        fs.mkdirSync(src, { recursive: true });
        fs.writeFileSync(path.join(src, 'SKILL.md'), '# Current skill\n');
        fs.writeFileSync(path.join(src, 'tool.js'), 'export default 1;\n');

        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'stale.js'), 'stale file\n');

        copySkill(src, dest);

        // Files from source are copied / overwritten
        assert.equal(fs.existsSync(path.join(dest, 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(dest, 'tool.js')), true);
        // Files only in this owned destination skill are removed
        assert.equal(fs.existsSync(path.join(dest, 'stale.js')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('installDefaultSkills refreshes incoming skills and preserves other .agents skills', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-install-'));
    const repoName = `UnitSkills-${process.pid}-${Date.now()}-agents`;
    const repoRoot = createRepo(repoName, {
        owned: {
            'SKILL.md': '# Current skill\n',
            'tool.js': 'export default 1;\n',
        },
    });

    try {
        writeSkill(path.join(root, '.agents', 'skills'), 'owned', {
            'SKILL.md': '# Old skill\n',
            'stale.js': 'stale file\n',
        });
        writeSkill(path.join(root, '.agents', 'skills'), 'local-only', {
            'SKILL.md': '# Local skill\n',
        });
        fs.writeFileSync(path.join(root, '.gitignore'), [
            '# >>> ploinky default-skills >>>',
            '.claude/skills/',
            '.agents/skills/',
            '# <<< ploinky default-skills <<<',
            '',
        ].join('\n'));

        installDefaultSkills(repoName, { targetRoot: root });

        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'tool.js')), true);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'stale.js')), false);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'local-only', 'SKILL.md')), true);
        assert.equal(fs.lstatSync(path.join(root, '.claude')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(root, '.claude')), '.agents');

        const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
        assert.match(gitignore, /^\.claude$/m);
        assert.match(gitignore, /^\.agents\/skills\/owned\/$/m);
        assert.doesNotMatch(gitignore, /^\.agents\/skills\/$/m);
        assert.doesNotMatch(gitignore, /local-only/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('refreshDefaultSkillsInPloinkyRepos installs default skills into managed repos', () => {
    const sourceRepo = `UnitDefaultSkillsRepo-${process.pid}-${Date.now()}`;
    const managedRepo = `UnitManagedRepo-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);
    const sourcePath = path.join(REPOS_DIR, sourceRepo);

    try {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        createRepo(sourceRepo, {
            defaultSkill: {
                'SKILL.md': '# Default skill\n',
                'tool.js': 'export default 1;\n',
            },
        });
        initGitRepo(managedPath);

        const result = refreshDefaultSkillsInPloinkyRepos([managedRepo, sourceRepo], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.defaultSkillsRepoName, sourceRepo);
        assert.equal(result.refreshed.length, 1);
        assert.equal(result.refreshed[0].repoName, managedRepo);
        assert.equal(result.skipped.length, 1);
        assert.equal(result.skipped[0].repoName, sourceRepo);
        assert.equal(result.failed.length, 0);
        assert.equal(
            fs.existsSync(path.join(managedPath, '.agents', 'skills', 'defaultSkill', 'SKILL.md')),
            true,
        );
        assert.equal(fs.lstatSync(path.join(managedPath, '.claude')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(managedPath, '.claude')), '.agents');
        assert.equal(fs.existsSync(path.join(sourcePath, '.agents')), false);

        const gitignore = fs.readFileSync(path.join(managedPath, '.gitignore'), 'utf8');
        assert.match(gitignore, /^\.claude$/m);
        assert.match(gitignore, /^\.agents\/skills\/defaultSkill\/$/m);
        assert.doesNotMatch(gitignore, /^\.agents$/m);
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
    }
});

test('refreshDefaultSkillsInPloinkyRepos skips skills-only repos', () => {
    const sourceRepo = `UnitDefaultSkillsSourceRepo-${process.pid}-${Date.now()}`;
    const managedRepo = `UnitManagedRepoWithSkillsSkip-${process.pid}-${Date.now()}`;
    const skillsRepo = `UnitSkillsOnlyRepo-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);
    const skillsPath = path.join(REPOS_DIR, skillsRepo);
    const sourcePath = path.join(REPOS_DIR, sourceRepo);

    try {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        removeRepo(skillsRepo);
        createRepo(sourceRepo, {
            defaultSkill: {
                'SKILL.md': '# Default skill\n',
            },
        });
        createRepo(skillsRepo, {
            catalogSkill: {
                'SKILL.md': '# Catalog skill\n',
            },
        });
        initGitRepo(managedPath);

        const result = refreshDefaultSkillsInPloinkyRepos([managedRepo, skillsRepo, sourceRepo], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 1);
        assert.equal(result.refreshed[0].repoName, managedRepo);
        assert.equal(result.skipped.length, 2);
        assert.deepEqual(
            result.skipped.map(entry => ({ repoName: entry.repoName, reason: entry.reason })),
            [
                { repoName: skillsRepo, reason: 'skills-only repo' },
                { repoName: sourceRepo, reason: 'default skills source repo' },
            ],
        );
        assert.equal(result.failed.length, 0);
        assert.equal(
            fs.existsSync(path.join(managedPath, '.agents', 'skills', 'defaultSkill', 'SKILL.md')),
            true,
        );
        assert.equal(fs.existsSync(path.join(skillsPath, '.agents')), false);
        assert.equal(fs.existsSync(path.join(sourcePath, '.agents')), false);
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        removeRepo(skillsRepo);
    }
});

test('refreshDefaultSkillsInPloinkyRepos rejects path-like repo names', () => {
    const sourceRepo = `UnitDefaultSkillsSafeSource-${process.pid}-${Date.now()}`;
    const outsideName = `UnitDefaultSkillsOutside-${process.pid}-${Date.now()}`;
    const pathLikeRepo = `../${outsideName}`;
    const outsidePath = path.join(REPOS_DIR, '..', outsideName);

    try {
        removeRepo(sourceRepo);
        fs.rmSync(outsidePath, { recursive: true, force: true });
        createRepo(sourceRepo, {
            defaultSkill: {
                'SKILL.md': '# Default skill\n',
            },
        });
        fs.mkdirSync(outsidePath, { recursive: true });

        const result = refreshDefaultSkillsInPloinkyRepos([pathLikeRepo], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 0);
        assert.equal(result.skipped.length, 0);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].repoName, pathLikeRepo);
        assert.match(result.failed[0].message, /Invalid repository name/);
        assert.equal(fs.existsSync(path.join(outsidePath, '.agents')), false);
        assert.equal(fs.existsSync(path.join(outsidePath, '.claude')), false);
    } finally {
        removeRepo(sourceRepo);
        fs.rmSync(outsidePath, { recursive: true, force: true });
    }
});

test('refreshDefaultSkillsInPloinkyRepos rejects dot repo names without root pollution', () => {
    const sourceRepo = `UnitDefaultSkillsDotSource-${process.pid}-${Date.now()}`;
    const skillName = `defaultSkillDot-${process.pid}-${Date.now()}`;
    const pollutionPaths = [
        path.join(REPOS_DIR, '.agents'),
        path.join(REPOS_DIR, '.claude'),
        path.join(PLOINKY_DIR, '.agents'),
        path.join(PLOINKY_DIR, '.claude'),
    ];
    const existedBefore = new Map(pollutionPaths.map(targetPath => [targetPath, fs.existsSync(targetPath)]));

    try {
        removeRepo(sourceRepo);
        createRepo(sourceRepo, {
            [skillName]: {
                'SKILL.md': '# Default skill\n',
            },
        });

        const result = refreshDefaultSkillsInPloinkyRepos(['.', '..'], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 0);
        assert.equal(result.skipped.length, 0);
        assert.equal(result.failed.length, 2);
        assert.deepEqual(result.failed.map(entry => entry.repoName), ['.', '..']);
        assert.match(result.failed[0].message, /Invalid repository name/);
        assert.match(result.failed[1].message, /Invalid repository name/);
        for (const targetPath of pollutionPaths) {
            if (!existedBefore.get(targetPath)) {
                assert.equal(fs.existsSync(targetPath), false);
            }
        }
        assert.equal(fs.existsSync(path.join(REPOS_DIR, '.agents', 'skills', skillName)), false);
        assert.equal(fs.existsSync(path.join(PLOINKY_DIR, '.agents', 'skills', skillName)), false);
    } finally {
        removeRepo(sourceRepo);
        for (const root of [REPOS_DIR, PLOINKY_DIR]) {
            fs.rmSync(path.join(root, '.agents', 'skills', skillName), { recursive: true, force: true });
            fs.rmSync(path.join(root, '.claude', 'skills', skillName), { recursive: true, force: true });
        }
        for (const targetPath of pollutionPaths) {
            if (!existedBefore.get(targetPath)) {
                fs.rmSync(targetPath, { recursive: true, force: true });
            }
        }
    }
});

test('refreshDefaultSkillsInPloinkyRepos reports default skill install failures', () => {
    const sourceRepo = `UnitDefaultSkillsRepoFailure-${process.pid}-${Date.now()}`;
    const managedRepo = `UnitManagedRepoFailure-${process.pid}-${Date.now()}`;
    const managedPath = path.join(REPOS_DIR, managedRepo);
    const sourcePath = path.join(REPOS_DIR, sourceRepo);

    try {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
        fs.mkdirSync(sourcePath, { recursive: true });
        initGitRepo(managedPath);

        const result = refreshDefaultSkillsInPloinkyRepos([` ${managedRepo} `], {
            defaultSkillsRepoName: sourceRepo,
        });

        assert.equal(result.refreshed.length, 0);
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].repoName, managedRepo);
        assert.match(result.failed[0].message, new RegExp(`No skills/ folder in repo '${sourceRepo}'`));
    } finally {
        removeRepo(sourceRepo);
        removeRepo(managedRepo);
    }
});

test('installDefaultSkills migrates legacy .claude skills without deleting other .claude content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skills-claude-'));
    const repoName = `UnitSkills-${process.pid}-${Date.now()}-claude`;
    const repoRoot = createRepo(repoName, {
        owned: {
            'SKILL.md': '# Current skill\n',
            'fresh.js': 'export default 2;\n',
        },
    });

    try {
        writeSkill(path.join(root, '.claude', 'skills'), 'owned', {
            'SKILL.md': '# Old skill\n',
            'stale.js': 'stale file\n',
        });
        writeSkill(path.join(root, '.claude', 'skills'), 'legacy-only', {
            'SKILL.md': '# Legacy skill\n',
        });
        fs.mkdirSync(path.join(root, '.claude', 'worktrees'), { recursive: true });
        fs.writeFileSync(path.join(root, '.claude', 'worktrees', 'keep.txt'), 'keep\n');

        installDefaultSkills(repoName, { targetRoot: root });

        assert.equal(fs.existsSync(path.join(root, '.claude', 'worktrees', 'keep.txt')), true);
        assert.equal(fs.lstatSync(path.join(root, '.claude')).isDirectory(), true);
        assert.equal(fs.lstatSync(path.join(root, '.claude', 'skills')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(root, '.claude', 'skills')), '../.agents/skills');

        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'fresh.js')), true);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'owned', 'stale.js')), false);
        assert.equal(fs.existsSync(path.join(root, '.agents', 'skills', 'legacy-only', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'legacy-only', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(root, '.claude', 'skills', 'owned', 'fresh.js')), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
