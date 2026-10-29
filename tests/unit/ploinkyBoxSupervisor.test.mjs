import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_IMAGE_REFERENCE, BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import { hardwareStorePaths, initializeStore, setAgentLimits } from '../../cli/sandbox/hardwareLimits/store.mjs';
import { createGpuGrantStore } from '../../ploinky-box/gpuGrant.mjs';
import { createHardwareGateStore } from '../../ploinky-box/hardwareLimitsGate.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createMutationLockManager } from '../../ploinky-box/locks.mjs';
import { readInboxStatus } from '../../ploinky-box/inbox/readStatus.mjs';
import {
    captureConfiguredCoreStartArgv,
    checkBoxHealth,
    createBoxSupervisor,
    formatBoxStatus,
    runBoundedCoreCommand,
    runBoundedCoreStart,
} from '../../ploinky-box/supervisor.mjs';
import {
    OUTER_IMAGE_ID_FIXTURE,
    agentLibFixture,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
    imageAgentLibFixture,
} from '../helpers/agentlibFixture.mjs';
import { fakeRestartCore, fakeUpdateCore } from '../helpers/fakeUpdateCore.mjs';
import { PERMISSIVE_HOST_STATE_GUARD } from '../helpers/hostStateFixture.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-supervisor-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    // Host operator state lives in the fixture workspace's `.ploinky-box`.
    return { root, workspace, stores: hostStores() };
}

function hostStores() {
    return {
        gpuGrantStore: createGpuGrantStore(),
        hardwareGateStore: createHardwareGateStore(),
    };
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
                    mounts: agentLibFixtureMounts(agentLib, identity.workspaceRoot),
                },
            },
        },
    };
}

function seedBoxCache(identity) {
    fs.mkdirSync(identity.dataPaths.dependencies, { recursive: true });
    fs.mkdirSync(identity.dataPaths.images, { recursive: true });
    fs.writeFileSync(path.join(identity.dataPaths.images, 'layer'), 'image data');
    fs.mkdirSync(path.join(identity.anchorPath, 'data'), { recursive: true });
    fs.writeFileSync(path.join(identity.anchorPath, 'data', 'master-key'), 'secret');
    return identity.dataPaths;
}

function boxCacheExists(identity) {
    return Object.values(identity.dataPaths).some((target) => fs.existsSync(target));
}

for (const [name, invoke] of [
    ['prepare', supervisor => supervisor.prepareBoxForCommand()],
    ['start', supervisor => supervisor.runStartTransaction(['start', 'fixture-agent'])],
    ['restart', supervisor => supervisor.runRestartTransaction(['restart'])],
    ['targeted restart', supervisor => supervisor.runTargetedRestartTransaction(['restart', 'fixture-agent'])],
    ['update', supervisor => supervisor.runUpdateTransaction(['update'])],
    ['bind', supervisor => supervisor.runBindTransaction()],
]) {
    test(`${name} reaches workspace identity without automatic prerequisite probes`, async t => {
        const state = fixture(t);
        const events = [];
        const lockManager = fakeLockManager(state.root, events);
        const runner = { run() { events.push('runtime'); }, query() { events.push('query'); } };
        const env = { PATH: '/fixture/bin' };
        const failure = new Error('Workspace identity sentinel');
        const unexpected = name => () => { events.push(name); throw new Error(`Unexpected ${name}`); };
        const supervisor = createBoxSupervisor({
            hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
            platform: 'linux',
            env,
            runner,
            lockManager,
            resolveIdentity() {
                events.push('identity');
                throw failure;
            },
            discover: unexpected('discovery'),
            selectAgentLib: unexpected('select-agentlib'),
            updateAgentLib: unexpected('update-agentlib'),
            updateWorkspacePloinky: unexpected('update-ploinky'),
            reconcile: unexpected('reconcile'),
            startCore: unexpected('start-core'),
            runCoreCommand: unexpected('core-command'),
        });

        await assert.rejects(invoke(supervisor), error => error === failure);
        assert.deepEqual(events, ['identity']);
        assert.equal(lockManager.acquisitions, 0);
        assert.deepEqual(fs.readdirSync(state.workspace), []);
    });
}

test('status, dry-run, stop, and destroy need no prerequisite probes', async t => {
    const state = fixture(t);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: false });
    const events = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        platform: 'linux',
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ({ state: 'absent', engine: { name: 'podman' }, handles: {} }),
        retireDestroyedMarkers: () => {},
        runner: { run() { throw new Error('An absent Box needs no runtime command'); } },
    });

    assert.equal(supervisor.inspectBoxStatus().state, 'absent');
    assert.equal(supervisor.planDryRun().mutationPerformed, false);
    assert.equal(fs.existsSync(path.join(state.workspace, '.ploinky')), false);
    assert.equal((await supervisor.runStopTransaction()).action, 'absent');
    assert.equal((await supervisor.runDestroyTransaction()).action, 'absent');
    assert.deepEqual(events, ['lock', 'release', 'lock', 'release']);
});

test('destroying a running Box stops nested agents before the outer Box is removed', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity, { running: true });
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => resolveWorkspaceIdentity({ env: {}, cwd: () => state.workspace }),
        lockManager,
        discover: () => ({ state: 'unsupported', message: 'native Linux required' }),
        runner: { run() { throw new Error('must not mutate'); } },
    });
    await assert.rejects(() => supervisor.prepareBoxForCommand(), /native Linux required/);
    assert.equal(fs.existsSync(path.join(state.workspace, '.ploinky')), false);
    assert.deepEqual(events, ['lock', 'release']);
});

test('prepare locks and reconciles without prerequisite probes, then validates dependencies', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const lockManager = fakeLockManager(state.root, events);
    const ownership = owned(identity);
    const imageOverride = 'registry.example.test/ploinky-box:dev';
    const runner = { run(command, args) { events.push(`run:${args.join(' ')}`); } };
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        `run:container exec --user podman --workdir ${identity.workspaceRoot} ${ownership.handles.container.id} /opt/ploinky/bin/ploinky-install-deps`,
        'release',
    ]);
});

