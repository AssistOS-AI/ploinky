// Generic execution-target discovery (plan section 5.6; frozen T0 section 3 + A1.7; proof sequence slice P1).
//
// Turns the active workspace registry and each agent's effective manifest into the trusted entry records that the
// worker availability projection consumes (the exact twenty ENTRY_KEYS of `availability.mjs`). It is pure: the registry,
// the manifests, live instance evidence and helper-preparation facts are injected readers. It names no agent, reads no
// file, environment or network and launches nothing. Global/running/Podman status is only a discovery filter: a record
// that is stopped, not a container or not global is still listed, and the worker policy refuses it with its own reason.
//
// Nothing here qualifies or authorizes a target. An entry is capability metadata; the worker re-checks everything.

import {
    deepFreeze,
    errorResult,
    isId,
    isOpaqueIdentity,
    isPrincipal,
    isRef,
    okResult,
} from './contract.mjs';
import { readExecutionTargetDeclaration } from './declaration.mjs';

export const DISCOVERY_VERSION = 1;
export const DISCOVERY_MAX_RECORDS = 256;

// Distinct per-case reasons for the non-entry diagnostics. The worker's step 6 collapses stopped, disabled,
// non-container and non-global to `target_not_eligible`; the finer reason is for operators and tests only.
export const DISCOVERY_REASONS = Object.freeze([
    'invalid_identity', 'disabled', 'stopped', 'non_container', 'non_global', 'identity_incomplete',
    'declaration_absent', 'declaration_invalid', 'manifest_unreadable', 'helper_unprepared', 'journal_unavailable',
]);

const CONTAINER_ID = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function text(value) {
    return typeof value === 'string' && value === value.trim() && value.length > 0 ? value : '';
}

function opaqueOrNull(value) {
    return isOpaqueIdentity(value) ? value : null;
}

function safeCall(fn, ...args) {
    try {
        return { ok: true, value: fn(...args) };
    } catch {
        return { ok: false, value: undefined };
    }
}

function normalizeAliases(record, repoName, ref) {
    const out = new Set();
    const candidates = [];
    if (text(record.alias)) candidates.push(record.alias);
    if (Array.isArray(record.aliases)) candidates.push(...record.aliases);
    for (const candidate of candidates) {
        const name = text(candidate);
        if (!name) continue;
        const principal = name.startsWith('agent:') ? name : `agent:${name.includes('/') ? name : `${repoName}/${name}`}`;
        if (isPrincipal(principal) && principal !== `agent:${ref}`) out.add(principal);
    }
    return [...out].sort();
}

// Declaration state for the entry: null (absent), {valid:false,...} (present but null or invalid) or {valid:true,...}.
function declarationState(manifestRead) {
    if (!manifestRead.ok || !isPlainObject(manifestRead.value)) {
        return { declaration: { valid: false, code: 'manifest_unreadable' }, reason: 'manifest_unreadable' };
    }
    const read = readExecutionTargetDeclaration(manifestRead.value);
    if (!read.present) return { declaration: null, reason: 'declaration_absent' };
    if (!read.result.ok) {
        return { declaration: { valid: false, code: read.result.error.code }, reason: 'declaration_invalid' };
    }
    return { declaration: { valid: true, value: read.result.value }, reason: null };
}

function helperState(facts) {
    const source = isPlainObject(facts) ? facts : {};
    const declaredIncarnation = isId(source.helperIncarnation) ? source.helperIncarnation : null;
    const prepared = source.prepared === true && declaredIncarnation !== null;
    // An unprepared target exposes no helper incarnation.
    const helperIncarnation = prepared ? declaredIncarnation : null;
    const journal = prepared && source.journal === 'available' ? 'available' : 'unavailable';
    const attestation = prepared && isPlainObject(source.attestation) ? structuredClone(source.attestation) : null;
    const activeExecutions = Number.isSafeInteger(source.activeExecutions) && source.activeExecutions >= 0
        ? source.activeExecutions : 0;
    return { helperIncarnation, prepared, journal, attestation, activeExecutions };
}

/**
 * Discover target entries.
 *
 * Inputs (all trusted, injected):
 *   live             {workspaceId, boxIdentity, boxGeneration} of the active Box; stamped on every entry
 *   readRegistry()   {agents: {[containerName]: record}} of the active workspace registry (same shape as the
 *                    webtty target resolver reads: type, runtime, runMode, containerId, instanceId,
 *                    enableGeneration, repoName, agentName, alias)
 *   readManifest(record)   the agent's effective manifest object (a throw or a non-object is `manifest_unreadable`)
 *   readInstance(record)   live instance evidence {running: boolean, containerId?: string} or null
 *   readHelper(record)     helper-preparation facts {helperIncarnation, prepared, journal, attestation,
 *                          activeExecutions} or null (provisioning is a later slice; null means unprepared)
 *
 * Returns the common result: {ok:true, value:{version, entries, diagnostics, dropped}} (deep-frozen) or
 * {ok:false, error:{code}}. `entries` are sorted by (ref, runtimeInstanceId, containerId) and carry exactly the
 * worker ENTRY_KEYS. A record that cannot form a valid ref is dropped (listed in `dropped`), never emitted partially.
 * `diagnostics` holds the finer per-case reasons per ref and is not part of any entry.
 */
