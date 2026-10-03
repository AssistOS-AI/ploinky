import crypto from 'node:crypto';
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
    boxImageIdFixtureEnv,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';
import { fakeRestartCore, fakeUpdateCore } from '../helpers/fakeUpdateCore.mjs';

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
                runtime: { running, status: running ? 'running' : 'exited', imageId: 'b'.repeat(64), mounts: agentLibFixtureMounts(agentLib, identity.workspaceRoot) },
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
    const notObserved = '\\(in-Box facts are not observed from the host\\)';
    assert.match(text, new RegExp(`\\nBox mount: cgroup2 unknown ${notObserved}; rw unknown ${notObserved}; nsdelegate unknown ${notObserved}\\n`), 'the host never invents in-Box facts');
    assert.match(text, /\nHost delegation: unknown \(the host engine was not queried\)\n/);
    assert.match(text, /\nGPU sharing: best-effort, not a security boundary; daemon unknown \(in-Box facts are not observed from the host\)\n/);
    // No instance was observed: the stored policy only, no invented key/availability.
    assert.match(text, /\nAgent: demo\/agent \(stored policy; instances not observed from the host\); cpu 2; RAM declared; GPU none\n/);
    assert.doesNotMatch(text, /not enabled|Availability: stopped|Limits: pending/);
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
    const text = status(state, { observedBox: { state: 'absent', wiring: null, prepared: false, preparedReason: 'no Box exists' } });
    assert.match(text, /\nHardware limits: off \(never set\)\n/);
    assert.match(text, /\nBox: absent; wiring none; prepared no: no Box exists\n/);
    assert.match(status(state), /\nBox: unknown \(the Box was not inspected\)\n/);
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
    assert.match(text, /\nAgent: demo\/agent \[ploinky_demo_agent_ws\] alias none; cpu 2; RAM declared \(unknown \(not observed\)\); GPU none\n  Availability: refused: The host does not delegate cpu to rootless Podman\.\n  Limits: unavailable\n  Fix: Apply the delegation commands, then run ploinky restart\.\n/);
    assert.match(text, /\nAgent: demo\/agent \[ploinky_demo_agent_blue_ws\] alias blue; .*\n  Availability: blocked by ploinky_root_ws: memory controller unavailable\n  Limits: pending\n/);
});

