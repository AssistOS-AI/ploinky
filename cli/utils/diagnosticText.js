export const DIAGNOSTIC_TEXT_LIMIT = 4_000;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const AUTHORIZATION_PATTERN = /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s,;]+/gi;
const COMMON_ASSIGNMENT_PATTERN = /\b(?:access[_-]?token|api[_-]?(?:key|token)|authorization|credential|jwt|password|passwd|secret|token|private[_-]?key)\b\s*[:=]\s*(?:["'][^"'\r\n]*["']|[^\s,;]+)/gi;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sanitizeDiagnosticText(value, {
    secretNames = [],
    limit = DIAGNOSTIC_TEXT_LIMIT,
    fallback = 'An internal operation failed',
    singleLine = false,
} = {}) {
    let text;
    if (typeof value === 'string') text = value;
    else if (value instanceof Error && typeof value.message === 'string') text = value.message;
    else return fallback.slice(0, limit);

    text = text.replace(AUTHORIZATION_PATTERN, 'Authorization: [REDACTED]');
    text = text.replace(JWT_PATTERN, '[REDACTED]');

    const names = Array.from(new Set(secretNames
        .filter((name) => typeof name === 'string' && name.trim())
        .map((name) => name.trim())))
        .sort((left, right) => right.length - left.length);
    if (names.length) {
        const named = new RegExp(
            `\\b(?:${names.map(escapeRegExp).join('|')})\\b\\s*[:=]\\s*(?:["'][^"'\\r\\n]*["']|[^\\s,;]+)`,
            'gi',
        );
        text = text.replace(named, (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`);
    }
    text = text.replace(COMMON_ASSIGNMENT_PATTERN, (match) => (
        `${match.split(/[:=]/, 1)[0]}=[REDACTED]`
    ));
    text = text.replace(
        singleLine
            ? /[\u0000-\u001f\u007f-\u009f]/g
            : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
        '?',
    );

    const ceiling = Number.isSafeInteger(limit) && limit > 0 ? limit : DIAGNOSTIC_TEXT_LIMIT;
    if (text.length <= ceiling) return text;
    if (ceiling <= 1) return text.slice(0, ceiling);
    return `${text.slice(0, ceiling - 1)}…`;
}

export function sanitizeControlDiagnosticText(value, options = {}) {
    return sanitizeDiagnosticText(value, { ...options, singleLine: true });
}
