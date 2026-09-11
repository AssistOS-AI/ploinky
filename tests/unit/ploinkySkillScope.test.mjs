import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHostSkillScope, buildLocalSkillScope } from '../../ploinky-box/skillScope.mjs';
import { buildContainerExecArgs } from '../../ploinky-box/command/execute.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';

test('launch scope is canonical and bounded independently of workspace identity', t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-scope-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-outside-'));
    t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
    const left = path.join(workspace, 'left');
    const right = path.join(workspace, 'right');
    fs.mkdirSync(left); fs.mkdirSync(right);
    const identity = buildWorkspaceIdentity(workspace);
    assert.equal(buildHostSkillScope(workspace, left).PLOINKY_SKILL_SCOPE, '/workspace/left');
    assert.equal(buildHostSkillScope(workspace, right).PLOINKY_SKILL_SCOPE, '/workspace/right');
    assert.equal(identity.instance, buildWorkspaceIdentity(workspace).instance);
    fs.symlinkSync(outside, path.join(workspace, 'escape'));
    assert.throws(() => buildHostSkillScope(workspace, path.join(workspace, 'escape')), /outside/);
    const local = buildLocalSkillScope(workspace, right, { PLOINKY_SKILL_SCOPE_VERSION: '1', PLOINKY_SKILL_SCOPE: left, PLOINKY_HOST_LAUNCH_CWD: '/host/left' });
    assert.equal(local.PLOINKY_SKILL_SCOPE, fs.realpathSync(left));
    assert.equal(local.PLOINKY_HOST_LAUNCH_CWD, '/host/left');
    assert.throws(() => buildLocalSkillScope(workspace, right, { PLOINKY_SKILL_SCOPE_VERSION: '1' }), /absolute/);
    assert.throws(() => buildLocalSkillScope(workspace, right, { PLOINKY_SKILL_SCOPE_VERSION: '9' }), /version/);
    assert.throws(() => buildLocalSkillScope(workspace, right, { PLOINKY_SKILL_SCOPE_VERSION: '1', PLOINKY_SKILL_SCOPE: outside }), /outside/);
});

test('two CLI invocations reuse one Box while forwarding their own trusted launch scopes', async t => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-handoff-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    for (const name of ['left', 'right']) fs.mkdirSync(path.join(workspace, name));
    const calls = [];
    const supervisor = { prepareBoxForCommand: async () => ({ identity: buildWorkspaceIdentity(workspace), containerId: 'same-box', engine: { name: 'podman' }, hostPort: 8080, mediaHostPort: 7882 }) };
    for (const name of ['left', 'right']) {
        const status = await runOuterCli(['cli', 'sample'], { supervisor, cwd: () => path.join(workspace, name), detectInsideBox: () => false, input: {}, output: { write() {} }, execute: (_command, args) => { calls.push(args); return 0; } });
        assert.equal(status, 0);
    }
    assert.ok(calls[0].includes('PLOINKY_SKILL_SCOPE=/workspace/left'));
    assert.ok(calls[1].includes('PLOINKY_SKILL_SCOPE=/workspace/right'));
    assert.ok(calls.every(args => args.includes('same-box')));
    assert.ok(calls.every(args => args[args.indexOf('--workdir') + 1] === '/workspace'));
});

test('scope metadata uses engine env arguments without new mounts or cwd changes', () => {
    const args = buildContainerExecArgs('box', ['start', 'example'], { hostPort: 8080, mediaHostPort: 7882, skillScopeEnv: { PLOINKY_SKILL_SCOPE: '/workspace/repo with spaces', PLOINKY_SKILL_SCOPE_VERSION: '1' } });
    assert.ok(args.includes('PLOINKY_SKILL_SCOPE=/workspace/repo with spaces'));
    assert.equal(args.includes('--volume'), false);
    assert.equal(args[args.indexOf('--workdir') + 1], '/workspace');
});
