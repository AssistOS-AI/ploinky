import fs from 'node:fs';
import path from 'node:path';

import { createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { resolveUpdateFolderScope } from '../../cli/commands/updateRequest.js';
import { GIT_CONFIG_LOCK, createSkillExclusionPlanner, resolveGitIdentity } from '../../cli/utils/skills/exportExclusions.mjs';
import {
    EXPORT_JOURNAL,
    EXPORT_LOCK,
    acquireGitConfigLock,
    acquireSkillExportLock,
    classifyLockOwner,
    refreshSkillExportExclusions,
    skillExportRecoveryProblem,
} from '../../cli/utils/skills/exportTransaction.mjs';
import { relativeBoxWorkspacePath } from '../contract/workspace-root.mjs';

// The in-Box core cannot see the host user's Git excludes view, so it defers
// exclusions for Git targets and lists those export folders (Box spelling) in
// its report. The host, still holding the workspace lock, maps each folder onto
// the host spelling of the same canonical-relative path and runs the shared
// exclusions-only refresh there. Every folder yields one optional record:
// failures make the final status nonzero but never block activation.
//
// Each folder's refresh holds that folder's export lock and its common Git
// configuration lock as this host process, an owner no in-Box exporter can
// prove dead. The caller therefore owns SIGINT/SIGTERM across the refresh,
// which stops before its next folder once one arrives. Before any lock is
// taken the refresh records its folders in private host state, and it keeps
// a folder there only while a lock it took there may remain. That record only
// says where to look: the next update, under the workspace lock and before
// its in-Box step, releases such a lock only when its owner record proves, in
// this boot and PID namespace, that the host refresh which took it has ended.
// A pending journal stays for the confined executor and Git's own lock files
// are never touched.

export const MAX_DEFERRED_EXCLUSION_FOLDERS = 64;
export const HOST_EXCLUSIONS_AUTHORITY = Object.freeze({
    kind: 'ploinky-box',
    operation: 'update-exclusions-refresh',
    executor: 'host',
});
export const HOST_EXCLUSIONS_INTENT_KIND = 'update-exclusions';
const INTENT_SCHEMA = 'ploinky-host-exclusions-refresh';

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

function intentRecord(identity, folders) {
    return { schema: INTENT_SCHEMA, version: 1, instance: identity.instance, folders: [...folders] };
}

/**
 * @param {object} options
 * @param {unknown} options.folders the report's `deferredExclusionFolders`
 * @param {{ workspaceRoot: string, instance: string }} options.identity exact
 *   workspace identity (its root is both the host selection and the Box mount spelling)
 * @param {{ signalReceived(): Promise<string> }} [options.cancellation] the
 *   caller's ownership of SIGINT/SIGTERM, checked before every folder
 * @param {{ write(record: object): unknown, remove(): unknown }} [options.intent]
 *   private host record of the folders whose locks this refresh may hold
 * @returns {Promise<object[]>} operation records
 */
export async function refreshDeferredHostExclusions({
    folders,
    identity,
    env = process.env,
    refresh = refreshSkillExportExclusions,
    createPlanner = createSkillExclusionPlanner,
    limit = MAX_DEFERRED_EXCLUSION_FOLDERS,
    cancellation = null,
    intent = null,
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
    const targets = [];
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
        targets.push({ id, folder: scope.canonicalFolder });
    }
    if (!targets.length) return records;
    if (intent) {
        try {
            intent.write(intentRecord(identity, targets.map(target => target.folder)));
        } catch (error) {
            // Without the record, a host that died holding a folder's locks
            // would strand them there, so no lock is taken.
            records.push(createOperationRecord({
                phase: 'skills-manifest', id: 'exclusions:intent', outcome: 'uncertain', required: false,
                code: 'exclusions-intent-unwritable',
                reason: 'No host exclusions were refreshed: their folders could not first be recorded in private host state, '
                    + `so locks left by an interrupted refresh could not be recovered (${error?.message || error}).`,
                details: { folders: targets.map(target => target.folder) },
            }));
            return records;
        }
    }
    const unreleased = [];
    try {
        for (const [index, { id, folder }] of targets.entries()) {
            const signal = cancellation ? await cancellation.signalReceived() : '';
            if (signal) {
                for (const skipped of targets.slice(index)) {
                    records.push(exclusionRecord(skipped.id, 'skipped', {
                        code: 'cancelled',
                        reason: `The update was cancelled by ${signal} before the host refreshed these exclusions; `
                            + 'a later update that exports this folder refreshes them.',
                        details: { folder: skipped.folder },
                    }));
                }
                break;
            }
            try {
                const result = refresh(folder, { exclusions: planner, authority: HOST_EXCLUSIONS_AUTHORITY });
                const recoveryProblem = skillExportRecoveryProblem(result);
                if (recoveryProblem) {
                    records.push(exclusionRecord(id, 'uncertain', {
                        code: recoveryProblem.code, reason: recoveryProblem.reason,
                        details: { folder, transaction: recoveryProblem.transaction, recovery: recoveryProblem.recovery },
                    }));
                    continue;
                }
                const exclusions = result?.exclusions;
                const outcome = outcomeOf(exclusions);
                records.push(exclusionRecord(id, outcome, {
                    code: exclusions?.code || (outcome === 'failed' ? 'exclusions-refresh-unrecognized' : ''),
                    reason: exclusions?.reason || '',
                    details: { folder, status: exclusions?.status || null },
                }));
            } catch (error) {
                // A lock this process could not release outlives it.
                if (error?.code === 'SKILL_EXPORT_LOCK_RELEASE_FAILED' || error?.lockReleaseError) unreleased.push(folder);
                // A lock release failure carries the completed result; one that
                // still needs recovery stays uncertain, as it would on success.
                const completedProblem = error?.code === 'SKILL_EXPORT_LOCK_RELEASE_FAILED' ? skillExportRecoveryProblem(error.skillExportResult) : null;
                if (completedProblem) {
                    records.push(exclusionRecord(id, 'uncertain', {
                        code: completedProblem.code, reason: `${completedProblem.reason} ${error.message}`,
                        details: { folder, transaction: completedProblem.transaction, recovery: completedProblem.recovery, errorCode: error.code },
                    }));
                    continue;
                }
                records.push(exclusionRecord(id, error?.code === 'SKILL_EXPORT_HOST_BOUNDARY' ? 'deferred' : error?.code === 'SKILL_EXPORT_RECOVERY_REQUIRED' ? 'uncertain' : 'failed', {
                    code: String(error?.exclusionCode || error?.code || 'exclusions-refresh-failed'),
                    reason: error?.message || String(error),
                    details: { folder },
                }));
            }
        }
    } finally {
        // Every other lock was released before its refresh returned. A record
        // left behind costs the next update one inspection of free locks.
        try {
            if (intent && unreleased.length) intent.write(intentRecord(identity, unreleased));
            else intent?.remove();
        } catch (_) {}
    }
    return records;
}

// ---------------------------------------------------------------------------
// Recovery of a host exclusion refresh that ended without releasing its locks.

const isHostRefreshAuthority = authority => authority?.kind === HOST_EXCLUSIONS_AUTHORITY.kind
    && authority?.operation === HOST_EXCLUSIONS_AUTHORITY.operation
    && authority?.executor === HOST_EXCLUSIONS_AUTHORITY.executor;

// The owner of one lock directory, read without following a link.
function observeLock(lockPath) {
    const directory = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (!directory) return { state: 'free', owner: null };
    if (!directory.isDirectory()) return { state: 'foreign', owner: null };
    const ownerPath = path.join(lockPath, 'owner.json');
    let owner = null;
    if (fs.lstatSync(ownerPath, { throwIfNoEntry: false })?.isFile()) {
        try { owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')); } catch (_) {}
    }
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) owner = null;
    return { state: classifyLockOwner(owner), owner };
}

// Only a lock that the host exclusion refresh took in this boot and PID
// namespace, whose process no longer runs, is released. The protocol's own
// acquisition reclaims it (one reclaimer, exact owner comparison) without
// waiting, and the lock it then holds is released at once.
function reclaimRefreshLock(lockPath, acquire) {
    const observed = observeLock(lockPath);
    if (observed.state === 'free') return observed;
    if (observed.state !== 'dead' || !isHostRefreshAuthority(observed.owner?.authority)) {
        return { ...observed, state: observed.state === 'dead' ? 'dead-other-writer' : observed.state };
    }
    try {
        acquire().release();
        return { ...observed, state: 'reclaimed' };
    } catch (error) {
        return { ...observed, state: String(error?.outcome || error?.code || 'reclaim-failed'), reason: error?.message || String(error) };
    }
}

function recoverFolder(folder, { identity, planner }) {
    let scope;
    try {
        scope = resolveUpdateFolderScope(folder, identity.workspaceRoot);
    } catch (error) {
        return { dropped: `${error.message}; nothing there was inspected` };
    }
    if (scope.canonicalFolder !== folder) {
        return { dropped: `it now resolves to ${scope.canonicalFolder}; nothing there was inspected` };
    }
    const unproven = [];
    const locks = [];
    let repository = null;
    try {
        planner.assertSafeTarget(folder);
        repository = resolveGitIdentity(folder);
    } catch (error) {
        unproven.push(`its Git metadata could not be verified (${error?.message || error})`);
    }
    if (repository?.unavailable) unproven.push(`Git could not identify its repository (${repository.reason})`);
    // The common Git configuration lock first, in every exporter's lock order.
    if (repository?.insideWorkTree) {
        const relative = path.relative(planner.hostBoundary, repository.commonDir);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            unproven.push(`its Git metadata resolves outside the workspace (${repository.commonDir})`);
        } else {
            const lockPath = path.join(repository.commonDir, GIT_CONFIG_LOCK);
            locks.push({ kind: 'Git configuration', lockPath, result: reclaimRefreshLock(lockPath, () => acquireGitConfigLock(
                repository.commonDir, { waitMs: 0, exclusions: planner, authority: HOST_EXCLUSIONS_AUTHORITY },
            )) });
        }
    }
    const agents = path.join(folder, '.agents');
    const agentsEntry = fs.lstatSync(agents, { throwIfNoEntry: false });
    if (agentsEntry && !agentsEntry.isDirectory()) {
        unproven.push(`${agents} is not a real directory`);
    } else if (agentsEntry) {
        const exportLock = path.join(agents, EXPORT_LOCK);
        const skills = path.join(agents, 'skills');
        locks.push({ kind: 'export', lockPath: exportLock, result: reclaimRefreshLock(exportLock, () => {
            // Acquisition creates a missing skills directory; this recovery creates nothing.
            if (!fs.lstatSync(skills, { throwIfNoEntry: false })?.isDirectory()) {
                throw Object.assign(new Error(`${skills} is not a directory`), { outcome: 'skills-directory-missing' });
            }
            return acquireSkillExportLock(folder, { waitMs: 0, authority: HOST_EXCLUSIONS_AUTHORITY });
        }) });
    }
    for (const { kind, lockPath, result } of locks) {
        if (result.state === 'free' || result.state === 'reclaimed') continue;
        const owner = result.owner?.pid ? ` (owner pid ${result.owner.pid})` : '';
        unproven.push(`its ${kind} lock ${lockPath}${owner} is ${result.state}${result.reason ? ` (${result.reason})` : ''}`);
    }
    return {
        relative: scope.relative || '.',
        reclaimed: locks.filter(lock => lock.result.state === 'reclaimed'),
        unproven,
        journal: Boolean(agentsEntry?.isDirectory()) && fs.existsSync(path.join(agents, EXPORT_JOURNAL)),
    };
}

