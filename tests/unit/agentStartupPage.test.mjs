import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import {
    AGENT_STARTUP_BROWSER_COPY,
    AGENT_STARTUP_POLL_INTERVAL_MS,
    AGENT_STARTUP_PROBE_HEADER,
    AGENT_STARTUP_PROBE_HEADER_VALUE,
    AGENT_STARTUP_STABLE_WINDOW_MS,
    acceptsAgentStartupHtml,
    buildAgentStartupDocumentResponse,
    buildAgentStartupProbeResponse,
    classifyAgentStartupRequest,
    createAgentStartupSettlingState,
    hasAgentStartupNavigationMetadata,
    isAgentStartupNavigationRequest,
    isAgentStartupProbeRequest,
    reduceAgentStartupSettling,
    renderAgentStartupPage,
    writeAgentStartupResponse,
} from '../../cli/server/agentStartupPage.js';

const GENERATION_ONE = `sha256:${'1'.repeat(64)}`;
const GENERATION_TWO = `sha256:${'2'.repeat(64)}`;

function pendingPlan(overrides = {}) {
    return {
        ok: true,
        kind: 'agent-root-pending',
        pathname: '/sampleAgent/index.html',
        canonicalPath: '/sampleAgent/index.html',
        upstreamPath: '/index.html',
        transport: 'http',
        ...overrides,
    };
}

function request(method = 'GET', headers = {}) {
    return { method, headers };
}

function navigationRequest(headers = {}) {
    return request('GET', {
        accept: 'text/html,application/xhtml+xml;q=0.9',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        ...headers,
    });
}

test('initial navigation classification requires exact GET, pending ordinary HTTP, and publication capability', () => {
    const req = navigationRequest();
    assert.equal(classifyAgentStartupRequest(req, {
        routePlan: pendingPlan(),
        canPublishHttp: true,
    }), 'navigation');
    assert.equal(isAgentStartupNavigationRequest(req, {
        routePlan: pendingPlan(),
        canPublishHttp: true,
    }), true);

    for (const method of ['HEAD', 'POST', 'OPTIONS', 'get', '']) {
        assert.equal(classifyAgentStartupRequest({ ...req, method }, {
            routePlan: pendingPlan(),
            canPublishHttp: true,
        }), null, method);
    }
    assert.equal(classifyAgentStartupRequest(req, {
        routePlan: pendingPlan(),
        canPublishHttp: false,
    }), null);
    assert.equal(classifyAgentStartupRequest(req, {
        routePlan: pendingPlan({ kind: 'agent-root' }),
        canPublishHttp: true,
    }), null);
    assert.equal(classifyAgentStartupRequest(req, {
        routePlan: pendingPlan({ kind: 'router-surface' }),
        canPublishHttp: true,
    }), null);
    assert.equal(classifyAgentStartupRequest(req, {
        routePlan: pendingPlan(),
        isOrdinaryAgentHttp: false,
        canPublishHttp: true,
    }), null);
});

test('HTML Accept parsing is explicit and respects q=0', () => {
    for (const accept of [
        'text/html',
        'TEXT/HTML;Q=0.5',
        'application/json, text/html;level=1;q=1',
        ['application/xhtml+xml', 'text/html'],
    ]) {
        assert.equal(acceptsAgentStartupHtml(request('GET', { accept })), true, String(accept));
    }
    for (const accept of [
        undefined,
        '',
        '*/*',
        'application/xhtml+xml',
        'text/html;q=0',
        'text/html;q=bogus',
        'text/html;q=1.1',
    ]) {
        const headers = accept === undefined ? {} : { accept };
        assert.equal(acceptsAgentStartupHtml(request('GET', headers)), false, String(accept));
    }
});

