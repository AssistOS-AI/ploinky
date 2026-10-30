import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGENT_DATA_POLICY_CODE } from '../../cli/utils/runtime/agentDataPathPolicy.js';
import {
    agentPrivateDataGuardMounts,
    peerAgentDataDenyPaths,
    planAgentPrivateDataGuards,
} from '../../cli/utils/runtime/agentPrivateDataGuards.js';
import { collectRegisteredPeerAgentDataRoots } from '../../cli/utils/runtime/peerAgentDataRoots.js';
import {
    appendAgentPrivateDataGuards,
    appendControllerStateGuards as appendContainerGuards,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { appendControllerStateGuards as appendBwrapGuards } from '../../cli/sandbox/bwrap/bwrapServiceManager.js';
import { buildSeatbeltProfile } from '../../cli/sandbox/seatbelt/seatbeltProfile.js';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';

// A workspace with the private directories of three agents: `robo` and `team`
// own persistent storage, `robo-home` and `team-home` are their homes. All
// names are arbitrary; the guard knows no agent.
function fixture(t, directories = ['robo', 'team', 'robo-home', 'team-home', 'shared']) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-private-data-')));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, '.ploinky', 'data'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.ploinky-box'));
    for (const directory of directories) {
        fs.mkdirSync(path.join(workspace, '.data', directory), { recursive: true });
    }
    return { workspace, data: path.join(workspace, '.data') };
}

// The binds one global-mode agent receives: the whole workspace at its own
// path, its private home and its persistent storage.
function ownerBindings(workspace, { home = 'robo-home', storage = 'robo' } = {}) {
    return [
        { hostPath: workspace, runtimePath: workspace },
        { hostPath: path.join(workspace, '.data', home), runtimePath: '/root' },
        { hostPath: path.join(workspace, '.data', storage), runtimePath: '/var/lib/storage' },
    ];
}

test('every other agent private directory is masked read-only and the owner keeps its own', t => {
    const { workspace, data } = fixture(t);
    const mounts = agentPrivateDataGuardMounts(ownerBindings(workspace), { workspaceRoot: workspace });
    const masks = mounts.filter(mount => !mount.parent);
    assert.deepEqual(masks.map(mask => mask.target), [
        path.join(data, 'team'), path.join(data, 'team-home'),
    ]);
    for (const mask of masks) {
        assert.equal(mask.readOnly, true);
        assert.equal(mask.source, masks[0].source, 'one shared empty source backs every mask');
    }
    const targets = mounts.map(mount => mount.target);
    for (const own of ['robo', 'robo-home', 'shared']) {
        assert.equal(targets.includes(path.join(data, own)), false, `${own} must stay visible to its owner`);
    }
    // The empty source is a physical, empty, read-only directory outside the workspace.
    const stat = fs.lstatSync(masks[0].source);
    assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true);
    assert.deepEqual(fs.readdirSync(masks[0].source), []);
    assert.equal(stat.mode & 0o777, 0o555);
    assert.equal(masks[0].source.startsWith(workspace), false);
    // The writable ancestor of the masks is pinned so a peer cannot rename it away.
    const pins = mounts.filter(mount => mount.parent);
    assert.deepEqual(pins.map(pin => [pin.source, pin.target, pin.readOnly]), [[data, data, false]]);
});

test('the same workspace seen from another agent masks the first agent instead', t => {
    const { workspace, data } = fixture(t);
    const mounts = agentPrivateDataGuardMounts(
        ownerBindings(workspace, { home: 'team-home', storage: 'team' }), { workspaceRoot: workspace },
    );
    assert.deepEqual(mounts.filter(mount => !mount.parent).map(mount => mount.target), [
        path.join(data, 'robo'), path.join(data, 'robo-home'),
    ]);
});

