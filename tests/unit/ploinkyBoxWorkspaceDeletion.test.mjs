import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS, BOX_ROLES } from '../../ploinky-box/constants.mjs';
import { createGpuGrantStore } from '../../ploinky-box/gpuGrant.mjs';
import { createHardwareGateStore } from '../../ploinky-box/hardwareLimitsGate.mjs';
import { createHostStateGuard } from '../../ploinky-box/hostState/guard.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import {
    assertNoLiveWorkspaceUsers,
    assertNoMountsInside,
    assertWorkspaceDeletionPaths,
    podmanRemovalArgs,
    removeWorkspaceContents,
} from '../../ploinky-box/workspaceDeletion.mjs';
import { agentLibFixture, agentLibFixtureLabels, agentLibFixtureMounts } from '../helpers/agentlibFixture.mjs';
import { PERMISSIVE_HOST_STATE_GUARD } from '../helpers/hostStateFixture.mjs';

const REFUSED = 'PLOINKY_BOX_WORKSPACE_DELETE_REFUSED';
const CONTAINER_ID = 'a'.repeat(64);
const USER_FILE = 'private-client-contract.docx';

function scratch(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-delete-data-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function seedWorkspace(workspace) {
    fs.mkdirSync(path.join(workspace, '.ploinky/data'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.ploinky/box/images'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.ploinky/data/master-key'), 'key');
    fs.writeFileSync(path.join(workspace, '.ploinky/edge-desired.json'), '{"hosts":{}}');
    fs.mkdirSync(path.join(workspace, '.data/app'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.data/app/state'), 'data');
    fs.writeFileSync(path.join(workspace, '.env'), 'A=1\n');
    fs.mkdirSync(path.join(workspace, 'documents'));
    fs.writeFileSync(path.join(workspace, 'documents', USER_FILE), 'text');
    fs.writeFileSync(path.join(workspace, USER_FILE), 'text');
    fs.mkdirSync(path.join(workspace, '.ploinky-box.quarantine-old'));
    for (const [name, mode] of [['locks', 0o700], ['quarantine', 0o700], ['empty', 0o555]]) {
        fs.mkdirSync(path.join(workspace, '.ploinky-box', name), { recursive: true, mode });
    }
    fs.mkdirSync(path.join(workspace, '.ploinky-box/quarantine/old-entry'));
    fs.mkdirSync(path.join(workspace, '.ploinky-box/router-bindings'));
    fs.writeFileSync(path.join(workspace, '.ploinky-box/workspace.json'), '{}');
}

function ownedBox(identity, { running = true } = {}) {
    const agentLib = agentLibFixture(identity.workspaceRoot);
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: {
                id: CONTAINER_ID,
                labels: agentLibFixtureLabels(agentLib),
                runtime: { running, imageId: 'b'.repeat(64), mounts: agentLibFixtureMounts(agentLib, identity.workspaceRoot) },
            },
        },
    };
}

function workspaceFixture(t) {
    const root = scratch(t);
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    seedWorkspace(workspace);
    const home = path.join(root, 'home');
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(home);
    fs.mkdirSync(checkout);
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    // The AgentLib fixture writes into the workspace, so it comes before any snapshot.
    return { root, workspace, home, checkout, identity, ownership: ownedBox(identity) };
}

function assertPaths(state, overrides = {}) {
    return assertWorkspaceDeletionPaths(overrides.identity || state.identity, {
        confirmWorkspace: state.workspace,
        repositoryRoot: state.checkout,
        homeDirectory: state.home,
        platform: 'linux',
        readMountTable: () => '',
        ...overrides,
    });
}

function refusedWith(pattern) {
    return (error) => {
        assert.equal(error.code, REFUSED);
        assert.match(error.message, pattern);
        assert.match(error.message, /Nothing was deleted/);
        return true;
    };
}

function snapshot(root) {
    const entries = [];
    const walk = (directory) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name);
            entries.push(path.relative(root, target));
            if (fs.lstatSync(target).isDirectory()) walk(target);
        }
    };
    walk(root);
    return entries;
}

function assertOnlyMarkersRemain(workspace) {
    assert.deepEqual(fs.readdirSync(workspace).sort(), ['.ploinky', '.ploinky-box']);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky')), []);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky-box')).sort(), ['empty', 'locks', 'quarantine']);
    assert.deepEqual(fs.readdirSync(path.join(workspace, '.ploinky-box/quarantine')), []);
}

