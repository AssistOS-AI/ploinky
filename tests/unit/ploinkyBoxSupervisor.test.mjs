import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    checkBoxHealth,
    createBoxSupervisor,
    formatBoxStatus,
    runBoundedCoreStart,
} from '../../ploinky-box/supervisor.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-supervisor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    return { root, workspace };
}

function fakeLockManager(root, events) {
    let acquisitions = 0;
    return {
        get acquisitions() { return acquisitions; },
        async acquire(instance) {
            acquisitions += 1;
            const lockPath = path.join(root, `lock-${acquisitions}`);
            fs.mkdirSync(lockPath);
            events.push('lock');
            let released = false;
            return {
                path: lockPath,
                assertHeld(expected) {
                    assert.equal(released, false);
                    assert.equal(expected, instance);
                },
                release() {
                    released = true;
                    events.push('release');
                },
            };
        },
    };
}

function owned(identity, { running = true, id = 'a'.repeat(64) } = {}) {
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: {
                id,
                labels: {
                    [BOX_LABELS.imageRef]: 'docker.io/assistos/ploinky-box:runtime',
                },
                runtime: { running, imageId: 'b'.repeat(64) },
            },
            volumes: {},
        },
    };
}

test('unsupported discovery happens before markerless anchor materialization', async (t) => {
    const state = fixture(t);
    const events = [];
    const lockManager = fakeLockManager(state.root, events);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => resolveWorkspaceIdentity({ env: {}, cwd: () => state.workspace }),
        lockManager,
        discover: () => ({ state: 'unsupported', message: 'native Linux required' }),
        runner: { run() { throw new Error('must not mutate'); } },
    });
    await assert.rejects(() => supervisor.prepareBoxForCommand(), /native Linux required/);
    assert.equal(fs.existsSync(path.join(state.workspace, '.ploinky')), false);
    assert.deepEqual(events, ['lock', 'release']);
});

test('prepare acquires once, reconciles under lock, validates dependencies, then releases', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const lockManager = fakeLockManager(state.root, events);
    const ownership = owned(identity);
    const runner = { run(command, args) { events.push(`run:${args.join(' ')}`); } };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager,
        discover: () => ownership,
        runner,
        reconcile: async ({ lock }) => {
            lock.assertHeld(identity.instance);
            events.push('reconcile');
            return { action: 'reused', ownership, hostPort: 8080 };
        },
    });
    const result = await supervisor.prepareBoxForCommand();
    assert.equal(result.containerId, ownership.handles.container.id);
    assert.equal(lockManager.acquisitions, 1);
    assert.deepEqual(events, [
        'lock',
        'reconcile',
        `run:container exec --user podman --workdir /workspace ${ownership.handles.container.id} /opt/ploinky/bin/ploinky-install-deps`,
        'release',
    ]);
});

test('stop uses the dependency-free helper and outer stop without dependency repair', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
    });
    await supervisor.runStopTransaction();
    assert.equal(events.some((value) => value.includes('ploinky-install-deps')), false);
    assert.equal(events.some((value) => value.includes('ploinky-local')), false);
    assert.equal(events.some((value) => value.includes('/opt/ploinky/ploinky-box/inbox/stopCore.mjs')), true);
    assert.equal(events.some((value) => value.includes('container stop --time 30')), true);
});

test('destroy revalidates the confirmed immutable ID and retains named volumes', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
    });
    await assert.rejects(() => supervisor.runDestroyTransaction('b'.repeat(64)), /changed after destroy confirmation/);
    assert.equal(events.some((value) => value.includes('container rm')), false);

    await supervisor.runDestroyTransaction(ownership.handles.container.id);
    const removal = events.find((value) => value.includes('container rm'));
    assert.match(removal, /container rm -f --volumes/);
    assert.equal(events.some((value) => value.includes('volume rm')), false);
});

test('status and dry-run inspect without acquiring a lock or creating an anchor', (t) => {
    const state = fixture(t);
    const identity = resolveWorkspaceIdentity({ env: {}, cwd: () => state.workspace });
    const events = [];
    const lockManager = fakeLockManager(state.root, events);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager,
        discover: () => ({ state: 'absent' }),
    });
    assert.equal(supervisor.inspectBoxStatus().ownership.state, 'absent');
    assert.equal(supervisor.planDryRun().mutationPerformed, false);
    assert.equal(lockManager.acquisitions, 0);
    assert.equal(fs.existsSync(path.join(state.workspace, '.ploinky')), false);
});