test('targeted restart preserves the exact running Box and mounted AgentLib generation', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity);
    const container = ownership.handles.container;
    const immutableImageRef = `docker.io/assistos/ploinky-box@sha256:${'c'.repeat(64)}`;
    container.labels[BOX_LABELS.imageRef] = immutableImageRef;
    container.labels[BOX_LABELS.routerHostPort] = '19090';
    container.labels[BOX_LABELS.mediaHostPort] = '17891';
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        env: {}, // Deliberately resolves to :latest, unlike the running Box.
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            query(_command, args) {
                events.push(`query:${args.at(-1)}`);
                return {
                    ok: true,
                    status: 0,
                    stdout: JSON.stringify({
                        state: 'running',
                        initialized: true,
                        routingConfigured: true,
                        trackedAgents: 2,
                        runningAgents: 2,
                        warnings: [],
                    }),
                };
            },
        },
        validateExistingImage(_engineName, imageId, imageRef) {
            events.push(`validate-image:${imageRef}`);
            assert.equal(imageId, 'b'.repeat(64));
            assert.equal(imageRef, immutableImageRef);
            return { immutableId: `sha256:${'b'.repeat(64)}` };
        },
        validateContainer(_container, options) {
            events.push('validate-container');
            assert.equal(options.imageRef, immutableImageRef);
            assert.equal(options.hostPort, 19090);
            assert.equal(options.mediaHostPort, 17891);
        },
        selectAgentLib: async () => assert.fail('targeted restart must not select source'),
        reconcile: async () => assert.fail('targeted restart must not reconcile or replace the Box'),
        resolveHostReachableIpv4: async () => '192.168.1.12',
        runCoreCommand: async (_engine, containerId, argv, hostPort, mediaHostPort, _runner, options) => {
            events.push(`core:${argv.join(' ')}`);
            assert.equal(containerId, container.id);
            assert.deepEqual(argv, ['restart', 'onlyOffice']);
            assert.equal(hostPort, 19090);
            assert.equal(mediaHostPort, 17891);
            assert.equal(options.hostReachableIpv4, '192.168.1.12');
            assert.equal(options.agentLib.fingerprint, agentLibFixture(identity.workspaceRoot).fingerprint);
        },
        healthCheck: async (hostPort, options) => {
            events.push(`health:${hostPort}:${options?.readinessTimeoutMs === 0 ? 'before' : 'after'}`);
        },
        commitAgentLibSelection: () => assert.fail('targeted restart must not advance source state'),
    });

    const result = await supervisor.runTargetedRestartTransaction(['restart', 'onlyOffice']);

    assert.equal(result.action, 'targeted-restart');
    assert.equal(result.containerId, container.id);
    assert.equal(result.agentLib.sourceDir, agentLibFixture(identity.workspaceRoot).sourceDir);
    assert.equal(events.some((event) => event.startsWith('core:restart onlyOffice')), true);
    assert.ok(events.indexOf('health:19090:before') < events.indexOf('core:restart onlyOffice'));
    assert.ok(events.indexOf('health:19090:before') >= 0);
    assert.ok(events.indexOf('health:19090:after') > events.indexOf('core:restart onlyOffice'));
    assert.equal(events.at(-1), 'release');
});

test('targeted restart refuses retained initialization metadata before Core can drain a recreated graph', async (t) => {
    const state = fixture(t);
    const ploinkyRoot = path.join(state.workspace, '.ploinky');
    fs.mkdirSync(ploinkyRoot);
    fs.writeFileSync(path.join(ploinkyRoot, 'routing.json'), '{"routes":{"target":{"draining":false}}}');
    fs.writeFileSync(path.join(ploinkyRoot, 'agents.json'), JSON.stringify({
        target: { type: 'agent', runtime: 'podman', containerId: 'f'.repeat(64) },
    }));
    const sourceBytes = fs.readFileSync(path.join(ploinkyRoot, 'routing.json'));
    const inbox = readInboxStatus({
        workspaceRoot: state.workspace,
        runner: { query: () => ({ ok: false, status: 1, stdout: '', stderr: '' }) },
    });
    assert.equal(inbox.initialized, true);
    assert.equal(inbox.runningAgents, 0);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    ownership.handles.container.labels[BOX_LABELS.routerHostPort] = '18080';
    ownership.handles.container.labels[BOX_LABELS.mediaHostPort] = '17882';
    const events = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: state.workspace,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { query: () => ({ ok: true, status: 0, stdout: JSON.stringify(inbox) }) },
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        selectAgentLib: async () => assert.fail('must not select source'),
        reconcile: async () => assert.fail('must not recreate the Box'),
        resolveHostReachableIpv4: async () => assert.fail('must stop before Core preparation'),
        runCoreCommand: async () => assert.fail('must not drain or mutate retained graph'),
        healthCheck: async (port, options) => {
            assert.equal(port, 18080);
            assert.equal(options.readinessTimeoutMs, 0);
            events.push('health-unavailable');
            throw new Error('current Box Router is unavailable');
        },
    });
    await assert.rejects(() => supervisor.runTargetedRestartTransaction(['restart', 'target']), {
        code: 'PLOINKY_BOX_TARGETED_RESTART_UNAVAILABLE',
        message: /ready Router/,
    });
    assert.deepEqual(events, ['lock', 'health-unavailable', 'release']);
    assert.deepEqual(fs.readFileSync(path.join(ploinkyRoot, 'routing.json')), sourceBytes);
});

