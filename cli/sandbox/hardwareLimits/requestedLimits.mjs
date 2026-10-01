// Shared hardware-limit request predicate and exact refusal construction.
//
// A request is any effective memory, cpus or pidsLimit value, whatever layer
// declared it and whether or not llmRuntime.enabled is set. Inside a Box the
// nested runtime enforces such a value only when the Box is hardware-prepared;
// a lite sandbox never can. An unenforceable request refuses the agent instead
// of silently dropping the limit. Outside a Box the container engine enforces
// the flags and behavior is unchanged.

import crypto from 'node:crypto';

import {
    HARDWARE_FIELDS,
    HARDWARE_UNENFORCEABLE,
    validateHardwareOutcome,
} from './errors.mjs';
import { readBoxHardwareContext } from './context.mjs';

export const HARDWARE_RESOURCE_FIELDS = Object.freeze(['memory', 'cpus', 'pidsLimit']);
const LAYERS = Object.freeze([
    ['manifest', 'manifestPolicy'],
    ['catalog', 'catalogPolicy'],
    ['profile', 'profilePolicy'],
    ['settings', 'overridePolicy'],
]);

export const DELEGATION_COMMANDS = Object.freeze([
    'sudo mkdir -p /etc/systemd/system/user@.service.d',
    "printf '[Service]\\nDelegate=cpu memory pids\\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf",
    'sudo systemctl daemon-reload',
]);

function resourceValue(policy, field) {
    const value = policy?.resources?.[field];
    if (value === undefined || value === null || value === '' || value === 0) return undefined;
    return String(value);
}

// The exact effective request with the last declaring layer as its source.
// Layer order matches buildEffectivePolicy: manifest, catalog, profile, then
// the operator's stored settings.
export function requestedHardwareLimits(sources = {}) {
    const requested = [];
    for (const field of HARDWARE_RESOURCE_FIELDS) {
        let entry = null;
        for (const [source, key] of LAYERS) {
            const value = resourceValue(sources[key], field);
            if (value !== undefined) entry = { field, value, source };
        }
        if (entry) requested.push(Object.freeze(entry));
    }
    return Object.freeze(requested);
}

export function hasHardwareRequest(requested) {
    return Array.isArray(requested) && requested.length > 0;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((out, key) => {
            out[key] = canonical(value[key]);
            return out;
        }, {});
    }
    return value;
}

export function hex64(value) {
    return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

// Hardware facts that admission depends on. The provider is replaced in a
// hardware-prepared Box; the default inside a Box is gate off, which makes
// every declared limit unenforceable (nested cgroups are disabled).
const DEFAULT_CONTEXT_PROVIDER = ({ insideBox }) => (insideBox
    ? readBoxHardwareContext()
    : { gate: 'none', prepared: false, backendReady: false, controllers: [], storeState: 'none' });
let contextProvider = DEFAULT_CONTEXT_PROVIDER;

export function setHardwareContextProvider(provider) {
    contextProvider = typeof provider === 'function' ? provider : DEFAULT_CONTEXT_PROVIDER;
}

export function normalizeHardwareContext(raw, { insideBox, runtimeKind }) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const controllers = Array.isArray(value.controllers)
        ? [...new Set(value.controllers.filter((entry) => ['cpu', 'memory', 'pids'].includes(entry)))].sort()
        : [];
    return Object.freeze({
        insideBox: Boolean(insideBox),
        runtimeKind: String(runtimeKind || 'container'),
        gate: ['on', 'off', 'none'].includes(value.gate) ? value.gate : (insideBox ? 'off' : 'none'),
        prepared: value.prepared === true,
        backendReady: value.backendReady === true,
        controllers: Object.freeze(controllers),
        hostKind: typeof value.hostKind === 'string' ? value.hostKind : '',
        unpreparedDetail: typeof value.unpreparedDetail === 'string' ? value.unpreparedDetail : '',
        unpreparedKind: typeof value.unpreparedKind === 'string' ? value.unpreparedKind : '',
        runtimeObserved: typeof value.runtimeObserved === 'string' ? value.runtimeObserved : '',
        storeState: ['none', 'valid', 'unreadable'].includes(value.storeState) ? value.storeState : 'none',
        storeDetail: typeof value.storeDetail === 'string' ? value.storeDetail : '',
        storeToken: value.storeToken && typeof value.storeToken === 'object'
            ? Object.freeze({ epoch: String(value.storeToken.epoch || ''), revision: Number(value.storeToken.revision) || 0 })
            : null,
        // Per-agent stored overrides and the visible envelope; consulted for
        // resolution, never part of another agent's fingerprint.
        overrides: value.overrides instanceof Map ? value.overrides : new Map(),
        envelope: value.envelope && typeof value.envelope === 'object' ? value.envelope : null,
    });
}

