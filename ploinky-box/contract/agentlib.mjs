// The Box side of the direct-mounted achillesAgentLib contract.
//
// One selected host directory is exposed to the Box twice: once at the stable
// runtime path every mount namespace agrees on, and once as a read-only shadow
// over the alias the broad writable `/workspace` bind would otherwise expose.
// Without that second bind the same inode stays writable through `/workspace`
// and the stable read-only mount is not a real confinement boundary.

import path from 'node:path';

import {
    AGENTLIB_ENV,
    AGENTLIB_STABLE_MOUNT_PATH,
    agentLibRuntimeEnv,
} from '../../agentlib/contract.mjs';
import { sourceIdHash } from '../../agentlib/fingerprint.mjs';
import { BOX_AGENTLIB_LABELS, BOX_WORKSPACE_MOUNT } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';

function agentLibContractError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
}

/**
 * Freeze one AgentLib selection into the exact values the Box contract uses.
 *
 * Accepts either an `AgentLibSelection` or an already-normalized contract, so
 * threading a contract through a second validation boundary is idempotent
 * rather than a spurious "missing fingerprint" failure.
 *
 * @param {object} selection - an AgentLibSelection with `sourceDir`, or a contract
 * @returns {Readonly<object>}
 */
export function normalizeBoxAgentLib(selection) {
    const sourceDir = String(selection?.sourceDir || '');
    const sourceRelativePath = String(selection?.sourceRelativePath || '');
    const fingerprint = String(selection?.contentFingerprint ?? selection?.fingerprint ?? '');
    const mode = String(selection?.mode || '');
    if (!path.isAbsolute(sourceDir)) {
        throw agentLibContractError('Box AgentLib contract requires an absolute selected source directory');
    }
    if (!sourceRelativePath || sourceRelativePath.startsWith('/') || sourceRelativePath.split('/').includes('..')) {
        throw agentLibContractError('Box AgentLib contract requires a workspace-relative source path');
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw agentLibContractError('Box AgentLib contract requires a 64-hex content fingerprint');
    }
    if (!['local', 'managed'].includes(mode)) {
        throw agentLibContractError(`Box AgentLib contract has an unknown source mode '${mode}'`);
    }
    if (!selection?.sourceId && !/^[a-f0-9]{64}$/.test(String(selection?.sourceIdHash || ''))) {
        throw agentLibContractError('Box AgentLib contract requires a source identity');
    }
    return Object.freeze({
        sourceDir: path.resolve(sourceDir),
        sourceRelativePath,
        mode,
        fingerprint,
        commit: String(selection?.resolvedCommit ?? selection?.commit ?? ''),
        sourceIdHash: selection?.sourceId
            ? sourceIdHash(selection.sourceId)
            : String(selection?.sourceIdHash || ''),
        stablePath: AGENTLIB_STABLE_MOUNT_PATH,
        aliasPath: path.posix.join(BOX_WORKSPACE_MOUNT, sourceRelativePath),
    });
}

/** The two exact read-only binds, keyed by container destination. */
export function expectedAgentLibMounts(contract) {
    return {
        [contract.stablePath]: { source: contract.sourceDir, rw: false },
        [contract.aliasPath]: { source: contract.sourceDir, rw: false },
    };
}

/**
 * Mount arguments for `container create`.
 *
 * The alias shadow must be rendered after the writable `/workspace` bind so the
 * read-only mount lands on top of it.
 */
export function agentLibMountArgs(contract) {
    return [
        '--volume', `${contract.sourceDir}:${contract.stablePath}:ro`,
        '--volume', `${contract.sourceDir}:${contract.aliasPath}:ro`,
    ];
}

/** The reserved runtime environment, as it appears inside the Box. */
export function agentLibBoxEnv(contract) {
    return agentLibRuntimeEnv(
        { mode: contract.mode, contentFingerprint: contract.fingerprint, resolvedCommit: contract.commit },
        contract.stablePath,
    );
}

export function agentLibEnvArgs(contract) {
    return Object.entries(agentLibBoxEnv(contract)).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

export function agentLibLabels(contract) {
    return {
        [BOX_AGENTLIB_LABELS.mode]: contract.mode,
        [BOX_AGENTLIB_LABELS.sourceIdHash]: contract.sourceIdHash,
        [BOX_AGENTLIB_LABELS.fingerprint]: contract.fingerprint,
        [BOX_AGENTLIB_LABELS.sourceRelativePath]: contract.sourceRelativePath,
    };
}

/**
 * Reconstruct the desired AgentLib contract of an existing Box from its labels
 * and observed mounts.
 *
 * Labels alone are never treated as proof: the real bind source is read back
 * from the observed mount set, so a relabelled Box cannot claim a source it
 * does not actually have.
 *
 * @returns {Readonly<object>|null} null when the Box predates this contract
 */
export function agentLibContractFromContainer(container) {
    const labels = container?.labels || {};
    const mode = String(labels[BOX_AGENTLIB_LABELS.mode] || '');
    const fingerprint = String(labels[BOX_AGENTLIB_LABELS.fingerprint] || '');
    const sourceRelativePath = String(labels[BOX_AGENTLIB_LABELS.sourceRelativePath] || '');
    const sourceIdHashValue = String(labels[BOX_AGENTLIB_LABELS.sourceIdHash] || '');
    if (!mode && !fingerprint && !sourceRelativePath && !sourceIdHashValue) return null;
    const mounts = Array.isArray(container?.runtime?.mounts) ? container.runtime.mounts : [];
    const stable = mounts.find((mount) => mount.destination === AGENTLIB_STABLE_MOUNT_PATH);
    if (!stable) {
        throw agentLibContractError(
            `Owned Box declares an AgentLib selection but has no ${AGENTLIB_STABLE_MOUNT_PATH} mount`,
        );
    }
    return Object.freeze({
        sourceDir: String(stable.source || ''),
        sourceRelativePath,
        mode,
        fingerprint,
        commit: '',
        sourceIdHash: sourceIdHashValue,
        stablePath: AGENTLIB_STABLE_MOUNT_PATH,
        aliasPath: path.posix.join(BOX_WORKSPACE_MOUNT, sourceRelativePath),
    });
}

/**
 * Whether a running Box must be replaced because the selection changed.
 *
 * Source directory identity, mode, and content fingerprint each independently
 * force replacement: a Box may not keep an old inode mounted after the
 * workspace selected different bytes.
 */
export function agentLibSelectionChanged(current, desired) {
    if (!current) return true;
    return current.sourceDir !== desired.sourceDir
        || current.sourceRelativePath !== desired.sourceRelativePath
        || current.mode !== desired.mode
        || current.sourceIdHash !== desired.sourceIdHash
        || current.fingerprint !== desired.fingerprint;
}

export { AGENTLIB_ENV, AGENTLIB_STABLE_MOUNT_PATH };
