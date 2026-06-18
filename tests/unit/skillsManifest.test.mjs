import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
    SKILLS_MANIFEST_FILE,
    installSkillsFromManifest,
    readSkillsManifest,
    findWorkspaceFoldersWithSkillsManifest,
} from '../../cli/services/skills.js';

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
}

function createManifest(root, links) {
    const manifestPath = path.join(root, SKILLS_MANIFEST_FILE);
    fs.writeFileSync(manifestPath, JSON.stringify(links, null, 2));
    return manifestPath;
}

test('readSkillsManifest parses repo links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-'));
    try {
        const manifestPath = createManifest(root, ['repo-a', '  repo-b  ']);
        assert.deepEqual(readSkillsManifest(manifestPath), ['repo-a', 'repo-b']);
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
            './repo-sources/repoA',
            './repo-sources/repoB',
        ]);

        const target = path.join(workspace, 'target');
        fs.mkdirSync(path.join(target, '.agents', 'skills', 'localOnly'), { recursive: true });
        fs.writeFileSync(path.join(target, '.agents', 'skills', 'localOnly', 'SKILL.md'), '# local\n');

        const result = installSkillsFromManifest(manifestPath, { targetRoot: target });

        assert.equal(result.repoCount, 2);
        assert.deepEqual(result.repos.map(r => path.basename(r.source)), ['repoA', 'repoB']);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'owned', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'owned', 'stale')), false);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'fresh', 'SKILL.md')), true);
        assert.equal(fs.existsSync(path.join(target, '.agents', 'skills', 'localOnly', 'SKILL.md')), false);
        assert.equal(fs.lstatSync(path.join(target, '.claude')).isSymbolicLink(), true);
        assert.equal(fs.readlinkSync(path.join(target, '.claude')), '.agents');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('installSkillsFromManifest adds .agents and .claude to gitignore for git repositories', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-git-ignore-'));
    const reposRoot = path.join(workspace, 'repo-sources');
    const repoA = path.join(reposRoot, 'repoA');

    try {
        createSkillRepo(repoA, {
            owned: {
                'SKILL.md': '# repoA owned\n',
            },
        });

        const target = path.join(workspace, 'repo-target');
        fs.mkdirSync(target, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' });

        const manifestPath = createManifest(target, [
            repoA,
        ]);

        installSkillsFromManifest(manifestPath, { targetRoot: target });

        const gitignorePath = path.join(target, '.gitignore');
        const gitignore = fs.readFileSync(gitignorePath, 'utf8');
        assert.equal(/(^|[\n\r])\.agents([\n\r]|$)/m.test(gitignore), true);
        assert.equal(/(^|[\n\r])\.claude([\n\r]|$)/m.test(gitignore), true);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('installSkillsFromManifest does not create or update .gitignore for non-git destinations', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-no-gitignore-'));
    const reposRoot = path.join(workspace, 'repo-sources');
    const repoA = path.join(reposRoot, 'repoA');

    try {
        createSkillRepo(repoA, {
            owned: {
                'SKILL.md': '# repoA owned\n',
            },
        });

        const target = path.join(workspace, 'non-git-target');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, SKILLS_MANIFEST_FILE), JSON.stringify([repoA]));

        const manifestPath = path.join(target, SKILLS_MANIFEST_FILE);
        installSkillsFromManifest(manifestPath, { targetRoot: target });

        assert.equal(fs.existsSync(path.join(target, '.gitignore')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('installSkillsFromManifest resolves duplicate skill names using manifest order (last wins)', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-skill-manifest-dup-'));
    const reposRoot = path.join(workspace, 'repo-sources');
    const first = path.join(reposRoot, 'first');
    const second = path.join(reposRoot, 'second');

    try {
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
            './repo-sources/first',
            './repo-sources/second',
        ]);

        const target = path.join(workspace, 'target');
        const result = installSkillsFromManifest(manifestPath, { targetRoot: target });

        assert.equal(result.duplicateSkills.length, 1);
        assert.equal(result.duplicateSkills[0].skill, 'shared');
        assert.equal(result.duplicateSkills[0].previousSource, './repo-sources/first');
        assert.equal(result.duplicateSkills[0].chosenSource, './repo-sources/second');
        assert.equal(fs.readFileSync(path.join(target, '.agents', 'skills', 'shared', 'SKILL.md'), 'utf8'), '# second\n');
        assert.equal(result.skills.includes('shared'), true);
        assert.equal(result.skills.includes('firstOnly'), true);
        assert.equal(result.skills.includes('secondOnly'), true);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
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
