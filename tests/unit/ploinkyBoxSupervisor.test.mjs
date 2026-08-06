import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    admitReleaseNodeImage,
    checkBoxHealth,
    createBoxSupervisor,
    formatBoxStatus,
    runBoundedCoreStart,
} from '../../ploinky-box/supervisor.mjs';
import {
    REQUIRED_RELEASE_AGENTLIB_SHA,
    createReleaseDescriptor,
} from '../../ploinky-box/contract/release.mjs';

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

function releaseFixture() {
    return createReleaseDescriptor({
        schema: 'ploinky-release-v1',
        boxImageId: 'b'.repeat(64),
        boxImageDigest: `sha256:${'1'.repeat(64)}`,
        nodeImageId: 'c'.repeat(64),
        nodeImageDigest: `sha256:${'2'.repeat(64)}`,
        artifactSourceSha: '4'.repeat(40),
        controllerSourceSha: '5'.repeat(40),
        agentlibSha: REQUIRED_RELEASE_AGENTLIB_SHA,
        routerHostPort: 18081,
        mediaHostPort: 17883,
    });
}

function releaseNodeInspect(descriptor) {
    return [{
        Id: descriptor.nodeImageId,
        RepoDigests: [`docker.io/assistos/ploinky-node@${descriptor.nodeImageDigest}`],
        Config: { Labels: {
            'io.assistos.ploinky.source-sha': descriptor.artifactSourceSha,
            'io.assistos.ploinky.agentlib-sha': descriptor.agentlibSha,
        } },
    }];
}

test('exact release Node admission streams the raw image into the exact Box and re-inspects it', async () => {
    const descriptor = releaseFixture();
    const containerId = 'a'.repeat(64);
    const calls = [];
    let nestedInspections = 0;
    const runner = {
        query(engine, args) {
            calls.push({ method: 'query', engine, args });
            if (args[0] === 'image') {
                return { ok: true, stdout: JSON.stringify(releaseNodeInspect(descriptor)) };
            }
            nestedInspections += 1;
            return nestedInspections === 1
                ? { ok: false, stdout: '', stderr: 'image not known' }
                : { ok: true, stdout: JSON.stringify(releaseNodeInspect(descriptor)) };
        },
        async pipe(sourceCommand, sourceArgs, destinationCommand, destinationArgs) {
            calls.push({ method: 'pipe', sourceCommand, sourceArgs, destinationCommand, destinationArgs });
            return { ok: true, status: 0, stdout: '', stderr: '' };
        },
    };

    const admitted = await admitReleaseNodeImage(
        { name: 'podman' }, containerId, descriptor, runner,
    );
    assert.equal(admitted.imageId, descriptor.nodeImageId);
    assert.deepEqual(calls[0], {
        method: 'query', engine: 'podman',
        args: ['image', 'inspect', descriptor.nodeImageId],
    });
    const transfer = calls.find((call) => call.method === 'pipe');
    assert.deepEqual(transfer, {
        method: 'pipe',
        sourceCommand: 'podman',
        sourceArgs: ['image', 'save', '--format', 'oci-archive', descriptor.nodeImageId],
        destinationCommand: 'podman',
        destinationArgs: [
            'container', 'exec', '-i', '--user', 'podman', '--workdir', '/workspace',
            containerId, 'podman', 'image', 'load',
        ],
    });
    const nested = calls.filter((call) => call.method === 'query' && call.args[0] === 'container');
    assert.equal(nested.length, 2);
    assert.deepEqual(nested[1].args.slice(-4), [
        'podman', 'image', 'inspect', descriptor.nodeImageId,
    ]);
    assert.equal(JSON.stringify(calls).includes('pull'), false);
    assert.equal(JSON.stringify(calls).includes('24-bookworm-tools'), false);
});

