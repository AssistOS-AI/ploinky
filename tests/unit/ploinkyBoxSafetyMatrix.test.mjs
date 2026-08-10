import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { buildContainerExecArgs } from '../../ploinky-box/command/execute.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { buildWorkspaceIdentity, resolveWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { buildEngineProcessEnvironment } from '../../ploinky-box/process.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { stripReservedAgentEnv } from '../../cli/utils/security/agentIdentityEnv.js';

function bufferStream(isTTY = false) {
    let bytes = '';
    return {
        isTTY,
        write(chunk) { bytes += String(chunk); },
        value() { return bytes; },
    };
}

function owned(identity, { running = true } = {}) {
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine-fingerprint' },
        handles: {
            container: {
                id: 'a'.repeat(64),
                labels: {
                    [BOX_LABELS.routerHostPort]: '8080',
                    [BOX_LABELS.mediaHostPort]: '7882',
                },
                runtime: { running },
            },
        },
    };
}

function matrixSupervisor(identity, events) {
    const ownership = owned(identity);
    let acquisitions = 0;
    const lockManager = {
        get acquisitions() { return acquisitions; },
        async acquire(instance) {
            acquisitions += 1;
            events.push('lock');
            let released = false;
            return {
                assertHeld(expected) {
                    assert.equal(expected, instance);
                    assert.equal(released, false);
                },
                release() {
                    assert.equal(released, false);
                    released = true;
                    events.push('release');
                },
            };
        },
    };
    const runner = {
        run(command, args) { events.push(`run:${args.join(' ')}`); },
        query(command, args) {
            events.push(`query:${args.join(' ')}`);
            return {
                ok: true,
                status: 0,
                stdout: JSON.stringify({
                    state: 'initialized', initialized: true, routingConfigured: true,
                    trackedAgents: 0, runningAgents: 0, warnings: [],
                }),
                stderr: '',
            };
        },
    };
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: () => ownership,
        lockManager,
        runner,
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        validateContainer: () => ({}),
        reconcile: async ({ lock }) => {
            lock.assertHeld(identity.instance);
            events.push('reconcile');
            return { ownership, hostPort: 8080, mediaHostPort: 7882, action: 'reused' };
        },
        startCore: async () => { events.push('start-core'); },
        healthCheck: async () => { events.push('health'); },
    });
    return { supervisor, lockManager };
}

test('every public verb has the required single-lock depth and release boundary', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-verb-matrix-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const cases = [
        { name: 'help', argv: ['help'], locks: 0 },
        { name: 'status', argv: ['status'], locks: 0 },
        { name: 'dry-run', argv: ['--dry-run', 'start', 'Agent'], locks: 0 },
        { name: 'stop', argv: ['stop'], locks: 1 },
        { name: 'destroy', argv: ['destroy'], locks: 1 },
        { name: 'start', argv: ['start', 'Agent'], locks: 1 },
        { name: 'update', argv: ['update'], locks: 1, forwarded: true },
        { name: 'repl', argv: [], locks: 1, forwarded: true },
        { name: 'bash', argv: ['cli'], locks: 1, forwarded: true },
        { name: 'agent-cli', argv: ['cli', 'Agent'], locks: 1, forwarded: true },
        { name: 'generic', argv: ['list', 'agents'], locks: 1, forwarded: true },
        // Logs are observational: they inspect Box status and forward without
        // ever taking the workspace mutation lock.
        { name: 'logs', argv: ['logs', 'last', '5'], locks: 0, forwarded: true },
    ];
    for (const scenario of cases) {
        const events = [];
        const { supervisor, lockManager } = matrixSupervisor(identity, events);
        const execute = () => { events.push('execute'); return 0; };
        const code = await runOuterCli(scenario.argv, {
            env: {},
            input: { isTTY: false },
            output: bufferStream(),
            errorOutput: bufferStream(),
            supervisor,
            execute,
            executeStreaming: execute,
            updateHostSource: async () => ({ updated: false }),
        });
        assert.equal(code, 0, scenario.name);
        assert.equal(lockManager.acquisitions, scenario.locks, scenario.name);
        assert.equal(events.filter((event) => event === 'lock').length, scenario.locks, scenario.name);
        assert.equal(events.filter((event) => event === 'release').length, scenario.locks, scenario.name);
        assert.equal(events.some((event) => event.includes(' pull ')), false, scenario.name);
        if (scenario.forwarded) {
            assert.ok(events.indexOf('release') < events.indexOf('execute'), scenario.name);
        }
        if (scenario.name === 'start') {
            assert.ok(events.indexOf('health') < events.indexOf('release'));
        }
        if (scenario.name === 'stop') {
            const outerStop = events.findIndex((event) => event.includes('container stop --time 30'));
            assert.ok(outerStop >= 0 && outerStop < events.indexOf('release'));
        }
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
    const stagedSupervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        discover: () => owned(identity),
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
        runner: {
            run(command, args) { events.push(`run:${args.join(' ')}`); },
            query() { return { ok: true, stdout: '' }; },
        },
        reconcile: async () => ({
            ownership: owned(identity),
            hostPort: 8080,
            mediaHostPort: 7882,
            action: 'reused',
        }),
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

    await stagedSupervisor.runStartTransaction(['start', 'Agent', '8080']);

    assert.ok(events.indexOf('lock') < events.indexOf('read-edge-desired'));
    assert.ok(events.indexOf('read-edge-desired') < events.indexOf('stage-edge-desired'));
    assert.ok(events.indexOf('stage-edge-desired') < events.indexOf('start-core'));
    assert.ok(events.indexOf('start-core') < events.indexOf('health'));
    assert.ok(events.indexOf('health') < events.indexOf('release'));
});

