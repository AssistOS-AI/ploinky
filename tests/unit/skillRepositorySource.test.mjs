import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveSkillRepositorySource } from '../../cli/utils/skillRepositorySource.js';

test('skill recommendations prefer workspace repositories, then installed repos, then the URL', t => {
    const workspaceRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'recommended-skills-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const url = 'https://example.com/DocumentationSkills.git';
    const resolve = () => resolveSkillRepositorySource('DocumentationSkills', url, { workspaceRoot });
    assert.deepEqual(resolve(), { source: url, origin: 'remote' });
    const installed = path.join(workspaceRoot, '.ploinky/repos/DocumentationSkills');
    fs.mkdirSync(path.join(installed, '.git'), { recursive: true });
    assert.deepEqual(resolve(), { source: installed, origin: 'installed' });
    const local = path.join(workspaceRoot, 'DocumentationSkills');
    fs.mkdirSync(local);
    assert.equal(resolve().origin, 'installed'); // A same-name ordinary directory is not a repository.
    fs.writeFileSync(path.join(local, '.git'), 'gitdir: /worktree-metadata');
    assert.deepEqual(resolve(), { source: local, origin: 'workspace' });
});

test('recommendations cannot escape the workspace through names or symlinks', t => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recommended-scope-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-skills-'));
    t.after(() => { fs.rmSync(workspaceRoot, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
    fs.mkdirSync(path.join(outside, '.git'));
    fs.symlinkSync(outside, path.join(workspaceRoot, 'Skills'));
    const url = 'https://example.com/skills.git';
    assert.deepEqual(resolveSkillRepositorySource('Skills', url, { workspaceRoot }), { source: url, origin: 'remote' });
    assert.deepEqual(resolveSkillRepositorySource('../Skills', url, { workspaceRoot }), { source: url, origin: 'remote' });
});

test('discovers unregistered workspace skill repositories and rejects invalid or external trees', async t => {
    const { listWorkspaceSkillRepositories } = await import('../../cli/utils/skillRepositorySource.js');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-skills-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const make = (name, descriptor = '---\nname: example\ndescription: Example skill\n---\nInstructions') => {
        const root = path.join(workspaceRoot, name);
        fs.mkdirSync(path.join(root, 'skills/example'), { recursive: true });
        fs.mkdirSync(path.join(root, '.git'));
        fs.writeFileSync(path.join(root, 'skills/example/SKILL.md'), descriptor);
        return root;
    };
    const local = make('LocalSkills');
    make('InvalidSkills', '# No frontmatter');
    make('NoDescription', '---\nname: example\n---\n');
    const mixed = make('PartlyValid');
    fs.mkdirSync(path.join(mixed, 'skills/invalid'));
    const ordinary = make('NotARepository');
    fs.rmSync(path.join(ordinary, '.git'), { recursive: true });
    make('.ploinky/repos/HiddenSkills');
    fs.symlinkSync(local, path.join(workspaceRoot, 'Alias'));
    assert.deepEqual(listWorkspaceSkillRepositories({ workspaceRoot }), [
        { name: 'LocalSkills', source: local, origin: 'workspace' },
        { name: 'PartlyValid', source: mixed, origin: 'workspace', warnings: ['skills/invalid: missing SKILL.md'] }
    ]);
    fs.writeFileSync(path.join(local, 'skills/example/SKILL.md'), '---\nname: example\ndescription: >\n  A multiline\n  description\n---\n');
    assert.equal(listWorkspaceSkillRepositories({ workspaceRoot }).length, 2);
});

test('excludes AgentLib repositories for every supported descriptor, including nested and mixed trees', async t => {
    const { listWorkspaceSkillRepositories } = await import('../../cli/utils/skillRepositorySource.js');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlib-skills-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    for (const descriptor of ['oskill.md', 'cskill.md', 'dcgskill.md', 'tskill.md']) {
        const root = path.join(workspaceRoot, descriptor.replace('.md', ''));
        fs.mkdirSync(path.join(root, '.git'), { recursive: true });
        fs.mkdirSync(path.join(root, 'skills/group/typed'), { recursive: true });
        fs.writeFileSync(path.join(root, 'skills/group/typed', descriptor), '# Typed skill');
        fs.mkdirSync(path.join(root, 'skills/valid'));
        fs.writeFileSync(path.join(root, 'skills/valid/SKILL.md'), '---\nname: valid\ndescription: Valid skill\n---\n');
    }
    const incomplete = path.join(workspaceRoot, 'Incomplete');
    fs.mkdirSync(path.join(incomplete, '.git'), { recursive: true });
    fs.mkdirSync(path.join(incomplete, 'skills/unfinished'), { recursive: true });
    assert.deepEqual(listWorkspaceSkillRepositories({ workspaceRoot }), [{
        name: 'Incomplete', source: incomplete, origin: 'workspace',
        warnings: ['skills/unfinished: missing SKILL.md']
    }]);
});
