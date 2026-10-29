import { spawnSync } from 'node:child_process';
import {
    evaluateInterimLegacyMarkers, evaluateLegacyAgentAdoption, readContainerId, OCI_GUARD_RUNTIMES,
    NATIVE_GUARD_RUNTIMES, RECOGNIZED_RUN_MODES, LEGACY_GUARD_ERROR_CODES,
} from './legacyAgentAdoptionGuard.mjs';
import { collectPodmanOciEvidence } from './legacyAgentRuntimeEvidence.mjs';
import { assertExactContainerOwnership } from './docker/containerOwnership.js';
import { workspaceNetworkIdentity } from './networkIdentity.js';
import { readRuntimePredecessor } from './runtimePredecessorStore.js';
import { readRuntimeCandidate } from './runtimeCandidateStore.js';

const CODE = 'PLOINKY_LEGACY_AGENT_REFUSED';
const UNKNOWN = Object.freeze({ decision: 'refuse', containerId: null,
    code: 'unverifiable_security_evidence', reason: 'interim instance security evidence cannot be verified' });
const bounded = (value, limit) => typeof value === 'string'
    ? [...value.replace(/[\u0000-\u001f\u007f]/g, '?')].slice(0, limit).join('') : '';

export class LegacyAgentLifecycleRefusal extends Error {
    constructor({ containerName, containerId, result = UNKNOWN } = {}) {
        const name = bounded(containerName, 160);
        const id = /^[a-f0-9]{64}$/.test(containerId || '') ? containerId : null;
        const predicate = Object.freeze({ decision: 'refuse', containerId: id,
            code: result.code, reason: bounded(result.reason, 256) });
        super(`Refused legacy agent '${name}'${id ? ` (${id})` : ''}: ${predicate.reason}. `
            + 'Preserve state and recovery evidence, explicitly remove this exact instance through a separately selected '
            + 'cleanup action, then start under the approved baseline. Restart and force recreation do not override this refusal.');
        Object.defineProperties(this, {
            code: { value: CODE, enumerable: true },
            result: { value: predicate, enumerable: true },
            containerName: { value: name, enumerable: true },
            containerId: { value: id, enumerable: true },
        });
    }
}

export function isLegacyAgentLifecycleRefusal(error) {
    const seen = new Set();
    for (let current = error; current && typeof current === 'object' && !seen.has(current); current = current.cause) {
        if (current.code === CODE) return true;
        seen.add(current);
    }
    return false;
}

function modeOf(runMode, context) {
    // Omitted modes have always selected isolated execution. Present malformed
    // modes cannot turn an applicability check into a bypass.
    if (runMode === undefined) return 'isolated';
    if (!RECOGNIZED_RUN_MODES.includes(runMode)) throw new LegacyAgentLifecycleRefusal(context);
    return runMode;
}

/** Pure assertion. The caller has already proved workspace ownership. */
export function assertInterimOwnedGlobalAgent({ runtime, runMode, containerName, containerId, record } = {}) {
    const context = { containerName, containerId };
    const mode = modeOf(runMode, context);
    if (NATIVE_GUARD_RUNTIMES.includes(runtime) || mode !== 'global') {
        return Object.freeze({ decision: 'not-applicable' });
    }
    if (!OCI_GUARD_RUNTIMES.includes(runtime) || !containerId || readContainerId(record) !== containerId) {
        throw new LegacyAgentLifecycleRefusal(context);
    }
    const result = evaluateInterimLegacyMarkers(record);
    if (result.decision === 'refuse') throw new LegacyAgentLifecycleRefusal({ ...context, result });
    return result;
}

/**
 * A1.1 step 5 activation. The full mask-completeness predicate is wired at
 * every call site that runs the interim markers, behind this reviewed constant
 * (not an environment variable). It stays false until the deployment decision
 * is made: with it true, every owned global agent whose engine is not the
 * reviewed Podman/crun baseline of legacyAgentRuntimeEvidence.mjs is refused as
 * unverifiable_security_evidence.
 */
export const FULL_MASK_COMPLETENESS_ACTIVE = false;