export function captureHardwareContext({ insideBox = false, runtimeKind = 'container', hardwareContext } = {}) {
    const raw = hardwareContext !== undefined
        ? hardwareContext
        : contextProvider({ insideBox: Boolean(insideBox), runtimeKind });
    return normalizeHardwareContext(raw, { insideBox, runtimeKind });
}

const CONTROLLER_BY_FIELD = Object.freeze({ memory: 'memory', cpus: 'cpu', pidsLimit: 'pids' });

function liteSandboxRefusal(requested) {
    const fields = requested.map((entry) => entry.field).join(', ');
    return {
        reasonCode: 'lite_sandbox',
        reason: `This runtime cannot apply ${fields}.`,
        fix: 'Use the managed container lifecycle, or remove the limit. For host lite sandboxes, disable the lite sandbox before starting the container runtime.',
    };
}

function unpreparedRefusal(context) {
    if (context.unpreparedKind === 'cgroup') {
        return {
            reasonCode: 'cgroup_unsupported',
            reason: 'The Box needs writable cgroup v2 with nsdelegate.',
            fix: "Configure the host's unified delegated hierarchy and restart the Box; Ploinky will not change host mounts or boot settings.",
        };
    }
    if (context.unpreparedKind === 'runtime') {
        return {
            reasonCode: 'runtime_unverified',
            reason: `Hardware limits require verified crun and nested cgroupfs. Observed: ${context.runtimeObserved || 'unknown/unknown/unknown/unknown'}.`,
            fix: 'For the outer engine, set runtime="crun" in the [engine] section of that engine user\'s '
                + '~/.config/containers/containers.conf, then run ploinky restart. On macOS do this inside the Podman machine. '
                + 'A nested failure requires the supported immutable Box image and working podman --cgroup-manager=cgroupfs '
                + 'invocation; inspect ploinky diagnose before retrying.',
        };
    }
    if (context.unpreparedKind === 'parents') {
        return {
            reasonCode: 'backend_unavailable',
            reason: `This Box is not prepared for hardware limits: ${context.unpreparedDetail || 'the agent cgroup parents could not be created'}.`,
            fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
        };
    }
    return {
        reasonCode: 'unprepared',
        reason: `This Box is not prepared for hardware limits: ${context.unpreparedDetail || 'preparation was not proved'}.`,
        fix: 'On the host run ploinky limits status, repair the reported prerequisite, then ploinky restart.',
    };
}

function controllerRefusal(controller, context) {
    if (context.hostKind === 'macos') {
        return {
            reasonCode: 'controller_unavailable',
            reason: `The host does not delegate ${controller} to rootless Podman.`,
            fix: 'Apply the delegation commands inside podman machine ssh, then restart that Podman machine and run '
                + `ploinky restart on macOS. ${DELEGATION_COMMANDS.join(' ; ')}`,
        };
    }
    return {
        reasonCode: 'controller_unavailable',
        reason: `The host does not delegate ${controller} to rootless Podman.`,
        fix: 'Apply the delegation commands below on the Linux host, log out and back in, then run ploinky restart. '
            + `${DELEGATION_COMMANDS.join(' ; ')} (daemon-reload alone does not change an existing session)`,
    };
}

function storeRefusal(context) {
    return {
        reasonCode: 'store_unreadable',
        reason: `The hardware policy store cannot be read safely: ${context.storeDetail || 'unreadable'}.`,
        fix: 'On the host run ploinky limits clear --all to reset it, or restore a valid private store, then ploinky restart.',
    };
}

