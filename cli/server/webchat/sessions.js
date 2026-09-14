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
        chatList,
        sessionDialog,
        sessionDialogClose,
        sessionList
    } = elements;
    let currentSession = null;
    let currentSnapshot = null;
    let historyLoaded = false;
    let sessionsAvailable = false;
    let firstVisibleIndex = 0;
    let loadingOlder = false;
    let generation = 0;
    const INITIAL_MESSAGES = 100;
    const PAGE_MESSAGES = 50;


    if (sessionsBtn) sessionsBtn.disabled = true;

    function showHistoryGate(show) {
        if (historyGate) historyGate.hidden = !show;
    }

    function bootstrap() {
        return Promise.resolve(null);
    }

    function loadHistory() {
        if (!currentSnapshot) return;
        generation += 1;
        loadingOlder = false;
        chatList?.classList.remove('is-loading-history');
        const all = currentSnapshot.messages || [];
        firstVisibleIndex = Math.max(0, all.length - INITIAL_MESSAGES);
        messages.renderHistory(all.slice(firstVisibleIndex), { startIndex: firstVisibleIndex });
        historyLoaded = true;
        showHistoryGate(false);
        if (chatList) chatList.scrollTop = chatList.scrollHeight;
    }

    async function loadOlder() {
        if (loadingOlder || !firstVisibleIndex || !chatList) return;
        loadingOlder = true;
        const requestGeneration = generation;
        const previousHeight = chatList.scrollHeight;
        const previousTop = chatList.scrollTop;
        chatList.classList.add('is-loading-history');
        showHistoryGate(true);
        // Let the loading overlay paint before inserting a bounded page.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (requestGeneration !== generation) return;
        try {
            const nextIndex = Math.max(0, firstVisibleIndex - PAGE_MESSAGES);
            messages.renderHistory(currentSnapshot.messages.slice(nextIndex, firstVisibleIndex), { prepend: true, startIndex: nextIndex });
            firstVisibleIndex = nextIndex;

        } finally {
            loadingOlder = false;
            showHistoryGate(false);
            chatList.classList.remove('is-loading-history');
            chatList.scrollTop = previousTop + chatList.scrollHeight - previousHeight;
        }
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
        button.addEventListener('click', async () => {
            closeDialog();
            showBanner('Creating session…');
            if (!await network.sendQuickCommand('/session new')) {
                showBanner('Unable to create session. Wait for the agent to be ready.', 'err');
            }
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
            button.addEventListener('click', async () => {
                closeDialog();
                showBanner('Loading session…');
                if (!await network.sendQuickCommand(`/session resume ${session.sessionId}`)) {
                    showBanner('Unable to load session. Wait for the agent to be ready.', 'err');
                }
            });
            sessionList.appendChild(button);
        }
    }

    async function openDialog() {
        if (!sessionsAvailable || !sessionDialog || !sessionList) return;
        sessionDialog.hidden = false;
        sessionList.replaceChildren();
        appendNewButton();
        const loading = document.createElement('div');
        loading.className = 'wa-session-list-loading';
        loading.textContent = 'Loading sessions…';
        sessionList.appendChild(loading);
        if (!await network.sendQuickCommand('/session')) {
            loading.textContent = 'Sessions unavailable until the agent is ready.';
            showBanner('Unable to load sessions. Wait for the agent to be ready.', 'err');
        }
    }

    function handleSessionState(payload) {
        if (!payload || typeof payload !== 'object') return;
        if (payload.event === 'error') {
            if (!payload.sessionId || payload.sessionId === currentSession?.sessionId) {
                messages.hideTypingIndicator?.(true);
                showBanner(payload.error || 'Session operation failed.', 'err');
            }
            return;
        }
        sessionsAvailable = true;
        if (sessionsBtn) sessionsBtn.disabled = false;

        if (payload.event === 'list') {
            renderSessionList(payload);
            return;
        }
        if (!['current', 'selected', 'updated'].includes(payload.event) || !payload.session || !payload.summary) {
            return;
        }

        const changed = payload.summary.sessionId !== currentSession?.sessionId;
        // Updates describe an execution, not a request to select its conversation.
        if (payload.event === 'updated' && changed) return;
        currentSession = payload.summary;
        if (loadingOlder) {
            generation += 1;
            loadingOlder = false;
            showHistoryGate(false);
            chatList?.classList.remove('is-loading-history');
        }
        currentSnapshot = payload.session;
        messages.setSessionId?.(currentSession.sessionId);

        if (!historyLoaded || changed || payload.event === 'selected') {
            loadHistory();
            closeDialog();
            hideBanner();
        } else if (payload.event === 'updated' || payload.event === 'current') {
            const previousHeight = chatList?.scrollHeight || 0;
            const previousTop = chatList?.scrollTop || 0;
            const atBottom = !chatList || previousHeight - previousTop - chatList.clientHeight < 80;
            const all = currentSnapshot.messages || [];
            firstVisibleIndex = Math.min(firstVisibleIndex, all.length);
            messages.renderHistory(all.slice(firstVisibleIndex), { startIndex: firstVisibleIndex });
            if (chatList) chatList.scrollTop = atBottom ? chatList.scrollHeight : previousTop;
            hideBanner();
        }
    }

    function addRemoteUserMessage(message, payload = {}) {
        if (payload.sessionId && payload.sessionId !== currentSession?.sessionId) return;
        messages.addClientMsg(message?.text || '', {
            historical: true,
            timestamp: message?.timestamp,
            references: message?.references,
            messageId: message?.id,
            messageIndex: payload.messageIndex,
        });
    }

    sessionsBtn?.addEventListener('click', openDialog);
    chatList?.addEventListener('scroll', () => { if (chatList.scrollTop < 120) void loadOlder(); }, { passive: true });
    for (const event of ['wheel', 'touchmove']) chatList?.addEventListener(event, e => { if (loadingOlder) e.preventDefault(); }, { passive: false });
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
        loadOlder,
        handleSessionState,
        addRemoteUserMessage,
        getCurrentSession: () => currentSession,
        isHistoryLoaded: () => historyLoaded
    };
}
