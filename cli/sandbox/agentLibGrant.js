// The achillesAgentLib grant every agent runtime receives.
//
// One selected host directory reaches each runtime as a read-only source, plus
// read-only shadows over any alias a broader writable bind already exposes.
// Without those shadows the same inode would stay writable through the project
// or workspace mount, and the stable read-only grant would not be a real
// confinement boundary.

import path from 'path';

import {
    AGENTLIB_ENV,
    AGENTLIB_ERROR_CODES,
    AGENTLIB_STABLE_MOUNT_PATH,
    agentLibError,
    agentLibRuntimeEnv,
    assertSupplyingImageId,
} from '../../agentlib/contract.mjs';
import { activeAgentLibSelection, agentLibLinkTarget } from '../utils/dependencies/agentLibLink.js';

export { AGENTLIB_STABLE_MOUNT_PATH, activeAgentLibSelection };

/**
 * The grant for one runtime key.
 *
 * Container and bwrap runtimes see the source at the stable path in their own
 * mount namespace. Seatbelt creates no mount namespace, so it is granted the
 * canonical host path directly.
 *
 * @param {string} runtimeKey
 * @param {object} [selection] - defaults to this process's runtime contract
 * @returns {Readonly<{sourceDir: string, runtimePath: string, mode: string, sourceIdHash: string, namespaced: boolean, fingerprint?: string, commit?: string, supplyingImageId?: string}>}
 *   A local grant carries the content fingerprint and commit; an image grant
 *   carries the outer Box image ID that supplies the source.
 */
export function agentLibGrant(runtimeKey, selection = null) {
    const active = selection || activeAgentLibSelection();
    const sourceDir = path.resolve(active.sourceDir);
    const runtimePath = agentLibLinkTarget(runtimeKey, active);
    const sourceIdHash = String(active.sourceIdHash || '');
    if (!/^[a-f0-9]{64}$/.test(sourceIdHash)) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            'Agent runtime admission requires the selected achillesAgentLib source identity.',
        );
    }
    const common = {
        sourceDir,
        runtimePath,
        mode: active.mode,
        sourceIdHash,
        namespaced: runtimePath === AGENTLIB_STABLE_MOUNT_PATH,
    };
    if (active.mode === 'image') {
        return Object.freeze({
            ...common,
            supplyingImageId: assertSupplyingImageId(active.supplyingImageId),
        });
    }
    return Object.freeze({
        ...common,
        fingerprint: active.fingerprint,
        commit: active.commit || '',
    });
}

/**
 * The reserved runtime environment an agent must receive for a grant. It never
 * carries the outer Box image ID: nothing inside a nested runtime consumes it.
 */
export function agentLibGrantEnv(grant) {
    if (grant.mode === 'image') {
        return agentLibRuntimeEnv({ mode: 'image', sourceIdHash: grant.sourceIdHash }, grant.runtimePath);
    }
    return agentLibRuntimeEnv(
        {
            mode: grant.mode,
            contentFingerprint: grant.fingerprint,
            resolvedCommit: grant.commit,
            sourceIdHash: grant.sourceIdHash,
        },
        grant.runtimePath,
    );
}

/**
 * Read-only shadows for every alias a writable bind exposes for the source.
 *
 * `writableBinds` is the compiled list of writable host→runtime mappings. Each
 * one that contains the selected source yields an exact read-only shadow at the
 * alias path. A writable mapping whose alias cannot be computed unambiguously
 * fails admission rather than being ignored.
 *
 * @param {object} grant
 * @param {Array<{hostPath: string, runtimePath: string}>} writableBinds
 * @returns {Array<{hostPath: string, runtimePath: string}>}
 */
export function agentLibAliasShadows(grant, writableBinds = []) {
    const shadows = [];
    const seen = new Set();
    for (const bind of writableBinds) {
        const hostPath = String(bind?.hostPath || '');
        const runtimePath = String(bind?.runtimePath || '');
        if (!hostPath || !runtimePath) continue;
        const base = path.resolve(hostPath);
        if (grant.sourceDir !== base && !grant.sourceDir.startsWith(`${base}${path.sep}`)) continue;
        const relative = path.relative(base, grant.sourceDir);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.pathEscape,
                `Cannot compute an unambiguous achillesAgentLib alias for the writable bind `
                + `${base} -> ${runtimePath}; refusing to admit a writable source.`,
            );
        }
        const alias = relative === ''
            ? runtimePath
            : path.posix.join(runtimePath, relative.split(path.sep).join('/'));
        if (alias === grant.runtimePath || seen.has(alias)) continue;
        seen.add(alias);
        shadows.push({ hostPath: grant.sourceDir, runtimePath: alias });
    }
    return shadows;
}

/**
 * The minimal generation identity stored with a managed runtime.
 *
 * Mount paths and aliases are derived from the runtime configuration at launch;
 * persisting them duplicates configuration without improving reuse decisions.
 */
export function agentLibRuntimeRecord(grant) {
    if (grant.mode === 'image') {
        return {
            supplyingImageId: grant.supplyingImageId,
            sourceIdHash: grant.sourceIdHash,
        };
    }
    return {
        fingerprint: grant.fingerprint,
        sourceIdHash: grant.sourceIdHash,
    };
}

export { AGENTLIB_ENV };

/**
 * Why a running runtime must not be reused for this grant, or an empty string.
 *
 * The AgentLib selection is not derivable from a manifest or profile, so the
 * config-derived env hash cannot detect a changed source on its own. Every
 * runtime family therefore compares the recorded grant explicitly: a local edit
 * plus `ploinky restart` must replace core AND every agent, never leave them on
 * different active selections.
 *
 * @param {object} existingRecord - the persisted runtime record
 * @param {object} grant
 * @returns {string}
 */
export function agentLibReuseProblem(existingRecord, grant) {
    const recorded = existingRecord?.agentLib;
    if (!recorded) return 'agentLib runtime record missing';
    // Compare exactly the identity this grant records: a record of the other
    // mode, or of a shape this version does not write, never matches.
    const expected = agentLibRuntimeRecord(grant);
    for (const key of Object.keys(expected)) {
        if (String(recorded[key] ?? '') !== String(expected[key] ?? '')) {
            return `agentLib ${key} changed (${recorded[key] ?? 'null'} != ${expected[key] ?? 'null'})`;
        }
    }
    return '';
}