test('managed start admits the exact release Node image before dependencies and core readiness', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const descriptor = releaseFixture();
    const events = [];
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        validateReleaseAdmission: () => descriptor,
        reconcile: async (options) => {
            events.push('reconcile');
            await options.admitNodeImage(
                ownership.engine,
                ownership.handles.container.id,
                descriptor,
            );
            return { action: 'reused', ownership, hostPort: descriptor.routerHostPort };
        },
        admitNodeImage: async (engine, containerId, release) => {
            assert.equal(engine, ownership.engine);
            assert.equal(containerId, ownership.handles.container.id);
            assert.equal(release, descriptor);
            events.push('admit-node');
        },
        runner: {
            run(command, args) { events.push(`run:${args.join(' ')}`); },
        },
        readEdgeDesired: () => null,
        startCore: async () => { events.push('core'); },
        healthCheck: async () => { events.push('health'); },
    });

    await supervisor.runStartTransaction(['start'], { releaseDescriptor: descriptor });
    assert.ok(events.indexOf('reconcile') < events.indexOf('admit-node'));
    assert.ok(events.indexOf('admit-node') < events.findIndex((entry) => entry.includes('ploinky-install-deps')));
    assert.ok(events.indexOf('admit-node') < events.indexOf('core'));
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
        runner: {
            run(command, args) { events.push(args.join(' ')); },
            query(command, args) {
                events.push(args.join(' '));
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        state: 'initialized',
                        initialized: true,
                        runtimes: [],
                        warnings: [],
                    }),
                };
            },
        },
    });
    await supervisor.runStopTransaction();
    assert.equal(events.some((value) => value.includes('ploinky-install-deps')), false);
    const localStop = events.findIndex((value) => (
        value.includes('/opt/ploinky/bin/ploinky-local stop')
    ));
    const outerStop = events.findIndex((value) => value.includes('container stop --time 30'));
    const survivorCheck = events.findIndex((value) => (
        value.includes('/opt/ploinky/ploinky-box/inbox/readStatus.mjs')
    ));
    assert.ok(localStop >= 0 && localStop < survivorCheck && survivorCheck < outerStop);
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
    ownership.handles.volumes = { workspace: { name: identity.volumes.workspace } };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(command, args) { events.push(args.join(' ')); } },
        destroyNamedVolumes(options) {
            options.lock.assertHeld(identity.instance);
            assert.equal(options.knownHandles, ownership.handles.volumes);
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
    assert.deepEqual(result.deletedVolumes, Object.values(identity.volumes));
});

test('destructive volume reset works when only the complete retained set remains', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity);
    ownership.handles.container = null;
    ownership.handles.volumes = { workspace: { name: identity.volumes.workspace } };
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
                    runtimes: [{
                        runtime: 'bwrap',
                        role: 'provider-task',
                        effectiveInstance: 'alpha',
                        generation: 'generation-a',
                        state: 'running',
                        ownerKey: 'provider-task:runtime-a:task-a',
                        processIdentity: 'linux-proc:fixture:42',
                        workdir: '/workspace/project',
                        homeKey: 'runtime-a.sandbox-v2',
                        readiness: 'ready',
                        logPath: '/workspace/.ploinky/logs/agents/instance-a/tasks/task-a-provider.log',
                        taskId: 'task-a',
                        provider: 'codex',
                        brokerOwner: 'must-not-cross',
                    }, {
                        runtime: 'container',
                        role: 'service',
                        effectiveInstance: 'container-writer',
                        generation: 'generation-container',
                        state: 'running',
                        ownerKey: `container:${'c'.repeat(64)}`,
                        processIdentity: `container:${'c'.repeat(64)}`,
                        workdir: '/workspace/projects/current',
                        homeKey: 'coding_container',
                        readiness: 'ready',
                        logPath: `podman://${'c'.repeat(64)}`,
                    }],
                    warnings: [], secret: 'must-not-cross',
                }) };
            },
        },
    });
    const result = supervisor.inspectBoxStatus();
    assert.equal(result.state, 'running-initialized');
    assert.equal(calls[0].includes(ownership.handles.container.id), true);
    assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
    assert.equal(result.inbox.runtimes.length, 2);
    assert.deepEqual(result.inbox.runtimes[0], {
        runtime: 'bwrap',
        role: 'provider-task',
        effectiveInstance: 'alpha',
        generation: 'generation-a',
        state: 'running',
        ownerKey: 'provider-task:runtime-a:task-a',
        processIdentity: 'linux-proc:fixture:42',
        workdir: '/workspace/project',
        homeKey: 'runtime-a.sandbox-v2',
        readiness: 'ready',
        logPath: '/workspace/.ploinky/logs/agents/instance-a/tasks/task-a-provider.log',
        taskId: 'task-a',
        provider: 'codex',
    });
    assert.deepEqual(result.inbox.runtimes[1], {
        runtime: 'container',
        role: 'service',
        effectiveInstance: 'container-writer',
        generation: 'generation-container',
        state: 'running',
        ownerKey: `container:${'c'.repeat(64)}`,
        processIdentity: `container:${'c'.repeat(64)}`,
        workdir: '/workspace/projects/current',
        homeKey: 'coding_container',
        readiness: 'ready',
        logPath: `podman://${'c'.repeat(64)}`,
    });
    assert.equal(formatBoxStatus(result).includes('must-not-cross'), false);
    assert.equal(result.inbox.cloudflarePublication.state, 'unstarted');
    assert.match(formatBoxStatus(result), /Cloudflare mode: local-only/);
    assert.match(formatBoxStatus(result), /bwrap provider-task alpha running/);
    assert.match(formatBoxStatus(result), /container service container-writer running/);
    assert.match(formatBoxStatus(result), /podman:\/\/c{64}/);
});

