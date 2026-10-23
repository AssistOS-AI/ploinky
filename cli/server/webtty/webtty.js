(() => {
    'use strict';

    const MAX_PENDING_INPUT_BYTES = 64 * 1024;
    const MAX_INPUT_REQUEST_BYTES = 8 * 1024;
    const INPUT_FLUSH_MS = 20;
    const RESIZE_FLUSH_MS = 100;
    const RECONNECT_LIMIT_MS = 10 * 60_000;
    const STORAGE_KEY = 'ploinky.webtty.session';
    const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
    const VIEW_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
    // A recovery claim names the replaced view in the attach-token mint body.
    const CLAIM_PATTERN = /^[A-Za-z0-9_-]{32}$/;
    const VIEW_MESSAGE = 'ploinky-webtty:view';
    const encoder = new TextEncoder();
    let handoff = null;
    try { handoff = window.__ploinkyTakeWebttyHandoff?.() || null; } catch (_) {}

    const directoryElement = document.getElementById('directory');
    const targetElement = document.getElementById('target');
    const accessElement = document.getElementById('access');
    const roleElement = document.getElementById('role');
    const profileElement = document.getElementById('profile');
    const killButton = document.getElementById('kill');
    const statusElement = document.getElementById('status');
    const statusDot = document.getElementById('status-dot');
    const dimensionsElement = document.getElementById('dimensions');
    const messageElement = document.getElementById('message');
    const terminalElement = document.getElementById('terminal');
    const embedded = window.top !== window;
    if (embedded) document.body.classList.add('embedded');

    let terminalSessionId = '';
    // The server-issued view of this document; streams and the close signal bind to it.
    let viewId = '';
    // The session's stored policy as the server reports it; only announced to an embedding page.
    let closePolicy = 'keep';
    let intentSentForView = '';
    let role = 'watcher';
    let eventSource = null;
    let closed = false;
    let deletionStarted = false;
    let inputStopped = false;
    let inputQueue = '';
    let inputQueueBytes = 0;
    let inputTimer = null;
    let inputChain = Promise.resolve();
    let resizeTimer = null;
    let reconnectTimer = null;
    let reconnectSince = null;
    let reconnectDelay = 1000;

    function mutationHeaders() {
        // The HttpOnly CSRF cookie is accepted by the router with exact Origin.
        return { 'Content-Type': 'application/json' };
    }

    function setStatus(text, state = '') {
        statusElement.textContent = text;
        statusDot.className = `status-dot${state ? ` ${state}` : ''}`;
    }

    function showMessage(text) {
        messageElement.textContent = text;
        messageElement.hidden = false;
    }

    function friendlyFailure(status, fallback) {
        if (status === 400) return 'The terminal request is invalid.';
        if (status === 401) return 'Your authentication session has expired.';
        if (status === 403) return 'Administrator access is required.';
        if (status === 404) return 'Reopen this terminal from Live Sessions.';
        if (status === 409) return 'This terminal target changed. Choose again from Explorer.';
        if (status === 429) return 'Close or kill an existing terminal in Explorer → Live Sessions';
        if (status === 503) return 'The terminal runtime is temporarily unavailable.';
        return fallback;
    }

    async function jsonRequest(url, options = {}) {
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
        let body = null;
        try { body = await response.json(); } catch (_) {}
        if (!response.ok) {
            const error = new Error(friendlyFailure(response.status, 'The terminal request failed.'));
            error.status = response.status;
            error.body = body;
            throw error;
        }
        return body;
    }

    async function refreshingMutation(url, body, stillWanted = () => true) {
        const options = { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body) };
        try {
            return await jsonRequest(url, options);
        } catch (error) {
            if (error.status !== 403 || error.body?.error !== 'browser_csrf_invalid') throw error;
            await jsonRequest('/webtty/live-sessions');
            if (!stillWanted()) return undefined;
            // Refresh once, then propagate any second refusal without another retry.
            return jsonRequest(url, options);
        }
    }

    function inputMutation(url, body) {
        return refreshingMutation(url, body, () => !closed && !inputStopped && role === 'owner');
    }

    // Only a top-level page remembers its terminal: exactly {sessionId,
    // viewId}, never tokens, rewritten after every successful create, attach
    // or restore. Every storage failure is contained.
    function rememberSession() {
        if (embedded) return;
        try {
            window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ sessionId: terminalSessionId, viewId }));
        } catch (_) {}
    }

    function forgetSession() {
        if (embedded) return;
        try { window.sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }

    // Returns null when nothing is stored, or the exact remembered ids. Any
    // other (invalid or legacy) value throws, like a storage read failure.
    function storedSession() {
        const value = window.sessionStorage.getItem(STORAGE_KEY);
        if (value === null) return null;
        const parsed = JSON.parse(String(value));
        const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
        if (keys.length !== 2 || keys[0] !== 'sessionId' || keys[1] !== 'viewId'
            || !SESSION_ID_PATTERN.test(String(parsed.sessionId)) || !CLAIM_PATTERN.test(String(parsed.viewId))
            || typeof parsed.sessionId !== 'string' || typeof parsed.viewId !== 'string') {
            throw new Error('invalid remembered terminal');
        }
        return { sessionId: parsed.sessionId, viewId: parsed.viewId };
    }

    function announceView() {
        if (!embedded || !viewId || !terminalSessionId) return;
        try {
            window.parent.postMessage({
                type: VIEW_MESSAGE, sessionId: terminalSessionId, viewId, role, policy: closePolicy,
            }, window.location.origin);
        } catch (_) {}
    }

    function showProfile(label) {
        if (!profileElement) return;
        profileElement.textContent = label ? `Profile: ${label}` : '';
        profileElement.hidden = !label;
    }

    const terminal = new window.Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        disableStdin: true,
        fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        scrollback: 2000,
        theme: { background: '#0b0f14', foreground: '#e6edf3', cursor: '#e6edf3' },
    });
    const fitAddon = new window.FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalElement);
    fitAddon.fit();

    function boundedDimensions() {
        return {
            cols: Math.max(2, Math.min(1024, Number.isSafeInteger(terminal.cols) ? terminal.cols : 80)),
            rows: Math.max(2, Math.min(512, Number.isSafeInteger(terminal.rows) ? terminal.rows : 24)),
        };
    }

    function fit() {
        try { fitAddon.fit(); } catch (_) {}
        const dimensions = boundedDimensions();
        dimensionsElement.textContent = `${dimensions.cols} × ${dimensions.rows}`;
    }

    function stopInput() {
        inputStopped = true;
        inputQueue = '';
        inputQueueBytes = 0;
        window.clearTimeout(inputTimer);
        inputTimer = null;
        terminal.options.disableStdin = true;
    }

    function setRole(value) {
        role = value;
        roleElement.textContent = role === 'owner' ? 'Owner' : 'Watching (read-only)';
        terminal.options.disableStdin = role !== 'owner' || inputStopped || closed;
    }

    function inputFailure(error) {
        stopInput();
        if (error.status === 403 && error.body?.error === 'owner_required') {
            setRole('watcher');
            showMessage('Watching (read-only). Only the owner can type or resize.');
        } else if (error.status === 503 && error.body?.error === 'edge_generation_changed') {
            showMessage('Input was not sent because the connection changed. Reopen from Live Sessions to continue typing.');
        } else {
            showMessage(error.message || 'Input stopped. Reopen from Live Sessions to continue typing.');
        }
    }

    function takeUtf8Chunk(value, maxBytes) {
        if (encoder.encode(value).length <= maxBytes) return [value, ''];
        let result = '';
        let bytes = 0;
        let offset = 0;
        for (const character of value) {
            const size = encoder.encode(character).length;
            if (bytes + size > maxBytes) break;
            result += character;
            bytes += size;
            offset += character.length;
        }
        return [result, value.slice(offset)];
    }

    async function flushInput() {
        while (inputQueue && terminalSessionId && !closed && !inputStopped && role === 'owner') {
            const [data, rest] = takeUtf8Chunk(inputQueue, MAX_INPUT_REQUEST_BYTES);
            inputQueue = rest;
            inputQueueBytes = encoder.encode(rest).length;
            await inputMutation(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/input`, { data });
        }
    }

    terminal.onData((data) => {
        if (closed || inputStopped || role !== 'owner' || !terminalSessionId) return;
        const nextBytes = inputQueueBytes + encoder.encode(data).length;
        if (nextBytes > MAX_PENDING_INPUT_BYTES) {
            stopInput();
            showMessage('Input stopped because the browser queue reached its safety limit. Reopen from Live Sessions to continue.');
            return;
        }
        inputQueue += data;
        inputQueueBytes = nextBytes;
        if (!inputTimer) {
            inputTimer = window.setTimeout(() => {
                inputTimer = null;
                inputChain = inputChain.then(flushInput).catch(inputFailure);
            }, INPUT_FLUSH_MS);
        }
    });

    async function sendResize() {
        resizeTimer = null;
        fit();
        if (!terminalSessionId || closed || inputStopped || role !== 'owner') return;
        try {
            await inputMutation(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/resize`, boundedDimensions());
        } catch (error) {
            inputFailure(error);
        }
    }
    window.addEventListener('resize', () => {
        window.clearTimeout(resizeTimer);
        if (!closed) resizeTimer = window.setTimeout(sendResize, RESIZE_FLUSH_MS);
    });

    let shellExited = false;

    function disposeLocal() {
        closed = true;
        stopInput();
        window.clearTimeout(resizeTimer);
        window.clearTimeout(reconnectTimer);
        resizeTimer = reconnectTimer = null;
        eventSource?.close();
        eventSource = null;
        killButton.disabled = true;
        setStatus('Disconnected');
    }

    function recoverStream() {
        if (closed || reconnectTimer) return;
        if (reconnectSince === null) {
            reconnectSince = Date.now();
            terminal.reset();
        }
        if (Date.now() - reconnectSince >= RECONNECT_LIMIT_MS) {
            disposeLocal();
            showMessage('Disconnected — reopen from Live Sessions');
            return;
        }
        const delay = Math.min(reconnectDelay, RECONNECT_LIMIT_MS - (Date.now() - reconnectSince));
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
        reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            if (!closed) {
                if (Date.now() - reconnectSince >= RECONNECT_LIMIT_MS) recoverStream();
                else attachStream();
            }
        }, delay);
    }

    function attachStream() {
        if (closed) return;
        const source = new EventSource(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/stream?view=${encodeURIComponent(viewId)}`);
        eventSource = source;
        const current = () => !closed && eventSource === source;
        source.addEventListener('open', () => {
            if (!current()) return;
            reconnectSince = null;
            reconnectDelay = 1000;
            setStatus('Connected', 'connected');
        });
        source.addEventListener('output', (event) => {
            if (!current()) return;
            try { terminal.write(JSON.parse(event.data).data); } catch (_) {}
        });
        source.addEventListener('replay-truncated', () => {
            if (current()) showMessage('Showing recent terminal output. Older output is no longer available.');
        });
        source.addEventListener('resync', () => { if (current()) terminal.reset(); });
        source.addEventListener('reset', () => {
            if (!current()) return;
            disposeLocal();
            showMessage('Replay unavailable — reopen from Live Sessions');
        });
        source.addEventListener('detached', () => {
            if (!current()) return;
            disposeLocal();
            showMessage('This view detached. Reopen this terminal from Live Sessions.');
        });
        source.addEventListener('exit', (event) => {
            if (!current()) return;
            shellExited = true;
            forgetSession();
            let reason = 'Terminal exited.';
            try { reason = `Terminal closed: ${JSON.parse(event.data).reason || 'exited'}.`; } catch (_) {}
            disposeLocal();
            setStatus('Closed', 'error');
            showMessage(reason);
        });
        source.addEventListener('error', () => {
            if (!current()) return;
            setStatus('Reconnecting…');
            if (source.readyState === EventSource.CLOSED) {
                source.close();
                recoverStream();
            }
        });
    }

    async function killSession({ keepalive = false, refreshProof = false } = {}) {
        if (!terminalSessionId || deletionStarted) return;
        deletionStarted = true;
        if (!refreshProof) disposeLocal();
        else killButton.disabled = true;
        try {
            // A confirmed Kill refreshes the CSRF proof once, then sends exactly one DELETE.
            if (refreshProof) await jsonRequest('/webtty/live-sessions');
            await jsonRequest(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}`, {
                method: 'DELETE', headers: mutationHeaders(), keepalive,
            });
            disposeLocal();
            forgetSession();
            setStatus('Closed', 'error');
            showMessage('Terminal killed.');
        } catch (error) {
            if (!refreshProof) {
                showMessage(`Kill could not be confirmed. ${error.message}`);
                return;
            }
            if (shellExited || error.status === 404) {
                killButton.disabled = true;
                showMessage('The terminal had already ended.');
                return;
            }
            if (closed) {
                // The view closed for another reason; the shell may still be running.
                killButton.disabled = true;
                showMessage('Kill could not be confirmed. Reopen this terminal from Live Sessions to check whether it is still running.');
                return;
            }
            deletionStarted = false;
            killButton.disabled = false;
            showMessage(`Kill failed: ${error.message} The terminal is still running.`);
        }
    }
    killButton.addEventListener('click', () => {
        if (!closed && terminalSessionId && window.confirm('Kill this terminal and its running processes?')) {
            void killSession({ refreshProof: true });
        }
    });

    // Mints a fresh single-use attach token for a known terminal and attaches
    // with it, which creates a new server view. An explicit recovery names the
    // view it replaces, so that view's earlier close signal no longer counts.
    async function attachExisting(id, supersedes) {
        const minted = await refreshingMutation(`/webtty/live-sessions/${encodeURIComponent(id)}/attach-tokens`,
            CLAIM_PATTERN.test(String(supersedes || '')) ? { supersedes } : {});
        if (!/^[A-Za-z0-9_-]{32}$/.test(String(minted?.attach || ''))) throw new Error('The terminal response was invalid.');
        return refreshingMutation('/webtty/attachments', { attach: minted.attach, ...boundedDimensions() });
    }

    function showReopen() {
        setStatus('Reopen terminal', 'error');
        showMessage('Reopen this terminal from Live Sessions');
    }

    function showEnded() {
        forgetSession();
        setStatus('Closed', 'error');
        showMessage('This terminal has ended.');
    }

    async function useSession(result, kind) {
        const session = result?.session;
        const target = session?.target;
        if (!session || !/^[A-Za-z0-9_-]{16,128}$/.test(String(session.id || ''))) {
            throw new Error('The terminal response was invalid.');
        }
        terminalSessionId = session.id;
        if (!['owner', 'watcher'].includes(session.role)
            || !target || !['box', 'agent'].includes(target.kind)
            || typeof target.label !== 'string' || !target.label
            || !['rw', 'ro'].includes(target.access)
            || typeof target.cwdDisplay !== 'string' || !target.cwdDisplay
            || !VIEW_ID_PATTERN.test(String(result?.view?.id || ''))
            || !['keep', 'stop'].includes(session.closePolicy)) {
            if (kind === 'launch') await killSession({ keepalive: true });
            throw new Error('The terminal response was invalid.');
        }
        viewId = result.view.id;
        closePolicy = session.closePolicy;
        setRole(session.role);
        showProfile(typeof session.profileLabel === 'string' ? session.profileLabel : '');
        targetElement.textContent = `${target.label}${target.detail ? ` — ${target.detail}` : ''}`;
        accessElement.textContent = target.access === 'ro' ? 'Read only folder mapping' : 'Read and write folder mapping';
        accessElement.className = `access-badge access-${target.access}`;
        directoryElement.textContent = target.cwdDisplay;
        killButton.disabled = false;
        rememberSession();
        announceView();
        attachStream();
        terminal.focus();
    }

    async function reattach(id, supersedes) {
        let result;
        try {
            result = await attachExisting(id, supersedes);
        } catch (error) {
            disposeLocal();
            if (error.status === 404) showEnded();
            else showReopen();
            return;
        }
        // Unload never kills, even if the response arrives after pagehide.
        if (closed) return;
        await useSession(result, 'attach');
    }

    async function start() {
        if (!handoff) {
            // A top-level reload re-attaches to the remembered terminal and
            // supersedes the view it remembers.
            let stored = null;
            if (!embedded) {
                try {
                    stored = storedSession();
                } catch (_) {
                    forgetSession();
                    stored = null;
                }
            }
            if (!stored) {
                showReopen();
                return;
            }
            setStatus('Attaching terminal…');
            fit();
            await reattach(stored.sessionId, stored.viewId);
            return;
        }
        const { kind, value } = handoff;
        handoff = null;
        setStatus(kind === 'attach' ? 'Attaching terminal…' : 'Creating terminal…');
        fit();
        const body = kind === 'attach'
            ? { attach: value, ...boundedDimensions() }
            : { launch: value, ...boundedDimensions(), closePolicy: 'keep' };
        const result = await jsonRequest(kind === 'attach' ? '/webtty/attachments' : '/webtty/sessions', {
            method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body),
        });
        // Unload never kills, even if the response arrives after pagehide.
        if (closed) return;
        await useSession(result, kind);
    }

    // A best-effort signal bound to this document's view. Closing, reloading
    // or leaving the tab always keeps the shell running, whatever policy the
    // session stores, so the signal only ends this view. A lost or refused
    // request stops nothing; embedded pages leave the signal to their parent.
    function sendCloseIntent() {
        if (embedded || role !== 'owner' || !terminalSessionId || !viewId
            || shellExited || deletionStarted || intentSentForView === viewId) return;
        intentSentForView = viewId;
        try {
            Promise.resolve(fetch(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/close-intents`, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                keepalive: true,
                headers: mutationHeaders(),
                body: JSON.stringify({ view: viewId, policy: 'keep' }),
            })).catch(() => {});
        } catch (_) {}
    }

    window.addEventListener('pagehide', () => {
        sendCloseIntent();
        disposeLocal();
    });

    // A page restored from the back/forward cache attaches again with a fresh
    // token, which creates a new view and supersedes its earlier signal.
    window.addEventListener('pageshow', (event) => {
        if (event?.persisted !== true || !terminalSessionId || shellExited || deletionStarted) return;
        closed = false;
        inputStopped = false;
        reconnectSince = null;
        reconnectDelay = 1000;
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
        messageElement.hidden = true;
        setStatus('Attaching terminal…');
        // The restored page supersedes its own previous view.
        reattach(terminalSessionId, viewId).catch((error) => {
            disposeLocal();
            setStatus('Unavailable', 'error');
            showMessage(error.message);
        });
    });
    start().catch((error) => {
        disposeLocal();
        setStatus('Unavailable', 'error');
        showMessage(error.message);
    });
})();
