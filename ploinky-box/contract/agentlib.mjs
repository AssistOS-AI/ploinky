// The Box side of the achillesAgentLib contract.
//
// A local selection is one host directory exposed to the Box twice: once at the
// stable runtime path every mount namespace agrees on, and once as a read-only
// shadow over the alias the broad writable workspace bind would otherwise
// expose. Without that second bind the same inode stays writable through the
// workspace and the stable read-only mount is not a real confinement boundary.
//
// An image selection has no host source: the library is the copy the outer Box
// image supplies at the stable path, identified by that image's immutable ID.

import path from 'node:path';

import {
    AGENTLIB_ENV,
    AGENTLIB_STABLE_MOUNT_PATH,
    BOX_IMAGE_ID_ENV,
    agentLibRuntimeEnv,
    agentLibSourceIdHash,
    assertSupplyingImageId,
    imageSourceIdentity,
    imageSourceIdHash,
} from '../../agentlib/contract.mjs';
import { BOX_AGENTLIB_LABELS, INCOMPATIBLE_BOX_GUIDANCE } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { normalizeImageId } from './image-id.mjs';
import { boxWorkspacePath } from './workspace-root.mjs';

function agentLibContractError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE' });
}

/**
 * Freeze one AgentLib selection into the exact values the Box contract uses.
 *
 * Accepts either an `AgentLibSelection` or an already-normalized contract, so
 * threading a contract through a second validation boundary is idempotent
 * rather than a spurious "missing fingerprint" failure. The two modes have
 * distinct shapes: a local contract carries its content fingerprint and Git
 * commit, an image contract only the immutable image ID that supplies it.
 *
 * @param {object} selection - an AgentLibSelection with `sourceDir`, or a contract
 * @returns {Readonly<object>}
 */
export function normalizeBoxAgentLib(selection) {
    const sourceDir = String(selection?.sourceDir || '');
    const sourceRelativePath = String(selection?.sourceRelativePath || '');
    const mode = String(selection?.mode || '');
    if (!path.isAbsolute(sourceDir)) {
        throw agentLibContractError('Box AgentLib contract requires an absolute selected source directory');
    }
    if (!sourceRelativePath || sourceRelativePath.startsWith('/') || sourceRelativePath.split('/').includes('..')) {
        throw agentLibContractError('Box AgentLib contract requires a workspace-relative source path');
    }
    if (!['local', 'image'].includes(mode)) {
        throw agentLibContractError(`Box AgentLib contract has an unknown source mode '${mode}'`);
    }
    if (!selection?.sourceId && !/^[a-f0-9]{64}$/.test(String(selection?.sourceIdHash || ''))) {
        throw agentLibContractError('Box AgentLib contract requires a source identity');
    }
    if (mode === 'image') {
        let supplyingImageId;
        try {
            supplyingImageId = assertSupplyingImageId(
                normalizeImageId(selection?.supplyingImageId ?? selection?.sourceId?.supplyingImageId),
            );
        } catch (error) {
            throw agentLibContractError(`Box AgentLib image selection has no immutable supplying image: ${error.message}`);
        }
        const identityHash = imageSourceIdHash(imageSourceIdentity(supplyingImageId));
        if (sourceDir !== AGENTLIB_STABLE_MOUNT_PATH || sourceRelativePath !== 'image'
            || (selection?.sourceIdHash !== undefined && String(selection.sourceIdHash) !== identityHash)
            || (selection?.sourceId && agentLibSourceIdHash(selection) !== identityHash)) {
            throw agentLibContractError('Box AgentLib image selection has an incompatible path or immutable identity');
        }
        return Object.freeze({
            sourceDir: AGENTLIB_STABLE_MOUNT_PATH,
            sourceRelativePath,
            mode,
            sourceIdHash: identityHash,
            supplyingImageId,
            stablePath: AGENTLIB_STABLE_MOUNT_PATH,
        });
    }
    const fingerprint = String(selection?.contentFingerprint ?? selection?.fingerprint ?? '');
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
        throw agentLibContractError('Box AgentLib contract requires a 64-hex content fingerprint');
    }
    return Object.freeze({
        sourceDir: path.resolve(sourceDir),
        sourceRelativePath,
        mode,
        fingerprint,
        commit: String(selection?.resolvedCommit ?? selection?.commit ?? ''),
        sourceIdHash: selection?.sourceId
            ? agentLibSourceIdHash(selection)
            : String(selection?.sourceIdHash || ''),
        stablePath: AGENTLIB_STABLE_MOUNT_PATH,
    });
}

/**
 * The Box path at which the writable workspace bind also exposes the selected
 * source. The contract records it workspace-relative; the alias exists only
 * for one selected workspace root.
 *
 * @param {Readonly<object>} contract
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function agentLibAliasPath(contract, workspaceRoot) {
    if (contract.mode === 'image') {
        throw agentLibContractError('An image AgentLib selection has no workspace alias');
    }
    return boxWorkspacePath(workspaceRoot, contract.sourceRelativePath);
}

/** The two exact read-only binds, keyed by container destination. */
export function expectedAgentLibMounts(contract, workspaceRoot) {
    if (contract.mode === 'image') return {};
    return {
        [contract.stablePath]: { source: contract.sourceDir, rw: false },
        [agentLibAliasPath(contract, workspaceRoot)]: { source: contract.sourceDir, rw: false },
    };
}

/**
 * Mount arguments for `container create`.
 *
 * The alias shadow must be rendered after the writable workspace bind so the
 * read-only mount lands on top of it.
 */
