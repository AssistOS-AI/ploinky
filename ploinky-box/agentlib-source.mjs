// Host-side ownership of the achillesAgentLib source.
//
// In the public `ploinky` path the outer host supervisor is the one source
// writer: it selects or stages the source while holding the workspace Box
// mutation lock, then hands the resulting selection to Box reconciliation. The
// in-Box process only ever validates what it was given — it must never acquire
// this lock, clone, fetch, or rewrite `active.json`.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
    AGENTLIB_ERROR_CODES,
    AGENTLIB_LOCAL_DIR_NAME,
    agentLibError,
    agentLibIdentityEquals,
} from '../agentlib/contract.mjs';
import { isInsideBoxRuntime } from '../agentlib/bootstrap.mjs';
import { fingerprintSource } from '../agentlib/fingerprint.mjs';
import {
    buildImageSelection,
    planSourceSelection,
    readActiveDescriptor,
    selectAgentLibSource,
    validateAgentLibSource,
} from '../agentlib/source.mjs';

/**
 * Read diagnostic revision context for a local checkout.
 *
 * This never mutates the checkout: a local source is the developer's, and
 * Ploinky only reports what it finds there.
 */
export function readLocalGitState(sourceDir, { spawn = spawnSync } = {}) {
    const run = (args) => {
        const result = spawn('git', ['-C', sourceDir, ...args], {
            encoding: 'utf8',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        return result.status === 0 ? String(result.stdout || '').trim() : null;
    };
    const commit = run(['rev-parse', 'HEAD']);
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = run(['status', '--porcelain']);
    return {
        commit: commit && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
        branch: branch && branch !== 'HEAD' ? branch : null,
        dirty: status === null ? false : status.length > 0,
    };
}

/**
 * Prefer the exact local checkout, otherwise use the library the Box image
 * supplies. Neither path clones, fetches, creates source state, or changes a
 * checkout. Global branch policy applies to local sources. An image source is
 * identified by the outer image that supplies it, whatever revision that image
 * was built from. A local validation failure never probes the image.
 *
 * A present `active.json` is authority state, so it is validated by the
 * current descriptor validator before any local probe, image load or mutation:
 * a descriptor this Ploinky does not support fails with its file named, and an
 * absent one is simply an uninitialized workspace. Nothing here converts it.
 * A read-only caller (native `status`) selects without that gate so it can
 * report the unsupported descriptor, naming its file, instead of refusing.
 */
export async function selectWorkspaceAgentLibSource({
    workspaceRoot,
    branchPolicy = null,
    imageBundle = null,
    loadImageBundle = null,
    fsApi = fs,
    gitState = readLocalGitState,
    now,
    readOnly = false,
}) {
    if (!readOnly) readActiveDescriptor(workspaceRoot, fsApi);
    const selectLocal = () => selectAgentLibSource({
        workspaceRoot,
        fsApi,
        branchPolicy,
        readGitState: gitState,
        ...(now ? { now } : {}),
    });
    const local = selectLocal();
    if (local.selection) return { selection: local.selection, mode: 'local' };
    const bundle = imageBundle || (loadImageBundle ? await loadImageBundle() : null);
    // An image inspection may take time. Recheck developer intent before
    // accepting its result if a local checkout appeared during the probe.
    if (loadImageBundle && !imageBundle) {
        const current = selectLocal();
        if (current.selection) return { selection: current.selection, mode: 'local' };
    }
    if (!bundle) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageRequired,
            'No local achillesAgentLib checkout exists. Start this workspace with \u0060ploinky start\u0060 '
            + 'to use the copy supplied by the Box image, or add <workspace>/achillesAgentLib for ploinky-local.');
    }
    const selection = buildImageSelection({
        workspaceRoot,
        supplyingImageId: bundle.supplyingImageId,
        provenance: bundle.provenance,
        fsApi,
        ...(now ? { now } : {}),
    });
    return { selection, mode: 'image' };
}

/**
 * Refuse to own source selection from inside the Box.
 *
 * A missing supervisor-provided contract is an error, not permission for the
 * in-Box process to clone one for itself.
 */
export function assertNotInBoxSourceOwner(insideBox) {
    if (insideBox) {
        throw agentLibError(
            AGENTLIB_ERROR_CODES.contractMissing,
            'The in-Box process must not select or materialize an achillesAgentLib source; '
            + 'the host supervisor owns it.',
        );
    }
}

/**
 * Revalidate local bytes or select the image-supplied library again without
 * host Git. `changed` follows the mode-aware identity: a local selection by its
 * physical source and content fingerprint, an image selection by the outer
 * image ID that supplies it.
 */
export async function updateWorkspaceAgentLibSource({
    workspaceRoot,
    branchPolicy = null,
    imageBundle = null,
    loadImageBundle = null,
    fsApi = fs,
    gitState = readLocalGitState,
    insideBox = isInsideBoxRuntime({ fsApi }),
    now,
}) {
    assertNotInBoxSourceOwner(insideBox);
    const previous = readActiveDescriptor(workspaceRoot, fsApi);
    const { selection, mode } = await selectWorkspaceAgentLibSource({
        workspaceRoot, branchPolicy, imageBundle, loadImageBundle, fsApi, gitState, now,
    });
    return {
        mode,
        selection,
        changed: !agentLibIdentityEquals(previous, selection),
        previous,
    };
}

/**
 * Read-only inspection of the workspace source for `status`.
 *
 * Creates nothing, fetches nothing, and repairs nothing: an unmaterialized or
 * drifted workspace is reported as such.
 *
 * @returns {{mode: string, sourceRelativePath: string|null, active: object|null, drifted: boolean, present: boolean, detail: string}}
 */
export function inspectWorkspaceAgentLibSource({
    workspaceRoot,
    fsApi = fs,
    gitState = readLocalGitState,
}) {
    const plan = planSourceSelection(workspaceRoot, { fsApi });
    let active = null;
    let detail = '';
    try {
        active = readActiveDescriptor(workspaceRoot, fsApi);
    } catch (error) {
        detail = error.message;
    }
    if (!plan.present) {
        const missingLocal = active?.mode === 'local';
        return {
            mode: missingLocal ? 'image' : active?.mode || 'image',
            sourceRelativePath: missingLocal ? null : active?.sourceRelativePath || null,
            active,
            drifted: missingLocal,
            present: Boolean(active) && !missingLocal,
            detail: detail || (missingLocal
                ? 'The selected local achillesAgentLib checkout is missing; the next lifecycle command uses the copy supplied by the Box image.'
                : active ? '' : 'no achillesAgentLib source has been selected yet'),
        };
    }
    try {
        const { sourceDir } = validateAgentLibSource(plan.candidate, { fsApi, deepSymlinkScan: false });
        const { fingerprint } = fingerprintSource(sourceDir, { fsApi });
        const git = gitState(sourceDir);
        return {
            mode: 'local',
            sourceRelativePath: AGENTLIB_LOCAL_DIR_NAME,
            active,
            // A local checkout can change independently of Ploinky, so the
            // active selection is compared against the bytes on disk right now.
            drifted: Boolean(active) && active.contentFingerprint !== fingerprint,
            present: true,
            contentFingerprint: fingerprint,
            commit: git?.commit || null,
            branch: git?.branch || null,
            dirty: Boolean(git?.dirty),
            detail,
        };
    } catch (error) {
        return {
            mode: 'local',
            sourceRelativePath: AGENTLIB_LOCAL_DIR_NAME,
            active,
            drifted: false,
            present: true,
            detail: error.message,
        };
    }
}
