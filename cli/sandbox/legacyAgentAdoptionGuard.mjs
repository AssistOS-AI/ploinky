// Pure owned-global-agent security-evidence predicate (frozen T0 §11 + A1.1 +
// A1.7 + A2.4). It inspects only data it is given: no runtime calls, no
// files, no clock. The lifecycle adapter wires only the reviewed interim
// subset; the full predicate waits for the G-L runtime-adapter observations.
//
// A refusal or foreign decision is terminal for the lifecycle request and
// carries no recreate, remediation, cleanup or stop directive: decision
// objects have exactly the §11 key sets below.

import { digestOrThrow } from '../server/executionTarget/contract.mjs';

export const LEGACY_GUARD_ERROR_CODES = Object.freeze({
    legacyProcUnmask: 'legacy_proc_unmask',
    privilegedAgent: 'privileged_agent',
    weakenedProcPolicy: 'weakened_proc_policy',
    unverifiableSecurityEvidence: 'unverifiable_security_evidence',
});

export const LEGACY_GUARD_DECISIONS = Object.freeze({
    notApplicable: 'not-applicable',
    foreign: 'foreign',
    allow: 'allow',
    refuse: 'refuse',
    interimClear: 'interim-clear',
});

export const OCI_GUARD_RUNTIMES = Object.freeze(['docker', 'podman']);
export const NATIVE_GUARD_RUNTIMES = Object.freeze(['bwrap', 'seatbelt']);
// The Ploinky run modes of cli/utils/agents.js (ENABLE_AGENT_MODES), repeated
// here so this module stays pure; a unit test pins their equality.
export const RECOGNIZED_RUN_MODES = Object.freeze(['isolated', 'global', 'devel']);
export const LEGACY_PROC_UNMASK_LABEL = 'ploinky.procunmask';

// The ownership label keys of cli/sandbox/networkIdentity.js (NETWORK_LABELS),
// repeated here so this module stays pure; a unit test pins their equality.
export const OWNED_AGENT_LABELS = Object.freeze({
    managed: 'io.assistos.ploinky.managed',
    resource: 'io.assistos.ploinky.resource',
    workspace: 'io.assistos.ploinky.workspace',
    instanceId: 'io.assistos.ploinky.instance-id',
    enableGeneration: 'io.assistos.ploinky.enable-generation',
});

const G = LEGACY_GUARD_ERROR_CODES;
const D = LEGACY_GUARD_DECISIONS;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const LABEL_VIEW_PATHS = Object.freeze([['Config', 'Labels'], ['Labels'], ['labels']]);
const REASONS = Object.freeze({
    [G.legacyProcUnmask]: 'the instance carries a legacy proc-unmask marker',
    [G.privilegedAgent]: 'the instance runs privileged',
    [G.weakenedProcPolicy]: 'the instance does not keep the baseline masked and read-only paths',
    [G.unverifiableSecurityEvidence]: 'the instance security evidence is incomplete, contradictory or not bound to it',
});
const INTERIM_PREFIX = 'interim definite-marker check: ';

function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function own(object, key) {
    return isPlainObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;
}

function freeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const key of Object.keys(value)) freeze(value[key]);
        Object.freeze(value);
    }
    return value;
}

function refuse(containerId, code, { interim = false } = {}) {
    return freeze({ decision: D.refuse, containerId, code, reason: `${interim ? INTERIM_PREFIX : ''}${REASONS[code]}` });
}

// ---------------------------------------------------------------- field parsing

// Immutable container ID from `Id|ID`; contradictory or non-canonical spellings
// give null (identity cannot be established).
export function readContainerId(record) {
    const ids = ['Id', 'ID'].filter((key) => own(record, key) !== undefined).map((key) => record[key]);
    if (ids.length === 0) return null;
    if (!ids.every((value) => typeof value === 'string' && CONTAINER_ID.test(value))) return null;
    return ids.every((value) => value === ids[0]) ? ids[0] : null;
}

