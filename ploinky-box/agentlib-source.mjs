// Host-side ownership of the achillesAgentLib source.
//
// In the public `ploinky` path the outer host supervisor is the one source
// writer: it selects or stages the source while holding the workspace Box
// mutation lock, then hands the resulting selection to Box reconciliation. The
// in-Box process only ever validates what it was given — it must never acquire
// this lock, clone, fetch, or rewrite `active.json`.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { AGENTLIB_ERROR_CODES, AGENTLIB_LOCAL_DIR_NAME, agentLibError } from '../agentlib/contract.mjs';
import { isInsideBoxRuntime } from '../agentlib/bootstrap.mjs';
import { fingerprintSource } from '../agentlib/fingerprint.mjs';
import { createGitRunner, selectManagedSource } from '../agentlib/materialize.mjs';
import {
    planSourceSelection,
    readActiveDescriptor,
    resolveDescriptorSource,
    selectAgentLibSource,
    validateAgentLibSource,
    withAgentLibSourceLock,
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
 * Select the one achillesAgentLib source for a workspace.
 *
 * A present local checkout always wins and is never mutated. Only its absence
 * reaches the managed path, and a present-but-invalid checkout is a hard error
 * rather than a silent GitHub fallback.
 *
 * @param {object} params
 * @param {string} params.workspaceRoot
 * @param {{branch: string|null, fallback: 'default'|'fail'}|null} [params.branchPolicy]
 * @param {boolean} [params.readOnly] - reuse only; never clone, fetch, or create state
 * @returns {Promise<{ selection: object, mode: 'local'|'managed' }>}
 */
export async function selectWorkspaceAgentLibSource({
    workspaceRoot,
    branchPolicy = null,
    readOnly = false,
    remote = null,
    fsApi = fs,
    runner = createGitRunner(),
    gitState = readLocalGitState,
    now,
}) {
    const local = selectAgentLibSource({
        workspaceRoot,
        fsApi,
        branchPolicy,
        readGitState: gitState,
        ...(now ? { now } : {}),
    });
    if (!local.requiresMaterialization) {
        return { selection: local.selection, mode: 'local' };
    }
    if (readOnly) {
        // Read-only commands may reuse an already-materialized generation but
        // must never create one, so an unmaterialized workspace is reported
        // rather than silently populated.
        const activeDescriptor = readActiveDescriptor(workspaceRoot, fsApi);
        if (!activeDescriptor) {
            throw agentLibError(
                AGENTLIB_ERROR_CODES.sourceMissing,
                'No achillesAgentLib source is available for this workspace yet. '
                + 'Add <workspace>/achillesAgentLib, or run `ploinky start` to materialize a managed source.',
            );
        }
        const { sourceDir } = resolveDescriptorSource(activeDescriptor, workspaceRoot, { fsApi });
        return { selection: { ...activeDescriptor, sourceDir }, mode: activeDescriptor.mode };
    }
    // Only a managed source needs the writer lock; a local checkout is selected
    // without creating any workspace state at all.
    return withAgentLibSourceLock(workspaceRoot, () => {
        const activeDescriptor = readActiveDescriptor(workspaceRoot, fsApi);
        const { selection } = selectManagedSource({
            workspaceRoot,
            activeDescriptor,
            branchPolicy,
            remote,
            runner,
            fsApi,
            ...(now ? { now } : {}),
        });
        return { selection, mode: 'managed' };
    }, { fsApi });
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
 * The one `ploinky update` behavior for the achillesAgentLib source.
 *
 * A local checkout is never pulled, reset, or checked out — it belongs to the
 * developer. It is revalidated and reported; if its bytes changed, the new
 * fingerprint becomes the selection and consumers must restart coherently.
 *
 * A managed source advances only through a new immutable generation: an explicit
 * branch is fetched and resolved to one exact commit, and an unpinned managed
 * source follows the canonical lock commit, which moves only when Ploinky itself
 * is updated.
 *
 * @param {object} params
 * @param {string} params.workspaceRoot
 * @param {{branch: string|null, fallback: 'default'|'fail'}|null} [params.branchPolicy]
 * @returns {Promise<{mode: 'local'|'managed', selection: object, changed: boolean, previous: object|null}>}
 */
export async function updateWorkspaceAgentLibSource({
    workspaceRoot,
    branchPolicy = null,
    remote = null,
    fsApi = fs,
    runner = createGitRunner(),
    gitState = readLocalGitState,
    insideBox = isInsideBoxRuntime({ fsApi }),
    now,
}) {
    // Defense in depth: callers are expected to check first, but a future
    // unguarded caller must not be able to reopen in-Box source mutation.
    assertNotInBoxSourceOwner(insideBox);
    const previous = readActiveDescriptor(workspaceRoot, fsApi);
    const local = selectAgentLibSource({
        workspaceRoot,
        fsApi,
        branchPolicy,
        readGitState: gitState,
        ...(now ? { now } : {}),
    });
    if (!local.requiresMaterialization) {
        const selection = local.selection;
        return {
            mode: 'local',
            selection,
            changed: previous?.contentFingerprint !== selection.contentFingerprint,
            previous,
        };
    }
    return withAgentLibSourceLock(workspaceRoot, () => {
        // An update is allowed to resolve a moving branch, so the previous
        // descriptor is not used to pin the commit here; a new generation is
        // staged and the old one is retained for rollback.
        const effectiveBranchPolicy = branchPolicy?.branch
            ? branchPolicy
            : previous?.requestedRef
                ? { branch: previous.requestedRef, fallback: 'fail' }
                : null;
        const { selection } = selectManagedSource({
            workspaceRoot,
            // Update is the operation that advances a moving source. Never
            // feed the active descriptor back into ordinary-start pinning.
            activeDescriptor: null,
            branchPolicy: effectiveBranchPolicy,
            remote,
            runner,
            fsApi,
            ...(now ? { now } : {}),
        });
        return {
            mode: 'managed',
            selection,
            changed: previous?.contentFingerprint !== selection.contentFingerprint,
            previous,
        };
    }, { fsApi });
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
        return {
            mode: active?.mode || 'managed',
            sourceRelativePath: active?.sourceRelativePath || null,
            active,
            drifted: false,
            present: Boolean(active),
            detail: detail || (active ? '' : 'no achillesAgentLib source has been selected yet'),
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
