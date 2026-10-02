import { sanitizeDiagnosticText } from '../../utils/diagnosticText.js';

// Keep launcher stderr outside chat while retaining evidence of failed startup.
export function createStartupFailureRecorder(report = record => console.error('[webchat-startup-failed]', record)) {
    let stderr = '';
    let finished = false;
    return {
        append(chunk) { if (!finished) stderr = (stderr + String(chunk)).slice(-8192); },
        ready() { finished = true; stderr = ''; },
        failed({ pid, code, signal }) {
            if (finished) return;
            finished = true;
            report({ pid, code, signal,
                stderr: sanitizeDiagnosticText(stderr, { fallback: '', limit: 8192 }).slice(-4000) });
            stderr = '';
        },
    };
}