// Decide hardware eligibility for one admitted descriptor. Returns
// {applicable:false} outside the hardware boundary, otherwise
// {applicable:true, state:'eligible'|'refused', refusalParts, inputFingerprint}.
export function evaluateHardwareEligibility(descriptor, context, { helper = false, overrideProblem = null } = {}) {
    const requested = Array.isArray(descriptor?.hardwareRequest) ? descriptor.hardwareRequest : [];
    const runtimeKind = context.runtimeKind;
    // Internal helpers are never refused by hardware admission.
    if (helper) return Object.freeze({ applicable: false });
    if (runtimeKind === 'container' && !context.insideBox) return Object.freeze({ applicable: false });
    const hostNetwork = descriptor?.capabilities?.hostNetwork === true;
    const nestedPodman = descriptor?.capabilities?.nestedPodman === true;
    const inputFingerprint = hex64({
        schema: 1,
        agentId: String(descriptor?.agentId || ''),
        profileName: String(descriptor?.profileName || ''),
        runtimeKind,
        requested,
        hostNetwork,
        nestedPodman,
        overrideProblem,
        context: {
            insideBox: context.insideBox,
            gate: context.gate,
            prepared: context.prepared,
            backendReady: context.backendReady,
            controllers: context.controllers,
            hostKind: context.hostKind,
            unpreparedKind: context.unpreparedKind,
            unpreparedDetail: context.unpreparedDetail,
            runtimeObserved: context.runtimeObserved,
            storeState: context.storeState,
        },
    });
    let refusal = null;
    if (runtimeKind !== 'container') {
        if (hasHardwareRequest(requested)) refusal = liteSandboxRefusal(requested);
    } else if (context.storeState === 'unreadable') {
        // No non-helper agent can prove the absence of stored limits.
        refusal = storeRefusal(context);
    } else if (overrideProblem) {
        // The stored entry itself cannot be enforced (outside the current
        // envelope, or a GPU share this release cannot apply): refused with
        // its own reason and fix, never ignored or clamped.
        refusal = {
            reasonCode: overrideProblem.reasonCode,
            reason: overrideProblem.reason,
            fix: overrideProblem.fix,
            extraRequested: overrideProblem.requested || [],
        };
    } else if (hasHardwareRequest(requested)) {
        if (context.gate !== 'on') {
            refusal = {
                reasonCode: 'gate_off',
                reason: 'Hardware limits are off for this workspace.',
                fix: 'On the host run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart, or remove the declared limit.',
            };
        } else if (hostNetwork && nestedPodman) {
            // D4: the limited host-network + nestedPodman combination is not
            // supported in this release; an unlimited instance is unaffected.
            refusal = {
                reasonCode: 'host_network_nested_podman',
                reason: 'This release cannot enforce this hardware limit for host networking with nestedPodman.',
                fix: 'Use managed networking, remove nestedPodman capability, or remove the requested limit at its source.',
            };
        } else if (!context.prepared || !context.backendReady) {
            refusal = unpreparedRefusal(context);
        } else {
            for (const entry of requested) {
                const controller = CONTROLLER_BY_FIELD[entry.field];
                if (controller && !context.controllers.includes(controller)) {
                    refusal = controllerRefusal(controller, context);
                    break;
                }
            }
        }
    }
    let refusalParts = null;
    if (refusal) {
        // A refused stored entry replaces the declared value of the same field
        // (the stored layer wins), so each field is listed once.
        const { extraRequested = [], ...parts } = refusal;
        const merged = [
            ...requested.filter((entry) => !extraRequested.some((extra) => extra.field === entry.field)),
            ...extraRequested,
        ];
        refusalParts = Object.freeze({ ...parts, requested: merged });
    }
    return Object.freeze({
        applicable: true,
        state: refusal ? 'refused' : 'eligible',
        refusalParts,
        inputFingerprint,
    });
}

function orderedRequested(requested) {
    return [...requested].sort((left, right) => HARDWARE_FIELDS.indexOf(left.field) - HARDWARE_FIELDS.indexOf(right.field));
}

// Build the validated direct-refusal outcome for an exact instance.
export function buildDirectRefusal({ key, ref, alias = null, refusalParts, inputFingerprint }) {
    return validateHardwareOutcome({
        state: 'refused',
        code: HARDWARE_UNENFORCEABLE,
        reasonCode: refusalParts.reasonCode,
        key,
        ref,
        alias: alias || null,
        inputFingerprint,
        reason: refusalParts.reason,
        fix: refusalParts.fix,
        requested: orderedRequested(refusalParts.requested || []).map((entry) => ({
            field: entry.field, value: entry.value, source: entry.source,
        })),
        blockedBy: null,
        rootCause: {
            key,
            ref,
            field: orderedRequested(refusalParts.requested || [])[0]?.field || null,
            reason: refusalParts.reason,
            fix: refusalParts.fix,
        },
        causalPath: [key],
        omittedPathCount: 0,
        additionalCauseCount: 0,
    });
}

/**
 * Interactive create/reuse (plan §8.2): before either reusing or creating an
 * interactive container, any requested or stored memory/cpus/pidsLimit is
 * refused with the fix to use the managed lifecycle. Returns the validated
 * refusal outcome or null.
 */
export function interactiveHardwareRefusal({ manifest, profileConfig = null, ref, key, alias = null, context = null }) {
    const stored = context?.gate === 'on' && context.overrides instanceof Map ? context.overrides.get(ref) || null : null;
    const storedPolicy = stored
        ? { resources: { ...(stored.cpus !== undefined ? { cpus: String(stored.cpus) } : {}), ...(stored.memoryPercent !== undefined ? { memory: `${stored.memoryPercent}%` } : {}) } }
        : null;
    const requested = requestedHardwareLimits({
        manifestPolicy: manifest?.llmRuntime?.runtimePolicy || null,
        profilePolicy: profileConfig?.llmRuntime?.runtimePolicy || null,
        overridePolicy: storedPolicy,
    });
    if (!hasHardwareRequest(requested)) return null;
    return buildDirectRefusal({
        key,
        ref,
        alias,
        refusalParts: {
            reasonCode: 'interactive_runtime',
            reason: `This runtime cannot apply ${requested.map((entry) => entry.field).join(', ')}.`,
            fix: 'Use the managed container lifecycle, or remove the limit. For host lite sandboxes, disable the lite sandbox before starting the container runtime.',
            requested,
        },
        inputFingerprint: hex64({ schema: 1, interactive: true, ref, requested }),
    });
}
