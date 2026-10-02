// The hardware facts admission needs inside a Box (plan §5.1, §7, §8.1):
// the gate (from the read-only marker), the policy store snapshot and its
// per-agent overrides, the visible envelope and the delegation proof. Reads
// are bounded; nothing here mutates policy or prepares the Box.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { BOX_HARDWARE_MARKER_PATH, BOX_HARDWARE_STORE_PATH } from '../../../ploinky-box/constants.mjs';
import { readBoxHardwareMarker } from '../../../ploinky-box/lib/hardwareLimitsMarker.mjs';
import { readDelegationState } from './delegation.mjs';
import { readEnvelope } from './resolve.mjs';
import { readMpsStatus } from './mpsStatus.mjs';
import { hardwareStorePaths, readStoreSnapshot } from './store.mjs';

const BACKEND_CACHE_MS = 60_000;
let backendCache = null;

function readOptional(fsApi, target) {
    try {
        return String(fsApi.readFileSync(target, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        return null;
    }
}

function defaultQuery(command, args, { timeoutMs = 10_000 } = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return { ok: result.status === 0 && !result.error, status: result.status, stdout: String(result.stdout || '') };
}

export function resetHardwareContextCacheForTests() {
    backendCache = null;
}

/**
 * Inside a Box: gate off when the marker is absent; when present the store
 * must be readable to prove the absence (or presence) of stored limits.
 */
export function readBoxHardwareContext({
    fsApi = fs,
    markerPath = BOX_HARDWARE_MARKER_PATH,
    storeRoot = BOX_HARDWARE_STORE_PATH,
    cgroupRoot = '/sys/fs/cgroup',
    procRoot = '/proc',
    query = defaultQuery,
    now = () => Date.now(),
    refreshBackend = false,
} = {}) {
    const marker = readBoxHardwareMarker({ markerPath, fsApi });
    if (!marker.present) {
        return { gate: 'off', prepared: false, backendReady: false, controllers: [], storeState: 'none' };
    }
    if (!marker.valid) {
        return {
            gate: 'on', prepared: false, backendReady: false, controllers: [], storeState: 'unreadable',
            storeDetail: marker.problem, unpreparedDetail: marker.problem,
        };
    }
    const identity = { instance: marker.marker.instance, pathHash: marker.marker.pathHash, workspaceRoot: marker.marker.workspaceRoot };
    let snapshot;
    try {
        snapshot = readStoreSnapshot({ paths: hardwareStorePaths({ identity, context: 'box', boxRoot: storeRoot }), identity, fsApi });
    } catch (error) {
        snapshot = { status: 'unreadable', diagnostic: error.message, agents: new Map(), token: null };
    }
    if (snapshot.status === 'valid' && snapshot.storeId !== marker.marker.storeId) {
        snapshot = { status: 'unreadable', diagnostic: 'the bound store is not the store this Box was wired to', agents: new Map(), token: null };
    }
    let delegation;
    if (!refreshBackend && backendCache && now() - backendCache.at < BACKEND_CACHE_MS) {
        delegation = backendCache.value;
    } else {
        delegation = readDelegationState({ gate: 'on', fsApi, cgroupRoot, procRoot, query });
        backendCache = { at: now(), value: delegation };
    }
    const envelope = readEnvelope({
        procMeminfo: readOptional(fsApi, `${procRoot}/meminfo`),
        memoryMax: readOptional(fsApi, `${cgroupRoot}/memory.max`),
        cpuMax: readOptional(fsApi, `${cgroupRoot}/cpu.max`),
        cpuParallelism: typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length,
    });
    const runtimeObserved = delegation.backend
        ? `unknown/unknown/${delegation.backend.runtime}/${delegation.backend.manager}`
        : '';
    return {
        gate: 'on',
        prepared: delegation.structurallyPrepared === true,
        backendReady: delegation.backendReady === true,
        controllers: delegation.controllers || [],
        // The host discovery produces 'native-linux' or 'podman-machine';
        // a Podman machine is the macOS host (its delegation fix differs).
        hostKind: marker.marker.hostKind === 'podman-machine' ? 'macos' : 'linux',
        // cgroup (Box mount), placement, runtime (nested backend) or parents.
        unpreparedKind: delegation.backendReady ? '' : String(delegation.kind || ''),
        unpreparedDetail: delegation.reason || '',
        runtimeObserved,
        storeState: snapshot.status === 'valid' ? 'valid' : 'unreadable',
        storeDetail: snapshot.status === 'valid' ? '' : String(snapshot.diagnostic || ''),
        storeToken: snapshot.token || null,
        overrides: snapshot.agents,
        ...([...snapshot.agents?.values() || []].some((entry) => entry.gpu) ? { gpu: readMpsStatus({ workspaceRoot: identity.workspaceRoot }) } : {}),
        envelope: envelope.unreadable ? null : envelope,
        envelopeProblem: envelope.unreadable ? envelope.reason : null,
    };
}
