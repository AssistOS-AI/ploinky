import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import {
    REQUIRED_RELEASE_AGENTLIB_SHA,
    createReleaseDescriptor,
    serializeReleaseDescriptor,
} from '../../ploinky-box/contract/release.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import {
    admitReleaseNodeImage,
    checkBoxHealth,
    createBoxSupervisor,
    formatBoxStatus,
    runBoundedCoreStart,
    verifyBoxCapabilities,
} from '../../ploinky-box/supervisor.mjs';

const CONTAINER_ID = 'a'.repeat(64);

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

function releaseImageInspect(descriptor, kind = 'box') {
    const id = kind === 'box' ? descriptor.boxImageId : descriptor.nodeImageId;
    const digest = kind === 'box' ? descriptor.boxImageDigest : descriptor.nodeImageDigest;
    return {
        Id: id,
        Digest: digest,
        RepoDigests: [`docker.io/assistos/ploinky-${kind}@${digest}`],
        Config: {
            User: IMAGE_CONTRACT.user,
            WorkingDir: IMAGE_CONTRACT.workdir,
            Env: Object.entries(IMAGE_CONTRACT.environment)
                .map(([key, value]) => `${key}=${value}`),
            Entrypoint: [IMAGE_CONTRACT.entrypoint],
            Cmd: [],
            Volumes: {},
            Labels: {
                [IMAGE_CONTRACT.sourceShaLabel]: descriptor.artifactSourceSha,
                [IMAGE_CONTRACT.agentlibShaLabel]: descriptor.agentlibSha,
            },
        },
    };
}

function committedJournal(descriptor) {
    return {
        phase: 'committed',
        revision: 9,
        transaction: { generation: descriptor.releaseGeneration },
        container: { id: CONTAINER_ID },
    };
}

function owned(identity, descriptor, {
    running = true,
    journal = committedJournal(descriptor),
    volumes = {},
} = {}) {
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine-one' },
        journal,
        handles: {
            container: {
                id: CONTAINER_ID,
                labels: {
                    [BOX_LABELS.imageRef]: descriptor.boxImageId,
                    [BOX_LABELS.routerHostPort]: String(descriptor.routerHostPort),
                    [BOX_LABELS.releaseDescriptor]: serializeReleaseDescriptor(descriptor),
                    [BOX_LABELS.releaseGeneration]: descriptor.releaseGeneration,
                },
                runtime: { running, imageId: descriptor.boxImageId },
            },
            volumes,
        },
    };
}

function structuredClient(overrides = {}) {
    return {
        async listContainers() { return []; },
        ...overrides,
    };
}

test('existing exact Node image admission uses direct inspection and one bounded nested exec', async () => {
    const descriptor = releaseFixture();
    const journal = committedJournal(descriptor);
    const calls = [];
    const hostClient = structuredClient({
        async inspectImage(imageId) {
            calls.push({ operation: 'inspect-image', imageId });
            return releaseImageInspect(descriptor, 'node');
        },
        async execContainer(request) {
            calls.push({ operation: 'exec', request });
            return {
                exitCode: 0,
                stdout: JSON.stringify(releaseImageInspect(descriptor, 'node')),
                stderr: '',
            };
        },
        async exportImageToFile() {
            throw new Error('an already-admitted exact image must not be exported');
        },
        async putFileArchive() {
            throw new Error('an already-admitted exact image must not be copied');
        },
    });

    const admitted = await admitReleaseNodeImage(
        hostClient, CONTAINER_ID, descriptor, journal,
    );
    assert.equal(admitted.imageId, descriptor.nodeImageId);
    assert.deepEqual(calls[0], {
        operation: 'inspect-image', imageId: descriptor.nodeImageId,
    });
    assert.deepEqual(calls[1].request, {
        id: CONTAINER_ID,
        argv: ['podman', 'image', 'inspect', descriptor.nodeImageId],
        user: 'podman',
        workdir: '/workspace',
        env: {},
        journal,
        timeoutMs: 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
    });
});

test('Node image admission fails closed when structured transport is incomplete', async () => {
    const descriptor = releaseFixture();
    const calls = [];
    await assert.rejects(admitReleaseNodeImage({
        async inspectImage() { calls.push('inspect'); },
    }, CONTAINER_ID, descriptor, committedJournal(descriptor)), /structured host transport/);
    assert.deepEqual(calls, []);
});

