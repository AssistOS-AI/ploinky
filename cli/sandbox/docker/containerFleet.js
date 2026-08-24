import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { debugLog } from '../../utils/utils.js';
import { PLOINKY_DIR } from '../../utils/config.js';
import { loadAgents } from '../../utils/workspace.js';
import {
    containerExists,
    getAgentContainerName,
    getRuntime,
    isContainerRunning,
    isSandboxRuntime,
    listRunningContainerNames,
    loadAgentsMap,
    probeContainerRuntime
} from './common.js';
import { clearLivenessState } from './healthProbes.js';
import {
    hasBwrapPidRecord,
    hasInvalidBwrapPidRecord,
    isBwrapProcessRunning,
    stopBwrapProcesses,
} from '../bwrap/bwrapFleet.js';
import {
    NETWORK_LABELS,
    withNetworkLifecycleLock,
    workspaceNetworkIdentity,
} from '../networkLifecycle.js';
import { assertExactContainerOwnership } from './containerOwnership.js';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';

const GENERATED_ROUTER_DESCRIPTOR_TARGET = '/run/ploinky/router-descriptor.json';
const GENERATED_ROUTER_DESCRIPTOR_ROOT = path.join(PLOINKY_DIR, 'run', 'router-descriptors');
const CONTROL_TIMEOUT_MS = 5_000;
const PREPARED_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertCompletePreparedAgentRecord(name, record) {
    const agentName = String(record?.agentName || '');
    const repoName = String(record?.repoName || '');
    const alias = String(record?.alias || '');
    const instanceId = String(record?.instanceId || '');
    const enableGeneration = String(record?.enableGeneration || '');
    const createdAt = String(record?.createdAt || '');
    const projectPath = String(record?.projectPath || '');
    const runMode = String(record?.runMode || '');
    const profile = String(record?.profile || '');
    const config = record?.config;
    const expectedName = getAgentContainerName(alias || agentName, repoName);
    const complete = isPlainRecord(record)
        && agentName.trim() === agentName
        && Boolean(agentName)
        && repoName.trim() === repoName
        && Boolean(repoName)
        && alias.trim() === alias
        && name === expectedName
        && PREPARED_ID_PATTERN.test(instanceId)
        && PREPARED_ID_PATTERN.test(enableGeneration)
        && instanceId.toLowerCase() !== enableGeneration.toLowerCase()
        && Boolean(String(record.containerImage || '').trim())
        && Boolean(createdAt)
        && Number.isFinite(Date.parse(createdAt))
        && path.isAbsolute(projectPath)
        && Boolean(runMode.trim())
        && Boolean(profile.trim())
        && isPlainRecord(config)
        && Array.isArray(config.binds)
        && Array.isArray(config.env)
        && Array.isArray(config.ports);
    if (!complete) {
        throw new Error(`fleet lifecycle for '${name}' is not one complete canonical prepared-agent record`);
    }
    return Object.freeze({ name, instanceId, enableGeneration });
}

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

