import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PLOINKY_DIR } from '../../utils/config.js';
import { loadAgents } from '../../utils/workspace.js';
import {
    loadAgentsMap,
} from './common.js';
import { clearLivenessState } from './healthProbes.js';
import { stopBwrapProcesses, isBwrapProcessRunning } from '../bwrap/bwrapFleet.js';
import {
    NETWORK_LABELS,
    withNetworkLifecycleLock,
    workspaceNetworkIdentity,
} from '../networkLifecycle.js';
import { NETWORK_SCHEMA_VERSION } from '../networkContract.js';

const GENERATED_ROUTER_DESCRIPTOR_TARGET = '/run/ploinky/router-descriptor.json';
const GENERATED_ROUTER_DESCRIPTOR_ROOT = path.join(PLOINKY_DIR, 'run', 'router-descriptors');
const CONTROL_TIMEOUT_MS = 5_000;

function runContainerControl(runtime, args) {
    return spawnSync(runtime, args, {
        encoding: 'utf8',
        timeout: CONTROL_TIMEOUT_MS,
        maxBuffer: 128 * 1024,
        killSignal: 'SIGKILL',
    });
}

function inspectExactContainer(runtime, identifier) {
    const result = runContainerControl(runtime, ['container', 'inspect', identifier]);
    if (result.error) throw result.error;
    if (result.status !== 0) return null;
    let parsed;
    try { parsed = JSON.parse(String(result.stdout || '')); } catch (error) {
        throw new Error(`container inspection returned malformed JSON: ${error.message}`);
    }
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    return record && typeof record === 'object' ? record : null;
}

function captureRecordedGeneratedRouterDescriptor(record) {
    const binds = (record?.config?.binds || []).filter((bind) => (
        bind?.generatedRouterDescriptor === true
        || String(bind?.target || '') === GENERATED_ROUTER_DESCRIPTOR_TARGET
    ));
    if (!binds.length) return null;
    if (binds.length !== 1
        || binds[0]?.generatedRouterDescriptor !== true
        || binds[0]?.ro !== true
        || String(binds[0]?.target || '') !== GENERATED_ROUTER_DESCRIPTOR_TARGET) {
        throw new Error('generated Router descriptor registry ownership is ambiguous');
    }
    const source = path.resolve(String(binds[0]?.source || ''));
    const root = path.resolve(GENERATED_ROUTER_DESCRIPTOR_ROOT);
    const relative = path.relative(root, source);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i.test(relative)
        || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw new Error('generated Router descriptor registry source is outside its runtime-owned root');
    }
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('generated Router descriptor registry source is not an exact 0600 regular file');
    }
    const realRoot = fs.realpathSync.native(root);
    const realSource = fs.realpathSync.native(source);
    if (realSource !== path.join(realRoot, relative)) {
        throw new Error('generated Router descriptor registry source failed real-path confinement');
    }
    return Object.freeze({ source, dev: stat.dev, ino: stat.ino });
}

function labelsOf(record) {
    return record?.Config?.Labels || record?.Labels || record?.labels || {};
}