test('G.status-production-observed', (t) => {
    // F2: the production inspectLimitsStatus path, a running gate-on Box and
    // one stored entry. Only observed facts are printed; the host's own
    // read-only engine and exact-Box runtime checks are included.
    const state = fixture(t);
    state.gateStore.write(state.identity, true, lockFor(state.identity), { now: () => new Date('2026-10-01T12:00:00.000Z') });
    storeWithEntry(state);
    const ownership = owned(state.identity, { labels: { [BOX_LABELS.hardwareLimits]: 'e'.repeat(64) } });
    const queries = [];
    const runs = [];
    const supervisor = (boxRuntime) => createBoxSupervisor({
        env: {},
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        discover: () => ownership,
        runner: {
            run(_command, args) { runs.push(args.join(' ')); },
            query(_command, args) {
                queries.push(args.join(' '));
                if (args[0] === 'info') {
                    return { ok: true, stdout: JSON.stringify({ host: { cgroupVersion: 'v2', ociRuntime: { name: 'crun' }, cgroupControllers: ['cpu', 'memory', 'pids'] } }) };
                }
                if (args[0] === 'container' && args[1] === 'inspect') return { ok: true, stdout: `${boxRuntime}\n` };
                return { ok: false, stdout: '' };
            },
        },
        hardwareGateStore: state.gateStore,
    });
    const text = formatLimitsStatus(supervisor('/usr/bin/crun').inspectLimitsStatus());
    assert.match(text, /\nHardware limits: on \(saved 2026-10-01T12:00:00\.000Z\)\n/);
    assert.match(text, /\nHost delegation: cgroup v2; outer OCI runtime crun; Box OCI runtime crun \(verified\); controllers cpu memory pids\n/);
    assert.match(text, /\nBox: running; wiring eeeeeeeeeeee; prepared unknown \(in-Box preparation is not observed from the host\)\n/);
    assert.match(text, /\nNested backend: unknown \(in-Box facts are not observed from the host\); manager unknown/);
    assert.match(text, /\nInternal helpers: unknown \(in-Box facts are not observed from the host\)\n/);
    assert.match(text, /\nAgent: demo\/agent \(stored policy; instances not observed from the host\); cpu 2; RAM declared; GPU none\n$/);
    assert.doesNotMatch(text, /not enabled|Availability|Limits: pending|daemon not started|prepared yes|prepared no/);
    // A Box recorded with another runtime is reported as unverified.
    assert.match(formatLimitsStatus(supervisor('/usr/bin/runc').inspectLimitsStatus()),
        /\nHost delegation: cgroup v2; outer OCI runtime crun; Box OCI runtime unverified \(the Box runs \/usr\/bin\/runc, not crun\); controllers cpu memory pids\n/);
    // Read-only: only engine queries ran; nothing was created, started or prepared.
    assert.deepEqual(runs, []);
    assert.ok(queries.every((query) => query.startsWith('info ') || query.startsWith('container inspect --format {{.OCIRuntime}} ')), queries.join('\n'));
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

test('G.off-byte-identical', async (t) => {
    const state = fixture(t);
    // The gate-off create argv equals the golden captured from the baseline
    // export (tests/hardware-limits/gateOffCreateArgs.mjs), not the candidate
    // compared with itself. The baseline is master 4dae3a99 since the integration
    // merge; the 8d8c4b77 golden is kept as the record of the earlier baseline.
    const golden = JSON.parse(fs.readFileSync(new URL('../fixtures/hardware-limits/gate-off-create-args-4dae3a99.json', import.meta.url), 'utf8'));
    const repository = path.resolve(import.meta.dirname, '../..');
    assert.deepEqual(await normalizedGateOffCreateArgs(repository), golden, 'default (no hardware argument) matches the baseline bytes');
    assert.deepEqual(await normalizedGateOffCreateArgs(repository, { extra: { hardware: null } }), golden, 'gate off matches the baseline bytes');
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
                ...boxImageIdFixtureEnv(imageId),
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
        // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
        runRestartCore: fakeRestartCore(async (_engine, _id, argv) => { events.push(`core:${argv.join(' ')}`); }),
        runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async (_engine, _id, argv) => { events.push(`core:${argv.join(' ')}`); })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
        resolveHostReachableIpv4: async () => '192.168.1.12',
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
    // Every gate-on generation a host operation creates, replaces, restarts
    // or restores is prepared before its graph work. GPU grant, revoke and
    // the internal GPU reapply are covered by G.every-final-generation-gpu.
    const state = fixture(t);
    const previousHome = process.env.HOME;
    process.env.HOME = state.home;
    t.after(() => { process.env.HOME = previousHome; });
    writeGraphSkillScope(state.identity, buildHostSkillScope(state.identity.workspaceRoot, state.identity.workspaceRoot), lockFor(state.identity));
    const graphEvents = new Set(['graph', 'start-core']);
    const supervisorFor = (events, { ownership = owned(state.identity), env = { PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, reconcile } = {}) => createBoxSupervisor({
        env,
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: {
            run(_c, args) { events.push(`run:${args[0]}`); },
            query() { return { ok: true, status: 0, stdout: INBOX_READY }; },
        },
        selectAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }),
        updateAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), changed: false, previous: null }),
        updateWorkspacePloinky: async () => ({ found: false }),
        reconcile: reconcile || (async (options) => ({ action: 'replaced', ownership: owned(state.identity, { id: 'f'.repeat(64) }), hostPort: 8080, mediaHostPort: 7882, hardware: options.hardware })),
        captureCoreStartArgv: () => ['start', 'explorer', '8080'],
        readEdgeDesired: () => null,
        startCore: async () => { events.push('start-core'); },
        runCoreCommand: async (_engine, _id, argv) => { events.push(argv[0] === 'start' && argv.length > 1 ? 'graph' : `core:${argv[0]}`); },
        // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
        runRestartCore: fakeRestartCore(async (_engine, _id, argv) => { events.push(argv[0] === 'start' && argv.length > 1 ? 'graph' : `core:${argv[0]}`); }),
        runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async (_engine, _id, argv) => { events.push(argv[0] === 'start' && argv.length > 1 ? 'graph' : `core:${argv[0]}`); })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
        resolveHostReachableIpv4: async () => '192.168.1.12',
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: state.gateStore,
        prepareHardwareGeneration: async ({ containerId, hardware }) => {
            events.push(`prepare:${containerId.slice(0, 4)}:${hardware.fingerprint.slice(0, 8)}`);
            return { structurallyPrepared: true };
        },
        stdout: { write() { return true; } },
        stderr: { write() { return true; } },
    });
    const preparedBeforeGraph = (events, label, graphMarkers = [...graphEvents, 'core:start', 'core:restart', 'core:update']) => {
        const prepare = events.findIndex((event) => event.startsWith('prepare:'));
        const graph = events.findIndex((event) => graphMarkers.includes(event));
        assert.ok(prepare >= 0, `${label} prepares its gate-on generation: ${events.join(' ')}`);
        assert.ok(graph < 0 || prepare < graph, `${label} prepares before graph work: ${events.join(' ')}`);
    };
    for (const [operation, invoke] of [
        ['start', (supervisor) => supervisor.runStartTransaction(['start', 'explorer'])],
        ['restart', (supervisor) => supervisor.runRestartTransaction(['restart'])],
        ['update', (supervisor) => supervisor.runUpdateTransaction(['update'], { restartAfterUpdate: true })],
    ]) {
        const events = [];
        await invoke(supervisorFor(events));
        preparedBeforeGraph(events, operation);
    }
    // bind creating a Box follows the saved gate (on) and prepares it.
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    const bindEvents = [];
    await supervisorFor(bindEvents, { env: {}, ownership: { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: {} } })
        .runBindTransaction({ address: '127.0.0.1', hostPort: 8080 });
    preparedBeforeGraph(bindEvents, 'bind');
    // Rollback restoration: the replacement's graph fails, the previous
    // gate-on Box is restored, and that restored generation is prepared
    // before its graph is restored.
    const rollbackEvents = [];
    const failing = createBoxSupervisor({
        env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' },
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, rollbackEvents),
        discover: () => owned(state.identity),
        runner: { run(_c, args) { rollbackEvents.push(`run:${args[0]}`); }, query() { return { ok: true, status: 0, stdout: INBOX_READY }; } },
        selectAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }),
        reconcile: async (options) => ({
            action: 'replaced', ownership: owned(state.identity, { id: '1'.repeat(64) }), hostPort: 8080, mediaHostPort: 7882,
            hardware: options.hardware, gpu: null, routerBinding: options.routerBinding, previousAgentLib: options.agentLib,
            async rollback() {
                rollbackEvents.push('outer-rollback');
                return {
                    action: 'restored', containerId: '2'.repeat(64), hostPort: 8080, mediaHostPort: 7882,
                    agentLib: options.agentLib, routerBinding: options.routerBinding, gpu: null, hardware: options.hardware,
                };
            },
        }),
        captureCoreStartArgv: () => ['start', 'explorer', '8080'],
        readEdgeDesired: () => null,
        runCoreCommand: async (_engine, id, argv) => {
            rollbackEvents.push(`core:${id.slice(0, 4)}:${argv.join(' ')}`);
            if (id.startsWith('1111')) throw new Error('candidate graph failed');
        },
        // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
        runRestartCore: fakeRestartCore(async (_engine, id, argv) => {
            rollbackEvents.push(`core:${id.slice(0, 4)}:${argv.join(' ')}`);
            if (id.startsWith('1111')) throw new Error('candidate graph failed');
        }),
        runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async (_engine, id, argv) => {
            rollbackEvents.push(`core:${id.slice(0, 4)}:${argv.join(' ')}`);
            if (id.startsWith('1111')) throw new Error('candidate graph failed');
        })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
        resolveHostReachableIpv4: async () => '192.168.1.12',
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: state.gateStore,
        prepareHardwareGeneration: async ({ containerId }) => {
            rollbackEvents.push(`prepare:${containerId.slice(0, 4)}`);
            return { structurallyPrepared: true };
        },
        stdout: { write() { return true; } },
        stderr: { write() { return true; } },
    });
    await assert.rejects(failing.runRestartTransaction(['restart']), /candidate graph failed/);
    const order = (marker) => rollbackEvents.findIndex((event) => event.startsWith(marker));
    assert.ok(order('prepare:1111') >= 0 && order('prepare:1111') < order('core:1111'), rollbackEvents.join(' '));
    assert.ok(order('outer-rollback') >= 0, rollbackEvents.join(' '));
    assert.ok(order('prepare:2222') > order('outer-rollback'), `the restored generation is prepared: ${rollbackEvents.join(' ')}`);
    assert.ok(order('prepare:2222') < order('core:2222:start explorer 8080'), `prepared before its graph: ${rollbackEvents.join(' ')}`);
    // The restored branch: the failed replacement itself restored the old
    // gate-on Box (boxRollback action 'restored'); that generation is
    // prepared before its graph is restored, through start, restart and update.
    const wiring = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    for (const [operation, invoke] of [
        ['start', (supervisor) => supervisor.runStartTransaction(['start', 'explorer'])],
        ['restart', (supervisor) => supervisor.runRestartTransaction(['restart'])],
        ['update', (supervisor) => supervisor.runUpdateTransaction(['update'], { restartAfterUpdate: true })],
    ]) {
        const events = [];
        const supervisor = createBoxSupervisor({
            env: { PLOINKY_BOX_HARDWARE_LIMITS: 'on' },
            resolveIdentity: () => state.identity,
            launchCwd: state.identity.workspaceRoot,
            lockManager: fakeLockManager(state.root, events),
            discover: () => owned(state.identity),
            runner: { run() {}, query() { return { ok: true, status: 0, stdout: INBOX_READY }; } },
            selectAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }),
            updateAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), changed: false, previous: null }),
            updateWorkspacePloinky: async () => ({ found: false }),
            reconcile: async (options) => {
                const error = new Error('candidate start failed; the old Box was restored');
                error.boxRollback = Object.freeze({
                    action: 'restored', containerId: '3'.repeat(64), oldStopAttempted: true, previouslyRunning: true,
                    hostPort: 8080, mediaHostPort: 7882, routerBinding: options.routerBinding, gpu: null,
                    hardware: wiring, agentLib: options.agentLib,
                });
                throw error;
            },
            captureCoreStartArgv: () => ['start', 'explorer', '8080'],
            readEdgeDesired: () => null,
            runCoreCommand: async (_engine, id, argv) => { events.push(`core:${id.slice(0, 4)}:${argv.join(' ')}`); },
            // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
            runRestartCore: fakeRestartCore(async (_engine, id, argv) => { events.push(`core:${id.slice(0, 4)}:${argv.join(' ')}`); }),
            runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async (_engine, id, argv) => { events.push(`core:${id.slice(0, 4)}:${argv.join(' ')}`); })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
            resolveHostReachableIpv4: async () => '192.168.1.12',
            healthCheck: async () => {},
            revalidateAgentLibSource: () => {},
            commitAgentLibSelection: () => {},
            hardwareGateStore: state.gateStore,
            prepareHardwareGeneration: async ({ containerId }) => { events.push(`prepare:${containerId.slice(0, 4)}`); return { structurallyPrepared: true }; },
            stdout: { write() { return true; } },
            stderr: { write() { return true; } },
        });
        await assert.rejects(invoke(supervisor), /the old Box was restored/, operation);
        const prepare = events.indexOf('prepare:3333');
        const graph = events.indexOf('core:3333:start explorer 8080');
        assert.ok(prepare >= 0, `${operation}: the restored generation is prepared: ${events.join(' ')}`);
        assert.ok(graph > prepare, `${operation}: prepared before its graph: ${events.join(' ')}`);
    }
});

// ---------------------------------------------------------------------------
// Fix round 1: outer-path ordering (V1), pending downgrades (F5), stale store
// locks on the U9 path (F4) and the real downgrade effects (R7).

const { runOuterCli } = await import('../../ploinky-box/bin/ploinky-box.mjs');
const { normalizedGateOffCreateArgs } = await import('../hardware-limits/gateOffCreateArgs.mjs');
const {
    SimulatedProcessDeath,
    createTransitionStore,
    runHardwareDowngrade,
} = await import('../../ploinky-box/hardwareLimitsTransition.mjs');
const { spawnSync } = await import('node:child_process');
const { writeGraphSkillScope } = await import('../../ploinky-box/graphSkillScope.mjs');
const { buildHostSkillScope } = await import('../../ploinky-box/skillScope.mjs');

function sink() {
    let value = '';
    return { write(chunk) { value += chunk; return true; }, value: () => value };
}

function realSupervisor(state, { env = {}, events = [], ownership = owned(state.identity), reconciled = owned(state.identity) } = {}) {
    return createBoxSupervisor({
        env,
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership,
        runner: { run(_command, args) { events.push(`run:${args.slice(0, 2).join(' ')}`); }, query() { return { ok: true, status: 0, stdout: INBOX_READY }; } },
        selectAgentLib: async () => { events.push('select-agentlib'); return { selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }; },
        reconcile: async (options) => { events.push('reconcile'); return { action: 'reused', ownership: reconciled, hostPort: 8080, mediaHostPort: 7882, hardware: options.hardware }; },
        readEdgeDesired: () => null,
        resolveHostReachableIpv4: async () => '192.168.1.12',
        startCore: async () => { events.push('start-core'); },
        runCoreCommand: async () => { events.push('core'); },
        // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
        runRestartCore: fakeRestartCore(async () => { events.push('core'); }),
        runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async () => { events.push('core'); })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: state.gateStore,
        prepareHardwareGeneration: async () => { events.push('prepare'); return { structurallyPrepared: true }; },
        stderr: { write: (text) => events.push(`stderr:${text.trim()}`) },
    });
}

