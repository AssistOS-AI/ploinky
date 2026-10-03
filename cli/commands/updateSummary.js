import { sanitizeReason } from './updateOutcome.js';

// Human summary of one `ploinky update` result. The wording is derived from
// the decision on the records; there is no success text after a recorded
// failure.

const STATUS_TEXT = {
    complete: 'Update complete: every input was verified.',
    'complete-with-skips': 'Update complete with named skips or deferrals (none required by the workspace graph).',
    partial: 'Update partially failed: errors were recorded; only verified required inputs may be activated.',
    failed: 'Update failed: required inputs are not verified, so activation is blocked.',
};

// The in-Box update that the host runs is one phase of the host's update: the
// host activates it and prints the update result, so this phase never claims it.
const PHASE_STATUS_TEXT = {
    complete: 'In-Box update phase: every input was verified. The host activates it and reports the update result.',
    'complete-with-skips': 'In-Box update phase: verified with named skips or deferrals (none required by the workspace graph). '
        + 'The host activates it and reports the update result.',
    partial: 'In-Box update phase: errors were recorded. The host reports the update result.',
    failed: 'In-Box update phase: required inputs are not verified. The host reports the update result.',
};

function line(record) {
    const required = record.required === false ? 'optional' : record.required === true ? 'required' : 'required (membership unknown)';
    return `  - ${record.phase} ${record.id}: ${record.outcome} (${record.code || 'no code'}, ${required})`
        + (record.reason ? `: ${sanitizeReason(record.reason, { limit: 400 })}` : '');
}

export function formatUpdateSummary(result, { hostPhase = false } = {}) {
    const lines = [];
    const totals = result.totals || {};
    lines.push((hostPhase ? PHASE_STATUS_TEXT : STATUS_TEXT)[result.status] || `Update status: ${result.status}`);
    lines.push(`  Records: ${totals.total || 0} (${totals.attempted || 0} attempted) — `
        + `${totals.changed || 0} changed, ${totals.unchanged || 0} unchanged, ${totals.skipped || 0} skipped, `
        + `${totals.deferred || 0} deferred, ${totals.failed || 0} failed, ${totals.uncertain || 0} uncertain.`);
    const named = (result.records || []).filter(record => !['changed', 'unchanged'].includes(record.outcome));
    if (named.length) {
        lines.push('  Not verified:');
        for (const record of named) lines.push(`  ${line(record)}`);
    }
    if (result.blockedBy?.length) {
        lines.push(`  Activation blocked by: ${result.blockedBy.map(entry => `${entry.phase} ${entry.id} (${entry.outcome}${entry.code ? `, ${entry.code}` : ''})`).join('; ')}`);
    }
    return lines.join('\n');
}

export function printUpdateSummary(result, { log = console.log, error = console.error, hostPhase = false } = {}) {
    const text = formatUpdateSummary(result, { hostPhase });
    if (result.exitCode) error(text);
    else log(text);
}
