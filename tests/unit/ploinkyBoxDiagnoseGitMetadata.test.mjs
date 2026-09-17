import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { diagnoseWorkspace } from '../../ploinky-box/diagnose.mjs';
import { findExternalGitMetadata } from '../../ploinky-box/diagnose/gitMetadata.mjs';
import { annotateRemediations } from '../../ploinky-box/diagnose/remediations.mjs';

function fixture(t) {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-git-metadata-')));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'work space ăîș');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    return { parent, root, outside };
}

function write(filename, content) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
}

test('only Git metadata the Box cannot read through the workspace path is reported', (t) => {
    const { parent, root, outside } = fixture(t);
    // Ordinary clone and an in-workspace linked worktree with a relative pointer.
    fs.mkdirSync(path.join(root, 'main', '.git', 'worktrees', 'feature'), { recursive: true });
    write(path.join(root, 'main', '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    write(path.join(root, 'feature', '.git'), 'gitdir: ../main/.git/worktrees/feature\r\n');
    // An absolute in-workspace pointer keeps working at the same path.
    fs.mkdirSync(path.join(root, 'main', '.git', 'worktrees', 'absolute'), { recursive: true });
    write(path.join(root, 'absolute', '.git'), `gitdir: ${path.join(root, 'main', '.git', 'worktrees', 'absolute')}\n`);
    // External linked worktree, separated Git directory, and external common directory.
    fs.mkdirSync(path.join(outside, 'main.git', 'worktrees', 'linked'), { recursive: true });
    write(path.join(root, 'linked', '.git'), `gitdir: ${path.join(outside, 'main.git', 'worktrees', 'linked')}\n`);
    fs.mkdirSync(path.join(outside, 'skills.git'));
    fs.mkdirSync(path.join(root, '.ploinky', 'repos', 'Skills'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'skills.git'), path.join(root, '.ploinky', 'repos', 'Skills', '.git'));
    fs.mkdirSync(path.join(root, 'main', '.git', 'worktrees', 'shared'), { recursive: true });
    write(path.join(root, 'main', '.git', 'worktrees', 'shared', 'commondir'), `${path.join(outside, 'main.git')}\n`);
    write(path.join(root, 'shared', '.git'), 'gitdir: ../main/.git/worktrees/shared\n');
    // A sibling whose name extends the workspace path is still outside it.
    fs.mkdirSync(`${root}-other/.git`, { recursive: true });
    write(path.join(root, 'prefix', '.git'), `gitdir: ${root}-other/.git\n`);
    // Deeper checkouts are outside the bounded inspection.
    write(path.join(root, 'deep', 'nested', '.git'), `gitdir: ${path.join(outside, 'main.git')}\n`);

    assert.deepEqual(findExternalGitMetadata(root), [
        { repository: 'linked', metadata: path.join(outside, 'main.git', 'worktrees', 'linked') },
        { repository: 'prefix', metadata: `${root}-other/.git` },
        { repository: 'shared', metadata: path.join(outside, 'main.git') },
        { repository: path.join('.ploinky', 'repos', 'Skills'), metadata: path.join(outside, 'skills.git') },
    ]);

    // A symlink-selected workspace is mounted only at its selected spelling.
    const selected = path.join(parent, 'selected link');
    fs.symlinkSync(root, selected);
    const external = findExternalGitMetadata(selected).map((entry) => entry.repository);
    assert.ok(external.includes('absolute'), 'a canonical absolute pointer is not visible at the selected path');
    assert.equal(external.includes('feature'), false);
    write(path.join(root, 'absolute', '.git'), `gitdir: ${path.join(selected, 'main', '.git', 'worktrees', 'absolute')}\n`);
    assert.equal(findExternalGitMetadata(selected).some((entry) => entry.repository === 'absolute'), false);
});

test('metadata symlink chains must resolve through the selected mount spelling', (t) => {
    const { parent, root } = fixture(t);
    const selected = path.join(parent, 'selected link');
    fs.symlinkSync(root, selected);
    fs.mkdirSync(path.join(root, 'metadata'), { recursive: true });
    fs.symlinkSync(path.join(root, 'metadata'), path.join(root, 'canonical-link'));
    fs.symlinkSync('canonical-link', path.join(root, 'indirect-link'));
    write(path.join(root, 'bad', '.git'), 'gitdir: ../indirect-link\n');
    fs.symlinkSync(path.join(selected, 'metadata'), path.join(root, 'selected-link'));
    write(path.join(root, 'good', '.git'), 'gitdir: ../selected-link\n');

    assert.deepEqual(findExternalGitMetadata(selected), [
        { repository: 'bad', metadata: path.join(selected, 'indirect-link') },
    ]);
    assert.deepEqual(findExternalGitMetadata(root), [
        { repository: 'good', metadata: path.join(root, 'selected-link') },
    ]);
});

test('diagnose warns about unreadable Git metadata without failing or touching the workspace', async (t) => {
    const { root, outside } = fixture(t);
    fs.mkdirSync(path.join(outside, 'main.git', 'worktrees', 'linked'), { recursive: true });
    write(path.join(root, 'linked', '.git'), `gitdir: ${path.join(outside, 'main.git', 'worktrees', 'linked')}\n`);
    const before = fs.readdirSync(root, { recursive: true }).sort();
    const options = {
        cwd: root, env: {},
        runner: { query() { assert.fail('No engine calls expected'); } },
        hostChecks: () => ({ checks: [], engineUsable: false }),
        runtimeChecks: () => assert.fail('Runtime probes must be blocked'),
        repairAssessments: () => [],
    };
    const report = await diagnoseWorkspace(options);
    const check = report.checks.find((entry) => entry.id === 'workspace.git');
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /^linked: .*main\.git\/worktrees\/linked$/);
    assert.match(check.next, /does not mount/);
    assert.deepEqual(check.actionIds, ['keep-git-metadata-in-workspace']);
    assert.equal(report.checks.some((entry) => entry.status === 'fail'), false);
    assert.deepEqual(fs.readdirSync(root, { recursive: true }).sort(), before);

    fs.rmSync(path.join(root, 'linked'), { recursive: true });
    const clean = await diagnoseWorkspace(options);
    assert.equal(clean.checks.find((entry) => entry.id === 'workspace.git').status, 'pass');

    const unmountable = path.join(path.dirname(root), 'pro:ject');
    fs.mkdirSync(unmountable);
    const rejected = await diagnoseWorkspace({ ...options, cwd: unmountable });
    assert.equal(rejected.checks.some((entry) => entry.id === 'workspace.git'), false);
});

test('workspace path checks are never classified by words inside user paths', () => {
    const annotated = annotateRemediations({ version: 1, platform: 'linux', exitCode: 1, checks: [
        { id: 'workspace.path', label: 'path', status: 'fail',
            detail: 'Ploinky Box cannot use the workspace path "/srv/registry overlay/pro:ject": contains \':\'' },
        { id: 'workspace.git', label: 'git', status: 'warn', detail: 'repo: /srv/registry/no space left/.git' },
    ] });
    assert.deepEqual(annotated.checks.map((entry) => entry.actionIds), [
        ['select-mountable-workspace-path'], ['keep-git-metadata-in-workspace'],
    ]);
    assert.ok(annotated.actions.every((entry) => entry.mode === 'manual' && entry.requiresSudo === false));
    assert.equal(annotated.actions.find((entry) => entry.id === 'keep-git-metadata-in-workspace').required, false);
});