test('the paths pass for a marked workspace and for a rerun with only the markers left', (t) => {
    const state = workspaceFixture(t);
    assertPaths(state);
    fs.rmSync(path.join(state.workspace, '.ploinky'), { recursive: true });
    assertPaths(state);
});

test('the confirmation must be exactly the selected workspace', (t) => {
    const state = workspaceFixture(t);
    for (const confirmWorkspace of [undefined, `${state.workspace}/`, state.root, path.join(state.root, 'other')]) {
        assert.throws(() => assertPaths(state, { confirmWorkspace }), refusedWith(/must be exactly this workspace/));
    }
});

test('a directory that was never a Ploinky workspace is refused', (t) => {
    const state = workspaceFixture(t);
    const backups = path.join(state.root, 'backups');
    fs.mkdirSync(backups);
    fs.writeFileSync(path.join(backups, USER_FILE), 'text');
    assert.throws(() => assertPaths(state, {
        identity: buildWorkspaceIdentity(backups, { markerFound: false }),
        confirmWorkspace: backups,
    }), refusedWith(/is not a Ploinky workspace/));
});

test('the home directory and its ancestors are refused, also through a link', (t) => {
    const state = workspaceFixture(t);
    assert.throws(() => assertPaths(state, { homeDirectory: state.workspace }), refusedWith(/home directory/));
    const inside = path.join(state.workspace, 'nested', 'home');
    fs.mkdirSync(inside, { recursive: true });
    assert.throws(() => assertPaths(state, { homeDirectory: inside }), refusedWith(/home directory/));
    const alias = path.join(state.root, 'home-alias');
    fs.symlinkSync(state.workspace, alias);
    assert.throws(() => assertPaths(state, { homeDirectory: alias }), refusedWith(/home directory/));
});

test('a linked workspace or linked durable state is refused', (t) => {
    const state = workspaceFixture(t);
    const linked = path.join(state.root, 'linked-workspace');
    fs.symlinkSync(state.workspace, linked);
    assert.throws(() => assertPaths(state, {
        identity: buildWorkspaceIdentity(linked, { markerFound: true }),
        confirmWorkspace: linked,
    }), refusedWith(/must be a real directory/));

    const elsewhere = path.join(state.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    for (const relative of ['.data', '.ploinky/data', '.ploinky-box', '.ploinky']) {
        const target = path.join(state.workspace, relative);
        const parked = `${target}.parked`;
        fs.renameSync(target, parked);
        fs.symlinkSync(elsewhere, target);
        assert.throws(() => assertPaths(state), refusedWith(/must be a real directory/), relative);
        fs.rmSync(target);
        fs.writeFileSync(target, 'a file');
        assert.throws(() => assertPaths(state), refusedWith(/must be a real directory/), relative);
        fs.rmSync(target);
        fs.renameSync(parked, target);
    }
    assertPaths(state);
});

test('a workspace that overlaps the running checkout is refused in both directions', (t) => {
    const state = workspaceFixture(t);
    const inside = path.join(state.workspace, '.runtime', 'ploinky');
    fs.mkdirSync(inside, { recursive: true });
    assert.throws(() => assertPaths(state, { repositoryRoot: inside }), refusedWith(/lies inside the workspace/));
    assert.throws(() => assertPaths(state, { repositoryRoot: state.workspace }), /is the Ploinky checkout|is.*checkout/);
    assert.throws(() => assertPaths(state, { repositoryRoot: state.root }), /lies inside/);
});

test('a mount strictly inside the workspace is refused and the workspace itself may be one', (t) => {
    const state = workspaceFixture(t);
    const line = (mountPoint) => `36 35 98:0 / ${mountPoint} rw,noatime - ext3 /dev/root rw`;
    assert.doesNotThrow(() => assertNoMountsInside(state.workspace, `${line('/')}\n${line(state.workspace)}\n${line(state.root)}`));
    assert.throws(() => assertPaths(state, {
        readMountTable: () => line(path.join(state.workspace, 'documents')),
    }), refusedWith(/mounted inside/));
    assert.throws(() => assertNoMountsInside(state.workspace, line(`${state.workspace}/with\\040space`)), refusedWith(/mounted inside/));
    assert.doesNotThrow(() => assertNoMountsInside(state.workspace, line(`${state.workspace}-sibling/x`)));
});

test('without a mount table a different device anywhere in the tree is refused, naming no entry', (t) => {
    const state = workspaceFixture(t);
    assert.doesNotThrow(() => assertPaths(state, { platform: 'darwin' }));
    const share = path.join(state.workspace, 'documents', 'share');
    fs.mkdirSync(share);
    const withDevice = (changed) => ({
        ...fs,
        lstatSync(target, ...rest) {
            const stat = fs.lstatSync(target, ...rest);
            if (target !== changed) return stat;
            return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 });
        },
    });
    assert.throws(() => assertPaths(state, { platform: 'darwin', fsApi: withDevice(share) }), (error) => {
        refusedWith(/mounted inside/)(error);
        assert.equal(error.message.includes('share'), false);
        return true;
    });
    const unreadable = {
        ...fs,
        readdirSync(target, ...rest) {
            if (target === share) throw Object.assign(new Error(`EACCES: ${target}`), { code: 'EACCES' });
            return fs.readdirSync(target, ...rest);
        },
    };
    assert.throws(() => assertPaths(state, { platform: 'darwin', fsApi: unreadable }), (error) => {
        refusedWith(/Unable to read all of/)(error);
        assert.equal(error.message.includes('share'), false);
        return true;
    });
});

