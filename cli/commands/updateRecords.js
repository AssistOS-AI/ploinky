import path from 'path';

import { buildUpdateResult, createOperationRecord } from './updateOutcome.js';
import { skillExportRecoveryProblem } from '../utils/skills/exportTransaction.mjs';

// Record helpers shared by the core `ploinky update` entry points. Totals,
// exit status and activation come from the operation records alone; the
// helpers below only name records for the printed summary.

const VERIFIED = new Set(['changed', 'unchanged']);
const ERRORS = new Set(['failed', 'uncertain']);
const COUNTED_PHASES = new Set(['host-ploinky', 'registered-repository', 'workspace-repository', 'skills-manifest']);
const NOT_APPLICABLE_SELF_CODES = new Set(['owned-by-host', 'scope-excluded', 'not-a-git-checkout', 'interactive-session', 'current']);

export function isVerified(record) {
    return VERIFIED.has(record?.outcome);
}

export function isErrorRecord(record) {
    return ERRORS.has(record?.outcome);
}

export function recordDisplayName(record) {
    switch (record.phase) {
        case 'host-ploinky': return 'ploinky';
        case 'agentlib': return 'achillesAgentLib';
        case 'workspace-repository': return path.basename(String(record.id));
        case 'default-skills': return `default skills ${record.details?.target || record.id}`;
        case 'skills-manifest': return `${record.details?.label || record.id} skills`;
        case 'command': return 'update';
        default: return String(record.id);
    }
}

// A preserved repository, or a self-update skipped for a reason the user can
// act on, is listed in the summary; a not-applicable self-update is not.
export function isReportedSkip(record) {
    if (!['skipped', 'deferred'].includes(record.outcome)) return false;
    if (record.phase === 'registered-repository' || record.phase === 'workspace-repository') return true;
    return record.phase === 'host-ploinky' && !NOT_APPLICABLE_SELF_CODES.has(record.code);
}

/**
 * Counters over the update operations (self-update, repositories and skills
 * manifests). Only attempted operations enter the denominator, so a skipped
 * or deferred self-update is neither a success nor a failure, while a
 * self-update that threw is a failed attempt.
 */
export function countUpdateOperations(records) {
    const counted = records.filter(record => COUNTED_PHASES.has(record.phase) && record.attempted);
    return { total: counted.length, updated: counted.filter(isVerified).length };
}

// A failure outside any phase (request rejection, lock, unexpected throw).
export function commandErrorRecord(error, { outcome = 'failed', attempted = false, code = '' } = {}) {
    return createOperationRecord({
        phase: 'command',
        id: 'update',
        outcome,
        attempted,
        required: null,
        code: code || String(error?.code || 'update-error'),
        reason: String(error?.message || error || 'update failed'),
    });
}

// Command-specific fields (for example `deferredExclusionFolders`) never
// override the record-derived fields.
export function buildCoreUpdateResult({ command, records, agentLib = null, context = null, extra = {} }) {
    return { ...extra, ...buildUpdateResult({ command, records, context, agentLib }) };
}

/**
 * Append records (for example activation) to an existing result and
 * recompute totals and the decision, preserving every other field.
 */
export function appendUpdateRecords(result, additional) {
    const records = [...(result.records || []), ...additional];
    const { schema, version, records: _records, totals, status, exitCode, activationAllowed, blockedBy, errors,
        command, context, agentLib, ...rest } = result;
    return { ...rest, ...buildUpdateResult({ command: command || [], records, context: context ?? null, agentLib: agentLib ?? null }) };
}

function exclusionSummary(outcome) {
    if (!outcome || typeof outcome !== 'object') return null;
    return { status: outcome.status || null, mode: outcome.mode || null, code: outcome.code || null };
}

// A thrown export whose journal stays pending or cannot be observed, or whose
// rollback quarantined output it could not restore, has not failed: its
// outputs need recovery, so the record is uncertain. So is a lock-release
// failure whose completed result still needs recovery. A throw that rolled
// back cleanly, never started a transaction, or settled its outputs before
// the release failed is failed. The thrown code stays in details.
function thrownExportFields(error, fallbackCode) {
    const code = String(error?.code || fallbackCode);
    const releaseError = error?.lockReleaseError || null;
    const reason = String(error?.message || error)
        + (releaseError ? `; its export lock could not be released either (${releaseError.message})` : '');
    const recovery = error?.skillExportRecovery || null;
    const status = recovery?.status || null;
    const completed = code === 'SKILL_EXPORT_LOCK_RELEASE_FAILED' ? error?.skillExportResult || null : null;
    const details = {
        errorCode: code,
        recovery: status ? { status, transaction: recovery.transaction || null } : null,
        ...(releaseError ? { lockReleaseCode: String(releaseError.code || 'lock-release-failed') } : {}),
        ...(completed ? { transaction: completed.transaction || null } : {}),
    };
    if (code === 'SKILL_EXPORT_RECOVERY_REQUIRED' || status === 'pending' || status === 'unknown') {
        return { outcome: 'uncertain', code: 'SKILL_EXPORT_RECOVERY_REQUIRED', reason, details };
    }
    if (status === 'quarantined') {
        return {
            outcome: 'uncertain',
            code: 'SKILL_EXPORT_RECOVERY_REQUIRED',
            reason: `${reason}; skill export transaction ${recovery.transaction} was quarantined with output it could not restore. Existing state is preserved for recovery.`,
            details,
        };
    }
    if (completed) {
        const problem = skillExportRecoveryProblem(completed);
        if (problem) return { outcome: 'uncertain', code: problem.code, reason: `${problem.reason} ${reason}`, details };
        const settled = completed.transaction?.status ? ` Its outputs are settled (transaction ${completed.transaction.status}).` : '';
        return { outcome: 'failed', code, reason: `${reason}${settled}`, details };
    }
    return { outcome: 'failed', code, reason, details };
}

