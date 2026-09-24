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

function line(record) {
    const required = record.required === false ? 'optional' : record.required === true ? 'required' : 'required (membership unknown)';
    return `  - ${record.phase} ${record.id}: ${record.outcome} (${record.code || 'no code'}, ${required})`
        + (record.reason ? `: ${sanitizeReason(record.reason, { limit: 400 })}` : '');
}

export function formatUpdateSummary(result) {
    const lines = [];
    const totals = result.totals || {};
    lines.push(STATUS_TEXT[result.status] || `Update status: ${result.status}`);
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

export function printUpdateSummary(result, { log = console.log, error = console.error } = {}) {
    const text = formatUpdateSummary(result);
    if (result.exitCode) error(text);
    else log(text);
}