test('Fetch Metadata must describe a navigation when supplied and permits the explicit-HTML legacy fallback', () => {
    assert.equal(hasAgentStartupNavigationMetadata(request('GET', {})), true);
    assert.equal(hasAgentStartupNavigationMetadata(request('GET', {
        'Sec-Fetch-Dest': 'Document',
        'SEC-FETCH-MODE': 'Navigate',
    })), true);
    for (const headers of [
        { 'sec-fetch-dest': 'document' },
        { 'sec-fetch-mode': 'navigate' },
        { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' },
        { 'sec-fetch-dest': 'script', 'sec-fetch-mode': 'no-cors' },
        { 'sec-fetch-dest': ['document', 'document'], 'sec-fetch-mode': 'navigate' },
    ]) {
        assert.equal(hasAgentStartupNavigationMetadata(request('GET', headers)), false, JSON.stringify(headers));
    }

    assert.equal(classifyAgentStartupRequest(request('GET', { accept: 'text/html' }), {
        routePlan: pendingPlan(),
        canPublishHttp: true,
    }), 'navigation');
    assert.equal(classifyAgentStartupRequest(navigationRequest({
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
    }), {
        routePlan: pendingPlan(),
        canPublishHttp: true,
    }), null);
});

test('probe classification is exact, case-insensitive by header name, and independent of publication capability', () => {
    const req = request('GET', {
        'X-Ploinky-Agent-Startup-Probe': AGENT_STARTUP_PROBE_HEADER_VALUE,
        accept: 'application/json',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
    });
    assert.equal(classifyAgentStartupRequest(req, {
        routePlan: pendingPlan(),
        canPublishHttp: false,
    }), 'probe');
    assert.equal(isAgentStartupProbeRequest(req, {
        routePlan: pendingPlan({ kind: 'agent-root' }),
        canPublishHttp: false,
    }), true);

    for (const value of ['', '0', '01', '1 ', 'true', ['1', '1']]) {
        const invalid = navigationRequest({ [AGENT_STARTUP_PROBE_HEADER]: value });
        assert.equal(classifyAgentStartupRequest(invalid, {
            routePlan: pendingPlan(),
            canPublishHttp: true,
        }), null, JSON.stringify(value));
    }
    assert.equal(classifyAgentStartupRequest({ ...req, method: 'HEAD' }, {
        routePlan: pendingPlan(),
    }), null);
});

test('MCP, internal, delegated, non-HTTP, and malformed route families never receive the protocol', () => {
    const req = navigationRequest();
    const cases = [
        pendingPlan({ upstreamPath: '/mcp' }),
        pendingPlan({ upstreamPath: '/mcp/tools' }),
        pendingPlan({ pathname: '/mcp' }),
        pendingPlan({ surface: 'agent-mcp' }),
        pendingPlan({ surfaceKind: 'router-surface' }),
        pendingPlan({ transport: 'websocket' }),
        pendingPlan({ upstreamPath: '/__agent/share' }),
        pendingPlan({ upstreamPath: '/%5f%5fagent/share' }),
        pendingPlan({ upstreamPath: '/%zz' }),
    ];
    for (const routePlan of cases) {
        assert.equal(classifyAgentStartupRequest(req, {
            routePlan,
            canPublishHttp: true,
        }), null, JSON.stringify(routePlan));
    }
    assert.equal(classifyAgentStartupRequest(navigationRequest({
        authorization: 'Bearer delegated-assertion',
    }), {
        routePlan: pendingPlan(),
        canPublishHttp: true,
    }), null);
});

test('probe response schemas, statuses, and security headers are fixed', () => {
    const cases = [
        [{ state: 'starting', generation: GENERATION_ONE }, 202, {
            state: 'starting',
            generation: GENERATION_ONE,
            retryAfterMs: AGENT_STARTUP_POLL_INTERVAL_MS,
        }],
        [{ state: 'ready', generation: GENERATION_TWO }, 200, {
            state: 'ready',
            generation: GENERATION_TWO,
        }],
        [{ state: 'failed', code: 'startup_failed' }, 503, {
            state: 'failed',
            code: 'startup_failed',
            message: AGENT_STARTUP_BROWSER_COPY.startup_failed.message,
        }],
        [{ state: 'failed', code: 'startup_timed_out' }, 503, {
            state: 'failed',
            code: 'startup_timed_out',
            message: AGENT_STARTUP_BROWSER_COPY.startup_timed_out.message,
        }],
        [{ state: 'unavailable', code: 'route_unavailable' }, 503, {
            state: 'unavailable',
            code: 'route_unavailable',
            message: AGENT_STARTUP_BROWSER_COPY.route_unavailable.message,
        }],
        [{ state: 'retry', code: 'edge_generation_changed' }, 503, {
            state: 'retry',
            code: 'edge_generation_changed',
        }],
    ];
    for (const [input, expectedStatus, expectedPayload] of cases) {
        const response = buildAgentStartupProbeResponse(input);
        assert.equal(response.kind, 'probe');
        assert.equal(response.statusCode, expectedStatus);
        assert.deepEqual(JSON.parse(response.body), expectedPayload);
        assert.equal(response.headers['Cache-Control'], 'no-store');
        assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(response.headers['Content-Length'], String(Buffer.byteLength(response.body)));
        assert.equal('Access-Control-Allow-Origin' in response.headers, false);
    }
});

test('probe response construction rejects unknown codes and non-edge generation values', () => {
    assert.throws(() => buildAgentStartupProbeResponse({
        state: 'failed',
        code: 'ENOENT: /private/path',
    }), /unsupported agent startup browser response/);
    assert.throws(() => buildAgentStartupProbeResponse({
        state: 'starting',
        generation: 'run-id-or-container-id',
    }), /opaque edge generation/);
    assert.throws(() => buildAgentStartupProbeResponse({
        state: 'unavailable',
        code: 'some_other_failure',
    }), /unsupported agent startup browser response/);
});

test('document responses use a unique nonce-bound strict CSP and no external resources', () => {
    const first = buildAgentStartupDocumentResponse({ state: 'starting', routeLabel: 'Sample agent' });
    const second = buildAgentStartupDocumentResponse({ state: 'starting', routeLabel: 'Sample agent' });
    assert.equal(first.statusCode, 503);
    assert.equal(first.headers['Cache-Control'], 'no-store, no-cache, must-revalidate');
    assert.equal(first.headers['Retry-After'], '1');
    assert.equal(first.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(first.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(first.headers['X-Frame-Options'], 'DENY');
    assert.equal(first.headers['Cross-Origin-Resource-Policy'], 'same-origin');
    assert.equal(first.headers['Content-Length'], String(Buffer.byteLength(first.body)));

    const firstNonce = first.headers['Content-Security-Policy'].match(/script-src 'nonce-([^']+)'/)?.[1];
    const secondNonce = second.headers['Content-Security-Policy'].match(/script-src 'nonce-([^']+)'/)?.[1];
    assert.ok(firstNonce);
    assert.ok(secondNonce);
    assert.notEqual(firstNonce, secondNonce);
    assert.match(first.headers['Content-Security-Policy'], /^default-src 'none';/);
    assert.match(first.headers['Content-Security-Policy'], /connect-src 'self'/);
    assert.match(first.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.doesNotMatch(first.headers['Content-Security-Policy'], /unsafe-inline|https?:/);
    assert.equal((first.body.match(new RegExp(`nonce="${firstNonce}"`, 'g')) || []).length, 2);
    assert.doesNotMatch(first.body, /<(?:link|img|iframe|object)\b/i);
    assert.doesNotMatch(first.body, /\b(?:src|href)\s*=/i);
});

test('page rendering escapes hostile route labels in text context and keeps an accessible fixed presentation', () => {
    const hostile = `</strong><script>alert(1)</script><img src=x onerror="steal()">'&`;
    const body = renderAgentStartupPage({
        state: 'starting',
        routeLabel: hostile,
        nonce: 'A'.repeat(32),
    });
    assert.match(body, /data-ploinky-agent-startup-page="starting"/);
    assert.match(body, /role="status" aria-live="polite" aria-atomic="true"/);
    assert.match(body, /<button id="agent-startup-retry" type="button" hidden>Retry<\/button>/);
    assert.match(body, /prefers-reduced-motion: reduce/);
    assert.match(body, /&lt;\/strong&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(body, /&lt;img src=x onerror=&quot;steal\(\)&quot;&gt;&#39;&amp;/);
    assert.doesNotMatch(body, /<script>alert\(1\)<\/script>|<img src=x|onerror="steal/);
});

test('terminal pages expose only allowlisted fixed copy and an operable Retry control', () => {
    for (const [input, marker, expectedMessage] of [
        [{ state: 'failed', code: 'startup_failed' }, 'failed', AGENT_STARTUP_BROWSER_COPY.startup_failed.message],
        [{ state: 'failed', code: 'startup_timed_out' }, 'failed', AGENT_STARTUP_BROWSER_COPY.startup_timed_out.message],
        [{ state: 'unavailable', code: 'route_unavailable' }, 'unavailable', AGENT_STARTUP_BROWSER_COPY.route_unavailable.message],
    ]) {
        const response = buildAgentStartupDocumentResponse({
            ...input,
            diagnostic: 'Error at /Users/operator/private.js:744 http://127.0.0.1:49152/?secret=token container=image pid=9321\nstack',
        });
        assert.match(response.body, new RegExp(`data-ploinky-agent-startup-page="${marker}"`));
        assert.match(response.body, new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(response.body, /<button id="agent-startup-retry" type="button">Retry<\/button>/);
        assert.doesNotMatch(response.body, /operator|private\.js|49152|secret=|container=image|9321|\nstack/);
    }
});

test('response writer preserves representation length while suppressing HEAD bodies', () => {
    const response = buildAgentStartupDocumentResponse({ state: 'starting' });
    function capture(method) {
        const captured = { statusCode: null, headers: null, body: undefined };
        const res = {
            writeHead(statusCode, headers) {
                captured.statusCode = statusCode;
                captured.headers = headers;
            },
            end(body) {
                captured.body = body;
            },
        };
        writeAgentStartupResponse(res, response, { method });
        return captured;
    }
    const get = capture('GET');
    const head = capture('HEAD');
    assert.equal(get.statusCode, 503);
    assert.equal(get.body, response.body);
    assert.equal(head.statusCode, 503);
    assert.equal(head.body, undefined);
    assert.equal(head.headers['Content-Length'], String(Buffer.byteLength(response.body)));
});

function transition(state, event, nowMs) {
    return reduceAgentStartupSettling(state, event, nowMs, AGENT_STARTUP_STABLE_WINDOW_MS);
}

test('settling requires the same ready generation for the complete 2500ms window and reloads once', () => {
    let state = createAgentStartupSettlingState();
    let result = transition(state, { type: 'starting' }, 0);
    state = result.state;
    assert.equal(result.action, 'poll');
    result = transition(state, { type: 'ready', generation: 'g1' }, 1000);
    state = result.state;
    assert.equal(result.action, 'poll');
    assert.equal(state.candidateSinceMs, 1000);
    result = transition(state, { type: 'ready', generation: 'g1' }, 3499);
    state = result.state;
    assert.equal(result.action, 'poll');
    result = transition(state, { type: 'ready', generation: 'g1' }, 3500);
    state = result.state;
    assert.equal(result.action, 'reload');
    assert.equal(state.reloadRequested, true);
    assert.equal(transition(state, { type: 'ready', generation: 'g1' }, 5000).action, 'none');
});

test('generation change, starting, retry, network failure, and clock rewind reset settling', () => {
    const resetEvents = [
        { type: 'starting' },
        { type: 'retry' },
        { type: 'network-error' },
    ];
    for (const resetEvent of resetEvents) {
        let state = transition(createAgentStartupSettlingState(), {
            type: 'ready', generation: 'g1',
        }, 100).state;
        const reset = transition(state, resetEvent, 200);
        assert.equal(reset.action, 'poll');
        assert.equal(reset.state.candidateGeneration, '');
        assert.equal(reset.state.candidateSinceMs, null);
        state = transition(reset.state, { type: 'ready', generation: 'g1' }, 3000).state;
        assert.equal(state.candidateSinceMs, 3000);
    }

    let state = transition(createAgentStartupSettlingState(), {
        type: 'ready', generation: 'g1',
    }, 100).state;
    state = transition(state, { type: 'ready', generation: 'g2' }, 3000).state;
    assert.equal(state.candidateGeneration, 'g2');
    assert.equal(state.candidateSinceMs, 3000);
    const rewind = transition(state, { type: 'ready', generation: 'g2' }, 2500);
    assert.equal(rewind.action, 'poll');
    assert.equal(rewind.state.candidateSinceMs, 2500);
});

test('failed and unavailable are terminal until Retry clears them', () => {
    for (const event of [
        { type: 'failed', code: 'startup_failed' },
        { type: 'failed', code: 'startup_timed_out' },
        { type: 'unavailable', code: 'route_unavailable' },
    ]) {
        let state = transition(createAgentStartupSettlingState(), {
            type: 'ready', generation: 'g1',
        }, 0).state;
        const terminal = transition(state, event, 1000);
        assert.equal(terminal.action, 'stop');
        assert.equal(terminal.state.candidateGeneration, '');
        assert.equal(terminal.state.terminalState, event.type === 'unavailable' ? 'unavailable' : 'failed');
        const retry = transition(terminal.state, { type: 'retry-click' }, 2000);
        assert.equal(retry.action, 'poll');
        assert.equal(retry.state.terminalState, '');
        assert.equal(retry.state.terminalCode, '');
    }
});

test('redirected, non-JSON, and invalid protocol events reload normally and never claim readiness', () => {
    for (const event of [
        { type: 'auth-response' },
        { type: 'invalid-response' },
        { type: 'ready', generation: '' },
        { type: 'unknown-protocol-state' },
    ]) {
        const candidate = transition(createAgentStartupSettlingState(), {
            type: 'ready', generation: 'g1',
        }, 0).state;
        const result = transition(candidate, event, 5000);
        assert.equal(result.action, 'reload');
        assert.equal(result.state.reloadRequested, true);
        assert.notEqual(result.state.candidateGeneration && result.state.candidateSinceMs, 5000);
    }
});

function extractBrowserScript(html) {
    const match = html.match(/<script nonce="[^"]+">\s*([\s\S]*?)\s*<\/script>/);
    assert.ok(match, 'startup page must contain its nonce-bound client script');
    return match[1];
}

function createElement() {
    const listeners = new Map();
    return {
        hidden: false,
        textContent: '',
        attributes: {},
        focusCount: 0,
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        addEventListener(name, listener) {
            listeners.set(name, listener);
        },
        dispatch(name) {
            listeners.get(name)?.();
        },
        focus() {
            this.focusCount += 1;
        },
    };
}

function protocolResponse({ status, payload, redirected = false, contentType = 'application/json; charset=utf-8' }) {
    return {
        status,
        redirected,
        headers: {
            get(name) {
                return String(name).toLowerCase() === 'content-type' ? contentType : null;
            },
        },
        async json() {
            return payload;
        },
    };
}

function browserHarness({ responseFactory, initialState = 'starting', code = '' } = {}) {
    const html = buildAgentStartupDocumentResponse({ state: initialState, code }).body;
    const elements = {
        'agent-startup-root': createElement(),
        'agent-startup-title': createElement(),
        'agent-startup-message': createElement(),
        'agent-startup-spinner': createElement(),
        'agent-startup-retry': createElement(),
    };
    const timers = new Map();
    const fetchCalls = [];
    let nextTimerId = 1;
    let nowMs = 0;
    const location = {
        href: 'http://127.0.0.1:8080/sampleAgent/index.html?room=kept#section',
        reloadCount: 0,
        reload() {
            this.reloadCount += 1;
        },
    };
    const context = {
        document: {
            getElementById(id) {
                return elements[id] || null;
            },
        },
        window: { location },
        performance: { now: () => nowMs },
        setTimeout(callback, delay) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
        async fetch(url, options) {
            fetchCalls.push({ url, options });
            return responseFactory(fetchCalls.length);
        },
    };
    vm.runInNewContext(extractBrowserScript(html), context);
    return {
        elements,
        fetchCalls,
        location,
        timers,
        setNow(value) {
            nowMs = value;
        },
        runNextTimer() {
            const next = timers.entries().next().value;
            assert.ok(next, 'expected a scheduled browser poll');
            const [id, timer] = next;
            timers.delete(id);
            timer.callback();
            return timer.delay;
        },
    };
}

async function flushBrowserTasks() {
    for (let index = 0; index < 6; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

test('browser polls the unchanged original URL every 1000ms with no overlapping request', async () => {
    let releaseFetch;
    const pendingFetch = new Promise((resolve) => { releaseFetch = resolve; });
    const harness = browserHarness({ responseFactory: () => pendingFetch });
    assert.equal(harness.runNextTimer(), AGENT_STARTUP_POLL_INTERVAL_MS);
    assert.equal(harness.fetchCalls.length, 1);
    assert.equal(harness.timers.size, 0, 'next poll is not scheduled while fetch is in flight');
    assert.equal(harness.fetchCalls[0].url, harness.location.href);
    assert.deepEqual(JSON.parse(JSON.stringify(harness.fetchCalls[0].options)), {
        method: 'GET',
        headers: {
            [AGENT_STARTUP_PROBE_HEADER]: AGENT_STARTUP_PROBE_HEADER_VALUE,
            Accept: 'application/json',
        },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'follow',
    });
    releaseFetch(protocolResponse({
        status: 202,
        payload: {
            state: 'starting',
            generation: GENERATION_ONE,
            retryAfterMs: AGENT_STARTUP_POLL_INTERVAL_MS,
        },
    }));
    await flushBrowserTasks();
    assert.equal(harness.timers.size, 1);
    assert.equal(harness.location.href, 'http://127.0.0.1:8080/sampleAgent/index.html?room=kept#section');
    assert.equal(harness.location.reloadCount, 0);
});

test('browser reloads through normal auth for redirected or non-JSON responses and never marks ready', async () => {
    for (const response of [
        protocolResponse({
            status: 200,
            redirected: true,
            payload: { state: 'ready', generation: GENERATION_ONE },
        }),
        protocolResponse({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            payload: { state: 'ready', generation: GENERATION_ONE },
        }),
    ]) {
        const harness = browserHarness({ responseFactory: () => response });
        harness.runNextTimer();
        await flushBrowserTasks();
        assert.equal(harness.location.reloadCount, 1);
        assert.equal(harness.timers.size, 0);
        assert.notEqual(
            harness.elements['agent-startup-root'].attributes['data-ploinky-agent-startup-page'],
            'ready',
        );
    }
});

test('browser stops on fixed terminal state and Retry resumes resolution', async () => {
    for (const [payload, expectedState, expectedMessage] of [
        [{
            state: 'failed',
            code: 'startup_failed',
            message: 'hostile response text is ignored',
        }, 'failed', AGENT_STARTUP_BROWSER_COPY.startup_failed.message],
        [{
            state: 'unavailable',
            code: 'route_unavailable',
            message: 'hostile response text is ignored',
        }, 'unavailable', AGENT_STARTUP_BROWSER_COPY.route_unavailable.message],
    ]) {
        const harness = browserHarness({
            responseFactory: () => protocolResponse({ status: 503, payload }),
        });
        harness.runNextTimer();
        await flushBrowserTasks();
        assert.equal(harness.timers.size, 0);
        assert.equal(harness.elements['agent-startup-root'].attributes['data-ploinky-agent-startup-page'], expectedState);
        assert.equal(harness.elements['agent-startup-message'].textContent, expectedMessage);
        assert.equal(harness.elements['agent-startup-retry'].hidden, false);
        assert.equal(harness.elements['agent-startup-retry'].focusCount, 1);

        harness.elements['agent-startup-retry'].dispatch('click');
        assert.equal(harness.elements['agent-startup-root'].attributes['data-ploinky-agent-startup-page'], 'starting');
        assert.equal(harness.elements['agent-startup-retry'].hidden, true);
        assert.equal(harness.timers.size, 1);
        assert.equal(harness.runNextTimer(), 0);
    }
});
