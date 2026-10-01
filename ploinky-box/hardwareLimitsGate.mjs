// Host-owned hardware-limits gate (plan §3 U1/U9/U16, §5.5, §6.1).
//
// The saved gate lives in ~/.ploinky-box/hardware-limits/INSTANCE.json and is
// never mounted. Only start, restart and update apply
// PLOINKY_BOX_HARDWARE_LIMITS; omitting it keeps the saved value. Every other
// command uses the saved state and says when an environment value is ignored.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    BOX_HARDWARE_MARKER_PATH,
    BOX_HARDWARE_STORE_PATH,
    BOX_LABELS,
} from './constants.mjs';
import { PloinkyBoxError } from './errors.mjs';
import {
    ensurePrivateDirectory,
    readPrivateFile,
    writePrivateFileAtomically,
} from './privateStateFiles.mjs';
import { assertRouterBindingStateConfined } from './routerBinding.mjs';
import {
    assertHardwareStateConfined,
    clearAgentLimits,
    clearAllLimits,
    hardwareStateRoot,
    hardwareStorePaths,
    readBarrier,
    readStoreSnapshot,
} from '../cli/sandbox/hardwareLimits/store.mjs';
import { readStoreLockOwner } from '../cli/sandbox/hardwareLimits/storeLock.mjs';

export const HARDWARE_GATE_ENV = 'PLOINKY_BOX_HARDWARE_LIMITS';
export const GATE_APPLYING_OPERATIONS = Object.freeze(['start', 'restart', 'update']);
const GATE_RECORD_KEYS = ['enabled', 'savedAt', 'schema'];
const MAX_GATE_BYTES = 1024;
const STATE_FILES = Object.freeze({
    subject: 'hardware-limits state',
    stateError: (message, cause) => new PloinkyBoxError(message, { code: 'PLOINKY_BOX_HARDWARE_STATE_INVALID', cause }),
});

function gateError(message, code = 'PLOINKY_BOX_HARDWARE_GATE_INVALID') {
    return new PloinkyBoxError(message, { code });
}