export function agentLibMountArgs(contract, workspaceRoot) {
    if (contract.mode === 'image') return [];
    return [
        '--volume', `${contract.sourceDir}:${contract.stablePath}:ro`,
        '--volume', `${contract.sourceDir}:${agentLibAliasPath(contract, workspaceRoot)}:ro`,
    ];
}

/** The reserved runtime environment, as it appears inside the Box. */
export function agentLibBoxEnv(contract) {
    if (contract.mode === 'image') {
        return agentLibRuntimeEnv({ mode: 'image', sourceIdHash: contract.sourceIdHash }, contract.stablePath);
    }
    return agentLibRuntimeEnv(
        {
            mode: contract.mode,
            contentFingerprint: contract.fingerprint,
            resolvedCommit: contract.commit,
            sourceIdHash: contract.sourceIdHash,
        },
        contract.stablePath,
    );
}

export function agentLibEnvArgs(contract) {
    return Object.entries(agentLibBoxEnv(contract)).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

/**
 * The engine-observed immutable outer image ID, as the Box environment carries
 * it. It is set once when the Box is created and inherited by every process in
 * it; it is independent of the AgentLib mode.
 */
export function boxImageIdEnv(imageId) {
    return { [BOX_IMAGE_ID_ENV]: assertSupplyingImageId(normalizeImageId(imageId), 'Box image ID') };
}

export function agentLibLabels(contract) {
    if (contract.mode === 'image') {
        return {
            [BOX_AGENTLIB_LABELS.mode]: contract.mode,
            [BOX_AGENTLIB_LABELS.sourceIdHash]: contract.sourceIdHash,
            [BOX_AGENTLIB_LABELS.sourceRelativePath]: contract.sourceRelativePath,
        };
    }
    return {
        [BOX_AGENTLIB_LABELS.mode]: contract.mode,
        [BOX_AGENTLIB_LABELS.sourceIdHash]: contract.sourceIdHash,
        [BOX_AGENTLIB_LABELS.fingerprint]: contract.fingerprint,
        [BOX_AGENTLIB_LABELS.sourceRelativePath]: contract.sourceRelativePath,
        [BOX_AGENTLIB_LABELS.commit]: contract.commit,
    };
}

/**
 * Reconstruct the desired AgentLib contract of an existing Box from its labels
 * and observed mounts and image.
 *
 * Labels alone are never treated as proof: a local source is read back from the
 * observed mount set, and an image source from the observed image ID, so a
 * relabelled Box cannot claim a source it does not actually have.
 *
 * @returns {Readonly<object>}
 */
export function agentLibContractFromContainer(container) {
    const labels = container?.labels || {};
    const mode = String(labels[BOX_AGENTLIB_LABELS.mode] || '');
    const fingerprint = String(labels[BOX_AGENTLIB_LABELS.fingerprint] || '');
    const sourceRelativePath = String(labels[BOX_AGENTLIB_LABELS.sourceRelativePath] || '');
    const sourceIdHashValue = String(labels[BOX_AGENTLIB_LABELS.sourceIdHash] || '');
    const commit = String(labels[BOX_AGENTLIB_LABELS.commit] || '');
    if (!mode && !fingerprint && !sourceRelativePath && !sourceIdHashValue && !commit) {
        throw agentLibContractError('Owned Box is missing its required AgentLib selection labels');
    }
    const mounts = Array.isArray(container?.runtime?.mounts) ? container.runtime.mounts : [];
    const stable = mounts.find((mount) => mount.destination === AGENTLIB_STABLE_MOUNT_PATH);
    if (mode === 'image') {
        if (stable) throw agentLibContractError('An image AgentLib selection must not have a source bind mount');
        try {
            return normalizeBoxAgentLib({
                sourceDir: AGENTLIB_STABLE_MOUNT_PATH,
                sourceRelativePath,
                mode,
                sourceIdHash: sourceIdHashValue,
                supplyingImageId: container?.runtime?.imageId,
            });
        } catch (error) {
            // A Box whose image AgentLib labels follow another contract (one
            // created by an earlier Ploinky, for example) is not adapted.
            if (error?.code !== 'PLOINKY_BOX_AGENTLIB_INCOMPATIBLE') throw error;
            throw agentLibContractError(`Owned Box AgentLib labels are incompatible (${error.message})${INCOMPATIBLE_BOX_GUIDANCE}`);
        }
    }
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
        commit,
        sourceIdHash: sourceIdHashValue,
        stablePath: AGENTLIB_STABLE_MOUNT_PATH,
    });
}

/**
 * Whether a running Box must be replaced because the selection changed.
 *
 * Source directory identity, mode, and (local) content fingerprint each
 * independently force replacement: a Box may not keep an old inode mounted
 * after the workspace selected different bytes. An image selection changes
 * only with the outer image that supplies it.
 */
export function agentLibSelectionChanged(current, desired) {
    if (!current) return true;
    if (current.sourceDir !== desired.sourceDir
        || current.sourceRelativePath !== desired.sourceRelativePath
        || current.mode !== desired.mode
        || current.sourceIdHash !== desired.sourceIdHash) {
        return true;
    }
    return desired.mode === 'image'
        ? current.supplyingImageId !== desired.supplyingImageId
        : current.commit !== desired.commit || current.fingerprint !== desired.fingerprint;
}

export { AGENTLIB_ENV, AGENTLIB_STABLE_MOUNT_PATH, BOX_IMAGE_ID_ENV };