test('managed start completes capabilities, Node admission, dependencies, core, and health under one lock', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const descriptor = releaseFixture();
    const ownership = owned(identity, descriptor);
    const events = [];
    const journal = ownership.journal;
    const hostClient = structuredClient({
        async execContainer(request) {
            if (request.argv[0] === '/bin/bash') events.push('capabilities');
            else if (request.argv[0] === '/opt/ploinky/bin/ploinky-install-deps') events.push('dependencies');
            else throw new Error(`unexpected direct exec ${request.argv.join(' ')}`);
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: async () => ownership,
        hostClient,
        validateReleaseAdmission: () => descriptor,
        reconcile: async (options) => {
            events.push('reconcile');
            const context = {
                containerId: CONTAINER_ID,
                journal,
                async advance(phase) { events.push(`advance:${phase}`); return journal; },
            };
            await options.afterStart(context);
            return {
                action: 'reused', ownership,
                hostPort: descriptor.routerHostPort,
            };
        },
        admitNodeImage: async (client, id, release, selectedJournal) => {
            assert.equal(client, hostClient);
            assert.equal(id, CONTAINER_ID);
            assert.equal(release, descriptor);
            assert.equal(selectedJournal, journal);
            events.push('admit-node');
        },
        readEdgeDesired: () => { events.push('read-edge'); return null; },
        startCore: async () => { events.push('core'); },
        healthCheck: async () => { events.push('health'); },
        stdout: { write() {} },
        stderr: { write() {} },
    });

    const result = await supervisor.runStartTransaction(['start', 'Agent', '8080'], {
        releaseDescriptor: descriptor,
    });
    assert.equal(result.containerId, CONTAINER_ID);
    assert.deepEqual(events, [
        'lock', 'reconcile', 'capabilities', 'admit-node', 'dependencies',
        'advance:dependencies-installed', 'read-edge', 'advance:edge-staged',
        'core', 'advance:core-started', 'health', 'advance:health-verified', 'release',
    ]);
});

test('managed start requires an exact release and structured host client before reconciliation', async (t) => {
    const state = fixture(t);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: false });
    const descriptor = releaseFixture();
    for (const scenario of [
        { options: {}, hostClient: structuredClient(), pattern: /exact release descriptor/ },
        { options: { releaseDescriptor: descriptor }, hostClient: null, pattern: /Structured Podman host transport/ },
    ]) {
        const events = [];
        const supervisor = createBoxSupervisor({
            resolveIdentity: () => identity,
            lockManager: fakeLockManager(state.root, events),
            discover: async () => ({ state: 'absent', handles: {} }),
            hostClient: scenario.hostClient,
            validateReleaseAdmission: () => descriptor,
            reconcile: async () => { events.push('reconcile'); },
        });
        await assert.rejects(
            supervisor.runStartTransaction(['start'], scenario.options),
            scenario.pattern,
        );
        assert.equal(events.includes('reconcile'), false);
    }
});

test('prepare reuses only a running committed generation through direct exec', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const descriptor = releaseFixture();
    const ownership = owned(identity, descriptor);
    const events = [];
    const hostClient = structuredClient({
        async execContainer(request) {
            events.push(request.argv);
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: async () => ownership,
        hostClient,
        validateReleaseAdmission: () => descriptor,
        admitNodeImage: async () => { events.push('admit-node'); },
        stdout: { write() {} },
        stderr: { write() {} },
    });

    const prepared = await supervisor.prepareBoxForCommand({ releaseDescriptor: descriptor });
    assert.equal(prepared.containerId, CONTAINER_ID);
    assert.equal(prepared.hostClient, hostClient);
    assert.equal(prepared.journal, ownership.journal);
    assert.deepEqual(events, [
        'lock',
        'admit-node',
        ['/opt/ploinky/bin/ploinky-install-deps'],
        'release',
    ]);
});

test('prepare refuses absent, stopped, or uncommitted generations before direct execution', async (t) => {
    const state = fixture(t);
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: false });
    const descriptor = releaseFixture();
    for (const ownership of [
        { state: 'absent', handles: {} },
        owned(identity, descriptor, { running: false }),
        owned(identity, descriptor, { journal: { phase: 'candidate-started' } }),
    ]) {
        const calls = [];
        const supervisor = createBoxSupervisor({
            resolveIdentity: () => identity,
            lockManager: fakeLockManager(state.root, []),
            discover: async () => ownership,
            hostClient: structuredClient({
                async execContainer() { calls.push('exec'); },
            }),
            validateReleaseAdmission: () => descriptor,
        });
        await assert.rejects(supervisor.prepareBoxForCommand(), /run `ploinky start` first/);
        assert.deepEqual(calls, []);
    }
});

