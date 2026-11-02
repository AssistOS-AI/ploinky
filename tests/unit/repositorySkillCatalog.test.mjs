import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-catalog-')));
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { listRepositorySources } = await import('../../cli/utils/repos.js');
const { readRepositorySkillCatalog } = await import('../../cli/utils/skillRepositorySource.js');

const repository = (name, { skills = [], skillsets, agent = false } = {}) => {
    const repo = path.join(root, '.ploinky/repos', name);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    for (const skill of skills) {
        fs.mkdirSync(path.join(repo, 'skills', skill), { recursive: true });
        fs.writeFileSync(path.join(repo, 'skills', skill, 'SKILL.md'), '');
    }
    if (agent) {
        fs.mkdirSync(path.join(repo, 'agent'));
        fs.writeFileSync(path.join(repo, 'agent/manifest.json'), '{}');
    }
    if (skillsets) fs.writeFileSync(path.join(repo, 'skillsets.md'), skillsets);
    return repo;
};
const listed = name => listRepositorySources().find(repo => repo.name === name);
const set = (name, ...skills) => `# ${name}\n## Description\nAbout ${name}\n## Skills\n${skills.map(skill => `- ${skill}`).join('\n')}\n`;

test.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
});

test('a skills repository lists its skills and root skillsets, keeping shared members in each set', () => {
    repository('SkillsOnly', { skills: ['beta', 'alpha', 'gamma'], skillsets: set('Set One', 'alpha', 'beta') + set('Set Two', 'beta', 'gamma') });
    const repo = listed('SkillsOnly');
    assert.equal(repo.kind, 'skills');
    assert.deepEqual(repo.skills, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(repo.skillsets, [
        { name: 'Set One', description: 'About Set One', skills: ['alpha', 'beta'] },
        { name: 'Set Two', description: 'About Set Two', skills: ['beta', 'gamma'] },
    ]);
    assert.deepEqual(repo.warnings, []);
});

test('a mixed repository lists only skills/ and ignores a skillsets.md beside the skill folders', () => {
    const repo = repository('Mixed', { skills: ['alpha'], agent: true });
    fs.writeFileSync(path.join(repo, 'skills/skillsets.md'), set('Ignored', 'alpha'));
    assert.deepEqual(listed('Mixed').skills, ['alpha']);
    assert.equal(listed('Mixed').kind, 'mixed');
    assert.deepEqual(listed('Mixed').skillsets, []);
});

test('an agents repository carries no catalog', () => {
    repository('AgentsOnly', { agent: true });
    assert.equal(listed('AgentsOnly').kind, 'agents');
    assert.equal('skills' in listed('AgentsOnly'), false);
    assert.equal('skillsets' in listed('AgentsOnly'), false);
});

test('SKILL.md content is not read, and folders without a real SKILL.md are not skills', t => {
    const repo = repository('Unread', { skills: ['alpha'] });
    fs.writeFileSync(path.join(repo, 'skills/alpha/SKILL.md'), 'not a valid descriptor');
    fs.mkdirSync(path.join(repo, 'skills/empty'));
    fs.mkdirSync(path.join(repo, 'skills/.hidden'));
    fs.writeFileSync(path.join(repo, 'skills/.hidden/SKILL.md'), '');
    fs.mkdirSync(path.join(repo, 'skills/linked'));
    fs.symlinkSync(path.join(repo, 'skills/alpha/SKILL.md'), path.join(repo, 'skills/linked/SKILL.md'));
    const read = t.mock.method(fs, 'readFileSync');
    assert.deepEqual(readRepositorySkillCatalog(repo).skills, ['alpha']);
    assert.equal(read.mock.calls.some(call => String(call.arguments[0]).endsWith('SKILL.md')), false);
});

test('an invalid skillsets.md is a warning that keeps the skills listed', () => {
    repository('Broken', { skills: ['alpha'], skillsets: set('Bad', 'missing') });
    const repo = listed('Broken');
    assert.deepEqual(repo.skills, ['alpha']);
    assert.deepEqual(repo.skillsets, []);
    assert.equal(repo.warnings.length, 1);
    assert.match(repo.warnings[0], /Invalid skillsets\.md: unknown or invalid skill/);
    assert.equal(repo.warnings[0].includes(root), false);
});

test('a skillsets.md that is a symbolic link is rejected without being followed', () => {
    const repo = repository('Linked', { skills: ['alpha'] });
    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, set('Outside', 'alpha'));
    fs.symlinkSync(outside, path.join(repo, 'skillsets.md'));
    const catalog = readRepositorySkillCatalog(repo);
    assert.deepEqual(catalog.skillsets, []);
    assert.match(catalog.warnings[0], /regular file/);
});

test('a remote repository has empty lists', () => {
    fs.writeFileSync(path.join(root, '.ploinky/repo_sources.json'), JSON.stringify({ RemoteOnly: { url: 'https://example.com/RemoteOnly.git', kind: 'skills' } }));
    const repo = listed('RemoteOnly');
    assert.equal(repo.origin, 'remote');
    assert.deepEqual([repo.skills, repo.skillsets], [[], []]);
});