test('G.update-gate-before-host-source', async (t) => {
    for (const [label, setup, env, pattern] of [
        ['invalid gate value', () => {}, { PLOINKY_BOX_HARDWARE_LIMITS: 'maybe' }, /must be on, off, 1, 0, true or false/],
        ['stored entry with the gate off', (state) => storeWithEntry(state), { PLOINKY_BOX_HARDWARE_LIMITS: 'off' }, /1 agents have stored hardware limits/],
        ['stored entry with the saved gate off', (state) => {
            state.gateStore.write(state.identity, false, lockFor(state.identity));
            storeWithEntry(state);
        }, {}, /1 agents have stored hardware limits/],
    ]) {
        const state = fixture(t);
        setup(state);
        const events = [];
        const hostUpdates = [];
        await assert.rejects(runOuterCli(['update'], {
            env, input: {}, output: sink(), errorOutput: sink(), cwd: () => state.identity.workspaceRoot,
            supervisor: realSupervisor(state, { env, events }), detectInsideBox: () => false,
            updateHostSource: async (options) => { hostUpdates.push(options); return { updated: true }; },
            relaunch: () => { hostUpdates.push('relaunch'); return 0; },
        }), pattern, label);
        assert.deepEqual(hostUpdates, [], `${label}: the host source was never updated or relaunched`);
        assert.equal(events.includes('reconcile'), false, `${label}: no Box mutation`);
    }
});

// A pending gate-on to gate-off journal left by an interrupted process.
async function pendingDowngrade(state) {
    const paths = storePaths(state);
    initializeStore({ paths, identity: state.identity });
    const config = { image: 'img@sha256:1', hostPort: 8080, hardware: { fingerprint: 'a'.repeat(64) } };
    await assert.rejects(runHardwareDowngrade({
        identity: state.identity,
        operation: 'restart',
        oldContainerId: 'c'.repeat(64),
        oldConfiguration: config,
        desiredConfiguration: { ...config, hardware: null },
        graphSnapshot: { schema: 1, coreArgv: ['start', 'explorer', '8080'] },
        oldWasRunning: true,
        oldGraphRunning: true,
        hostRecords: [{ name: 'gate', old: true, next: false }],
        homeDirectory: state.home,
        effects: { engineIdentity: 'engine', hostKind: 'native-linux', inspectBox: () => null, stopGraph() {}, stopBox() {} },
        faults: { 'outer-stop.after': 'process-death' },
    }), SimulatedProcessDeath);
    const pending = createTransitionStore({ identity: state.identity, homeDirectory: state.home }).listPending();
    assert.equal(pending.length, 1);
    return pending[0];
}

test('G.pending-downgrade-blocks-bind-grant-revoke', async (t) => {
    for (const [label, invoke] of [
        ['bind', (supervisor) => supervisor.runBindTransaction({ address: '127.0.0.1', hostPort: 8080 })],
        ['gpu grant', (supervisor) => supervisor.runGpuGrantTransaction({ agents: ['demo/agent'] })],
        ['gpu revoke', (supervisor) => supervisor.runGpuRevokeTransaction({})],
    ]) {
        const state = fixture(t);
        state.gateStore.write(state.identity, true, lockFor(state.identity));
        await pendingDowngrade(state);
        const events = [];
        await assert.rejects(invoke(realSupervisor(state, { events })), (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_HARDWARE_TRANSITION_PENDING', label);
            assert.match(error.message, new RegExp(`Run ploinky restart on the host to complete recovery, then retry ploinky ${label}\\. No Box mutation was performed\\.$`));
            return true;
        });
        assert.deepEqual(events.filter((event) => event === 'reconcile' || event.startsWith('run:')), [], `${label}: no Box created or changed`);
        assert.equal(createTransitionStore({ identity: state.identity, homeDirectory: state.home }).listPending().length, 1, 'the journal is kept for recovery');
    }
});

test('G.u9-stale-store-lock', async (t) => {
    // F4: the U9 guard of a gate-off start recovers a lock whose same-host
    // holder is dead while the Box is absent; a running Box keeps it.
    const deadLock = (state) => {
        const directory = path.join(storePaths(state).storeRoot, 'write.lock');
        fs.mkdirSync(directory, { mode: 0o700 });
        fs.writeFileSync(path.join(directory, 'owner.json'), `${JSON.stringify({
            token: 'd'.repeat(32), pid: spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid, hostname: os.hostname(),
            domain: 'host', operation: 'crashed-writer', acquiredAt: new Date().toISOString(),
        })}\n`, { mode: 0o600 });
        return directory;
    };
    const absent = (state) => ({ state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: {} });
    const state = fixture(t);
    initializeStore({ paths: storePaths(state), identity: state.identity });
    const directory = deadLock(state);
    const events = [];
    await realSupervisor(state, { events, ownership: absent(state) }).runStartTransaction(['start', 'explorer']);
    assert.ok(events.includes('reconcile'), 'the gate-off start proceeded after recovery');
    assert.equal(fs.existsSync(directory), false);
    // A running Box: never stolen, start refused before any mutation.
    const running = fixture(t);
    initializeStore({ paths: storePaths(running), identity: running.identity });
    const kept = deadLock(running);
    const runningEvents = [];
    await assert.rejects(realSupervisor(running, { events: runningEvents }).runStartTransaction(['start', 'explorer']),
        (error) => error.code === 'PLOINKY_BOX_HARDWARE_STORE_BUSY');
    assert.ok(fs.existsSync(kept));
    assert.equal(runningEvents.includes('reconcile'), false);
});