test('a linked .env is refused because its keys would outlive the command', (t) => {
    const state = workspaceFixture(t);
    assertPaths(state);
    const keys = path.join(state.root, 'keys.env');
    fs.writeFileSync(keys, 'A=1\n');
    fs.rmSync(path.join(state.workspace, '.env'));
    fs.symlinkSync(keys, path.join(state.workspace, '.env'));
    assert.throws(() => assertPaths(state), refusedWith(/must not be a link/));
});

function boxContainer(source, overrides = {}) {
    return {
        id: 'b'.repeat(64),
        name: 'other-box',
        running: true,
        labels: { [BOX_LABELS.role]: BOX_ROLES.container },
        mounts: [{ type: 'bind', rw: true, source, destination: source }],
        ...overrides,
    };
}

test('another Box workspace inside or around this one is refused', (t) => {
    const state = workspaceFixture(t);
    const inner = path.join(state.workspace, 'documents');
    assert.throws(
        () => assertNoLiveWorkspaceUsers(state.identity, [boxContainer(inner)], { platform: 'darwin' }),
        (error) => error.code === 'PLOINKY_BOX_NESTED_WORKSPACE',
    );
    assert.throws(
        () => assertNoLiveWorkspaceUsers(state.identity, [boxContainer(state.root)], { platform: 'darwin' }),
        (error) => error.code === 'PLOINKY_BOX_NESTED_WORKSPACE',
    );
});

test('a running container with a mount inside the workspace is refused unless it is the excluded Box', (t) => {
    const state = workspaceFixture(t);
    const user = {
        id: 'c'.repeat(64),
        name: 'other-container',
        running: true,
        labels: {},
        mounts: [{ type: 'bind', rw: false, source: path.join(state.workspace, 'documents'), destination: '/in' }],
    };
    assert.throws(
        () => assertNoLiveWorkspaceUsers(state.identity, [user], { platform: 'darwin' }),
        refusedWith(/running container other-container has a mount inside/),
    );
    assert.doesNotThrow(() => assertNoLiveWorkspaceUsers(state.identity, [user], {
        platform: 'darwin', excludeContainerIds: [user.id],
    }));
    assert.doesNotThrow(() => assertNoLiveWorkspaceUsers(state.identity, [{ ...user, running: false }], { platform: 'darwin' }));
    assert.doesNotThrow(() => assertNoLiveWorkspaceUsers(state.identity, [{
        ...user,
        mounts: [{ type: 'bind', rw: true, source: `${state.workspace}-sibling`, destination: '/in' }],
    }], { platform: 'darwin' }));
});

