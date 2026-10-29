// Debug-log redaction for AgentServer tool calls. Credentials never reach a
// log line: the key-based redaction covers every Router credential carrier,
// including the serialized `x-ploinky-auth-info` header and the tokens a
// parsed auth-info object holds (invocation, origin and delegation tokens).

export function sanitizeAuthInfoForLog(authInfo = null) {
    if (!authInfo || typeof authInfo !== 'object') return null;
    const github = authInfo.github && typeof authInfo.github === 'object'
        ? {
            provider: authInfo.github.provider || '',
            tokenType: authInfo.github.tokenType || '',
            scope: authInfo.github.scope || '',
            hasAccessToken: Boolean(authInfo.github.accessToken),
            user: authInfo.github.user || null
        }
        : null;
    // Every credential the Router puts in auth-info (invocation, origin and
    // delegation tokens) is redacted by key, like the rest of the context.
    return {
        ...sanitizeValueForLog(authInfo),
        github
    };
}

export function sanitizeInvocationForLog(invocation = null) {
    if (!invocation || typeof invocation !== 'object') return null;
    return {
        iss: invocation.iss,
        sub: invocation.sub,
        aud: invocation.aud,
        tool: invocation.tool,
        scope: invocation.scope,
        workspace_id: invocation.workspace_id,
        iat: invocation.iat,
        exp: invocation.exp,
        hasUserClaims: Boolean(invocation.user)
    };
}

export function shouldRedactLogField(key) {
    // `auth-info` is the serialized Router credential carrier
    // (`x-ploinky-auth-info`, holding invocation and origin tokens);
    // `delegation` covers user delegation grants and their headers.
    return /authorization|auth[_-]?info|taskrefOrigin|delegation|cookie|jwt|token|secret|password|credential|access[_-]?key|api[_-]?key|^value$|^task$|prompt|messages?|resources?|content|base64|stdin|payload/i.test(String(key || ''));
}

export function sanitizeValueForLog(value, key = '') {
    if (value == null) return value;
    if (shouldRedactLogField(key)) return '[redacted]';
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeValueForLog(entry));
    }
    if (typeof value === 'object') {
        const out = {};
        for (const [entryKey, entryValue] of Object.entries(value)) {
            out[entryKey] = sanitizeValueForLog(entryValue, entryKey);
        }
        return out;
    }
    return value;
}

export function sanitizeContextForLog(context = {}) {
    if (!context || typeof context !== 'object') return context;
    const sanitized = sanitizeValueForLog(context);
    return {
        ...sanitized,
        requestInfo: sanitizeValueForLog(context.requestInfo || null),
        invocationToken: context.invocationToken ? '[redacted]' : context.invocationToken,
        authInfo: sanitizeAuthInfoForLog(context.authInfo || null),
        invocation: sanitizeInvocationForLog(context.invocation || null)
    };
}

export function sanitizePayloadForLog(payload = {}) {
    if (!payload || typeof payload !== 'object') return payload;
    return {
        ...payload,
        input: sanitizeValueForLog(payload.input || {}),
        metadata: sanitizeContextForLog(payload.metadata || {})
    };
}
