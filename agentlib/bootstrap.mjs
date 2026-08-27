// Establish the achillesAgentLib runtime contract before any framework import.
//
// Outside the Box this resolves (and, for a managed source, materializes) the
// one workspace source and exports the reserved environment. Inside the Box it
// only validates what the host supervisor already mounted: a missing contract
// there is an error, not permission to clone from inside the Box.

import fs from 'node:fs';
import path from 'node:path';

import {
    AGENTLIB_ENV,
    AGENTLIB_ERROR_CODES,
    AGENTLIB_PACKAGE_NAME,
    AGENTLIB_STABLE_MOUNT_PATH,
    agentLibError,
    agentLibRuntimeEnv,
    assertNoRemovedAgentLibSettings,
} from './contract.mjs';
import { resolveWorkspaceRoot } from './source.mjs';

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
    if (!/^[a-f0-9]{64}$/.test(String(env[AGENTLIB_ENV.fingerprint] || ''))) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.fingerprint} must carry the selected content fingerprint.`,
        );
    }
    if (!/^[a-f0-9]{64}$/.test(String(env[AGENTLIB_ENV.sourceId] || ''))) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            `${AGENTLIB_ENV.sourceId} must carry the selected physical source identity.`,
        );
    }
    return {
        sourceDir: root,
        mode: String(env[AGENTLIB_ENV.mode] || ''),
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
        fingerprint: selection.contentFingerprint,
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
