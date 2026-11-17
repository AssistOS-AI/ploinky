import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    appendControllerStateGuards,
    buildPodmanStagedTargetMounts,
    podmanMountSuffix,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { assertDataLayoutCurrent } from '../../cli/utils/workspaceDataLayout.js';
import { AGENT_DATA_POLICY_CODE } from '../../cli/utils/runtime/agentDataPathPolicy.js';
import { ensureControllerGuardSources, guardSourceEntries } from '../../cli/utils/runtime/controllerStateGuards.js';

// In a Box, a launch with no broad workspace bind gets the `.data` mask from the
// one guard source that every launch of the workspace shares. A bind nested below
// that mask makes the engine create its mountpoint inside the shared source, and
// every later launch is then refused. These tests drive the production guard entry
// point with the launch shapes seen on Explorer QA and emulate the engine.

function workspace(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mask-nest-')));
    fs.mkdirSync(path.join(root, '.data', 'agents'), { recursive: true, mode: 0o700 });
    // Stamp the current data layout once, so concurrent launches never race on initializing it.
    assertDataLayoutCurrent(root);
    const shared = ensureControllerGuardSources({ workspaceRoot: root }).get('workspace-data');
    t.after(() => {
        const base = path.dirname(shared);
        const unlock = (directory) => {
            if (!fs.existsSync(directory) || fs.lstatSync(directory).isSymbolicLink()) return;
            fs.chmodSync(directory, 0o755);
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (entry.isDirectory()) unlock(path.join(directory, entry.name));
                else if (entry.isFile()) fs.chmodSync(path.join(directory, entry.name), 0o644);
            }
        };
        unlock(base);
        fs.rmSync(base, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, shared };
}

// An isolated agent with no prepared dependency tree, as liveKitServerAgent: its
// empty node_modules lives in its home and the staged /Agent links it, so it is
// also mounted at its real path, below `<ws>/.data`.
function isolatedNoCacheLaunch(root, agent) {
    const home = path.join(root, '.data', 'agents', agent);
    const nodeModules = path.join(home, 'node_modules');
    const code = path.join(root, '.ploinky', 'repos', 'webmeet', agent);
    fs.mkdirSync(nodeModules, { recursive: true });
    fs.mkdirSync(code, { recursive: true });
    const args = ['-v', `${home}:/root:z`, '-v', `${code}:/code:z,ro`, '-v', `${nodeModules}:/code/node_modules:z,ro`];
    for (const mount of buildPodmanStagedTargetMounts({
        agentCodePath: code, nodeModulesDir: nodeModules, codeReadOnly: true, writableProjectSource: false,
    })) {
        args.push('-v', `${mount.source}:${mount.target}${podmanMountSuffix(mount.ro)}`);
    }
    return { args, home };
}

// An isolated agent whose dependency tree comes from the store outside `.data`, as emailAgent.
function isolatedStoreLaunch(root, agent) {
    const home = path.join(root, '.data', 'agents', agent);
    const nodeModules = path.join(root, '.ploinky', 'deps', agent, 'node_modules');
    const code = path.join(root, '.ploinky', 'repos', 'AchillesIDE', agent);
    for (const directory of [home, nodeModules, code]) fs.mkdirSync(directory, { recursive: true });
    const args = ['-v', `${home}:/root:z`, '-v', `${code}:/code:z,ro`, '-v', `${nodeModules}:/code/node_modules:z,ro`];
    for (const mount of buildPodmanStagedTargetMounts({
        agentCodePath: code, nodeModulesDir: nodeModules, codeReadOnly: true, writableProjectSource: false,
    })) {
        args.push('-v', `${mount.source}:${mount.target}${podmanMountSuffix(mount.ro)}`);
    }
    return { args, home };
}

function guard(root, launch, agent) {
    appendControllerStateGuards(launch.args, 'podman', {
        workspaceRoot: root,
        canonicalRuntimeWorkspaceGuards: true,
        agentName: agent,
        agentDataDir: launch.home,
    });
    return launch.args;
}

function volumes(args) {
    const mounts = [];
    for (let index = 0; index < args.length - 1; index += 1) {
        if (args[index] !== '-v') continue;
        const [source, target] = String(args[index + 1]).split(':');
        mounts.push({ source, target });
    }
    return mounts;
}

// What the engine does with a bind whose target lies below another bind: it
// creates the missing mountpoint inside the parent bind's source, as the user
// namespace root that mode 0555 does not stop.
function emulateEngine(args) {
    const mounts = volumes(args);
    for (const mount of mounts) {
        const parents = mounts.filter(other => other !== mount && mount.target.startsWith(`${other.target}/`));
        if (!parents.length) continue;
        const parent = parents.reduce((left, right) => (left.target.length >= right.target.length ? left : right));
        let current = parent.source;
        const segments = path.posix.relative(parent.target, mount.target).split('/');
        segments.forEach((segment, index) => {
            const next = path.join(current, segment);
            if (!fs.existsSync(next)) {
                const mode = fs.statSync(current).mode & 0o7777;
                fs.chmodSync(current, mode | 0o200);
                if (index === segments.length - 1 && fs.statSync(mount.source).isFile()) fs.writeFileSync(next, '');
                else fs.mkdirSync(next);
                fs.chmodSync(current, mode);
            }
            current = next;
        });
    }
}

function dataMask(root, args) {
    const masks = volumes(args).filter(mount => mount.target === path.join(root, '.data'));
    assert.equal(masks.length, 1);
    return masks[0].source;
}

test('a nested bind under the Box .data mask does not poison the next launch', (t) => {
    const { root, shared } = workspace(t);
    const livekit = guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent');
    emulateEngine(livekit);
    assert.deepEqual(fs.readdirSync(shared), []);
    // The next launches, as bizanso on QA, are admitted.
    for (const agent of ['bizanso', 'scriptahubAgent']) {
        const args = guard(root, isolatedStoreLaunch(root, agent), agent);
        emulateEngine(args);
    }
    assert.deepEqual(fs.readdirSync(shared), []);
});

test('the shared .data source is never mounted with a bind nested below it', (t) => {
    const { root, shared } = workspace(t);
    const args = guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent');
    const mask = path.join(root, '.data');
    const source = dataMask(root, args);
    assert.notEqual(source, shared);
    assert.ok(volumes(args).some(mount => mount.target.startsWith(`${mask}/`)));
    assert.deepEqual(guardSourceEntries(source, { maxDepth: Infinity, maxEntries: Infinity }),
        ['agents/', 'agents/liveKitServerAgent/', 'agents/liveKitServerAgent/node_modules/']);
    for (const directory of ['', 'agents', 'agents/liveKitServerAgent', 'agents/liveKitServerAgent/node_modules']) {
        assert.equal(fs.statSync(path.join(source, directory)).mode & 0o777, 0o555, directory);
    }
});

test('the nested-mount view holds no data of other agents', (t) => {
    const { root } = workspace(t);
    fs.mkdirSync(path.join(root, '.data', 'agents', 'other'), { recursive: true });
    fs.writeFileSync(path.join(root, '.data', 'agents', 'other', 'secret'), 'x');
    fs.mkdirSync(path.join(root, '.data', 'dpu-data'), { recursive: true });
    fs.writeFileSync(path.join(root, '.data', 'dpu-data', 'master-key'), 'x');
    const args = guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent');
    const listing = guardSourceEntries(dataMask(root, args), { maxDepth: Infinity, maxEntries: Infinity });
    assert.equal(listing.some(entry => entry.includes('other') || entry.includes('dpu-data')), false);
});

test('a launch with no nested bind keeps the shared source and builds no view', (t) => {
    const { root, shared } = workspace(t);
    const args = guard(root, isolatedStoreLaunch(root, 'emailAgent'), 'emailAgent');
    assert.equal(dataMask(root, args), shared);
    assert.equal(fs.existsSync(path.join(path.dirname(shared), 'mask-views')), false);
});

test('identical launches reuse one view and a nested file bind gets a read-only file', (t) => {
    const { root } = workspace(t);
    const first = dataMask(root, guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent'));
    const second = dataMask(root, guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent'));
    assert.equal(first, second);

    const launch = isolatedStoreLaunch(root, 'conf');
    const file = path.join(launch.home, 'settings.json');
    fs.writeFileSync(file, '{}');
    launch.args.push('-v', `${file}:${file}:z,ro`);
    const view = dataMask(root, guard(root, launch, 'conf'));
    assert.deepEqual(guardSourceEntries(view, { maxDepth: Infinity, maxEntries: Infinity }),
        ['agents/', 'agents/conf/', 'agents/conf/settings.json']);
    assert.equal(fs.statSync(path.join(view, 'agents', 'conf', 'settings.json')).mode & 0o777, 0o444);
});

test('a view with an unexpected entry is refused', (t) => {
    const { root } = workspace(t);
    const view = dataMask(root, guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent'));
    fs.chmodSync(view, 0o755);
    fs.writeFileSync(path.join(view, 'planted'), 'x');
    fs.chmodSync(view, 0o555);
    assert.throws(
        () => guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent'),
        error => error?.code === AGENT_DATA_POLICY_CODE && /holds unexpected entries/.test(error.message),
    );
});

test('a nested bind with a missing source is refused', (t) => {
    const { root } = workspace(t);
    const launch = isolatedStoreLaunch(root, 'gone');
    const missing = path.join(launch.home, 'missing');
    launch.args.push('-v', `${missing}:${missing}:z,ro`);
    assert.throws(() => guard(root, launch, 'gone'), /missing/);
});

test('a launch that loses the publication race reuses the identical view', (t) => {
    const { root } = workspace(t);
    // Force the race: just before this launch renames its build, a competitor publishes the identical view.
    const original = fs.renameSync;
    let raced = 0;
    fs.renameSync = (from, to) => {
        if (String(to).includes(`${path.sep}mask-views${path.sep}`) && !fs.existsSync(to)) {
            const mountpoint = path.join(to, 'agents', 'liveKitServerAgent', 'node_modules');
            fs.mkdirSync(mountpoint, { recursive: true });
            for (const directory of [mountpoint, path.dirname(mountpoint), path.join(to, 'agents'), to]) fs.chmodSync(directory, 0o555);
            raced += 1;
        }
        return original(from, to);
    };
    let view;
    try {
        view = dataMask(root, guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent'));
    } finally {
        fs.renameSync = original;
    }
    assert.equal(raced, 1);
    assert.deepEqual(guardSourceEntries(view, { maxDepth: Infinity, maxEntries: Infinity }),
        ['agents/', 'agents/liveKitServerAgent/', 'agents/liveKitServerAgent/node_modules/']);
    assert.equal(fs.readdirSync(path.dirname(view)).some(name => name.startsWith('.build-')), false);
});

test('a launch that loses the race to a different tree is refused', (t) => {
    const { root } = workspace(t);
    const original = fs.renameSync;
    fs.renameSync = (from, to) => {
        if (String(to).includes(`${path.sep}mask-views${path.sep}`) && !fs.existsSync(to)) {
            fs.mkdirSync(path.join(to, 'planted'), { recursive: true });
        }
        return original(from, to);
    };
    try {
        assert.throws(
            () => guard(root, isolatedNoCacheLaunch(root, 'liveKitServerAgent'), 'liveKitServerAgent'),
            error => error?.code === AGENT_DATA_POLICY_CODE && /holds unexpected entries/.test(error.message),
        );
    } finally {
        fs.renameSync = original;
    }
});

test('concurrent launches publish one exact view and leave no build directories', async (t) => {
    const { root, shared } = workspace(t);
    const moduleUrl = new URL('../../cli/sandbox/docker/agentServiceManager.js', import.meta.url).href;
    const stagedUrl = moduleUrl;
    const script = `
        const fs = await import('node:fs');
        const path = await import('node:path');
        const { appendControllerStateGuards, buildPodmanStagedTargetMounts, podmanMountSuffix } = await import(${JSON.stringify(stagedUrl)});
        const [root, agent] = process.argv.slice(1);
        const home = path.join(root, '.data', 'agents', agent);
        const nodeModules = path.join(home, 'node_modules');
        const code = path.join(root, '.ploinky', 'repos', 'webmeet', agent);
        fs.mkdirSync(nodeModules, { recursive: true });
        fs.mkdirSync(code, { recursive: true });
        const args = ['-v', home + ':/root:z', '-v', code + ':/code:z,ro'];
        for (const mount of buildPodmanStagedTargetMounts({ agentCodePath: code, nodeModulesDir: nodeModules, codeReadOnly: true })) {
            args.push('-v', mount.source + ':' + mount.target + podmanMountSuffix(mount.ro));
        }
        appendControllerStateGuards(args, 'podman', { workspaceRoot: root, canonicalRuntimeWorkspaceGuards: true, agentName: agent, agentDataDir: home });
    `;
    const run = agent => new Promise((resolve) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, agent], {
            env: { ...process.env, PLOINKY_WORKSPACE_ROOT: root }, stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('close', code => resolve({ code, stderr }));
    });
    const results = await Promise.all([
        ...Array.from({ length: 6 }, () => run('liveKitServerAgent')),
        ...Array.from({ length: 4 }, (_, index) => run(`agent${index}`)),
    ]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const viewsRoot = path.join(path.dirname(shared), 'mask-views');
    const views = fs.readdirSync(viewsRoot);
    assert.equal(views.some(name => name.startsWith('.build-')), false);
    assert.equal(views.length, 5);
    assert.deepEqual(fs.readdirSync(shared), []);
});