function captureAllContainerInventory(runtime, {
    control = runContainerControl,
    inspect = inspectExactContainer,
} = {}) {
    const listed = control(runtime, ['ps', '--all', '--quiet', '--no-trunc']);
    if (listed?.error || listed?.status !== 0) {
        const detail = String(
            listed?.error?.message
            || listed?.stderr
            || listed?.stdout
            || `exit ${listed?.status ?? 'unknown'}`,
        ).trim();
        throw new Error(`cannot inventory all configured runtimes: ${detail}`);
    }
    const ids = String(listed.stdout || '')
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
    if (new Set(ids).size !== ids.length || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
        throw new Error('all-container inventory returned malformed or duplicate immutable IDs');
    }

    const records = [];
    const names = new Set();
    for (const id of ids) {
        const record = inspect(runtime, id);
        const inspectedId = String(record?.Id || record?.ID || '').trim();
        const name = String(record?.Name || record?.Names?.[0] || '')
            .trim()
            .replace(/^\//, '');
        if (!record || inspectedId !== id || !name || names.has(name)) {
            throw new Error(`all-container inventory changed while inspecting ${id}`);
        }
        names.add(name);
        records.push(Object.freeze({
            id,
            name,
            labels: Object.freeze({ ...(record?.Config?.Labels || record?.Labels || {}) }),
        }));
    }
    return Object.freeze(records);
}

function preflightProvenStagedAbsence(entries, runtime, {
    control = runContainerControl,
    inspect = inspectExactContainer,
    workspaceIdentity = workspaceNetworkIdentity,
    sandboxPidRecordExists = hasBwrapPidRecord,
} = {}) {
    const candidates = [];
    for (const [name, record] of entries) {
        if (isSandboxRuntime(record?.runtime) || record?.type !== 'agent') continue;
        const hasContainerId = Object.prototype.hasOwnProperty.call(record, 'containerId');
        if (hasContainerId) {
            if (!/^[a-f0-9]{64}$/.test(String(record.containerId || ''))) {
                throw new Error(`fleet lifecycle for '${name}' has a malformed present registry container ID`);
            }
            if (!String(record.instanceId || '').trim()
                || !String(record.enableGeneration || '').trim()) {
                throw new Error(`fleet lifecycle for '${name}' requires a complete managed-agent registry identity`);
            }
            continue;
        }
        const candidate = assertCompletePreparedAgentRecord(name, record);
        if (sandboxPidRecordExists(name)) {
            throw new Error(`fleet lifecycle for '${name}' found sandbox PID authority for a staged runtime`);
        }
        candidates.push(candidate);
    }
    if (!candidates.length) return Object.freeze(new Set());

    const workspaceHash = String(workspaceIdentity()?.hash || '');
    if (!workspaceHash) {
        throw new Error('staged runtime absence proof could not resolve the workspace identity');
    }
    const inventory = captureAllContainerInventory(runtime, { control, inspect });
    const proven = new Set();
    for (const candidate of candidates) {
        for (const container of inventory) {
            if (container.name === candidate.name) {
                throw new Error(
                    `fleet lifecycle for '${candidate.name}' found a same-name staged runtime without immutable registry ownership`,
                );
            }
            const labels = container.labels;
            if (String(labels[NETWORK_LABELS.workspace] || '') === workspaceHash
                && String(labels[NETWORK_LABELS.instanceId] || '') === candidate.instanceId
                && String(labels[NETWORK_LABELS.enableGeneration] || '') === candidate.enableGeneration) {
                throw new Error(
                    `fleet lifecycle for '${candidate.name}' found its staged identity under another container name`,
                );
            }
        }
        proven.add(candidate.name);
    }
    return Object.freeze(proven);
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
        let inspected = inspect(runtime, expectedId);
        if (!inspected) {
            // Without a live immutable-ID inspection there is no container
            // ownership evidence that permits deleting even a recorded
            // descriptor artifact. Preserve both registry state and artifact.
            return Object.freeze({ found: false, stopped: false, removed: false });
        }
        const artifact = captureRecordedGeneratedRouterDescriptor(record);
        const workspaceHash = String(workspaceIdentity()?.hash || '');
        if (!workspaceHash) {
            throw new Error(`fleet lifecycle for '${name}' could not resolve the workspace identity`);
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
            control(runtime, ['rm', '-f', expectedId]);
            if (inspect(runtime, expectedId)) {
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

function stopConfiguredAgents({ fast = false, strict = false, remove = false } = {}, {
    agents: suppliedAgents,
    runtime: suppliedRuntime = null,
    provenStagedAbsent = new Set(),
    removeExact = removeExactContainerAndDescriptor,
    listRunningNames = listRunningContainerNames,
} = {}) {
    const agents = suppliedAgents || loadAgents();
    const entries = Object.entries(agents || {})
        .filter(([name, rec]) => rec && (rec.type === 'agent' || rec.type === 'agentCore') && typeof name === 'string' && !name.startsWith('_'));

    // Handle sandbox (bwrap/seatbelt) agents first
    const bwrapStopped = [];
    const bwrapEntries = [];
    const containerEntries = [];
    const failures = new Map();
    for (const [name, rec] of entries) {
        if (isSandboxRuntime(rec?.runtime)) {
            const agentName = rec.agentName || name;
            if (strict && hasInvalidBwrapPidRecord(name)) {
                failures.set(
                    name,
                    `${rec.runtime} PID record is invalid or predates the current ownership schema`,
                );
                continue;
            }
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
            if (stoppedSandboxRuntimes.has(entry.runtimeKey)
                && !isBwrapProcessRunning(entry.runtimeKey)) {
                console.log(`[stop] Stopped ${entry.agentName} (${entry.runtime})`);
                bwrapStopped.push(entry.name);
                continue;
            }
            failures.set(entry.name, `${entry.runtime} process remains live`);
        }
    }

    // Handle container agents. Registry names are diagnostic only: every
    // signal targets a revalidated immutable container ID while the shared
    // network lifecycle lock is held.
    const stoppedContainers = [];
    let runtime = suppliedRuntime;
    for (const [name, rec] of containerEntries) {
        if (provenStagedAbsent.has(name)) {
            console.log(`[stop] ${rec?.agentName || name}: staged runtime is proven absent.`);
            continue;
        }
        try {
            runtime ||= getRuntime();
            const result = removeExact(name, rec, runtime, {
                fast,
                remove,
            });
            if (!result.found) {
                console.log(`[stop] ${rec?.agentName || name}: no exact registered container found.`);
                if (strict && listRunningNames({ runtime }).has(name)) {
                    failures.set(name, 'registered runtime name remains live without exact ownership');
                }
                continue;
            }
            if (strict && listRunningNames({ runtime }).has(name)) {
                failures.set(name, 'container remains live after stop');
                continue;
            }
            console.log(`[stop] ${remove ? 'Removed' : 'Stopped'} ${name}`);
            clearLivenessState(name);
            stoppedContainers.push(name);
        } catch (error) {
            console.log(`[stop] Preserved ${name}: ${error?.message || error}`);
            failures.set(name, error?.message || String(error));
        }
    }
    if (strict && failures.size > 0) {
        const error = new Error(
            `Configured runtimes remain after shutdown: ${[...failures]
                .map(([name, reason]) => `${name} (${reason})`).join(', ')}`,
        );
        error.code = 'PLOINKY_CONFIGURED_RUNTIME_QUIESCENCE_FAILED';
        throw error;
    }
    return [...bwrapStopped, ...stoppedContainers];
}

function stopCoordinatedConfiguredAgents({
    fast = false,
    strict = true,
    remove = false,
} = {}, {
    load = loadAgents,
    resolveRuntime = getRuntime,
    insideBox = isInsideBox,
    withLock = withNetworkLifecycleLock,
    control = runContainerControl,
    inspect = inspectExactContainer,
    workspaceIdentity = workspaceNetworkIdentity,
    sandboxPidRecordExists = hasBwrapPidRecord,
    removeExact = removeExactContainerAndDescriptor,
    listRunningNames = listRunningContainerNames,
} = {}) {
    return withLock(() => {
        // Capture desired state under the same lifecycle lock that guards the
        // absence proof and every exact runtime control. A pre-lock snapshot
        // could become stale before classification and authorize a destructive
        // transition against a newer generation.
        const agents = load();
        const entries = Object.entries(agents || {})
            .filter(([name, record]) => record
                && (record.type === 'agent' || record.type === 'agentCore')
                && typeof name === 'string'
                && !name.startsWith('_'));
        const hasStagedContainerRecord = entries.some(([, record]) => (
            record.type === 'agent'
            && !isSandboxRuntime(record.runtime)
            && !Object.prototype.hasOwnProperty.call(record, 'containerId')
        ));
        let runtime = null;
        let provenStagedAbsent = new Set();
        if (hasStagedContainerRecord) {
            if (!insideBox()) {
                throw new Error('staged runtime absence recovery is available only inside a managed Ploinky Box');
            }
            runtime = resolveRuntime();
            provenStagedAbsent = preflightProvenStagedAbsence(entries, runtime, {
                control,
                inspect,
                workspaceIdentity,
                sandboxPidRecordExists,
            });
        }
        return stopConfiguredAgents({ fast, strict, remove }, {
            agents,
            runtime,
            provenStagedAbsent,
            removeExact,
            listRunningNames,
        });
    });
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
    stopCoordinatedConfiguredAgents,
    stopConfiguredAgents,
    waitForContainers
};