test('targeted restart refuses stopped and uninitialized Boxes without mutation', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    for (const testCase of [
        { name: 'stopped', running: false, initialized: false },
        { name: 'running-uninitialized', running: true, initialized: false },
    ]) {
        const caseRoot = path.join(state.root, testCase.name);
        fs.mkdirSync(caseRoot);
        const ownership = owned(identity, { running: testCase.running });
        ownership.handles.container.labels[BOX_LABELS.routerHostPort] = '8080';
        ownership.handles.container.labels[BOX_LABELS.mediaHostPort] = '7882';
        const supervisor = createBoxSupervisor({
            hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
            resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
            lockManager: fakeLockManager(caseRoot, []),
            discover: () => ownership,
            runner: {
                query() {
                    return {
                        ok: true,
                        status: 0,
                        stdout: JSON.stringify({ initialized: testCase.initialized }),
                    };
                },
            },
            validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
            validateContainer: () => {},
            selectAgentLib: async () => assert.fail('must not select source'),
            reconcile: async () => assert.fail('must not reconcile'),
            runCoreCommand: async () => assert.fail('must not execute Core'),
        });

        await assert.rejects(
            () => supervisor.runTargetedRestartTransaction(['restart', 'onlyOffice']),
            {
                code: 'PLOINKY_BOX_TARGETED_RESTART_UNAVAILABLE',
                message: /running and initialized/,
            },
            testCase.name,
        );
    }
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
        boxRepoPath: path.join(identity.workspaceRoot, 'ploinky'),
        pullStrategy: 'rebase-autostash',
    });
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
            assert.equal(options.updateScopeRoot, identity.workspaceRoot);
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
        runUpdateCore: fakeUpdateCore({
            onCall({ engine, containerId, argv, options }) {
                assert.equal(engine, ownership.engine);
                assert.equal(containerId, ownership.handles.container.id);
                assert.deepEqual(argv, ['update']);
                assert.equal(options.workspaceRoot, identity.workspaceRoot);
                assert.equal(options.updateExcludedRepoPath, path.join(identity.workspaceRoot, 'ploinky'));
                // The expected context carries the exact identity and source snapshot.
                assert.deepEqual(options.reportContext.workspace, {
                    instance: identity.instance, workspaceRoot: identity.workspaceRoot,
                });
                assert.equal(options.reportContext.source.workspacePloinky.updated, true);
                events.push('core-update');
            },
        }),
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
    });
    await supervisor.runStopTransaction();
    assert.equal(events.some((value) => value.includes('ploinky-install-deps')), false);
    const localStop = events.findIndex((value) => (
        value.includes('/opt/ploinky/bin/ploinky-local stop')
    ));
    assert.equal(events[localStop],
        `container exec --user podman --workdir ${identity.workspaceRoot} ${ownership.handles.container.id} /opt/ploinky/bin/ploinky-local stop`);
    const outerStop = events.findIndex((value) => value.includes('container stop --time 30'));
    assert.ok(localStop >= 0 && localStop < outerStop);
});

function guardedStopSupervisor(t, { scenario, requireExistingContainerId }) {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const id = scenario === 'malformed' ? requireExistingContainerId : 'a'.repeat(64);
    const ownership = owned(identity, { id });
    const replaced = owned(identity, { id: 'c'.repeat(64) });
    const absent = { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: {} };
    const calls = [];
    const lockEvents = [];
    let discoveries = 0;
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, lockEvents),
        discover: () => {
            discoveries += 1;
            if (scenario === 'absent') return absent;
            // The Box is substituted after the anchor check but before the locked stop.
            if (scenario === 'replaced-under-lock' && discoveries > 1) return replaced;
            return ownership;
        },
        runner: {
            run(command, args) { calls.push(args.join(' ')); },
            query(command, args) { calls.push(`query ${args.join(' ')}`); },
        },
    });
    return {
        ownership, calls, lockEvents, get discoveries() { return discoveries; },
        stop: () => supervisor.runStopTransaction({ requireExistingContainerId }),
    };
}

test('guarded stop proceeds only for the matching immutable Box ID', async (t) => {
    const h = guardedStopSupervisor(t, { scenario: 'matching', requireExistingContainerId: 'a'.repeat(64) });
    const result = await h.stop();
    assert.equal(result.action, 'stopped');
    assert.equal(result.containerId, 'a'.repeat(64));
    // Ownership is authorized before the anchor and again under the lock.
    assert.equal(h.discoveries, 2);
    const localStop = h.calls.findIndex((value) => value.includes('/opt/ploinky/bin/ploinky-local stop'));
    const outerStop = h.calls.indexOf(`container stop --time 30 ${'a'.repeat(64)}`);
    assert.ok(localStop >= 0 && localStop < outerStop, h.calls.join('\n'));
    assert.deepEqual(h.lockEvents, ['lock', 'release']);
});

for (const [label, scenario, requireExistingContainerId] of [
    ['a substituted ID', 'substituted', 'f'.repeat(64)],
    ['an absent Box', 'absent', 'a'.repeat(64)],
    // The running Box carries the same malformed ID, so only the format check refuses it.
    ['an uppercase malformed ID', 'malformed', 'A'.repeat(64)],
    ['a short malformed ID', 'malformed', 'a'.repeat(63)],
    ['an empty malformed ID', 'malformed', ''],
    ['a Box substituted under the lock', 'replaced-under-lock', 'a'.repeat(64)],
]) {
    test(`guarded stop refuses ${label} without stopping anything`, async (t) => {
        const h = guardedStopSupervisor(t, { scenario, requireExistingContainerId });
        await assert.rejects(h.stop(), { code: 'PLOINKY_BOX_EXISTING_REQUIRED' });
        assert.deepEqual(h.calls, [], 'no ploinky-local graph stop and no container stop');
        assert.equal(h.discoveries, scenario === 'replaced-under-lock' ? 2 : 1);
    });
}

test('destroy revalidates the inspected immutable ID and retains cache data by default', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    seedBoxCache(identity);
    const events = [];
    const ownership = owned(identity, { running: false });
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
    assert.equal(fs.readFileSync(path.join(identity.anchorPath, 'data', 'master-key'), 'utf8'), 'secret');
    assert.equal(events.some((value) => value.includes('volume')), false);
});

test('cache deletion works when the outer container is already absent', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    seedBoxCache(identity);
    const events = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
    assert.deepEqual(calls[0].slice(0, 6), [
        'podman', 'container', 'exec', '--user', 'podman', '--workdir',
    ]);
    assert.equal(calls[0][6], identity.workspaceRoot);
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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

test('status reports a timed-out image probe as unknown without admitting or entering the Box', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const calls = [];
    const image = [{
        Id: 'b'.repeat(64), Os: 'linux', Architecture: 'arm64',
        Config: {
            User: IMAGE_CONTRACT.user, WorkingDir: IMAGE_CONTRACT.workdir,
            Env: Object.entries(IMAGE_CONTRACT.environment).map(([key, value]) => `${key}=${value}`),
            Entrypoint: [IMAGE_CONTRACT.entrypoint], Cmd: [], Volumes: {}, Labels: {},
        },
    }];
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        discover: () => ownership,
        validateContainer() { throw new Error('an unavailable image observation cannot admit a container'); },
        runner: {
            query(_command, args) {
                calls.push(args);
                if (args[0] === 'image') return { ok: true, stdout: JSON.stringify(image) };
                return { ok: false, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' };
            },
            run() { throw new Error('status cannot mutate the Box'); },
        },
    });
    const status = supervisor.inspectBoxStatus();
    assert.equal(status.state, 'unknown');
    assert.equal(status.inbox, undefined);
    assert.match(status.detail, /runtime capability probe unavailable \(timeout\)/);
    assert.doesNotMatch(formatBoxStatus(status), /destroy|recreate/);
    assert.deepEqual(calls.map(args => args.slice(0, 2)), [['image', 'inspect'], ['run', '--rm']]);
});