test('stop performs exact in-Box containment, verifies the inbox, then stops directly', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const descriptor = releaseFixture();
    const ownership = owned(identity, descriptor);
    const events = [];
    const hostClient = structuredClient({
        async execContainer(request) {
            if (request.argv.at(-1) === 'stop') {
                events.push('local-stop');
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            events.push('inbox');
            return {
                exitCode: 0,
                stdout: JSON.stringify({
                    state: 'initialized', initialized: true, runtimes: [], warnings: [],
                }),
                stderr: '',
            };
        },
        async stopContainer({ id, timeout, journal }) {
            assert.equal(id, CONTAINER_ID);
            assert.equal(timeout, 30);
            assert.equal(journal, ownership.journal);
            events.push('outer-stop');
        },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: async () => ownership,
        hostClient,
    });

    await supervisor.runStopTransaction();
    assert.deepEqual(events, ['lock', 'local-stop', 'inbox', 'outer-stop', 'release']);
});

test('failed in-Box stop still contains the outer Box and reports failure', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const descriptor = releaseFixture();
    const ownership = owned(identity, descriptor);
    const events = [];
    const hostClient = structuredClient({
        async execContainer(request) {
            if (request.argv.at(-1) === 'stop') {
                events.push('local-stop-failed');
                return { exitCode: 7, stdout: '', stderr: '' };
            }
            events.push('inbox');
            return { exitCode: 0, stdout: '{"runtimes":[],"warnings":[]}', stderr: '' };
        },
        async stopContainer() { events.push('outer-stop'); },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager: fakeLockManager(state.root, events),
        discover: async () => ownership,
        hostClient,
    });

    await assert.rejects(supervisor.runStopTransaction(), /Outer Box stopped after ploinky-local stop failed/);
    assert.deepEqual(events, [
        'lock', 'local-stop-failed', 'inbox', 'outer-stop', 'release',
    ]);
});

test('status and dry-run await inspection without acquiring a lock or materializing an anchor', async (t) => {
    const state = fixture(t);
    const identity = resolveWorkspaceIdentity({ env: {}, cwd: () => state.workspace });
    const events = [];
    const lockManager = fakeLockManager(state.root, events);
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        lockManager,
        discover: async () => ({ state: 'absent' }),
    });
    assert.equal((await supervisor.inspectBoxStatus()).ownership.state, 'absent');
    assert.equal((await supervisor.planDryRun()).mutationPerformed, false);
    assert.equal(lockManager.acquisitions, 0);
    assert.equal(fs.existsSync(path.join(state.workspace, '.ploinky')), false);
});

test('running status uses direct image/inbox operations and strictly allowlists output', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const descriptor = releaseFixture();
    const ownership = owned(identity, descriptor);
    const calls = [];
    const hostClient = structuredClient({
        async inspectImage(imageId) {
            calls.push(['inspect-image', imageId]);
            return releaseImageInspect(descriptor, 'box');
        },
        async execContainer(request) {
            calls.push(['exec', request]);
            return {
                exitCode: 0,
                stdout: JSON.stringify({
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
                        runtime: 'bwrap',
                        role: 'provider-task',
                        effectiveInstance: 'traversal',
                        generation: 'generation-b',
                        state: 'running',
                        ownerKey: 'provider-task:runtime-b:task-b',
                        processIdentity: 'linux-proc:fixture:43',
                        workdir: '/workspace/project',
                        homeKey: 'runtime-b.sandbox-v2',
                        readiness: 'ready',
                        logPath: '/workspace/.ploinky/logs/../secret/task-b-provider.log',
                        taskId: 'task-b',
                        provider: 'codex',
                    }],
                    warnings: [{ secret: 'must-not-cross' }],
                    secret: 'must-not-cross',
                }),
                stderr: '',
            };
        },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: async () => ownership,
        hostClient,
        validateReleaseAdmission: () => descriptor,
    });

    const result = await supervisor.inspectBoxStatus();
    assert.equal(result.state, 'running-initialized');
    assert.equal(calls.filter(([operation]) => operation === 'inspect-image').length, 2);
    assert.equal(calls.filter(([operation]) => operation === 'exec').length, 1);
    assert.deepEqual(calls.find(([operation]) => operation === 'exec')[1].argv, [
        '/usr/local/bin/node',
        '/opt/ploinky/ploinky-box/inbox/readStatus.mjs',
    ]);
    assert.equal(result.inbox.runtimes.length, 1);
    assert.equal(result.inbox.invalidRuntimeEntries, 1);
    assert.deepEqual(result.inbox.warnings, [
        'inner lifecycle warning',
        'inner runtime status rejected: 1 invalid entries',
    ]);
    assert.equal(JSON.stringify(result).includes('must-not-cross'), false);
    const rendered = formatBoxStatus(result);
    assert.match(rendered, /Cloudflare mode: local-only/);
    assert.match(rendered, /Runtime: bwrap provider-task alpha running task=task-a/);
    assert.equal(rendered.includes('traversal'), false);
    assert.equal(rendered.includes('must-not-cross'), false);
});

