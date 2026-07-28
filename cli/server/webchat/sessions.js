export function formatRelativeTime(value, now = Date.now()) {
    const timestamp = Date.parse(value || '');
    if (!Number.isFinite(timestamp)) return '';
    const elapsed = Math.max(0, now - timestamp);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const units = elapsed < minute
        ? [0, 'just now']
        : elapsed < hour
            ? [Math.floor(elapsed / minute), 'minute']
            : elapsed < day
                ? [Math.floor(elapsed / hour), 'hour']
                : elapsed < 7 * day
                    ? [Math.floor(elapsed / day), 'day']
                    : elapsed < 30 * day
                        ? [Math.floor(elapsed / (7 * day)), 'week']
                        : elapsed < 365 * day
                            ? [Math.floor(elapsed / (30 * day)), 'month']
                            : [Math.floor(elapsed / (365 * day)), 'year'];
    if (units[0] === 0) return units[1];
    return `${units[0]} ${units[1]}${units[0] === 1 ? '' : 's'} ago`;
}

export function createSessionController({
    elements,
    messages,
    network,
    showBanner,
    hideBanner
}) {
    const {
        sessionsBtn,
        historyGate,
        loadHistoryBtn,
        sessionDialog,
        sessionDialogClose,
        sessionList
    } = elements;
    let currentSession = null;
    let currentSnapshot = null;
    let historyLoaded = false;
    let sessionsAvailable = false;

    if (sessionsBtn) sessionsBtn.disabled = true;

    function showHistoryGate(show) {
        if (historyGate) historyGate.hidden = !show;
    }

    function bootstrap() {
        return Promise.resolve(null);
    }

    function loadHistory() {
        if (!currentSnapshot) return;
        messages.renderHistory(currentSnapshot.messages || []);
        historyLoaded = true;
        showHistoryGate(false);
    }

    function closeDialog() {
        if (sessionDialog) sessionDialog.hidden = true;
    }

    function appendNewButton() {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wa-session-list-item wa-session-list-new';
        const label = document.createElement('span');
        label.className = 'wa-session-list-preview';
        label.textContent = 'New';
        button.appendChild(label);
        button.addEventListener('click', () => {
            closeDialog();
            showBanner('Creating session…');
            network.sendQuickCommand('/session new');
        });
        sessionList.appendChild(button);
    }

    function renderSessionList(payload) {
        if (!sessionList) return;
        sessionList.replaceChildren();
        appendNewButton();
        for (const session of payload.sessions || []) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wa-session-list-item';
            button.dataset.current = session.sessionId === payload.currentSessionId ? 'true' : 'false';
            const preview = document.createElement('span');
            preview.className = 'wa-session-list-preview';
            preview.textContent = session.preview || 'New session';
            const relative = document.createElement('span');
            relative.className = 'wa-session-list-time';
            relative.textContent = formatRelativeTime(session.updatedAt);
            button.append(preview, relative);
            button.addEventListener('click', () => {
                closeDialog();
                showBanner('Loading session…');
                network.sendQuickCommand(`/session resume ${session.sessionId}`);
            });
            sessionList.appendChild(button);
        }
    }

    function openDialog() {
        if (!sessionsAvailable || !sessionDialog || !sessionList) return;
        sessionDialog.hidden = false;
        sessionList.replaceChildren();
        appendNewButton();
        const loading = document.createElement('div');
        loading.className = 'wa-session-list-loading';
        loading.textContent = 'Loading sessions…';
        sessionList.appendChild(loading);
        network.sendQuickCommand('/session');
    }

    function handleSessionState(payload) {
        if (!payload || typeof payload !== 'object') return;
        sessionsAvailable = true;
        if (sessionsBtn) sessionsBtn.disabled = false;

        if (payload.event === 'list') {
            renderSessionList(payload);
            return;
        }
        if ((payload.event !== 'current' && payload.event !== 'selected') || !payload.session || !payload.summary) {
            return;
        }

        const hadSession = Boolean(currentSession?.sessionId);
        const changed = payload.summary.sessionId !== currentSession?.sessionId;
        currentSession = payload.summary;
        currentSnapshot = payload.session;

        if (payload.event === 'selected' || (hadSession && changed)) {
            messages.clearMessages();
            messages.renderHistory(payload.session.messages || []);
            historyLoaded = true;
            showHistoryGate(false);
            closeDialog();
            hideBanner();
            return;
        }

        if (!historyLoaded) {
            showHistoryGate(Boolean(payload.summary.hasHistory));
        }
    }

    function addRemoteUserMessage(message) {
        messages.addClientMsg(message?.text || '', {
            historical: true,
            timestamp: message?.timestamp,
            references: message?.references
        });
    }

    sessionsBtn?.addEventListener('click', openDialog);
    loadHistoryBtn?.addEventListener('click', loadHistory);
    sessionDialogClose?.addEventListener('click', closeDialog);
    sessionDialog?.addEventListener('click', (event) => {
        if (event.target === sessionDialog) closeDialog();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && sessionDialog && !sessionDialog.hidden) closeDialog();
    });

    return {
        bootstrap,
        loadHistory,
        handleSessionState,
        addRemoteUserMessage,
        getCurrentSession: () => currentSession,
        isHistoryLoaded: () => historyLoaded
    };
}