// A container engine behind a stub runner: the supervisor's real downgrade
// effects (stop, remove, create with a CID receipt, start and wait for the
// ready line, dependency install, graph restore and in-Box status) run
// against it unchanged.
function downgradeWorld(t, { boxRunning, graphRunning }) {
    const state = fixture(t);
    // Box wiring observation resolves host state from the user's home, as in
    // production; point it at this fixture's home.
    const previousHome = process.env.HOME;
    process.env.HOME = state.home;
    t.after(() => { process.env.HOME = previousHome; });
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    const wiring = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    const box = completeBoxFixture(state);
    // The prior start's saved launch scope, as start records it.
    writeGraphSkillScope(state.identity, buildHostSkillScope(state.identity.workspaceRoot, state.identity.workspaceRoot), lockFor(state.identity));
    const engine = { name: 'podman', identity: 'engine', hostKind: 'native-linux' };
    const containers = new Map();
    const old = completeHandle(box, wiring);
    old.runtime.running = boxRunning;
    containers.set(old.id, { handle: old, graphRunning: boxRunning && graphRunning, logs: '' });
    const events = [];
    const current = () => [...containers.values()][0] || null;
    const ownership = () => (current()
        ? { state: 'owned', engine, handles: { container: current().handle } }
        : { state: 'absent', engine, handles: {} });
    const runner = {
        run(_command, args) {
            const id = args[args.length - 1];
            if (args[0] === 'container' && args[1] === 'stop') {
                const entry = containers.get(id);
                entry.handle.runtime.running = false;
                entry.graphRunning = false;
                events.push('box-stop');
            } else if (args[0] === 'container' && args[1] === 'rm') {
                containers.delete(id);
                events.push('box-remove');
            } else if (args[0] === 'container' && args[1] === 'start') {
                const entry = containers.get(id);
                entry.handle.runtime.running = true;
                entry.logs += '2026-10-01T12:00:00.000000000Z PLOINKY_BOX_READY\n';
                events.push('box-start');
            } else if (args.includes('/opt/ploinky/bin/ploinky-local') && args.includes('stop')) {
                containers.get(args[args.indexOf('/opt/ploinky/bin/ploinky-local') - 1]).graphRunning = false;
                events.push('graph-stop');
            } else if (args.includes('--cidfile')) {
                const newId = crypto.randomBytes(32).toString('hex');
                fs.writeFileSync(args[args.indexOf('--cidfile') + 1], `${newId}\n`);
                const handle = completeHandle(box, null);
                handle.id = newId;
                handle.runtime.running = false;
                handle.runtime.environment.HOSTNAME = newId.slice(0, 12);
                containers.set(newId, { handle, graphRunning: false, logs: '' });
                events.push(`box-create:${args.some((arg) => String(arg).startsWith(`${BOX_LABELS.hardwareLimits}=`)) ? 'gate-on' : 'gate-off'}`);
            }
            return { ok: true, status: 0, stdout: '' };
        },
        query(_command, args) {
            const id = args[args.length - 1];
            if (args[0] === 'container' && args[1] === 'logs') return { ok: true, status: 0, stdout: containers.get(id)?.logs || '', stderr: '' };
            if (args[0] === 'container' && args[1] === 'inspect' && args.includes('{{.State.Status}}')) {
                return { ok: true, status: 0, stdout: containers.get(id)?.handle.runtime.running ? 'running\n' : 'exited\n' };
            }
            if (args.includes('/opt/ploinky/ploinky-box/inbox/readStatus.mjs')) {
                const entry = containers.get(args[args.indexOf('/usr/local/bin/node') - 1]);
                if (!entry?.handle.runtime.running) return { ok: false, status: 1, stdout: '' };
                return { ok: true, status: 0, stdout: JSON.stringify({ state: 'running', initialized: true, routingConfigured: true, trackedAgents: 1, runningAgents: entry.graphRunning ? 1 : 0, warnings: [] }) };
            }
            return { ok: true, status: 0, stdout: '' };
        },
    };
    const supervisor = createBoxSupervisor({
        env: { PLOINKY_BOX_HARDWARE_LIMITS: 'off' },
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        repositoryRoot: box.root,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership(),
        runner,
        selectAgentLib: async () => ({ selection: box.agentLib, mode: 'local' }),
        reconcile: async () => ({ action: 'reused', ownership: ownership(), hostPort: 8090, mediaHostPort: 7882, hardware: null }),
        captureCoreStartArgv: () => ['start', 'explorer', '8090'],
        readEdgeDesired: () => null,
        resolveHostReachableIpv4: async () => '192.168.1.12',
        runCoreCommand: async (_engine, id, argv) => {
            const entry = containers.get(id);
            entry.graphRunning = true;
            events.push(`core:${argv.join(' ')}`);
        },
        // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
        runRestartCore: fakeRestartCore(async (_engine, id, argv) => {
            const entry = containers.get(id);
            entry.graphRunning = true;
            events.push(`core:${argv.join(' ')}`);
        }),
        runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async (_engine, id, argv) => {
            const entry = containers.get(id);
            entry.graphRunning = true;
            events.push(`core:${argv.join(' ')}`);
        })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
        startCore: async () => { events.push('start-core'); },
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        validateExistingImage: () => ({ immutableId: `sha256:${'d'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: state.gateStore,
        prepareHardwareGeneration: async () => { events.push('prepare'); return { structurallyPrepared: true }; },
        stdout: { write() { return true; } },
        stderr: { write: (text) => { events.push(`stderr:${text.trim()}`); return true; } },
    });
    return { state, supervisor, events, current };
}

test('G.downgrade-running-graph-restored', async (t) => {
    // R7 through the supervisor's real downgrade effects: the graph was
    // observed running, so it is stopped with the old Box and restored on
    // the gate-off Box before the restart continues.
    const world = downgradeWorld(t, { boxRunning: true, graphRunning: true });
    await world.supervisor.runRestartTransaction(['restart']);
    const create = world.events.indexOf('box-create:gate-off');
    const restore = world.events.indexOf('core:start explorer 8090');
    assert.ok(world.events.indexOf('graph-stop') >= 0 && world.events.indexOf('graph-stop') < create, world.events.join('\n'));
    assert.ok(restore > create, 'the prior graph is restored on the gate-off Box');
    assert.equal(world.state.gateStore.read(world.state.identity).enabled, false);
    const [journal] = createTransitionStore({ identity: world.state.identity, homeDirectory: world.state.home }).listPending();
    assert.equal(journal, undefined, 'the downgrade committed');
});

test('G.downgrade-stopped-graph-not-started', async (t) => {
    // A stopped gate-on Box ran no graph: the downgrade never starts one.
    const world = downgradeWorld(t, { boxRunning: false, graphRunning: false });
    await world.supervisor.runRestartTransaction(['restart']);
    assert.ok(world.events.includes('box-create:gate-off'), world.events.join('\n'));
    assert.equal(world.events.includes('graph-stop'), false);
    assert.equal(world.events.includes('core:start explorer 8090'), false, 'no graph restored by the downgrade');
    assert.equal(world.state.gateStore.read(world.state.identity).enabled, false);
});

// ---------------------------------------------------------------------------
// Fix round 2: preserved-Box recovery keeps its wiring (K1), the restored
// generation is prepared (K5), phase-accurate recovery advice (K6) and
// stale-lock messages and recovery on every lifecycle path (K7).

const { reconcileBoxContainer } = await import('../../ploinky-box/lifecycle/transactions.mjs');

// The real Box transaction (reconcileBoxContainer) behind the supervisor,
// against a stub engine. The old gate-on Box is replaced (a changed data
// path), its graph and container stop, and the first removal fails, so the
// transaction preserves the stopped old Box and the supervisor recovers it.
function preservedRecoveryWorld(t, { removalFailures = 1 } = {}) {
    const state = fixture(t);
    const previousHome = process.env.HOME;
    process.env.HOME = state.home;
    t.after(() => { process.env.HOME = previousHome; });
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    const wiring = resolveDesiredHardwareWiring({ identity: state.identity, enabled: true, homeDirectory: state.home, initializeStore });
    storeWithEntry(state);
    writeGraphSkillScope(state.identity, buildHostSkillScope(state.identity.workspaceRoot, state.identity.workspaceRoot), lockFor(state.identity));
    const box = completeBoxFixture(state);
    let current = completeHandle(box, wiring);
    const engine = { name: 'podman', identity: 'engine', hostKind: 'native-linux' };
    const events = [];
    const reconciledHardware = [];
    const DATA = { dependencies: 'd'.repeat(64), images: 'f'.repeat(64) };
    let removals = 0;
    let inspections = 0;
    const ownership = () => (current
        ? { state: 'owned', engine, handles: { container: current } }
        : { state: 'absent', engine, handles: {} });
    const runner = {
        run(_command, args) {
            if (args[0] === 'container' && args[1] === 'stop') {
                current.runtime.running = false;
                current.runtime.status = 'exited';
                events.push('box-stop');
            } else if (args[0] === 'container' && args[1] === 'start') {
                current.runtime.running = true;
                current.runtime.status = 'running';
                events.push('box-start');
            } else if (args[0] === 'container' && args[1] === 'rm') {
                current = null;
                events.push('box-remove');
            } else if (args[0] === 'container' && args[1] === 'create') {
                events.push(`box-create:${args.some((arg) => String(arg).startsWith(`${BOX_LABELS.hardwareLimits}=`)) ? 'gate-on' : 'gate-off'}`);
                throw new Error('stub engine: no Box is created in this scenario');
            }
            return { ok: true, status: 0, stdout: '' };
        },
        query() { return { ok: true, status: 0, stdout: INBOX_READY }; },
        async stream() { return { ok: true, status: 0, stdout: '', stderr: '' }; },
    };
    const seams = {
        async preflight(options) {
            return { hostPort: options.hostPort, mediaHostPort: options.mediaHostPort, address: options.address, recheckAfterRelease: { tcp: false, udp: false } };
        },
        async recheckReleased() {},
        validateImage: () => ({ immutableId: 'd'.repeat(64) }),
        validateExistingImage: (_engine, imageId) => ({ immutableId: imageId }),
        removeContainer(selectedEngine, id, selectedRunner) {
            removals += 1;
            if (removals <= removalFailures) {
                events.push('box-remove-failed');
                throw new Error('stub engine: remove failed');
            }
            selectedRunner.run(selectedEngine.name, ['container', 'rm', '-f', id]);
        },
        stopPloinkyLocal() { events.push('graph-stop'); },
        async startAndWaitReady(selectedEngine, id, selectedRunner) { selectedRunner.run(selectedEngine.name, ['container', 'start', id]); },
        discover: () => ownership(),
        ensureDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA, created: [] }),
        // The first observation differs, so the first transaction replaces the Box.
        inspectDataPaths: () => {
            inspections += 1;
            return { paths: state.identity.dataPaths, fingerprints: inspections === 1 ? { ...DATA, images: 'e'.repeat(64) } : DATA };
        },
        revalidateDataPaths: () => ({ paths: state.identity.dataPaths, fingerprints: DATA }),
        retireStartLock() {},
        retireEdgePreparation() {},
        token: (kind) => (kind === 'candidate' ? '1'.repeat(24) : '2'.repeat(24)),
    };
    const supervisor = createBoxSupervisor({
        env: {},
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        repositoryRoot: box.root,
        lockManager: fakeLockManager(state.root, events),
        discover: () => ownership(),
        runner,
        selectAgentLib: async () => ({ selection: box.agentLib, mode: 'local' }),
        updateAgentLib: async () => ({ selection: box.agentLib, changed: false, previous: null }),
        updateWorkspacePloinky: async () => ({ found: false }),
        reconcile: async (options) => {
            reconciledHardware.push(options.hardware);
            events.push('reconcile');
            return reconcileBoxContainer(options, seams);
        },
        captureCoreStartArgv: () => ['start', 'explorer', '8090'],
        readEdgeDesired: () => null,
        startCore: async () => { events.push('start-core'); },
        runCoreCommand: async (_engine, _id, argv) => { events.push(`core:${argv.join(' ')}`); },
        // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
        runRestartCore: fakeRestartCore(async (_engine, _id, argv) => { events.push(`core:${argv.join(' ')}`); }),
        runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async (_engine, _id, argv) => { events.push(`core:${argv.join(' ')}`); })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
        resolveHostReachableIpv4: async () => '192.168.1.12',
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        validateExistingImage: () => ({ immutableId: `sha256:${'d'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: state.gateStore,
        prepareHardwareGeneration: async ({ containerId }) => { events.push(`prepare:${containerId.slice(0, 4)}`); return { structurallyPrepared: true }; },
        stdout: { write() { return true; } },
        stderr: { write() { return true; } },
    });
    return { state, wiring, supervisor, events, reconciledHardware, current: () => current };
}

test('G.preserved-recovery-keeps-gate-on', async (t) => {
    // K1: a replacement that fails after the old gate-on Box was stopped is
    // preserved; recovery brings that Box back with its own wiring, while a
    // stored entry exists. Reconcile never receives null and no gate-off Box
    // appears, through start, restart and update.
    for (const [operation, invoke] of [
        ['start', (supervisor) => supervisor.runStartTransaction(['start', 'explorer'])],
        ['restart', (supervisor) => supervisor.runRestartTransaction(['restart'])],
        ['update', (supervisor) => supervisor.runUpdateTransaction(['update'], { restartAfterUpdate: true })],
    ]) {
        const world = preservedRecoveryWorld(t);
        await assert.rejects(invoke(world.supervisor), (error) => {
            assert.match(error.message, /stub engine: remove failed/, operation);
            assert.equal(error.boxRollback?.action, 'preserved', operation);
            assert.equal(error.boxRollback.oldStopAttempted, true, operation);
            // The transaction carries the old Box's own wiring.
            assert.equal(error.boxRollback.hardware?.fingerprint, world.wiring.fingerprint, operation);
            return true;
        });
        assert.equal(world.reconciledHardware.length, 2, `${operation}: the replacement and the recovery: ${world.events.join(' ')}`);
        for (const hardware of world.reconciledHardware) {
            assert.notEqual(hardware, null, `${operation}: reconcile never receives gate-off wiring`);
            assert.equal(hardware?.fingerprint, world.wiring.fingerprint, operation);
        }
        assert.equal(world.events.some((event) => event.startsWith('box-create:')), false, `${operation}: no Box is created: ${world.events.join(' ')}`);
        // The preserved gate-on Box is running again, prepared before its graph.
        assert.equal(world.current().labels[BOX_LABELS.hardwareLimits], world.wiring.fingerprint, operation);
        assert.equal(world.current().runtime.running, true, operation);
        const prepare = world.events.findIndex((event) => event.startsWith('prepare:'));
        const graph = world.events.indexOf('core:start explorer 8090');
        assert.ok(prepare >= 0 && graph > prepare, `${operation}: ${world.events.join(' ')}`);
    }
});

test('G.recovery-blocked-advice', async (t) => {
    // K6: bind, GPU grant and revoke refuse a recovery-blocked journal with
    // the advice that phase needs (never "run ploinky restart"), and the
    // advised destroy closes it even when the Box is already absent.
    for (const [label, invoke] of [
        ['bind', (supervisor) => supervisor.runBindTransaction({ address: '127.0.0.1', hostPort: 8080 })],
        ['gpu grant', (supervisor) => supervisor.runGpuGrantTransaction({ agents: ['demo/agent'] })],
        ['gpu revoke', (supervisor) => supervisor.runGpuRevokeTransaction({})],
    ]) {
        const state = fixture(t);
        state.gateStore.write(state.identity, true, lockFor(state.identity));
        const pending = await pendingDowngrade(state);
        createTransitionStore({ identity: state.identity, homeDirectory: state.home }).writeJournal({
            ...pending, phase: 'recovery-blocked', lastProblem: { code: 'TARGET_MISSING', message: 'the decided gate-off Box is not present', action: 'roll-forward' },
        });
        const events = [];
        await assert.rejects(invoke(realSupervisor(state, { events })), (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_HARDWARE_TRANSITION_PENDING', label);
            assert.match(error.message, new RegExp(`phase recovery-blocked\\)\\. Recovery is blocked \\(the decided gate-off Box is not present\\), and ploinky restart cannot complete it\\. Run ploinky destroy on the host`));
            assert.match(error.message, new RegExp(`Then retry ploinky ${label}\\. No Box mutation was performed\\.$`));
            assert.doesNotMatch(error.message, /Run ploinky restart on the host to complete recovery/);
            return true;
        });
        assert.equal(events.includes('reconcile'), false, label);
    }
    // The advised destroy closes the journal and removes its barrier, also
    // with the Box already absent.
    const state = fixture(t);
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    const pending = await pendingDowngrade(state);
    const store = createTransitionStore({ identity: state.identity, homeDirectory: state.home });
    store.writeJournal({ ...pending, phase: 'recovery-blocked' });
    const absent = { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: {} };
    await realSupervisor(state, { ownership: absent }).runDestroyTransaction(null);
    assert.equal(store.readJournal(pending.operationId).phase, 'aborted-by-destroy');
    assert.deepEqual(store.listPending(), []);
    assert.equal(fs.existsSync(storePaths(state).barrierPath), false);
    assert.equal(state.gateStore.read(state.identity).enabled, true, 'destroy keeps the saved gate');
});

function storeLockOwnedBy(state, owner) {
    const directory = path.join(storePaths(state).storeRoot, 'write.lock');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'owner.json'), `${JSON.stringify({
        token: 'c'.repeat(32), domain: 'host', operation: 'policy-write', acquiredAt: new Date().toISOString(), ...owner,
    })}\n`, { mode: 0o600 });
    return directory;
}

