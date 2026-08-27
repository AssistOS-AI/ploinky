import crypto from 'node:crypto';

export const AGENT_STARTUP_PROBE_HEADER = 'X-Ploinky-Agent-Startup-Probe';
export const AGENT_STARTUP_PROBE_HEADER_LOWERCASE = AGENT_STARTUP_PROBE_HEADER.toLowerCase();
export const AGENT_STARTUP_PROBE_HEADER_VALUE = '1';
export const AGENT_STARTUP_POLL_INTERVAL_MS = 1000;
export const AGENT_STARTUP_STABLE_WINDOW_MS = 2500;

const EDGE_GENERATION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const AGENT_ROOT_PLAN_KINDS = new Set(['agent-root', 'agent-root-pending']);
const NON_HTTP_SURFACES = new Set([
    'agent-mcp',
    'agent-port-convention',
    'delegated-agent',
    'private-operation',
    'router-surface',
]);

export const AGENT_STARTUP_BROWSER_COPY = Object.freeze({
    starting: Object.freeze({
        state: 'starting',
        title: 'Starting agent',
        message: 'The agent is starting. This page will open automatically when it is ready.',
    }),
    startup_failed: Object.freeze({
        state: 'failed',
        code: 'startup_failed',
        title: 'Agent startup failed',
        message: 'Agent startup failed. Retry or contact an administrator.',
    }),
    startup_timed_out: Object.freeze({
        state: 'failed',
        code: 'startup_timed_out',
        title: 'Agent startup failed',
        message: 'Agent startup failed. Retry or contact an administrator.',
    }),
    route_unavailable: Object.freeze({
        state: 'unavailable',
        code: 'route_unavailable',
        title: 'Web page unavailable',
        message: 'This agent does not provide a web page.',
    }),
    edge_generation_changed: Object.freeze({
        state: 'retry',
        code: 'edge_generation_changed',
    }),
});

function headerEntry(req, name) {
    const headers = req?.headers;
    if (!headers) return { present: false, value: undefined };
    if (typeof headers.get === 'function') {
        const value = headers.get(name);
        return value === null || value === undefined
            ? { present: false, value: undefined }
            : { present: true, value };
    }
    const expected = String(name || '').toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === expected) return { present: true, value };
    }
    return { present: false, value: undefined };
}

function joinedHeaderValue(value) {
    if (Array.isArray(value)) return value.join(',');
    return typeof value === 'string' ? value : '';
}

export function acceptsAgentStartupHtml(req) {
    const accept = headerEntry(req, 'accept');
    if (!accept.present) return false;
    return joinedHeaderValue(accept.value).split(',').some((entry) => {
        const [rawMediaType, ...rawParameters] = entry.split(';');
        if (rawMediaType.trim().toLowerCase() !== 'text/html') return false;
        let quality = 1;
        for (const rawParameter of rawParameters) {
            const separator = rawParameter.indexOf('=');
            if (separator < 0) continue;
            const key = rawParameter.slice(0, separator).trim().toLowerCase();
            if (key !== 'q') continue;
            const rawQuality = rawParameter.slice(separator + 1).trim();
            if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(rawQuality)) return false;
            quality = Number(rawQuality);
        }
        return quality > 0;
    });
}

export function hasAgentStartupNavigationMetadata(req) {
    const destination = headerEntry(req, 'sec-fetch-dest');
    const mode = headerEntry(req, 'sec-fetch-mode');
    if (!destination.present && !mode.present) return true;
    if (!destination.present || !mode.present) return false;
    return joinedHeaderValue(destination.value).trim().toLowerCase() === 'document'
        && joinedHeaderValue(mode.value).trim().toLowerCase() === 'navigate';
}

function pathWithoutQuery(value) {
    const path = String(value || '');
    const query = path.indexOf('?');
    return query < 0 ? path : path.slice(0, query);
}