test('status validates the complete mount contract before entering the Box', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    let inboxQueried = false;
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        discover: () => ownership,
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        validateContainer(_container, desired) {
            assert.equal(desired.identity.workspaceRoot, state.workspace);
            assert.equal(desired.repositoryRoot, state.root);
            throw new Error(
                `Owned Box mount ${state.workspace} is incompatible; back up any Box-only data, then run 'ploinky stop' and 'ploinky destroy' before retrying`,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        env: {},
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        env: {},
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
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

test('a failed replacement restores and health-checks the prior Box graph before surfacing the failure', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const priorScope = buildHostSkillScope(identity.workspaceRoot, identity.workspaceRoot);
    writeGraphSkillScope(identity, priorScope, { assertHeld(instance) { assert.equal(instance, identity.instance); } });
    const priorAgentLib = agentLibFixture(identity.workspaceRoot);
    const candidateAgentLib = agentLibFixture(identity.workspaceRoot, {
        sourceRelativePath: '.ploinky/agentlib/generations/candidate',
    });
    const oldOwnership = owned(identity, { id: 'a'.repeat(64) });
    const candidateOwnership = owned(identity, { id: 'c'.repeat(64) });
    const events = [];
    let coreCalls = 0;
    let committed = false;
    const coreCommand = async (_engine, containerId, args, _host, _media, _runner, options) => {
        coreCalls += 1;
        events.push(`core:${containerId}:${args.join(' ')}:${options.agentLib.fingerprint}`);
        if (coreCalls === 1) throw new Error('candidate restart failed');
        assert.equal(containerId, oldOwnership.handles.container.id);
        assert.equal(options.agentLib, priorAgentLib);
        assert.deepEqual(options.skillScopeEnv, priorScope);
    };
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        env: {},
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => oldOwnership,
        runner: {
            run(_command, args) { events.push(`run:${args.join(' ')}`); },
        },
        selectAgentLib: async () => ({ selection: candidateAgentLib, mode: 'local' }),
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
        runCoreCommand: coreCommand,
        runRestartCore: fakeRestartCore(coreCommand),
        healthCheck: async () => { events.push('prior-health'); },
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
            workspaceRoot: boundedRoot,
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
        '--user', 'podman', '--workdir', boundedRoot,
    ]);
    assert.equal(calls[0][2].stdout, output);
    assert.equal(calls[0][2].stderr, output);
    assert.equal(output.value.match(/Debug mode enabled/g)?.length, 1);

    // An image source carries neither a fingerprint nor a commit. The outer image
    // ID is deliberately NOT injected per exec: every exec inherits the value set
    // when the Box was created, which the container validation checked against the
    // observed image.
    const imageAgentLib = imageAgentLibFixture();
    const imageCalls = [];
    await runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 19090, 17891,
        {
            async stream(command, args, options) {
                imageCalls.push([command, args, options]);
                options.stdout.write('[start] Router: http://127.0.0.1:19090\n');
                return { ok: true, status: 0, stdout: '[start] Router: http://127.0.0.1:19090\n', stderr: '' };
            },
        },
        { workspaceRoot: boundedRoot, stdout: output, stderr: output, timeoutMs: 1000, hostReachableIpv4: '192.168.1.12', agentLib: imageAgentLib },
    );
    const imageArgs = imageCalls[0][1];
    const imageEnv = imageArgs.flatMap((value, index) => (value === '--env' ? [imageArgs[index + 1]] : []));
    assert.deepEqual(imageEnv, [
        'PLOINKY_ROUTER_HOST_PORT=19090',
        'PLOINKY_MEDIA_HOST_PORT=17891',
        'PLOINKY_HOST_REACHABLE_IPV4=192.168.1.12',
        'PLOINKY_AGENTLIB_DIR=/opt/ploinky-agentlib',
        'PLOINKY_AGENTLIB_MODE=image',
        `PLOINKY_AGENTLIB_SOURCE_ID=${imageAgentLib.sourceIdHash}`,
    ]);
    assert.equal(imageArgs.some((value) => value.includes(OUTER_IMAGE_ID_FIXTURE) || value.includes('BOX_IMAGE_ID')), false);

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
        { workspaceRoot: boundedRoot, stdout: { write() {} }, stderr: { write() {} }, agentLib: boundedAgentLib },
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
        { workspaceRoot: boundedRoot, stdout: { write() {} }, stderr: { write() {} }, agentLib: boundedAgentLib },
    ), /public Router URL/);

    // The in-Box command always runs from the selected workspace root; it has
    // no fixed fallback working directory.
    for (const workspaceRoot of [undefined, '', 'relative', `${boundedRoot}:extra`]) {
        await assert.rejects(() => runBoundedCoreStart(
            { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 8080, 7882,
            { stream: async () => { throw new Error('an invalid workspace root must fail before Podman'); } },
            { workspaceRoot, stdout: { write() {} }, stderr: { write() {} }, agentLib: boundedAgentLib },
        ), (error) => error.code === 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID');
    }

    // A start without a selected source is a contract error, not a start that
    // lets the in-Box core resolve achillesAgentLib for itself.
    await assert.rejects(() => runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 8080, 7882,
        { stream: async () => { throw new Error('must fail before Podman'); } },
        { stdout: { write() {} }, stderr: { write() {} } },
    ), /requires the selected achillesAgentLib contract/);
});

