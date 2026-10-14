(() => {
    'use strict';

    const MAX_PENDING_INPUT_BYTES = 64 * 1024;
    const MAX_INPUT_REQUEST_BYTES = 8 * 1024;
    const INPUT_FLUSH_MS = 20;
    const RESIZE_FLUSH_MS = 100;
    const RECONNECT_LIMIT_MS = 10 * 60_000;
    const encoder = new TextEncoder();
    let handoff = null;
    try { handoff = window.__ploinkyTakeWebttyHandoff?.() || null; } catch (_) {}

    const directoryElement = document.getElementById('directory');
    const targetElement = document.getElementById('target');
    const accessElement = document.getElementById('access');
    const roleElement = document.getElementById('role');
    const killButton = document.getElementById('kill');
    const statusElement = document.getElementById('status');
    const statusDot = document.getElementById('status-dot');
    const dimensionsElement = document.getElementById('dimensions');
    const messageElement = document.getElementById('message');
    const terminalElement = document.getElementById('terminal');
    if (window.top !== window) document.body.classList.add('embedded');

    let terminalSessionId = '';
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

    async function inputMutation(url, body) {
        const options = { method: 'POST', headers: mutationHeaders(), body: JSON.stringify(body) };
        try {
            return await jsonRequest(url, options);
        } catch (error) {
            if (error.status !== 403 || error.body?.error !== 'browser_csrf_invalid') throw error;
            await jsonRequest('/webtty/live-sessions');
            if (closed || inputStopped || role !== 'owner') return;
            // Refresh once, then propagate any second refusal without another retry.
            return jsonRequest(url, options);
        }
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
        const source = new EventSource(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/stream`);
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

    async function start() {
        if (!handoff) {
            setStatus('Reopen terminal', 'error');
            showMessage('Reopen this terminal from Live Sessions');
            return;
        }
        const { kind, value } = handoff;
        handoff = null;
        setStatus(kind === 'attach' ? 'Attaching terminal…' : 'Creating terminal…');
        fit();
        const result = await jsonRequest(kind === 'attach' ? '/webtty/attachments' : '/webtty/sessions', {
            method: 'POST', headers: mutationHeaders(), body: JSON.stringify({ [kind]: value, ...boundedDimensions() }),
        });
        // Unload never kills, even if the response arrives after pagehide.
        if (closed) return;
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
            || typeof target.cwdDisplay !== 'string' || !target.cwdDisplay) {
            if (kind === 'launch') await killSession({ keepalive: true });
            throw new Error('The terminal response was invalid.');
        }
        setRole(session.role);
        targetElement.textContent = `${target.label}${target.detail ? ` — ${target.detail}` : ''}`;
        accessElement.textContent = target.access === 'ro' ? 'Read only folder mapping' : 'Read and write folder mapping';
        accessElement.className = `access-badge access-${target.access}`;
        directoryElement.textContent = target.cwdDisplay;
        killButton.disabled = false;
        attachStream();
        terminal.focus();
    }
    window.addEventListener('pagehide', disposeLocal);
    start().catch((error) => {
        disposeLocal();
        setStatus('Unavailable', 'error');
        showMessage(error.message);
    });
})();
