import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_IMAGE_REFERENCE, BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    captureConfiguredCoreStartArgv,
    checkBoxHealth,
    createBoxSupervisor,
    formatBoxStatus,
    runBoundedCoreStart,
} from '../../ploinky-box/supervisor.mjs';
import {
    agentLibFixture,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';

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
    const agentLib = agentLibFixture(identity.workspaceRoot);
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: {
                id,
                labels: {
                    ...agentLibFixtureLabels(agentLib),
                    [BOX_LABELS.imageRef]: BOX_IMAGE_REFERENCE,
                },
                runtime: {
                    running,
                    imageId: 'b'.repeat(64),
                    mounts: agentLibFixtureMounts(agentLib),
                },
            },
        },
    };
}

function seedBoxCache(identity) {
    fs.mkdirSync(identity.dataPaths.dependencies, { recursive: true });
    fs.mkdirSync(identity.dataPaths.images, { recursive: true });
    fs.writeFileSync(path.join(identity.dataPaths.images, 'layer'), 'image data');
    fs.writeFileSync(path.join(identity.anchorPath, 'master-key'), 'secret');
    return identity.dataPaths;
}

function boxCacheExists(identity) {
    return Object.values(identity.dataPaths).some((target) => fs.existsSync(target));
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
    assert.match(ordered[2], /^container rm -f [a-f0-9]{64}$/);
    assert.equal(events.some((value) => value.includes('volume')), false);
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
    seedBoxCache(identity);
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
    });

    await assert.rejects(
        () => supervisor.runDestroyTransaction(ownership.handles.container.id, {
            deleteCache: true,
        }),
        /inner stop refused/,
    );
    // The outer Box is stopped so nothing mutates further, but it is retained.
    assert.equal(events.some((value) => value.startsWith('container stop')), true);
    assert.equal(events.some((value) => value.includes('container rm')), false);
    assert.equal(events.some((value) => value.includes('volume')), false);
    assert.equal(fs.existsSync(identity.dataPaths.images), true);
    assert.equal(fs.existsSync(identity.dataPaths.dependencies), true);
});

test('a failed outer removal retains the workspace cache data', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    seedBoxCache(identity);
    const events = [];
    const ownership = owned(identity, { running: false });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            run(command, args) {
                events.push(args.join(' '));
                if (args[1] === 'rm') throw new Error('outer removal refused');
            },
        },
    });

    await assert.rejects(
        () => supervisor.runDestroyTransaction(ownership.handles.container.id, {
            deleteCache: true,
        }),
        /outer removal refused/,
    );
    assert.equal(fs.existsSync(identity.dataPaths.images), true);
    assert.equal(fs.existsSync(identity.dataPaths.dependencies), true);
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

