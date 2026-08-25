// Host-side ownership of the achillesAgentLib source.
//
// In the public `ploinky` path the outer host supervisor is the one source
// writer: it selects or stages the source while holding the workspace Box
// mutation lock, then hands the resulting selection to Box reconciliation. The
// in-Box process only ever validates what it was given — it must never acquire
// this lock, clone, fetch, or rewrite `active.json`.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { AGENTLIB_ERROR_CODES, agentLibError } from '../agentlib/contract.mjs';
import { createGitRunner, selectManagedSource } from '../agentlib/materialize.mjs';
import {
    readActiveDescriptor,
    resolveDescriptorSource,
    selectAgentLibSource,
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
