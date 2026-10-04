// Offline world for the LIVE-C5 driver (liveStoreTransition.mjs): the product's REAL supervisor, outer CLI, downgrade transaction, store and
// barrier, over a stub container engine behind the supervisor's process runner. The stub is only the engine: it models the container table, the
// stop/remove/create/start verbs and the in-Box status, the Router's administrator route (the product's own store functions behind the barrier
// check the route makes) and the reviewed store program, all SYNCHRONOUSLY, as the production runner is. Nothing starts a container.
//
// It is also an executable. `node c5DriverWorld.mjs SCENARIO` builds a standalone world in a private scratch directory, runs the driver over it and
// prints one JSON document; a test runs it as a child, optionally under a source mutation (c5Mutation.mjs), so the product modules it loads are the
// mutated ones. Test-only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BOX_IMAGE_REFERENCE, BOX_LABELS, BOX_ROUTER_HEALTH_SOCKET, BOX_TMPFS, BOX_USERNS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import { createHardwareGateStore, resolveDesiredHardwareWiring } from '../../ploinky-box/hardwareLimitsGate.mjs';
import { writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import { nestedPodmanSeccompProfileContract, nestedPodmanSeccompProfilePath } from '../../ploinky-box/seccomp.mjs';
import { createTransitionStore } from '../../ploinky-box/hardwareLimitsTransition.mjs';
import {
    HardwareStoreError, assertPolicyWritesAllowed, clearAgentLimits, hardwareStorePaths, initializeStore, readBarrier, readStoreSnapshot, setAgentLimits,
} from '../../cli/sandbox/hardwareLimits/store.mjs';
import {
    agentLibFixture, agentLibFixtureEnv, agentLibFixtureLabels, agentLibFixtureMounts, boxImageIdFixtureEnv,
} from '../helpers/agentlibFixture.mjs';
import { fakeRestartCore, fakeUpdateCore } from '../helpers/fakeUpdateCore.mjs';
import { ADMIN_REQUEST } from './liveGpuCommands.mjs';
import { BOX_PRODUCT_ROOT, STORE_PROGRAM } from './liveStoreCommands.mjs';
import { FIXTURE_REPOSITORY } from './liveFixture.mjs';
import { evaluateTemplate, fakeEngineInfo, inspectModel } from './fakeLiveEngine.mjs';
import { C5_INTENT_KIND, createC5Intent, exactContainerHandle, productEngineDigest, readPrivateC5File } from './liveBoxTransitionCustody.mjs';
import { DRIVER_BOUNDS, driverParams, runDriver } from './liveStoreTransition.mjs';
import { describeMutation } from './c5Mutation.mjs';
import { INSPECT, OWNER_MARKER, engineIdentityDigest, jsonDigest, liveSourceDigest } from './liveCommon.mjs';

export const REPOSITORY = fs.realpathSync(new URL('../..', import.meta.url).pathname);
const AGENT_REF = `${FIXTURE_REPOSITORY}/s`;
const ENVELOPE = Object.freeze({ memoryBytes: 8 * 1024 ** 3, cpus: 4 });
const ENGINE_HOST = Object.freeze({ arch: 'test', os: 'linux', hostname: 'fake-engine', id: 'engine-1' });
const hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');

// ---- the Box as the product's own contract validators see it (shaped like the gate tests' fixture) ----
export function completeBoxFixture({ root, identity, linkProduct = true }) {
    const seccomp = nestedPodmanSeccompProfilePath(root);
    const profile = fs.readFileSync(new URL('../../ploinky-box/seccomp/podman-nested-pid-fallback.json', import.meta.url));
    fs.mkdirSync(path.dirname(seccomp), { recursive: true });
    // A source tree that already carries the profile (a frozen fixture source) is left byte for byte as it is.
    if (!fs.existsSync(seccomp) || !fs.readFileSync(seccomp).equals(profile)) fs.writeFileSync(seccomp, profile);
    // The host store program loads the product's own modules from this root.
    if (linkProduct && !fs.existsSync(path.join(root, 'cli'))) fs.symlinkSync(path.join(REPOSITORY, 'cli'), path.join(root, 'cli'));
    return { root, identity, agentLib: agentLibFixture(identity.workspaceRoot) };
}

export function completeHandle(box, hardware, { id = 'e'.repeat(64), imageId = 'd'.repeat(64), running = true, hostPort = 8090, mediaHostPort = 7882, imageRef = BOX_IMAGE_REFERENCE } = {}) {
    return {
        kind: 'container', engine: 'podman', engineIdentity: 'engine', name: box.identity.instance, pathHash: box.identity.pathHash,
        id,
        labels: {
            ...agentLibFixtureLabels(box.agentLib),
            [BOX_LABELS.pathHash]: box.identity.pathHash,
            [BOX_LABELS.role]: 'box',
            [BOX_LABELS.imageRef]: imageRef,
            [BOX_LABELS.routerHostPort]: String(hostPort),
            [BOX_LABELS.mediaHostPort]: String(mediaHostPort),
            [BOX_LABELS.seccompFingerprint]: nestedPodmanSeccompProfileContract(box.root).fingerprint,
            [BOX_LABELS.dependenciesFingerprint]: 'd'.repeat(64),
            [BOX_LABELS.imagesFingerprint]: 'f'.repeat(64),
            ...(hardware ? { [BOX_LABELS.hardwareLimits]: hardware.fingerprint } : {}),
        },
        runtime: {
            complete: true, imageId, configuredImage: imageId, user: 'podman', workingDir: box.identity.workspaceRoot,
            networkMode: '',
            createCommand: ['podman', 'container', 'create', '--init', '--userns', BOX_USERNS, '--device', '/dev/fuse', '--device', '/dev/net/tun',
                '--tmpfs', `${BOX_TMPFS.destination}:${BOX_TMPFS.options.join(',')}`],
            environment: {
                ...IMAGE_CONTRACT.environment,
                PLOINKY_WORKSPACE_ROOT: box.identity.workspaceRoot,
                ...agentLibFixtureEnv(box.agentLib),
                ...boxImageIdFixtureEnv(imageId),
                PLOINKY_PRIVATE_BIND: '0.0.0.0', PLOINKY_PUBLIC_BIND: '0.0.0.0', PLOINKY_PUBLIC_AUTHORITY: `127.0.0.1:${hostPort}`,
                PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET, HOSTNAME: id.slice(0, 12),
            },
            publications: [
                { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: String(mediaHostPort) },
                { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: String(hostPort) },
            ],
            running, status: running ? 'running' : 'exited', init: true, usernsMode: 'private', privileged: false,
            securityOptions: ['label=disable', 'unmask=ALL', `seccomp=${nestedPodmanSeccompProfilePath(box.root)}`],
            devices: [],
            tmpfs: [{ destination: BOX_TMPFS.destination, options: [...BOX_TMPFS.options.filter(option => option !== 'notmpcopyup'), 'rprivate'].sort() }],
            mounts: [
                { type: 'bind', name: '', source: box.identity.dataPaths.images, destination: '/home/podman/.local/share/ploinky-images', rw: true },
                { type: 'bind', name: '', source: box.root, destination: '/opt/ploinky', rw: false },
                { type: 'bind', name: '', source: box.identity.dataPaths.dependencies, destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: box.identity.workspaceRoot, destination: box.identity.workspaceRoot, rw: true },
                ...agentLibFixtureMounts(box.agentLib, box.identity.workspaceRoot),
                ...(hardware ? hardware.mounts.map(mount => ({ type: 'bind', name: '', source: mount.source, destination: mount.destination, rw: mount.rw })) : []),
            ].sort((left, right) => left.destination.localeCompare(right.destination)),
        },
    };
}

// The inverse of the product's normalizeContainerRuntime: a full `container inspect` document that normalizes back to this handle. Test-only
// glue, so the PRODUCT's own validators judge a generation the fake engine reports.
export function rawInspectFromHandle(handle, { created = '2026-10-04T00:00:00.000000000Z' } = {}) {
    const runtime = handle.runtime;
    return {
        Id: handle.id, Name: `/${handle.name}`, Created: created, Image: runtime.imageId,
        Config: {
            Labels: { ...handle.labels }, Image: runtime.configuredImage, User: runtime.user, WorkingDir: runtime.workingDir,
            Env: Object.entries(runtime.environment).map(([key, value]) => `${key}=${value}`), CreateCommand: [...runtime.createCommand],
        },
        HostConfig: {
            NetworkMode: runtime.networkMode, Init: runtime.init, UsernsMode: runtime.usernsMode, Privileged: runtime.privileged, SecurityOpt: [...runtime.securityOptions],
            Devices: runtime.devices.map(device => ({ PathOnHost: device.hostPath, PathInContainer: device.containerPath, CgroupPermissions: device.permissions })),
            Tmpfs: Object.fromEntries(runtime.tmpfs.map(entry => [entry.destination, entry.options.join(',')])),
            PortBindings: runtime.publications.reduce((all, publication) => {
                (all[`${publication.containerPort}/${publication.protocol}`] ||= []).push({ HostIp: publication.hostIp, HostPort: publication.hostPort });
                return all;
            }, {}),
        },
        State: { Running: runtime.running, Status: runtime.status },
        Mounts: runtime.mounts.map(mount => ({ Type: mount.type, Name: mount.name, Source: mount.source, Destination: mount.destination, RW: mount.rw })),
    };
}

// The record the fake engine and the go-template inspect render for a handle.
export function engineRecordFromHandle(handle, { created }) {
    const raw = rawInspectFromHandle(handle, { created });
    return {
        id: handle.id, name: handle.name, created, image: handle.runtime.imageId, labels: raw.Config.Labels, running: handle.runtime.running,
        mounts: raw.Mounts, portBindings: raw.HostConfig.PortBindings,
    };
}

// ---- the world ----

// A workspace this world owns, with the harness's owner marker, so the harness's own workspace proofs hold over it.
export function createWorkspace(root, runId) {
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.writeFileSync(path.join(workspace, OWNER_MARKER), runId, { mode: 0o600 });
    const stat = fs.lstatSync(workspace);
    return { path: fs.realpathSync(workspace), uid: stat.uid, dev: String(stat.dev), ino: String(stat.ino), marker: runId };
}

export function createDowngradeWorld({
    root, workspace, home, identity: givenIdentity = null, runId, boxId = 'e'.repeat(64), created = '2026-10-04T00:00:00.000000000Z', boxRunning = true, graphRunning = true,
    faults = {}, engineHost = ENGINE_HOST, hostPort = 8090, mediaHostPort = 7882, repositoryRoot = null, linkProduct = true, imageRef = BOX_IMAGE_REFERENCE, killAt = null, reuseState = null,
} = {}) {
    fs.mkdirSync(root, { recursive: true });
    const identity = givenIdentity ?? buildWorkspaceIdentity(workspace.path);
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const gateStore = createHardwareGateStore({ homeDirectory: home });
    const lockFor = { assertHeld: instance => { if (instance !== identity.instance) throw new Error('lock instance'); } };
    if (!reuseState) gateStore.write(identity, true, lockFor);
    const wiring = resolveDesiredHardwareWiring({ identity, enabled: true, homeDirectory: home, initializeStore });
    const boxRoot = repositoryRoot ?? path.join(root, 'repository');
    fs.mkdirSync(boxRoot, { recursive: true });
    const box = completeBoxFixture({ root: boxRoot, identity, linkProduct });
    if (!reuseState) writeGraphSkillScope(identity, buildHostSkillScope(identity.workspaceRoot, identity.workspaceRoot), lockFor);
    const info = fakeEngineInfo(engineHost);
    const engine = { name: 'podman', identity: productEngineDigest(info), hostKind: 'native-linux' };
    const containers = new Map();
    const events = [];
    const old = completeHandle(box, wiring, { id: boxId, running: boxRunning, hostPort, mediaHostPort, imageRef });
    old.engineIdentity = engine.identity;
    if (!reuseState) containers.set(old.id, { handle: old, created, graphRunning: boxRunning && graphRunning, logs: '' });
    // A world reloaded after a crash holds the containers the dead process left, rebuilt from their inspect documents.
    for (const entry of reuseState?.containers ?? []) {
        const frozen = exactContainerHandle(entry.raw, entry.id, engine.identity);
        // The product's normalizer freezes the runtime; the stub engine moves a container between running and stopped.
        const handle = { ...frozen, labels: { ...frozen.labels }, runtime: { ...frozen.runtime } };
        containers.set(entry.id, { handle, created: entry.created, graphRunning: entry.graphRunning, logs: '' });
    }
    // A crash test ends the process at a named point, after persisting what the process had done (the durable product records are on disk already).
    const persistState = () => fs.writeFileSync(path.join(root, 'world_state.json'), JSON.stringify({
        containers: [...containers].map(([id, entry]) => ({ id, created: entry.created, graphRunning: entry.graphRunning, raw: rawInspectFromHandle(entry.handle, { created: entry.created }) })), events,
    }));
    const die = () => { persistState(); process.kill(process.pid, 'SIGKILL'); };
    const onStep = name => { if (killAt === `step:${name}`) die(); };
    const paths = hardwareStorePaths({ identity, homeDirectory: home });
    const adminCalls = [];
    let createFailed = false;

    const current = () => [...containers.values()][0] || null;
    const ownership = () => (current()
        ? { state: 'owned', engine, handles: { container: current().handle } }
        : { state: 'absent', engine, handles: {} });

    // The Router's administrator route: the product's own store functions behind the barrier check the route makes.
    function admin(method, bodyText) {
        adminCalls.push({ method, body: bodyText });
        if (method === 'GET') return { status: 200, text: JSON.stringify({ ok: true, token: readStoreSnapshot({ paths, identity }).token, agents: [] }) };
        let body;
        try { body = JSON.parse(bodyText); } catch { return { status: 400, text: JSON.stringify({ ok: false, error: 'invalid_json' }) }; }
        try {
            if (!faults.routerIgnoresBarrier) assertPolicyWritesAllowed({ paths });
            const common = { paths, identity, expectedToken: body.expectedToken, agentRef: body.agentRef, actor: { id: 'local:admin', name: 'admin' }, lockOptions: { deadlineMs: 250 }, beforeCommit: () => true };
            const result = body.action === 'set_agent_limits'
                ? setAgentLimits({ ...common, limits: body.limits, installedRefs: new Set([AGENT_REF]), capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'] }, envelope: ENVELOPE })
                : body.action === 'clear_agent_limits' ? clearAgentLimits(common) : null;
            if (!result) return { status: 400, text: JSON.stringify({ ok: false, error: 'unknown_action' }) };
            return { status: 200, text: JSON.stringify({ ok: true, token: result.token, committed: result.committed, agents: [] }) };
        } catch (error) {
            return { status: Number.isInteger(error?.status) ? error.status : 503, text: JSON.stringify({ ok: false, error: String(error?.code || 'error'), message: String(error?.message || error).slice(0, 400), ...(error?.committed === true ? { committed: true } : {}) }) };
        }
    }
    // The reviewed store program, for real and synchronously, with the Box's roots rewritten to this world's.
    function storeProgram(args) {
        const at = args.length - 1;
        const params = JSON.parse(args[at]);
        if (params.domain === 'box') { params.root = REPOSITORY; params.storeRoot = paths.storeRoot; }
        const words = [...args.slice(args.indexOf('--input-type=module'), at), JSON.stringify(params)];
        const result = spawnSync(process.execPath, words, { cwd: identity.workspaceRoot, env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp' }, encoding: 'utf8' });
        return { ok: result.status === 0, status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, error: null, signal: result.signal };
    }

    const running = id => containers.get(id)?.handle.runtime.running === true;
    const kindOf = args => (args.includes('/opt/ploinky/bin/ploinky-local') ? 'graph-stop' : args[0] === 'container' && args[1] === 'stop' ? 'box-stop' : args[0] === 'container' && args[1] === 'rm' ? 'box-remove'
        : args.includes('--cidfile') ? 'box-create' : args[0] === 'container' && args[1] === 'start' ? 'box-start' : null);
    const runner = {
        run(_command, args) {
            const id = args[args.length - 1];
            const kind = kindOf(args);
            if (kind && killAt === `${kind}:before`) die();
            const result = runner.perform(id, args);
            if (kind) persistState();
            if (kind && killAt === `${kind}:after`) die();
            return result;
        },
        perform(id, args) {
            if (faults.failFirstGateOffCreate && args.includes('--cidfile') && !createFailed && !args.some(arg => String(arg).startsWith(`${BOX_LABELS.hardwareLimits}=`))) {
                createFailed = true;
                throw Object.assign(new Error('injected engine failure: container create'), { code: 'EINJECTED' });
            }
            if (args[0] === 'container' && args[1] === 'stop') {
                const entry = containers.get(id);
                entry.handle.runtime.running = false; entry.handle.runtime.status = 'exited'; entry.graphRunning = false;
                events.push('box-stop');
            } else if (args[0] === 'container' && args[1] === 'rm') {
                containers.delete(id);
                events.push('box-remove');
            } else if (args[0] === 'container' && args[1] === 'start') {
                const entry = containers.get(id);
                entry.handle.runtime.running = true; entry.handle.runtime.status = 'running';
                entry.logs += '2026-10-01T12:00:00.000000000Z PLOINKY_BOX_READY\n';
                events.push('box-start');
            } else if (args.includes('/opt/ploinky/bin/ploinky-local') && args.includes('stop')) {
                containers.get(args[args.indexOf('/opt/ploinky/bin/ploinky-local') - 1]).graphRunning = false;
                events.push('graph-stop');
            } else if (args.includes('--cidfile')) {
                const newId = faults.createdId ?? crypto.randomBytes(32).toString('hex');
                fs.writeFileSync(args[args.indexOf('--cidfile') + 1], `${newId}\n`);
                const gateOn = args.some(arg => String(arg).startsWith(`${BOX_LABELS.hardwareLimits}=`));
                const handle = completeHandle(box, gateOn ? wiring : null, { id: newId, running: false, hostPort, mediaHostPort, imageRef });
                handle.engineIdentity = engine.identity;
                containers.set(newId, { handle, created: `2026-10-04T00:00:${String(containers.size + 10).padStart(2, '0')}.000000000Z`, graphRunning: false, logs: '' });
                events.push(`box-create:${gateOn ? 'gate-on' : 'gate-off'}`);
            }
            return Buffer.from('');
        },
        query(command, args, options = {}) {
            const id = args[args.length - 1];
            const ok = (stdout = '') => ({ ok: true, status: 0, stdout, stderr: '', error: null, signal: null });
            if (args[0] === 'info') return ok(JSON.stringify(info));
            if (args[0] === 'container' && args[1] === 'inspect' && args.includes('--format') && args[args.indexOf('--format') + 1] === INSPECT) {
                const entry = containers.get(id);
                if (!entry) return { ok: false, status: 125, stdout: '', stderr: 'no such container', error: null, signal: null };
                const rendered = evaluateTemplate(INSPECT, 'inspect', inspectModel(engineRecordFromHandle(entry.handle, { created: entry.created })));
                return ok(rendered);
            }
            if (args[0] === 'container' && args[1] === 'exec' && args.includes('node') && (args.includes(ADMIN_REQUEST) || args.includes(STORE_PROGRAM))) {
                const target = args[args.indexOf('--user') + 2];
                if (!running(target)) return { ok: false, status: 125, stdout: '', stderr: 'Error: container is not running', error: null, signal: null };
                if (args.includes(ADMIN_REQUEST)) {
                    const at = args.indexOf(ADMIN_REQUEST);
                    return ok(JSON.stringify(admin(args[at + 1], args[at + 2])));
                }
                return storeProgram(args);
            }
            if (args[0] === 'container' && args[1] === 'logs') return ok(containers.get(id)?.logs || '');
            if (args[0] === 'container' && args[1] === 'inspect' && args.includes('{{.State.Status}}')) return ok(containers.get(id)?.handle.runtime.running ? 'running\n' : 'exited\n');
            if (args.includes('/opt/ploinky/ploinky-box/inbox/readStatus.mjs')) {
                const entry = containers.get(args[args.indexOf('/usr/local/bin/node') - 1]);
                if (!entry?.handle.runtime.running) return { ok: false, status: 1, stdout: '', stderr: '', error: null, signal: null };
                return ok(JSON.stringify({ state: 'running', initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: entry.graphRunning ? 1 : 0, warnings: [] }));
            }
            return ok('');
        },
        stream() { return Promise.resolve({ ok: true, status: 0, stdout: '', stderr: '', error: null, signal: null }); },
    };

    function lockManager() {
        return {
            async acquire(instance) {
                const lockPath = fs.mkdtempSync(path.join(root, 'lock-'));
                let released = false;
                return { path: lockPath, assertHeld(expected) { if (released || expected !== instance) throw new Error('lock not held'); }, release() { released = true; } };
            },
        };
    }
    // The real supervisor over the stub runner it is given (the driver passes its decorated production runner).
    function makeSupervisor(decorated) {
        return createBoxSupervisor({
            env: { PLOINKY_BOX_HARDWARE_LIMITS: 'off' }, resolveIdentity: () => identity, launchCwd: identity.workspaceRoot, repositoryRoot: box.root,
            lockManager: lockManager(), discover: () => ownership(), runner: decorated,
            selectAgentLib: async () => ({ selection: box.agentLib, mode: 'local' }),
            reconcile: async () => ({ action: 'reused', ownership: ownership(), hostPort, mediaHostPort, hardware: null }),
            captureCoreStartArgv: () => ['start', 'explorer', String(hostPort)],
            readEdgeDesired: () => null, resolveHostReachableIpv4: async () => '192.168.1.12',
            runCoreCommand: async (_engine, containerId, argv) => { const entry = containers.get(containerId); entry.graphRunning = true; events.push(`core:${argv.join(' ')}`); },
            runRestartCore: fakeRestartCore(async (_engine, containerId, argv) => { const entry = containers.get(containerId); entry.graphRunning = true; events.push(`core:${argv.join(' ')}`); }),
            runUpdateCore: fakeUpdateCore({ onCall: () => {} }),
            startCore: async () => { events.push('start-core'); }, healthCheck: async () => {}, revalidateAgentLibSource: () => {}, commitAgentLibSelection: () => {},
            validateExistingImage: () => ({ immutableId: `sha256:${'d'.repeat(64)}` }), validateContainer: () => {},
            hardwareGateStore: gateStore, prepareHardwareGeneration: async () => { events.push('prepare'); return { structurallyPrepared: true }; },
            stdout: { write() { return true; } }, stderr: { write: text => { events.push(`stderr:${String(text).trim().slice(0, 120)}`); return true; } },
        });
    }
    return {
        root, identity, home, box, wiring, engine, info, containers, events, adminCalls, paths, gateStore, runner, makeSupervisor, admin, running,
        boxId, created, hostPort, mediaHostPort, restoreHome: () => { process.env.HOME = previousHome; },
        // The product resolves host state from HOME; an in-process caller sets it only while the world runs.
        async withHome(fn) { const before = process.env.HOME; process.env.HOME = home; try { return await fn(); } finally { process.env.HOME = before; } },
        engineIdentityDigest: engineIdentityDigest(info, null), oldHandle: old, onStep, persistState,
        transitionIds: () => createTransitionStore({ identity, homeDirectory: home }).listPending().map(journal => journal.operationId),
    };
}

// The profile the harness would hold over this world.
export function worldProfile(world, { runId, workspace, sourceDigest = liveSourceDigest(world.box.root) }) {
    const record = engineRecordFromHandle(world.oldHandle, { created: world.created });
    return {
        cases: ['LIVE-C5'], host: { home: world.home }, workspace, source: { root: world.box.root, digest: sourceDigest },
        engine: { identityDigest: world.engineIdentityDigest },
        box: { id: world.boxId, created: world.created, image: world.oldHandle.runtime.imageId, contractDigest: jsonDigest({ labels: record.labels, mounts: record.mounts }),
            pathHash: world.identity.pathHash, instance: world.identity.instance },
    };
}

// ---- standalone scenarios ----

// The world a crashed scenario left behind, reloaded in THIS process: the durable product records on disk and the containers the dead process had.
export function reloadWorld(root, { faults = {} } = {}) {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'world_meta.json'), 'utf8'));
    const reuseState = JSON.parse(fs.readFileSync(path.join(root, 'world_state.json'), 'utf8'));
    const world = createDowngradeWorld({ root, workspace: meta.workspace, home: meta.home, runId: meta.runId, boxId: meta.profile.box.id, created: meta.profile.box.created,
        hostPort: meta.hostPort, mediaHostPort: meta.mediaHostPort, linkProduct: false, faults, reuseState });
    world.restoreHome();
    return { meta, world, profile: meta.profile };
}

export function standalone(scenarioOptions = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.C5_WORLD_TMP || os.tmpdir(), 'c5w-')));
    const runId = crypto.randomBytes(16).toString('hex');
    const workspace = createWorkspace(root, runId);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const world = createDowngradeWorld({ root, workspace, home, runId, linkProduct: false, ...scenarioOptions });
    const profile = worldProfile(world, { runId, workspace });
    const run = { runId, operations: [], ownedBoxes: [], target: { execution: profile } };
    return { root, runId, workspace, home, world, profile, run };
}