test('update pulls a workspace Ploinky checkout under the workspace lock before updating the graph', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const lockManager = fakeLockManager(state.root, events);
    const ownership = owned(identity);
    const selection = agentLibFixture(identity.workspaceRoot);
    const workspacePloinky = Object.freeze({
        found: true,
        updated: true,
        skipped: false,
        repoPath: path.join(identity.workspaceRoot, 'ploinky'),
        pullStrategy: 'rebase-autostash',
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager,
        discover: () => ownership,
        repositoryRoot: state.root,
        stdout: { write() {} },
        stderr: { write() {} },
        runner: {
            run() {
                events.push('dependencies');
            },
        },
        updateWorkspacePloinky(options) {
            options.lock.assertHeld(identity.instance);
            assert.equal(options.identity, identity);
            assert.equal(options.repositoryRoot, state.root);
            events.push('workspace-ploinky');
            return workspacePloinky;
        },
        async updateAgentLib(options) {
            assert.equal(options.workspaceRoot, identity.workspaceRoot);
            events.push('agentlib');
            return { selection, changed: false, previous: null };
        },
        async reconcile(options) {
            options.lock.assertHeld(identity.instance);
            events.push('reconcile');
            return {
                action: 'reused',
                ownership,
                hostPort: 8080,
                mediaHostPort: 7882,
                finalize() { events.push('finalize'); },
            };
        },
        async runCoreCommand(engine, containerId, argv) {
            assert.equal(engine, ownership.engine);
            assert.equal(containerId, ownership.handles.container.id);
            assert.deepEqual(argv, ['update']);
            events.push('core-update');
        },
        async attestAgentLibGraph() {
            events.push('attest');
            return { ok: true };
        },
        revalidateAgentLibSource() {
            events.push('revalidate-agentlib');
        },
        commitAgentLibSelection() {
            events.push('commit-agentlib');
        },
        captureCoreStartArgv() {
            return null;
        },
    });

    const result = await supervisor.runUpdateTransaction(['update']);

    assert.equal(result.workspacePloinky, workspacePloinky);
    assert.equal(lockManager.acquisitions, 1);
    assert.ok(events.indexOf('workspace-ploinky') < events.indexOf('agentlib'));
    assert.ok(events.indexOf('agentlib') < events.indexOf('reconcile'));
    assert.ok(events.indexOf('reconcile') < events.indexOf('core-update'));
    assert.equal(events.at(-1), 'release');
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

test('destroy revalidates the inspected immutable ID and retains cache data by default', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    seedBoxCache(identity);
    const events = [];
    const ownership = owned(identity, { running: false });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
    });
    await assert.rejects(() => supervisor.runDestroyTransaction('b'.repeat(64)), /changed before destroy/);
    assert.equal(events.some((value) => value.includes('container rm')), false);

    const result = await supervisor.runDestroyTransaction(ownership.handles.container.id);
    const removal = events.find((value) => value.includes('container rm'));
    assert.match(removal, /container rm -f [a-f0-9]{64}$/);
    assert.equal(events.some((value) => value.includes('volume')), false);
    assert.equal(result.action, 'destroyed');
    assert.equal(result.deletedCache, false);
    assert.deepEqual(result.deletedPaths, []);
    assert.equal(fs.existsSync(identity.dataPaths.images), true);
    assert.equal(fs.existsSync(identity.dataPaths.dependencies), true);
});

test('explicit cache deletion happens only after the outer container is removed', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    seedBoxCache(identity);
    const events = [];
    const ownership = owned(identity, { running: false });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            run(command, args) {
                events.push(args.join(' '));
                if (args[1] === 'rm') {
                    // Cache data must still be present at removal time.
                    assert.equal(boxCacheExists(identity), true);
                }
            },
        },
    });

    const result = await supervisor.runDestroyTransaction(
        ownership.handles.container.id,
        { deleteCache: true },
    );

    assert.equal(result.action, 'destroyed');
    assert.equal(result.deletedCache, true);
    assert.deepEqual(result.deletedPaths, [
        identity.dataPaths.dependencies,
        identity.dataPaths.images,
    ]);
    assert.equal(boxCacheExists(identity), false);
    assert.equal(fs.existsSync(identity.boxDataRoot), false);
    // Unrelated workspace state is never touched.
    assert.equal(fs.readFileSync(path.join(identity.anchorPath, 'master-key'), 'utf8'), 'secret');
    assert.equal(events.some((value) => value.includes('volume')), false);
});

test('cache deletion works when the outer container is already absent', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    seedBoxCache(identity);
    const events = [];
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ({
            state: 'absent',
            engine: { name: 'podman', identity: 'engine' },
            handles: null,
        }),
        runner: { run(command, args) { events.push(args.join(' ')); } },
    });

    const result = await supervisor.runDestroyTransaction(null, { deleteCache: true });

    assert.equal(result.action, 'deleted-cache');
    assert.equal(result.containerId, null);
    assert.equal(result.deletedCache, true);
    assert.equal(boxCacheExists(identity), false);
    assert.equal(events.some((value) => value.includes('container rm')), false);
    assert.equal(events.some((value) => value.includes('volume')), false);
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
    assert.equal(events.some((value) => /container rm -f [a-f0-9]{64}$/.test(value)), true);
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
                "Owned Box mount /workspace is incompatible; back up any Box-only data, then run 'ploinky stop' and 'ploinky destroy' before retrying",
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