test('foreign ownership blocks every lifecycle path with zero engine mutation', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-foreign-matrix-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const identity = buildWorkspaceIdentity(root, { markerFound: false });
    for (const argv of [['status'], ['stop'], ['destroy'], ['start', 'Agent'], ['logs'], ['list']]) {
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
        });
        // Inspect-only verbs report foreign ownership and exit nonzero; every
        // preparing verb still refuses outright.
        if (['status', 'destroy', 'logs'].includes(argv[0])) {
            assert.equal(await invocation, 1, argv.join(' '));
        } else {
            await assert.rejects(invocation, /foreign exact-name resource/, argv.join(' '));
        }
        assert.deepEqual(mutations, [], argv.join(' '));
        assert.equal(fs.existsSync(path.join(root, '.ploinky')), false, argv.join(' '));
    }
});

test('master-key and arbitrary host canaries cannot cross outer or agent boundaries', () => {
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
    const identity = Object.freeze({
        instance: 'ploinky-box-workspace-123456789abc',
        pathHash: '123456789abc',
        workspaceRoot: '/private/workspace',
        anchorPath: '/private/workspace/.ploinky',
        boxDataRoot: '/private/workspace/.ploinky/box',
        dataPaths: Object.freeze({
            dependencies: '/private/workspace/.ploinky/box/dependencies',
            images: '/private/workspace/.ploinky/box/images',
        }),
    });
    const createArgs = containerCreateArgs({
        identity,
        dataFingerprints: {
            dependencies: 'd'.repeat(64),
            images: 'f'.repeat(64),
        },
        imageId: 'b'.repeat(64),
        imageRef: 'docker.io/assistos/ploinky-box:runtime',
        hostPort: 8080,
        repositoryRoot: '/opt/source',
        cidfile: '/private/lock/candidate.cid',
    });
    const execArgs = buildContainerExecArgs('a'.repeat(64), ['status'], {
        hostPort: 8080,
        mediaHostPort: 7882,
    });
    for (const canary of Object.values(host).filter((value) => /CANARY/.test(value))) {
        assert.equal(JSON.stringify(engineEnvironment).includes(canary), false);
        assert.equal(JSON.stringify(createArgs).includes(canary), false);
        assert.equal(JSON.stringify(execArgs).includes(canary), false);
    }
    const agentEnvironment = { SAFE: 'yes', ...host };
    stripReservedAgentEnv(agentEnvironment);
    assert.equal(agentEnvironment.PLOINKY_MASTER_KEY, undefined);
});

test('managed workspace key is removed from Router inheritance and is never logged', () => {
    const workspaceUtil = fs.readFileSync(path.join(
        import.meta.dirname, '../../cli/commands/workspaceUtil.js',
    ), 'utf8');
    const watchdog = fs.readFileSync(path.join(
        import.meta.dirname, '../../cli/server/Watchdog.js',
    ), 'utf8');
    assert.match(workspaceUtil, /env:\s*\{\s*\.\.\.buildRouterEnv\(\),/);
    assert.match(workspaceUtil, /sanitizeManagedMasterKeyEnvironment/);
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
    assert.deepEqual(fromChild.dataPaths, initial.dataPaths);
    assert.equal(fromChild.volumes, undefined);
});
