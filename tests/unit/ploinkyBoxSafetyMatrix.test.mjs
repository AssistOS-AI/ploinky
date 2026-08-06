import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { executeBoxCommand } from '../../ploinky-box/command/execute.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import {
    buildOuterContainerDefinition,
    directContainerCreateSpec,
} from '../../ploinky-box/lifecycle/container.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { buildEngineProcessEnvironment } from '../../ploinky-box/process.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import {
    REQUIRED_RELEASE_AGENTLIB_SHA,
    createReleaseDescriptor,
    serializeReleaseDescriptor,
} from '../../ploinky-box/contract/release.mjs';
import { stripReservedAgentEnv } from '../../cli/utils/security/agentIdentityEnv.js';

function bufferStream(isTTY = false) {
    let bytes = '';
    return {
        isTTY,
        write(chunk) { bytes += String(chunk); },
        value() { return bytes; },
    };
}

function releaseDescriptor() {
    return createReleaseDescriptor({
        schema: 'ploinky-release-v1',
        boxImageId: 'b'.repeat(64),
        boxImageDigest: `sha256:${'c'.repeat(64)}`,
        nodeImageId: 'd'.repeat(64),
        nodeImageDigest: `sha256:${'e'.repeat(64)}`,
        artifactSourceSha: '1'.repeat(40),
        controllerSourceSha: '2'.repeat(40),
        agentlibSha: REQUIRED_RELEASE_AGENTLIB_SHA,
        routerHostPort: 18080,
        mediaHostPort: 17882,
    });
}

function owned(identity, hostClient, { running = true } = {}) {
    const descriptor = releaseDescriptor();
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine-fingerprint' },
        hostClient,
        handles: {
            container: {
                id: 'a'.repeat(64),
                labels: {
                    [BOX_LABELS.routerHostPort]: String(descriptor.routerHostPort),
                    [BOX_LABELS.releaseGeneration]: descriptor.releaseGeneration,
                    [BOX_LABELS.releaseDescriptor]: serializeReleaseDescriptor(descriptor),
                },
                runtime: { running },
            },
            volumes: {},
        },
        journal: {
            container: {
                id: 'a'.repeat(64),
                creation: { dependencies: [], autoRemove: false },
            },
            predecessor: null,
            phase: 'committed',
        },
    };
}

function dispatchSupervisor(identity, events, { withContainer = false } = {}) {
    const container = withContainer
        ? { id: 'a'.repeat(64), labels: { [BOX_LABELS.routerHostPort]: '18080' } }
        : null;
    const ownership = { state: container ? 'owned' : 'absent', handles: { container } };
    return {
        async inspectBoxStatus() {
            events.push('inspect');
            return { identity, ownership, state: container ? 'stopped' : 'absent' };
        },
        async planDryRun() { events.push('dry-run'); return { mutationPerformed: false }; },
        async runStopTransaction() { events.push('stop'); },
        async runDestroyTransaction(id) { assert.equal(id, container?.id); events.push('destroy'); },
        async runStartTransaction() { events.push('start'); },
        async prepareBoxForCommand() {
            events.push('prepare');
            return { containerId: 'a'.repeat(64) };
        },
        async executeCommand(_prepared, argv) {
            events.push(`execute:${argv.join(' ')}`);
            return 0;
        },
    };
}

test('every public verb dispatches one bounded supervisor operation without a host CLI fallback', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-verb-matrix-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const cases = [
        { name: 'help', argv: ['help'], expected: [] },
        { name: 'status', argv: ['status'], expected: ['inspect'] },
        { name: 'dry-run', argv: ['--dry-run', 'start', 'Agent'], expected: ['dry-run'] },
        { name: 'stop', argv: ['stop'], expected: ['stop'] },
        {
            name: 'destroy', argv: ['destroy'], withContainer: true,
            expected: ['inspect', 'destroy'],
        },
        { name: 'start', argv: ['start', 'Agent'], expected: ['start'] },
        {
            name: 'repl', argv: [],
            expected: ['prepare', 'execute:/opt/ploinky/bin/ploinky-local'],
        },
        { name: 'bash', argv: ['cli'], expected: ['prepare', 'execute:'] },
        {
            name: 'agent-cli',
            argv: ['cli', 'Agent', '--workdir', 'project', '--'],
            expected: ['prepare', 'execute:/opt/ploinky/bin/ploinky-local cli Agent --workdir project --'],
        },
        {
            name: 'generic', argv: ['logs', '--tail'],
            expected: ['prepare', 'execute:/opt/ploinky/bin/ploinky-local logs --tail'],
        },
    ];
    for (const scenario of cases) {
        const events = [];
        const supervisor = dispatchSupervisor(identity, events, scenario);
        const code = await runOuterCli(scenario.argv, {
            env: {},
            input: { isTTY: false },
            output: bufferStream(),
            errorOutput: bufferStream(),
            supervisor,
            confirmDestroy: async () => true,
            detectInsideBox: () => false,
        });
        assert.equal(code, 0, scenario.name);
        assert.deepEqual(events, scenario.expected, scenario.name);
        assert.equal(JSON.stringify(events).includes('podman'), false, scenario.name);
        assert.equal(JSON.stringify(events).includes('docker'), false, scenario.name);
    }
});