export function intentFor(context, { priorTransitionIds = [] } = {}) {
    const { run, profile, runId } = context;
    return createC5Intent({ run, profile, driverReceiptName: `c5-transition-driver-${'1'.repeat(32)}`, argvDigest: jsonDigest(['node', 'driver', runId]), priorTransitionIds, invocationId: '1'.repeat(32) });
}

export async function runScenario(name, options = {}) {
    const context = standalone(options.world ?? {});
    const { world, run } = context;
    // Test controls: a profile whose pinned engine digest is wrong, a recorded stamp that is not the store's.
    const profile = options.engineDigestOverride ? { ...context.profile, engine: { identityDigest: options.engineDigestOverride } } : context.profile;
    context.profile = profile;
    const receiptPath = path.join(context.root, `c5-transition-driver-${'1'.repeat(32)}_claude.json`);
    const token = readStoreSnapshot({ paths: world.paths, identity: world.identity }).token;
    const bounds = { ...DRIVER_BOUNDS, ...(options.bounds ?? {}) };
    let params;
    if (name === 'transition') {
        params = driverParams({ mode: 'transition', profile, run, intent: intentFor(context), receiptPath, expectedToken: { epoch: token.epoch, revision: token.revision + (options.tokenRevisionOffset ?? 0) }, agentRef: AGENT_REF, bounds });
    } else if (name === 'prepared') {
        // The world exactly as the harness leaves it after it wrote the invocation intent and before any driver ran.
        fs.writeFileSync(path.join(context.root, 'world_meta.json'), JSON.stringify({ runId: context.runId, root: context.root, home: context.home, workspace: context.workspace, profile, run: { runId: context.runId },
            intent: intentFor(context), receiptPath, mode: name, hostPort: world.hostPort, mediaHostPort: world.mediaHostPort }));
        world.persistState();
        return { scenario: name, root: context.root, boxId: world.boxId, exitCode: 0, summary: { events: [] }, containers: [], store: {}, transitions: [], adminCalls: [], engineEvents: [] };
    } else if (name === 'writer-first') {
        const set = world.admin('POST', JSON.stringify({ action: 'set_agent_limits', expectedToken: token, agentRef: AGENT_REF, limits: { memoryPercent: 10 } }));
        if (JSON.parse(set.text).committed !== true) throw new Error('the writer-first policy was not committed');
        params = driverParams({ mode: 'writer-first', profile, run, agentRef: AGENT_REF, bounds });
    } else if (name === 'destroy') {
        params = driverParams({ mode: 'destroy', profile, run, expectedContainerId: options.expectedContainerId === undefined ? world.boxId : options.expectedContainerId, bounds });
    } else throw new Error(`unknown scenario ${name}`);
    const before = { ids: [...world.containers.keys()], transitions: world.transitionIds(), adminCalls: world.adminCalls.length };
    // Meta for a test that reloads this world after a crash: everything the harness would hold about it.
    fs.writeFileSync(path.join(context.root, 'world_meta.json'), JSON.stringify({ runId: context.runId, root: context.root, home: context.home, workspace: context.workspace, profile, run: { runId: context.runId },
        intent: params.intent, receiptPath, mode: name, hostPort: world.hostPort, mediaHostPort: world.mediaHostPort }));
    world.persistState();
    const result = await runDriver(params, { baseRunner: world.runner, supervisor: world.makeSupervisor, programRoot: REPOSITORY, onStep: world.onStep });
    let receipt = null;
    if (name === 'transition') receipt = readPrivateC5File(receiptPath);
    const after = readStoreSnapshot({ paths: world.paths, identity: world.identity });
    return {
        scenario: name, exitCode: result.exitCode, summary: result.summary, receipt, root: context.root, boxId: world.boxId,
        engineEvents: world.events, containers: [...world.containers.entries()].map(([id, entry]) => ({ id, running: entry.handle.runtime.running, gateOn: Boolean(entry.handle.labels[BOX_LABELS.hardwareLimits]) })),
        gate: world.gateStore.read(world.identity)?.enabled ?? null, store: { token: after.token, count: after.agents.size, barrier: readBarrier({ paths: world.paths }) },
        before, adminCalls: world.adminCalls, transitions: createTransitionStore({ identity: world.identity, homeDirectory: world.home }).listPending().map(journal => ({ id: journal.operationId, phase: journal.phase })),
        intentKind: C5_INTENT_KIND,
        mutation: process.env.C5_MUTATION ? describeMutation(JSON.parse(process.env.C5_MUTATION)) : null,
    };
}

const invoked = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
    const [scenario, optionsText] = process.argv.slice(2);
    const options = optionsText ? JSON.parse(optionsText) : {};
    // Fault functions cannot cross a process boundary; named faults are interpreted here.
    options.world = { ...(options.world ?? {}), faults: { ...(options.faults ?? {}) } };
    let result;
    try { result = await runScenario(scenario, options); }
    catch (error) { result = { scenario, crashed: { message: String(error?.message || error).slice(0, 600), stack: String(error?.stack || '').slice(0, 1200) } }; }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
}

export { HardwareStoreError, hex };