test('running status rejects traversal logs and identity-incomplete ready runtimes', (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const ownership = owned(identity);
    const containerId = 'c'.repeat(64);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: () => ownership,
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        runner: {
            query() {
                return { ok: true, stdout: JSON.stringify({
                    state: 'initialized',
                    initialized: true,
                    runtimes: [{
                        runtime: 'bwrap',
                        role: 'provider-task',
                        effectiveInstance: 'alpha',
                        generation: 'generation-a',
                        state: 'running',
                        ownerKey: 'provider-task:runtime-a:task-a',
                        processIdentity: 'linux-proc:fixture:42',
                        workdir: '/workspace/project',
                        homeKey: 'runtime-a.sandbox-v2',
                        readiness: 'ready',
                        logPath: '/workspace/.ploinky/logs/../secrets/canary',
                        taskId: 'task-a',
                        provider: 'codex',
                    }, {
                        runtime: 'container',
                        role: 'service',
                        effectiveInstance: 'container-writer',
                        generation: '',
                        state: 'running',
                        ownerKey: `container:${containerId}`,
                        processIdentity: `container:${containerId}`,
                        workdir: '',
                        homeKey: '',
                        readiness: 'ready',
                        logPath: `podman://${containerId}`,
                    }, {
                        runtime: 'bwrap',
                        role: 'provider-task',
                        effectiveInstance: 'foreign-provider',
                        generation: 'generation-b',
                        state: 'running',
                        ownerKey: 'provider-task:runtime-b:task-b',
                        processIdentity: 'linux-proc:fixture:43',
                        workdir: '/etc',
                        homeKey: 'runtime-b.sandbox-v2',
                        readiness: 'ready',
                        logPath: '/workspace/.ploinky/logs/agents/instance-b/tasks/task-b-provider.log',
                        taskId: 'task-b',
                        provider: 'codex',
                    }, {
                        runtime: 'container',
                        role: 'service',
                        effectiveInstance: 'foreign-container',
                        generation: 'generation-container-b',
                        state: 'running',
                        ownerKey: `container:${containerId}`,
                        processIdentity: `container:${containerId}`,
                        workdir: '/etc',
                        homeKey: 'container-b',
                        readiness: 'ready',
                        logPath: `podman://${containerId}`,
                    }, {
                        runtime: 'seatbelt',
                        role: 'service',
                        effectiveInstance: 'foreign-sandbox-service',
                        generation: 'generation-service-a',
                        state: 'running',
                        ownerKey: 'service-owner-a',
                        processIdentity: 'darwin-proc:fixture:44',
                        workdir: '/etc',
                        homeKey: 'runtime-service-a.sandbox-v2',
                        readiness: 'ready',
                        logPath: '/workspace/.ploinky/logs/seatbelt-a.log',
                    }, {
                        runtime: 'bwrap',
                        role: 'service',
                        effectiveInstance: 'valid-sandbox-service',
                        generation: 'generation-service-b',
                        state: 'running',
                        ownerKey: 'service-owner-b',
                        processIdentity: 'linux-proc:fixture:45',
                        workdir: '/code',
                        homeKey: 'runtime-service-b.sandbox-v2',
                        readiness: 'ready',
                        logPath: '/workspace/.ploinky/logs/bwrap-b.log',
                    }],
                    warnings: [],
                }) };
            },
        },
    });

    const result = supervisor.inspectBoxStatus();
    const output = formatBoxStatus(result);
    assert.equal(result.inbox.invalidRuntimeEntries, 5);
    assert.deepEqual(result.inbox.runtimes.map((runtime) => runtime.effectiveInstance), [
        'valid-sandbox-service',
    ]);
    assert.equal(JSON.stringify(result).includes('canary'), false);
    assert.doesNotMatch(output, /container-writer|foreign-|provider-task/);
    assert.match(output, /valid-sandbox-service/);
    assert.match(output, /5 invalid entries/);
});