test('start stages host-owned edge desired state under the Box lock before core startup', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-edge-start-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const events = [];
    const candidate = {
        path: path.join(root, '.ploinky', 'edge-desired.json'),
        digest: 'b'.repeat(64),
        size: 123,
    };
    const descriptor = releaseDescriptor();
    const hostClient = {
        async listContainers() { return []; },
        async execContainer({ argv }) {
            if (argv.includes('/opt/ploinky/bin/ploinky-install-deps')) {
                events.push('dependencies');
            } else {
                events.push('capabilities');
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
    };
    const ownership = owned(identity, hostClient);
    const stagedSupervisor = createBoxSupervisor({
        hostClient,
        resolveIdentity: () => identity,
        discover: () => ownership,
        lockManager: {
            async acquire(instance) {
                events.push('lock');
                let released = false;
                return {
                    assertHeld(expected) {
                        assert.equal(expected, instance);
                        assert.equal(released, false);
                    },
                    release() {
                        released = true;
                        events.push('release');
                    },
                };
            },
        },
        reconcile: async (options) => {
            events.push('reconcile');
            let journal = {
                container: {
                    id: 'a'.repeat(64),
                    creation: { dependencies: [], autoRemove: false },
                },
                predecessor: null,
                phase: 'candidate-started',
            };
            await options.afterStart({
                action: 'created',
                containerId: 'a'.repeat(64),
                hostClient,
                get journal() { return journal; },
                async advance(phase) { journal = { ...journal, phase }; return journal; },
            });
            return {
                ownership,
                hostPort: descriptor.routerHostPort,
                action: 'created',
            };
        },
        validateReleaseAdmission: () => undefined,
        admitNodeImage: async () => { events.push('admit-node'); },
        readEdgeDesired(selectedIdentity) {
            assert.equal(selectedIdentity, identity);
            events.push('read-edge-desired');
            return candidate;
        },
        stageEdgeDesired(options) {
            assert.equal(options.candidate, candidate);
            assert.equal(options.containerId, 'a'.repeat(64));
            events.push('stage-edge-desired');
        },
        startCore: async () => { events.push('start-core'); },
        healthCheck: async () => { events.push('health'); },
    });

    await stagedSupervisor.runStartTransaction(['start', 'Agent', '8080'], {
        releaseDescriptor: descriptor,
    });

    assert.ok(events.indexOf('lock') < events.indexOf('read-edge-desired'));
    assert.ok(events.indexOf('capabilities') < events.indexOf('dependencies'));
    assert.ok(events.indexOf('dependencies') < events.indexOf('read-edge-desired'));
    assert.ok(events.indexOf('read-edge-desired') < events.indexOf('stage-edge-desired'));
    assert.ok(events.indexOf('stage-edge-desired') < events.indexOf('start-core'));
    assert.ok(events.indexOf('start-core') < events.indexOf('health'));
    assert.ok(events.indexOf('health') < events.indexOf('release'));
});

test('foreign ownership blocks every lifecycle path with zero engine mutation', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-foreign-matrix-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(root, { markerFound: false });
    for (const argv of [['status'], ['stop'], ['destroy'], ['start', 'Agent'], ['logs']]) {
        const mutations = [];
        const supervisor = createBoxSupervisor({
            resolveIdentity: () => identity,
            discover: () => ({ state: 'foreign', message: 'foreign exact-name resource' }),
            runner: {
                run(command, args) { mutations.push([command, ...args]); },
                query(command, args) { mutations.push([command, ...args]); return { ok: false }; },
            },
        });
        const invocation = runOuterCli(argv, {
            env: {}, supervisor,
            input: { isTTY: false }, output: bufferStream(), errorOutput: bufferStream(),
            execute() { mutations.push(['execute']); return 0; },
            confirmDestroy: async () => { throw new Error('foreign destroy must not prompt'); },
        });
        if (argv[0] === 'status' || argv[0] === 'destroy') {
            assert.equal(await invocation, 1, argv.join(' '));
        } else {
            await assert.rejects(invocation, /foreign exact-name resource/, argv.join(' '));
        }
        assert.deepEqual(mutations, [], argv.join(' '));
        assert.equal(fs.existsSync(path.join(root, '.ploinky')), false, argv.join(' '));
    }
});