/**
 * Before an update's in-Box step, release the locks that a host exclusion
 * refresh of this workspace left when it ended without releasing them. The
 * private record says only where to look and proves nothing itself; it is
 * kept for every folder whose locks could not be proven released.
 *
 * @param {object} options
 * @param {{ read(): unknown, write(record: object): unknown, remove(): unknown }} options.intent
 * @param {{ workspaceRoot: string, instance: string }} options.identity
 * @returns {{ records: object[], warnings: string[] }}
 */
export function recoverInterruptedHostExclusions({
    intent,
    identity,
    env = process.env,
    createPlanner = createSkillExclusionPlanner,
} = {}) {
    const records = [];
    const warnings = [];
    let stored;
    try {
        stored = intent.read();
    } catch (error) {
        stored = { unreadable: error?.message || String(error) };
    }
    if (stored === null || stored === undefined) return { records, warnings };
    const folders = stored?.schema === INTENT_SCHEMA && stored.version === 1 && stored.instance === identity.instance
        && Array.isArray(stored.folders) && stored.folders.length <= MAX_DEFERRED_EXCLUSION_FOLDERS
        && stored.folders.every(folder => typeof folder === 'string' && path.isAbsolute(folder))
        ? [...new Set(stored.folders)] : null;
    let planner = null;
    let plannerError = null;
    if (folders) {
        try {
            planner = createPlanner({ env, containerExecutor: false, gitDirBoundary: identity.workspaceRoot });
        } catch (error) {
            plannerError = error;
        }
    }
    if (!folders || !planner) {
        const detail = stored?.unreadable || plannerError?.message || '';
        const reason = folders
            ? `The folders of an interrupted host exclusion refresh could not be inspected${detail ? ` (${detail})` : ''}; they are revisited by the next update`
            : 'The record of an earlier host exclusion refresh is unreadable, so its folders cannot be revisited; '
                + `a lock it left is reported by the next export that meets it${detail ? ` (${detail})` : ''}`;
        records.push(createOperationRecord({
            phase: 'skills-manifest', id: 'exclusions-recovery:record', outcome: 'uncertain', required: false,
            code: folders ? 'interrupted-refresh-locks-unproven' : 'exclusions-intent-invalid', reason,
        }));
        warnings.push(reason);
        if (!folders) {
            try { intent.remove(); } catch (_) {}
        }
        return { records, warnings };
    }
    const remaining = [];
    for (const folder of folders) {
        let recovered;
        try {
            recovered = recoverFolder(folder, { identity, planner });
        } catch (error) {
            recovered = { relative: folder, reclaimed: [], unproven: [`it could not be inspected (${error?.message || error})`], journal: false };
        }
        if (recovered.dropped) {
            warnings.push(`an interrupted host exclusion refresh recorded ${folder}, which is no longer a folder of this workspace: ${recovered.dropped}`);
            continue;
        }
        const id = `exclusions-recovery:${recovered.relative}`;
        if (recovered.reclaimed.length) {
            const owner = recovered.reclaimed[0].result.owner;
            const reason = `An interrupted host exclusion refresh of ${recovered.relative} left its `
                + `${recovered.reclaimed.map(lock => lock.kind).join(' and ')} lock; this host proved that refresh `
                + `(pid ${owner?.pid}) ended and released ${recovered.reclaimed.length > 1 ? 'them' : 'it'}`
                + `${recovered.journal ? '; its pending export journal is left for the next in-Box export of this folder' : ''}`;
            records.push(exclusionRecord(id, 'changed', {
                code: 'interrupted-refresh-locks-released', reason,
                details: { folder, released: recovered.reclaimed.map(lock => lock.lockPath), journal: recovered.journal },
            }));
            warnings.push(reason);
        }
        if (recovered.unproven.length) {
            remaining.push(folder);
            const reason = `An interrupted host exclusion refresh of ${recovered.relative} may have left locks that `
                + `could not be proven released: ${recovered.unproven.join('; ')}. They are preserved; once no Ploinky `
                + 'process runs for this workspace, remove them by hand';
            records.push(exclusionRecord(id, 'uncertain', {
                code: 'interrupted-refresh-locks-unproven', reason, details: { folder, journal: recovered.journal },
            }));
            warnings.push(reason);
        }
    }
    try {
        if (remaining.length) intent.write(intentRecord(identity, remaining));
        else intent.remove();
    } catch (error) {
        warnings.push(`the record of an interrupted host exclusion refresh could not be updated: ${error?.message || error}`);
    }
    return { records, warnings };
}
