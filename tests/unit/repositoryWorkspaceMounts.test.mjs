import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_DATA_POLICY_CODE } from '../../cli/utils/runtime/agentDataPathPolicy.js';
import { controllerGuardMounts, controllerGuardTargets } from '../../cli/utils/runtime/controllerStateGuards.js';
import { appendControllerStateGuards as appendContainerGuards } from '../../cli/sandbox/docker/agentServiceManager.js';
import { appendControllerStateGuards as appendBwrapGuards } from '../../cli/sandbox/bwrap/bwrapServiceManager.js';
import { buildInteractiveAgentCreateCommand } from '../../cli/sandbox/docker/interactive.js';

function fixture(t) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-workspace-mounts-')));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const controller = path.join(workspace, '.ploinky');
    const repositories = path.join(controller, 'repos');
    const code = path.join(repositories, 'demo', 'agent');
    fs.mkdirSync(code, { recursive: true });
    fs.mkdirSync(path.join(controller, 'data'));
    // Host launches create the host state skeleton before the guards are planned.
    fs.mkdirSync(path.join(workspace, '.ploinky-box'));
    return { workspace, controller, repositories, code };
}

function plan(workspaceRoot, bindings) {
    return controllerGuardMounts(controllerGuardTargets(bindings, { workspaceRoot }), { workspaceRoot, bindings });
}

test('writable workspace aliases receive only a writable repositories child under read-only controller parents', t => {
    const { workspace, controller, repositories } = fixture(t);
    const mounts = plan(workspace, [
        { hostPath: workspace, runtimePath: '/workspace' },
        { hostPath: workspace, runtimePath: '/root' },
    ]);
    assert.deepEqual(mounts.filter(mount => !mount.readOnly).map(mount => [mount.source, mount.target]), [
        [repositories, '/root/.ploinky/repos'], [repositories, '/workspace/.ploinky/repos'],
    ]);
    for (const target of ['/root', '/workspace']) {
        assert.ok(mounts.some(mount => mount.source === controller && mount.target === `${target}/.ploinky` && mount.readOnly));
        const data = mounts.find(mount => mount.target === `${target}/.ploinky/data`);
        assert.equal(data.readOnly, true);
        assert.notEqual(data.source, path.join(controller, 'data'));
    }
});

test('read-only workspaces and narrow project grants never acquire broader repository access', t => {
    const { workspace, controller, repositories, code } = fixture(t);
    for (const binding of [
        { hostPath: workspace, runtimePath: '/workspace', readOnly: true },
        { hostPath: controller, runtimePath: '/framework' },
        { hostPath: repositories, runtimePath: '/repos' },
        { hostPath: code, runtimePath: '/code' },
        { hostPath: path.join(workspace, '.data'), runtimePath: '/root' },
    ]) {
        assert.equal(plan(workspace, [binding]).some(mount => mount.source === repositories && !mount.readOnly), false);
    }
});

test('explicit read-only controller or repository grants are not overridden and identical writable grants are not duplicated', t => {
    const { workspace, controller, repositories, code } = fixture(t);
    const broad = { hostPath: workspace, runtimePath: '/workspace' };
    for (const binding of [
        { hostPath: controller, runtimePath: '/workspace/.ploinky', readOnly: true },
        { hostPath: repositories, runtimePath: '/workspace/.ploinky/repos', readOnly: true },
        { hostPath: repositories, runtimePath: '/workspace/.ploinky/repos' },
    ]) {
        assert.equal(plan(workspace, [broad, binding]).some(mount => mount.target === '/workspace/.ploinky/repos'), false);
    }
    const mounts = plan(workspace, [broad, { hostPath: code, runtimePath: '/code', readOnly: true }]);
    assert.ok(mounts.some(mount => mount.target === '/workspace/.ploinky/repos' && !mount.readOnly));
    assert.equal(mounts.some(mount => mount.target === '/code'), false);
});

test('missing repositories are not created while conflicting repository targets fail closed', t => {
    const { workspace, repositories } = fixture(t);
    const bindings = [{ hostPath: workspace, runtimePath: '/workspace' }];
    assert.throws(() => plan(workspace, [...bindings, {
        hostPath: workspace, runtimePath: '/workspace/.ploinky/repos',
    }]), error => error.code === AGENT_DATA_POLICY_CODE);
    fs.renameSync(repositories, path.join(workspace, 'saved-repositories'));
    assert.equal(plan(workspace, bindings).some(mount => mount.target.endsWith('/repos')), false);
    assert.equal(fs.existsSync(repositories), false);
});

test('a writable workspace below a read-only parent retains its existing writable scope', t => {
    const { workspace, repositories } = fixture(t);
    const mounts = plan(workspace, [
        { hostPath: path.dirname(workspace), runtimePath: '/home', readOnly: true },
        { hostPath: workspace, runtimePath: '/home/workspace' },
    ]);
    assert.ok(mounts.some(mount => mount.source === repositories
        && mount.target === '/home/workspace/.ploinky/repos' && !mount.readOnly));
    assert.equal(mounts.some(mount => mount.target === '/home' && !mount.readOnly), false);
});