function exactIdentity(identity) {
    const instance = String(identity?.instance || '');
    if (!/^ploinky-box-[a-z0-9-]+-[a-f0-9]{12}$/.test(instance)
        || !/^[a-f0-9]{12}$/.test(String(identity?.pathHash || ''))
        || !path.isAbsolute(String(identity?.workspaceRoot || ''))) {
        throw gateError('Hardware-limits state requires the exact workspace identity', 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
    }
    return identity;
}

/**
 * Unset/empty keeps the saved state; on/1/true and off/0/false (trimmed,
 * case-insensitive) select a gate. Anything else fails before any mutation.
 */
export function parseHardwareGateValue(value) {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim().toLowerCase();
    if (!text) return undefined;
    if (['on', '1', 'true'].includes(text)) return true;
    if (['off', '0', 'false'].includes(text)) return false;
    throw gateError(`${HARDWARE_GATE_ENV} must be on, off, 1, 0, true or false; got '${String(value).slice(0, 64)}'. No change was made.`);
}

export function createHardwareGateStore({ homeDirectory = os.homedir(), fsApi = fs } = {}) {
    const root = hardwareStateRoot(homeDirectory);

    function recordPath(identity) {
        return path.join(root, `${exactIdentity(identity).instance}.json`);
    }

    function read(identity) {
        assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
        const target = recordPath(identity);
        const bytes = readPrivateFile(fsApi, target, MAX_GATE_BYTES, 'Saved hardware-limits gate', STATE_FILES);
        if (bytes === null) return null;
        let record;
        try {
            record = JSON.parse(bytes.toString('utf8'));
        } catch (error) {
            throw gateError(`Saved hardware-limits gate is not valid JSON: ${target}`, 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)
            || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(GATE_RECORD_KEYS)
            || record.schema !== 1 || typeof record.enabled !== 'boolean' || Number.isNaN(Date.parse(record.savedAt))) {
            throw gateError(`Saved hardware-limits gate is invalid: ${target}`, 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
        }
        return Object.freeze({ enabled: record.enabled, savedAt: record.savedAt });
    }

    function write(identity, enabled, lock, { now = () => new Date() } = {}) {
        if (typeof lock?.assertHeld !== 'function') {
            throw gateError('Changing the hardware-limits gate requires the workspace mutation lock', 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
        }
        lock.assertHeld(identity.instance);
        assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
        fsApi.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
        ensurePrivateDirectory(fsApi, root, STATE_FILES);
        const target = recordPath(identity);
        const record = { schema: 1, enabled: Boolean(enabled), savedAt: now().toISOString() };
        writePrivateFileAtomically(fsApi, root, target, `${JSON.stringify(record, null, 2)}\n`, () => {}, STATE_FILES);
        return Object.freeze({ enabled: record.enabled, savedAt: record.savedAt });
    }

    return Object.freeze({ homeDirectory, root, recordPath, read, write });
}

/**
 * Select the gate for one operation. Only start/restart/update apply an
 * environment value; other operations report it as ignored.
 */
export function selectHardwareGate({ identity, gateStore, env = process.env, operation }) {
    const requested = parseHardwareGateValue(env?.[HARDWARE_GATE_ENV]);
    const saved = gateStore.read(identity);
    const savedEnabled = saved?.enabled === true;
    if (requested !== undefined && GATE_APPLYING_OPERATIONS.includes(operation)) {
        return Object.freeze({
            enabled: requested,
            saved,
            source: 'environment',
            persist: !saved || saved.enabled !== requested,
            changed: savedEnabled !== requested,
            note: null,
        });
    }
    return Object.freeze({
        enabled: savedEnabled,
        saved,
        source: saved ? 'saved' : 'default',
        persist: false,
        changed: false,
        note: requested !== undefined
            ? `${HARDWARE_GATE_ENV}=${String(env[HARDWARE_GATE_ENV]).trim()} is set; only start, restart and update apply it`
            : null,
    });
}

/**
 * U16: generic host commands become inspect-only only when this workspace has
 * hardware state: a saved on gate, an initialized store, or proven entries.
 * Unreadable or contradictory existing metadata is unknown and conservative.
 */
export function readHardwareStateClass({ identity, gateStore, homeDirectory = gateStore?.homeDirectory, fsApi = fs }) {
    let saved;
    try {
        saved = gateStore.read(identity);
    } catch (error) {
        return Object.freeze({ hasHardwareState: true, unknown: true, reason: `saved gate is unreadable: ${error.message}` });
    }
    if (saved?.enabled === true) return Object.freeze({ hasHardwareState: true, unknown: false, reason: 'saved gate is on' });
    const paths = hardwareStorePaths({ identity, homeDirectory });
    let snapshot;
    try {
        snapshot = readStoreSnapshot({ paths, identity, fsApi });
    } catch (error) {
        return Object.freeze({ hasHardwareState: true, unknown: true, reason: `hardware store identity is invalid: ${error.message}` });
    }
    if (snapshot.status === 'absent-never-initialized') {
        return Object.freeze({ hasHardwareState: false, unknown: false, reason: saved ? 'saved gate is off and no store exists' : 'never enabled' });
    }
    if (snapshot.status === 'unreadable') {
        return Object.freeze({ hasHardwareState: true, unknown: true, reason: `hardware store is unreadable: ${snapshot.diagnostic}` });
    }
    return Object.freeze({
        hasHardwareState: true,
        unknown: false,
        reason: snapshot.agents.size ? `${snapshot.agents.size} stored limit entries` : 'hardware store is initialized',
    });
}

export const GENERIC_INSPECT_ONLY_MESSAGE = 'This workspace has hardware-limit state, so this command only uses an '
    + 'already-running compatible Box. Run ploinky start on the host first.';

// ---------------------------------------------------------------------------
// Status (§5.5): read-only, never initializes state or prepares a Box.

function transitionLine(barrier) {
    if (!barrier) return 'none';
    if (barrier.malformed) return `unreadable barrier (${barrier.reason}); recovery Run ploinky restart on the host to complete recovery.`;
    return `gate-on to gate-off ${barrier.barrier.operationId}, barrier-installed; recovery Run ploinky restart on the host to complete recovery.`;
}

function percentOrNone(value) {
    return value === undefined || value === null ? 'none' : String(value);
}

export function readLimitsStatus({
    identity,
    gateStore,
    env = process.env,
    homeDirectory = gateStore?.homeDirectory,
    fsApi = fs,
    observedBox = null,
    hostFacts = null,
    agentInstances = [],
}) {
    exactIdentity(identity);
    let saved = null;
    let savedProblem = null;
    try {
        saved = gateStore.read(identity);
    } catch (error) {
        savedProblem = error.message;
    }
    const paths = hardwareStorePaths({ identity, homeDirectory });
    let snapshot;
    try {
        snapshot = readStoreSnapshot({ paths, identity, fsApi });
    } catch (error) {
        snapshot = { status: 'unreadable', agents: new Map(), diagnostic: error.message, token: null };
    }
    const barrier = snapshot.status === 'absent-never-initialized' ? null : readBarrier({ paths, fsApi });
    const lockOwner = snapshot.status === 'absent-never-initialized' ? null : readStoreLockOwner(paths.storeRoot, { fsApi });
    const envValue = env?.[HARDWARE_GATE_ENV];
    return Object.freeze({
        identity: identity.instance,
        gate: savedProblem
            ? { state: 'unknown', savedAt: null, problem: savedProblem }
            : saved ? { state: saved.enabled ? 'on' : 'off', savedAt: saved.savedAt } : { state: 'off', savedAt: null, neverSet: true },
        envNote: envValue !== undefined && String(envValue).trim() !== ''
            ? `${HARDWARE_GATE_ENV}=${String(envValue).trim()} is set; only start, restart and update apply it`
            : null,
        hardwareState: snapshot.status === 'absent-never-initialized'
            ? 'legacy'
            : snapshot.status === 'valid' ? 'initialized' : `unreadable: ${snapshot.diagnostic}`,
        token: snapshot.token,
        transition: barrier,
        storeLock: lockOwner,
        hostFacts,
        box: observedBox,
        agents: [...snapshot.agents].sort(([a], [b]) => a.localeCompare(b)).map(([ref, entry]) => ({
            ref,
            entry,
            instances: agentInstances.filter((instance) => instance.ref === ref),
        })),
    });
}

export function formatLimitsStatus(status) {
    const lines = [];
    lines.push(`Workspace identity: ${status.identity}`);
    const gate = status.gate;
    lines.push(`Hardware limits: ${gate.state === 'unknown' ? `unknown (${gate.problem})`
        : gate.neverSet ? 'off (never set)' : `${gate.state} (saved ${gate.savedAt})`}`);
    if (status.envNote) lines.push(`Note: ${status.envNote}`);
    lines.push(`Hardware state: ${status.hardwareState}`);
    lines.push(`Transition: ${transitionLine(status.transition)}`);
    const host = status.hostFacts;
    lines.push(`Host delegation: cgroup ${host?.cgroupVersion || 'unknown'}; outer OCI runtime ${host?.ociRuntime || 'unknown'}; controllers ${host?.controllers?.length ? host.controllers.join(' ') : 'unknown'}`);
    const box = status.box;
    const boxState = box?.state || 'absent';
    lines.push(`Box: ${boxState}; wiring ${box?.wiring ? String(box.wiring).slice(0, 12) : 'none'}; prepared ${box?.prepared === true ? 'yes' : `no: ${box?.preparedReason || (boxState === 'running' ? 'not observed from the host' : 'the Box is not running')}`}`);
    // A host invocation cannot invent in-Box mount or controller facts.
    lines.push(`Box mount: cgroup2 ${box?.mount?.cgroup2 ?? 'unknown'}; rw ${box?.mount?.rw ?? 'unknown'}; nsdelegate ${box?.mount?.nsdelegate ?? 'unknown'}`);
    lines.push(`Nested backend: ${box?.nested?.runtime || 'unknown'}; manager ${box?.nested?.manager || 'unknown'}; controllers ${box?.nested?.controllers?.length ? box.nested.controllers.join(' ') : 'unknown'}`);
    lines.push(`Internal helpers: ${box?.helpers || 'not observed'}`);
    lines.push(`GPU sharing: best-effort, not a security boundary; daemon ${box?.mps?.daemon || 'not started'}`);
    lines.push(`MPS defaults: ${box?.mps?.defaults || 'none'}`);
    if (status.storeLock) {
        lines.push(`Store lock: held by ${status.storeLock.malformed ? `an unrecognized owner (${status.storeLock.reason})` : `${status.storeLock.owner.operation} since ${status.storeLock.owner.acquiredAt}`}`);
    }
    for (const agent of status.agents) {
        const entry = agent.entry;
        const gpu = entry.gpu ? `${entry.gpu.smPercent}/${entry.gpu.vramPercent} percent` : 'none';
        const instances = agent.instances.length ? agent.instances : [{ key: 'not enabled', alias: null }];
        for (const instance of instances) {
            lines.push(`Agent: ${agent.ref} [${instance.key}] alias ${instance.alias || 'none'}; cpu ${percentOrNone(entry.cpus)}; RAM ${entry.memoryPercent !== undefined ? `${entry.memoryPercent}%` : 'declared'} (${instance.memoryBytes ?? 'none'}); GPU ${gpu}`);
            lines.push(`  Availability: ${instance.availability || 'stopped'}`);
            lines.push(`  Limits: ${instance.limitsState || 'pending'}`);
            if (instance.fix) lines.push(`  Fix: ${instance.fix}`);
        }
    }
    return `${lines.join('\n')}\n`;
}

/**
 * Host recovery: clear one agent's override or every entry. Requires the host
 * workspace mutation lock (supplied by the caller) and needs no router.
 */
export function runLimitsClear({ identity, lock, agentRef = null, all = false, homeDirectory = os.homedir(), fsApi = fs, actor }) {
    exactIdentity(identity);
    if (typeof lock?.assertHeld !== 'function') {
        throw gateError('Clearing hardware limits requires the workspace mutation lock', 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
    }
    lock.assertHeld(identity.instance);
    assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
    assertHardwareStateConfined({ workspaceRoot: identity.workspaceRoot, dataPaths: identity.dataPaths, homeDirectory, fsApi });
    const paths = hardwareStorePaths({ identity, homeDirectory });
    const hostActor = actor || { id: 'host', name: os.userInfo().username };
    if (all) return clearAllLimits({ paths, identity, actor: hostActor, fsApi });
    const snapshot = readStoreSnapshot({ paths, identity, fsApi });
    if (snapshot.status === 'absent-never-initialized') {
        // Clearing a never-initialized store is an already-empty no-op and
        // does not create hardware state.
        return Object.freeze({ committed: false, cleared: false, token: null, absent: true });
    }
    if (snapshot.status !== 'valid') {
        throw gateError(`The hardware policy store cannot be read safely: ${snapshot.diagnostic}. Selective clear cannot preserve the other entries; run ploinky limits clear --all.`, 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
    }
    return clearAgentLimits({ paths, identity, agentRef, actor: hostActor, fsApi });
}

// ---------------------------------------------------------------------------
// Box wiring (plan §4): a gate-on Box gets one label, the read-only identity
// marker and the read-write private store bind. A gate-off Box gets none of
// them, so its create arguments, labels and mounts are unchanged.

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function directoryIdentity(fsApi, target) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw gateError(`hardware store is not a real directory: ${target}`, 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
    }
    return { dev: String(stat.dev), ino: String(stat.ino) };
}

export function hardwareGenerationDirectory(identity, fingerprint, homeDirectory = os.homedir()) {
    exactIdentity(identity);
    if (!/^[a-f0-9]{64}$/.test(String(fingerprint))) {
        throw gateError('hardware wiring fingerprint is invalid', 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
    }
    return path.join(hardwareStateRoot(homeDirectory), identity.instance, fingerprint);
}

/**
 * The exact wiring for a gate-on Box. The host initializes the store before
 * the first gate-on Box exists, records its canonical path and filesystem
 * identity, and writes an immutable marker under the wiring fingerprint.
 * Replacing the store directory changes the fingerprint and so the Box.
 */
export function resolveDesiredHardwareWiring({
    identity,
    enabled,
    hostKind = 'native-linux',
    homeDirectory = os.homedir(),
    fsApi = fs,
    initializeStore,
}) {
    if (!enabled) return null;
    exactIdentity(identity);
    assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
    assertHardwareStateConfined({ workspaceRoot: identity.workspaceRoot, dataPaths: identity.dataPaths, homeDirectory, fsApi });
    const paths = hardwareStorePaths({ identity, homeDirectory });
    const snapshot = initializeStore({ paths, identity, fsApi });
    if (snapshot.status !== 'valid') {
        throw gateError(`The hardware policy store cannot be read safely: ${snapshot.diagnostic}`, 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
    }
    const storeRoot = fsApi.realpathSync.native(paths.storeRoot);
    const marker = {
        schema: 1,
        instance: identity.instance,
        pathHash: identity.pathHash,
        workspaceRoot: identity.workspaceRoot,
        hostKind,
        storeId: snapshot.storeId,
        storeDirectory: { path: storeRoot, ...directoryIdentity(fsApi, storeRoot) },
    };
    const bytes = `${canonicalJson(marker)}\n`;
    const fingerprint = crypto.createHash('sha256').update(bytes).digest('hex');
    const generation = hardwareGenerationDirectory(identity, fingerprint, homeDirectory);
    fsApi.mkdirSync(path.dirname(generation), { recursive: true, mode: 0o700 });
    ensurePrivateDirectory(fsApi, path.dirname(generation), STATE_FILES);
    ensurePrivateDirectory(fsApi, generation, STATE_FILES);
    const markerPath = path.join(generation, 'marker.json');
    const existing = readPrivateFile(fsApi, markerPath, 4096, 'Hardware-limits marker', STATE_FILES);
    if (existing === null) {
        writePrivateFileAtomically(fsApi, generation, markerPath, bytes, () => {}, STATE_FILES);
    } else if (existing.toString('utf8') !== bytes) {
        throw gateError(`Hardware-limits marker does not match its generation: ${markerPath}`, 'PLOINKY_BOX_HARDWARE_STATE_INVALID');
    }
    return Object.freeze({
        fingerprint,
        markerPath,
        storeRoot,
        storeId: snapshot.storeId,
        mounts: Object.freeze([
            Object.freeze({ source: markerPath, destination: BOX_HARDWARE_MARKER_PATH, rw: false }),
            Object.freeze({ source: storeRoot, destination: BOX_HARDWARE_STORE_PATH, rw: true }),
        ]),
    });
}

export function hardwareWiringCreateArgs(wiring) {
    if (!wiring) return Object.freeze({ volumes: [], labels: {} });
    return Object.freeze({
        volumes: wiring.mounts.flatMap((mount) => ['--volume', `${mount.source}:${mount.destination}${mount.rw ? '' : ':ro'}`]),
        labels: { [BOX_LABELS.hardwareLimits]: wiring.fingerprint },
    });
}

function isHardwareMountDestination(destination) {
    return destination === BOX_HARDWARE_MARKER_PATH || destination === BOX_HARDWARE_STORE_PATH;
}

function wiringObservationError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_PUBLICATION_INCOMPATIBLE' });
}

/**
 * Reconstruct the hardware wiring an owned Box records, from its own label and
 * mounts. A gate-off Box carries neither; any hardware mount without the label
 * (or the reverse) is incompatible.
 */
export function observeContainerHardwareWiring(containerHandle, { homeDirectory = os.homedir(), identity = null } = {}) {
    const labels = containerHandle?.labels || {};
    const runtime = containerHandle?.runtime || {};
    const mounts = (Array.isArray(runtime.mounts) ? runtime.mounts : [])
        .filter((mount) => isHardwareMountDestination(String(mount.destination || '')));
    if (!Object.hasOwn(labels, BOX_LABELS.hardwareLimits)) {
        if (mounts.length) throw wiringObservationError('Owned Box has hardware-limits mounts without its wiring label');
        return null;
    }
    const fingerprint = String(labels[BOX_LABELS.hardwareLimits]);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw wiringObservationError('Owned Box hardware-limits label is invalid');
    const marker = mounts.find((mount) => mount.destination === BOX_HARDWARE_MARKER_PATH);
    const store = mounts.find((mount) => mount.destination === BOX_HARDWARE_STORE_PATH);
    if (mounts.length !== 2 || !marker || !store) {
        throw wiringObservationError('Owned Box hardware-limits wiring must have exactly the marker and store binds');
    }
    if (String(marker.type).toLowerCase() !== 'bind' || marker.rw === true) {
        throw wiringObservationError('Owned Box hardware-limits marker is not a read-only bind');
    }
    if (String(store.type).toLowerCase() !== 'bind' || store.rw !== true) {
        throw wiringObservationError('Owned Box hardware-limits store is not a read-write bind');
    }
    if (identity) {
        const generation = hardwareGenerationDirectory(identity, fingerprint, homeDirectory);
        if (marker.source !== path.join(generation, 'marker.json')) {
            throw wiringObservationError('Owned Box hardware-limits marker is not its generation marker');
        }
    }
    return Object.freeze({
        fingerprint,
        markerPath: String(marker.source),
        storeRoot: String(store.source),
        storeId: null,
        mounts: Object.freeze([
            Object.freeze({ source: String(marker.source), destination: BOX_HARDWARE_MARKER_PATH, rw: false }),
            Object.freeze({ source: String(store.source), destination: BOX_HARDWARE_STORE_PATH, rw: true }),
        ]),
    });
}

export function sameHardwareWiring(left, right) {
    return (left?.fingerprint ?? null) === (right?.fingerprint ?? null);
}