test('master-key and arbitrary host canaries cannot cross structured outer or agent boundaries', async (t) => {
    const host = {
        PATH: '/usr/bin:/bin',
        HOME: '/private/home',
        USER: 'operator',
        XDG_CONFIG_HOME: '/private/config',
        PLOINKY_MASTER_KEY: 'HOST_MASTER_CANARY',
        UNRELATED_SECRET: 'UNRELATED_CANARY',
    };
    const engineEnvironment = buildEngineProcessEnvironment(host);
    assert.deepEqual(engineEnvironment, {
        PATH: '/usr/bin:/bin',
        HOME: '/private/home',
        USER: 'operator',
        XDG_CONFIG_HOME: '/private/config',
    });
    const root = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'ploinky-box-canary-'),
    ));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(root, { markerFound: false });
    const descriptor = releaseDescriptor();
    const definition = buildOuterContainerDefinition({
        identity,
        imageId: descriptor.boxImageId,
        imageRef: descriptor.boxImageId,
        hostPort: descriptor.routerHostPort,
        mediaHostPort: descriptor.mediaHostPort,
        repositoryRoot: root,
        hostKind: 'podman-machine',
        releaseDescriptor: descriptor,
    });
    const createSpec = directContainerCreateSpec(definition);
    let execRequest = null;
    await executeBoxCommand({
        hostClient: {
            async execContainer(request) {
                execRequest = structuredClone(request);
                return { exitCode: 0, stdout: '', stderr: '' };
            },
        },
        containerId: 'a'.repeat(64),
        journal: { container: { id: 'a'.repeat(64) } },
        argv: ['status'],
        hostPort: descriptor.routerHostPort,
    });
    for (const canary of Object.values(host).filter((value) => /CANARY/.test(value))) {
        assert.equal(JSON.stringify(engineEnvironment).includes(canary), false);
        assert.equal(JSON.stringify(createSpec).includes(canary), false);
        assert.equal(JSON.stringify(execRequest).includes(canary), false);
    }
    const agentEnvironment = { SAFE: 'yes', ...host };
    stripReservedAgentEnv(agentEnvironment);
    assert.equal(agentEnvironment.PLOINKY_MASTER_KEY, undefined);
});

test('generated workspace key has one trusted Watchdog-to-Router inheritance path and is never logged', () => {
    const workspaceUtil = fs.readFileSync(path.join(
        import.meta.dirname, '../../cli/commands/workspaceUtil.js',
    ), 'utf8');
    const watchdog = fs.readFileSync(path.join(
        import.meta.dirname, '../../cli/server/Watchdog.js',
    ), 'utf8');
    assert.match(workspaceUtil, /env:\s*\{\s*\.\.\.buildRouterEnv\(\),/);
    assert.match(watchdog, /const env = \{\s*\.\.\.restEnv,\s*MANAGED_BY_PROCESS_MANAGER:/);
    assert.doesNotMatch(workspaceUtil, /console\.(?:log|error)\([^\n]*PLOINKY_MASTER_KEY/);
    assert.doesNotMatch(watchdog, /(?:log|safeConsole)\([^\n]*PLOINKY_MASTER_KEY/);
});

test('first parent mutation makes every child resolution reuse one identity', async (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-parent-child-'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    const child = path.join(parent, 'child');
    fs.mkdirSync(child);
    const initial = resolveWorkspaceIdentity({ env: {}, cwd: () => parent });
    fs.mkdirSync(initial.anchorPath);
    const fromParent = resolveWorkspaceIdentity({ env: {}, cwd: () => parent });
    const fromChild = resolveWorkspaceIdentity({ env: {}, cwd: () => child });
    assert.equal(fromParent.instance, initial.instance);
    assert.equal(fromChild.instance, initial.instance);
    assert.equal(fromChild.workspaceRoot, parent);
    assert.deepEqual(fromChild.volumes, initial.volumes);
});
