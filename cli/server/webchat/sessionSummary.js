import { normalizeSessionSettingsAction } from './sessionSettings.js';

export function createSummaryController({ button, sidePanel, origin = globalThis.location?.origin }) {
    let action = null;
    let frame = null;
    if (button) button.hidden = true;
    button?.addEventListener('click', () => {
        if (action) frame = sidePanel.openIframe(action.href, { title: action.label });
    });
    return {
        handleSessionState(payload, selectedSessionId) {
            if (!['current', 'selected', 'updated'].includes(payload?.event)
                || !selectedSessionId || payload.summary?.sessionId !== selectedSessionId
                || payload.session?.sessionId !== selectedSessionId) return;
            const next = normalizeSessionSettingsAction(payload.summaryAction, origin);
            if (action?.href !== next?.href && frame?.isConnected) sidePanel.close();
            action = next;
            if (button) {
                button.hidden = !action;
                button.textContent = action?.label || 'View Summary';
            }
        },
    };
}