test('bounded update excludes the exact workspace Ploinky checkout already handled on the host', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-update-exclusion-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calls = [];
    await runBoundedCoreCommand(
        { name: 'podman' },
        'a'.repeat(64),
        ['update'],
        8080,
        7882,
        {
            async stream(command, args) {
                calls.push([command, args]);
                return { ok: true, status: 0, stdout: '', stderr: '' };
            },
        },
        {
            workspaceRoot: root,
            agentLib: agentLibFixture(root),
            updateExcludedRepoPath: path.join(root, 'ploinky'),
        },
    );
    const exclusionIndex = calls[0][1].indexOf(
        `PLOINKY_UPDATED_WORKSPACE_CHECKOUT=${path.join(root, 'ploinky')}`,
    );
    assert.ok(exclusionIndex > 0);
    assert.equal(calls[0][1][exclusionIndex - 1], '--env');
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

test('public health accepts the protected control challenge in an auth-none workspace', async (t) => {
    const http = await import('node:http');
    const { requireAdminControlRequest } = await import('../../cli/server/adminControlSecurity.js');
    let requests = 0;
    let protectedHandlerCalls = 0;
    const server = http.createServer((request, response) => {
        requests += 1;
        if (requests === 1) {
            response.writeHead(503).end('{"error":"EDGE_GENERATION_INACTIVE"}');
            return;
        }
        if (!requireAdminControlRequest(request, response)) return;
        protectedHandlerCalls += 1;
        response.writeHead(200).end('{"status":"healthy"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    await checkBoxHealth(server.address().port, { readinessTimeoutMs: 1_000, retryDelayMs: 1 });

    assert.equal(requests, 2);
    assert.equal(protectedHandlerCalls, 0);
});

test('public health rejects responses that are not the protected anonymous challenge', async (t) => {
    const http = await import('node:http');
    const cases = [
        [401, { error: 'unauthorized' }],
        [401, { ok: false, error: { code: 'ADMIN_REQUIRED' } }],
        [401, { ok: true, error: { code: 'AUTH_REQUIRED' } }],
        [401, { error: { code: 'AUTH_REQUIRED' } }],
        [401, { ok: false, error: 'AUTH_REQUIRED' }],
        [401, { ok: false, error: { code: 'AUTH_REQUIRED', cause: 'unhealthy' } }],
        [401, { ok: false, error: { code: 'AUTH_REQUIRED' }, status: 'unhealthy' }],
        [403, { ok: false, error: { code: 'AUTH_REQUIRED' } }],
        [503, { ok: false, error: { code: 'AUTH_REQUIRED' } }],
        [200, { ok: false, error: { code: 'AUTH_REQUIRED' } }],
        [401, null],
        [401, []],
    ];
    for (const [status, body] of cases) {
        await t.test(`${status} ${JSON.stringify(body)}`, async (t) => {
            let requests = 0;
            const server = http.createServer((_request, response) => {
                requests += 1;
                response.writeHead(status).end(JSON.stringify(body));
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            t.after(() => new Promise((resolve) => server.close(resolve)));

            await assert.rejects(() => checkBoxHealth(server.address().port), /unhealthy|malformed/);
            assert.equal(requests, 1);
        });
    }
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

function seedRetainedNoWaitMarker(workspace, overrides = {}) {
    const runningDir = path.join(workspace, '.ploinky', 'running', 'no-wait');
    fs.mkdirSync(runningDir, { recursive: true, mode: 0o700 });
    const containerName = 'ploinky_retained_worker';
    const runId = '11111111-2222-4333-8444-555555555555';
    const markerPath = path.join(runningDir, `${containerName}.current.json`);
    const statusPath = path.join(runningDir, `${containerName}.${runId}.json`);
    fs.writeFileSync(statusPath, 'retained run status');
    fs.writeFileSync(markerPath, JSON.stringify({
        containerName, instanceId: 'old-instance', enableGeneration: 'old-generation',
        repoName: 'fixture', shortAgent: 'worker', alias: '', routeKey: 'worker',
        runId, runStartedAtMs: 1_700_000_000_000, waveIndex: 0,
        statusFile: path.basename(statusPath), ...overrides,
    }), { mode: 0o600 });
    const lockPath = path.join(path.dirname(runningDir), 'workspace-start.json');
    fs.writeFileSync(lockPath, JSON.stringify({
        operation: `no-wait-activate:${containerName}`, ownerPid: process.pid,
        token: 'retained-box-lease', expiresAt: '2020-01-01T00:00:00Z',
    }), { mode: 0o600 });
    return { markerPath, statusPath, lockPath };
}

test('destroy retires retained markers and workspace lease only after exact Box removal', async (t) => {
    const state = fixture(t);
    const files = seedRetainedNoWaitMarker(state.workspace);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity, { running: false });
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) {
            if (args[1] === 'rm') {
                assert.equal(fs.existsSync(files.markerPath), true);
                assert.equal(fs.existsSync(files.lockPath), true);
            }
        } },
    });
    await supervisor.runDestroyTransaction(ownership.handles.container.id);
    assert.equal(fs.existsSync(files.markerPath), false);
    assert.equal(fs.existsSync(files.lockPath), false);
    assert.equal(fs.readFileSync(files.statusPath, 'utf8'), 'retained run status');
});

test('repeat destroy recovers markers when the Box is already absent without reading stale registry', async (t) => {
    const state = fixture(t);
    const files = seedRetainedNoWaitMarker(state.workspace);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    fs.writeFileSync(path.join(identity.anchorPath, 'agents.json'), '{malformed retained registry');
    const events = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ({ state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null }),
        runner: { run() { assert.fail('absent Box needs no engine mutation'); } },
    });
    const result = await supervisor.runDestroyTransaction(null);
    assert.equal(result.action, 'absent');
    assert.equal(fs.existsSync(files.markerPath), false);
    assert.equal(fs.existsSync(files.lockPath), false);
    assert.equal(fs.existsSync(files.statusPath), true);
    assert.equal((await supervisor.runDestroyTransaction(null)).action, 'absent');
});

test('failed Box removal preserves current no-wait markers and workspace lease', async (t) => {
    const state = fixture(t);
    const files = seedRetainedNoWaitMarker(state.workspace);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity, { running: false });
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...state.stores,
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run() { throw new Error('removal failed'); } },
    });
    await assert.rejects(() => supervisor.runDestroyTransaction(ownership.handles.container.id), /removal failed/);
    assert.equal(fs.existsSync(files.markerPath), true);
    assert.equal(fs.existsSync(files.lockPath), true);
});

