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
} from '../../agentlib/contract.mjs';
import { sha256Hex } from '../../agentlib/fingerprint.mjs';
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
 * @returns {Readonly<{sourceDir: string, runtimePath: string, mode: string, fingerprint: string, commit: string, sourceIdHash: string, namespaced: boolean}>}
 */
export function agentLibGrant(runtimeKey, selection = null) {
    const active = selection || activeAgentLibSelection();
    const sourceDir = path.resolve(active.sourceDir);
    const runtimePath = agentLibLinkTarget(runtimeKey, active);
    return Object.freeze({
        sourceDir,
        runtimePath,
        mode: active.mode,
        fingerprint: active.fingerprint,
        commit: active.commit || '',
        sourceIdHash: sha256Hex(sourceDir),
        namespaced: runtimePath === AGENTLIB_STABLE_MOUNT_PATH,
    });
}

/** The reserved runtime environment an agent must receive for a grant. */
export function agentLibGrantEnv(grant) {
    return agentLibRuntimeEnv(
        { mode: grant.mode, contentFingerprint: grant.fingerprint, resolvedCommit: grant.commit },
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
 * The complete structured record stored with a managed runtime.
 *
 * Reuse and adoption compare this whole section, so a runtime that is missing a
 * required alias shadow — or that carries a different selection — fails closed
 * instead of being adopted.
 */
export function agentLibRuntimeRecord(grant, aliasShadows = []) {
    return {
        mode: grant.mode,
        fingerprint: grant.fingerprint,
        commit: grant.commit,
        sourceIdHash: grant.sourceIdHash,
        sourceDir: grant.sourceDir,
        runtimePath: grant.runtimePath,
        aliasShadows: aliasShadows.map((shadow) => shadow.runtimePath).sort(),
    };
}

/** Why a recorded grant no longer matches the desired one, or an empty string. */
export function agentLibRecordProblem(recorded, desired) {
    if (!recorded) return 'agentLib runtime record missing';
    for (const key of ['mode', 'fingerprint', 'sourceIdHash', 'sourceDir', 'runtimePath']) {
        if (String(recorded[key] ?? '') !== String(desired[key] ?? '')) {
            return `agentLib ${key} changed (${recorded[key] ?? 'null'} != ${desired[key] ?? 'null'})`;
        }
    }
    const recordedAliases = JSON.stringify([...(recorded.aliasShadows || [])].sort());
    const desiredAliases = JSON.stringify([...(desired.aliasShadows || [])].sort());
    if (recordedAliases !== desiredAliases) {
        return `agentLib alias shadows changed (${recordedAliases} != ${desiredAliases})`;
    }
    return '';
}

export { AGENTLIB_ENV };
