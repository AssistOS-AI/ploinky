// Agent hardware-limit declarations.
//
// Every agent declares memory, cpus and pidsLimit in a neutral top-level
// `hardwareLimits` object, in its manifest and in a profile. The same keys
// under `llmRuntime.runtimePolicy.resources` are deprecated but still read.
// One source (the manifest, or one raw profile) is one layer: a key declared
// in both places with different values is a conflict that refuses the agent;
// equal values count once. Readers fold the declaration into that layer's
// runtime policy here, so the effective policy, its hash and the rendered
// arguments are the same whichever field declared a value.

import { validateHardwareLimitsShape } from '../docker/containerRuntimePolicy.js';
import { declaredMemoryBytes } from './resolve.mjs';

export const DECLARED_LIMIT_FIELDS = Object.freeze(['memory', 'cpus', 'pidsLimit']);
export const DEPRECATED_LIMITS_PATH = 'llmRuntime.runtimePolicy.resources';
export const HARDWARE_LIMITS_FIELD = 'hardwareLimits';

const MAX_WARNING_PATHS = 8;
const MAX_VALUE_TEXT = 64;

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function neutralOf(source) {
    return plainObject(source?.hardwareLimits) ? source.hardwareLimits : null;
}

function legacyOf(source) {
    const resources = source?.llmRuntime?.runtimePolicy?.resources;
    return plainObject(resources) ? resources : null;
}

function declaresNeutral(source) {
    const neutral = neutralOf(source);
    return Boolean(neutral) && DECLARED_LIMIT_FIELDS.some((field) => neutral[field] !== undefined);
}