test('an unmountable workspace path fails before locking inspection, anchoring, or Box mutation', async (t) => {
    const state = fixture(t);
    const selected = path.join(state.root, 'pro:ject');
    fs.mkdirSync(selected);
    const identity = buildWorkspaceIdentity(selected, { markerFound: false });
    for (const [name, invoke] of [
        ['prepare', supervisor => supervisor.prepareBoxForCommand()],
        ['start', supervisor => supervisor.runStartTransaction(['start', 'fixture-agent'])],
        ['restart', supervisor => supervisor.runRestartTransaction(['restart'])],
        ['update', supervisor => supervisor.runUpdateTransaction(['update'])],
        ['bind', supervisor => supervisor.runBindTransaction()],
        ['stop', supervisor => supervisor.runStopTransaction()],
        ['destroy', supervisor => supervisor.runDestroyTransaction()],
    ]) {
        const events = [];
        const unexpected = label => () => { events.push(label); throw new Error(`Unexpected ${label}`); };
        const supervisor = createBoxSupervisor({
            hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
            ...state.stores,
            resolveIdentity: () => identity,
            launchCwd: selected,
            lockManager: fakeLockManager(path.join(state.root, name.replace(/\s/g, '-')), events),
            discover: unexpected('discovery'),
            selectAgentLib: unexpected('select-agentlib'),
            updateAgentLib: unexpected('update-agentlib'),
            updateWorkspacePloinky: unexpected('update-ploinky'),
            reconcile: unexpected('reconcile'),
            startCore: unexpected('start-core'),
            runCoreCommand: unexpected('core-command'),
            runner: { run: unexpected('runtime'), query: unexpected('query') },
        });
        fs.mkdirSync(path.join(state.root, name.replace(/\s/g, '-')));
        await assert.rejects(invoke(supervisor), (error) => (
            error.code === 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID' && /contains ':'/.test(error.message)
        ), name);
        // The lock lives inside the workspace, so the path is refused before it is taken.
        assert.deepEqual(events, [], name);
        assert.equal(fs.existsSync(path.join(selected, '.ploinky')), false, name);
        assert.equal(fs.existsSync(path.join(selected, '.ploinky-box')), false, name);
    }
});

// ---------------------------------------------------------------------------
// Destroy removes this workspace's host operator records (GPU grants and
// hardware limits), keeps router bindings, and finishes on a re-run.

function hostLockFor(identity) {
    return { assertHeld: (instance) => assert.equal(instance, identity.instance) };
}

function canonicalRecords(identity) {
    const root = identity.hostStateRoot;
    return [
        path.join(root, 'gpu-grants', `${identity.instance}.json`),
        path.join(root, 'gpu-grants', identity.instance),
        path.join(root, 'hardware-limits', `${identity.instance}.json`),
        path.join(root, 'hardware-limits', identity.instance),
    ];
}

// Every host operator record of one workspace, through the real stores, plus
// a router binding that destroy must keep.
function seedOperatorRecords(identity) {
    const lock = hostLockFor(identity);
    const { gpuGrantStore, hardwareGateStore } = hostStores();
    gpuGrantStore.write(identity, { vendor: 'nvidia', agents: ['demo/agent'], denied: ['other/agent'] }, lock);
    const [, gpuDir, , instanceDir] = canonicalRecords(identity);
    const generation = path.join(gpuDir, 'e'.repeat(64));
    fs.mkdirSync(generation, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(generation, 'marker.json'), '{}\n', { mode: 0o600 });
    hardwareGateStore.write(identity, true, lock);
    const paths = hardwareStorePaths({ identity });
    const { token } = initializeStore({ paths, identity });
    setAgentLimits({
        paths, identity, expectedToken: token, agentRef: 'demo/agent', limits: { cpus: 2 },
        installedRefs: new Set(['demo/agent']), capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'] },
        envelope: { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
    });
    const transitions = path.join(instanceDir, 'transitions');
    fs.mkdirSync(transitions, { mode: 0o700 });
    fs.writeFileSync(path.join(transitions, `sha256-${'1'.repeat(64)}.json`), '{}\n', { mode: 0o600 });
    const marker = path.join(instanceDir, 'f'.repeat(64), 'marker.json');
    fs.mkdirSync(path.dirname(marker), { mode: 0o700 });
    fs.writeFileSync(marker, '{}\n', { mode: 0o600 });
    const binding = path.join(identity.hostStateRoot, 'router-bindings', `${identity.instance}.json`);
    fs.mkdirSync(path.dirname(binding), { recursive: true, mode: 0o700 });
    fs.writeFileSync(binding, '{"address":"0.0.0.0","hostPort":8080}\n', { mode: 0o600 });
    return { canonical: canonicalRecords(identity), details: [generation, paths.policyPath, transitions, marker], binding };
}

function treeDigest(target) {
    const hash = crypto.createHash('sha256');
    const visit = (current) => {
        const stat = fs.lstatSync(current);
        hash.update(`${path.relative(target, current)}:${stat.mode}:`);
        if (stat.isDirectory()) for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
        else if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(current));
        else hash.update(fs.readFileSync(current));
    };
    visit(target);
    return hash.digest('hex');
}

function absentOwnership() {
    return { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: null };
}

function recordsSupervisor(state, identity, { discover = () => absentOwnership(), runner, ...overrides } = {}) {
    const events = [];
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...hostStores(),
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: fakeLockManager(fs.mkdtempSync(path.join(state.root, 'locks-')), events),
        discover,
        runner: runner || { run(command, args) { events.push(args.join(' ')); } },
        stderr: { write: (text) => events.push(`stderr:${text}`) },
        ...overrides,
    });
    return { supervisor, events };
}

function destroyFixture(t, name = 'workspace') {
    const state = fixture(t);
    const workspace = name === 'workspace' ? state.workspace : path.join(state.root, name);
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    return { state, identity: buildWorkspaceIdentity(workspace, { markerFound: true }) };
}

test('destroy removes the GPU-grant and hardware-limits records only after the Box, and keeps the router binding', async (t) => {
    const { state, identity } = destroyFixture(t);
    const seeded = seedOperatorRecords(identity);
    const bindingBytes = fs.readFileSync(seeded.binding);
    const ownership = owned(identity, { running: false });
    let atRemoval = null;
    const { supervisor, events } = recordsSupervisor(state, identity, {
        discover: () => ownership,
        runner: {
            run(command, args) {
                events.push(args.join(' '));
                if (args[1] === 'rm') atRemoval = [...seeded.canonical, ...seeded.details].map((target) => fs.existsSync(target));
            },
        },
    });
    const result = await supervisor.runDestroyTransaction(ownership.handles.container.id);
    assert.deepEqual(atRemoval, [...seeded.canonical, ...seeded.details].map(() => true), 'every record existed at container rm');
    for (const target of [...seeded.canonical, ...seeded.details]) assert.equal(fs.existsSync(target), false, target);
    assert.equal(result.action, 'destroyed');
    assert.deepEqual(result.removedRecords, seeded.canonical);
    assert.deepEqual(fs.readFileSync(seeded.binding), bindingBytes, 'the router binding survives destroy');
    assert.equal(events.some((event) => event.startsWith('stderr:')), false, events.join('\n'));
});

