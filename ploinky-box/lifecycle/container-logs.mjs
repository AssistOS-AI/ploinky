// Podman prefixes stored log records with this timestamp when --timestamps is
// selected. Its own diagnostics remain unprefixed, even when they share stderr.
const RECORD_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}(?:Z|[+-]\d{2}:\d{2}) /;
const NON_FATAL_DIAGNOSTIC = /^(?:time="[^"]+" level=(?:trace|debug|info|warn|warning) |(?:TRAC|DEBU|INFO|WARN)\[\d+(?:\.\d+)?\]\s)/;

function lines(value) {
    return String(value || '').match(/[^\n]*\n|[^\n]+$/g) || [];
}

function splitOutput(value) {
    const records = [];
    const diagnostics = [];
    for (const line of lines(value)) {
        (RECORD_PREFIX.test(line) ? records : diagnostics).push(line);
    }
    return { records: records.join(''), diagnostics };
}

export function renderContainerLogs(value) {
    return lines(value).map((line) => line.replace(RECORD_PREFIX, '')).join('');
}

export function readContainerLogs(engine, containerId, runner) {
    const result = runner.query(engine.name, ['container', 'logs', '--timestamps', containerId]);
    if (!result?.ok) return result;
    const stdout = splitOutput(result.stdout);
    const stderr = splitOutput(result.stderr);
    const diagnostics = [...stdout.diagnostics, ...stderr.diagnostics];
    return {
        ...result,
        // Log reader errors can be reported by Podman even with exit status 0.
        // An incomplete read must never provide a baseline or prove readiness.
        ok: diagnostics.every((line) => NON_FATAL_DIAGNOSTIC.test(line)),
        stdout: stdout.records,
        stderr: stderr.records,
        diagnostics: diagnostics.join(''),
    };
}

export function emitContainerLogDiagnostics(diagnostics, output, seen) {
    for (const line of lines(diagnostics)) {
        const key = line
            .replace(/^time="[^"]+" /, '')
            .replace(/^((?:TRAC|DEBU|INFO|WARN|ERRO|FATA|PANI))\[\d+(?:\.\d+)?\]/, '$1');
        if (seen.has(key)) continue;
        seen.add(key);
        output?.write?.(line);
    }
}