// Two declarations of one field are equal when they mean the same limit:
// memory in bytes (1g is 1024m), cpus as a number (1.0 is 1) and pidsLimit as
// an integer. A value either parser rejects is compared as written; the
// policy validator refuses it anyway.
function sameDeclaredValue(field, left, right) {
    if (String(left) === String(right)) return true;
    if (field === 'memory') {
        const a = declaredMemoryBytes(left); const b = declaredMemoryBytes(right);
        return a !== null && b !== null && a === b;
    }
    const a = Number(left); const b = Number(right);
    if (!/^[0-9]+(\.[0-9]+)?$/.test(String(left)) || !/^[0-9]+(\.[0-9]+)?$/.test(String(right)) || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    return field === 'pidsLimit' ? Number.isInteger(a) && Number.isInteger(b) && a === b : a === b;
}

/**
 * One layer's declaration: the value of each declared field (the neutral
 * field wins when both places declare it), the fields declared under the
 * deprecated path and the fields declared in both places with different
 * values.
 */
export function readDeclaredLimits(source) {
    const neutral = neutralOf(source);
    const legacy = legacyOf(source);
    const values = {};
    const deprecated = [];
    const conflicts = [];
    for (const field of DECLARED_LIMIT_FIELDS) {
        const declared = neutral?.[field];
        const old = legacy?.[field];
        if (old !== undefined) deprecated.push(field);
        if (declared !== undefined) values[field] = declared;
        else if (old !== undefined) values[field] = old;
        if (declared !== undefined && old !== undefined && !sameDeclaredValue(field, declared, old)) {
            conflicts.push(Object.freeze({ field, value: String(declared), deprecatedValue: String(old) }));
        }
    }
    return Object.freeze({ values: Object.freeze(values), deprecated: Object.freeze(deprecated), conflicts: Object.freeze(conflicts) });
}

/**
 * The runtime policy one layer contributes to buildEffectivePolicy, with its
 * hardware-limit declaration folded into `resources`. A layer without a
 * neutral declaration is returned unchanged, so every existing manifest keeps
 * its exact policy.
 */
export function declaredLayerPolicy(source, label = 'hardwareLimits') {
    const policy = source?.llmRuntime?.runtimePolicy;
    if (!plainObject(source) || source.hardwareLimits === undefined) return policy || null;
    validateHardwareLimitsShape(source.hardwareLimits, label);
    if (!declaresNeutral(source)) return policy || null;
    // An invalid policy or resources object is left for the policy validator.
    if (policy !== undefined && policy !== null && !plainObject(policy)) return policy;
    if (policy?.resources !== undefined && !plainObject(policy.resources)) return policy;
    const resources = { ...(policy?.resources || {}) };
    for (const field of DECLARED_LIMIT_FIELDS) delete resources[field];
    Object.assign(resources, readDeclaredLimits(source).values);
    return { ...(policy || {}), resources };
}

/**
 * Conflicts within the manifest layer and within each raw profile the
 * resolved profile is built from (the selected one and the default one),
 * each named with the values of that one raw layer. Without the manifest's
 * raw profiles, the resolver's merged profile (see mergeProfileHardwareLimits,
 * which keeps a raw profile's conflict) is read as one unnamed profile layer.
 */
export function hardwareDeclarationConflicts({ manifest = null, profileConfig = null, profileName = '' } = {}) {
    const conflicts = [];
    for (const conflict of readDeclaredLimits(manifest).conflicts) conflicts.push({ layer: 'manifest', ...conflict });
    const profiles = plainObject(manifest?.profiles) ? manifest.profiles : null;
    const selected = String(profileName || '');
    if (profiles && selected && Object.hasOwn(profiles, selected)) {
        for (const name of selected === 'default' ? ['default'] : [selected, 'default']) {
            if (!Object.hasOwn(profiles, name)) continue;
            for (const conflict of readDeclaredLimits(profiles[name]).conflicts) conflicts.push({ layer: `profile ${safeName(name)}`, ...conflict });
        }
        return conflicts;
    }
    for (const conflict of readDeclaredLimits(profileConfig).conflicts) conflicts.push({ layer: 'profile', ...conflict });
    return conflicts;
}

function conflictOf(source, field) {
    return readDeclaredLimits(source).conflicts.some((entry) => entry.field === field);
}

/**
 * Profile semantics for the three hardware-limit keys. Each raw profile is
 * normalized on its own; the selected profile then overrides the default
 * profile key by key, and keys it leaves undeclared are inherited. Inheriting
 * across profiles is never a conflict. A conflict inside either raw profile
 * is kept, as both of its values, so admission refuses the agent. Every other
 * merged field, including the rest of `llmRuntime`, is left as the caller
 * merged it.
 */
export function mergeProfileHardwareLimits(merged, defaultProfile, selectedProfile) {
    const base = readDeclaredLimits(defaultProfile);
    const selected = readDeclaredLimits(selectedProfile);
    const declared = (reading, field) => reading.values[field] !== undefined;
    if (!DECLARED_LIMIT_FIELDS.some((field) => declared(base, field) || declared(selected, field))) return merged;
    const hardwareLimits = {};
    const keptConflicts = {};
    for (const field of DECLARED_LIMIT_FIELDS) {
        const conflicting = conflictOf(selectedProfile, field) ? selectedProfile
            : conflictOf(defaultProfile, field) ? defaultProfile : null;
        if (conflicting) {
            hardwareLimits[field] = neutralOf(conflicting)[field];
            keptConflicts[field] = legacyOf(conflicting)[field];
        } else if (declared(selected, field)) {
            hardwareLimits[field] = selected.values[field];
        } else if (declared(base, field)) {
            hardwareLimits[field] = base.values[field];
        }
    }
    const out = { ...merged, hardwareLimits };
    const policy = merged?.llmRuntime?.runtimePolicy;
    const inherited = plainObject(policy) && plainObject(policy.resources) ? policy.resources : null;
    if (inherited || Object.keys(keptConflicts).length) {
        const resources = { ...(inherited || {}) };
        for (const field of DECLARED_LIMIT_FIELDS) delete resources[field];
        Object.assign(resources, keptConflicts);
        out.llmRuntime = {
            ...(plainObject(merged?.llmRuntime) ? merged.llmRuntime : {}),
            runtimePolicy: { ...(plainObject(policy) ? policy : {}), resources },
        };
    }
    return out;
}

function boundedText(value) {
    const text = String(value);
    return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT)}…` : text;
}

/** The typed refusal parts for declaration conflicts. */
export function declarationConflictRefusal(conflicts) {
    const describe = (entry) => `the ${entry.layer} declares ${entry.field} as ${boundedText(entry.value)} in hardwareLimits `
        + `and as ${boundedText(entry.deprecatedValue)} in the deprecated ${DEPRECATED_LIMITS_PATH}`;
    const fields = [...new Set(conflicts.map((entry) => entry.field))];
    return {
        reasonCode: 'declaration_conflict',
        reason: `Conflicting hardware limit declarations: ${conflicts.map(describe).join('; ')}.`,
        fix: `Declare ${fields.join(', ')} only under hardwareLimits and remove ${fields.length === 1 ? 'it' : 'them'} `
            + `from ${DEPRECATED_LIMITS_PATH} in the same manifest or profile.`,
    };
}

function safeName(value) {
    return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/**
 * The manifest's declarations under the deprecated path, at its root and in
 * each profile, as bounded field paths without values.
 */
export function deprecatedHardwareDeclarations(manifest) {
    if (!plainObject(manifest)) return [];
    const paths = [];
    const add = (prefix, source) => {
        for (const field of readDeclaredLimits(source).deprecated) paths.push(`${prefix}${DEPRECATED_LIMITS_PATH}.${field}`);
    };
    add('', manifest);
    if (plainObject(manifest.profiles)) {
        for (const name of Object.keys(manifest.profiles).sort()) add(`profiles.${safeName(name)}.`, manifest.profiles[name]);
    }
    return paths;
}

/** A bounded note for status readers, or null. */
export function deprecatedDeclarationNote(manifest) {
    const paths = deprecatedHardwareDeclarations(manifest);
    if (!paths.length) return null;
    return Object.freeze({
        paths: Object.freeze(paths.slice(0, MAX_WARNING_PATHS)),
        omitted: Math.max(0, paths.length - MAX_WARNING_PATHS),
        replacement: HARDWARE_LIMITS_FIELD,
    });
}

const warned = new Set();
const DEFAULT_WARNING_SINK = (message) => console.warn(message);
let warningSink = DEFAULT_WARNING_SINK;

export function setHardwareDeclarationWarningSink(sink) {
    warningSink = typeof sink === 'function' ? sink : DEFAULT_WARNING_SINK;
    warned.clear();
}

/**
 * Warn once per process (one command, or one Router start) for each agent's
 * deprecated declaration. The message names the agent, the deprecated paths
 * and the replacement field; it carries no values and no manifest content.
 */
export function warnDeprecatedHardwareDeclarations(manifest, agentRef) {
    const note = deprecatedDeclarationNote(manifest);
    if (!note) return false;
    const ref = String(agentRef || 'agent').slice(0, 257);
    const key = `${ref}\0${note.paths.join('\0')}\0${note.omitted}`;
    if (warned.has(key)) return false;
    warned.add(key);
    const more = note.omitted ? ` and ${note.omitted} more` : '';
    warningSink(`[hardware-limits] ${ref}: ${note.paths.join(', ')}${more} ${note.paths.length + note.omitted === 1 ? 'is' : 'are'} `
        + `deprecated; declare memory, cpus and pidsLimit under ${HARDWARE_LIMITS_FIELD} at the manifest root or in the same profile.`);
    return true;
}