test('repository symlinks and non-directory roots cannot create writable aliases', t => {
    const { workspace, repositories } = fixture(t);
    const saved = path.join(workspace, 'saved-repositories');
    fs.renameSync(repositories, saved);
    for (const destination of [saved, path.join(workspace, '.ploinky', 'data'), os.tmpdir()]) {
        fs.symlinkSync(destination, repositories);
        assert.throws(() => plan(workspace, [{ hostPath: workspace, runtimePath: '/workspace' }]),
            error => error.code === AGENT_DATA_POLICY_CODE);
        fs.unlinkSync(repositories);
    }
    fs.writeFileSync(repositories, 'not a directory');
    assert.throws(() => plan(workspace, [{ hostPath: workspace, runtimePath: '/workspace' }]),
        error => error.code === AGENT_DATA_POLICY_CODE);
});

test('protected controller state cannot be aliased into the writable repository tree', t => {
    const { workspace, controller, repositories } = fixture(t);
    fs.rmdirSync(path.join(controller, 'data'));
    fs.symlinkSync(repositories, path.join(controller, 'data'));
    assert.throws(() => plan(workspace, [{ hostPath: workspace, runtimePath: '/workspace' }]),
        error => error.code === AGENT_DATA_POLICY_CODE);
});

test('canonical workspace and in-workspace controller aliases preserve repository projection', t => {
    const { workspace, controller, repositories } = fixture(t);
    const physicalController = path.join(workspace, '.state');
    fs.renameSync(controller, physicalController);
    fs.symlinkSync('.state', controller);
    const alias = path.join(workspace, 'workspace-alias');
    fs.symlinkSync(workspace, alias);
    const mounts = plan(alias, [{ hostPath: alias, runtimePath: '/workspace' }]);
    assert.ok(mounts.some(mount => mount.source === repositories.replace('/.ploinky/', '/.state/')
        && mount.target === '/workspace/.state/repos' && !mount.readOnly));
});

test('container and bwrap builders preserve read-only code/dependencies while rendering the writable repository overlay', t => {
    const { workspace, controller, repositories, code } = fixture(t);
    for (const runtime of ['podman', 'docker']) {
        const rw = runtime === 'podman' ? ':z' : '';
        const ro = runtime === 'podman' ? ':z,ro' : ':ro';
        const args = ['-v', `${workspace}:/workspace${rw}`, '-v', `${code}:/code${ro}`,
            '-v', `${code}:/workspace/.ploinky/repos/demo/agent${ro}`];
        appendContainerGuards(args, runtime, { workspaceRoot: workspace, canonicalRuntimeWorkspaceGuards: false });
        assert.ok(args.includes(`${repositories}:/workspace/.ploinky/repos${rw}`));
        assert.ok(args.includes(`${controller}:/workspace/.ploinky${ro}`));
        assert.ok(args.includes(`${code}:/code${ro}`));
        assert.ok(args.includes(`${code}:/workspace/.ploinky/repos/demo/agent${ro}`));
    }
    const args = ['--bind', workspace, '/workspace', '--ro-bind', code, '/code',
        '--ro-bind', code, '/workspace/.ploinky/repos/demo/agent', '--chdir', '/workspace'];
    appendBwrapGuards(args, { workspaceRoot: workspace });
    const position = target => args.findIndex((value, index) => value === target && ['--bind', '--ro-bind'].includes(args[index - 2]));
    assert.equal(args[position('/workspace/.ploinky') - 2], '--ro-bind');
    assert.equal(args[position('/workspace/.ploinky/repos') - 2], '--bind');
    assert.equal(args[position('/workspace/.ploinky/repos/demo/agent') - 2], '--ro-bind');
    assert.ok(position('/workspace/.ploinky') < position('/workspace/.ploinky/repos'));
    assert.ok(position('/workspace/.ploinky/repos') < position('/workspace/.ploinky/repos/demo/agent'));
    assert.equal(args[position('/code') - 2], '--ro-bind');
});

test('interactive shells use the same scoped repository overlay without relaxing code or library mounts', t => {
    const { workspace, controller, repositories, code } = fixture(t);
    for (const runtime of ['podman', 'docker']) {
        const rw = runtime === 'podman' ? ':z' : '';
        const ro = runtime === 'podman' ? ':z,ro' : ':ro';
        const command = buildInteractiveAgentCreateCommand({
            runtime, containerName: 'repository-mount-test', envHash: 'test', projectDir: workspace,
            homeDir: path.join(workspace, '.data', 'demo'), sharedDir: path.join(workspace, '.data', 'shared'),
            absAgentPath: code, agentLibPath: path.join(workspace, 'Agent'), containerImage: 'node:24',
            volumeSuffix: rw, readOnlySuffix: ro, workspaceRoot: workspace,
            agentLibGrant: {
                sourceDir: path.join(workspace, 'achillesAgentLib'), runtimePath: '/opt/ploinky-agentlib',
                mode: 'local', fingerprint: 'a1'.repeat(32), commit: '', sourceIdHash: 'b2'.repeat(32), namespaced: true,
            },
        });
        assert.ok(command.includes(`-v "${repositories}:${repositories}${rw}"`));
        assert.ok(command.includes(`-v "${controller}:${controller}${ro}"`));
        assert.ok(command.includes(`-v "${code}:/code${ro}"`));
    }
});