function defaultPause(milliseconds) {
    if (!(milliseconds > 0)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function exactRegistryText(value) {
    return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function classifyExactAgentRuntime(name, record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.type !== 'agent') {
        throw new Error(`fleet lifecycle for '${name}' requires a current managed-agent registry record`);
    }
    if (!exactRegistryText(record.instanceId) || !exactRegistryText(record.enableGeneration)) {
        throw new Error(`fleet lifecycle for '${name}' requires a complete managed-agent registry identity`);
    }
    if (record.runtime === 'podman') {
        if (typeof record.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(record.containerId)) {
            throw new Error(`fleet lifecycle for '${name}' requires its immutable registry container ID`);
        }
        return 'podman';
    }
    if (record.runtime === 'bwrap' || record.runtime === 'seatbelt') return record.runtime;
    throw new Error(
        `fleet lifecycle for '${name}' runtime must be exactly 'podman', 'bwrap', or 'seatbelt'`,
    );
}

function sandboxRuntimeIdentity(record) {
    return Object.freeze({
        instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
    });
}

function assertExactContainerOwnership(name, record, inspected, expectedId, workspaceHash) {
    const actualId = String(inspected?.Id || inspected?.ID || '');
    const actualName = String(inspected?.Name || '').replace(/^\//, '');
    if (actualId !== expectedId || actualName !== name) {
        throw new Error(`fleet lifecycle for '${name}' could not prove exact immutable container identity`);
    }
    if (record?.type !== 'agent') {
        throw new Error(`fleet lifecycle for '${name}' requires a current managed-agent registry record`);
    }
    const expectedInstanceId = record?.instanceId;
    const expectedEnableGeneration = record?.enableGeneration;
    const labels = labelsOf(inspected);
    if (!expectedInstanceId || !expectedEnableGeneration
        || labels?.[NETWORK_LABELS.managed] !== '1'
        || labels?.[NETWORK_LABELS.resource] !== 'agent'
        || labels?.[NETWORK_LABELS.schema] !== NETWORK_SCHEMA_VERSION
        || labels?.[NETWORK_LABELS.workspace] !== workspaceHash
        || !/^[a-f0-9]{64}$/.test(String(labels?.[NETWORK_LABELS.contract] || ''))
        || String(labels?.[NETWORK_LABELS.instanceId] || '') !== expectedInstanceId
        || String(labels?.[NETWORK_LABELS.enableGeneration] || '') !== expectedEnableGeneration
        || inspected?.HostConfig?.Init !== true) {
        throw new Error(`fleet lifecycle for '${name}' could not prove exact managed ownership labels and runtime identity`);
    }
    return inspected;
}

function assertExactDescriptorMount(name, inspected, artifact) {
    const descriptorMounts = (inspected?.Mounts || []).filter((mount) => (
        String(mount?.Destination || '') === GENERATED_ROUTER_DESCRIPTOR_TARGET
    ));
    if (!artifact) {
        if (descriptorMounts.length) {
            throw new Error(`fleet lifecycle for '${name}' found an unrecorded generated Router descriptor mount`);
        }
        return;
    }
    if (descriptorMounts.length !== 1
        || descriptorMounts[0]?.RW !== false
        || path.resolve(String(descriptorMounts[0]?.Source || '')) !== artifact.source) {
        throw new Error(`descriptor cleanup for '${name}' could not prove exact container/mount ownership`);
    }
}

function controlSucceeded(result) {
    return !result?.error && result?.status === 0;
}

function removeExactContainerAndDescriptor(name, record, runtime, {
    fast = false,
    remove = true,
    inspect = inspectExactContainer,
    control = runContainerControl,
    withLock = withNetworkLifecycleLock,
    pause = defaultPause,
    now = Date.now,
    workspaceIdentity = workspaceNetworkIdentity,
} = {}) {
    if (runtime !== 'podman' || record?.runtime !== 'podman') {
        throw new Error(`fleet lifecycle for '${name}' runtime must be exactly 'podman'`);
    }
    classifyExactAgentRuntime(name, record);
    const expectedId = record.containerId;
    return withLock(() => {
        const artifact = captureRecordedGeneratedRouterDescriptor(record);
        const workspaceHash = String(workspaceIdentity()?.hash || '');
        if (!workspaceHash) {
            throw new Error(`fleet lifecycle for '${name}' could not resolve the workspace identity`);
        }
        let inspected = inspect(runtime, expectedId);
        if (!inspected) {
            // Without a live immutable-ID inspection there is no container
            // ownership evidence that permits deleting even a recorded
            // descriptor artifact. Preserve both registry state and artifact.
            return Object.freeze({ found: false, stopped: false, removed: false });
        }

        const revalidate = () => {
            const current = inspect(runtime, expectedId);
            if (!current) return null;
            assertExactContainerOwnership(name, record, current, expectedId, workspaceHash);
            assertExactDescriptorMount(name, current, artifact);
            return current;
        };
        inspected = assertExactContainerOwnership(name, record, inspected, expectedId, workspaceHash);
        assertExactDescriptorMount(name, inspected, artifact);

        if (inspected?.State?.Running === true) {
            const signaled = control(runtime, ['kill', '--signal', 'SIGTERM', expectedId]);
            if (!controlSucceeded(signaled)) {
                const raced = revalidate();
                if (raced) throw new Error(`fleet lifecycle for '${name}' could not send SIGTERM by immutable ID`);
            }
        }

        const deadline = now() + (fast ? 100 : 5_000);
        inspected = revalidate();
        while (inspected?.State?.Running === true && now() < deadline) {
            pause(Math.min(fast ? 10 : 100, Math.max(1, deadline - now())));
            inspected = revalidate();
        }
        if (inspected?.State?.Running === true) {
            const killed = control(runtime, ['kill', expectedId]);
            if (!controlSucceeded(killed)) {
                const raced = revalidate();
                if (raced) throw new Error(`fleet lifecycle for '${name}' could not force-stop by immutable ID`);
            }
            inspected = revalidate();
            if (inspected?.State?.Running === true) {
                throw new Error(`fleet lifecycle for '${name}' remained running after immutable-ID kill`);
            }
        }

        if (!remove) {
            return Object.freeze({ found: true, stopped: true, removed: false });
        }
        inspected = revalidate();
        if (inspected) {
            const removed = control(runtime, ['rm', '-f', expectedId]);
            if (!controlSucceeded(removed) || inspect(runtime, expectedId)) {
                throw new Error(`descriptor cleanup for '${name}' could not prove exact container removal`);
            }
        }
        if (artifact) {
            const current = fs.lstatSync(artifact.source);
            if (!current.isFile() || current.isSymbolicLink()
                || current.dev !== artifact.dev || current.ino !== artifact.ino) {
                throw new Error(`descriptor cleanup for '${name}' detected artifact identity drift`);
            }
            fs.unlinkSync(artifact.source);
        }
        return Object.freeze({ found: true, stopped: true, removed: true });
    });
}

function removeExactRegisteredContainer(name, record, options = {}) {
    if (options.runtime !== 'podman') {
        throw new Error(`fleet lifecycle for '${name}' runtime must be exactly 'podman'`);
    }
    return removeExactContainerAndDescriptor(name, record, 'podman', {
        ...options,
        remove: true,
    });
}

function getContainerCandidates(name, rec) {
    // Registry keys are the exact runtime identifiers. Expanding an alias into
    // a derived canonical name can stop or delete a different current runtime
    // without any ownership proof.
    return name ? [name] : [];
}

function stopConfiguredAgents({ fast = false } = {}) {
    const agents = loadAgents();
    const entries = Object.entries(agents || {})
        .filter(([name, rec]) => rec && (rec.type === 'agent' || rec.type === 'agentCore') && typeof name === 'string' && !name.startsWith('_'));

    const sandboxStopped = [];
    const sandboxEntries = [];
    const podmanEntries = [];
    for (const [name, rec] of entries) {
        try {
            const runtime = classifyExactAgentRuntime(name, rec);
            if (runtime === 'podman') {
                podmanEntries.push([name, rec]);
                continue;
            }
            const agentName = rec.agentName || name;
            const expectedIdentity = sandboxRuntimeIdentity(rec);
            if (isBwrapProcessRunning(name, expectedIdentity)) {
                sandboxEntries.push({
                    name,
                    runtimeKey: name,
                    agentName,
                    runtime,
                    expectedIdentity,
                });
            } else {
                console.log(`[stop] ${agentName}: no running ${runtime} process found.`);
            }
        } catch (error) {
            console.log(`[stop] Preserved ${name}: ${error?.message || error}`);
        }
    }
    if (sandboxEntries.length) {
        const expectedIdentities = new Map(
            sandboxEntries.map((entry) => [entry.runtimeKey, entry.expectedIdentity]),
        );
        const stoppedSandboxRuntimes = new Set(stopBwrapProcesses(
            sandboxEntries.map((entry) => entry.runtimeKey),
            { timeout: fast ? 100 : 5000, expectedIdentities },
        ));
        for (const entry of sandboxEntries) {
            if (!stoppedSandboxRuntimes.has(entry.runtimeKey)) continue;
            console.log(`[stop] Stopped ${entry.agentName} (${entry.runtime})`);
            sandboxStopped.push(entry.name);
        }
    }

    // Handle container agents. Registry names are diagnostic only: every
    // signal targets a revalidated immutable container ID while the shared
    // network lifecycle lock is held.
    const stoppedContainers = [];
    for (const [name, rec] of podmanEntries) {
        try {
            const result = removeExactContainerAndDescriptor(name, rec, 'podman', {
                fast,
                remove: false,
            });
            if (!result.found) {
                console.log(`[stop] ${rec?.agentName || name}: no exact registered container found.`);
                continue;
            }
            console.log(`[stop] Stopped ${name}`);
            clearLivenessState(name);
            stoppedContainers.push(name);
        } catch (error) {
            console.log(`[stop] Preserved ${name}: ${error?.message || error}`);
        }
    }
    return [...sandboxStopped, ...stoppedContainers];
}

function stopAndRemoveMany(names, { fast = false, records = null } = {}) {
    if (!Array.isArray(names) || !names.length) return [];

    const agents = {
        ...(loadAgents() || {}),
        ...(records && typeof records === 'object' ? records : {})
    };

    const sandboxEntries = [];
    const podmanNames = [];
    const prefix = fast ? '[destroy-fast]' : '[destroy]';
    for (const agentName of names) {
        if (!agentName) continue;
        const rec = agents ? agents[agentName] : null;
        if (!rec) {
            console.log(`${prefix} Preserved ${agentName}: no exact registry record.`);
            continue;
        }
        try {
            const runtime = classifyExactAgentRuntime(agentName, rec);
            if (runtime === 'podman') {
                podmanNames.push(agentName);
            } else {
                sandboxEntries.push({
                    agentName,
                    runtimeKey: agentName,
                    expectedIdentity: sandboxRuntimeIdentity(rec),
                });
            }
        } catch (error) {
            console.log(`${prefix} Preserved ${agentName}: ${error?.message || error}`);
        }
    }
    const sandboxRemoved = [];
    if (sandboxEntries.length) {
        const expectedIdentities = new Map(
            sandboxEntries.map((entry) => [entry.runtimeKey, entry.expectedIdentity]),
        );
        stopBwrapProcesses(sandboxEntries.map((entry) => entry.runtimeKey), {
            timeout: fast ? 100 : 5000,
            expectedIdentities,
        });
        for (const entry of sandboxEntries) {
            if (isBwrapProcessRunning(entry.runtimeKey, entry.expectedIdentity)) {
                console.log(`${prefix} Preserved ${entry.agentName}: exact sandbox runtime is still running.`);
                continue;
            }
            sandboxRemoved.push(entry.agentName);
        }
    }

    const removed = [];
    for (const name of podmanNames) {
        const record = agents?.[name];
        try {
            const result = removeExactContainerAndDescriptor(name, record, 'podman', {
                fast,
                remove: true,
            });
            if (result.removed) {
                console.log(`${prefix} ✓ removed ${name}`);
                clearLivenessState(name);
                removed.push(name);
            }
        } catch (error) {
            console.log(`${prefix} Preserved ${name}: ${error?.message || error}`);
        }
    }

    return [...sandboxRemoved, ...removed];
}

function stopAndRemove(name, fastOrOptions = false) {
    if (!name) return [];
    const options = fastOrOptions && typeof fastOrOptions === 'object'
        ? fastOrOptions
        : { fast: fastOrOptions };
    return stopAndRemoveMany([name], options) || [];
}

function destroyAllPloinky({ fast = false } = {}) {
    const agents = loadAgentsMap();
    const records = {};
    for (const [name, record] of Object.entries(agents || {})) {
        if (!name.startsWith('ploinky_') || record?.type !== 'agent') continue;
        records[name] = record;
    }
    return stopAndRemoveMany(Object.keys(records), { fast, records }).length;
}

function destroyWorkspaceContainers({ fast = false } = {}) {
    const agents = loadAgentsMap();
    const names = [];
    for (const [name, rec] of Object.entries(agents || {})) {
        if (!rec || typeof name !== 'string' || name.startsWith('_')) continue;
        if (rec.type === 'agent') {
            names.push(name);
        }
    }
    return stopAndRemoveMany(names, { fast, records: agents });
}

const SESSION = new Set();

function addSessionContainer(name) {
    if (name) {
        try { SESSION.add(name); } catch (_) { }
    }
}

function cleanupSessionSet() {
    const list = Array.from(SESSION);
    const agents = loadAgentsMap();
    stopAndRemoveMany(list, { records: agents });
    SESSION.clear();
    return list.length;
}

export {
    addSessionContainer,
    cleanupSessionSet,
    destroyAllPloinky,
    destroyWorkspaceContainers,
    getContainerCandidates,
    removeExactContainerAndDescriptor,
    stopAndRemove,
    stopAndRemoveMany,
    removeExactRegisteredContainer,
    stopConfiguredAgents
};