test('the Podman user namespace mount table is checked because removal runs there', (t) => {
    const state = workspaceFixture(t);
    const calls = [];
    const runner = (result) => ({ query(command, args) { calls.push([command, args]); return result; } });
    const engine = { name: 'podman' };
    const clean = { ok: true, stdout: '36 35 98:0 / / rw - ext3 /dev/root rw' };
    assert.doesNotThrow(() => assertNoLiveWorkspaceUsers(state.identity, [], { engine, platform: 'linux', runner: runner(clean) }));
    assert.deepEqual(calls[0], ['podman', ['unshare', 'cat', '/proc/self/mountinfo']]);
    const dirty = { ok: true, stdout: `36 35 98:0 / ${state.workspace}/x rw - ext3 /dev/root rw` };
    assert.throws(
        () => assertNoLiveWorkspaceUsers(state.identity, [], { engine, platform: 'linux', runner: runner(dirty) }),
        refusedWith(/mounted inside/),
    );
    assert.throws(
        () => assertNoLiveWorkspaceUsers(state.identity, [], { engine, platform: 'linux', runner: runner({ ok: false, stdout: '' }) }),
        refusedWith(/Unable to read the mount table/),
    );
    calls.length = 0;
    assert.doesNotThrow(() => assertNoLiveWorkspaceUsers(state.identity, [], { engine, platform: 'darwin', runner: runner(clean) }));
    assert.deepEqual(calls, []);
});

const heldLock = (identity) => ({ assertHeld(instance) { assert.equal(instance, identity.instance); } });

test('Node removal empties the workspace and keeps only the markers', (t) => {
    const state = workspaceFixture(t);
    const result = removeWorkspaceContents(state.identity, { lock: heldLock(state.identity), platform: 'darwin' });
    assertOnlyMarkersRemain(state.workspace);
    assert.equal(result.removedEntries > 0, true);
    assert.equal(removeWorkspaceContents(state.identity, { lock: heldLock(state.identity), platform: 'darwin' }).removedEntries, 0);
});

test('a link in the workspace is unlinked and its target survives', (t) => {
    const state = workspaceFixture(t);
    const outside = path.join(state.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'keep');
    fs.symlinkSync(outside, path.join(state.workspace, 'linked-folder'));
    removeWorkspaceContents(state.identity, { lock: heldLock(state.identity), platform: 'darwin' });
    assertOnlyMarkersRemain(state.workspace);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'keep');
});