test('an isolated workspace projected at /root is masked at the projected path', t => {
    const { workspace } = fixture(t);
    const plan = planAgentPrivateDataGuards([
        { hostPath: workspace, runtimePath: '/root' },
        { hostPath: path.join(workspace, '.data', 'robo-home'), runtimePath: '/home/agent' },
    ], { workspaceRoot: workspace });
    assert.deepEqual(plan.masks.map(mask => mask.target), [
        '/root/.data/robo', '/root/.data/team', '/root/.data/team-home',
    ].sort());
});

test('a read-only workspace grant is masked too but needs no writable pin', t => {
    const { workspace } = fixture(t);
    const plan = planAgentPrivateDataGuards([
        { hostPath: workspace, runtimePath: '/ws', readOnly: true },
    ], { workspaceRoot: workspace });
    assert.equal(plan.masks.some(mask => mask.target === '/ws/.data/team'), true);
    assert.deepEqual(plan.pins, []);
});

test('a peer directory that does not exist yet is never mounted over, the registry says it exists', t => {
    const { workspace, data } = fixture(t, ['robo', 'shared']);
    const peerRoots = [path.join(data, 'later')];
    const plan = planAgentPrivateDataGuards(ownerBindings(workspace), { workspaceRoot: workspace, peerRoots });
    assert.deepEqual(plan.masks, [], 'an absent peer is not masked: the engine would create a host mountpoint');
    fs.mkdirSync(path.join(data, 'later'));
    const after = planAgentPrivateDataGuards(ownerBindings(workspace), { workspaceRoot: workspace, peerRoots });
    assert.deepEqual(after.masks.map(mask => mask.target), [path.join(data, 'later')]);
});

test('overlap with an own grant is left alone and nested peers collapse into their parent', t => {
    const { workspace, data } = fixture(t, ['robo', 'shared', 'group', 'other']);
    fs.mkdirSync(path.join(data, 'group', 'member'));
    fs.mkdirSync(path.join(data, 'other', 'deep'));
    // Own manifest volume below `.data/group`: the whole of `group` stays visible.
    const plan = planAgentPrivateDataGuards([
        { hostPath: workspace, runtimePath: workspace },
        { hostPath: path.join(data, 'group', 'member'), runtimePath: '/member' },
    ], { workspaceRoot: workspace, peerRoots: [path.join(data, 'other', 'deep')] });
    assert.deepEqual(plan.masks.map(mask => mask.target), [
        path.join(data, 'other'), path.join(data, 'robo'),
    ].sort(), 'only the outermost peer directory is masked');
});

test('an explicit grant at a mask target is not shadowed and is reported as skipped', t => {
    const { workspace, data } = fixture(t);
    const plan = planAgentPrivateDataGuards([
        ...ownerBindings(workspace),
        { hostPath: '/tmp', runtimePath: path.join(data, 'team') },
    ], { workspaceRoot: workspace });
    assert.equal(plan.masks.some(mask => mask.target === path.join(data, 'team')), false);
    assert.equal(plan.skipped.some(entry => entry.target === path.join(data, 'team')), true);
});

test('symlinks and files inside .data are not masked, and a symlinked .data is refused', t => {
    const { workspace, data } = fixture(t, ['robo', 'shared', 'real']);
    fs.symlinkSync('real', path.join(data, 'alias'));
    fs.writeFileSync(path.join(data, 'file'), 'x');
    const plan = planAgentPrivateDataGuards(ownerBindings(workspace), { workspaceRoot: workspace });
    assert.deepEqual(plan.masks.map(mask => mask.target), [path.join(data, 'real')],
        'the link resolves to a masked directory, so it reads empty too');

    const linked = fixture(t, []);
    fs.rmSync(path.join(linked.workspace, '.data'), { recursive: true, force: true });
    fs.mkdirSync(path.join(linked.workspace, 'elsewhere'));
    fs.symlinkSync('elsewhere', path.join(linked.workspace, '.data'));
    assert.throws(() => planAgentPrivateDataGuards(
        [{ hostPath: linked.workspace, runtimePath: linked.workspace }], { workspaceRoot: linked.workspace },
    ), error => error?.code === AGENT_DATA_POLICY_CODE);
});

