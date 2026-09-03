import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { debugLog } from '../../utils/utils.js';
import { PLOINKY_DIR } from '../../utils/config.js';
import { loadAgents } from '../../utils/workspace.js';
import {
    containerExists,
    getRuntime,
    isContainerRunning,
    isSandboxRuntime,
    loadAgentsMap,
    probeContainerRuntime
} from './common.js';
import { clearLivenessState, retireRuntimeRelaySocket } from './healthProbes.js';
import { stopBwrapProcesses, isBwrapProcessRunning } from '../bwrap/bwrapFleet.js';
import {
    withNetworkLifecycleLock,
    workspaceNetworkIdentity,
} from '../networkLifecycle.js';
import { assertExactContainerOwnership } from './containerOwnership.js';

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

function defaultPause(milliseconds) {
    if (!(milliseconds > 0)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
    retireRelay = retireRuntimeRelaySocket,
} = {}) {
    const expectedId = String(record?.containerId || '').trim();
    if (!/^[a-f0-9]{64}$/.test(expectedId)) {
        throw new Error(`fleet lifecycle for '${name}' requires its immutable registry container ID`);
    }
    if (record?.type !== 'agent'
        || !String(record?.instanceId || '').trim()
        || !String(record?.enableGeneration || '').trim()) {
        throw new Error(`fleet lifecycle for '${name}' requires a complete managed-agent registry identity`);
    }
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
            // Retire the projected pathname while the producer is still alive.
            // On macOS nested Podman, metadata and unlink can both become
            // permanently unsupported after the owning container exits.
            retireRelay(name);
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
    const runtime = options.runtime || getRuntime();
    return removeExactContainerAndDescriptor(name, record, runtime, {
        ...options,
        remove: true,
    });
}

function chunkArray(list, size = 8) {
    const chunks = [];
    if (!Array.isArray(list) || size <= 0) return chunks;
    for (let i = 0; i < list.length; i += size) {
        chunks.push(list.slice(i, i + size));
    }
    return chunks;
}

function gracefulStopContainer(name, { prefix = '[destroy]' } = {}) {
    const exists = containerExists(name);
    if (!exists) return false;

    const log = (msg) => console.log(`${prefix} ${msg}`);
    if (!isContainerRunning(name)) {
        log(`${name} already stopped.`);
        return true;
    }

    try {
        const runtime = getRuntime();
        log(`Sending SIGTERM to ${name}...`);
        execSync(`${runtime} kill --signal SIGTERM ${name}`, { stdio: 'ignore' });
    } catch (e) {
        debugLog(`gracefulStopContainer SIGTERM ${name}: ${e?.message || e}`);
    }
    return true;
}

function waitForContainers(names, timeoutSec = 5) {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        const stillRunning = names.filter((name) => isContainerRunning(name));
        if (!stillRunning.length) return [];
        try { execSync('sleep 1', { stdio: 'ignore' }); } catch (_) { }
    }
    return names.filter((name) => isContainerRunning(name));
}

