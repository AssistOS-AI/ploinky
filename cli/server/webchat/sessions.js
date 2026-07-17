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
    toEndpoint,
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
    let historyLoaded = false;

    async function request(path, options = {}) {
        const response = await fetch(toEndpoint(path), {
            credentials: 'include',
            ...options,
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...(options.headers || {})
            }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || `session_request_failed_${response.status}`);
        }
        return payload;
    }

    function showHistoryGate(show) {
        if (historyGate) historyGate.hidden = !show;
    }

    function applySession(summary, { restart = true, clear = true } = {}) {
        if (!summary?.sessionId) return;
        const changed = summary.sessionId !== currentSession?.sessionId;
        currentSession = summary;
        historyLoaded = false;
        if (clear) messages.clearMessages();
        showHistoryGate(Boolean(summary.hasHistory));
        network.setSession(summary.sessionId, { restart: restart && changed });
    }

    async function bootstrap() {
        const payload = await request('sessions');
        applySession(payload.current, { restart: false, clear: true });
        return payload.current;
    }

    async function loadHistory(sessionId = currentSession?.sessionId) {
        if (!sessionId) return;
        showHistoryGate(false);
        showBanner('Loading history…');
        try {
            const payload = await request(`sessions/${encodeURIComponent(sessionId)}`);
            if (payload.session.sessionId !== currentSession?.sessionId) {
                hideBanner();
                return;
            }
            messages.renderHistory(payload.session.messages || []);
            currentSession = {
                ...currentSession,
                hasHistory: (payload.session.messages || []).length > 0
            };
            historyLoaded = true;
            showHistoryGate(false);
            hideBanner();
        } catch (error) {
            if (sessionId === currentSession?.sessionId && currentSession?.hasHistory) {
                showHistoryGate(true);
            }
            showBanner(`Unable to load history: ${error.message}`, 'err');
        }
    }

    async function createNewSession() {
        showBanner('Creating session…');
        try {
            const payload = await request('sessions', { method: 'POST' });
            applySession(payload.session, { restart: true, clear: true });
            historyLoaded = true;
            showHistoryGate(false);
            hideBanner();
        } catch (error) {
            showBanner(`Unable to create session: ${error.message}`, 'err');
        }
    }

    function closeDialog() {
        if (sessionDialog) sessionDialog.hidden = true;
    }

    async function selectAndLoad(sessionId) {
        try {
            const payload = await request('sessions/current', {
                method: 'PUT',
                body: JSON.stringify({ sessionId })
            });
            closeDialog();
            applySession(payload.session, { restart: true, clear: true });
            await loadHistory(payload.session.sessionId);
        } catch (error) {
            showBanner(`Unable to select session: ${error.message}`, 'err');
        }
    }

    async function openDialog() {
        if (!sessionDialog || !sessionList) return;
        sessionDialog.hidden = false;
        sessionList.replaceChildren();

        const newSessionButton = document.createElement('button');
        newSessionButton.type = 'button';
        newSessionButton.className = 'wa-session-list-item wa-session-list-new';
        const newSessionLabel = document.createElement('span');
        newSessionLabel.className = 'wa-session-list-preview';
        newSessionLabel.textContent = 'New';
        newSessionButton.appendChild(newSessionLabel);
        newSessionButton.addEventListener('click', () => {
            closeDialog();
            void createNewSession();
        });
        sessionList.appendChild(newSessionButton);

        try {
            const payload = await request('sessions');
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
                button.addEventListener('click', () => void selectAndLoad(session.sessionId));
                sessionList.appendChild(button);
            }
        } catch (error) {
            const line = document.createElement('div');
            line.textContent = `Unable to list sessions: ${error.message}`;
            sessionList.appendChild(line);
        }
    }

    function handleExternalSessionChange(summary) {
        if (!summary?.sessionId || summary.sessionId === currentSession?.sessionId) return;
        applySession(summary, { restart: true, clear: true });
    }

    function addRemoteUserMessage(message) {
        messages.addClientMsg(message?.text || '', {
            historical: true,
            timestamp: message?.timestamp,
            references: message?.references
        });
    }

    sessionsBtn?.addEventListener('click', () => void openDialog());
    loadHistoryBtn?.addEventListener('click', () => void loadHistory());
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
        handleExternalSessionChange,
        addRemoteUserMessage,
        getCurrentSession: () => currentSession,
        isHistoryLoaded: () => historyLoaded
    };
}