function fakeRemovalRunner(remove = () => true) {
    const calls = [];
    return {
        calls,
        query(command, args, options) {
            calls.push({ command, args, options });
            const root = args[2];
            const keep = args.flatMap((value, index) => (value === '-name' ? [args[index + 1]] : []));
            for (const name of fs.readdirSync(root)) {
                if (!keep.includes(name) && remove(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
            }
            return { ok: true, status: 0, stdout: '', stderr: '' };
        },
    };
}

test('Linux with Podman removes each group in order through podman unshare', (t) => {
    const state = workspaceFixture(t);
    const runner = fakeRemovalRunner();
    removeWorkspaceContents(state.identity, {
        lock: heldLock(state.identity), engine: { name: 'podman' }, platform: 'linux', runner,
    });
    assertOnlyMarkersRemain(state.workspace);
    assert.deepEqual(runner.calls.map((call) => call.args), [
        ['unshare', 'find', state.workspace, '-mindepth', '1', '-maxdepth', '1',
            '!', '-name', '.ploinky', '!', '-name', '.ploinky-box',
            '-exec', 'rm', '-rf', '--one-file-system', '--', '{}', '+'],
        ['unshare', 'find', path.join(state.workspace, '.ploinky-box'), '-mindepth', '1', '-maxdepth', '1',
            '!', '-name', 'locks', '!', '-name', 'quarantine', '!', '-name', 'empty',
            '-exec', 'rm', '-rf', '--one-file-system', '--', '{}', '+'],
        podmanRemovalArgs({ root: path.join(state.workspace, '.ploinky-box/quarantine'), keep: [] }),
        podmanRemovalArgs({ root: path.join(state.workspace, '.ploinky'), keep: [] }),
    ]);
    for (const call of runner.calls) {
        assert.equal(call.command, 'podman');
        assert.equal(call.options.timeoutMs > 60_000, true);
    }
});

test('a failed removal reports counts only and leaves the identity for the rerun', (t) => {
    const state = workspaceFixture(t);
    const stubborn = fakeRemovalRunner((name) => name !== USER_FILE);
    assert.throws(() => removeWorkspaceContents(state.identity, {
        lock: heldLock(state.identity), engine: { name: 'podman' }, platform: 'linux', runner: stubborn,
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_WORKSPACE_DELETE_INCOMPLETE');
        assert.match(error.message, /1 workspace entries could not be deleted/);
        assert.equal(error.message.includes(USER_FILE), false);
        assert.equal(error.message.includes(state.workspace), false);
        return true;
    });
    assert.equal(fs.readFileSync(path.join(state.workspace, '.ploinky/data/master-key'), 'utf8'), 'key');
    assert.equal(stubborn.calls.some((call) => call.args[2] === path.join(state.workspace, '.ploinky')), false);

    removeWorkspaceContents(state.identity, {
        lock: heldLock(state.identity), engine: { name: 'podman' }, platform: 'linux', runner: fakeRemovalRunner(),
    });
    assertOnlyMarkersRemain(state.workspace);
});

test('a Node removal failure does not leak the file name', (t) => {
    const state = workspaceFixture(t);
    const fsApi = {
        ...fs,
        rmSync(target, options) {
            if (path.basename(target) === USER_FILE) throw new Error(`EACCES: ${target}`);
            return fs.rmSync(target, options);
        },
    };
    assert.throws(() => removeWorkspaceContents(state.identity, {
        lock: heldLock(state.identity), platform: 'darwin', fsApi,
    }), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_WORKSPACE_DELETE_INCOMPLETE');
        assert.equal(error.message.includes(USER_FILE), false);
        return true;
    });
});

test('removal needs the lock', (t) => {
    const state = workspaceFixture(t);
    assert.throws(() => removeWorkspaceContents(state.identity, {
        lock: { assertHeld() { throw new Error('lock lost'); } }, platform: 'darwin',
    }), /lock lost/);
    assert.equal(fs.existsSync(path.join(state.workspace, USER_FILE)), true);
});

function deletionSupervisor(state, {
    ownership = state.ownership,
    identity = state.identity,
    hostStateGuard = PERMISSIVE_HOST_STATE_GUARD,
    run = () => {},
    ...overrides
} = {}) {
    const events = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard,
        gpuGrantStore: createGpuGrantStore(),
        hardwareGateStore: createHardwareGateStore(),
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        repositoryRoot: state.checkout,
        homeDirectory: state.home,
        platform: 'darwin',
        retireDestroyedMarkers: () => {},
        discover: () => ownership,
        runner: {
            run(command, args) {
                events.push(args.join(' '));
                run(command, args);
            },
            query(_command, args) {
                events.push(args.join(' '));
                return { ok: true, status: 0, stdout: '', stderr: '' };
            },
        },
        ...overrides,
    });
    return { supervisor, events };
}

const deleteOptions = (state) => ({ deleteData: true, confirmWorkspace: state.workspace });

test('delete-data stops and removes the Box first, then empties the workspace', async (t) => {
    const state = workspaceFixture(t);
    const { supervisor, events } = deletionSupervisor(state);
    const result = await supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state));
    assertOnlyMarkersRemain(state.workspace);
    assert.equal(result.deletedWorkspace.removedEntries > 0, true);
    const stopIndex = events.findIndex((event) => event.includes('/ploinky-local stop'));
    const removeIndex = events.findIndex((event) => event.startsWith('container rm -f'));
    assert.equal(stopIndex >= 0 && removeIndex > stopIndex, true);
});

test('every refusal under real path checks leaves the Box running and every file in place', async (t) => {
    const state = workspaceFixture(t);
    const before = snapshot(state.workspace);
    for (const [options, pattern] of [
        [{ deleteData: true, confirmWorkspace: state.root }, /must be exactly this workspace/],
        [{ deleteData: true }, /must be exactly this workspace/],
    ]) {
        const { supervisor, events } = deletionSupervisor(state);
        await assert.rejects(supervisor.runDestroyTransaction(CONTAINER_ID, options), refusedWith(pattern));
        assert.deepEqual(events, []);
    }
    for (const overrides of [
        { homeDirectory: state.workspace },
        { repositoryRoot: path.join(state.workspace, 'documents') },
    ]) {
        const { supervisor, events } = deletionSupervisor(state, overrides);
        await assert.rejects(supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)));
        assert.deepEqual(events, []);
    }
    assert.deepEqual(snapshot(state.workspace), before);
});