function decodedSegments(value) {
    const segments = pathWithoutQuery(value).split('/').filter(Boolean);
    try {
        return segments.map((segment) => decodeURIComponent(segment));
    } catch (_) {
        return null;
    }
}

function isMcpPath(value) {
    const pathname = pathWithoutQuery(value);
    return pathname === '/mcp' || pathname.startsWith('/mcp/');
}

function hasInternalAgentSegment(value) {
    const segments = decodedSegments(value);
    return !segments || segments.includes('__agent');
}

function hasBearerAuthorization(req) {
    const authorization = headerEntry(req, 'authorization');
    if (!authorization.present || Array.isArray(authorization.value)) return false;
    return /^bearer(?:\s|$)/i.test(String(authorization.value));
}

export function isOrdinaryAgentStartupRoute(req, routePlan, { isOrdinaryAgentHttp = true } = {}) {
    if (isOrdinaryAgentHttp !== true
        || !routePlan?.ok
        || !AGENT_ROOT_PLAN_KINDS.has(routePlan.kind)
        || routePlan.transport === 'websocket') return false;
    const surface = String(
        routePlan.surface?.name
        || routePlan.surface
        || routePlan.surfaceKind
        || '',
    ).trim().toLowerCase();
    if (NON_HTTP_SURFACES.has(surface)) return false;
    if (isMcpPath(routePlan.upstreamPath) || isMcpPath(routePlan.pathname)) return false;
    if (hasInternalAgentSegment(routePlan.upstreamPath)
        || hasInternalAgentSegment(routePlan.canonicalPath)
        || hasInternalAgentSegment(routePlan.pathname)) return false;
    if (hasBearerAuthorization(req)) return false;
    return true;
}

export function classifyAgentStartupRequest(req, {
    routePlan,
    isOrdinaryAgentHttp = true,
    canPublishHttp = false,
} = {}) {
    if (req?.method !== 'GET') return null;
    if (!isOrdinaryAgentStartupRoute(req, routePlan, { isOrdinaryAgentHttp })) return null;

    const probe = headerEntry(req, AGENT_STARTUP_PROBE_HEADER);
    if (probe.present) {
        return !Array.isArray(probe.value)
            && String(probe.value) === AGENT_STARTUP_PROBE_HEADER_VALUE
            ? 'probe'
            : null;
    }

    if (routePlan.kind !== 'agent-root-pending'
        || canPublishHttp !== true
        || !acceptsAgentStartupHtml(req)
        || !hasAgentStartupNavigationMetadata(req)) return null;
    return 'navigation';
}

export function isAgentStartupNavigationRequest(req, options = {}) {
    return classifyAgentStartupRequest(req, options) === 'navigation';
}

export function isAgentStartupProbeRequest(req, options = {}) {
    return classifyAgentStartupRequest(req, options) === 'probe';
}

export function agentStartupBrowserPresentation(state, code = '') {
    if (state === 'starting') return AGENT_STARTUP_BROWSER_COPY.starting;
    if (state === 'failed' && (code === 'startup_failed' || code === 'startup_timed_out')) {
        return AGENT_STARTUP_BROWSER_COPY[code];
    }
    if (state === 'unavailable' && code === 'route_unavailable') {
        return AGENT_STARTUP_BROWSER_COPY.route_unavailable;
    }
    if (state === 'retry' && code === 'edge_generation_changed') {
        return AGENT_STARTUP_BROWSER_COPY.edge_generation_changed;
    }
    return null;
}

function requireOpaqueEdgeGeneration(generation) {
    const value = String(generation || '');
    if (!EDGE_GENERATION_PATTERN.test(value)) {
        throw new TypeError('agent startup responses require an opaque edge generation');
    }
    return value;
}

function responseWithBody(kind, statusCode, headers, body) {
    const bodyBytes = Buffer.byteLength(body);
    return Object.freeze({
        kind,
        statusCode,
        headers: Object.freeze({
            ...headers,
            'Content-Length': String(bodyBytes),
        }),
        body,
    });
}

