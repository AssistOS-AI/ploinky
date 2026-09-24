import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { resolveUpdateFolderScope } from '../../cli/commands/updateRequest.js';
import { createSkillExclusionPlanner } from '../../cli/utils/skills/exportExclusions.mjs';
import { refreshSkillExportExclusions, skillExportRecoveryProblem } from '../../cli/utils/skills/exportTransaction.mjs';
import { relativeBoxWorkspacePath } from '../contract/workspace-root.mjs';

// The in-Box core cannot see the host user's Git excludes view, so it defers
// exclusions for Git targets and lists those export folders (Box spelling) in
// its report. The host, still holding the workspace lock, maps each folder onto
// the host spelling of the same canonical-relative path and runs the shared
// exclusions-only refresh there. Every folder yields one optional record:
// failures make the final status nonzero but never block activation.

export const MAX_DEFERRED_EXCLUSION_FOLDERS = 64;
export const HOST_EXCLUSIONS_AUTHORITY = Object.freeze({
    kind: 'ploinky-box',
    operation: 'update-exclusions-refresh',
    executor: 'host',
});

function exclusionRecord(id, outcome, { code = '', reason = '', details = null } = {}) {
    return createOperationRecord({
        phase: 'skills-manifest',
        id,
        outcome,
        attempted: outcome !== 'deferred' && outcome !== 'skipped',
        required: false,
        code,
        reason,
        details,
    });
}

function outcomeOf(exclusions) {
    switch (exclusions?.status) {
        case 'published': return 'changed';
        case 'unchanged': return 'unchanged';
        case 'deferred': return 'deferred';
        // Ploinky deliberately stopped managing a user-edited policy.
        case 'relinquished': return 'skipped';
        default: return 'failed';
    }
}

/**
 * @param {object} options
 * @param {unknown} options.folders the report's `deferredExclusionFolders`
 * @param {{ workspaceRoot: string }} options.identity exact workspace identity
 *   (its root is both the host selection and the Box mount spelling)
 * @returns {object[]} operation records
 */
export function refreshDeferredHostExclusions({
    folders,
    identity,
    env = process.env,
    refresh = refreshSkillExportExclusions,
    createPlanner = createSkillExclusionPlanner,
    limit = MAX_DEFERRED_EXCLUSION_FOLDERS,
} = {}) {
    if (folders === undefined || folders === null) return [];
    if (!Array.isArray(folders)) {
        return [createOperationRecord({
            phase: 'skills-manifest', id: 'exclusions:report', outcome: 'uncertain', required: false,
            code: 'deferred-exclusion-folders-invalid', reason: 'the report listed deferred exclusion folders in an unsupported shape',
        })];
    }
    const unique = [...new Set(folders.map(value => (typeof value === 'string' ? value : JSON.stringify(value))))].sort();
    const records = [];
    const selected = unique.slice(0, limit);
    if (unique.length > limit) {
        records.push(createOperationRecord({
            phase: 'skills-manifest', id: 'exclusions:overflow', outcome: 'uncertain', required: false,
            code: 'deferred-exclusion-folders-exceeded',
            reason: `the report listed ${unique.length} deferred exclusion folders; only the first ${limit} were refreshed`,
            details: { listed: unique.length, refreshed: limit },
        }));
    }
    const planner = createPlanner({
        authorizeComposition: env.PLOINKY_SKILL_EXCLUDES_COMPOSE === '1',
        nonGitBlock: false,
        env,
        // This runs in the host process that owns the outer Box.
        containerExecutor: false,
        // Folders come from the Box; their Git metadata must stay inside the workspace.
        gitDirBoundary: identity.workspaceRoot,
    });
    const seenHostFolders = new Set();
    for (const boxFolder of selected) {
        let relative;
        try {
            // Box spelling: a clean absolute path under the Box workspace mount.
            relative = relativeBoxWorkspacePath(identity.workspaceRoot, boxFolder);
        } catch (error) {
            records.push(exclusionRecord(`exclusions:${boxFolder}`, 'failed', {
                code: 'exclusion-folder-refused',
                reason: `the reported folder is not inside the Box workspace: ${error.message}`,
            }));
            continue;
        }
        const id = `exclusions:${relative || '.'}`;
        let scope;
        try {
            // Host spelling of the same relative path, contained canonically.
            scope = resolveUpdateFolderScope(
                relative ? `${identity.workspaceRoot}/${relative}` : identity.workspaceRoot,
                identity.workspaceRoot,
            );
        } catch (error) {
            records.push(exclusionRecord(id, 'failed', {
                code: error?.code === 'PLOINKY_UPDATE_SCOPE_MISSING' ? 'exclusion-folder-missing' : 'exclusion-folder-refused',
                reason: error.message,
            }));
            continue;
        }
        if (seenHostFolders.has(scope.canonicalFolder)) continue;
        seenHostFolders.add(scope.canonicalFolder);
        try {
            const result = refresh(scope.canonicalFolder, { exclusions: planner, authority: HOST_EXCLUSIONS_AUTHORITY });
            const recoveryProblem = skillExportRecoveryProblem(result);
            if (recoveryProblem) {
                records.push(exclusionRecord(id, 'uncertain', {
                    code: recoveryProblem.code, reason: recoveryProblem.reason,
                    details: { folder: scope.canonicalFolder, transaction: recoveryProblem.transaction, recovery: recoveryProblem.recovery },
                }));
                continue;
            }
            const exclusions = result?.exclusions;
            const outcome = outcomeOf(exclusions);
            records.push(exclusionRecord(id, outcome, {
                code: exclusions?.code || (outcome === 'failed' ? 'exclusions-refresh-unrecognized' : ''),
                reason: exclusions?.reason || '',
                details: { folder: scope.canonicalFolder, status: exclusions?.status || null },
            }));
        } catch (error) {
            records.push(exclusionRecord(id, error?.code === 'SKILL_EXPORT_HOST_BOUNDARY' ? 'deferred' : error?.code === 'SKILL_EXPORT_RECOVERY_REQUIRED' ? 'uncertain' : 'failed', {
                code: String(error?.exclusionCode || error?.code || 'exclusions-refresh-failed'),
                reason: error?.message || String(error),
                details: { folder: scope.canonicalFolder },
            }));
        }
    }
    return records;
}
