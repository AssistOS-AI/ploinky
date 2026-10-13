(() => {
    'use strict';

    const tokenPattern = /^[A-Za-z0-9_-]{32}$/;
    let handoff = null;
    try {
        const values = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
        const keys = [...values.keys()];
        const kind = keys[0];
        const value = values.get(kind) || '';
        if (keys.length === 1 && ['launch', 'attach'].includes(kind) && tokenPattern.test(value)) {
            handoff = { kind, value };
        }
    } catch (_) {}
    try {
        window.history.replaceState(null, '', window.location.pathname || '/webtty/');
    } catch (_) {
        handoff = null;
    }
    Object.defineProperty(window, '__ploinkyTakeWebttyHandoff', {
        configurable: true,
        enumerable: false,
        value() {
            const result = handoff;
            handoff = null;
            try { delete window.__ploinkyTakeWebttyHandoff; } catch (_) {}
            return result;
        },
    });
})();
