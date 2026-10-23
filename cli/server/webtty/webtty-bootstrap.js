(() => {
    'use strict';

    const tokenPattern = /^[A-Za-z0-9_-]{32}$/;
    let handoff = null;
    try {
        const values = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
        const keys = [...values.keys()];
        const kind = keys[0];
        const value = values.get(kind) || '';
        // Exactly `#launch=<id>`, `#launch=<id>&close=stop` or `#attach=<id>`.
        const stopOnClose = keys.length === 2 && kind === 'launch' && keys[1] === 'close'
            && values.get('close') === 'stop';
        if ((keys.length === 1 || stopOnClose) && ['launch', 'attach'].includes(kind) && tokenPattern.test(value)) {
            handoff = { kind, value, closePolicy: stopOnClose ? 'stop' : 'keep' };
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
