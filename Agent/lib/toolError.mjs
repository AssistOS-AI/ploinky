// Helpers for surfacing actionable error messages when an MCP tool subprocess
// exits non-zero. Tools written against this codebase write a JSON envelope
// (e.g. `{"ok":false,"error":"...","message":"..."}`) to stdout even on
// failure, so falling back to "command exited with code N" hides the real
// reason. This helper prefers explicit failure-envelope JSON, then stderr,
// then the code.

const MAX_FAILURE_MESSAGE_LENGTH = 4096;

function truncateMessage(message) {
    const text = String(message || '');
    if (text.length <= MAX_FAILURE_MESSAGE_LENGTH) return text;
    return `${text.slice(0, MAX_FAILURE_MESSAGE_LENGTH)}...`;
}

function parseJsonErrorMessage(stdout) {
    const trimmed = String(stdout || '').trim();
    if (!trimmed) return '';
    try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object') return '';
        const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        const errorField = typeof parsed.error === 'string' ? parsed.error.trim() : '';
        if (parsed.ok !== false && !errorField) return '';
        if (message && errorField && message !== errorField) {
            return `${errorField}: ${message}`;
        }
        return message || errorField || '';
    } catch (_) {
        return '';
    }
}

export function describeShellFailure(result) {
    const code = result?.code;
    const fromStdout = parseJsonErrorMessage(result?.stdout);
    if (fromStdout) return truncateMessage(fromStdout);
    const stderr = String(result?.stderr || '').trim();
    if (stderr) return truncateMessage(stderr);
    return `command exited with code ${code}`;
}

const ERROR_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_RETRY_AFTER_SECONDS = 86400;

// Only an explicit `"ok": false` marks an envelope. A string `error` alone is
// what an ordinary structured log line looks like, and such a line must never
// choose the HTTP status or replace the diagnostic text.
function asFailureEnvelope(candidate) {
    try {
        const parsed = JSON.parse(candidate);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed.ok === false ? parsed : null;
    } catch (_) {
        return null;
    }
}

function parseFailureEnvelope(text, { lastLineOnly = false } = {}) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return null;
    if (!lastLineOnly) return asFailureEnvelope(trimmed);
    const lines = trimmed.split('\n');
    return asFailureEnvelope(lines[lines.length - 1].trim());
}

/**
 * Describe a failed command handler for an HTTP endpoint. Besides the message
 * of `describeShellFailure`, a failure envelope (`"ok": false`) may choose how
 * the failure is reported: `status` (an integer from 400 to 599), `type` (an
 * OpenAI-style error type) and `retryAfter` (seconds). Anything absent or
 * malformed is returned as `null`, and the caller keeps its own default.
 *
 * A buffered handler prints the envelope as its whole stdout. A streamed
 * handler owns stdout for its events, so it prints the envelope as the last
 * line of stderr, after any diagnostic output.
 *
 * @param {{ code?: number|null, stdout?: string, stderr?: string }} result
 * @returns {{ message: string, status: number|null, type: string|null, retryAfterSeconds: number|null }}
 */
export function describeShellFailureDetails(result) {
    const stdoutEnvelope = parseFailureEnvelope(result?.stdout);
    const stderrEnvelope = stdoutEnvelope ? null : parseFailureEnvelope(result?.stderr, { lastLineOnly: true });
    const envelope = stdoutEnvelope || stderrEnvelope;
    // `describeShellFailure` already takes its message from a stdout envelope.
    // An stderr envelope replaces the raw stderr text it was appended to.
    const envelopeMessage = stderrEnvelope
        ? parseJsonErrorMessage(JSON.stringify(stderrEnvelope))
        : '';
    const message = envelopeMessage ? truncateMessage(envelopeMessage) : describeShellFailure(result);
    const status = Number.isInteger(envelope?.status) && envelope.status >= 400 && envelope.status <= 599
        ? envelope.status
        : null;
    const type = typeof envelope?.type === 'string' && ERROR_TYPE_RE.test(envelope.type)
        ? envelope.type
        : null;
    const retryAfter = Number(envelope?.retryAfter);
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= MAX_RETRY_AFTER_SECONDS
        ? Math.ceil(retryAfter)
        : null;
    return { message, status, type, retryAfterSeconds };
}