export function discoverExecutionTargets(inputs = {}) {
    const { live, readRegistry, readManifest, readInstance, readHelper } = isPlainObject(inputs) ? inputs : {};
    if (!isPlainObject(live) || !['workspaceId', 'boxIdentity', 'boxGeneration'].every((key) => isOpaqueIdentity(live[key]))
        || typeof readRegistry !== 'function' || typeof readManifest !== 'function' || typeof readInstance !== 'function') {
        return errorResult('invalid_request');
    }
    const registry = safeCall(readRegistry);
    if (!registry.ok || !isPlainObject(registry.value) || !isPlainObject(registry.value.agents)) {
        return errorResult('invalid_request');
    }
    const names = Object.keys(registry.value.agents)
        .filter((name) => isPlainObject(registry.value.agents[name]) && registry.value.agents[name].type === 'agent').sort();
    if (names.length > DISCOVERY_MAX_RECORDS) return errorResult('capacity_exceeded');

    const entries = [];
    const diagnostics = [];
    const dropped = [];
    for (const containerName of names) {
        const record = registry.value.agents[containerName];
        if (!isPlainObject(record) || record.type !== 'agent') continue;
        const repoName = text(record.repoName);
        const agentName = text(record.agentName);
        const ref = `${repoName}/${agentName}`;
        if (!isRef(ref)) {
            dropped.push({ containerName: String(containerName).slice(0, 128), reason: 'invalid_identity' });
            continue;
        }
        const reasons = [];
        const containerId = CONTAINER_ID.test(text(record.containerId)) ? record.containerId : null;
        const runtimeInstanceId = opaqueOrNull(record.instanceId);
        const enableGeneration = opaqueOrNull(record.enableGeneration);
        if (containerId === null || runtimeInstanceId === null || enableGeneration === null) reasons.push('identity_incomplete');

        // Only podman is a container target; every other runtime keeps its own (non-'container') spelling.
        const runtimeName = text(record.runtime);
        const runtime = runtimeName === 'podman' ? 'container' : (runtimeName || 'unknown');
        const placement = text(record.runMode) || 'unknown';
        const enabled = record.enabled !== false && record.disabled !== true;

        // The registry alone is not evidence of a running instance: require matching live evidence.
        const instance = safeCall(readInstance, record);
        const running = instance.ok && isPlainObject(instance.value) && instance.value.running === true
            && containerId !== null && instance.value.containerId === containerId;

        const manifest = safeCall(readManifest, record);
        const { declaration, reason: declarationReason } = declarationState(manifest);
        const helperFacts = safeCall(readHelper ?? (() => null), record);
        const helper = helperState(helperFacts.ok ? helperFacts.value : null);

        if (!enabled) reasons.push('disabled');
        if (!running) reasons.push('stopped');
        if (runtime !== 'container') reasons.push('non_container');
        if (placement !== 'global') reasons.push('non_global');
        if (declarationReason) reasons.push(declarationReason);
        if (!helper.prepared) reasons.push('helper_unprepared');
        else if (helper.journal !== 'available') reasons.push('journal_unavailable');

        entries.push({
            ref,
            // Projection label: 1-128 UTF-8 bytes. Ref characters are ASCII; a longer ref falls back to the agent name.
            label: ref.length <= 128 ? ref : agentName,
            principal: `agent:${ref}`,
            aliases: normalizeAliases(record, repoName, ref),
            runtimeInstanceId,
            containerId,
            enableGeneration,
            helperIncarnation: helper.helperIncarnation,
            workspaceId: opaqueOrNull(record.workspaceId) ?? live.workspaceId,
            boxIdentity: opaqueOrNull(record.boxIdentity) ?? live.boxIdentity,
            boxGeneration: opaqueOrNull(record.boxGeneration) ?? live.boxGeneration,
            enabled,
            running,
            runtime,
            placement,
            declaration,
            prepared: helper.prepared,
            journal: helper.journal,
            attestation: helper.attestation,
            activeExecutions: helper.activeExecutions,
        });
        diagnostics.push({ ref, containerId, reasons });
    }
    const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const key = (item) => `${item.ref}\u0000${item.runtimeInstanceId ?? ''}\u0000${item.containerId ?? ''}`;
    entries.sort((a, b) => order(key(a), key(b)));
    diagnostics.sort((a, b) => order(`${a.ref}\u0000${a.containerId ?? ''}`, `${b.ref}\u0000${b.containerId ?? ''}`));
    return okResult(deepFreeze({ version: DISCOVERY_VERSION, entries, diagnostics, dropped }));
}
