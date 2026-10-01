import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_IMAGE_REFERENCE, BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import {
    createHardwareGateStore,
    formatLimitsStatus,
    parseHardwareGateValue,
    readLimitsStatus,
    selectHardwareGate,
} from '../../ploinky-box/hardwareLimitsGate.mjs';
import {
    beginDowngradeBarrier,
    hardwareStorePaths,
    initializeStore,
    setAgentLimits,
} from '../../cli/sandbox/hardwareLimits/store.mjs';
import {
    agentLibFixture,
    agentLibFixtureEnv,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';

function fixture(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-gate-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    const home = path.join(root, 'home');
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    fs.mkdirSync(home);
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    return { root, workspace, home, identity, gateStore: createHardwareGateStore({ homeDirectory: home }) };
}

function fakeLockManager(root, events) {
    let acquisitions = 0;
    return {
        get acquisitions() { return acquisitions; },
        async acquire(instance) {
            acquisitions += 1;
            const lockPath = fs.mkdtempSync(path.join(root, 'lock-'));
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

function lockFor(identity) {
    return { assertHeld: (instance) => assert.equal(instance, identity.instance) };
}

function owned(identity, { running = true, id = 'a'.repeat(64), labels = {} } = {}) {
    const agentLib = agentLibFixture(identity.workspaceRoot);
    return {
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: {
                id,
                labels: { ...agentLibFixtureLabels(agentLib), [BOX_LABELS.imageRef]: BOX_IMAGE_REFERENCE, ...labels },
                runtime: { running, imageId: 'b'.repeat(64), mounts: agentLibFixtureMounts(agentLib, identity.workspaceRoot) },
            },
        },
    };
}

// A start supervisor whose every mutation is recorded. Reconciliation is the
// first Box mutation, so "no mutation" means no reconcile/start event.
function startSupervisor(state, { env = {}, events = [] } = {}) {
    const ownership = owned(state.identity);
    const agentLib = agentLibFixture(state.identity.workspaceRoot);
    const supervisor = createBoxSupervisor({
        env,
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        selectAgentLib: async () => { events.push('select-agentlib'); return { selection: agentLib, mode: 'local' }; },
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        platform: 'linux',
        runner: { run(_command, args) { events.push(`run:${args[0]}`); } },
        reconcile: async () => {
            events.push('reconcile');
            return { action: 'reused', ownership, hostPort: 8080, mediaHostPort: 7882 };
        },
        readEdgeDesired: () => null,
        resolveHostReachableIpv4: async () => '192.168.1.12',
        startCore: async () => { events.push('start-core'); },
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        hardwareGateStore: state.gateStore,
        stderr: { write: (text) => events.push(`stderr:${text.trim()}`) },
    });
    return { supervisor, events };
}

function storePaths(state) {
    return hardwareStorePaths({ identity: state.identity, homeDirectory: state.home });
}

function storeWithEntry(state) {
    const paths = storePaths(state);
    const { token } = initializeStore({ paths, identity: state.identity });
    setAgentLimits({
        paths, identity: state.identity, expectedToken: token, agentRef: 'demo/agent', limits: { cpus: 2 },
        installedRefs: new Set(['demo/agent']), capabilities: { gate: 'on', controllers: ['cpu', 'memory', 'pids'] },
        envelope: { cpus: 8, memoryBytes: 16 * 1024 ** 3 },
    });
    return paths;
}

test('G.parse', () => {
    for (const value of [undefined, null, '', '   ']) assert.equal(parseHardwareGateValue(value), undefined);
    for (const value of ['on', 'ON', ' On ', '1', 'true', 'TRUE']) assert.equal(parseHardwareGateValue(value), true);
    for (const value of ['off', 'Off', '0', 'false', ' FALSE ']) assert.equal(parseHardwareGateValue(value), false);
    for (const value of ['yes', 'enabled', '2', 'onn']) {
        assert.throws(() => parseHardwareGateValue(value), (error) => error.code === 'PLOINKY_BOX_HARDWARE_GATE_INVALID'
            && /No change was made/.test(error.message));
    }
});

test('G.omitted-persists', async (t) => {
    const state = fixture(t);
    const { supervisor } = startSupervisor(state, { env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' } });
    await supervisor.runStartTransaction(['start', 'explorer']);
    assert.equal(state.gateStore.read(state.identity).enabled, true, 'an explicit on is saved after success');
    // A later start without the variable keeps the saved gate.
    const later = selectHardwareGate({ identity: state.identity, gateStore: state.gateStore, env: {}, operation: 'start' });
    assert.equal(later.enabled, true);
    assert.equal(later.source, 'saved');
    assert.equal(later.persist, false);
    // Only start/restart/update apply the variable; others report it ignored.
    const bind = selectHardwareGate({ identity: state.identity, gateStore: state.gateStore, env: { PLOINKY_BOX_HARDWARE_LIMITS: 'off' }, operation: 'bind' });
    assert.equal(bind.enabled, true);
    assert.match(bind.note, /only start, restart and update apply it/);
});

test('G.invalid-no-mutation', async (t) => {
    const state = fixture(t);
    const { supervisor, events } = startSupervisor(state, { env: { PLOINKY_BOX_HARDWARE_LIMITS: 'maybe' } });
    await assert.rejects(supervisor.runStartTransaction(['start', 'explorer']), { code: 'PLOINKY_BOX_HARDWARE_GATE_INVALID' });
    assert.deepEqual(events.filter((event) => event !== 'lock' && event !== 'release'), [], 'nothing ran before the parse failure');
    assert.equal(state.gateStore.read(state.identity), null);
});

test('G.u9-nonempty-no-mutation', async (t) => {
    const state = fixture(t);
    const paths = storeWithEntry(state);
    const before = fs.readFileSync(paths.policyPath, 'utf8');
    const { supervisor, events } = startSupervisor(state, { env: { PLOINKY_BOX_HARDWARE_LIMITS: 'off' } });
    await assert.rejects(supervisor.runRestartTransaction(['restart']), (error) => {
        assert.equal(error.code, 'PLOINKY_BOX_HARDWARE_LIMITS_STORED');
        assert.equal(error.message, '1 agents have stored hardware limits. Turn the gate on with PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart, or run ploinky limits clear --agent REPO/AGENT or ploinky limits clear --all on the host. No Box mutation was performed.');
        return true;
    });
    assert.equal(events.includes('reconcile'), false);
    assert.equal(events.includes('start-core'), false);
    assert.equal(fs.readFileSync(paths.policyPath, 'utf8'), before, 'the store is unchanged');
    assert.equal(state.gateStore.read(state.identity), null, 'the gate is not persisted');
});

test('G.u9-corrupt-not-empty', async (t) => {
    const state = fixture(t);
    const paths = storePaths(state);
    initializeStore({ paths, identity: state.identity });
    fs.writeFileSync(paths.policyPath, '{corrupt', { mode: 0o600 });
    const { supervisor, events } = startSupervisor(state);
    await assert.rejects(supervisor.runStartTransaction(['start', 'explorer']), (error) => (
        error.code === 'PLOINKY_BOX_HARDWARE_STATE_INVALID' && /cannot be read safely/.test(error.message)
    ));
    assert.equal(events.includes('reconcile'), false, 'an unreadable store is never treated as empty');
});

function status(state, overrides = {}) {
    return formatLimitsStatus(readLimitsStatus({
        identity: state.identity, gateStore: state.gateStore, env: {}, ...overrides,
    }));
}

test('G.status-on', (t) => {
    const state = fixture(t);
    state.gateStore.write(state.identity, true, lockFor(state.identity), { now: () => new Date('2026-10-01T12:00:00.000Z') });
    storeWithEntry(state);
    const text = status(state, { observedBox: { state: 'running', wiring: 'f'.repeat(64), prepared: true } });
    assert.match(text, new RegExp(`^Workspace identity: ${state.identity.instance}\\n`));
    assert.match(text, /\nHardware limits: on \(saved 2026-10-01T12:00:00\.000Z\)\n/);
    assert.match(text, /\nHardware state: initialized\n/);
    assert.match(text, /\nBox: running; wiring ffffffffffff; prepared yes\n/);
    assert.match(text, /\nBox mount: cgroup2 unknown; rw unknown; nsdelegate unknown\n/, 'the host never invents in-Box facts');
    assert.match(text, /\nGPU sharing: best-effort, not a security boundary; daemon not started\n/);
    assert.match(text, /\nAgent: demo\/agent \[not enabled\] alias none; cpu 2; RAM declared \(none\); GPU none\n/);
});

test('G.status-off', (t) => {
    const state = fixture(t);
    state.gateStore.write(state.identity, false, lockFor(state.identity), { now: () => new Date('2026-10-01T12:00:00.000Z') });
    const text = status(state, { env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' } });
    assert.match(text, /\nHardware limits: off \(saved 2026-10-01T12:00:00\.000Z\)\n/);
    assert.match(text, /\nNote: PLOINKY_BOX_HARDWARE_LIMITS=on is set; only start, restart and update apply it\n/);
    assert.match(text, /\nHardware state: legacy\n/);
});

test('G.status-absent', (t) => {
    const state = fixture(t);
    const text = status(state);
    assert.match(text, /\nHardware limits: off \(never set\)\n/);
    assert.match(text, /\nBox: absent; wiring none; prepared no: the Box is not running\n/);
    assert.equal(fs.existsSync(storePaths(state).storeRoot), false, 'status never initializes the store');
    assert.equal(text.includes('Note:'), false);
});

test('G.status-unprepared', (t) => {
    const state = fixture(t);
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    initializeStore({ paths: storePaths(state), identity: state.identity });
    const text = status(state, { observedBox: { state: 'running', wiring: null, prepared: false, preparedReason: 'nsdelegate is missing' } });
    assert.match(text, /\nBox: running; wiring none; prepared no: nsdelegate is missing\n/);
});

test('G.status-transition', (t) => {
    const state = fixture(t);
    const paths = storePaths(state);
    const { token } = initializeStore({ paths, identity: state.identity });
    const operationId = '9'.repeat(32);
    beginDowngradeBarrier({ paths, identity: state.identity, operationId, expectedEmptyToken: token });
    const text = status(state);
    assert.match(text, new RegExp(`\\nTransition: gate-on to gate-off ${operationId}, barrier-installed; recovery Run ploinky restart on the host to complete recovery\\.\\n`));
    assert.ok(fs.existsSync(paths.barrierPath), 'status reports the pending downgrade without mutating it');
});

test('G.status-refused-blocked', (t) => {
    const state = fixture(t);
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    storeWithEntry(state);
    const text = status(state, {
        agentInstances: [
            { ref: 'demo/agent', key: 'ploinky_demo_agent_ws', alias: null, availability: 'refused: The host does not delegate cpu to rootless Podman.', limitsState: 'unavailable', fix: 'Apply the delegation commands, then run ploinky restart.' },
            { ref: 'demo/agent', key: 'ploinky_demo_agent_blue_ws', alias: 'blue', availability: 'blocked by ploinky_root_ws: memory controller unavailable', limitsState: 'pending' },
        ],
    });
    assert.match(text, /\nAgent: demo\/agent \[ploinky_demo_agent_ws\] alias none; cpu 2; RAM declared \(none\); GPU none\n  Availability: refused: The host does not delegate cpu to rootless Podman\.\n  Limits: unavailable\n  Fix: Apply the delegation commands, then run ploinky restart\.\n/);
    assert.match(text, /\nAgent: demo\/agent \[ploinky_demo_agent_blue_ws\] alias blue; .*\n  Availability: blocked by ploinky_root_ws: memory controller unavailable\n  Limits: pending\n/);
});

// ---------------------------------------------------------------------------
// P1.2: wiring, U16 generic routing, targeted restart and every generation

import { containerCreateArgs } from '../../ploinky-box/lifecycle/container.mjs';
import { validateContainerConfiguration } from '../../ploinky-box/contract/container.mjs';
import {
    hardwareWiringCreateArgs,
    observeContainerHardwareWiring,
    resolveDesiredHardwareWiring,
    sameHardwareWiring,
} from '../../ploinky-box/hardwareLimitsGate.mjs';
import {
    BOX_HARDWARE_MARKER_PATH,
    BOX_HARDWARE_STORE_PATH,
    BOX_ROUTER_HEALTH_SOCKET,
    BOX_TMPFS,
    BOX_USERNS,
} from '../../ploinky-box/constants.mjs';
import { IMAGE_CONTRACT } from '../../ploinky-box/contract/image.mjs';
import {
    nestedPodmanSeccompProfileContract,
    nestedPodmanSeccompProfilePath,
} from '../../ploinky-box/seccomp.mjs';

const INBOX_READY = JSON.stringify({ state: 'running', initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: 1, warnings: [] });

function genericSupervisor(state, { running = true, initialized = true, absent = false, events = [] } = {}) {
    const ownership = absent ? { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: {} } : owned(state.identity, { running });
    const supervisor = createBoxSupervisor({
        env: {},
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            run(_command, args) { events.push(`run:${args[0]}`); },
            query() { return { ok: true, status: 0, stdout: initialized ? INBOX_READY : '{}' }; },
        },
        selectAgentLib: async () => { events.push('select-agentlib'); return { selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }; },
        reconcile: async () => {
            events.push('reconcile');
            return { action: 'created', ownership: owned(state.identity), hostPort: 8080, mediaHostPort: 7882 };
        },
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: state.gateStore,
        stderr: { write: (text) => events.push(`stderr:${text.trim()}`) },
    });
    return { supervisor, events };
}

test('G.generic-never-enabled-cli-creates-starts', async (t) => {
    const state = fixture(t);
    const { supervisor, events } = genericSupervisor(state, { absent: true });
    await supervisor.prepareBoxForCommand();
    assert.ok(events.includes('reconcile'), 'a never-enabled workspace still creates and starts the Box');
    assert.ok(events.includes('run:container'), 'dependencies are installed in the created Box');
    assert.equal(fs.existsSync(storePaths(state).storeRoot), false, 'no hardware state is created');
});

test('G.generic-saved-off-absent-legacy', async (t) => {
    const state = fixture(t);
    state.gateStore.write(state.identity, false, lockFor(state.identity));
    const { supervisor, events } = genericSupervisor(state, { absent: true });
    await supervisor.prepareBoxForCommand();
    assert.ok(events.includes('reconcile'), 'a saved off record alone keeps legacy behavior');
});

test('G.generic-saved-on-inspect', async (t) => {
    const state = fixture(t);
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    const { supervisor, events } = genericSupervisor(state);
    const adopted = await supervisor.prepareBoxForCommand();
    assert.equal(adopted.action, 'adopted');
    assert.equal(events.includes('reconcile'), false, 'never reconciles, creates or replaces');
    const stopped = genericSupervisor(state, { running: false });
    await assert.rejects(stopped.supervisor.prepareBoxForCommand(), { code: 'PLOINKY_BOX_HARDWARE_INSPECT_ONLY' });
    assert.equal(stopped.events.includes('reconcile'), false);
});

test('G.generic-initialized-empty-inspect', async (t) => {
    const state = fixture(t);
    initializeStore({ paths: storePaths(state), identity: state.identity });
    const { supervisor, events } = genericSupervisor(state, { running: false });
    await assert.rejects(supervisor.prepareBoxForCommand(), (error) => error.code === 'PLOINKY_BOX_HARDWARE_INSPECT_ONLY'
        && /Run ploinky start on the host first/.test(error.message));
    assert.equal(events.includes('reconcile'), false);
});

test('G.generic-nonempty-inspect', async (t) => {
    const state = fixture(t);
    storeWithEntry(state);
    const { supervisor, events } = genericSupervisor(state, { absent: true });
    await assert.rejects(supervisor.prepareBoxForCommand(), { code: 'PLOINKY_BOX_HARDWARE_INSPECT_ONLY' });
    assert.equal(events.includes('reconcile'), false);
});

test('G.generic-unknown-refuses', async (t) => {
    const state = fixture(t);
    fs.mkdirSync(state.gateStore.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(state.gateStore.recordPath(state.identity), '{corrupt', { mode: 0o600 });
    const { supervisor, events } = genericSupervisor(state, { absent: true });
    await assert.rejects(supervisor.prepareBoxForCommand(), (error) => error.code === 'PLOINKY_BOX_HARDWARE_INSPECT_ONLY'
        && /saved gate is unreadable/.test(error.message));
    assert.equal(events.includes('reconcile'), false, 'unknown metadata is never treated as never-enabled');
});

function createArgsFor(state, extra = {}) {
    const agentLib = agentLibFixture(state.identity.workspaceRoot);
    return containerCreateArgs({
        identity: state.identity,
        dataFingerprints: { dependencies: 'd'.repeat(64), images: 'e'.repeat(64) },
        agentLib,
        imageId: `sha256:${'b'.repeat(64)}`,
        imageRef: BOX_IMAGE_REFERENCE,
        hostPort: 8080,
        repositoryRoot: path.resolve(import.meta.dirname, '../..'),
        cidfile: path.join(state.root, 'x.cid'),
        ...extra,
    });
}

test('G.off-byte-identical', (t) => {
    const state = fixture(t);
    const baseline = createArgsFor(state);
    assert.deepEqual(createArgsFor(state, { hardware: null }), baseline, 'gate off adds nothing');
    assert.equal(baseline.some((arg) => String(arg).startsWith(`${BOX_LABELS.hardwareLimits}=`)
        || String(arg).includes(BOX_HARDWARE_MARKER_PATH) || String(arg).includes(BOX_HARDWARE_STORE_PATH)), false);
    const wiring = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    const enabled = createArgsFor(state, { hardware: wiring });
    assert.equal(enabled.length - baseline.length, 6, 'exactly one label and two binds');
    assert.ok(enabled.includes(`${wiring.markerPath}:${BOX_HARDWARE_MARKER_PATH}:ro`));
    assert.ok(enabled.includes(`${wiring.storeRoot}:${BOX_HARDWARE_STORE_PATH}`));
    assert.ok(enabled.includes(`${BOX_LABELS.hardwareLimits}=${wiring.fingerprint}`));
});

function handleWith(state, wiring, { markerRw = false, storeRw = true, label = true, mounts = true } = {}) {
    const labels = label ? { [BOX_LABELS.hardwareLimits]: wiring.fingerprint } : {};
    const runtimeMounts = mounts ? [
        { destination: BOX_HARDWARE_MARKER_PATH, source: wiring.markerPath, type: 'bind', rw: markerRw },
        { destination: BOX_HARDWARE_STORE_PATH, source: wiring.storeRoot, type: 'bind', rw: storeRw },
    ] : [];
    return { labels, runtime: { mounts: runtimeMounts } };
}

test('G.bind-contract', (t) => {
    const state = fixture(t);
    const wiring = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    const observed = observeContainerHardwareWiring(handleWith(state, wiring), { identity: state.identity, homeDirectory: state.home });
    assert.equal(observed.fingerprint, wiring.fingerprint);
    assert.equal(observeContainerHardwareWiring({ labels: {}, runtime: { mounts: [] } }), null, 'gate off has no wiring');
    for (const [description, handle] of [
        ['writable marker', handleWith(state, wiring, { markerRw: true })],
        ['read-only store', handleWith(state, wiring, { storeRw: false })],
        ['label without binds', handleWith(state, wiring, { mounts: false })],
        ['binds without label', handleWith(state, wiring, { label: false })],
    ]) {
        assert.throws(() => observeContainerHardwareWiring(handle, { identity: state.identity, homeDirectory: state.home }),
            { code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE' }, description);
    }
    // The complete Box contract accepts exactly the wiring and rejects it,
    // or any variant, without the matching expectation.
    const box = completeBoxFixture(state);
    const withWiring = completeHandle(box, wiring);
    assert.doesNotThrow(() => validateContainerConfiguration(withWiring, boxDesired(box, wiring)));
    assert.throws(() => validateContainerConfiguration(withWiring, boxDesired(box, null)), /label set is incompatible/);
    assert.throws(() => validateContainerConfiguration(completeHandle(box, null), boxDesired(box, wiring)), /incompatible/);
    const writableMarker = completeHandle(box, wiring);
    writableMarker.runtime.mounts.find((mount) => mount.destination === BOX_HARDWARE_MARKER_PATH).rw = true;
    assert.throws(() => validateContainerConfiguration(writableMarker, boxDesired(box, wiring)), /incompatible/);
    const extra = completeHandle(box, wiring);
    extra.runtime.mounts.push({ type: 'bind', name: '', source: box.root, destination: '/run/ploinky/extra', rw: true });
    assert.throws(() => validateContainerConfiguration(extra, boxDesired(box, wiring)), /mount set is incompatible/);
    assert.doesNotThrow(() => validateContainerConfiguration(completeHandle(box, null), boxDesired(box, null)),
        'a gate-off Box with no hardware wiring stays valid');
});

// A complete owned-Box handle, shaped like ploinkyBoxGpuGrant's fixture.
function completeBoxFixture(state) {
    const root = path.join(state.root, 'repository');
    const seccomp = nestedPodmanSeccompProfilePath(root);
    fs.mkdirSync(path.dirname(seccomp), { recursive: true });
    fs.copyFileSync(new URL('../../ploinky-box/seccomp/podman-nested-pid-fallback.json', import.meta.url), seccomp);
    return { ...state, root, agentLib: agentLibFixture(state.identity.workspaceRoot) };
}

function completeHandle(box, hardware) {
    const id = 'e'.repeat(64);
    const imageId = 'd'.repeat(64);
    return {
        id,
        labels: {
            ...agentLibFixtureLabels(box.agentLib),
            [BOX_LABELS.pathHash]: box.identity.pathHash,
            [BOX_LABELS.role]: 'box',
            [BOX_LABELS.imageRef]: BOX_IMAGE_REFERENCE,
            [BOX_LABELS.routerHostPort]: '8090',
            [BOX_LABELS.mediaHostPort]: '7882',
            [BOX_LABELS.seccompFingerprint]: nestedPodmanSeccompProfileContract(box.root).fingerprint,
            [BOX_LABELS.dependenciesFingerprint]: 'd'.repeat(64),
            [BOX_LABELS.imagesFingerprint]: 'f'.repeat(64),
            ...(hardware ? { [BOX_LABELS.hardwareLimits]: hardware.fingerprint } : {}),
        },
        runtime: {
            complete: true,
            imageId,
            configuredImage: imageId,
            user: 'podman',
            workingDir: box.identity.workspaceRoot,
            createCommand: ['podman', 'container', 'create', '--init', '--userns', BOX_USERNS,
                '--device', '/dev/fuse', '--device', '/dev/net/tun',
                '--tmpfs', `${BOX_TMPFS.destination}:${BOX_TMPFS.options.join(',')}`],
            environment: {
                ...IMAGE_CONTRACT.environment,
                PLOINKY_WORKSPACE_ROOT: box.identity.workspaceRoot,
                ...agentLibFixtureEnv(box.agentLib),
                PLOINKY_PRIVATE_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_BIND: '0.0.0.0',
                PLOINKY_PUBLIC_AUTHORITY: '127.0.0.1:8090',
                PLOINKY_ROUTER_HEALTH_SOCKET: BOX_ROUTER_HEALTH_SOCKET,
                HOSTNAME: id.slice(0, 12),
            },
            publications: [
                { containerPort: '7882', protocol: 'udp', hostIp: '0.0.0.0', hostPort: '7882' },
                { containerPort: '8080', protocol: 'tcp', hostIp: '127.0.0.1', hostPort: '8090' },
            ],
            running: true,
            status: 'running',
            init: true,
            usernsMode: 'private',
            privileged: false,
            securityOptions: ['label=disable', 'unmask=ALL', `seccomp=${nestedPodmanSeccompProfilePath(box.root)}`],
            devices: [],
            tmpfs: [{ destination: BOX_TMPFS.destination, options: [...BOX_TMPFS.options.filter((option) => option !== 'notmpcopyup'), 'rprivate'].sort() }],
            mounts: [
                { type: 'bind', name: '', source: box.identity.dataPaths.images, destination: '/home/podman/.local/share/ploinky-images', rw: true },
                { type: 'bind', name: '', source: box.root, destination: '/opt/ploinky', rw: false },
                { type: 'bind', name: '', source: box.identity.dataPaths.dependencies, destination: '/opt/ploinky/node_modules', rw: true },
                { type: 'bind', name: '', source: box.identity.workspaceRoot, destination: box.identity.workspaceRoot, rw: true },
                ...agentLibFixtureMounts(box.agentLib, box.identity.workspaceRoot),
                ...(hardware ? hardware.mounts.map((mount) => ({ type: 'bind', name: '', source: mount.source, destination: mount.destination, rw: mount.rw })) : []),
            ].sort((left, right) => left.destination.localeCompare(right.destination)),
        },
    };
}

function boxDesired(box, hardware) {
    return {
        identity: box.identity,
        dataFingerprints: { dependencies: 'd'.repeat(64), images: 'f'.repeat(64) },
        agentLib: box.agentLib,
        hostPort: 8090,
        imageId: 'd'.repeat(64),
        imageRef: BOX_IMAGE_REFERENCE,
        repositoryRoot: box.root,
        gpu: null,
        hardware,
    };
}

test('G.store-directory-replaced', (t) => {
    const state = fixture(t);
    const first = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    const again = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    assert.equal(sameHardwareWiring(first, again), true, 'an unchanged store keeps the wiring and the Box');
    // Atomic replacement of limits.json inside the same directory is normal.
    const paths = storePaths(state);
    const document = fs.readFileSync(paths.policyPath, 'utf8');
    fs.writeFileSync(`${paths.policyPath}.tmp`, document, { mode: 0o600 });
    fs.renameSync(`${paths.policyPath}.tmp`, paths.policyPath);
    assert.equal(resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore }).fingerprint, first.fingerprint);
    // Replacing the directory itself is a Box replacement reason.
    const moved = `${paths.storeRoot}.old`;
    fs.renameSync(paths.storeRoot, moved);
    fs.cpSync(moved, paths.storeRoot, { recursive: true });
    fs.chmodSync(paths.storeRoot, 0o700);
    const replaced = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    assert.equal(sameHardwareWiring(first, replaced), false);
});

test('G.targeted-gate-change', async (t) => {
    const state = fixture(t);
    const events = [];
    const ownership = owned(state.identity);
    let reconciledHardware;
    const supervisor = createBoxSupervisor({
        env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' },
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(_c, args) { events.push(`run:${args[0]}`); }, query() { return { ok: true, status: 0, stdout: INBOX_READY }; } },
        selectAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }),
        reconcile: async (options) => {
            reconciledHardware = options.hardware;
            events.push('reconcile');
            return { action: 'replaced', ownership, hostPort: 8080, mediaHostPort: 7882, hardware: options.hardware };
        },
        runCoreCommand: async (_engine, _id, argv) => { events.push(`core:${argv.join(' ')}`); },
        resolveHostReachableIpv4: async () => '127.0.0.1',
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: state.gateStore,
        prepareHardwareGeneration: async () => { events.push('prepare'); return { structurallyPrepared: true }; },
        stderr: { write: (text) => events.push(`stderr:${text.trim()}`) },
    });
    await supervisor.runTargetedRestartTransaction(['restart', 'onlyOffice']);
    assert.ok(events.some((event) => /changes the Box hardware-limits gate; reconciling the outer Box, so the whole workspace graph restarts/.test(event)));
    assert.ok(events.includes('reconcile'));
    assert.ok(reconciledHardware?.fingerprint, 'the reconciled Box receives the gate-on wiring');
    assert.ok(events.includes('core:restart'), 'the whole graph restarts');
    assert.equal(state.gateStore.read(state.identity).enabled, true);
});

test('G.every-final-generation', async (t) => {
    const state = fixture(t);
    for (const [operation, invoke] of [
        ['start', (supervisor) => supervisor.runStartTransaction(['start', 'explorer'])],
        ['restart', (supervisor) => supervisor.runRestartTransaction(['restart'])],
    ]) {
        const events = [];
        const ownership = owned(state.identity);
        const supervisor = createBoxSupervisor({
            env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' },
            resolveIdentity: () => state.identity,
            launchCwd: state.identity.workspaceRoot,
            lockManager: fakeLockManager(state.root, events),
            discover: () => ownership,
            runner: { run(_c, args) { events.push(`run:${args[0]}`); } },
            selectAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }),
            reconcile: async (options) => ({ action: 'replaced', ownership, hostPort: 8080, mediaHostPort: 7882, hardware: options.hardware }),
            readEdgeDesired: () => null,
            startCore: async () => { events.push('graph'); },
            runCoreCommand: async () => { events.push('graph'); },
            resolveHostReachableIpv4: async () => '127.0.0.1',
            healthCheck: async () => {},
            revalidateAgentLibSource: () => {},
            commitAgentLibSelection: () => {},
            hardwareGateStore: state.gateStore,
            prepareHardwareGeneration: async ({ containerId, hardware }) => {
                events.push(`prepare:${containerId}:${hardware.fingerprint.slice(0, 8)}`);
                return { structurallyPrepared: true };
            },
        });
        await invoke(supervisor);
        const prepare = events.findIndex((event) => event.startsWith('prepare:'));
        assert.ok(prepare >= 0, `${operation} prepares its gate-on generation`);
        assert.ok(prepare < events.indexOf('graph'), `${operation} prepares before graph work`);
    }
});