function forceStopContainers(names, { prefix } = {}) {
    if (!Array.isArray(names) || !names.length) return;
    const runtime = getRuntime();
    for (const chunk of chunkArray(names)) {
        try {
            console.log(`${prefix} Forcing kill for ${chunk.join(', ')}...`);
            execSync(`${runtime} kill ${chunk.join(' ')}`, { stdio: 'ignore' });
        } catch (e) {
            debugLog(`forceStopContainers kill ${chunk.join(', ')}: ${e?.message || e}`);
            for (const name of chunk) {
                try {
                    console.log(`${prefix} Forcing kill for ${name}...`);
                    execSync(`${runtime} kill ${name}`, { stdio: 'ignore' });
                } catch (err) {
                    debugLog(`forceStopContainers (single) kill ${name}: ${err?.message || err}`);
                }
            }
        }
    }
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

    // Handle sandbox (bwrap/seatbelt) agents first
    const bwrapStopped = [];
    const bwrapEntries = [];
    const containerEntries = [];
    for (const [name, rec] of entries) {
        if (isSandboxRuntime(rec?.runtime)) {
            const agentName = rec.agentName || name;
            if (isBwrapProcessRunning(name)) {
                bwrapEntries.push({ name, runtimeKey: name, agentName, runtime: rec.runtime });
            } else {
                console.log(`[stop] ${agentName}: no running ${rec.runtime} process found.`);
            }
        } else {
            containerEntries.push([name, rec]);
        }
    }
    if (bwrapEntries.length) {
        const stoppedSandboxRuntimes = new Set(stopBwrapProcesses(bwrapEntries.map((entry) => entry.runtimeKey), {
            timeout: fast ? 100 : 5000
        }));
        for (const entry of bwrapEntries) {
            if (!stoppedSandboxRuntimes.has(entry.runtimeKey)) continue;
            console.log(`[stop] Stopped ${entry.agentName} (${entry.runtime})`);
            bwrapStopped.push(entry.name);
        }
    }

    // Handle container agents. Registry names are diagnostic only: every
    // signal targets a revalidated immutable container ID while the shared
    // network lifecycle lock is held.
    const stoppedContainers = [];
    let runtime = null;
    for (const [name, rec] of containerEntries) {
        try {
            runtime ||= getRuntime();
            const result = removeExactContainerAndDescriptor(name, rec, runtime, {
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
    return [...bwrapStopped, ...stoppedContainers];
}

function stopAndRemoveMany(names, { fast = false, records = null } = {}) {
    if (!Array.isArray(names) || !names.length) return [];

    const agents = {
        ...(loadAgents() || {}),
        ...(records && typeof records === 'object' ? records : {})
    };

    // Handle sandbox (bwrap/seatbelt) agents first
    const bwrapEntries = [];
    const containerNames = [];
    for (const agentName of names) {
        if (!agentName) continue;
        const rec = agents ? agents[agentName] : null;
        if (isSandboxRuntime(rec?.runtime)) {
            bwrapEntries.push({ agentName, runtimeKey: agentName });
            continue;
        }
        containerNames.push(agentName);
    }
    if (bwrapEntries.length) {
        stopBwrapProcesses(bwrapEntries.map((entry) => entry.runtimeKey), {
            timeout: fast ? 100 : 5000
        });
    }
    const bwrapRemoved = bwrapEntries.map((entry) => entry.agentName);

    const prefix = fast ? '[destroy-fast]' : '[destroy]';
    let runtime = null;
    const removed = [];
    for (const name of containerNames) {
        const record = agents?.[name];
        if (!record) {
            console.log(`${prefix} Preserved ${name}: no exact registry record.`);
            continue;
        }
        try {
            runtime ||= getRuntime();
            const result = removeExactContainerAndDescriptor(name, record, runtime, {
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

    return [...bwrapRemoved, ...removed];
}

function stopAndRemove(name, fastOrOptions = false) {
    if (!name) return [];
    const options = fastOrOptions && typeof fastOrOptions === 'object'
        ? fastOrOptions
        : { fast: fastOrOptions };
    return stopAndRemoveMany([name], options) || [];
}

function listAllContainerNames() {
    const runtime = probeContainerRuntime();
    if (!runtime) return [];
    try {
        const out = execSync(`${runtime} ps -a --format "{{.Names}}"`, { stdio: 'pipe' }).toString().trim();
        return out ? out.split(/\n+/).filter(Boolean) : [];
    } catch (e) {
        debugLog(`listAllContainerNames error: ${e?.message || e}`);
        return [];
    }
}

function destroyAllPloinky({ fast = false } = {}) {
    const names = listAllContainerNames().filter((n) => n.startsWith('ploinky_'));
    return stopAndRemoveMany(names, { fast }).length;
}

function destroyWorkspaceContainers({ fast = false } = {}) {
    const agents = loadAgentsMap();
    const names = [];
    for (const [name, rec] of Object.entries(agents || {})) {
        if (!rec || typeof name !== 'string' || name.startsWith('_')) continue;
        if (rec.type === 'agent' || rec.type === 'agentCore') {
            names.push(name);
        }
    }
    // stopAndRemoveMany now handles bwrap agents internally
    return stopAndRemoveMany(names, { fast });
}

const SESSION = new Set();

function addSessionContainer(name) {
    if (name) {
        try { SESSION.add(name); } catch (_) { }
    }
}

function cleanupSessionSet() {
    const list = Array.from(SESSION);
    stopAndRemoveMany(list);
    SESSION.clear();
    return list.length;
}

export {
    addSessionContainer,
    cleanupSessionSet,
    destroyAllPloinky,
    destroyWorkspaceContainers,
    forceStopContainers,
    getContainerCandidates,
    gracefulStopContainer,
    listAllContainerNames,
    removeExactContainerAndDescriptor,
    stopAndRemove,
    stopAndRemoveMany,
    removeExactRegisteredContainer,
    stopConfiguredAgents,
    waitForContainers
};