test('a refused delete-data writes nothing into the directory, not even the lock skeleton', async (t) => {
    const state = workspaceFixture(t);
    const backups = path.join(state.root, 'backups');
    fs.mkdirSync(backups);
    fs.writeFileSync(path.join(backups, USER_FILE), 'text');
    const identity = buildWorkspaceIdentity(backups, { markerFound: false });
    const { supervisor, events } = deletionSupervisor(state, {
        identity,
        ownership: { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null },
    });
    await assert.rejects(
        supervisor.runDestroyTransaction(null, { deleteData: true, confirmWorkspace: backups }),
        refusedWith(/is not a Ploinky workspace/),
    );
    assert.deepEqual(fs.readdirSync(backups), [USER_FILE]);
    assert.deepEqual(events, []);

    const wrong = workspaceFixture(t);
    fs.rmSync(path.join(wrong.workspace, '.ploinky-box'), { recursive: true });
    const { supervisor: mismatched } = deletionSupervisor(wrong);
    await assert.rejects(
        mismatched.runDestroyTransaction(CONTAINER_ID, { deleteData: true, confirmWorkspace: wrong.root }),
        refusedWith(/must be exactly this workspace/),
    );
    assert.equal(fs.existsSync(path.join(wrong.workspace, '.ploinky-box')), false);
});

test('a live user of the workspace refuses before the Box is stopped', async (t) => {
    const state = workspaceFixture(t);
    const before = snapshot(state.workspace);
    const view = [{
        id: 'c'.repeat(64),
        name: 'other-container',
        running: true,
        labels: {},
        mounts: [{ type: 'bind', rw: true, source: path.join(state.workspace, 'documents'), destination: '/in' }],
    }];
    const quiescenceCalls = [];
    const { supervisor, events } = deletionSupervisor(state, {
        hostStateGuard: {
            ...PERMISSIVE_HOST_STATE_GUARD,
            quiescence(context) { quiescenceCalls.push(context.excludeContainerIds); return view; },
        },
    });
    await assert.rejects(
        supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)),
        refusedWith(/running container other-container/),
    );
    assert.deepEqual(quiescenceCalls, [[CONTAINER_ID]]);
    assert.deepEqual(events.filter((event) => /stop|rm -f/.test(event)), []);
    assert.deepEqual(snapshot(state.workspace), before);
});

test('the checks repeat with no exclusion once the Box is gone, and a late user retains the data', async (t) => {
    const state = workspaceFixture(t);
    const before = snapshot(state.workspace);
    const quiescenceCalls = [];
    const { supervisor, events } = deletionSupervisor(state, {
        hostStateGuard: {
            ...PERMISSIVE_HOST_STATE_GUARD,
            quiescence(context) {
                quiescenceCalls.push(context.excludeContainerIds);
                if (context.excludeContainerIds.length === 0) throw new Error('another runtime appeared');
                return [];
            },
        },
    });
    await assert.rejects(supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_WORKSPACE_DELETE_KEPT');
        assert.match(error.message, /Box is gone .*no workspace data was deleted: another runtime appeared/);
        return true;
    });
    assert.deepEqual(quiescenceCalls, [[CONTAINER_ID], [CONTAINER_ID], []]);
    assert.equal(events.some((event) => event.startsWith('container rm -f')), true);
    assert.deepEqual(snapshot(state.workspace), before);
});

test('the path checks repeat under the lock and refuse before the Box is stopped', async (t) => {
    const state = workspaceFixture(t);
    const outside = path.join(state.root, 'outside');
    fs.mkdirSync(outside);
    let observations = 0;
    const { supervisor, events } = deletionSupervisor(state, {
        discover() {
            observations += 1;
            // The pre-lock check has passed; the tree changes before the locked one.
            if (observations === 2) {
                fs.rmSync(path.join(state.workspace, '.data'), { recursive: true });
                fs.symlinkSync(outside, path.join(state.workspace, '.data'));
            }
            return state.ownership;
        },
    });
    await assert.rejects(
        supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)),
        refusedWith(/must be a real directory/),
    );
    assert.equal(observations >= 2, true);
    assert.deepEqual(events.filter((event) => /stop|rm -f/.test(event)), []);
    assert.equal(fs.existsSync(path.join(state.workspace, USER_FILE)), true);
});