test('podman, docker and bwrap launches mask .ploinky-box read-only, keep the workspace writable and create the skeleton first', t => {
    const { workspace } = fixture(t);
    const hostState = path.join(workspace, '.ploinky-box');
    fs.rmSync(hostState, { recursive: true });
    for (const runtime of ['podman', 'docker']) {
        const rw = runtime === 'podman' ? ':z' : '';
        const ro = runtime === 'podman' ? ':z,ro' : ':ro';
        const args = ['-v', `${workspace}:/workspace${rw}`];
        appendContainerGuards(args, runtime, { workspaceRoot: workspace, canonicalRuntimeWorkspaceGuards: false });
        assert.equal(args[1], `${workspace}:/workspace${rw}`, `${runtime}: the workspace bind stays read-write`);
        const mask = args.find(value => value.endsWith(`:/workspace/.ploinky-box${ro}`));
        assert.ok(mask, `${runtime}: ${args.join(' ')}`);
        assert.notEqual(mask.split(':')[0], hostState, `${runtime}: the mask source is the empty guard`);
        assert.deepEqual(fs.readdirSync(mask.split(':')[0]), []);
        assert.equal(args.some(value => value.startsWith(`${workspace}:/workspace`) && value.endsWith('ro')), false);
    }
    // The first launch created the skeleton; it is never removed afterwards.
    assert.deepEqual(fs.readdirSync(hostState).sort(), ['empty', 'locks', 'quarantine']);
    // bwrap creates it on its own too.
    fs.rmSync(hostState, { recursive: true });
    const args = ['--bind', workspace, '/workspace'];
    appendBwrapGuards(args, { workspaceRoot: workspace });
    assert.deepEqual(fs.readdirSync(hostState).sort(), ['empty', 'locks', 'quarantine']);
    assert.deepEqual(args.slice(0, 3), ['--bind', workspace, '/workspace'], 'bwrap keeps the workspace bind read-write');
    const index = args.indexOf('/workspace/.ploinky-box');
    assert.equal(args[index - 2], '--ro-bind');
    assert.notEqual(args[index - 1], hostState);
});

test('a launch whose .ploinky-box is a link or a file fails before any argument is added', t => {
    const { workspace } = fixture(t);
    const hostState = path.join(workspace, '.ploinky-box');
    const elsewhere = path.join(workspace, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(hostState, { recursive: true });
    for (const plant of [() => fs.symlinkSync('elsewhere', hostState), () => fs.writeFileSync(hostState, 'x')]) {
        plant();
        const containerArgs = ['-v', `${workspace}:/workspace:z`];
        assert.throws(() => appendContainerGuards(containerArgs, 'podman', {
            workspaceRoot: workspace, canonicalRuntimeWorkspaceGuards: false,
        }), error => error?.code === 'PLOINKY_BOX_HOST_STATE_INVALID');
        assert.deepEqual(containerArgs, ['-v', `${workspace}:/workspace:z`]);
        const bwrapArgs = ['--bind', workspace, '/workspace'];
        assert.throws(() => appendBwrapGuards(bwrapArgs, { workspaceRoot: workspace }),
            error => error?.code === 'PLOINKY_BOX_HOST_STATE_INVALID');
        assert.deepEqual(bwrapArgs, ['--bind', workspace, '/workspace']);
        fs.rmSync(hostState, { force: true });
    }
    assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('an interactive shell on a fresh workspace creates the host state skeleton before it plans the mask', t => {
    const { workspace, code } = fixture(t);
    const hostState = path.join(workspace, '.ploinky-box');
    for (const runtime of ['podman', 'docker']) {
        fs.rmSync(hostState, { recursive: true, force: true });
        const ro = runtime === 'podman' ? ':z,ro' : ':ro';
        const command = buildInteractiveAgentCreateCommand({
            runtime, containerName: 'host-state-mask-test', envHash: 'test', projectDir: workspace,
            homeDir: path.join(workspace, '.data', 'demo'), sharedDir: path.join(workspace, '.data', 'shared'),
            absAgentPath: code, agentLibPath: path.join(workspace, 'Agent'), containerImage: 'node:24',
            volumeSuffix: runtime === 'podman' ? ':z' : '', readOnlySuffix: ro, workspaceRoot: workspace,
            agentLibGrant: {
                sourceDir: path.join(workspace, 'achillesAgentLib'), runtimePath: '/opt/ploinky-agentlib',
                mode: 'local', fingerprint: 'a1'.repeat(32), commit: '', sourceIdHash: 'b2'.repeat(32), namespaced: true,
            },
        });
        assert.deepEqual(fs.readdirSync(hostState).sort(), ['empty', 'locks', 'quarantine'], runtime);
        assert.match(command, new RegExp(`-v "[^"]+:${hostState.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${ro}"`), runtime);
        assert.ok(command.includes(`-v "${workspace}:${workspace}${runtime === 'podman' ? ':z' : ''}"`), `${runtime}: the workspace stays writable`);
    }
});