test('G.stale-lock-never-stolen-messages', async (t) => {
    // K7: a lock owned by another host or by a live PID, or held while the
    // Box is paused, is never taken over; each refusal names the lock, its
    // owner and the explicit repair.
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    const absent = { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: {} };
    for (const [label, owner, ownershipFor, pattern] of [
        ['foreign host', { pid: deadPid, hostname: 'other-host.example' }, () => absent,
            /is held by policy-write \(pid \d+ on host other-host\.example\), which is not this host .* so its holder cannot be proven dead and the lock is never taken over\. Stop this workspace on every host that uses this store, make sure no Ploinky process on that host uses this store, then remove .*write\.lock and retry\. No policy was changed\.$/],
        ['live pid', { pid: process.pid, hostname: os.hostname() }, () => absent,
            new RegExp(`is held by policy-write \\(pid ${process.pid} on host .*\\), and that process is still running on this host, so the lock is never taken over\\. Wait for that operation to finish and retry\\. If that PID is not a Ploinky process \\(it was reused\\), stop this workspace on the host, make sure no Ploinky process on that host uses this store, then remove .*write\\.lock and retry\\.`)],
        ['paused Box', { pid: deadPid, hostname: os.hostname() }, (state) => {
            const box = owned(state.identity, { running: false });
            box.handles.container.runtime.status = 'paused';
            return box;
        }, /and this workspace's Box is paused, so a writer inside it may still hold the lock\. Resume the Box, or stop this workspace on the host, then retry\. No policy was changed\.$/],
        ...['', undefined, 'unrecognized'].map((status) => [
            `unknown Box status ${String(status)}`, { domain: 'box', pid: deadPid, hostname: os.hostname() }, (state) => {
                const box = owned(state.identity, { running: false });
                box.handles.container.runtime.status = status;
                return box;
            }, /Hardware policy store is locked\. Stop this workspace on the host, then run ploinky limits clear --all or retry the lifecycle command\. No policy was changed\.$/,
        ]),
    ]) {
        const state = fixture(t);
        initializeStore({ paths: storePaths(state), identity: state.identity });
        const directory = storeLockOwnedBy(state, owner);
        const events = [];
        await assert.rejects(realSupervisor(state, { events, ownership: ownershipFor(state) }).runStartTransaction(['start', 'explorer']), (error) => {
            assert.equal(error.code, 'PLOINKY_BOX_HARDWARE_STORE_BUSY', label);
            assert.match(error.message, pattern, label);
            assert.ok(error.message.includes(directory), `${label}: names the lock path`);
            return true;
        });
        assert.ok(fs.existsSync(path.join(directory, 'owner.json')), `${label}: never stolen`);
        assert.equal(events.includes('reconcile'), false, label);
    }
});

test('G.update-recovers-stale-lock', async (t) => {
    // K7: the update preflight is lock-free and read-only, and the update
    // transaction recovers a dead same-host holder's lock with the Box absent
    // under the workspace lock, then proceeds.
    const state = fixture(t);
    initializeStore({ paths: storePaths(state), identity: state.identity });
    const directory = storeLockOwnedBy(state, { pid: spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid, hostname: os.hostname() });
    const absent = { state: 'absent', engine: { name: 'podman', identity: 'engine' }, handles: {} };
    const events = [];
    const supervisor = createBoxSupervisor({
        env: {},
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => absent,
        runner: { run(_command, args) { events.push(`run:${args.slice(0, 2).join(' ')}`); }, query() { return { ok: true, status: 0, stdout: INBOX_READY }; } },
        selectAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }),
        updateAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), changed: false, previous: null }),
        updateWorkspacePloinky: async () => ({ found: false }),
        reconcile: async (options) => { events.push('reconcile'); return { action: 'created', ownership: owned(state.identity), hostPort: 8080, mediaHostPort: 7882, hardware: options.hardware }; },
        readEdgeDesired: () => null,
        runCoreCommand: async () => { events.push('core'); },
        // The restart and update of the Box run through master's bounded runners; the same recorder plays the in-Box core.
        runRestartCore: fakeRestartCore(async () => { events.push('core'); }),
        runUpdateCore: fakeUpdateCore({ onCall: ({ engine, containerId, argv, hostPort, mediaHostPort, options }) => (async () => { events.push('core'); })(engine, containerId, argv, hostPort, mediaHostPort, null, options) }),
        resolveHostReachableIpv4: async () => '192.168.1.12',
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        hardwareGateStore: state.gateStore,
        stderr: { write() { return true; } },
    });
    // The preflight is read-only: it neither takes nor recovers the lock.
    assert.deepEqual(supervisor.preflightHardwareGate('update'), { enabled: false, source: 'default' });
    assert.ok(fs.existsSync(path.join(directory, 'owner.json')), 'the preflight leaves the lock alone');
    const hostUpdates = [];
    const code = await runOuterCli(['update'], {
        env: {}, input: {}, output: sink(), errorOutput: sink(), cwd: () => state.identity.workspaceRoot,
        supervisor, detectInsideBox: () => false,
        updateHostSource: async () => { hostUpdates.push('host'); return { updated: false }; },
        relaunch: () => 0,
    });
    assert.equal(code, 0);
    assert.deepEqual(hostUpdates, ['host']);
    assert.ok(events.includes('reconcile'), `the update proceeded: ${events.join(' ')}`);
    assert.equal(fs.existsSync(directory), false, 'the stale lock was quarantined');
    assert.ok(fs.readdirSync(storePaths(state).storeRoot).some((name) => name.startsWith('write.lock.stale-')));
});

