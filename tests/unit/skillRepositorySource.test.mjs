import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveSkillRepositorySource } from '../../cli/utils/skillRepositorySource.js';

test('skill recommendations prefer workspace repositories, then installed repos, then the URL', t => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recommended-skills-'));
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