test('stop reports exact inner survivors after containment and never exposes unallowlisted fields', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const events = [];
    const ownership = owned(identity);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            run(command, args) { events.push(args.join(' ')); },
            query(command, args) {
                events.push(args.join(' '));
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        state: 'initialized',
                        initialized: true,
                        runtimes: [{
                            runtime: 'container',
                            role: 'provider-task',
                            effectiveInstance: 'codex-a',
                            generation: 'generation-a',
                            state: 'failed',
                            ownerKey: 'provider-task:container-a:task-a',
                            processIdentity: 'linux-proc:fixture:42',
                            workdir: '/workspace/project',
                            homeKey: 'container-a',
                            readiness: 'not-ready',
                            logPath: '/workspace/.ploinky/logs/agents/instance-a/tasks/task-a-provider.log',
                            taskId: 'task-a',
                            provider: 'codex',
                            secret: 'must-not-cross',
                        }],
                        warnings: [],
                    }),
                };
            },
        },
    });

    await assert.rejects(
        () => supervisor.runStopTransaction(),
        (error) => {
            assert.match(error.message, /container provider-task codex-a task-a failed/);
            assert.doesNotMatch(error.message, /must-not-cross/);
            return true;
        },
    );
    assert.equal(events.some((value) => value.includes('container stop --time 30')), true);
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
            query() {
                return { ok: true, stdout: JSON.stringify({ runtimes: [], warnings: [] }) };
            },
        },
    });
    await assert.rejects(
        () => supervisor.runStopTransaction(),
        /Outer Box stopped after ploinky-local stop failed/,
    );
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
        },
    );
    assert.equal(status, 0);
    assert.deepEqual(calls[0][1].slice(-4), ['--debug', 'start', 'Agent', '8080']);
    assert.deepEqual(calls[0][1].slice(0, 6), [
        'container', 'exec',
        '--env', 'PLOINKY_ROUTER_HOST_PORT=19090',
        '--user', 'podman',
    ]);
    assert.equal(calls[0][2].stdout, output);
    assert.equal(calls[0][2].stderr, output);
    assert.equal(output.value.match(/Debug mode enabled/g)?.length, 1);

    const defaultTimeoutCalls = [];
    await runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 8080,
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

    await assert.rejects(() => runBoundedCoreStart(
        { name: 'podman' }, 'a'.repeat(64), ['start', 'Agent', '8080'], 19090,
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