function isStringMap(value) {
    return isPlainObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

// Present label views: Docker/Podman spell "no labels" as null, read as {}.
function labelViews(record) {
    const views = [];
    for (const segments of LABEL_VIEW_PATHS) {
        let parent = record;
        for (const segment of segments.slice(0, -1)) parent = own(parent, segment);
        const value = own(parent, segments[segments.length - 1]);
        if (value === undefined) continue;
        views.push(value === null ? {} : value);
    }
    return views;
}

/**
 * Parse one security option the way the runtimes do: the key runs to the
 * first `=` or `:` (both separators are accepted, A2.4). Returns
 * `{key,value}` in lower case, or null when the representation is malformed.
 */
export function parseSecurityOption(option) {
    if (typeof option !== 'string' || option.length === 0 || /[\u0000-\u001f\u007f]/.test(option)) return null;
    const match = /[=:]/.exec(option);
    const key = (match ? option.slice(0, match.index) : option).trim().toLowerCase();
    if (!key) return null;
    return { key, value: match ? option.slice(match.index + 1).trim().toLowerCase() : null };
}

function isProcUnmaskOption(parsed) {
    return parsed.key === 'unmask' || (parsed.key === 'systempaths' && parsed.value === 'unconfined');
}

function hostConfig(record) {
    return own(record, 'HostConfig');
}

// ---------------------------------------------------------------- interim subset (A1.1 step 4)

/**
 * A1.1 interim definite-marker subset: refuses only definite legacy markers
 * and malformed representations. Absent `Privileged`/`SecurityOpt` fields do
 * not refuse here (only the full predicate requires complete evidence). This
 * is labelled interim; it is not the A49 mask-completeness guard.
 */
export function evaluateInterimLegacyMarkers(record) {
    if (!isPlainObject(record)) return refuse(null, G.unverifiableSecurityEvidence, { interim: true });
    const containerId = readContainerId(record);
    const host = hostConfig(record);
    if (host !== undefined && host !== null && !isPlainObject(host)) {
        return refuse(containerId, G.unverifiableSecurityEvidence, { interim: true });
    }
    const views = labelViews(record);
    if (!views.every(isStringMap)) return refuse(containerId, G.unverifiableSecurityEvidence, { interim: true });
    const securityOpt = own(host, 'SecurityOpt');
    const options = securityOpt === undefined || securityOpt === null ? [] : securityOpt;
    if (!Array.isArray(options)) return refuse(containerId, G.unverifiableSecurityEvidence, { interim: true });
    const parsed = options.map(parseSecurityOption);
    if (parsed.some((entry) => entry === null)) return refuse(containerId, G.unverifiableSecurityEvidence, { interim: true });
    const privileged = own(host, 'Privileged');
    if (privileged !== undefined && typeof privileged !== 'boolean') {
        return refuse(containerId, G.unverifiableSecurityEvidence, { interim: true });
    }
    if (views.some((view) => Object.hasOwn(view, LEGACY_PROC_UNMASK_LABEL))) {
        return refuse(containerId, G.legacyProcUnmask, { interim: true });
    }
    if (parsed.some(isProcUnmaskOption)) return refuse(containerId, G.legacyProcUnmask, { interim: true });
    if (privileged === true) return refuse(containerId, G.privilegedAgent, { interim: true });
    return freeze({ decision: D.interimClear, containerId });
}

// ---------------------------------------------------------------- evidence normalization

function stringList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

// Missing evidence is never a false boolean or an empty list: a null spelling
// is known-empty only where the reviewed adapter establishes that meaning.
function normalizeList(value, nullMeansEmpty) {
    if (value === undefined) return { state: 'unknown', value: null };
    if (value === null) return nullMeansEmpty === true ? { state: 'known-empty', value: [] } : { state: 'unknown', value: null };
    if (!stringList(value)) return { state: 'malformed', value: null };
    return { state: value.length ? 'known-value' : 'known-empty', value: [...value].sort() };
}

function normalizeMounts(value) {
    if (value === undefined || value === null) return { state: 'unknown', value: null };
    if (!Array.isArray(value)) return { state: 'malformed', value: null };
    const mounts = [];
    for (const mount of value) {
        const destination = own(mount, 'Destination') ?? own(mount, 'destination');
        const readWrite = own(mount, 'RW');
        const readOnly = own(mount, 'readOnly');
        if (typeof destination !== 'string' || !destination.startsWith('/')) return { state: 'malformed', value: null };
        let ro;
        if (typeof readWrite === 'boolean') ro = !readWrite;
        else if (typeof readOnly === 'boolean') ro = readOnly;
        else return { state: 'malformed', value: null };
        mounts.push({ destination, readOnly: ro });
    }
    mounts.sort((left, right) => (left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0));
    return { state: mounts.length ? 'known-value' : 'known-empty', value: mounts };
}

function sameSet(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

// Combine an inspect field with an exact-instance OCI observation: either may
// supply the fact; when both are known they must agree.
function combine(inspected, observed) {
    if (inspected.state === 'malformed' || observed.state === 'malformed') return { state: 'malformed', value: null };
    const known = (field) => field.state === 'known-value' || field.state === 'known-empty';
    if (known(inspected) && known(observed)) {
        const equal = JSON.stringify(inspected.value) === JSON.stringify(observed.value);
        return equal ? inspected : { state: 'contradictory', value: null };
    }
    if (known(inspected)) return inspected;
    if (known(observed)) return observed;
    return { state: 'unknown', value: null };
}

/**
 * Normalize raw inspect data plus trusted adapter evidence into tri-state
 * facts (`known-value`, `known-empty`, `unknown`, plus `malformed` and
 * `contradictory`). The adapter evidence is
 * `{runtimeFamily, runtimeVersion, configIdentity, nullMeansEmpty:{securityOpt,maskedPaths,readonlyPaths}, oci}`
 * where `oci` is null or an exact-instance observation
 * `{containerId, configIdentity, maskedPaths, readonlyPaths, mounts}`.
 */
export function normalizeAgentSecurityEvidence({ runtime, record, evidence } = {}) {
    const adapter = isPlainObject(evidence) ? evidence : {};
    const nullMeansEmpty = isPlainObject(adapter.nullMeansEmpty) ? adapter.nullMeansEmpty : {};
    const containerId = isPlainObject(record) ? readContainerId(record) : null;
    const host = isPlainObject(record) ? hostConfig(record) : undefined;
    const hostState = host === undefined || host === null ? 'unknown' : (isPlainObject(host) ? 'known' : 'malformed');
    const views = isPlainObject(record) ? labelViews(record) : [];
    let labels;
    if (!views.every(isStringMap)) labels = { state: 'malformed', value: null };
    else if (views.length === 0) labels = { state: 'unknown', value: null };
    else {
        const encoded = views.map((view) => JSON.stringify(Object.keys(view).sort().map((key) => [key, view[key]])));
        labels = encoded.every((item) => item === encoded[0])
            ? { state: Object.keys(views[0]).length ? 'known-value' : 'known-empty', value: { ...views[0] } }
            : { state: 'contradictory', value: null };
    }
    const privilegedRaw = hostState === 'known' ? own(host, 'Privileged') : undefined;
    const privileged = privilegedRaw === undefined || privilegedRaw === null
        ? { state: 'unknown', value: null }
        : (typeof privilegedRaw === 'boolean' ? { state: 'known-value', value: privilegedRaw } : { state: 'malformed', value: null });
    let securityOpt = normalizeList(hostState === 'known' ? own(host, 'SecurityOpt') : undefined, nullMeansEmpty.securityOpt);
    if (securityOpt.value && securityOpt.value.some((option) => parseSecurityOption(option) === null)) {
        securityOpt = { state: 'malformed', value: null };
    }
    const oci = adapter.oci;
    let observed = {
        maskedPaths: { state: 'unknown', value: null },
        readonlyPaths: { state: 'unknown', value: null },
        mounts: { state: 'unknown', value: null },
    };
    let ociBinding = 'absent';
    if (oci !== undefined && oci !== null) {
        if (!isPlainObject(oci)) ociBinding = 'malformed';
        else if (oci.containerId !== containerId || containerId === null || oci.configIdentity !== adapter.configIdentity) {
            ociBinding = 'foreign';
        } else {
            ociBinding = 'bound';
            observed = {
                maskedPaths: normalizeList(oci.maskedPaths, false),
                readonlyPaths: normalizeList(oci.readonlyPaths, false),
                mounts: normalizeMounts(oci.mounts),
            };
        }
    }
    const result = {
        runtime: typeof runtime === 'string' ? runtime : null,
        containerId,
        hostConfig: hostState,
        labels,
        privileged,
        securityOpt,
        maskedPaths: combine(normalizeList(hostState === 'known' ? own(host, 'MaskedPaths') : undefined,
            nullMeansEmpty.maskedPaths), observed.maskedPaths),
        readonlyPaths: combine(normalizeList(hostState === 'known' ? own(host, 'ReadonlyPaths') : undefined,
            nullMeansEmpty.readonlyPaths), observed.readonlyPaths),
        mounts: combine(normalizeMounts(isPlainObject(record) ? own(record, 'Mounts') : undefined), observed.mounts),
        ociBinding,
        adapter: {
            runtimeFamily: typeof adapter.runtimeFamily === 'string' ? adapter.runtimeFamily : null,
            runtimeVersion: typeof adapter.runtimeVersion === 'string' ? adapter.runtimeVersion : null,
            configIdentity: typeof adapter.configIdentity === 'string' ? adapter.configIdentity : null,
        },
    };
    return freeze(result);
}

// ---------------------------------------------------------------- full predicate

function segments(value) {
    return value === '/' ? [] : value.replace(/\/+$/, '').slice(1).split('/');
}

function overlaps(left, right) {
    const a = segments(left);
    const b = segments(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) if (a[index] !== b[index]) return false;
    return true;
}

function validBaseline(baseline) {
    return isPlainObject(baseline)
        && typeof baseline.runtimeFamily === 'string'
        && typeof baseline.runtimeVersion === 'string' && baseline.runtimeVersion.length > 0
        && typeof baseline.configIdentity === 'string' && baseline.configIdentity.length > 0
        && typeof baseline.profileDigest === 'string' && /^[0-9a-f]{64}$/.test(baseline.profileDigest)
        && stringList(baseline.maskedPaths) && baseline.maskedPaths.length > 0
        && stringList(baseline.readonlyPaths)
        && [...baseline.maskedPaths, ...baseline.readonlyPaths].every((item) => item.startsWith('/') && item !== '/');
}

const isKnown = (field) => field.state === 'known-value' || field.state === 'known-empty';

/**
 * The full §11 predicate. Returns exactly one of
 *   {decision:'not-applicable'}
 *   {decision:'foreign', containerId}
 *   {decision:'allow', containerId, evidenceDigest}
 *   {decision:'refuse', containerId, code, reason}
 * `allow` says only that this guard found no legacy or weakened confinement;
 * it implies no target qualification.
 */
export function evaluateLegacyAgentAdoption({
    runtime, runMode, ownership, record, expectedIdentity, baseline, evidence,
} = {}) {
    // A5.4: applicability fails closed. Only an exact known runtime and run
    // mode can make the guard not applicable.
    if (![...OCI_GUARD_RUNTIMES, ...NATIVE_GUARD_RUNTIMES].includes(runtime) || !RECOGNIZED_RUN_MODES.includes(runMode)) {
        return refuse(isPlainObject(record) ? readContainerId(record) : null, G.unverifiableSecurityEvidence);
    }
    if (NATIVE_GUARD_RUNTIMES.includes(runtime)) return freeze({ decision: D.notApplicable });
    if (ownership === 'outer-box' || ownership === 'unrelated' || runMode !== 'global') {
        return freeze({ decision: D.notApplicable });
    }
    const facts = normalizeAgentSecurityEvidence({ runtime, record, evidence });
    const { containerId } = facts;
    if (ownership === 'foreign') return freeze({ decision: D.foreign, containerId });
    if (ownership !== 'owned' || !isPlainObject(record) || facts.hostConfig === 'malformed') {
        return refuse(containerId, G.unverifiableSecurityEvidence);
    }
    if (facts.labels.state === 'malformed' || facts.labels.state === 'contradictory') {
        return refuse(containerId, G.unverifiableSecurityEvidence);
    }
    const labels = facts.labels.value || {};
    const expected = isPlainObject(expectedIdentity) ? expectedIdentity : {};
    // Not this workspace's agent: never touched.
    if (labels[OWNED_AGENT_LABELS.managed] !== '1' || labels[OWNED_AGENT_LABELS.resource] !== 'agent'
        || typeof expected.workspaceHash !== 'string' || labels[OWNED_AGENT_LABELS.workspace] !== expected.workspaceHash) {
        return freeze({ decision: D.foreign, containerId });
    }
    // Definite legacy markers refuse before any completeness question.
    if (Object.hasOwn(labels, LEGACY_PROC_UNMASK_LABEL)) return refuse(containerId, G.legacyProcUnmask);
    if (facts.securityOpt.state === 'malformed') return refuse(containerId, G.unverifiableSecurityEvidence);
    if ((facts.securityOpt.value || []).some((option) => isProcUnmaskOption(parseSecurityOption(option)))) {
        return refuse(containerId, G.legacyProcUnmask);
    }
    if (facts.privileged.state === 'malformed') return refuse(containerId, G.unverifiableSecurityEvidence);
    if (facts.privileged.value === true) return refuse(containerId, G.privilegedAgent);
    // Exact identity of the instance and of the evidence.
    if (containerId === null || (expected.containerId != null && expected.containerId !== containerId)
        || typeof expected.instanceId !== 'string' || labels[OWNED_AGENT_LABELS.instanceId] !== expected.instanceId
        || typeof expected.enableGeneration !== 'string'
        || labels[OWNED_AGENT_LABELS.enableGeneration] !== expected.enableGeneration) {
        return refuse(containerId, G.unverifiableSecurityEvidence);
    }
    if (facts.privileged.state !== 'known-value' || !isKnown(facts.securityOpt)) {
        return refuse(containerId, G.unverifiableSecurityEvidence);
    }
    if (!validBaseline(baseline) || baseline.runtimeFamily !== runtime
        || facts.adapter.runtimeFamily !== runtime
        || facts.adapter.runtimeVersion !== baseline.runtimeVersion
        || facts.adapter.configIdentity !== baseline.configIdentity
        || (expected.configIdentity != null && expected.configIdentity !== baseline.configIdentity)
        || facts.ociBinding === 'foreign' || facts.ociBinding === 'malformed') {
        return refuse(containerId, G.unverifiableSecurityEvidence);
    }
    if (!isKnown(facts.maskedPaths) || !isKnown(facts.readonlyPaths) || !isKnown(facts.mounts)) {
        return refuse(containerId, G.unverifiableSecurityEvidence);
    }
    const masked = new Set(facts.maskedPaths.value);
    const readonly = new Set(facts.readonlyPaths.value);
    if (!baseline.maskedPaths.every((item) => masked.has(item))) return refuse(containerId, G.weakenedProcPolicy);
    // Masked is more restrictive than read-only and is acceptable here.
    if (!baseline.readonlyPaths.every((item) => readonly.has(item) || masked.has(item))) {
        return refuse(containerId, G.weakenedProcPolicy);
    }
    for (const mount of facts.mounts.value) {
        if (mount.destination === '/') return refuse(containerId, G.weakenedProcPolicy);
        if (baseline.maskedPaths.some((item) => overlaps(mount.destination, item))) return refuse(containerId, G.weakenedProcPolicy);
        if (!mount.readOnly && baseline.readonlyPaths.some((item) => overlaps(mount.destination, item))) {
            return refuse(containerId, G.weakenedProcPolicy);
        }
    }
    const evidenceDigest = digestOrThrow({
        version: 1,
        containerId,
        runtime: { family: runtime, version: baseline.runtimeVersion, configIdentity: baseline.configIdentity },
        profileDigest: baseline.profileDigest,
        privileged: false,
        securityOpt: facts.securityOpt.value,
        maskedPaths: facts.maskedPaths.value,
        readonlyPaths: facts.readonlyPaths.value,
        mounts: facts.mounts.value,
    });
    return freeze({ decision: D.allow, containerId, evidenceDigest });
}