test('a path refusal after the Box is gone says what happened and keeps the data', async (t) => {
    const state = workspaceFixture(t);
    const outside = path.join(state.root, 'outside');
    fs.mkdirSync(outside);
    const { supervisor } = deletionSupervisor(state, {
        run(_command, args) {
            if (args[1] !== 'rm') return;
            fs.rmSync(path.join(state.workspace, '.data'), { recursive: true });
            fs.symlinkSync(outside, path.join(state.workspace, '.data'));
        },
    });
    await assert.rejects(supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_WORKSPACE_DELETE_KEPT');
        assert.match(error.message, /Box is gone .*no workspace data was deleted: .*must be a real directory/);
        assert.equal(error.message.includes('Nothing was deleted'), false);
        return true;
    });
    assert.equal(fs.existsSync(path.join(state.workspace, USER_FILE)), true);
});

test('engine and ownership refusals write nothing, not even the lock skeleton', async (t) => {
    const state = workspaceFixture(t);
    fs.rmSync(path.join(state.workspace, '.ploinky-box'), { recursive: true });
    const before = snapshot(state.workspace);
    const user = {
        id: 'c'.repeat(64),
        name: 'other-container',
        running: true,
        labels: {},
        mounts: [{ type: 'bind', rw: true, source: path.join(state.workspace, 'documents'), destination: '/in' }],
    };
    const { supervisor: inUse } = deletionSupervisor(state, {
        hostStateGuard: { ...PERMISSIVE_HOST_STATE_GUARD, quiescence: () => [user] },
    });
    await assert.rejects(inUse.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)), refusedWith(/running container/));
    assert.deepEqual(snapshot(state.workspace), before);

    const { supervisor: nested } = deletionSupervisor(state, {
        hostStateGuard: {
            ...PERMISSIVE_HOST_STATE_GUARD,
            quiescence: () => [boxContainer(path.join(state.workspace, 'documents'))],
        },
    });
    await assert.rejects(
        nested.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)),
        (error) => error.code === 'PLOINKY_BOX_NESTED_WORKSPACE',
    );
    assert.deepEqual(snapshot(state.workspace), before);

    const { supervisor: foreign } = deletionSupervisor(state, {
        ownership: { state: 'foreign', message: 'fixture foreign Box', handles: null },
    });
    await assert.rejects(foreign.runDestroyTransaction(null, deleteOptions(state)), /fixture foreign Box/);
    assert.deepEqual(snapshot(state.workspace), before);
});

test('on Linux with Podman the supervisor checks the namespace mounts and removes through unshare', async (t) => {
    const state = workspaceFixture(t);
    const removal = fakeRemovalRunner();
    const queries = [];
    const { supervisor, events } = deletionSupervisor(state, {
        platform: 'linux',
        readMountTable: () => '',
        runner: {
            run(_command, args) { events.push(args.join(' ')); },
            query(command, args, options) {
                queries.push({ command, args, options });
                if (args[1] === 'cat') return { ok: true, status: 0, stdout: '', stderr: '' };
                if (args[1] === 'find') return removal.query(command, args, options);
                return { ok: true, status: 0, stdout: '', stderr: '' };
            },
        },
    });
    const result = await supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state));
    assert.equal(result.deletedWorkspace.removedEntries > 0, true);
    assertOnlyMarkersRemain(state.workspace);
    assert.equal(events.some((event) => event.startsWith('container rm -f')), true);
    const unshare = queries.filter((query) => query.args[0] === 'unshare');
    assert.deepEqual(unshare.map((query) => query.args[1]), ['cat', 'cat', 'cat', 'find', 'find', 'find', 'find']);
    for (const query of unshare.filter((entry) => entry.args[1] === 'find')) {
        assert.equal(query.command, 'podman');
        assert.equal(query.options.cwd, state.workspace);
    }
    assert.equal(unshare.at(-1).args[2], path.join(state.workspace, '.ploinky'));
});