test('status marks stale or malformed direct image inspection incompatible', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(path.join(state.workspace, '.ploinky'));
    const identity = buildWorkspaceIdentity(state.workspace, { markerFound: true });
    const descriptor = releaseFixture();
    const ownership = owned(identity, descriptor);
    const hostClient = structuredClient({
        async inspectImage() { throw new Error('exact image bytes are unavailable'); },
        async execContainer() { throw new Error('inbox must not be queried'); },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: async () => ownership,
        hostClient,
        validateReleaseAdmission: () => descriptor,
    });
    const status = await supervisor.inspectBoxStatus();
    assert.equal(status.state, 'incompatible');
    assert.match(formatBoxStatus(status), /exact image bytes are unavailable/);
});

test('capability admission runs in the exact Box and never creates a temporary host container', async () => {
    const calls = [];
    const journal = { phase: 'candidate-started' };
    const result = await verifyBoxCapabilities({
        async execContainer(request) {
            calls.push(request);
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    }, CONTAINER_ID, journal);
    assert.equal(result.includes('cloudflared'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, CONTAINER_ID);
    assert.deepEqual(calls[0].argv.slice(0, 2), ['/bin/bash', '-ceu']);
    assert.match(calls[0].argv[2], /command -v "cloudflared"/);
    assert.equal(calls[0].journal, journal);

    await assert.rejects(verifyBoxCapabilities({
        async execContainer() { return { exitCode: 97, stdout: '', stderr: '' }; },
    }, CONTAINER_ID, journal), /temporary host run is forbidden/);
});

test('bounded start uses direct exec, exact environment, and the public Dashboard URL', async () => {
    const descriptor = releaseFixture();
    const output = { value: '', write(chunk) { this.value += String(chunk); } };
    const calls = [];
    const journal = { phase: 'edge-staged' };
    const status = await runBoundedCoreStart(
        {
            async execContainer(request) {
                calls.push(request);
                return {
                    exitCode: 0,
                    stdout: '[INFO] Debug mode enabled.\n[start] Dashboard: http://127.0.0.1:19090/dashboard\n',
                    stderr: '',
                };
            },
        },
        CONTAINER_ID,
        ['--debug', 'start', 'Agent', '8080'],
        19090,
        journal,
        {
            stdout: output,
            stderr: output,
            timeoutMs: 1000,
            releaseDescriptor: descriptor,
        },
    );
    assert.equal(status, 0);
    assert.deepEqual(calls[0].argv, [
        '/opt/ploinky/bin/ploinky-local', '--debug', 'start', 'Agent', '8080',
    ]);
    assert.equal(calls[0].env.PLOINKY_ROUTER_HOST_PORT, '19090');
    assert.equal(calls[0].env.PLOINKY_RELEASE_DESCRIPTOR, serializeReleaseDescriptor(descriptor));
    assert.equal(calls[0].journal, journal);
    assert.equal(calls[0].timeoutMs, 1000);
    assert.equal(output.value.match(/Debug mode enabled/g)?.length, 1);

    await assert.rejects(runBoundedCoreStart(
        {
            async execContainer() {
                return {
                    exitCode: 0,
                    stdout: '[start] Dashboard: http://127.0.0.1:8080/dashboard\n',
                    stderr: '',
                };
            },
        },
        CONTAINER_ID,
        ['start', 'Agent', '8080'],
        19090,
        journal,
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

test('public health accepts only the active admin-auth challenge shape', async (t) => {
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

test('public health retries declared generation races and then succeeds', async (t) => {
    const http = await import('node:http');
    const transitions = [
        'EDGE_GENERATION_INACTIVE',
        'EDGE_GENERATION_RUNTIME_MISMATCH',
        'edge_generation_changed',
    ];
    let requests = 0;
    const server = http.createServer((_request, response) => {
        const transition = transitions[requests];
        requests += 1;
        if (transition) {
            response.writeHead(503).end(JSON.stringify({ error: transition }));
            return;
        }
        response.writeHead(200).end('{"status":"healthy"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    await checkBoxHealth(port, { readinessTimeoutMs: 1_000, retryDelayMs: 1 });
    assert.equal(requests, 4);
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
    await assert.rejects(checkBoxHealth(port, {
        readinessTimeoutMs: 1_000,
        retryDelayMs: 1,
    }), /unhealthy \(HTTP 401\)/);
    assert.equal(requests, 1);
});

test('public health bounds a retryable generation wait', async (t) => {
    const http = await import('node:http');
    const server = http.createServer((_request, response) => {
        response.writeHead(503).end('{"error":"EDGE_GENERATION_INACTIVE"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    await assert.rejects(checkBoxHealth(port, {
        readinessTimeoutMs: 1,
        retryDelayMs: 1,
    }), /did not become ready within 1ms/);
});
