import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-source-links-'));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const { createAgentSymlinks, getAgentCodePath, getAgentSkillsPath } = await import('../../cli/utils/workspaceStructure.js');
after(() => fs.rmSync(workspace, { recursive: true, force: true }));

function sources(agent) {
    const cached = path.join(workspace, '.ploinky/repos/example', agent);
    const local = path.join(workspace, 'example', agent);
    fs.mkdirSync(path.join(cached, 'skills'), { recursive: true });
    fs.mkdirSync(local, { recursive: true });
    createAgentSymlinks(agent, 'example', cached);
    return { cached, local };
}

test('switching to a workspace source removes obsolete skills without deleting their source', () => {
    const { cached, local } = sources('switch');
    fs.writeFileSync(path.join(cached, 'skills/keep.txt'), 'original');
    createAgentSymlinks('switch', 'example', local);
    assert.equal(fs.realpathSync(getAgentCodePath('switch')), local);
    assert.throws(() => fs.lstatSync(getAgentSkillsPath('switch')), { code: 'ENOENT' });
    assert.equal(fs.readFileSync(path.join(cached, 'skills/keep.txt'), 'utf8'), 'original');
});

test('a dangling skills link is removed when the selected source has no skills', () => {
    const { cached, local } = sources('dangling');
    fs.rmdirSync(path.join(cached, 'skills'));
    createAgentSymlinks('dangling', 'example', local);
    assert.throws(() => fs.lstatSync(getAgentSkillsPath('dangling')), { code: 'ENOENT' });
});

test('a real user skills directory survives a source without skills', () => {
    const { local } = sources('user-owned');
    const skills = getAgentSkillsPath('user-owned');
    fs.unlinkSync(skills);
    fs.mkdirSync(skills);
    fs.writeFileSync(path.join(skills, 'keep.txt'), 'user data');
    createAgentSymlinks('user-owned', 'example', local);
    assert.equal(fs.readFileSync(path.join(skills, 'keep.txt'), 'utf8'), 'user data');
});

test('switching sources redirects both links when the new source has skills', () => {
    const { local } = sources('both');
    fs.mkdirSync(path.join(local, 'skills'));
    createAgentSymlinks('both', 'example', local);
    assert.equal(fs.realpathSync(getAgentCodePath('both')), local);
    assert.equal(fs.realpathSync(getAgentSkillsPath('both')), path.join(local, 'skills'));
});

for (const [runtime, entry] of [['bwrap', 'startBwrapProcess'], ['seatbelt', 'startSeatbeltProcess']]) {
    test(`${runtime} refreshes source links before capturing paths for dependencies and execution`, () => {
        const source = fs.readFileSync(new URL(`../../cli/sandbox/${runtime}/${runtime}ServiceManager.js`, import.meta.url), 'utf8');
        const body = source.slice(source.indexOf(`function ${entry}(`));
        const lifecycle = body.indexOf('const preLifecycle = runPreContainerLifecycle(');
        const failure = body.indexOf('if (!preLifecycle.success)');
        const code = body.indexOf('const agentCodePath = resolveSymlinkPath(');
        const skills = body.indexOf('const agentSkillsPath = resolveSymlinkPath(');
        const dependencies = body.indexOf('const agentHasPackageJson =');
        assert.ok(lifecycle >= 0 && failure > lifecycle && code > failure && skills > failure);
        assert.ok(dependencies > code && dependencies > skills);
    });
}