test('a workspace without .data and a runtime without a workspace grant add nothing', t => {
    const { workspace, data } = fixture(t);
    assert.deepEqual(planAgentPrivateDataGuards([
        { hostPath: path.join(workspace, '.ploinky', 'repos'), runtimePath: '/repos' },
    ], { workspaceRoot: workspace }).masks, []);
    fs.rmSync(data, { recursive: true });
    assert.deepEqual(agentPrivateDataGuardMounts(ownerBindings(workspace).slice(0, 1), { workspaceRoot: workspace }), []);
});

test('docker and podman launches render the masks read-only and never mask the owner', t => {
    const { workspace, data } = fixture(t);
    for (const runtime of ['podman', 'docker']) {
        const rw = runtime === 'podman' ? ':z' : '';
        const ro = runtime === 'podman' ? ':z,ro' : ':ro';
        const args = [
            '-v', `${workspace}:${workspace}${rw}`,
            '-v', `${path.join(data, 'robo-home')}:/root${rw}`,
            '-v', `${path.join(data, 'robo')}:/var/lib/storage${rw}`,
        ];
        appendContainerGuards(args, runtime, { workspaceRoot: workspace, canonicalRuntimeWorkspaceGuards: false });
        const mounts = appendAgentPrivateDataGuards(args, runtime, { workspaceRoot: workspace, peerRoots: [] });
        const rendered = args.filter((_, index) => args[index - 1] === '-v');
        for (const peer of ['team', 'team-home']) {
            const mask = rendered.find(value => value.endsWith(`:${path.join(data, peer)}${ro}`));
            assert.ok(mask, `${runtime}: ${peer} masked in ${rendered.join(' ')}`);
            assert.deepEqual(fs.readdirSync(mask.split(':')[0]), []);
        }
        for (const own of ['robo', 'robo-home', 'shared']) {
            assert.equal(rendered.some(value => value.includes(`:${path.join(data, own)}:`)
                || value.endsWith(`:${path.join(data, own)}`)), false, `${runtime}: ${own} unmasked`);
        }
        assert.ok(rendered.includes(`${data}:${data}${rw}`), `${runtime}: .data is pinned writable`);
        assert.equal(rendered.includes(`${workspace}:${workspace}${rw}`), true, `${runtime}: workspace stays writable`);
        assert.equal(mounts.length, 3);
        // The controller masks planned alongside are untouched.
        assert.ok(rendered.some(value => value.endsWith(`:${path.join(workspace, '.ploinky-box')}${ro}`)));
        // Planning again over the rendered args adds nothing: the targets are taken.
        const rerendered = [...args];
        const quiet = t.mock.method(console, 'warn', () => {});
        assert.deepEqual(appendAgentPrivateDataGuards(rerendered, runtime, { workspaceRoot: workspace, peerRoots: [] }), []);
        assert.deepEqual(rerendered, args);
        quiet.mock.restore();
    }
});

test('a registered peer that has not started gets its directory before it is masked', t => {
    const { workspace, data } = fixture(t, ['robo', 'shared']);
    const registry = {
        _config: { anything: true },
        'ctr-a': { type: 'agent', agentName: 'a', repoName: 'repoA', alias: 'a-alias' },
        'ctr-b': { type: 'agent', agentName: 'b', repoName: 'repoB' },
        'ctr-bad': { type: 'agent', agentName: 'c', repoName: 'repoC' },
    };
    const manifests = {
        'repoA/a': { runtimeResources: { persistentStorage: { key: 'a-storage' } } },
        'repoB/b': { runtimeResources: {} },
        'repoC/c': { runtimeResources: { persistentStorage: { key: '../escape' } } },
    };
    const roots = collectRegisteredPeerAgentDataRoots({
        workspaceRoot: workspace,
        create: false,
        readRegistry: () => registry,
        describe: (repo, agent) => manifests[`${repo}/${agent}`],
    });
    assert.deepEqual(roots, [
        path.join(data, 'a-alias'), path.join(data, 'a-storage'), path.join(data, 'b'), path.join(data, 'c'),
    ], 'homes follow the alias, an unsafe storage key is ignored, _config is not an agent');
    assert.equal(fs.existsSync(path.join(data, 'a-storage')), false, 'read-only collection creates nothing');
    const created = collectRegisteredPeerAgentDataRoots({
        workspaceRoot: workspace,
        create: true,
        readRegistry: () => registry,
        describe: (repo, agent) => manifests[`${repo}/${agent}`],
    });
    assert.deepEqual(created, roots);
    for (const root of created) assert.equal(fs.lstatSync(root).isDirectory(), true);
    const plan = planAgentPrivateDataGuards(ownerBindings(workspace), { workspaceRoot: workspace, peerRoots: created });
    assert.deepEqual(plan.masks.map(mask => path.basename(mask.target)).sort(),
        ['a-alias', 'a-storage', 'b', 'c'], 'robo and robo-home are the owner');
});