export function defaultSkillsRecord(entry) {
    const target = entry.repoName;
    const source = entry.defaultSkillsRepoName;
    const id = `${source}->${target}`;
    const base = { phase: 'default-skills', id };
    if (entry.error) {
        const { details, ...thrown } = thrownExportFields(entry.error, 'default-skills-failed');
        return createOperationRecord({
            ...base,
            ...thrown,
            details: { target, source, targetPath: entry.repoPath || null, ...details },
        });
    }
    if (entry.sourceSkipped) {
        // The source's own update was not verified (uncertain): the consumer
        // keeps its output; the graph decides whether this blocks activation.
        return createOperationRecord({
            ...base,
            outcome: 'skipped',
            code: 'source-not-refreshed',
            reason: entry.reason || `default skills source not refreshed (${entry.sourceSkipped.code})`,
            details: { target, source, targetPath: entry.repoPath || null, sourceCode: entry.sourceSkipped.code },
        });
    }
    if (entry.skipped) {
        const code = {
            'default skills source repo': 'source-repository',
            'repo path missing': 'target-missing',
            'skills-only repo': 'skills-only-target',
            'missing repo name': 'target-missing',
        }[entry.reason] || 'not-applicable';
        return createOperationRecord({
            ...base,
            outcome: 'skipped',
            required: false,
            code,
            reason: `default skills are not applicable here: ${entry.reason}`,
            details: { target, source, requirementFixed: true },
        });
    }
    const exported = entry.managedExport || {};
    const recoveryProblem = skillExportRecoveryProblem(exported);
    const artifacts = Object.values(exported.artifacts || {});
    const changed = Boolean(exported.installed?.length || exported.removed?.length
        || artifacts.some(value => value === true || value?.changed === true));
    const preserved = (exported.diagnostics || []).slice(0, 50).map(item => ({ name: item.name, reason: item.reason }));
    return createOperationRecord({
        ...base,
        outcome: recoveryProblem ? 'uncertain' : changed ? 'changed' : 'unchanged',
        attempted: true,
        code: recoveryProblem?.code || (changed ? 'exported' : 'current'),
        reason: recoveryProblem?.reason || (preserved.length
            ? `${preserved.length} existing output(s) preserved`
            : (changed ? 'default skills exported' : 'default skills already current')),
        details: {
            target,
            source,
            targetPath: entry.repoPath || null,
            skills: (entry.skills || []).length,
            preserved,
            exclusions: exclusionSummary(entry.exclusions),
            sourceState: entry.sourceState || null,
            transaction: exported.transaction || null,
            recovery: exported.recovery || null,
        },
    });
}

export function skillsManifestRecord({ folder, manifestPath, label, result = null, error = null }) {
    const base = { phase: 'skills-manifest', id: folder };
    if (error) {
        const { details, ...thrown } = thrownExportFields(error, 'skills-manifest-failed');
        return createOperationRecord({
            ...base,
            ...thrown,
            details: { folder, manifestPath, label, ...details },
        });
    }
    const exported = result?.managedExport || {};
    const recoveryProblem = skillExportRecoveryProblem(exported);
    const sourceStates = result?.sourceStates || result?.sources || [];
    const artifacts = Object.values(exported.artifacts || {});
    const changed = Boolean(exported.installed?.length || exported.removed?.length || result?.prunedSkills?.length
        || artifacts.some(value => value === true || value?.changed === true));
    const preserved = (exported.diagnostics || []).slice(0, 50).map(item => ({ name: item.name, reason: item.reason }));
    return createOperationRecord({
        ...base,
        outcome: recoveryProblem ? 'uncertain' : changed ? 'changed' : 'unchanged',
        attempted: true,
        code: recoveryProblem?.code || (changed ? 'exported' : 'current'),
        reason: recoveryProblem?.reason || `${result?.skills?.length || 0} skill(s)${preserved.length ? `, ${preserved.length} existing output(s) preserved` : ''}`,
        details: {
            folder,
            manifestPath,
            label,
            sources: [...new Set([...sourceStates.map(source => source.name), ...(result?.repos || []).map(repo => repo.name)].filter(Boolean))],
            sourceStates,
            transaction: exported.transaction || null,
            recovery: exported.recovery || null,
            preserved,
            exclusions: exclusionSummary(result?.exclusions),
        },
    });
}
