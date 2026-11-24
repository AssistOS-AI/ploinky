// Only presentation changes here; structured outcomes and exit codes stay intact.
export function diagnosticColorEnabled({ stream = process.stderr, env = process.env } = {}) {
    if (Object.hasOwn(env, 'NO_COLOR')) return false;
    if (env.PLOINKY_DIAGNOSTIC_COLOR === '0') return false;
    if (env.PLOINKY_DIAGNOSTIC_COLOR === '1') return true;
    return stream?.isTTY === true && env.TERM !== 'dumb';
}

export function diagnosticLevel(record) {
    return ['failed', 'uncertain'].includes(record?.outcome) ? 'error' : 'warning';
}

export function formatDiagnostic(message, level = 'warning', options = {}) {
    const text = `${level === 'error' ? '✖' : '⚠'} ${String(message).trimEnd()}`;
    if (!diagnosticColorEnabled(options)) return text;
    return `\u001b[${level === 'error' ? '31' : '33'}m${text}\u001b[0m`;
}

export function updateDiagnosticLevel(result) {
    if ((result.records || []).some(record => diagnosticLevel(record) === 'error')) return 'error';
    return result.status !== 'complete' ? 'warning' : null;
}
