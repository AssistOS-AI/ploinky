// Establish the achillesAgentLib runtime contract before any framework import.
//
// Outside the Box this resolves the local workspace source. Inside the Box it
// validates the selected local mount or the image-supplied copy before imports.

import fs from 'node:fs';
import path from 'node:path';

import {
    AGENTLIB_ENV,
    AGENTLIB_ERROR_CODES,
    AGENTLIB_PACKAGE_NAME,
    AGENTLIB_STABLE_MOUNT_PATH,
    BOX_IMAGE_ID_ENV,
    agentLibError,
    agentLibRuntimeEnv,
    assertNoRemovedAgentLibSettings,
    assertSupplyingImageId,
    imageSourceIdHash,
    imageSourceIdentity,
} from './contract.mjs';
import { resolveWorkspaceRoot } from './source.mjs';
import { verifyImageAgentLibPackage } from './image-bundle.mjs';

let bootstrapped = null;

/**
 * True when this process runs inside the outer Box.
 *
 * The marker file is part of the immutable Box image contract, so it is the one
 * reliable signal that does not depend on an environment variable a caller
 * could set.
 */
export function isInsideBoxRuntime({ fsApi = fs, markerPath = '/etc/ploinky-box' } = {}) {
    try {
        return fsApi.statSync(markerPath).isFile();
    } catch (_) {
        return false;
    }
}

function validateProvidedContract({ env, fsApi, expectedDir }) {
    const declared = String(env[AGENTLIB_ENV.dir] || '').trim();
    if (!declared) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.dir} is not set inside the Box. The host supervisor owns achillesAgentLib `
            + 'selection; start this workspace with `ploinky start`.',
        );
    }
    if (expectedDir && declared !== expectedDir) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.dir} must be ${expectedDir} inside the Box (got ${declared}).`,
        );
    }
    let root;
    try {
        root = fsApi.realpathSync(declared);
    } catch (error) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `The achillesAgentLib direct mount is missing at ${declared}.`,
            { cause: error },
        );
    }
    let pkg;
    try {
        pkg = JSON.parse(fsApi.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch (error) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `The achillesAgentLib direct mount at ${root} has no readable package.json.`,
            { cause: error },
        );
    }
    if (pkg?.name !== AGENTLIB_PACKAGE_NAME) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `The achillesAgentLib direct mount at ${root} declares package name '${String(pkg?.name)}'.`,
        );
    }
    if (!/^[a-f0-9]{64}$/.test(String(env[AGENTLIB_ENV.sourceId] || ''))) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.sourceId} must carry the selected source identity.`,
        );
    }
    const mode = String(env[AGENTLIB_ENV.mode] || '');
    if (!['local', 'image'].includes(mode)) {
        throw agentLibError(AGENTLIB_ERROR_CODES.contractMissing, 'The Box AgentLib source mode is missing or invalid.');
    }
    if (mode === 'image') {
        // The image copy is identified by the outer Box image the host created
        // this container from, never by its content or a Git revision.
        const supplyingImageId = assertSupplyingImageId(env[BOX_IMAGE_ID_ENV], `${BOX_IMAGE_ID_ENV} value`);
        if (env[AGENTLIB_ENV.sourceId] !== imageSourceIdHash(imageSourceIdentity(supplyingImageId))) {
            throw agentLibError(AGENTLIB_ERROR_CODES.contractMissing,
                'The image AgentLib source identity does not match the Box image that supplies it.');
        }
        const image = verifyImageAgentLibPackage({ sourceDir: declared, fsApi });
        return {
            sourceDir: root,
            mode,
            fingerprint: '',
            commit: image.provenance.commit || '',
            sourceIdHash: String(env[AGENTLIB_ENV.sourceId]),
            supplyingImageId,
            owned: false,
        };
    }
    if (!/^[a-f0-9]{64}$/.test(String(env[AGENTLIB_ENV.fingerprint] || ''))) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.fingerprint} must carry the selected content fingerprint.`,
        );
    }
    return {
        sourceDir: root,
        mode,
        fingerprint: String(env[AGENTLIB_ENV.fingerprint] || ''),
        commit: String(env[AGENTLIB_ENV.commit] || ''),
        sourceIdHash: String(env[AGENTLIB_ENV.sourceId] || ''),
        owned: false,
    };
}

/**
 * Prepare the AgentLib runtime contract for this process.
 *
 * Call this before importing any module that resolves achillesAgentLib. It is
 * idempotent: repeated calls return the first result rather than re-selecting.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {boolean} [opts.insideBox]
 * @param {(params: object) => Promise<{selection: object}>} [opts.select] - host selector
 * @param {{branch: string|null, fallback: 'default'|'fail'}|null} [opts.branchPolicy]
 * @param {boolean} [opts.readOnly] - forbid any clone, fetch, or state creation
 * @returns {Promise<{sourceDir: string, mode: string, fingerprint: string, commit: string, owned: boolean}>}
 */
export async function bootstrapAgentLibRuntime({
    env = process.env,
    fsApi = fs,
    insideBox = null,
    select = null,
    branchPolicy = null,
    readOnly = false,
    cwd = process.cwd(),
    force = false,
} = {}) {
    if (bootstrapped && !force) return bootstrapped;
    assertNoRemovedAgentLibSettings(env);
    const inBox = insideBox === null ? isInsideBoxRuntime({ fsApi }) : insideBox;
    if (inBox) {
        bootstrapped = validateProvidedContract({
            env,
            fsApi,
            expectedDir: AGENTLIB_STABLE_MOUNT_PATH,
        });
        return bootstrapped;
    }
    // Host source authority always comes from the resolved workspace. Ambient
    // AgentLib variables are deliberately overwritten rather than trusted: a
    // stale shell or parent process must not bypass a present local checkout.
    const workspaceRoot = resolveWorkspaceRoot({ cwd, env, fsApi });
    env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
    const selector = select
        || (await import('../ploinky-box/agentlib-source.mjs')).selectWorkspaceAgentLibSource;
    const { selection } = await selector({ workspaceRoot, branchPolicy, fsApi, readOnly });
    Object.assign(env, agentLibRuntimeEnv(selection, selection.sourceDir));
    bootstrapped = {
        sourceDir: selection.sourceDir,
        mode: selection.mode,
        fingerprint: selection.contentFingerprint || '',
        commit: selection.resolvedCommit || '',
        sourceIdHash: env[AGENTLIB_ENV.sourceId],
        owned: true,
        selection,
    };
    return bootstrapped;
}

/** Test seam: forget the cached bootstrap result. */
export function resetAgentLibBootstrap() {
    bootstrapped = null;
}
