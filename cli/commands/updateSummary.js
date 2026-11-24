import { formatDiagnostic, diagnosticLevel, updateDiagnosticLevel } from '../utils/diagnostics.js';
import { sanitizeReason } from './updateOutcome.js';

// Human summary of one `ploinky update` result. The wording is derived from
// the decision on the records; there is no success text after a recorded
// failure.

const STATUS_TEXT = {
    complete: 'Update complete: every input was verified.',
    'complete-with-skips': 'Update complete with named skips or deferrals (none required by the workspace graph).',
    partial: 'Update partially failed: errors were recorded; only verified required inputs may be activated.',
    failed: 'Update incomplete: the workspace cannot be restarted with these changes.',
};

// Delegation between the host and its container is expected, not an update problem.
// Keep these records in the report; hide only optional, non-error outcomes.
export function isExpectedUpdateDelegation(record) {
    if (record.required !== false) return false;
    return (record.phase === 'agentlib' && record.outcome === 'deferred' && record.code === 'owned-by-host')
        || (record.phase === 'host-ploinky' && record.outcome === 'skipped'
            && record.code === 'scope-excluded' && record.id === '/opt/ploinky');
}

function line(record) {
    const required = record.required === false ? 'optional' : record.required === true ? 'required by the workspace' : 'workspace dependency could not be determined';
    return `  - ${record.phase} ${record.id}: ${record.outcome} (${record.code || 'no code'}, ${required})`
        + (record.reason ? `: ${sanitizeReason(record.reason, { limit: 400 })}` : '');
}

export function formatUpdateSummary(result, { hostPhase = false } = {}) {
    const named = (result.records || []).filter(record => !['changed', 'unchanged'].includes(record.outcome)
        && !(hostPhase && isExpectedUpdateDelegation(record)));
    if (hostPhase) {
        return named.map(record => `Update: ${sanitizeReason(record.id)}: ${sanitizeReason(record.reason || record.code || record.outcome)}`)
            .concat((result.graphErrors || []).map(reason => `Dependency check: ${sanitizeReason(reason)}`)).join('\n');
    }
    const lines = [];
    const totals = result.totals || {};
    lines.push(STATUS_TEXT[result.status] || `Update status: ${result.status}`);
    lines.push(`  Records: ${totals.total || 0} (${totals.attempted || 0} attempted) — `
        + `${totals.changed || 0} changed, ${totals.unchanged || 0} unchanged, ${totals.skipped || 0} skipped, `
        + `${totals.deferred || 0} deferred, ${totals.failed || 0} failed, ${totals.uncertain || 0} uncertain.`);
    if (named.length) {
        lines.push('  Not verified:');
        for (const record of named) lines.push(`  ${line(record)}`);
    }
    lines.push(...formatWorkspaceRestartBlockers(result));
    return lines.join('\n');
}

export function printUpdateSummary(result, { log = console.log, error = console.error, hostPhase = false } = {}) {
    if (hostPhase) {
        for (const record of result.records || []) {
            if (['changed', 'unchanged'].includes(record.outcome) || isExpectedUpdateDelegation(record)) continue;
            const level = diagnosticLevel(record);
            const message = `Update: ${sanitizeReason(record.id)}: ${sanitizeReason(record.reason || record.code || record.outcome)}`;
            (result.exitCode ? error : log)(formatDiagnostic(message, level));
        }
        for (const reason of result.graphErrors || []) log(formatDiagnostic(`Dependency check: ${sanitizeReason(reason)}`));
        return;
    }
    const text = formatUpdateSummary(result);
    if (!text) return;
    const level = updateDiagnosticLevel(result);
    const blockers = formatWorkspaceRestartBlockers(result);
    const summary = blockers.length ? text.split('\n').slice(0, -blockers.length).join('\n') : text;
    const write = result.exitCode ? error : log;
    write(level ? formatDiagnostic(summary, level) : summary);
    if (blockers.length) write(formatDiagnostic(blockers.join('\n'), 'warning'));
}

export function formatWorkspaceRestartBlockers(result) {
    const lines = [];
    if (result.blockedBy?.length) {
        const blocking = (result.records || []).filter(record => record.required !== false
            && !['changed', 'unchanged'].includes(record.outcome));
        const dirty = blocking.filter(record => record.required === true && ['dirty-worktree', 'dirty-index'].includes(record.code));
        if (dirty.length) {
            lines.push('Workspace restart skipped: these required repositories have uncommitted changes:');
            for (const record of dirty) lines.push(`  - ${sanitizeReason(record.id)}`);
            lines.push('Commit or stash those changes, then run ploinky update again.');
        }
        const unknown = blocking.filter(record => record.required === null);
        if (unknown.length) {
            lines.push('Workspace restart skipped: Ploinky could not determine whether these skipped or unverified inputs are needed by the workspace:');
            for (const record of unknown) lines.push(`  - ${sanitizeReason(record.id)} (${record.code || record.outcome})`);
            for (const reason of result.graphErrors || []) lines.push(`  Dependency check: ${sanitizeReason(reason)}`);
        }
        const other = blocking.filter(record => record.required === true && !dirty.includes(record));
        if (other.length) {
            lines.push('Workspace restart skipped: these required inputs could not be updated or verified:');
            for (const record of other) lines.push(`  - ${sanitizeReason(record.id)}: ${sanitizeReason(record.reason || record.code || record.outcome)}`);
        }
    }
    return lines;
}