// Registered after the module-level imports above it uses.
test('G.status-transition', async (t) => {
    // K6: status prints every pending downgrade journal read-only with its
    // operation ID, its real phase (the pre-barrier prepared phase and
    // recovery-blocked included) and the recovery that phase needs; it never
    // prints a hard-coded barrier-installed.
    const RESTART = 'Run ploinky restart on the host to complete recovery.';
    for (const phase of ['prepared', 'old-stopped', 'old-absent', 'candidate-created', 'recovery-blocked']) {
        const state = fixture(t);
        const pending = await pendingDowngrade(state);
        const store = createTransitionStore({ identity: state.identity, homeDirectory: state.home });
        store.writeJournal({
            ...pending,
            phase,
            lastProblem: phase === 'recovery-blocked'
                ? { code: 'FOREIGN_BOX', message: `Box ${'9'.repeat(64)} is not owned by this transition`, action: 'recover' }
                : null,
        });
        const journalPath = path.join(store.directory, `${pending.operationId}.json`);
        const before = fs.readFileSync(journalPath, 'utf8');
        const text = status(state);
        const lines = text.split('\n').filter((line) => line.startsWith('Transition: '));
        assert.equal(lines.length, 1, `${phase}: ${text}`);
        if (phase === 'recovery-blocked') {
            assert.equal(lines[0], `Transition: gate-on to gate-off ${pending.operationId}, recovery-blocked; recovery Recovery is blocked `
                + `(Box ${'9'.repeat(64)} is not owned by this transition), and ploinky restart cannot complete it. Run ploinky destroy `
                + "on the host to remove this workspace's Box and close the transition (the saved gate and stored limits are kept), then run ploinky start.");
            assert.equal(lines[0].includes(RESTART), false, 'recovery-blocked is never told to run ploinky restart');
        } else {
            assert.equal(lines[0], `Transition: gate-on to gate-off ${pending.operationId}, ${phase}; recovery ${RESTART}`);
        }
        assert.doesNotMatch(text, /barrier-installed/, phase);
        assert.equal(fs.readFileSync(journalPath, 'utf8'), before, `${phase}: status never mutates the journal`);
        assert.equal(store.readJournal(pending.operationId).phase, phase);
    }
    // A barrier without any pending journal is reported as exactly that.
    const state = fixture(t);
    const paths = storePaths(state);
    const { token } = initializeStore({ paths, identity: state.identity });
    const operationId = '9'.repeat(32);
    beginDowngradeBarrier({ paths, identity: state.identity, operationId, expectedEmptyToken: token });
    const text = status(state);
    assert.match(text, new RegExp(`\\nTransition: write barrier ${operationId} has no pending journal; policy writes stay blocked and no recovery applies to it automatically\\n`));
    assert.doesNotMatch(text, /barrier-installed/);
    assert.ok(fs.existsSync(paths.barrierPath), 'status reports the barrier without mutating it');
});

for (const mismatch of ['engineIdentity', 'hostKind']) {
    test(`supervisor restart blocks pending recovery on changed ${mismatch}`, async (t) => {
        const state = fixture(t);
        state.gateStore.write(state.identity, true, lockFor(state.identity));
        await pendingDowngrade(state);
        const events = [];
        const ownership = { state: 'absent', engine: {
            name: 'podman', identity: mismatch === 'engineIdentity' ? 'different-engine' : 'engine',
            hostKind: mismatch === 'hostKind' ? 'podman-machine' : 'native-linux',
        }, handles: {} };
        await assert.rejects(realSupervisor(state, { events, ownership }).runRestartTransaction(['restart']),
            (error) => error.code === 'PLOINKY_BOX_HARDWARE_RECOVERY_BLOCKED');
        assert.equal(events.some((event) => event.startsWith('run:') || ['core', 'prepare', 'reconcile', 'start-core'].includes(event)), false);
        assert.ok(fs.existsSync(storePaths(state).barrierPath));
        const journal = createTransitionStore({ identity: state.identity, homeDirectory: state.home }).listPending()[0];
        assert.equal(journal.phase, 'recovery-blocked');
        assert.equal(journal.lastProblem.code, 'ENGINE_IDENTITY_CHANGED');
    });
}

// R12-c(v): the status text states the daemon default as configured; no producer feeds a "largest share" clause.
test('G.status-mps-defaults-line-states-only-the-configured-default', () => {
    const text = formatLimitsStatus({ identity: 'w', gate: { state: 'on', savedAt: '2026-10-03T00:00:00.000Z' }, box: { mps: { daemonStatus: 'ready', serverDefault: { smPercent: 25, vramMiB: 2048, shareMemoryMiB: 1044 } } }, agents: [] });
    assert.match(text, /^MPS defaults: 25% SM; 2048 MiB per CUDA process$/m);
    assert.equal(/largest share/.test(text), false);
});

// ---------------------------------------------------------------------------
// R20-1: the selected gate is a journal item of the graph admission. Master's rule (update/admission.mjs): every candidate
// write happens inside the error boundary and nothing after settlement can trigger a restoration.
const FIXED_PRIOR = '2026-01-02T03:04:05.000Z';
function gateAdmissionWorld(t, { action, failWrite = false, failFinalize = null, priorGate = null, events = [], env = { PLOINKY_BOX_HARDWARE_LIMITS: 'on' }, stderrLines = [] }) {
    const state = fixture(t);
    const previousHome = process.env.HOME;
    process.env.HOME = state.home;
    t.after(() => { process.env.HOME = previousHome; });
    writeGraphSkillScope(state.identity, buildHostSkillScope(state.identity.workspaceRoot, state.identity.workspaceRoot), lockFor(state.identity));
    if (priorGate !== null) state.gateStore.write(state.identity, priorGate, lockFor(state.identity), { now: () => new Date(FIXED_PRIOR) });
    const candidate = owned(state.identity, { id: (action === 'replaced' ? '1' : 'a').repeat(64) });
    const priorAgentLib = agentLibFixture(state.identity.workspaceRoot);
    let settled = false;
    const gate = Object.freeze({
        homeDirectory: state.gateStore.homeDirectory,
        root: state.gateStore.root,
        recordPath: state.gateStore.recordPath,
        read: (identity) => state.gateStore.read(identity),
        write: (identity, enabled, lock, options) => {
            events.push(settled ? 'gate-write-after-settlement' : 'gate-write');
            if (failWrite) throw new Error('simulated gate record write failure');
            return state.gateStore.write(identity, enabled, lock, options);
        },
        clear: (identity, lock) => state.gateStore.clear(identity, lock),
        restore: (identity, previous, lock) => { events.push('gate-restore'); return state.gateStore.restore(identity, previous, lock); },
    });
    const supervisor = createBoxSupervisor({
        env,
        resolveIdentity: () => state.identity,
        launchCwd: state.identity.workspaceRoot,
        lockManager: fakeLockManager(state.root, events),
        discover: () => owned(state.identity),
        runner: {
            run(_command, args) { if (args.includes('ploinky-local')) events.push(`graph-stop:${settled ? 'after-settlement' : 'before-settlement'}`); },
            query() { return { ok: true, status: 0, stdout: INBOX_READY }; },
        },
        selectAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), mode: 'local' }),
        updateAgentLib: async () => ({ selection: agentLibFixture(state.identity.workspaceRoot), changed: false, previous: null }),
        updateWorkspacePloinky: async () => ({ found: false }),
        reconcile: async (options) => ({
            action, ownership: candidate, hostPort: 8080, mediaHostPort: 7882, hardware: options.hardware, previousAgentLib: priorAgentLib,
            validate() { if (settled) throw new Error('already settled'); },
            finalize() {
                events.push('finalize');
                if (failFinalize) failFinalize(state, events);
                settled = true;
            },
            async rollback() {
                events.push(`rollback:${settled ? 'after-settlement' : 'before-settlement'}`);
                return Object.freeze({ action: action === 'reused' ? 'reused-preserved' : 'candidate-removed', ownership: candidate, containerId: candidate.handles.container.id, hostPort: 8080, mediaHostPort: 7882, routerBinding: null, gpu: null, agentLib: priorAgentLib });
            },
        }),
        captureCoreStartArgv: () => ['start', 'explorer', '8080'],
        readEdgeDesired: () => null,
        startCore: async () => { events.push('start-core'); },
        runCoreCommand: async () => {},
        runRestartCore: fakeRestartCore(async () => {}),
        runUpdateCore: fakeUpdateCore({ onCall: () => Promise.resolve() }),
        resolveHostReachableIpv4: async () => '192.168.1.12',
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        validateExistingImage: () => ({ immutableId: `sha256:${'b'.repeat(64)}` }),
        validateContainer: () => {},
        hardwareGateStore: gate,
        prepareHardwareGeneration: async () => ({ structurallyPrepared: true }),
        stdout: { write() { return true; } },
        stderr: { write(text) { stderrLines.push(String(text).trim()); return true; } },
    });
    const invoke = {
        start: () => supervisor.runStartTransaction(['start', 'explorer', '8080']),
        restart: () => supervisor.runRestartTransaction(['restart']),
        update: () => supervisor.runUpdateTransaction(['update'], { restartAfterUpdate: true }),
        targetedUpdate: () => supervisor.runUpdateTransaction(['update', 'repos']),
    };
    return { state, events, invoke, supervisor };
}