const defaultCollectEvidence = ({ runtime, record }) => collectPodmanOciEvidence({ runtime, record },
    { reinspect: (engine, id) => inspectInterimContainer(engine, id) });
let installedCollectEvidence = defaultCollectEvidence;

/** Test seam: replace the evidence collector; returns the restore function. */
export function overrideLegacyConfinementCollector(collect) {
    const previous = installedCollectEvidence;
    installedCollectEvidence = typeof collect === 'function' ? collect : defaultCollectEvidence;
    return () => { installedCollectEvidence = previous; };
}

/**
 * The interim markers first, then (when active) the full predicate against
 * trusted OCI evidence. `registryRecord` supplies the expected instance and
 * generation; the workspace hash comes from the workspace identity. Any gap
 * is the typed refusal, never a raw diagnostic.
 */
export function assertLegacyAgentConfinement({ runtime, runMode, containerName, containerId, record, registryRecord } = {}, {
    active = FULL_MASK_COMPLETENESS_ACTIVE, collectEvidence = installedCollectEvidence,
    workspaceIdentity = workspaceNetworkIdentity,
} = {}) {
    const interim = assertInterimOwnedGlobalAgent({ runtime, runMode, containerName, containerId, record });
    if (interim.decision === 'not-applicable' || active !== true) return interim;
    const context = { containerName, containerId };
    let result;
    try {
        const collected = collectEvidence({ runtime, record, containerId });
        const workspaceHash = workspaceIdentity()?.hash;
        if (!collected || typeof workspaceHash !== 'string' || !workspaceHash) throw new LegacyAgentLifecycleRefusal(context);
        result = evaluateLegacyAgentAdoption({ runtime, runMode, ownership: 'owned', record,
            expectedIdentity: { containerId, workspaceHash, instanceId: registryRecord?.instanceId,
                enableGeneration: registryRecord?.enableGeneration },
            baseline: collected.baseline, evidence: collected.evidence });
    } catch (_) {
        throw new LegacyAgentLifecycleRefusal(context);
    }
    if (result.decision === 'allow') return result;
    // A foreign or not-applicable answer for an instance the caller proved
    // owned and global is a contradiction, not clearance.
    throw new LegacyAgentLifecycleRefusal({ ...context, result: result.decision === 'refuse' ? result
        : { code: LEGACY_GUARD_ERROR_CODES.unverifiableSecurityEvidence, reason: UNKNOWN.reason } });
}

/** Internal fleet callback; explicit operator removal does not install it. */
export function assertInterimLifecycleMutation({ record, inspected, containerId, containerName, runtime }, dependencies) {
    return assertLegacyAgentConfinement({ runtime, runMode: record?.runMode,
        containerName, containerId, record: inspected, registryRecord: record }, dependencies);
}

/** A journal may borrow a mode only from the very same immutable runtime. */
export function interimReceiptRegistryRecord(record, registered) {
    const sameInstance = record?.containerId && record.containerId === registered?.containerId
        && record.instanceId === registered.instanceId && record.enableGeneration === registered.enableGeneration;
    const runMode = Object.hasOwn(record, 'runMode') ? record.runMode
        : sameInstance && Object.hasOwn(registered, 'runMode') ? registered.runMode : 'global';
    return { ...record, runMode, ...(sameInstance && !record.runtime && registered.runtime ? { runtime: registered.runtime } : {}) };
}

