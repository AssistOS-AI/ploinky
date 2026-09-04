import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocalTTYFactory } from '../../cli/server/webchat/tty.js';
import { handleRuntimeRoute } from '../../cli/server/handlers/webchat/runtimeRoutes.js';
import { createNetwork } from '../../cli/server/webchat/network.js';

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

async function runChild(script) {
    const session = createLocalTTYFactory({
        workdir: process.cwd(),
        command: `${quote(process.execPath)} -e ${quote(script)} --`,
        startupProtocol: true,
    }).create(null);
    const output = [];
    const states = [];
    session.onStartupState((state) => states.push(state.state));
    session.onOutput((chunk) => output.push(chunk));
    await new Promise((resolve) => session.onClose(resolve));
    return { output: output.join(''), states, session };
}

test('WebChat buffers early output until the private CLI readiness signal', async () => {
    const result = await runChild(`
        const fs = require('fs');
        fs.writeSync(1, 'early greeting\\n');
        setTimeout(() => {
            fs.writeSync(3, '{"version":1,"state":"ready"}\\n');
            fs.writeSync(1, 'ready greeting\\n');
        }, 30);
    `);
    assert.deepEqual(result.states, ['starting', 'ready']);
    assert.equal(result.output, 'early greeting\nready greeting\n');
    assert.equal(result.session.isAlive(), false);
});

test('WebChat startup stderr and stdout never become an agent answer on failure', async () => {
    const result = await runChild(`
        process.stdout.write('launcher diagnostic\\n');
        process.stderr.write('Network lifecycle is busy (pid 2149844)\\n');
        process.exitCode = 1;
    `);
    assert.deepEqual(result.states, ['starting', 'failed']);
    assert.equal(result.output, '');
    assert.equal(result.session.isReady(), false);
});

test('WebChat ordinary output cannot impersonate the private readiness signal', async () => {
    const result = await runChild(`
        process.stdout.write('{"version":1,"state":"ready"}\\n');
    `);
    assert.deepEqual(result.states, ['starting', 'failed']);
    assert.equal(result.output, '');
});

test('WebChat malformed and oversized startup controls fail closed', async () => {
    for (const control of ['{"version":2,"state":"ready"}\n', 'x'.repeat(2048)]) {
        const result = await runChild(`
            require('fs').writeSync(3, ${JSON.stringify(control)});
            process.stdout.write('must not reach chat\\n');
        `);
        assert.deepEqual(result.states, ['starting', 'failed']);
        assert.equal(result.output, '');
    }
});

test('WebChat control EOF fails startup and reaps a child that ignores TERM', { timeout: 5000 }, async () => {
    const result = await runChild(`
        require('child_process').spawn(process.execPath, ['-e',
            'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
        ], { stdio: 'inherit' });
        setTimeout(() => require('fs').closeSync(3), 100);
        setInterval(() => {}, 1000);
    `);
    assert.deepEqual(result.states, ['starting', 'failed']);
    assert.equal(result.output, '');
    assert.equal(result.session.isAlive(), false);
});

function runtimeFixture(t) {
    let outputHandler;
    let closeHandler;
    let startupHandler;
    const input = [];
    const tty = {
        isAlive: () => true,
        onOutput(handler) { outputHandler = handler; },
        onClose(handler) { closeHandler = handler; },
        onStartupState(handler) { startupHandler = handler; handler({ state: 'starting' }); },
        write(value) { input.push(value); return true; },
        dispose() {},
    };
    const appState = { runtimes: new Map(), sessions: new Map([['session', {}]]) };
    const effectiveConfig = { agentName: 'generic-agent', ttyFactory: { create: () => tty } };
    const requests = [];
    const request = (pathname, tabId = 'tab') => {
        const req = new EventEmitter();
        req.headers = { cookie: 'webchat_sid=session' };
        req.method = pathname === '/stream' ? 'GET' : 'POST';
        const chunks = [];
        const res = {
            statusCode: null,
            ended: false,
            writeHead(status) { this.statusCode = status; },
            write(chunk) { chunks.push(chunk); },
            end(chunk = '') { chunks.push(chunk); this.ended = true; },
        };
        handleRuntimeRoute({
            pathname, req, res,
            parsedUrl: new URL(`http://localhost${pathname}?tabId=${tabId}`),
            appState, effectiveConfig, workspaceDirectory: '/workspace', agentQuery: '',
        });
        requests.push(req);
        return { req, res, chunks };
    };
    t.after(() => {
        for (const req of requests) req.emit('close');
        for (const tab of appState.runtimes.values()) clearTimeout(tab.cleanupTimer);
    });
    return {
        appState, request, input,
        emitStartup: (state) => startupHandler({ state }),
        emitOutput: (data) => outputHandler(data),
        emitClose: () => closeHandler(),
    };
}