export function buildAgentStartupProbeResponse({ state, generation = '', code = '' } = {}) {
    let statusCode;
    let payload;
    if (state === 'starting') {
        statusCode = 202;
        payload = {
            state: 'starting',
            generation: requireOpaqueEdgeGeneration(generation),
            retryAfterMs: AGENT_STARTUP_POLL_INTERVAL_MS,
        };
    } else if (state === 'ready') {
        statusCode = 200;
        payload = {
            state: 'ready',
            generation: requireOpaqueEdgeGeneration(generation),
        };
    } else {
        const presentation = agentStartupBrowserPresentation(state, code);
        if (!presentation) throw new TypeError('unsupported agent startup browser response');
        statusCode = 503;
        payload = presentation.state === 'retry'
            ? { state: 'retry', code: presentation.code }
            : {
                state: presentation.state,
                code: presentation.code,
                message: presentation.message,
            };
    }
    return responseWithBody('probe', statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
    }, JSON.stringify(payload));
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function safeRouteLabel(value) {
    const withoutControls = String(value || '')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .trim();
    return Array.from(withoutControls).slice(0, 128).join('');
}

function createCspNonce() {
    return crypto.randomBytes(24).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

/**
 * Pure client transition state. The function is also serialized into the
 * self-contained page, so it intentionally has no module-scope dependencies.
 */
export function createAgentStartupSettlingState({
    terminalState = '',
    terminalCode = '',
} = {}) {
    const safeTerminalState = terminalState === 'failed' || terminalState === 'unavailable'
        ? terminalState
        : '';
    const safeTerminalCode = safeTerminalState === 'failed'
        && (terminalCode === 'startup_failed' || terminalCode === 'startup_timed_out')
        ? terminalCode
        : safeTerminalState === 'unavailable'
            ? 'route_unavailable'
            : '';
    return Object.freeze({
        candidateGeneration: '',
        candidateSinceMs: null,
        terminalState: safeTerminalCode ? safeTerminalState : '',
        terminalCode: safeTerminalCode,
        reloadRequested: false,
    });
}

/**
 * Reduce one trusted protocol observation into a browser action. `nowMs` must
 * come from a monotonic clock. Candidate readiness never survives a transient
 * state, network failure, terminal state, invalid/auth response, clock rewind,
 * or generation change.
 */
export function reduceAgentStartupSettling(
    current,
    event,
    nowMs,
    stableWindowMs = 2500,
) {
    const previous = current && typeof current === 'object' ? current : {};
    const state = {
        candidateGeneration: typeof previous.candidateGeneration === 'string'
            ? previous.candidateGeneration
            : '',
        candidateSinceMs: Number.isFinite(previous.candidateSinceMs)
            ? previous.candidateSinceMs
            : null,
        terminalState: previous.terminalState === 'failed' || previous.terminalState === 'unavailable'
            ? previous.terminalState
            : '',
        terminalCode: typeof previous.terminalCode === 'string' ? previous.terminalCode : '',
        reloadRequested: previous.reloadRequested === true,
    };
    const freezeResult = (action) => Object.freeze({
        state: Object.freeze({ ...state }),
        action,
    });
    const clearCandidate = () => {
        state.candidateGeneration = '';
        state.candidateSinceMs = null;
    };
    const clearTerminal = () => {
        state.terminalState = '';
        state.terminalCode = '';
    };

    if (state.reloadRequested) return freezeResult('none');
    const type = String(event?.type || '');
    if (type === 'retry-click') {
        clearCandidate();
        clearTerminal();
        return freezeResult('poll');
    }
    if (type === 'auth-response' || type === 'invalid-response') {
        clearCandidate();
        clearTerminal();
        state.reloadRequested = true;
        return freezeResult('reload');
    }
    if (type === 'starting' || type === 'retry' || type === 'network-error') {
        clearCandidate();
        clearTerminal();
        return freezeResult('poll');
    }
    if (type === 'failed') {
        clearCandidate();
        state.terminalState = 'failed';
        state.terminalCode = event?.code === 'startup_timed_out'
            ? 'startup_timed_out'
            : 'startup_failed';
        return freezeResult('stop');
    }
    if (type === 'unavailable') {
        clearCandidate();
        state.terminalState = 'unavailable';
        state.terminalCode = 'route_unavailable';
        return freezeResult('stop');
    }
    if (type === 'ready') {
        clearTerminal();
        const generation = typeof event?.generation === 'string' ? event.generation : '';
        const observedAt = Number(nowMs);
        const settlingWindow = Number(stableWindowMs);
        if (!generation || !Number.isFinite(observedAt)
            || !Number.isFinite(settlingWindow) || settlingWindow < 0) {
            clearCandidate();
            state.reloadRequested = true;
            return freezeResult('reload');
        }
        if (state.candidateGeneration !== generation
            || !Number.isFinite(state.candidateSinceMs)
            || observedAt < state.candidateSinceMs) {
            state.candidateGeneration = generation;
            state.candidateSinceMs = observedAt;
            return freezeResult('poll');
        }
        if (observedAt - state.candidateSinceMs >= settlingWindow) {
            state.reloadRequested = true;
            return freezeResult('reload');
        }
        return freezeResult('poll');
    }

    clearCandidate();
    clearTerminal();
    state.reloadRequested = true;
    return freezeResult('reload');
}

function browserScript({ initialState, initialCode }) {
    const createStateSource = createAgentStartupSettlingState.toString();
    const reduceStateSource = reduceAgentStartupSettling.toString();
    return `(() => {
      'use strict';
      const PROBE_HEADER = ${JSON.stringify(AGENT_STARTUP_PROBE_HEADER)};
      const PROBE_VALUE = ${JSON.stringify(AGENT_STARTUP_PROBE_HEADER_VALUE)};
      const POLL_INTERVAL_MS = ${AGENT_STARTUP_POLL_INTERVAL_MS};
      const STABLE_WINDOW_MS = ${AGENT_STARTUP_STABLE_WINDOW_MS};
      const EDGE_GENERATION = /^sha256:[a-f0-9]{64}$/;
      const createSettlingState = (${createStateSource});
      const reduceSettling = (${reduceStateSource});
      const copy = Object.freeze({
        starting: Object.freeze(${JSON.stringify(AGENT_STARTUP_BROWSER_COPY.starting)}),
        failed: Object.freeze(${JSON.stringify(AGENT_STARTUP_BROWSER_COPY.startup_failed)}),
        unavailable: Object.freeze(${JSON.stringify(AGENT_STARTUP_BROWSER_COPY.route_unavailable)})
      });
      const root = document.getElementById('agent-startup-root');
      const title = document.getElementById('agent-startup-title');
      const message = document.getElementById('agent-startup-message');
      const spinner = document.getElementById('agent-startup-spinner');
      const retry = document.getElementById('agent-startup-retry');
      if (!root || !title || !message || !spinner || !retry) return;

      let settling = createSettlingState({
        terminalState: ${JSON.stringify(initialState === 'starting' ? '' : initialState)},
        terminalCode: ${JSON.stringify(initialCode)}
      });
      let timer = null;
      let inFlight = false;
      let stopped = Boolean(settling.terminalState);

      const showStarting = () => {
        root.setAttribute('data-ploinky-agent-startup-page', 'starting');
        title.textContent = copy.starting.title;
        message.textContent = copy.starting.message;
        spinner.hidden = false;
        retry.hidden = true;
      };
      const showTerminal = (terminalState) => {
        const presentation = terminalState === 'unavailable' ? copy.unavailable : copy.failed;
        root.setAttribute('data-ploinky-agent-startup-page', presentation.state);
        title.textContent = presentation.title;
        message.textContent = presentation.message;
        spinner.hidden = true;
        retry.hidden = false;
        retry.focus();
      };
      const schedulePoll = (delay = POLL_INTERVAL_MS) => {
        if (stopped || settling.reloadRequested || inFlight) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          void poll();
        }, delay);
      };
      const eventForResponse = async (response) => {
        const contentType = String(response?.headers?.get?.('content-type') || '')
          .split(';', 1)[0]
          .trim()
          .toLowerCase();
        if (response?.redirected || contentType !== 'application/json') {
          return { type: 'auth-response' };
        }
        let payload;
        try {
          payload = await response.json();
        } catch (_) {
          return { type: 'invalid-response' };
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          return { type: 'invalid-response' };
        }
        if (response.status === 202 && payload.state === 'starting'
          && payload.retryAfterMs === POLL_INTERVAL_MS
          && EDGE_GENERATION.test(String(payload.generation || ''))) {
          return { type: 'starting' };
        }
        if (response.status === 200 && payload.state === 'ready'
          && EDGE_GENERATION.test(String(payload.generation || ''))) {
          return { type: 'ready', generation: payload.generation };
        }
        if (response.status === 503 && payload.state === 'retry'
          && payload.code === 'edge_generation_changed') {
          return { type: 'retry' };
        }
        if (response.status === 503 && payload.state === 'failed'
          && (payload.code === 'startup_failed' || payload.code === 'startup_timed_out')) {
          return { type: 'failed', code: payload.code };
        }
        if (response.status === 503 && payload.state === 'unavailable'
          && payload.code === 'route_unavailable') {
          return { type: 'unavailable', code: payload.code };
        }
        return { type: 'invalid-response' };
      };
      const applyEvent = (event) => {
        const result = reduceSettling(settling, event, performance.now(), STABLE_WINDOW_MS);
        settling = result.state;
        if (result.action === 'reload') {
          stopped = true;
          window.location.reload();
          return;
        }
        if (result.action === 'stop') {
          stopped = true;
          showTerminal(settling.terminalState);
          return;
        }
        if (result.action === 'poll') {
          showStarting();
          schedulePoll();
        }
      };
      async function poll() {
        if (stopped || settling.reloadRequested || inFlight) return;
        inFlight = true;
        let event;
        try {
          const response = await fetch(window.location.href, {
            method: 'GET',
            headers: {
              [PROBE_HEADER]: PROBE_VALUE,
              'Accept': 'application/json'
            },
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'follow'
          });
          event = await eventForResponse(response);
        } catch (_) {
          event = { type: 'network-error' };
        } finally {
          inFlight = false;
        }
        applyEvent(event);
      }
      retry.addEventListener('click', () => {
        const result = reduceSettling(settling, { type: 'retry-click' }, performance.now(), STABLE_WINDOW_MS);
        settling = result.state;
        stopped = false;
        showStarting();
        schedulePoll(0);
      });

      if (stopped) showTerminal(settling.terminalState);
      else {
        showStarting();
        schedulePoll();
      }
    })();`;
}

export function renderAgentStartupPage({
    state = 'starting',
    code = '',
    routeLabel = '',
    nonce = createCspNonce(),
} = {}) {
    const presentation = agentStartupBrowserPresentation(state, code);
    if (!presentation || presentation.state === 'retry') {
        throw new TypeError('unsupported agent startup page state');
    }
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(nonce)) {
        throw new TypeError('invalid agent startup page CSP nonce');
    }
    const label = safeRouteLabel(routeLabel);
    const safeLabel = escapeHtml(label);
    const safeTitle = escapeHtml(presentation.title);
    const safeMessage = escapeHtml(presentation.message);
    const terminal = presentation.state !== 'starting';
    const script = browserScript({
        initialState: presentation.state,
        initialCode: presentation.code || '',
    });
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: #f4f7fb; color: #18212f; }
    .card { width: min(100%, 520px); padding: 36px; border: 1px solid #dbe3ee; border-radius: 20px; background: #fff; box-shadow: 0 20px 60px rgba(24, 33, 47, .12); text-align: center; }
    .spinner { width: 34px; height: 34px; margin: 0 auto 24px; border: 4px solid #dbe3ee; border-top-color: #2563eb; border-radius: 50%; animation: agent-startup-spin .9s linear infinite; }
    h1 { margin: 0 0 12px; font-size: clamp(1.55rem, 5vw, 2rem); line-height: 1.2; }
    p { margin: 0; color: #526173; line-height: 1.6; }
    .route-label { margin-top: 14px; overflow-wrap: anywhere; font-size: .9rem; }
    button { margin-top: 24px; min-height: 44px; padding: 10px 20px; border: 0; border-radius: 10px; background: #2563eb; color: #fff; font: inherit; font-weight: 700; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 3px; }
    [hidden] { display: none !important; }
    @keyframes agent-startup-spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #f3f4f6; }
      .card { border-color: #374151; background: #1f2937; box-shadow: none; }
      .spinner { border-color: #4b5563; border-top-color: #93c5fd; }
      p { color: #cbd5e1; }
    }
  </style>
</head>
<body>
  <main id="agent-startup-root" class="card" data-ploinky-agent-startup-page="${presentation.state}">
    <div id="agent-startup-spinner" class="spinner" aria-hidden="true"${terminal ? ' hidden' : ''}></div>
    <div role="status" aria-live="polite" aria-atomic="true">
      <h1 id="agent-startup-title">${safeTitle}</h1>
      <p id="agent-startup-message">${safeMessage}</p>
      ${label ? `<p class="route-label">Opening <strong>${safeLabel}</strong></p>` : ''}
    </div>
    <button id="agent-startup-retry" type="button"${terminal ? '' : ' hidden'}>Retry</button>
  </main>
  <script nonce="${nonce}">
    ${script}
  </script>
</body>
</html>`;
}

export function buildAgentStartupDocumentResponse(options = {}) {
    const nonce = createCspNonce();
    const body = renderAgentStartupPage({ ...options, nonce });
    return responseWithBody('document', 503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Retry-After': String(AGENT_STARTUP_POLL_INTERVAL_MS / 1000),
        'Content-Security-Policy': `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'none'; font-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cross-Origin-Resource-Policy': 'same-origin',
    }, body);
}

export const createAgentStartupProbeResponse = buildAgentStartupProbeResponse;
export const createAgentStartupDocumentResponse = buildAgentStartupDocumentResponse;

export function writeAgentStartupResponse(res, response, { method = 'GET' } = {}) {
    if (!res || typeof res.writeHead !== 'function' || typeof res.end !== 'function') {
        throw new TypeError('a writable HTTP response is required');
    }
    if (!response || !Number.isInteger(response.statusCode)
        || !response.headers || typeof response.body !== 'string') {
        throw new TypeError('a valid agent startup response is required');
    }
    res.writeHead(response.statusCode, response.headers);
    if (method === 'HEAD') res.end();
    else res.end(response.body);
}

export default {
    AGENT_STARTUP_BROWSER_COPY,
    AGENT_STARTUP_POLL_INTERVAL_MS,
    AGENT_STARTUP_PROBE_HEADER,
    AGENT_STARTUP_PROBE_HEADER_LOWERCASE,
    AGENT_STARTUP_PROBE_HEADER_VALUE,
    AGENT_STARTUP_STABLE_WINDOW_MS,
    acceptsAgentStartupHtml,
    agentStartupBrowserPresentation,
    buildAgentStartupDocumentResponse,
    buildAgentStartupProbeResponse,
    classifyAgentStartupRequest,
    createAgentStartupDocumentResponse,
    createAgentStartupProbeResponse,
    createAgentStartupSettlingState,
    hasAgentStartupNavigationMetadata,
    isAgentStartupNavigationRequest,
    isAgentStartupProbeRequest,
    isOrdinaryAgentStartupRoute,
    reduceAgentStartupSettling,
    renderAgentStartupPage,
    writeAgentStartupResponse,
};