test('destroy removes the records of a Box that is already absent or was never created, and creates no state', async (t) => {
    const { state, identity } = destroyFixture(t);
    const seeded = seedOperatorRecords(identity);
    const { supervisor } = recordsSupervisor(state, identity, {
        runner: { run() { assert.fail('an absent Box needs no engine command'); }, query() { assert.fail('an absent Box needs no engine query'); } },
    });
    const result = await supervisor.runDestroyTransaction(null);
    assert.equal(result.action, 'absent');
    assert.deepEqual(result.removedRecords, seeded.canonical);
    for (const target of seeded.canonical) assert.equal(fs.existsSync(target), false, target);
    assert.ok(fs.existsSync(seeded.binding));

    // A fresh workspace: nothing to remove and no state directory is created.
    const fresh = destroyFixture(t);
    const empty = recordsSupervisor(fresh.state, fresh.identity, { runner: { run() { assert.fail('no engine command'); } } });
    assert.deepEqual((await empty.supervisor.runDestroyTransaction(null)).removedRecords, []);
    assert.equal(fs.existsSync(fresh.identity.hostStateRoot), false);
});

test('destroy is idempotent and finishes what a crash left behind', async (t) => {
    const { state, identity } = destroyFixture(t);
    const seeded = seedOperatorRecords(identity);
    const { supervisor } = recordsSupervisor(state, identity);
    assert.deepEqual((await supervisor.runDestroyTransaction(null)).removedRecords, seeded.canonical);
    for (let round = 0; round < 2; round += 1) {
        const again = await supervisor.runDestroyTransaction(null);
        assert.equal(again.action, 'absent');
        assert.deepEqual(again.removedRecords, [], `round ${round}`);
    }
    // Crash states: a half-deleted store, a gate record removed before the tree, and generations left after the GPU record.
    const [gpuRecord, gpuDir, hardwareRecord, instanceDir] = canonicalRecords(identity);
    fs.mkdirSync(path.join(instanceDir, 'store'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(instanceDir, 'store', 'limits.json'), '{"half":', { mode: 0o600 });
    fs.mkdirSync(path.join(gpuDir, 'e'.repeat(64)), { recursive: true, mode: 0o700 });
    const recovered = await supervisor.runDestroyTransaction(null);
    assert.deepEqual(recovered.removedRecords, [gpuDir, instanceDir]);
    for (const target of [gpuRecord, gpuDir, hardwareRecord, instanceDir]) assert.equal(fs.existsSync(target), false, target);
});

test('destroy preflights both stores before deleting anything', async (t) => {
    for (const [label, corrupt] of [
        ['hardware-limits/INSTANCE is a symlink', (identity, outside) => {
            const [, , , instanceDir] = canonicalRecords(identity);
            fs.rmSync(instanceDir, { recursive: true, force: true });
            fs.symlinkSync(outside, instanceDir);
        }],
        ['gpu-grants/INSTANCE is a symlink', (identity, outside) => {
            const [, gpuDir] = canonicalRecords(identity);
            fs.rmSync(gpuDir, { recursive: true, force: true });
            fs.symlinkSync(outside, gpuDir);
        }],
        ['hardware-limits/INSTANCE has an unexpected entry', (identity) => {
            fs.mkdirSync(path.join(canonicalRecords(identity)[3], 'evil'), { mode: 0o700 });
        }],
        ['gpu-grants/INSTANCE.json is a directory', (identity) => {
            const [gpuRecord] = canonicalRecords(identity);
            fs.rmSync(gpuRecord);
            fs.mkdirSync(gpuRecord, { mode: 0o700 });
        }],
    ]) {
        const { state, identity } = destroyFixture(t);
        const seeded = seedOperatorRecords(identity);
        const outside = path.join(state.root, 'outside');
        fs.mkdirSync(path.join(outside, 'store'), { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(outside, 'store', 'keep'), 'outside data', { mode: 0o600 });
        corrupt(identity, outside);
        const before = seeded.canonical.map((target) => (fs.existsSync(target) ? treeDigest(target) : null));
        const { supervisor } = recordsSupervisor(state, identity);
        await assert.rejects(supervisor.runDestroyTransaction(null), (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_DESTROY_RECORDS_KEPT', label);
            assert.match(error.message, /host operator records were kept: .*, then run ploinky destroy again\.$/, label);
            return true;
        }, label);
        assert.deepEqual(seeded.canonical.map((target) => (fs.existsSync(target) ? treeDigest(target) : null)), before, `${label}: nothing deleted`);
        assert.equal(fs.readFileSync(path.join(outside, 'store', 'keep'), 'utf8'), 'outside data', label);
    }
});

test('destroy leaves every record of another workspace byte-identical', async (t) => {
    const { state, identity } = destroyFixture(t);
    fs.mkdirSync(path.join(state.root, 'other', '.ploinky'), { recursive: true });
    const other = buildWorkspaceIdentity(path.join(state.root, 'other'), { markerFound: true });
    const seeded = seedOperatorRecords(identity);
    const kept = seedOperatorRecords(other);
    const before = kept.canonical.map(treeDigest);
    const ownership = owned(identity, { running: false });
    const { supervisor } = recordsSupervisor(state, identity, { discover: () => ownership });
    const result = await supervisor.runDestroyTransaction(ownership.handles.container.id);
    assert.deepEqual(result.removedRecords, seeded.canonical);
    for (const target of seeded.canonical) assert.equal(fs.existsSync(target), false, `destroyed workspace: ${target}`);
    assert.deepEqual(kept.canonical.map(treeDigest), before, 'the other workspace is untouched');
});

test('destroy never deletes records when a cache path overlaps the host control-state directory', async (t) => {
    const { state, identity } = destroyFixture(t);
    const seeded = seedOperatorRecords(identity);
    fs.mkdirSync(identity.boxDataRoot, { recursive: true });
    fs.symlinkSync(identity.hostStateRoot, identity.dataPaths.images);
    const { supervisor } = recordsSupervisor(state, identity);
    await assert.rejects(supervisor.runDestroyTransaction(null), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_DESTROY_RECORDS_KEPT');
        assert.match(error.message, new RegExp(`overlaps the host-state directory ${identity.hostStateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, so destroy never deletes there`));
        return true;
    });
    for (const target of seeded.canonical) assert.ok(fs.existsSync(target), target);
});

test('destroy --delete-cache deletes the cache of a gone Box even when the records are kept, then reports both', async (t) => {
    const { state, identity } = destroyFixture(t);
    seedBoxCache(identity);
    const seeded = seedOperatorRecords(identity);
    fs.mkdirSync(path.join(seeded.canonical[3], 'evil'), { mode: 0o700 });
    const ownership = owned(identity, { running: false });
    const { supervisor, events } = recordsSupervisor(state, identity, { discover: () => ownership });
    await assert.rejects(supervisor.runDestroyTransaction(ownership.handles.container.id, { deleteCache: true }), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_DESTROY_RECORDS_KEPT');
        assert.match(error.message, /host operator records were kept: .*Unexpected entry in hardware-limits state/);
        assert.ok(error.message.includes(`The cache data was deleted: ${identity.dataPaths.dependencies}, ${identity.dataPaths.images}.`), error.message);
        assert.deepEqual(error.deletedPaths, [identity.dataPaths.dependencies, identity.dataPaths.images]);
        return true;
    });
    assert.ok(events.some((event) => /container rm -f/.test(event)));
    assert.equal(boxCacheExists(identity), false, 'the cache was deleted');
    for (const target of seeded.canonical) assert.ok(fs.existsSync(target), target);
});