test('a namespace mount found on Linux refuses before the Box is stopped', async (t) => {
    const state = workspaceFixture(t);
    const before = snapshot(state.workspace);
    const { supervisor, events } = deletionSupervisor(state, {
        platform: 'linux',
        readMountTable: () => '',
        runner: {
            run(_command, args) { events.push(args.join(' ')); },
            query() {
                return { ok: true, status: 0, stdout: `36 35 98:0 / ${state.workspace}/documents rw - ext3 /dev/root rw`, stderr: '' };
            },
        },
    });
    await assert.rejects(
        supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)),
        refusedWith(/mounted inside/),
    );
    assert.deepEqual(events, []);
    assert.deepEqual(snapshot(state.workspace), before);
});

test('a failed nested stop retains the Box and all data', async (t) => {
    const state = workspaceFixture(t);
    const before = snapshot(state.workspace);
    const { supervisor, events } = deletionSupervisor(state, {
        run(_command, args) {
            if (args.some((value) => String(value).endsWith('/ploinky-local'))) throw new Error('inner stop refused');
        },
    });
    await assert.rejects(supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)), /inner stop refused/);
    assert.equal(events.some((event) => event.startsWith('container rm')), false);
    assert.deepEqual(snapshot(state.workspace), before);
});

test('a kept operator record retains all data', async (t) => {
    const state = workspaceFixture(t);
    fs.mkdirSync(state.identity.boxDataRoot, { recursive: true });
    fs.rmSync(state.identity.dataPaths.images, { recursive: true, force: true });
    fs.symlinkSync(state.identity.hostStateRoot, state.identity.dataPaths.images);
    const before = snapshot(state.workspace);
    const { supervisor } = deletionSupervisor(state);
    await assert.rejects(
        supervisor.runDestroyTransaction(CONTAINER_ID, deleteOptions(state)),
        (error) => error.code === 'PLOINKY_BOX_DESTROY_RECORDS_KEPT',
    );
    assert.deepEqual(snapshot(state.workspace), before);
});

test('an unowned Box state deletes nothing', async (t) => {
    const state = workspaceFixture(t);
    const before = snapshot(state.workspace);
    for (const ownership of [
        { state: 'foreign', message: 'fixture foreign Box', handles: null },
        { state: 'unsupported', message: 'fixture no engine', handles: null },
    ]) {
        const { supervisor, events } = deletionSupervisor(state, { ownership });
        await assert.rejects(supervisor.runDestroyTransaction(null, deleteOptions(state)), /fixture/);
        assert.deepEqual(events, []);
    }
    assert.deepEqual(snapshot(state.workspace), before);
});

test('with the real lock and guard a rerun finishes, and the next command adopts the remaining skeleton', async (t) => {
    const state = workspaceFixture(t);
    fs.rmSync(path.join(state.workspace, '.ploinky-box'), { recursive: true });
    fs.rmSync(path.join(state.workspace, '.ploinky-box.quarantine-old'), { recursive: true });
    const absent = { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null };
    const runner = { run() {}, query() { return { ok: true, status: 0, stdout: '', stderr: '' }; } };
    const hostStateGuard = createHostStateGuard({
        runner, platform: 'darwin', repositoryRoot: state.checkout, observeEngine: () => [], stderr: null,
    });
    const { supervisor } = deletionSupervisor(state, { ownership: absent, hostStateGuard, runner });
    const first = await supervisor.runDestroyTransaction(null, deleteOptions(state));
    assert.equal(first.deletedWorkspace.removedEntries > 0, true);
    assert.deepEqual(fs.readdirSync(state.workspace).sort(), ['.ploinky', '.ploinky-box']);
    assert.deepEqual(fs.readdirSync(path.join(state.workspace, '.ploinky')), []);

    const second = await supervisor.runDestroyTransaction(null, deleteOptions(state));
    assert.equal(second.deletedWorkspace.removedEntries, 0);

    const saved = await supervisor.runEdgeSetTransaction(JSON.stringify({ hosts: {} }));
    assert.equal(fs.existsSync(saved.path), true);
    assert.deepEqual(
        fs.readdirSync(path.join(state.workspace, '.ploinky-box', 'locks')).filter((name) => name.endsWith('.lock')),
        [],
    );
});
