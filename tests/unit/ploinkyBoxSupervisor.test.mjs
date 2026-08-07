import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_IMAGE_REFERENCE, BOX_LABELS } from '../../ploinky-box/constants.mjs';
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
                    [BOX_LABELS.imageRef]: BOX_IMAGE_REFERENCE,
                },
                runtime: { running, imageId: 'b'.repeat(64) },
            },
            volumes: {},
        },
    };
}

test('destroying a running Box stops nested agents before the outer Box is removed', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity, { running: true });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
    });

    await supervisor.runDestroyTransaction(ownership.handles.container.id);

    const ordered = events.filter((value) => /ploinky-local|container stop|container rm/.test(value));
    assert.equal(ordered.length, 3);
    assert.match(ordered[0], /ploinky-local stop$/);
    assert.match(ordered[1], /^container stop --time 30/);
    assert.match(ordered[2], /^container rm -f --volumes/);
});

test('destroy revalidates the exact container after stopping it', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const before = owned(identity, { running: true });

    // A replaced container between stop and remove must abort the removal.
    const replacedRoot = path.join(state.root, 'replaced');
    fs.mkdirSync(replacedRoot);
    const replacedEvents = [];
    const replaced = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(replacedRoot, replacedEvents),
        discover: (() => {
            let calls = 0;
            return () => {
                calls += 1;
                return calls === 1 ? before : owned(identity, { id: 'c'.repeat(64) });
            };
        })(),
        runner: { run(command, args) { replacedEvents.push(args.join(' ')); } },
    });
    await assert.rejects(
        () => replaced.runDestroyTransaction(before.handles.container.id),
        /Box changed while stopping; nothing was removed/,
    );
    assert.equal(replacedEvents.some((value) => value.includes('container rm')), false);

    // An incidentally incompatible resource set must NOT block destroy: it is
    // the documented recovery path.
    const recoveryRoot = path.join(state.root, 'recovery');
    fs.mkdirSync(recoveryRoot);
    const recoveryEvents = [];
    const recovery = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(recoveryRoot, recoveryEvents),
        discover: (() => {
            let calls = 0;
            return () => {
                calls += 1;
                return calls === 1
                    ? before
                    : { ...owned(identity, { running: false }), state: 'incompatible' };
            };
        })(),
        runner: { run(command, args) { recoveryEvents.push(args.join(' ')); } },
    });
    await recovery.runDestroyTransaction(before.handles.container.id);
    assert.equal(recoveryEvents.some((value) => value.includes('container rm -f')), true);
});

test('a failed nested stop halts the Box but removes nothing', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity, { running: true });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            run(command, args) {
                events.push(args.join(' '));
                if (args.some((value) => String(value).endsWith('/ploinky-local'))) {
                    throw new Error('inner stop refused');
                }
            },
        },
        destroyNamedVolumes() { throw new Error('volumes must survive a failed inner stop'); },
    });

    await assert.rejects(
        () => supervisor.runDestroyTransaction(ownership.handles.container.id, {
            deleteVolumes: true,
        }),
        /inner stop refused/,
    );
    // The outer Box is stopped so nothing mutates further, but it is retained.
    assert.equal(events.some((value) => value.startsWith('container stop')), true);
    assert.equal(events.some((value) => value.includes('container rm')), false);
    assert.equal(events.some((value) => value.includes('volume rm')), false);
});

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
    const imageOverride = 'registry.example.test/ploinky-box:dev';
    const runner = { run(command, args) { events.push(`run:${args.join(' ')}`); } };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager,
        discover: () => ownership,
        env: { PLOINKY_BOX_IMAGE: imageOverride },
        runner,
        reconcile: async ({ lock, imageRef }) => {
            lock.assertHeld(identity.instance);
            assert.equal(imageRef, imageOverride);
            events.push('reconcile');
            return { action: 'reused', ownership, hostPort: 8080, mediaHostPort: 7882 };
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

test('stop relays to ploinky-local before stopping the outer Box without dependency repair', async (t) => {
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
    const localStop = events.findIndex((value) => (
        value.includes('/opt/ploinky/bin/ploinky-local stop')
    ));
    const outerStop = events.findIndex((value) => value.includes('container stop --time 30'));
    assert.ok(localStop >= 0 && localStop < outerStop);
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

test('destructive volume reset removes the container before the locked owned-volume set', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity);
    ownership.handles.volumes = Object.fromEntries(Object.entries(identity.volumes).map(
        ([key, name]) => [key, { name }],
    ));
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
        destroyNamedVolumes(options) {
            options.lock.assertHeld(identity.instance);
            assert.equal(options.knownHandles, ownership.handles.volumes);
            assert.equal(options.knownLegacyHandles, undefined);
            events.push('delete-named-volumes');
            return Object.freeze(Object.values(identity.volumes));
        },
    });
    const result = await supervisor.runDestroyTransaction(
        ownership.handles.container.id,
        { deleteVolumes: true },
    );
    const containerRemoval = events.findIndex((value) => value.includes('container rm'));
    const volumeRemoval = events.indexOf('delete-named-volumes');
    assert.ok(containerRemoval >= 0 && containerRemoval < volumeRemoval);
    assert.deepEqual(result.deletedVolumes, [
        ...Object.values(identity.volumes),
    ]);
});