for (const operation of ['start', 'restart', 'update']) {
    test(`G.gate-write-is-a-journal-item-before-settlement-${operation}`, async (t) => {
        for (const action of ['replaced', 'reused']) {
            const world = gateAdmissionWorld(t, { action });
            await world.invoke[operation]();
            const { events, state } = world;
            assert.ok(events.includes('gate-write'), `${operation}/${action} saves the selected gate: ${events}`);
            assert.ok(events.indexOf('gate-write') < events.indexOf('finalize'), `${operation}/${action}: the gate is written inside the journaled admission, before settlement: ${events}`);
            assert.equal(events.some((event) => event.endsWith('after-settlement')), false, `nothing runs after settlement: ${events}`);
            assert.equal(state.gateStore.read(state.identity).enabled, true);
        }
    });

    test(`G.gate-write-failure-never-reaches-a-rollback-after-settlement-${operation}`, async (t) => {
        for (const action of ['replaced', 'reused']) {
            const world = gateAdmissionWorld(t, { action, failWrite: true });
            const error = await world.invoke[operation]().then(() => null, (failure) => failure);
            const { events, state } = world;
            assert.ok(error, `${operation}/${action}: a failing gate write fails the transaction`);
            assert.match(error.message, /simulated gate record write failure/);
            // The failure is inside the journaled boundary: the admission never settled, so the candidate is rolled back
            // under its rollback authority, exactly once, and the settlement never ran for a graph that was not admitted.
            assert.equal(events.includes('finalize'), false, `${operation}/${action}: no settlement after a failed gate write: ${events}`);
            assert.equal(events.filter((event) => event === 'rollback:before-settlement').length, 1, events.join(' '));
            assert.equal(events.some((event) => event.endsWith('after-settlement')), false, events.join(' '));
            assert.equal(error.admission?.outcome, 'recovered', JSON.stringify(error.admission));
            assert.deepEqual(error.admission.results.find((result) => result.name === 'hardware-gate'), { name: 'hardware-gate', outcome: 'unchanged' });
            assert.equal(state.gateStore.read(state.identity), null, 'a failed write leaves no saved gate');
        }
    });

    test(`G.gate-is-restored-to-its-exact-prior-record-only-while-it-is-this-transactions-candidate-${operation}`, async (t) => {
        // A prior saved gate (off, with its own timestamp) and a settlement that fails after the gate was written: the journal
        // puts back exactly the prior record, timestamp included, and reports the recovery.
        const restored = gateAdmissionWorld(t, { action: 'replaced', priorGate: false, failFinalize: () => { throw new Error('simulated settlement failure'); } });
        const error = await restored.invoke[operation]().then(() => null, (failure) => failure);
        assert.match(String(error?.message), /simulated settlement failure/);
        assert.deepEqual(error.admission.results.find((result) => result.name === 'hardware-gate'), { name: 'hardware-gate', outcome: 'restored' });
        assert.deepEqual({ ...restored.state.gateStore.read(restored.state.identity) }, { enabled: false, savedAt: FIXED_PRIOR });
        // No prior record: restoration removes the candidate record.
        const absent = gateAdmissionWorld(t, { action: 'reused', failFinalize: () => { throw new Error('simulated settlement failure'); } });
        const absentError = await absent.invoke[operation]().then(() => null, (failure) => failure);
        assert.deepEqual(absentError.admission.results.find((result) => result.name === 'hardware-gate'), { name: 'hardware-gate', outcome: 'restored' });
        assert.equal(absent.state.gateStore.read(absent.state.identity), null);
        assert.ok(absent.events.includes('gate-restore'));
        // A successor wrote its own gate before the failure: its value is preserved and the recovery is reported, never overwritten.
        const successor = gateAdmissionWorld(t, {
            action: 'replaced', priorGate: false,
            failFinalize: (state) => { state.gateStore.write(state.identity, false, lockFor(state.identity), { now: () => new Date('2026-02-03T04:05:06.000Z') }); throw new Error('simulated settlement failure'); },
        });
        const successorError = await successor.invoke[operation]().then(() => null, (failure) => failure);
        assert.equal(successorError.admission.outcome, 'recovery-required');
        assert.deepEqual(successorError.admission.results.find((result) => result.name === 'hardware-gate'), { name: 'hardware-gate', outcome: 'successor-preserved' });
        assert.deepEqual({ ...successor.state.gateStore.read(successor.state.identity) }, { enabled: false, savedAt: '2026-02-03T04:05:06.000Z' });
        assert.equal(successor.events.includes('gate-restore'), false, 'a successor value is never restored over');
    });
}

test('G.gate-store-clear-and-restore-are-lock-checked-and-exact', (t) => {
    const state = fixture(t);
    const lock = lockFor(state.identity);
    const record = state.gateStore.recordPath(state.identity);
    // Both mutations need the workspace lock, and a lock for another instance is refused.
    for (const operation of [() => state.gateStore.clear(state.identity), () => state.gateStore.restore(state.identity, null)]) {
        assert.throws(operation, (error) => error.code === 'PLOINKY_BOX_HARDWARE_STATE_INVALID' && /workspace mutation lock/.test(error.message));
    }
    assert.throws(() => state.gateStore.clear(state.identity, { assertHeld: () => { throw new Error('not held'); } }), /not held/);
    // Clearing an absent record is a no-op; clearing a saved one removes exactly it.
    assert.equal(state.gateStore.clear(state.identity, lock), false);
    state.gateStore.write(state.identity, true, lock);
    assert.equal(state.gateStore.clear(state.identity, lock), true);
    assert.equal(fs.existsSync(record), false);
    // Restoring a previous record puts back its value and its timestamp; restoring absence removes the record.
    state.gateStore.restore(state.identity, { enabled: false, savedAt: FIXED_PRIOR }, lock);
    assert.deepEqual({ ...state.gateStore.read(state.identity) }, { enabled: false, savedAt: FIXED_PRIOR });
    state.gateStore.restore(state.identity, null, lock);
    assert.equal(state.gateStore.read(state.identity), null);
    // A non-regular record is never removed.
    fs.mkdirSync(path.dirname(record), { recursive: true });
    fs.mkdirSync(record);
    assert.throws(() => state.gateStore.clear(state.identity, lock), /non-regular hardware-limits gate path/);
    assert.equal(fs.existsSync(record), true);
});

// ---------------------------------------------------------------------------
// R20-3: the repository forms of `ploinky update` follow the saved gate, so a request for another gate is refused BEFORE any
// mutation instead of being checked and then ignored. Only the full form applies it.
const GATE_VARIABLE = 'PLOINKY_BOX_HARDWARE_LIMITS';
const NOT_APPLIED = /would change the saved hardware-limits gate \((on|off)\), but a targeted update never replaces the Box, so it cannot apply it\. No change was made\./;