test('bwrap launches ro-bind the empty guard over every other agent directory', t => {
    const { workspace, data } = fixture(t);
    const args = [
        '--bind', workspace, workspace,
        '--bind', path.join(data, 'robo-home'), '/root',
        '--bind', path.join(data, 'robo'), '/var/lib/storage',
    ];
    appendBwrapGuards(args, { workspaceRoot: workspace });
    const bound = [];
    for (let index = 0; index < args.length - 2; index += 1) {
        if (args[index] === '--bind' || args[index] === '--ro-bind') {
            bound.push({ mode: args[index], source: args[index + 1], target: args[index + 2] });
        }
    }
    for (const peer of ['team', 'team-home']) {
        const mask = bound.find(entry => entry.target === path.join(data, peer));
        assert.equal(mask?.mode, '--ro-bind');
        assert.deepEqual(fs.readdirSync(mask.source), []);
    }
    for (const own of ['robo', 'robo-home', 'shared']) {
        assert.equal(bound.some(entry => entry.target === path.join(data, own)), false);
    }
    const pin = bound.find(entry => entry.target === data);
    assert.deepEqual([pin?.mode, pin?.source], ['--bind', data]);
    // Shallower mounts come first so the masks land inside the workspace bind.
    assert.ok(bound.findIndex(entry => entry.target === workspace) < bound.findIndex(entry => entry.target === data));
    assert.ok(bound.findIndex(entry => entry.target === data) < bound.findIndex(entry => entry.target === path.join(data, 'team')));
});