test('start selects the AgentLib source and passes the host address into the bounded runtime', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const events = [];
    let boundedOptions;
    const agentLib = agentLibFixture(identity.workspaceRoot);
    let selectedFor = null;
    let revalidated = null;
    let committed = null;
    const supervisor = createBoxSupervisor({
        env: {},
        resolveIdentity: () => identity,
        selectAgentLib: async ({ workspaceRoot, branchPolicy }) => {
            selectedFor = { workspaceRoot, branchPolicy };
            return { selection: agentLib, mode: 'local' };
        },
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
        attestAgentLibGraph: async (_engine, containerId, selection) => {
            assert.equal(containerId, ownership.handles.container.id);
            assert.equal(selection, agentLib);
            events.push('attest');
            return { deploymentFingerprint: selection.contentFingerprint };
        },
        revalidateAgentLibSource: (selection) => { revalidated = selection; },
        commitAgentLibSelection: (workspaceRoot, selection) => { committed = { workspaceRoot, selection }; },
    });

    await supervisor.runStartTransaction(['start', 'explorer'], {
        branchPolicy: { branch: 'feature-agentlib', fallback: 'fail' },
    });
    assert.equal(boundedOptions.hostReachableIpv4, '192.168.1.12');
    // The source is selected from the resolved workspace before Box
    // reconciliation, and the same selection reaches the in-Box core.
    assert.equal(selectedFor.workspaceRoot, identity.workspaceRoot);
    assert.deepEqual(selectedFor.branchPolicy, { branch: 'feature-agentlib', fallback: 'fail' });
    assert.equal(boundedOptions.agentLib, agentLib);
    // The source is revalidated after the graph is ready, and `active.json` is
    // committed only after that succeeds.
    assert.equal(revalidated, agentLib);
    assert.deepEqual(committed, { workspaceRoot: identity.workspaceRoot, selection: agentLib });
});

test('a source that changes during startup is not committed and is not declared ready', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const agentLib = agentLibFixture(identity.workspaceRoot);
    let committed = false;
    const supervisor = createBoxSupervisor({
        env: {},
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, []),
        discover: () => ownership,
        platform: 'linux',
        runner: { run() {} },
        selectAgentLib: async () => ({ selection: agentLib, mode: 'local' }),
        reconcile: async () => ({ action: 'reused', ownership, hostPort: 8080, mediaHostPort: 7882 }),
        readEdgeDesired: () => null,
        resolveHostReachableIpv4: async () => '',
        startCore: async () => {},
        healthCheck: async () => {},
        attestAgentLibGraph: async () => ({ deploymentFingerprint: agentLib.contentFingerprint }),
        revalidateAgentLibSource: () => {
            const error = new Error('achillesAgentLib source changed during startup');
            error.code = 'PLOINKY_AGENTLIB_SOURCE_CHANGED';
            throw error;
        },
        commitAgentLibSelection: () => { committed = true; },
    });

    await assert.rejects(
        () => supervisor.runStartTransaction(['start', 'explorer']),
        /source changed during startup/,
    );
    assert.equal(committed, false, 'the active selection must not record an unready graph');
});

test('prior graph capture records an exact start command before mutation', (t) => {
    const state = fixture(t);
    const ploinkyDir = path.join(state.workspace, '.ploinky');
    fs.mkdirSync(ploinkyDir);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'AssistOSExplorer/explorer' },
        port: 8080,
        routes: {},
    }));

    const argv = captureConfiguredCoreStartArgv(identity);

    assert.deepEqual(argv, ['start', 'AssistOSExplorer/explorer', '8080']);
    assert.equal(Object.isFrozen(argv), true);
});

