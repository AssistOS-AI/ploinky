import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createSessionController, formatRelativeTime } from '../../cli/server/webchat/sessions.js';

test('formats WebChat session activity as compact relative English time', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z');
    assert.equal(formatRelativeTime('2026-07-13T11:59:40.000Z', now), 'just now');
    assert.equal(formatRelativeTime('2026-07-13T10:00:00.000Z', now), '2 hours ago');
    assert.equal(formatRelativeTime('2026-07-12T12:00:00.000Z', now), '1 day ago');
    assert.equal(formatRelativeTime('2026-07-11T12:00:00.000Z', now), '2 days ago');
    assert.equal(formatRelativeTime('2026-07-06T12:00:00.000Z', now), '1 week ago');
});

test('uses a dark green hover fill for WebChat header session controls', () => {
    const css = readFileSync(new URL('../../cli/server/webchat/webchat.css', import.meta.url), 'utf8');
    assert.match(css, /\.wa-session-btn:hover\s*\{\s*background:\s*#086b58;\s*\}/);
    assert.doesNotMatch(css, /\.wa-session-btn:hover,\s*\.wa-history-gate button:hover/);
});

test('renders Load History as a scrollable DOM-only assistant message', () => {
    const css = readFileSync(new URL('../../cli/server/webchat/webchat.css', import.meta.url), 'utf8');
    const messages = readFileSync(new URL('../../cli/server/webchat/messages.js', import.meta.url), 'utf8');
    const sessions = readFileSync(new URL('../../cli/server/webchat/sessions.js', import.meta.url), 'utf8');

    assert.doesNotMatch(css, /\.wa-history-gate\s*\{[^}]*position:\s*sticky/s);
    assert.match(messages, /child !== typingIndicator && child !== historyGate/);
    assert.match(sessions, /async function loadHistory[\s\S]*?showHistoryGate\(false\);[\s\S]*?request\(`sessions\/\$\{encodeURIComponent\(sessionId\)\}`\)/);
    assert.doesNotMatch(sessions, /addServerMsg\([^)]*Load History/);
});

test('hides the fake history message during loading and restores it after failure', async () => {
    const originalDocument = globalThis.document;
    const originalFetch = globalThis.fetch;
    const historyGate = { hidden: true };
    const listeners = new Map();
    const loadHistoryBtn = {
        addEventListener(type, listener) {
            listeners.set(type, listener);
        }
    };
    globalThis.document = { addEventListener() {} };

    try {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                current: { sessionId: 'session-1', hasHistory: true }
            })
        });
        const controller = createSessionController({
            toEndpoint: (path) => path,
            elements: { historyGate, loadHistoryBtn },
            messages: { clearMessages() {}, renderHistory() {} },
            network: { setSession() {} },
            showBanner() {},
            hideBanner() {}
        });
        await controller.bootstrap();
        assert.equal(historyGate.hidden, false);
        assert.equal(typeof listeners.get('click'), 'function');

        let rejectLoad;
        globalThis.fetch = () => new Promise((resolve, reject) => {
            rejectLoad = reject;
        });
        const loading = controller.loadHistory();
        assert.equal(historyGate.hidden, true);
        rejectLoad(new Error('offline'));
        await loading;
        assert.equal(historyGate.hidden, false);
    } finally {
        globalThis.document = originalDocument;
        globalThis.fetch = originalFetch;
    }
});
