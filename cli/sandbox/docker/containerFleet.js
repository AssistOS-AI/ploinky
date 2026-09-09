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
import { assertExactContainerOwnership, IMMUTABLE_CONTAINER_ID } from './containerOwnership.js';
import { deriveAgentPrincipalId } from '../../utils/security/agentIdentity.js';
import {
    buildGeneratedRouterDescriptorEnv,
    readVerifiedGeneratedRouterDescriptorFile,
} from '../../utils/security/generatedRouterDescriptor.js';

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
    if (result.status !== 0) {
        if (/no such (?:container|object)|no container with .* (?:found|exists)/i.test(String(result.stderr || ''))) {
            return null;
        }
        throw new Error('container inspection failed; check that the recorded container engine is available');
    }
    let parsed;
    try { parsed = JSON.parse(String(result.stdout || '')); } catch (_) {
        // Engine inspection contains credentials. Do not expose parser excerpts.
        throw new Error('container inspection returned malformed JSON');
    }
    const record = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('container inspection did not return one exact container record');
    }
    return record;
}

function captureRecordedGeneratedRouterDescriptor(record) {
    const configuredBinds = record?.config?.binds ?? [];
    if (!Array.isArray(configuredBinds)) {
        throw new Error('generated Router descriptor registry binds are malformed');
    }
    const binds = configuredBinds.filter((bind) => (
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
    return Object.freeze({ source, dev: stat.dev, ino: stat.ino,
        size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
}

function assertDescriptorUnchanged(name, artifact) {
    if (!artifact) return;
    const stat = fs.lstatSync(artifact.source);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
        || stat.dev !== artifact.dev || stat.ino !== artifact.ino || stat.size !== artifact.size
        || stat.mtimeMs !== artifact.mtimeMs || stat.ctimeMs !== artifact.ctimeMs) {
        throw new Error(`descriptor cleanup for '${name}' detected artifact identity drift`);
    }
}

function inspectedEnvironment(inspected) {
    const values = new Map();
    for (const rawEntry of inspected?.Config?.Env || []) {
        const entry = String(rawEntry);
        const separator = entry.indexOf('=');
        if (separator < 1) continue;
        const key = entry.slice(0, separator);
        if (values.has(key)) values.set(key, null);
        else values.set(key, entry.slice(separator + 1));
    }
    return values;
}

function assertRecoveryAgentIdentity(name, record, inspected) {
    let principal;
    try { principal = deriveAgentPrincipalId(record?.repoName, record?.agentName); } catch (_) {
        throw new Error(`reinstall recovery for '${name}' requires its registered repository and agent identity`);
    }
    const environment = inspectedEnvironment(inspected);
    for (const [key, value] of Object.entries({
        PLOINKY_AGENT_PRINCIPAL: principal,
        PLOINKY_AGENT_INSTANCE_ID: record.instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: record.enableGeneration,
    })) {
        if (environment.get(key) !== value) {
            throw new Error(`reinstall recovery for '${name}' found conflicting or missing agent launch identity (${key})`);
        }
    }
    return principal;
}

function recoverGeneratedRouterDescriptor(name, record, inspected) {
    const mounts = (inspected?.Mounts || []).filter((mount) => (
        String(mount?.Destination || '') === GENERATED_ROUTER_DESCRIPTOR_TARGET
    ));
    if (!mounts.length) return { record, artifact: null };
    if (mounts.length !== 1 || mounts[0]?.RW !== false) {
        throw new Error(`reinstall recovery for '${name}' found ambiguous generated Router descriptor mounts`);
    }
    const recoveredRecord = {
        ...record,
        config: {
            ...record.config,
            binds: [...(record.config?.binds || []), {
                source: mounts[0].Source,
                target: GENERATED_ROUTER_DESCRIPTOR_TARGET,
                ro: true,
                generatedRouterDescriptor: true,
            }],
        },
    };
    const artifact = captureRecordedGeneratedRouterDescriptor(recoveredRecord);
    const verified = readVerifiedGeneratedRouterDescriptorFile(artifact.source);
    const principal = assertRecoveryAgentIdentity(name, record, inspected);
    if (verified.identity.dev !== artifact.dev || verified.identity.ino !== artifact.ino
        || verified.payload.agentPrincipal !== principal
        || verified.payload.instanceId !== record.instanceId
        || verified.payload.generationId !== record.enableGeneration
        || path.basename(artifact.source) !== `${verified.payload.launchId}.json`) {
        throw new Error(`reinstall recovery for '${name}' could not match the signed Router descriptor to its exact launch`);
    }
    const environment = inspectedEnvironment(inspected);
    for (const [key, value] of Object.entries(buildGeneratedRouterDescriptorEnv(verified.payload))) {
        if (environment.get(key) !== value) {
            throw new Error(`reinstall recovery for '${name}' found a Router descriptor that differs from the container launch (${key})`);
        }
    }
    assertDescriptorUnchanged(name, artifact);
    return { record: recoveredRecord, artifact };
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
    recoverIncompleteIdentity = false,
    onRecoveredIdentity = null,
} = {}) {
    let expectedId = String(record?.containerId || '').trim();
    const incompleteId = !IMMUTABLE_CONTAINER_ID.test(expectedId);
    if (incompleteId && !recoverIncompleteIdentity) {
        throw new Error(`fleet lifecycle for '${name}' requires its immutable registry container ID`);
    }
    if (recoverIncompleteIdentity && !remove) {
        throw new Error(`reinstall recovery for '${name}' requires an explicit removal operation`);
    }
    if (incompleteId && expectedId && expectedId !== name && !/^[a-f0-9]{12,63}$/.test(expectedId)) {
        throw new Error(`reinstall recovery for '${name}' found a malformed registry container ID; restore the exact launch record`);
    }
    const completeRegistryIdentity = !(record?.type !== 'agent'
        || typeof record?.instanceId !== 'string' || !record.instanceId
        || record.instanceId !== record.instanceId.trim()
        || typeof record?.enableGeneration !== 'string' || !record.enableGeneration
        || record.enableGeneration !== record.enableGeneration.trim());
    if (!completeRegistryIdentity && !recoverIncompleteIdentity) {
        throw new Error(`fleet lifecycle for '${name}' requires a complete managed-agent registry identity`);
    }
    if (recoverIncompleteIdentity && record?.runtime && record.runtime !== runtime) {
        throw new Error(`reinstall recovery for '${name}' requires the recorded '${record.runtime}' container engine`);
    }
    return withLock(() => {
        const workspaceHash = String(workspaceIdentity()?.hash || '');
        if (!workspaceHash) {
            throw new Error(`fleet lifecycle for '${name}' could not resolve the workspace identity`);
        }
        // A name is only a discovery key for an incomplete legacy record. It
        // never authorizes control, and cannot replace a recorded immutable ID.
        let inspected = inspect(runtime, incompleteId ? name : expectedId);
        if (!inspected) {
            if (recoverIncompleteIdentity) {
                if (!incompleteId && inspect(runtime, name)) {
                    throw new Error(`reinstall recovery for '${name}' found a different named container while its recorded immutable ID is absent`);
                }
                return Object.freeze({ found: false, stopped: false, removed: false, state: 'absent' });
            }
            // Without a live immutable-ID inspection there is no container
            // ownership evidence that permits deleting even a recorded
            // descriptor artifact. Preserve both registry state and artifact.
            return Object.freeze({ found: false, stopped: false, removed: false });
        }

        if (!completeRegistryIdentity) {
            throw new Error(`fleet lifecycle for '${name}' requires a complete managed-agent registry identity`);
        }
        if (incompleteId) {
            const actualId = String(inspected?.Id || inspected?.ID || '');
            if (!IMMUTABLE_CONTAINER_ID.test(actualId)
                || (expectedId && expectedId !== name && !actualId.startsWith(expectedId))) {
                throw new Error(`reinstall recovery for '${name}' could not resolve its recorded container ID prefix to one exact immutable ID`);
            }
            expectedId = actualId;
        }
        let exactRecord = record;
        assertExactContainerOwnership(name, record, inspected, expectedId, workspaceHash);
        if (incompleteId) assertRecoveryAgentIdentity(name, record, inspected);
        let artifact = captureRecordedGeneratedRouterDescriptor(record);
        let recoveredDescriptor = false;
        if (!artifact && recoverIncompleteIdentity) {
            const recovered = recoverGeneratedRouterDescriptor(name, record, inspected);
            artifact = recovered.artifact;
            exactRecord = recovered.record;
            recoveredDescriptor = Boolean(artifact);
        }
        exactRecord = { ...exactRecord, containerId: expectedId, runtime };
        assertExactDescriptorMount(name, inspected, artifact);
        const recoveredIdentity = incompleteId || recoveredDescriptor;

        const revalidate = () => {
            const current = inspect(runtime, expectedId);
            if (!current) return null;
            assertExactContainerOwnership(name, exactRecord, current, expectedId, workspaceHash);
            if (recoveredIdentity) assertRecoveryAgentIdentity(name, exactRecord, current);
            assertExactDescriptorMount(name, current, artifact);
            assertDescriptorUnchanged(name, artifact);
            return current;
        };
        // Pin/reinspect after discovery and before any signal. A replacement
        // observed between name lookup and ID lookup is never adopted.
        inspected = revalidate();
        if (!inspected) {
            if (recoverIncompleteIdentity && !inspect(runtime, name)) {
                return Object.freeze({ found: false, stopped: false, removed: false, state: 'absent' });
            }
            throw new Error(`fleet lifecycle for '${name}' lost its exact container before removal; retry after checking the runtime identity`);
        }
        if (recoveredIdentity && onRecoveredIdentity) {
            onRecoveredIdentity({ containerId: expectedId, record: exactRecord });
            inspected = revalidate();
            if (!inspected) {
                throw new Error(`fleet lifecycle for '${name}' changed while recording its recovered immutable ID`);
            }
        }

        try {
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
                assertDescriptorUnchanged(name, artifact);
                fs.unlinkSync(artifact.source);
            }
            return Object.freeze({ found: true, stopped: true, removed: true,
                ...(recoveredIdentity ? { containerId: expectedId, recoveredIdentity: true } : {}) });
        } catch (error) {
            if (recoveredIdentity) error.recoveredContainerId = expectedId;
            throw error;
        }
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
