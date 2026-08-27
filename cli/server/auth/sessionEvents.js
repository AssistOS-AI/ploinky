const invalidationListeners = new Set();

export function onAuthenticationSessionInvalidated(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    invalidationListeners.add(listener);
    return () => invalidationListeners.delete(listener);
}

export function emitAuthenticationSessionInvalidated({
    mode = '',
    sessionId = '',
    sessionBindingId = '',
    all = false,
    reason = 'revoked',
} = {}) {
    const event = Object.freeze({
        mode: String(mode || '').trim(),
        sessionId: String(sessionId || '').trim(),
        sessionBindingId: String(sessionBindingId || '').trim(),
        all: all === true,
        reason: String(reason || 'revoked').trim() || 'revoked',
    });
    for (const listener of [...invalidationListeners]) {
        try { listener(event); } catch (_) { }
    }
}

export default {
    emitAuthenticationSessionInvalidated,
    onAuthenticationSessionInvalidated,
};
