import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-kind-')));
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { getSkillRepositoryRecommendations, resolveRepoKind } = await import('../../cli/utils/repos.js');

const recordKind = (name, kind) => fs.writeFileSync(path.join(root, '.ploinky/repo_sources.json'),
    JSON.stringify({ [name]: { url: `https://example.com/${name}.git`, kind } }));
const checkout = name => {
    const repo = path.join(root, '.ploinky/repos', name);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'agent'));
    fs.writeFileSync(path.join(repo, 'agent/manifest.json'), '{}');
    return repo;
};
const addSkill = repo => {
    fs.mkdirSync(path.join(repo, 'skills/example'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'skills/example/SKILL.md'), '---\nname: example\ndescription: Example\n---\n');
};
const recommended = name => getSkillRepositoryRecommendations().find(repo => repo.name === name);

test.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
});

test('an installed repository that gains a root skills folder is recommended despite its recorded agents kind', () => {
    const repo = checkout('GainsSkills');
    recordKind('GainsSkills', 'agents');
    assert.equal(recommended('GainsSkills'), undefined);
    addSkill(repo);
    assert.equal(resolveRepoKind('GainsSkills'), 'mixed');
    assert.deepEqual(recommended('GainsSkills').skillSource, { source: repo, origin: 'installed' });
});

test('an installed repository that loses its skills folder is no longer recommended despite its recorded kind', () => {
    checkout('LosesSkills');
    recordKind('LosesSkills', 'mixed');
    assert.equal(resolveRepoKind('LosesSkills'), 'agents');
    assert.equal(recommended('LosesSkills'), undefined);
});

test('a recorded kind applies while the repository has no checkout, and presets stay authoritative', () => {
    recordKind('RemoteOnly', 'skills');
    assert.equal(resolveRepoKind('RemoteOnly'), 'skills');
    assert.equal(recommended('RemoteOnly').skillSource.origin, 'remote');
    assert.equal(resolveRepoKind('DocumentationSkills'), 'skills');
});
