export function normalizeSessionSettingsAction(action, origin) {
    if (!action || typeof action.label !== 'string' || !action.label.trim() || action.label.length > 80
        || /[\x00-\x1f\x7f]/.test(action.label)
        || typeof action.href !== 'string' || action.href.length > 4096 || !/^\/(?!\/)/.test(action.href)
        || /[\\\x00-\x20\x7f]/.test(action.href)) return null;
    try {
        const url = new URL(action.href, origin);
        if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        return { label: action.label.trim(), href: `${url.pathname}${url.search}${url.hash}` };
    } catch {
        return null;
    }
}

// The agent declares a navigation action for its selected conversation. It is never fetched or opened automatically.
export function createSessionSettingsController({ link, origin = globalThis.location?.origin } = {}) {
    function clear() {
        if (!link) return;
        link.hidden = true;
        link.removeAttribute('href');
        link.textContent = '';
    }
    clear();
    return {
        handleSessionState(payload, selectedSessionId) {
            if (!link || !['current', 'selected', 'updated'].includes(payload?.event)
                || !payload.session || !payload.summary || payload.summary.sessionId !== selectedSessionId) return;
            clear();
            if (payload.session.sessionId !== selectedSessionId) return;
            const action = normalizeSessionSettingsAction(payload.settingsAction, origin);
            if (!action) return;
            link.textContent = action.label;
            link.href = action.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.hidden = false;
        },
        clear,
    };
}