test('seatbelt denies reads and writes of peer directories, never the agent own', t => {
    const { workspace, data } = fixture(t);
    const profile = buildSeatbeltProfile({
        agentLibGrant: {
            sourceDir: `${workspace}/achillesAgentLib`, runtimePath: `${workspace}/achillesAgentLib`,
            mode: 'local', fingerprint: 'a1'.repeat(32), commit: '', sourceIdHash: 'b2'.repeat(32), namespaced: false,
        },
        agentCodePath: path.join(workspace, '.ploinky', 'repos', 'r', 'a'),
        agentLibPath: path.join(workspace, 'Agent'),
        nodeModulesDir: path.join(workspace, 'nm'),
        agentWorkDir: path.join(data, 'robo-home'),
        sharedDir: path.join(data, 'shared'),
        cwd: workspace,
        skillsPath: null,
        codeReadOnly: true,
        skillsReadOnly: true,
        volumes: {},
        workspaceRoot: workspace,
        extraWritePaths: [path.join(data, 'robo')],
    });
    const section = profile.slice(profile.indexOf('; Peer agents'));
    const denied = section.slice(0, section.indexOf('\n)\n') + 2);
    assert.match(denied, /\(deny file-read\* file-write\*/);
    for (const peer of ['team', 'team-home']) assert.ok(denied.includes(`(subpath "${path.join(data, peer)}")`), peer);
    for (const own of ['robo', 'robo-home', 'shared']) {
        assert.equal(denied.includes(`(subpath "${path.join(data, own)}")`), false, own);
    }
    assert.ok(section.includes(`(literal "${data}")`), '.data itself cannot be renamed away');
    assert.deepEqual(peerAgentDataDenyPaths([path.join(data, 'robo-home')], { workspaceRoot: workspace }),
        [path.join(data, 'robo'), path.join(data, 'team'), path.join(data, 'team-home')]);
});

test('the launch reads the real registry and masks the home of a peer that has not started', t => {
    const { workspace, data } = fixture(t, ['robo-home', 'shared']);
    fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), JSON.stringify({
        'ctr-robo': { type: 'agent', agentName: 'robo', repoName: 'repo' },
        'ctr-peer': { type: 'agent', agentName: 'peer', repoName: 'repo', alias: 'peer-alias' },
        _config: {},
    }), { mode: 0o600 });
    assert.equal(fs.existsSync(path.join(data, 'peer-alias')), false);
    const args = [
        '-v', `${workspace}:${workspace}:z`,
        '-v', `${path.join(data, 'robo-home')}:/root:z`,
    ];
    appendAgentPrivateDataGuards(args, 'podman', { workspaceRoot: workspace });
    assert.equal(fs.lstatSync(path.join(data, 'peer-alias')).isDirectory(), true, 'created for the mask');
    assert.ok(args.some(value => value.endsWith(`:${path.join(data, 'peer-alias')}:z,ro`)), args.join(' '));
    // A read-only adoption plans the same masks from what exists and creates nothing.
    fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), JSON.stringify({
        'ctr-late': { type: 'agent', agentName: 'late', repoName: 'repo' },
    }), { mode: 0o600 });
    const adoptArgs = [...args.slice(0, 4)];
    appendAgentPrivateDataGuards(adoptArgs, 'podman', { workspaceRoot: workspace, adoptOnly: true });
    assert.equal(fs.existsSync(path.join(data, 'late')), false);
    assert.ok(adoptArgs.some(value => value.endsWith(`:${path.join(data, 'peer-alias')}:z,ro`)));
});

test('a peer path that is a file or a link is reported as unmaskable and never fails a launch', t => {
    const { workspace, data } = fixture(t, ['robo', 'robo-home', 'shared', 'good-peer']);
    fs.writeFileSync(path.join(data, 'file-peer'), 'not a directory');
    fs.symlinkSync('good-peer', path.join(data, 'link-peer'));
    const registry = {
        'ctr-1': { type: 'agent', agentName: 'file-peer', repoName: 'r' },
        'ctr-2': { type: 'agent', agentName: 'link-peer', repoName: 'r' },
        'ctr-3': { type: 'agent', agentName: 'good-peer', repoName: 'r' },
    };
    const roots = collectRegisteredPeerAgentDataRoots({
        workspaceRoot: workspace, create: true, readRegistry: () => registry, describe: () => null,
    });
    assert.deepEqual(roots.map(root => path.basename(root)), ['file-peer', 'good-peer', 'link-peer']);
    assert.equal(fs.readFileSync(path.join(data, 'file-peer'), 'utf8'), 'not a directory', 'the file is untouched');
    assert.equal(fs.lstatSync(path.join(data, 'link-peer')).isSymbolicLink(), true, 'the link is not followed');

    const plan = planAgentPrivateDataGuards(ownerBindings(workspace), { workspaceRoot: workspace, peerRoots: roots });
    assert.deepEqual(plan.masks.map(mask => path.basename(mask.target)), ['good-peer']);
    assert.deepEqual(plan.skipped.map(entry => path.basename(entry.peer)).sort(), ['file-peer', 'link-peer']);

    const warnings = [];
    t.mock.method(console, 'warn', (message) => { warnings.push(String(message)); });
    const mounts = agentPrivateDataGuardMounts(ownerBindings(workspace), { workspaceRoot: workspace, peerRoots: roots });
    assert.equal(mounts.filter(mount => !mount.parent).length, 1);
    assert.equal(warnings.length, 1, 'one warning per launch');
    assert.match(warnings[0], /file-peer.*link-peer|link-peer.*file-peer/);
});