test('G.targeted-update-selection-refuses-another-gate-and-notes-a-matching-one', (t) => {
    const state = fixture(t);
    const select = (env, operation) => selectHardwareGate({ identity: state.identity, gateStore: state.gateStore, env, operation });
    // Saved off (or never set): a request for on cannot be applied by a targeted update.
    for (const saved of [null, false]) {
        if (saved === false) state.gateStore.write(state.identity, false, lockFor(state.identity));
        assert.throws(() => select({ [GATE_VARIABLE]: 'on' }, 'targeted-update'), (error) => error.code === 'PLOINKY_BOX_HARDWARE_GATE_NOT_APPLIED' && NOT_APPLIED.test(error.message) && /\(off\)/.test(error.message));
        // The full form applies it.
        assert.equal(select({ [GATE_VARIABLE]: 'on' }, 'update').enabled, true);
        assert.equal(select({ [GATE_VARIABLE]: 'on' }, 'update').source, 'environment');
        // The same request, or none, keeps the saved gate; the matching request is acknowledged, never reported as ignored.
        const same = select({ [GATE_VARIABLE]: 'off' }, 'targeted-update');
        assert.deepEqual({ enabled: same.enabled, persist: same.persist, changed: same.changed }, { enabled: false, persist: false, changed: false });
        assert.equal(same.note, `${GATE_VARIABLE}=off matches the saved gate; a targeted update follows the saved gate`);
        assert.doesNotMatch(same.note, /only start, restart and update apply it/);
        assert.equal(select({}, 'targeted-update').note, null);
    }
    // Saved on: a request for off is refused (the saved gate stays on), a matching on is acknowledged.
    state.gateStore.write(state.identity, true, lockFor(state.identity));
    assert.throws(() => select({ [GATE_VARIABLE]: 'off' }, 'targeted-update'), (error) => error.code === 'PLOINKY_BOX_HARDWARE_GATE_NOT_APPLIED' && /\(on\)/.test(error.message));
    assert.equal(select({ [GATE_VARIABLE]: '1' }, 'targeted-update').note, `${GATE_VARIABLE}=on matches the saved gate; a targeted update follows the saved gate`);
    // An invalid value fails like every other operation.
    assert.throws(() => select({ [GATE_VARIABLE]: 'maybe' }, 'targeted-update'), { code: 'PLOINKY_BOX_HARDWARE_GATE_INVALID' });
    // Other non-applying operations are unchanged: the generic note, no refusal.
    assert.match(select({ [GATE_VARIABLE]: 'off' }, 'saved').note, /only start, restart and update apply it/);
});

test('G.targeted-update-preflight-and-host-command-refuse-before-the-host-source-update', async (t) => {
    for (const form of [['update', 'repos'], ['update', 'repo', 'demo']]) {
        for (const [label, setup, value, code] of [
            ['on against a saved-off gate', (state) => state.gateStore.write(state.identity, false, lockFor(state.identity)), 'on', 'PLOINKY_BOX_HARDWARE_GATE_NOT_APPLIED'],
            ['on against no saved gate', () => {}, 'on', 'PLOINKY_BOX_HARDWARE_GATE_NOT_APPLIED'],
            // The change would not happen, so the stored-limits refusal (U9) of a downgrade must not be raised for it.
            ['off against a saved-on gate with stored limits', (state) => { state.gateStore.write(state.identity, true, lockFor(state.identity)); storeWithEntry(state); }, 'off', 'PLOINKY_BOX_HARDWARE_GATE_NOT_APPLIED'],
        ]) {
            const state = fixture(t);
            setup(state);
            const before = fs.existsSync(storePaths(state).policyPath) ? fs.readFileSync(storePaths(state).policyPath, 'utf8') : null;
            const savedBefore = state.gateStore.read(state.identity);
            const env = { [GATE_VARIABLE]: value };
            const events = [];
            const hostUpdates = [];
            await assert.rejects(runOuterCli(form, {
                env, input: {}, output: sink(), errorOutput: sink(), cwd: () => state.identity.workspaceRoot,
                supervisor: realSupervisor(state, { env, events }), detectInsideBox: () => false,
                updateHostSource: async (options) => { hostUpdates.push(options); return { updated: true }; },
                relaunch: () => { hostUpdates.push('relaunch'); return 0; },
            }), (error) => error.code === code && NOT_APPLIED.test(error.message), `${form.join(' ')} / ${label}`);
            assert.deepEqual(hostUpdates, [], `${form.join(' ')} / ${label}: the host source was never updated or relaunched`);
            assert.equal(events.includes('reconcile'), false, `${form.join(' ')} / ${label}: no Box mutation`);
            assert.equal(events.includes('lock'), false, `${form.join(' ')} / ${label}: refused by the lock-free preflight, before the workspace lock is taken`);
            assert.deepEqual(state.gateStore.read(state.identity), savedBefore, `${label}: the saved gate is untouched`);
            if (before !== null) assert.equal(fs.readFileSync(storePaths(state).policyPath, 'utf8'), before, `${label}: the store is untouched`);
        }
    }
    // The full form is unchanged: it applies the request, and its downgrade is still refused with stored limits.
    const full = fixture(t);
    assert.deepEqual(realSupervisor(full, { env: { [GATE_VARIABLE]: 'on' } }).preflightHardwareGate('update'), { enabled: true, source: 'environment' });
    const stored = fixture(t);
    stored.gateStore.write(stored.identity, true, lockFor(stored.identity));
    storeWithEntry(stored);
    assert.throws(() => realSupervisor(stored, { env: { [GATE_VARIABLE]: 'off' } }).preflightHardwareGate('update'), { code: 'PLOINKY_BOX_HARDWARE_LIMITS_STORED' });
    // Through the host command: the full form still applies the request (its preflight passes and the host source update is reached);
    // only the repository forms refuse it.
    const hostFull = fixture(t);
    const fullEvents = [];
    const fullHostUpdates = [];
    const fullEnv = { [GATE_VARIABLE]: 'on' };
    const fullError = await runOuterCli(['update'], {
        env: fullEnv, input: {}, output: sink(), errorOutput: sink(), cwd: () => hostFull.identity.workspaceRoot,
        supervisor: realSupervisor(hostFull, { env: fullEnv, events: fullEvents }), detectInsideBox: () => false,
        updateHostSource: async (options) => { fullHostUpdates.push(options); return { updated: false }; },
        relaunch: () => 0,
    }).then(() => null, (failure) => failure);
    assert.notEqual(fullError?.code, 'PLOINKY_BOX_HARDWARE_GATE_NOT_APPLIED', String(fullError?.message));
    assert.equal(fullHostUpdates.length, 1, 'the full form passed its preflight and reached the host source update');
    // The matching request passes the targeted preflight and reports the saved gate.
    stored.gateStore.write(stored.identity, true, lockFor(stored.identity));
    assert.deepEqual(realSupervisor(stored, { env: { [GATE_VARIABLE]: 'on' } }).preflightHardwareGate('targeted-update'), { enabled: true, source: 'saved' });
});

test('G.targeted-update-transaction-refuses-another-gate-under-the-lock-before-any-mutation', async (t) => {
    for (const [label, priorGate, value] of [['on against saved-off', false, 'on'], ['off against saved-on', true, 'off'], ['on against no saved gate', null, 'on']]) {
        const events = [];
        const world = gateAdmissionWorld(t, { action: 'reused', priorGate, events, env: { [GATE_VARIABLE]: value } });
        const error = await world.invoke.targetedUpdate().then(() => null, (failure) => failure);
        assert.equal(error?.code, 'PLOINKY_BOX_HARDWARE_GATE_NOT_APPLIED', `${label}: ${error?.message}`);
        assert.equal(events.some((event) => ['finalize', 'gate-write', 'start-core'].includes(event) || event.startsWith('rollback')), false, `${label}: nothing mutated: ${events}`);
        assert.equal(world.state.gateStore.read(world.state.identity)?.enabled ?? null, priorGate, `${label}: the saved gate is untouched`);
    }
    // A matching request runs the update with the saved gate, says so, and never claims it was ignored or applied.
    const stderrLines = [];
    const world = gateAdmissionWorld(t, { action: 'reused', priorGate: true, env: { [GATE_VARIABLE]: 'on' }, stderrLines });
    await world.invoke.targetedUpdate();
    assert.ok(stderrLines.some((line) => line.includes(`${GATE_VARIABLE}=on matches the saved gate; a targeted update follows the saved gate`)), stderrLines.join('|'));
    assert.equal(stderrLines.some((line) => /only start, restart and update apply it/.test(line)), false, stderrLines.join('|'));
    assert.equal(world.events.includes('gate-write'), false, 'a targeted update never rewrites the gate');
});

// R20 (R2): the full update re-resolves its folder under the lock BEFORE it settles a gate-on to gate-off downgrade, as master
// orders it, so a scope that fails there leaves the running gate-on Box, its graph and its saved gate untouched.
test('G.full-update-scope-failure-under-the-lock-settles-no-downgrade', async (t) => {
    const world = downgradeWorld(t, { boxRunning: true, graphRunning: true });
    const missing = path.join(world.state.root, 'folder-that-vanished-while-waiting-for-the-lock');
    const request = Object.freeze({ kind: 'all', folder: 'vanished', folderPath: missing });
    const error = await world.supervisor.runUpdateTransaction(['update'], { request }).then(() => null, (failure) => failure);
    assert.equal(error?.code, 'PLOINKY_UPDATE_SCOPE_MISSING', String(error?.message));
    for (const effect of ['graph-stop', 'box-stop', 'box-remove', 'box-start']) assert.equal(world.events.includes(effect), false, `${effect} did not run: ${world.events.join(' ')}`);
    assert.equal(world.events.some((event) => event.startsWith('box-create')), false, world.events.join(' '));
    assert.equal(world.state.gateStore.read(world.state.identity).enabled, true, 'the saved gate is still on');
    assert.deepEqual(createTransitionStore({ identity: world.state.identity, homeDirectory: world.state.home }).listPending(), [], 'no downgrade journal was written');
});