test('destructive volume reset works when only the complete retained set remains', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity);
    ownership.handles.container = null;
    ownership.handles.volumes = Object.fromEntries(Object.entries(identity.volumes).map(
        ([key, name]) => [key, { name }],
    ));
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
        destroyNamedVolumes() {
            events.push('delete-named-volumes');
            return Object.freeze(Object.values(identity.volumes));
        },
    });
    const result = await supervisor.runDestroyTransaction(null, { deleteVolumes: true });
    assert.equal(result.action, 'deleted-retained-volumes');
    assert.equal(events.some((value) => value.includes('container rm')), false);
    assert.equal(events.includes('delete-named-volumes'), true);
});

test('destructive volume reset recovers an exactly owned partial cache set', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const dependencies = { name: identity.volumes.dependencies };
    const ownership = {
        state: 'incompatible',
        message: 'podman has only part of the expected Box resource set',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: null,
            volumes: { images: null, dependencies },
        },
    };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
        destroyNamedVolumes(options) {
            options.lock.assertHeld(identity.instance);
            assert.deepEqual(options.knownHandles, ownership.handles.volumes);
            events.push('delete-partial-volume-set');
            return Object.freeze([identity.volumes.dependencies]);
        },
    });

    const result = await supervisor.runDestroyTransaction(null, { deleteVolumes: true });
    assert.deepEqual(result.deletedVolumes, [identity.volumes.dependencies]);
    assert.equal(events.includes('delete-partial-volume-set'), true);
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
        validateContainer: () => ({}),
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
    assert.equal(result.inbox.cloudflarePublication.state, 'unstarted');
    assert.match(formatBoxStatus(result), /Cloudflare mode: local-only/);
});

test('running status allowlists and renders concise Cloudflare publication state', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: () => ownership,
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        validateContainer: () => ({}),
        runner: {
            query() {
                return { ok: true, stdout: JSON.stringify({
                    state: 'initialized',
                    initialized: true,
                    routingConfigured: true,
                    trackedAgents: 1,
                    runningAgents: 1,
                    warnings: [],
                    cloudflarePublication: {
                        mode: 'cloudflare',
                        management: 'connector-only',
                        state: 'error',
                        connectorState: 'stopped',
                        configurationGeneration: `sha256:${'a'.repeat(64)}`,
                        desiredDigest: `sha256:${'b'.repeat(64)}`,
                        hostnames: ['office.example.test'],
                        error: {
                            code: 'CLOUDFLARE_HOST_PROBE_FAILED',
                            operation: 'probe-hostname',
                            retryable: true,
                            message: 'must-not-cross',
                        },
                        secret: 'must-not-cross',
                    },
                }) };
            },
        },
    });
    const result = supervisor.inspectBoxStatus();
    const output = formatBoxStatus(result);
    assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
    assert.match(output, /Cloudflare mode: cloudflare/);
    assert.match(output, /Cloudflare management: connector-only/);
    assert.match(output, /Cloudflare publication: error/);
    assert.match(output, /Cloudflare connector: stopped/);
    assert.match(output, /Cloudflare hosts: 1/);
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
            const error = new Error('image configuration is incompatible; destroy and recreate the Box');
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