test('WebChat streams startup state, preserves a waiting runtime, and replays readiness', (t) => {
    const fixture = runtimeFixture(t);
    const first = fixture.request('/stream');
    assert.match(first.chunks.join(''), /event: startup-state\ndata: {"state":"starting"}/);
    const input = fixture.request('/input');
    assert.equal(input.res.statusCode, 409);
    assert.match(input.chunks.join(''), /startup is still in progress/);
    assert.equal(fixture.appState.runtimes.size, 1);
    assert.deepEqual(fixture.input, []);

    fixture.emitStartup('ready');
    const reconnected = fixture.request('/stream', 'other-tab');
    assert.match(reconnected.chunks.join(''), /event: startup-state\ndata: {"state":"ready"}/);
    fixture.emitClose();
    assert.match(first.chunks.join(''), /event: close\ndata: {"state":"closed"}/);
    assert.equal(first.res.ended, true);
    assert.equal(reconnected.res.ended, true);
    assert.equal(fixture.appState.runtimes.size, 0);
});

test('WebChat startup failure is a separate SSE control event followed by terminal close', (t) => {
    const fixture = runtimeFixture(t);
    const stream = fixture.request('/stream');
    fixture.emitStartup('failed');
    fixture.emitClose();
    assert.match(stream.chunks.join(''), /event: startup-state\ndata: {"state":"failed"}/);
    assert.match(stream.chunks.join(''), /event: close\ndata: {"state":"failed"}/);
    assert.equal(stream.res.ended, true);
});

function browserFixture(t) {
    const sources = [];
    const banners = [];
    const answers = [];
    let connected = 0;
    const statusEl = { textContent: '' };
    class FakeEventSource {
        constructor() { this.listeners = new Map(); sources.push(this); }
        addEventListener(name, fn) { this.listeners.set(name, fn); }
        emit(name, payload) { this.listeners.get(name)?.({ data: JSON.stringify(payload) }); }
        close() { this.closed = true; }
    }
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalSource = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource;
    t.mock.method(Math, 'random', () => 0);
    const network = createNetwork({
        TAB_ID: 'tab', PAGE_INSTANCE_ID: 'page', agentName: 'generic-agent',
        toEndpoint: (route) => route, dlog() {},
        showBanner: (text) => banners.push(text), hideBanner: () => banners.push('hidden'),
        statusEl,
        statusDot: { classList: { add() {}, remove() {} } },
    }, {
        addServerMsg: (message) => answers.push(message),
        showTypingIndicator() {}, hideTypingIndicator() {},
        onConnected: () => { connected += 1; },
    });
    t.after(() => {
        network.stop();
        if (originalSource === undefined) delete globalThis.EventSource;
        else globalThis.EventSource = originalSource;
    });
    network.start();
    return { network, sources, banners, answers, statusEl, connected: () => connected };
}

test('WebChat transport open is not agent readiness and fatal startup is terminal', (t) => {
    const fixture = browserFixture(t);
    const source = fixture.sources[0];
    source.onopen();
    assert.equal(fixture.statusEl.textContent, 'starting');
    assert.equal(fixture.connected(), 0);
    source.emit('startup-state', { state: 'failed' });
    source.onerror();
    source.onopen();
    source.emit('startup-state', { state: 'ready' });
    t.mock.timers.tick(120000);
    assert.equal(fixture.sources.length, 1);
    assert.equal(fixture.statusEl.textContent, 'offline');
    assert.match(fixture.banners.at(-1), /Agent startup failed/);
    assert.equal(fixture.connected(), 0);
    assert.deepEqual(fixture.answers, []);
});

test('WebChat CLI exit after readiness stays terminal and cannot hide its error banner', (t) => {
    const fixture = browserFixture(t);
    const source = fixture.sources[0];
    source.onopen();
    source.emit('startup-state', { state: 'ready' });
    source.emit('startup-state', { state: 'ready' });
    assert.equal(fixture.connected(), 1);
    assert.equal(fixture.statusEl.textContent, 'online');
    source.emit('close', { state: 'closed' });
    source.onerror();
    t.mock.timers.tick(120000);
    assert.equal(fixture.sources.length, 1);
    assert.match(fixture.banners.at(-1), /Agent session closed/);
});

test('WebChat repeated stream opens retain exponential backoff and exhaust a finite budget', (t) => {
    const fixture = browserFixture(t);
    for (let attempt = 0; attempt < 6; attempt += 1) {
        const source = fixture.sources.at(-1);
        source.onopen();
        // Even transient readiness must not replenish the retry budget.
        source.emit('startup-state', { state: 'ready' });
        source.onerror();
        const delay = 1000 * (2 ** attempt);
        t.mock.timers.tick(delay - 1);
        assert.equal(fixture.sources.length, attempt + 1);
        t.mock.timers.tick(1);
        assert.equal(fixture.sources.length, attempt + 2);
    }
    fixture.sources.at(-1).onopen();
    fixture.sources.at(-1).onerror();
    t.mock.timers.tick(120000);
    assert.equal(fixture.sources.length, 7);
    assert.match(fixture.banners.at(-1), /Unable to reconnect/);
});

test('WebChat sustained readiness resets retries and stop cancels stale reconnects', (t) => {
    const fixture = browserFixture(t);
    fixture.sources[0].onerror();
    t.mock.timers.tick(1000);
    const source = fixture.sources[1];
    source.onopen();
    source.emit('startup-state', { state: 'ready' });
    t.mock.timers.tick(30000);
    source.onerror();
    assert.match(fixture.banners.at(-1), /attempt 1\/6/);
    fixture.network.stop();
    source.onerror();
    t.mock.timers.tick(120000);
    assert.equal(fixture.sources.length, 2);
});