test('a failed replacement restores and re-attests the prior Box graph before surfacing the failure', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const priorAgentLib = agentLibFixture(identity.workspaceRoot);
    const candidateAgentLib = agentLibFixture(identity.workspaceRoot, {
        sourceRelativePath: '.ploinky/agentlib/generations/candidate',
    });
    const oldOwnership = owned(identity, { id: 'a'.repeat(64) });
    const candidateOwnership = owned(identity, { id: 'c'.repeat(64) });
    const events = [];
    let coreCalls = 0;
    let committed = false;
    const supervisor = createBoxSupervisor({
        env: {},
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => oldOwnership,
        runner: {
            run(_command, args) { events.push(`run:${args.join(' ')}`); },
        },
        selectAgentLib: async () => ({ selection: candidateAgentLib, mode: 'managed' }),
        captureCoreStartArgv: () => Object.freeze(['start', 'explorer', '8080']),
        reconcile: async () => ({
            action: 'replaced',
            ownership: candidateOwnership,
            hostPort: 8080,
            mediaHostPort: 7882,
            previousAgentLib: priorAgentLib,
            async rollback() {
                events.push('outer-rollback');
                return {
                    action: 'restored',
                    ownership: oldOwnership,
                    containerId: oldOwnership.handles.container.id,
                    hostPort: 8080,
                    mediaHostPort: 7882,
                    agentLib: priorAgentLib,
                };
            },
        }),
        readEdgeDesired: () => null,
        resolveHostReachableIpv4: async () => '192.168.1.12',
        runCoreCommand: async (_engine, containerId, args, _host, _media, _runner, options) => {
            coreCalls += 1;
            events.push(`core:${containerId}:${args.join(' ')}:${options.agentLib.fingerprint}`);
            if (coreCalls === 1) throw new Error('candidate restart failed');
            assert.equal(containerId, oldOwnership.handles.container.id);
            assert.equal(options.agentLib, priorAgentLib);
        },
        healthCheck: async () => { events.push('prior-health'); },
        attestAgentLibGraph: async (_engine, containerId, selection) => {
            events.push(`attest:${containerId}`);
            assert.equal(selection, priorAgentLib);
            return { deploymentFingerprint: selection.fingerprint };
        },
        commitAgentLibSelection: () => { committed = true; },
    });

    await assert.rejects(
        () => supervisor.runRestartTransaction(['restart']),
        /candidate restart failed/,
    );
    assert.equal(committed, false);
    assert.equal(coreCalls, 2, 'the second bounded command restores the prior graph');
    const rollbackIndex = events.indexOf('outer-rollback');
    const priorStartIndex = events.findIndex((event) => (
        event.startsWith(`core:${oldOwnership.handles.container.id}:start explorer 8080:`)
    ));
    assert.ok(rollbackIndex >= 0 && priorStartIndex > rollbackIndex);
    assert.ok(events.indexOf('prior-health') > priorStartIndex);
    assert.ok(events.indexOf(`attest:${oldOwnership.handles.container.id}`) > priorStartIndex);
});

test('bounded start requires the external Router URL and preserves normalized argv', async (t) => {
    const boundedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-bounded-'));
    t.after(() => fs.rmSync(boundedRoot, { recursive: true, force: true }));
    const boundedAgentLib = agentLibFixture(boundedRoot);
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
                options.stdout.write('[start] Router: http://127.0.0.1:19090\n');
                return {
                    ok: true,
                    status: 0,
                    stdout: '[INFO] Debug mode enabled.\n[start] Router: http://127.0.0.1:19090\n',
                    stderr: '',
                };
            },
        },
        {
            stdout: output,
            stderr: output,
            timeoutMs: 1000,
            hostReachableIpv4: '192.168.1.12',
            agentLib: boundedAgentLib,
        },
    );
    assert.equal(status, 0);
    assert.deepEqual(calls[0][1].slice(-4), ['--debug', 'start', 'Agent', '8080']);
    // The in-Box core learns the source only through the reserved environment,
    // which names the stable mount path rather than any host path.
    assert.deepEqual(calls[0][1].slice(0, 22), [
        'container', 'exec',
        '--env', 'PLOINKY_ROUTER_HOST_PORT=19090',
        '--env', 'PLOINKY_MEDIA_HOST_PORT=17891',
        '--env', 'PLOINKY_HOST_REACHABLE_IPV4=192.168.1.12',
        '--env', 'PLOINKY_AGENTLIB_DIR=/opt/ploinky-agentlib',
        '--env', 'PLOINKY_AGENTLIB_MODE=local',
        '--env', `PLOINKY_AGENTLIB_FINGERPRINT=${boundedAgentLib.fingerprint}`,
        '--env', 'PLOINKY_AGENTLIB_COMMIT=',
        '--env', `PLOINKY_AGENTLIB_SOURCE_ID=${boundedAgentLib.sourceIdHash}`,
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
                    stdout: '[start] Router: http://127.0.0.1:8080\n',
                    stderr: '',
                };
            },
        },
        { stdout: { write() {} }, stderr: { write() {} }, agentLib: boundedAgentLib },
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
        { stream: async () => ({ ok: true, status: 0, stdout: '[start] Router: http://127.0.0.1:8080\n', stderr: '' }) },
        { stdout: { write() {} }, stderr: { write() {} }, agentLib: boundedAgentLib },
    ), /public Router URL/);

    // A start without a selected source is a contract error, not a start that
    // lets the in-Box core resolve achillesAgentLib for itself.
    await assert.rejects(() => runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 8080, 7882,
        { stream: async () => { throw new Error('must fail before Podman'); } },
        { stdout: { write() {} }, stderr: { write() {} } },
    ), /requires the selected achillesAgentLib contract/);
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
