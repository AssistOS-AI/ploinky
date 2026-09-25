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

// A thrown export whose journal stays pending has not failed: its outputs are
// between two states until recovery completes, so the record is uncertain.
function thrownExportOutcome(error) {
    return error?.code === 'SKILL_EXPORT_RECOVERY_REQUIRED' ? 'uncertain' : 'failed';
}

export function defaultSkillsRecord(entry) {
    const target = entry.repoName;
    const source = entry.defaultSkillsRepoName;
    const id = `${source}->${target}`;
    const base = { phase: 'default-skills', id };
    if (entry.error) {
        return createOperationRecord({
            ...base,
            outcome: thrownExportOutcome(entry.error),
            code: String(entry.error?.code || 'default-skills-failed'),
            reason: String(entry.error?.message || entry.error),
            details: { target, source, targetPath: entry.repoPath || null },
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
        return createOperationRecord({
            ...base,
            outcome: thrownExportOutcome(error),
            code: String(error?.code || 'skills-manifest-failed'),
            reason: String(error?.message || error),
            details: { folder, manifestPath, label },
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