test('status validates the complete mount contract before entering the Box', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    let inboxQueried = false;
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: () => ownership,
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        validateContainer(_container, desired) {
            assert.equal(desired.identity.workspaceRoot, state.workspace);
            assert.equal(desired.repositoryRoot, state.root);
            throw new Error(
                "Owned Box mount /workspace is incompatible; back up legacy Box-only workspace data, then run 'ploinky stop' and 'ploinky destroy --delete-volumes' before retrying",
            );
        },
        repositoryRoot: state.root,
        runner: {
            query() {
                inboxQueried = true;
                throw new Error('incompatible status must not enter the Box');
            },
        },
    });

    const status = supervisor.inspectBoxStatus();
    assert.equal(status.state, 'incompatible');
    assert.match(status.detail, /ploinky destroy/);
    assert.equal(inboxQueried, false);
});

test('failed ploinky-local stop still stops the outer Box', async (t) => {
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
                if (args.includes('/opt/ploinky/bin/ploinky-local')) {
                    throw new Error('local stop failed');
                }
            },
        },
    });
    await assert.rejects(
        () => supervisor.runStopTransaction(),
        /Outer Box stopped after ploinky-local stop reported: local stop failed/,
    );
    assert.equal(events.some((value) => value.includes('container stop --time 30')), true);
});

test('start passes the native host address into the bounded in-box runtime', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const events = [];
    let boundedOptions;
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        platform: 'darwin',
        runner: { run(_command, args) { events.push(args.join(' ')); } },
        reconcile: async () => ({
            action: 'reused', ownership, hostPort: 8080, mediaHostPort: 7882,
        }),
        readEdgeDesired: () => null,
        resolveHostReachableIpv4: async ({ platform }) => {
            assert.equal(platform, 'darwin');
            return '192.168.1.12';
        },
        startCore: async (_engine, _containerId, coreArgs, hostPort, mediaHostPort, _runner, options) => {
            assert.deepEqual(coreArgs, ['start', 'explorer']);
            assert.equal(hostPort, 8080);
            assert.equal(mediaHostPort, 7882);
            boundedOptions = options;
        },
        healthCheck: async (hostPort) => assert.equal(hostPort, 8080),
    });

    await supervisor.runStartTransaction(['start', 'explorer']);
    assert.equal(boundedOptions.hostReachableIpv4, '192.168.1.12');
});