test('destroy refuses an unproven Box observation without deleting the cache or any record', async (t) => {
    const { state, identity } = destroyFixture(t);
    seedBoxCache(identity);
    const seeded = seedOperatorRecords(identity);
    for (const observation of [{ state: 'unknown', message: 'engine unavailable' }, { state: 'foreign' }]) {
        const { supervisor } = recordsSupervisor(state, identity, {
            discover: () => observation,
            runner: { run() { assert.fail('no engine mutation'); } },
        });
        await assert.rejects(supervisor.runDestroyTransaction(null, { deleteCache: true }),
            (error) => error.code === `PLOINKY_BOX_${observation.state.toUpperCase()}`);
        assert.equal(boxCacheExists(identity), true, observation.state);
        for (const target of seeded.canonical) assert.ok(fs.existsSync(target), `${observation.state}: ${target}`);
    }
});

test('a deletion failure midway keeps the rest for a re-run, which finishes', async (t) => {
    const { state, identity } = destroyFixture(t);
    const seeded = seedOperatorRecords(identity);
    let failures = 0;
    const failingFs = new Proxy(fs, {
        get(target, property) {
            if (property === 'rmSync') {
                return (entry, options) => {
                    if (failures === 0 && path.basename(entry) === 'f'.repeat(64)) {
                        failures += 1;
                        throw Object.assign(new Error(`EACCES: permission denied, rm '${entry}'`), { code: 'EACCES' });
                    }
                    return fs.rmSync(entry, options);
                };
            }
            return Reflect.get(target, property);
        },
    });
    const failing = recordsSupervisor(state, identity, {
        hardwareGateStore: createHardwareGateStore({ fsApi: failingFs }),
    });
    await assert.rejects(failing.supervisor.runDestroyTransaction(null), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_DESTROY_RECORDS_KEPT');
        assert.match(error.message, /host operator records were only partly removed: EACCES.*, then run ploinky destroy again to remove the rest\.$/);
        return true;
    });
    assert.equal(failures, 1);
    assert.equal(fs.existsSync(seeded.canonical[2]), false, 'the gate decision went first');
    assert.ok(fs.existsSync(seeded.canonical[3]), 'the tree remains');
    const rerun = recordsSupervisor(state, identity);
    const result = await rerun.supervisor.runDestroyTransaction(null);
    for (const target of seeded.canonical) assert.equal(fs.existsSync(target), false, target);
    assert.deepEqual(result.removedRecords, [seeded.canonical[0], seeded.canonical[1], seeded.canonical[3]]);
});

test('two concurrent destroys serialize on the real workspace lock; the second sees nothing left', async (t) => {
    const { state, identity } = destroyFixture(t);
    const seeded = seedOperatorRecords(identity);
    let present = true;
    const ownership = owned(identity, { running: false });
    const lockManager = createMutationLockManager();
    const supervisor = createBoxSupervisor({
        hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
        ...hostStores(),
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager,
        discover: () => (present ? ownership : absentOwnership()),
        runner: { run(command, args) { if (args[1] === 'rm') present = false; } },
    });
    const [first, second] = await Promise.all([
        supervisor.runDestroyTransaction(ownership.handles.container.id),
        supervisor.runDestroyTransaction(null),
    ]);
    assert.equal(first.action, 'destroyed');
    assert.deepEqual(first.removedRecords, seeded.canonical);
    assert.equal(second.action, 'absent');
    assert.deepEqual(second.removedRecords, []);
    assert.ok(fs.existsSync(seeded.binding));
});

test('restart passes PLOINKY_REPOS_SOURCE to Box reconciliation, keeps the Box source when unset, and refuses typos first', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const sentinel = new Error('reconcile sentinel');
    const run = async (env) => {
        const requested = [];
        const supervisor = createBoxSupervisor({
            hostStateGuard: PERMISSIVE_HOST_STATE_GUARD,
            ...state.stores,
            env,
            resolveIdentity: () => identity,
            launchCwd: identity.workspaceRoot,
            lockManager: fakeLockManager(fs.mkdtempSync(path.join(state.root, 'locks-')), []),
            discover: () => owned(identity),
            runner: { run() {} },
            selectAgentLib: async () => ({ selection: agentLibFixture(identity.workspaceRoot), mode: 'local' }),
            captureCoreStartArgv: () => Object.freeze(['start', 'explorer', '8080']),
            scanGpuAgents: (_root, options) => { requested.push(`scan:${options.includeWorkspace}`); return []; },
            reconcile: async (options) => { requested.push(options.reposSource); throw sentinel; },
        });
        await assert.rejects(supervisor.runRestartTransaction(['restart']), (error) => {
            if (error === sentinel || error?.cause === sentinel || String(error?.message).includes(sentinel.message)) return true;
            requested.push(error);
            return true;
        });
        return requested;
    };
    // The GPU manifest scan follows the source this restart applies.
    assert.deepEqual(await run({ PLOINKY_REPOS_SOURCE: 'prod' }), ['scan:false', 'prod']);
    assert.deepEqual(await run({}), ['scan:true', undefined]);
    const [refusal, ...rest] = await run({ PLOINKY_REPOS_SOURCE: 'production' });
    assert.equal(rest.length, 0, 'an invalid value never reaches reconciliation');
    assert.equal(refusal.code, 'PLOINKY_BOX_ARGUMENT_INVALID');
    assert.match(refusal.message, /PLOINKY_REPOS_SOURCE must be/);
});
