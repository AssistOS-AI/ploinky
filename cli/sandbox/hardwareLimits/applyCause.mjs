import { sanitizeAuthorityDiagnostic } from '../authorityCommandDiagnostics.mjs';

// The cause of an Apply failure that is not a typed hardware outcome: the step
// that failed, the error's class and code, and a bounded, secret-free message.
// A step is recorded on the error where it is thrown (the first, innermost
// step wins); the Apply result then reports it with the generic fix hint.
export const APPLY_STEPS = Object.freeze([
    'planning', 'mps-coordination', 'image-preparation', 'client-inventory', 'drain', 'daemon-stop', 'daemon-cleanup', 'daemon-start', 'set-defaults',
    'verify', 'client-launch', 'runtime-launch', 'restart-preparation', 'readiness', 'activation',
]);
const STEP = /^[a-z][a-z-]{1,31}$/;
const MESSAGE_LIMIT = 400;
const IDENTIFIER = /[^A-Za-z0-9_.$-]/g;

/** Record the step on an error object once; the innermost step is kept. */
export function markApplyStep(error, step) {
    if (error && typeof error === 'object' && STEP.test(step) && !Object.hasOwn(error, 'applyStep')) {
        try { Object.defineProperty(error, 'applyStep', { value: step, configurable: true, enumerable: false }); } catch (_) { /* a frozen error keeps no step */ }
    }
    return error;
}

/** Run one step; a failure carries the step, whether it is thrown or rejected. */
export function inApplyStep(step, operation) {
    try {
        const value = operation();
        return value && typeof value.then === 'function' ? value.then((resolved) => resolved, (error) => { throw markApplyStep(error, step); }) : value;
    } catch (error) { throw markApplyStep(error, step); }
}

function identifier(value, limit) {
    const text = String(value ?? '').replace(IDENTIFIER, '').slice(0, limit);
    return text || null;
}

/** The bounded, secret-free cause of one error: { step, errorClass, code, message }. */
export function describeApplyCause(error, fallbackStep = 'apply') {
    const step = typeof error?.applyStep === 'string' && STEP.test(error.applyStep) ? error.applyStep : STEP.test(fallbackStep) ? fallbackStep : 'apply';
    const raw = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
    const message = sanitizeAuthorityDiagnostic(raw.replace(/\s+/g, ' '), { limit: MESSAGE_LIMIT }).trim() || 'no message';
    const errorClass = (error && typeof error === 'object' ? identifier(error.name || error.constructor?.name, 64) : null) || (error && typeof error === 'object' ? 'Error' : 'NonError');
    const code = typeof error?.code === 'string' || typeof error?.code === 'number' ? identifier(error.code, 64) : null;
    return Object.freeze({ step, errorClass, code, message });
}

/** One line for a person: the step, the class and code, and the bounded message. */
export function formatApplyCause(cause) {
    return `${cause.step}: ${cause.errorClass}${cause.code ? ` (${cause.code})` : ''}: ${cause.message}`;
}

const REPLY_REDACTION_BOUND = 4096;

/**
 * A sanitized excerpt of a reply, for an error or a journal: printable ASCII only (anything else becomes `?`),
 * a newline shown as `\n`, at most 64 bytes, and credentials redacted from the whole original reply first. Replies of the MPS control daemon are
 * numbers, so nothing else is expected; this keeps a surprising one bounded and harmless.
 */
export function replyExcerpt(text, limit = 64) {
    const raw = String(text ?? '');
    // Credentials are redacted from the ORIGINAL reply, before it is escaped or cut: an exact known value is only found whole and
    // unchanged. A reply too long to redact whole is not shown at all (only its size), so no prefix of anything in it can leak.
    if (raw.length > REPLY_REDACTION_BOUND) return `[${Buffer.byteLength(raw)} bytes not shown]`.slice(0, limit);
    const clean = (value) => sanitizeAuthorityDiagnostic(value, { limit: REPLY_REDACTION_BOUND });
    // What is shown is always the sanitizer's own output. The whole reply is sanitized (so a credential spanning lines is found); the
    // sanitizer shows a newline as `?`. When sanitizing line by line gives exactly the same text, the newlines are shown as `\n`
    // instead; otherwise the whole-reply output is shown as it is. The raw reply is never shown and no test of its text is made.
    const whole = clean(raw);
    const parts = raw.split(/(\r?\n)/);
    const lines = parts.map((part, index) => (index % 2 ? part : clean(part)));
    const joined = parts.map((part, index) => (index % 2 ? part.replace(/[\r\n]/g, '?') : lines[index])).join('');
    const shown = joined === whole ? parts.map((part, index) => (index % 2 ? '\\n' : lines[index])).join('') : whole;
    return shown.replace(/[^\x20-\x7e]/g, '?').slice(0, limit);
}

/** What a failed child process looked like, bounded and secret-free: " (error CODE, signal S, exit N, stderr: ...)". */
export function commandFailureDetail(result) {
    const parts = [];
    if (result?.error) parts.push(`error ${identifier(result.error.code || result.error.message, 40) || 'unknown'}`);
    if (result?.signal) parts.push(`signal ${identifier(result.signal, 20)}`);
    if (Number.isInteger(result?.status) && result.status !== 0) parts.push(`exit ${result.status}`);
    const stderr = sanitizeAuthorityDiagnostic(String(result?.stderr || '').replace(/\s+/g, ' '), { limit: 200 }).trim();
    if (stderr) parts.push(`stderr: ${stderr}`);
    return parts.length ? ` (${parts.join(', ')})` : '';
}