export function inspectInterimContainer(runtime, identifier, { run = spawnSync } = {}) {
    let reply;
    try {
        reply = run(runtime, ['container', 'inspect', identifier], {
            encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
            killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (_) { throw new LegacyAgentLifecycleRefusal(); }
    if (reply?.error || reply?.signal) throw new LegacyAgentLifecycleRefusal();
    if (reply?.status !== 0) {
        if (/no such (?:container|object)|no container with .* (?:found|exists)/i.test(String(reply?.stderr || ''))) return null;
        throw new LegacyAgentLifecycleRefusal();
    }
    let parsed;
    try { parsed = JSON.parse(String(reply.stdout || '')); } catch (_) { throw new LegacyAgentLifecycleRefusal(); }
    const record = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new LegacyAgentLifecycleRefusal();
    return record;
}

/** Read-only preflight of a captured predecessor, never discovery by enumeration. */
export function inspectInterimAgentLifecycle({ containerName, registryRecord, runtime } = {}, {
    inspect = inspectInterimContainer, workspaceIdentity = workspaceNetworkIdentity,
    readPredecessor = readRuntimePredecessor, readCandidate = readRuntimeCandidate,
    active, collectEvidence,
} = {}) {
    if (!registryRecord || registryRecord.type !== 'agent') return Object.freeze({ state: 'not-applicable' });
    let record = registryRecord;
    let context = { containerName, containerId: record.containerId };
    try {
        const receipt = readPredecessor(containerName, record);
        if (receipt) record = interimReceiptRegistryRecord(receipt.predecessor, registryRecord);
        const candidate = record.instanceId && record.enableGeneration ? readCandidate(containerName, record) : null;
        if (candidate) {
            if (record.containerId && record.containerId !== candidate.containerId
                && record.containerId !== candidate.predecessorContainerId) throw new LegacyAgentLifecycleRefusal(context);
            record = interimReceiptRegistryRecord(candidate.registryRecord, registryRecord);
        }
        const mode = modeOf(record.runMode, context);
        const engine = record.runtime || (mode === 'global' && typeof runtime === 'function' ? runtime() : runtime);
        if (NATIVE_GUARD_RUNTIMES.includes(engine) || mode !== 'global') {
            return Object.freeze({ state: 'not-applicable', runMode: mode, runtime: engine });
        }
        context = { containerName, containerId: record.containerId };
        if (!OCI_GUARD_RUNTIMES.includes(engine) || typeof containerName !== 'string'
            || !containerName || containerName !== containerName.trim()) throw new LegacyAgentLifecycleRefusal(context);
        const expectedId = record.containerId || '';
        if (expectedId && !/^[a-f0-9]{64}$/.test(expectedId)) throw new LegacyAgentLifecycleRefusal(context);
        const found = inspect(engine, expectedId || containerName);
        if (!found) {
            if (expectedId && inspect(engine, containerName)) throw new LegacyAgentLifecycleRefusal(context);
            return Object.freeze({ state: 'absent', runMode: mode, runtime: engine });
        }
        const containerId = readContainerId(found);
        if (!containerId || (expectedId && expectedId !== containerId)) throw new LegacyAgentLifecycleRefusal(context);
        context = { containerName, containerId };
        const workspaceHash = workspaceIdentity()?.hash;
        if (!workspaceHash) throw new LegacyAgentLifecycleRefusal(context);
        assertExactContainerOwnership(containerName, record, found, containerId, workspaceHash);
        const confine = (inspected) => assertLegacyAgentConfinement({ ...context, runtime: engine, runMode: mode,
            record: inspected, registryRecord: record }, { workspaceIdentity: () => ({ hash: workspaceHash }),
            ...(active === undefined ? {} : { active }), ...(collectEvidence ? { collectEvidence } : {}) });
        confine(found);
        // Discovery by name never authorizes reuse; pin and inspect the full ID.
        if (!expectedId) {
            const exact = inspect(engine, containerId);
            assertExactContainerOwnership(containerName, record, exact, containerId, workspaceHash);
            confine(exact);
        }
        return Object.freeze({ state: 'exact', containerId, runtime: engine, runMode: mode });
    } catch (error) {
        if (isLegacyAgentLifecycleRefusal(error) && error.containerName) throw error;
        // Do not retain raw inspection/parser/engine errors as a cause: they
        // can include environment variables and other credentials.
        throw new LegacyAgentLifecycleRefusal(context);
    }
}

export function preflightInterimAgentLifecycles(entries, dependencies) {
    for (const { containerName, registryRecord, runtime } of entries) {
        inspectInterimAgentLifecycle({ containerName, registryRecord, runtime }, dependencies);
    }
}