test('running status uses immutable-ID inbox inspection and allowlists its output', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const calls = [];
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: () => ownership,
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        runner: {
            query(command, args) {
                calls.push([command, ...args]);
                return { ok: true, stdout: JSON.stringify({
                    state: 'initialized', initialized: true, routingConfigured: true,
                    trackedAgents: 2, runningAgents: 1,
                    warnings: [], secret: 'must-not-cross',
                }) };
            },
        },
    });
    const result = supervisor.inspectBoxStatus();
    assert.equal(result.state, 'running-initialized');
    assert.equal(calls[0].includes(ownership.handles.container.id), true);
    assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
    assert.equal(formatBoxStatus(result).includes('must-not-cross'), false);
});

test('status reports an older owned image as incompatible while destroy remains available', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity, { running: false });
    const events = [];
    const lockManager = fakeLockManager(state.root, events);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager,
        discover: () => ownership,
        validateExistingImage() {
            const error = new Error('contract 5; destroy and recreate the Box');
            error.code = 'PLOINKY_BOX_IMAGE_CONTRACT_HARD_CUT';
            throw error;
        },
        runner: {
            run(command, args) { events.push(args.join(' ')); },
            query() { throw new Error('status must use only the injected image validator'); },
        },
    });
    const status = supervisor.inspectBoxStatus();
    assert.equal(status.state, 'incompatible');
    assert.match(formatBoxStatus(status), /destroy and recreate the Box/);
    assert.equal(lockManager.acquisitions, 0);

    await supervisor.runDestroyTransaction(ownership.handles.container.id);
    assert.equal(events.some((value) => value.includes('container rm -f --volumes')), true);
});

test('dependency-free stop continues to outer stop when inner identity is unverifiable', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const events = [];
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            run(command, args) {
                events.push(args.join(' '));
                if (args.includes('/opt/ploinky/ploinky-box/inbox/stopCore.mjs')) {
                    throw new Error('inner identity changed');
                }
            },
        },
    });
    await assert.rejects(() => supervisor.runStopTransaction(), /Outer Box stopped/);
    assert.equal(events.some((value) => value.includes('container stop --time 30')), true);
});

test('bounded start requires the external Dashboard URL and preserves normalized argv', async () => {
    const output = { value: '', write(chunk) { this.value += String(chunk); } };
    const calls = [];
    const status = await runBoundedCoreStart(
        { name: 'podman' },
        'a'.repeat(64),
        ['--debug', 'start', 'Agent', '8080'],
        19090,
        {
            query(command, args, options) {
                calls.push([command, args, options]);
                return {
                    ok: true,
                    status: 0,
                    stdout: '[INFO] Debug mode enabled.\n[start] Dashboard: http://127.0.0.1:19090/dashboard\n',
                    stderr: '',
                };
            },
        },
        { stdout: output, stderr: output, timeoutMs: 1000 },
    );
    assert.equal(status, 0);
    assert.deepEqual(calls[0][1].slice(-4), ['--debug', 'start', 'Agent', '8080']);
    assert.equal(output.value.match(/Debug mode enabled/g)?.length, 1);

    const defaultTimeoutCalls = [];
    await runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 8080,
        {
            query(command, args, options) {
                defaultTimeoutCalls.push(options);
                return {
                    ok: true,
                    status: 0,
                    stdout: '[start] Dashboard: http://127.0.0.1:8080/dashboard\n',
                    stderr: '',
                };
            },
        },
        { stdout: { write() {} }, stderr: { write() {} } },
    );
    assert.equal(defaultTimeoutCalls[0].timeoutMs, 1_800_000);

    await assert.rejects(() => runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 19090,
        { query: () => ({ ok: true, status: 0, stdout: '[start] Dashboard: http://127.0.0.1:8080/dashboard\n', stderr: '' }) },
        { stdout: { write() {} }, stderr: { write() {} } },
    ), /public Dashboard URL/);
});

test('public health connects to the published port with matching authority', async (t) => {
    const http = await import('node:http');
    let observedHost = '';
    const server = http.createServer((request, response) => {
        observedHost = request.headers.host;
        response.writeHead(200).end('{"status":"healthy"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    await checkBoxHealth(port);
    assert.equal(observedHost, `127.0.0.1:${port}`);
});
