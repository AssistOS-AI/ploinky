(() => {
  'use strict';

  const MAX_PENDING_INPUT_BYTES = 64 * 1024;
  const MAX_INPUT_REQUEST_BYTES = 8 * 1024;
  const INPUT_FLUSH_MS = 20;
  const RESIZE_FLUSH_MS = 100;
  const MIN_COLUMNS = 2;
  const MAX_COLUMNS = 1024;
  const MIN_ROWS = 2;
  const MAX_ROWS = 512;
  const encoder = new TextEncoder();

  function consumeLaunchFragment() {
    try {
      const take = window.__ploinkyTakeWebttyLaunch;
      return typeof take === 'function' ? take() : '';
    } catch (_) { }
    return '';
  }

  const launch = consumeLaunchFragment();
  const directoryElement = document.getElementById('directory');
  const targetElement = document.getElementById('target');
  const accessElement = document.getElementById('access');
  const statusElement = document.getElementById('status');
  const statusDot = document.getElementById('status-dot');
  const dimensionsElement = document.getElementById('dimensions');
  const messageElement = document.getElementById('message');
  const terminalElement = document.getElementById('terminal');

  directoryElement.textContent = 'Not selected';
  targetElement.textContent = 'Not selected';
  accessElement.textContent = '';

  let terminalSessionId = '';
  let eventSource = null;
  let closed = false;
  let deletionStarted = false;
  let inputQueue = '';
  let inputQueueBytes = 0;
  let inputTimer = null;
  let inputChain = Promise.resolve();
  let resizeTimer = null;

  function csrfToken() {
    for (const part of document.cookie.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      if (part.slice(0, separator).trim() === 'ploinky_browser_csrf') {
        return part.slice(separator + 1).trim();
      }
    }
    return '';
  }

  function mutationHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Ploinky-Browser-CSRF-Token': csrfToken(),
    };
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
    if (status === 400) return 'The requested workspace directory is invalid.';
    if (status === 401) return 'Your authentication session has expired.';
    if (status === 403) return 'Administrator access is required.';
    if (status === 404) return 'This terminal launch is missing, invalid, expired, or already used. Return to Explorer and choose a terminal target again.';
    if (status === 409) return 'This terminal target changed. Close this tab and choose again from Explorer.';
    if (status === 429) return 'Terminal capacity has been reached. Close another terminal and retry.';
    if (status === 503) return 'The terminal runtime is temporarily unavailable.';
    return fallback;
  }

  async function jsonRequest(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
    let body = null;
    try { body = await response.json(); } catch (_) { }
    if (!response.ok) {
      const error = new Error(friendlyFailure(response.status, 'The terminal request failed.'));
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  const terminal = new window.Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    scrollback: 2000,
    theme: { background: '#0b0f14', foreground: '#e6edf3', cursor: '#e6edf3' },
  });
  const fitAddon = new window.FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalElement);
  fitAddon.fit();

  function fit() {
    try { fitAddon.fit(); } catch (_) { }
    const dimensions = boundedDimensions();
    dimensionsElement.textContent = `${dimensions.cols} × ${dimensions.rows}`;
  }

  function boundedDimensions() {
    return {
      cols: Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Number.isSafeInteger(terminal.cols) ? terminal.cols : 80)),
      rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, Number.isSafeInteger(terminal.rows) ? terminal.rows : 24)),
    };
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
    inputTimer = null;
    while (inputQueue && terminalSessionId && !closed) {
      const [data, rest] = takeUtf8Chunk(inputQueue, MAX_INPUT_REQUEST_BYTES);
      inputQueue = rest;
      inputQueueBytes = encoder.encode(rest).length;
      await jsonRequest(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/input`, {
        method: 'POST',
        headers: mutationHeaders(),
        body: JSON.stringify({ data }),
      });
    }
  }

  terminal.onData((data) => {
    if (closed || !terminalSessionId) return;
    const nextBytes = inputQueueBytes + encoder.encode(data).length;
    if (nextBytes > MAX_PENDING_INPUT_BYTES) {
      showMessage('Input was stopped because the browser input queue reached its safety limit.');
      void closeTerminal();
      return;
    }
    inputQueue += data;
    inputQueueBytes = nextBytes;
    if (!inputTimer) {
      inputTimer = window.setTimeout(() => {
        inputChain = inputChain.then(flushInput).catch((error) => {
          showMessage(error.message);
          void closeTerminal();
        });
      }, INPUT_FLUSH_MS);
    }
  });

  async function sendResize() {
    resizeTimer = null;
    fit();
    if (!terminalSessionId || closed) return;
    const dimensions = boundedDimensions();
    try {
      await jsonRequest(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/resize`, {
        method: 'POST',
        headers: mutationHeaders(),
        body: JSON.stringify(dimensions),
      });
    } catch (error) {
      showMessage(error.message);
    }
  }

  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(sendResize, RESIZE_FLUSH_MS);
  });

  function attachStream() {
    eventSource = new EventSource(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}/stream`);
    eventSource.addEventListener('open', () => setStatus('Connected', 'connected'));
    eventSource.addEventListener('output', (event) => {
      try { terminal.write(JSON.parse(event.data).data); } catch (_) { }
    });
    eventSource.addEventListener('reset', () => {
      showMessage('Terminal output replay is no longer available. Open a new terminal.');
      void closeTerminal();
    });
    eventSource.addEventListener('exit', (event) => {
      let reason = 'Terminal exited.';
      try { reason = `Terminal closed: ${JSON.parse(event.data).reason || 'exited'}.`; } catch (_) { }
      setStatus('Closed', 'error');
      showMessage(reason);
      closed = true;
      eventSource?.close();
    });
    eventSource.addEventListener('error', () => {
      if (!closed) setStatus('Reconnecting…');
    });
  }

  async function closeTerminal({ keepalive = false } = {}) {
    closed = true;
    eventSource?.close();
    if (!terminalSessionId || deletionStarted) return;
    deletionStarted = true;
    try {
      await fetch(`/webtty/sessions/${encodeURIComponent(terminalSessionId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        cache: 'no-store',
        keepalive,
        headers: mutationHeaders(),
      });
    } catch (_) { }
  }

  async function start() {
    if (!launch) {
      setStatus('Invalid launch', 'error');
      showMessage('This terminal launch is missing, invalid, expired, or already used. Return to Explorer and choose a terminal target again.');
      return;
    }
    setStatus('Creating terminal…');
    fit();
    const dimensions = boundedDimensions();
    const result = await jsonRequest('/webtty/sessions', {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({ launch, ...dimensions }),
    });
    const session = result?.session;
    const target = session?.target;
    if (!session || !/^[A-Za-z0-9_-]{16,128}$/.test(String(session.id || ''))) {
      throw new Error('The terminal response was invalid.');
    }
    terminalSessionId = session.id;
    if (!target || !['box', 'agent'].includes(target.kind)
      || typeof target.label !== 'string' || !target.label
      || !['rw', 'ro'].includes(target.access)
      || typeof target.cwdDisplay !== 'string' || !target.cwdDisplay) {
      await closeTerminal({ keepalive: true });
      throw new Error('The terminal response was invalid.');
    }
    if (closed) {
      await closeTerminal({ keepalive: true });
      return;
    }
    targetElement.textContent = `${target.label}${target.detail ? ` — ${target.detail}` : ''}`;
    accessElement.textContent = target.access === 'ro' ? 'Read only folder mapping' : 'Read and write folder mapping';
    accessElement.className = `access-badge access-${target.access}`;
    directoryElement.textContent = target.cwdDisplay;
    attachStream();
    terminal.focus();
  }

  window.addEventListener('pagehide', () => { void closeTerminal({ keepalive: true }); });
  start().catch(async (error) => {
    await closeTerminal({ keepalive: true });
    setStatus('Unavailable', 'error');
    showMessage(error.message);
  });
})();
