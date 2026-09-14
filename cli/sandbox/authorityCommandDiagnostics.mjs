import crypto from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

import { sanitizeControlDiagnosticText } from '../utils/diagnosticText.js';

export const AUTHORITY_DIAGNOSTIC_LIMIT = 2_000;
const SENSITIVE_NAME = /(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|authorization|cookie)/i;

function redactAssignments(text) {
    // Match each complete key once; retrying a greedy key pattern at every
    // word boundary makes diagnostics with long hyphenated words quadratic.
    const assignment = /(?<![\w.-])([\w.-]+)["']?\s*(?:[:=]\s*|\s+)/g;
    let output = '';
    let cursor = 0;
    let match;
    while ((match = assignment.exec(text))) {
        if (!SENSITIVE_NAME.test(match[1])) continue;
        let end = assignment.lastIndex;
        const quote = text[end];
        if (quote === '{' || quote === '[') {
            // A structured credential may contain arbitrary nested secrets.
            end = text.length;
        } else if (quote === '"' || quote === "'") {
            end += 1;
            while (end < text.length) {
                const character = text[end++];
                if (character === '\\') end = Math.min(end + 1, text.length);
                else if (character === quote) break;
            }
        } else {
            while (end < text.length && !/[\s,;]/.test(text[end])) end += 1;
        }
        output += text.slice(cursor, match.index) + `${match[1]}=[REDACTED]`;
        cursor = end;
        assignment.lastIndex = end;
    }
    return output + text.slice(cursor);
}

export function sanitizeAuthorityDiagnostic(value, { sensitiveValues = [], limit = AUTHORITY_DIAGNOSTIC_LIMIT } = {}) {
    let text = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
    // Strip terminal escapes before matching secrets so they cannot split a key.
    text = stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
    const secrets = [...sensitiveValues, ...Object.entries(process.env)
        .filter(([name]) => SENSITIVE_NAME.test(name))
        .map(([, secret]) => secret)]
        .filter((secret) => typeof secret === 'string' && secret.length > 0)
        .sort((left, right) => right.length - left.length);
    for (const secret of new Set(secrets)) text = text.split(secret).join('[REDACTED]');
    text = text
        .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
        .replace(/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/]*@/gi, '$1[REDACTED]@')
        .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/gi, '[REDACTED HEADER]')
        .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[REDACTED]')
        .replace(/(^|[^A-Za-z0-9_.-])eyJ[A-Za-z0-9_.-]+/g, '$1[REDACTED]');
    text = redactAssignments(text);
    // Redact the entire captured value before truncating; never start an excerpt
    // mid-token or serialize spawn errors (which can contain the full argv).
    return sanitizeControlDiagnosticText(text, { limit, fallback: '' }).trim();
}

export function authorityCommandFailure(operation, result, { timeout, sensitiveValues = [] } = {}) {
    const stderr = typeof result?.stderr === 'string' || Buffer.isBuffer(result?.stderr)
        ? Buffer.from(result.stderr)
        : Buffer.alloc(0);
    const errorCode = typeof result?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(result.error.code)
        ? result.error.code
        : null;
    const signal = typeof result?.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(result.signal)
        ? result.signal
        : null;
    const metadata = {
        status: Number.isInteger(result?.status) ? result.status : null,
        ...(signal ? { signal } : {}),
        ...(errorCode ? { errorCode } : {}),
        timeoutMs: timeout,
        ...(errorCode === 'ETIMEDOUT' ? { timedOut: true } : {}),
        stderrBytes: stderr.length,
        stderrSha256: `sha256:${crypto.createHash('sha256').update(stderr).digest('hex')}`,
    };
    const detail = sanitizeAuthorityDiagnostic(stderr.toString('utf8'), { sensitiveValues });
    return `bounded helper operation failed during ${operation} (${JSON.stringify(metadata)})`
        + (detail ? `; stderr: ${detail}` : '; stderr: (empty)');
}