test('bounded start requires the external Dashboard URL and preserves normalized argv', async () => {
    const output = { value: '', write(chunk) { this.value += String(chunk); } };
    const calls = [];
    const status = await runBoundedCoreStart(
        { name: 'podman' },
        'a'.repeat(64),
        ['--debug', 'start', 'Agent', '8080'],
        19090,
        17891,
        {
            async stream(command, args, options) {
                calls.push([command, args, options]);
                options.stdout.write('[INFO] Debug mode enabled.\n');
                options.stdout.write('[start] Dashboard: http://127.0.0.1:19090/dashboard\n');
                return {
                    ok: true,
                    status: 0,
                    stdout: '[INFO] Debug mode enabled.\n[start] Dashboard: http://127.0.0.1:19090/dashboard\n',
                    stderr: '',
                };
            },
        },
        {
            stdout: output,
            stderr: output,
            timeoutMs: 1000,
            hostReachableIpv4: '192.168.1.12',
        },
    );
    assert.equal(status, 0);
    assert.deepEqual(calls[0][1].slice(-4), ['--debug', 'start', 'Agent', '8080']);
    assert.deepEqual(calls[0][1].slice(0, 12), [
        'container', 'exec',
        '--env', 'PLOINKY_ROUTER_HOST_PORT=19090',
        '--env', 'PLOINKY_MEDIA_HOST_PORT=17891',
        '--env', 'PLOINKY_HOST_REACHABLE_IPV4=192.168.1.12',
        '--user', 'podman', '--workdir', '/workspace',
    ]);
    assert.equal(calls[0][2].stdout, output);
    assert.equal(calls[0][2].stderr, output);
    assert.equal(output.value.match(/Debug mode enabled/g)?.length, 1);

    const defaultTimeoutCalls = [];
    await runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 8080, 7882,
        {
            async stream(command, args, options) {
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
    assert.equal(
        calls[0][1].includes('PLOINKY_HOST_REACHABLE_IPV4=192.168.1.12'),
        true,
    );

    await assert.rejects(() => runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 8080, 7882,
        { stream: async () => { throw new Error('invalid address must fail before Podman'); } },
        {
            stdout: { write() {} },
            stderr: { write() {} },
            hostReachableIpv4: '192.168.001.12',
        },
    ), /usable canonical literal IPv4 address/);

    await assert.rejects(() => runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 19090, 17891,
        { stream: async () => ({ ok: true, status: 0, stdout: '[start] Dashboard: http://127.0.0.1:8080/dashboard\n', stderr: '' }) },
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

test('public health accepts the exact active admin-auth challenge', async (t) => {
    const http = await import('node:http');
    const server = http.createServer((_request, response) => {
        response.writeHead(302, {
            Location: '/auth/login?returnTo=%2Fhealth&agent=explorer',
        }).end('Authentication required');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    await checkBoxHealth(port);
});

test('public health waits for an inactive edge generation to become ready', async (t) => {
    const http = await import('node:http');
    let requests = 0;
    const server = http.createServer((_request, response) => {
        requests += 1;
        if (requests === 1) {
            response.writeHead(503).end('{"error":"EDGE_GENERATION_INACTIVE"}');
            return;
        }
        response.writeHead(200).end('{"status":"healthy"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    await checkBoxHealth(port, {
        readinessTimeoutMs: 1_000,
        retryDelayMs: 1,
    });

    assert.equal(requests, 2);
});

test('public health waits for a preserved generation to match the selected host port', async (t) => {
    const http = await import('node:http');
    let requests = 0;
    const server = http.createServer((_request, response) => {
        requests += 1;
        if (requests === 1) {
            response.writeHead(503).end('{"error":"EDGE_GENERATION_RUNTIME_MISMATCH"}');
            return;
        }
        response.writeHead(200).end('{"status":"healthy"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    await checkBoxHealth(port, {
        readinessTimeoutMs: 1_000,
        retryDelayMs: 1,
    });

    assert.equal(requests, 2);
});

test('public health waits for an authenticated route-plan generation race', async (t) => {
    const http = await import('node:http');
    let requests = 0;
    const server = http.createServer((_request, response) => {
        requests += 1;
        if (requests === 1) {
            response.writeHead(503).end('{"error":"edge_generation_changed"}');
            return;
        }
        response.writeHead(302, {
            Location: '/auth/login?returnTo=%2Fhealth',
        }).end('Authentication required');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    await checkBoxHealth(port, {
        readinessTimeoutMs: 1_000,
        retryDelayMs: 1,
    });

    assert.equal(requests, 2);
});

test('public health fails immediately for a permanent response', async (t) => {
    const http = await import('node:http');
    let requests = 0;
    const server = http.createServer((_request, response) => {
        requests += 1;
        response.writeHead(401).end('{"error":"unauthorized"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    await assert.rejects(() => checkBoxHealth(port, {
        readinessTimeoutMs: 1_000,
        retryDelayMs: 1,
    }), /unhealthy \(HTTP 401\)/);

    assert.equal(requests, 1);
});

test('public health bounds an inactive edge generation wait', async (t) => {
    const http = await import('node:http');
    const server = http.createServer((_request, response) => {
        response.writeHead(503).end('{"error":"EDGE_GENERATION_INACTIVE"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    await assert.rejects(() => checkBoxHealth(port, {
        readinessTimeoutMs: 0,
        retryDelayMs: 1,
    }), /did not become ready within 0ms/);
});
