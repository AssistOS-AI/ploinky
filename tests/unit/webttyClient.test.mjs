import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const webttyDirectory = path.resolve('cli/server/webtty');
const bootstrapSource = fs.readFileSync(path.join(webttyDirectory, 'webtty-bootstrap.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(webttyDirectory, 'webtty.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(webttyDirectory, 'webtty.html'), 'utf8');
const handlerSource = fs.readFileSync(path.resolve('cli/server/handlers/webtty.js'), 'utf8');

function flushTasks(count = 8) {
    return Array.from({ length: count }).reduce(
        (promise) => promise.then(() => new Promise((resolve) => setImmediate(resolve))),
        Promise.resolve(),
    );
}

function createHarness({
    search = '?dir=Projects%2F%3Cimg%20src%3Dx%20onerror%3D1%3E',
    hash = '#launch=abcdefghijklmnopqrstuvwxyzABCDEF',
    deferredCreate = false,
    historyThrows = false,
    initialCols = 80,
    initialRows = 24,
} = {}) {
    const requests = [];
    const sources = [];
    const windowListeners = new Map();
    const historyCalls = [];
    const elements = new Map();
    let createResolve;
    const createPromise = deferredCreate
        ? new Promise((resolve) => { createResolve = resolve; })
        : null;

    function element(id) {
        const value = {
            id,
            textContent: '',
            className: '',
            hidden: true,
        };
        Object.defineProperty(value, 'innerHTML', {
            set() { assert.fail(`client must not write requested data through innerHTML (${id})`); },
        });
        elements.set(id, value);
        return value;
    }
    for (const id of ['directory', 'target', 'access', 'status', 'status-dot', 'dimensions', 'message', 'terminal']) element(id);

    class FakeTerminal {
        constructor() {
            this.cols = initialCols;
            this.rows = initialRows;
            FakeTerminal.instance = this;
        }
        loadAddon(addon) { this.addon = addon; }
        open(target) { this.target = target; }
        focus() { this.focused = true; }
        onData(listener) { this.dataListener = listener; }
        write(data) { this.output = `${this.output || ''}${data}`; }
        emitData(data) { this.dataListener(data); }
    }
    class FakeFitAddon { fit() {} }
    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.listeners = new Map();
            sources.push(this);
        }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        close() { this.closed = true; }
        emit(type, value = {}) {
            this.listeners.get(type)?.({ data: JSON.stringify(value) });
        }
    }
    const windowRef = {
        location: { pathname: '/webtty/', search, hash },
        history: {
            replaceState(...args) {
                if (historyThrows) throw new Error('history unavailable');
                historyCalls.push(args);
                windowRef.location.hash = '';
            },
        },
        Terminal: FakeTerminal,
        FitAddon: { FitAddon: FakeFitAddon },
        setTimeout(callback) { queueMicrotask(callback); return 1; },
        clearTimeout() {},
        addEventListener(type, listener) { windowListeners.set(type, listener); },
    };
    const documentRef = {
        cookie: 'ploinky_browser_csrf=proof-cookie',
        getElementById: (id) => elements.get(id),
    };
    async function fetch(url, options = {}) {
        requests.push({ url, options });
        if (url === '/webtty/sessions') {
            if (createPromise) return createPromise;
            return {
                ok: true,
                status: 201,
                async json() {
                    return {
                        session: {
                            id: 'terminal-abcdefghijklmnop',
                            target: {
                                kind: 'agent', label: '<agent>', detail: 'repo/agent', access: 'ro', cwdDisplay: '/code/<folder>',
                            },
                        },
                    };
                },
            };
        }
        return { ok: true, status: 200, async json() { return { ok: true }; } };
    }
    const context = {
        document: documentRef,
        window: windowRef,
        EventSource: FakeEventSource,
        fetch,
        URLSearchParams,
        TextEncoder,
        encodeURIComponent,
        queueMicrotask,
        console,
        Promise,
        JSON,
        Error,
    };
    vm.runInNewContext(bootstrapSource, context);
    vm.runInNewContext(clientSource, context);
    return {
        elements,
        historyCalls,
        requests,
        sources,
        terminal: FakeTerminal.instance,
        windowRef,
        windowListeners,
        resolveCreate() {
            createResolve({
                ok: true,
                status: 201,
                async json() {
                    return {
                        session: {
                            id: 'terminal-abcdefghijklmnop',
                            target: {
                                kind: 'agent', label: '<agent>', detail: 'repo/agent', access: 'ro', cwdDisplay: '/code/<folder>',
                            },
                        },
                    };
                },
            });
        },
    };
}

test('fragment launch is stripped immediately, sent only in JSON, and POST completes before SSE attach', async () => {
    const launch = 'abcdefghijklmnopqrstuvwxyzABCDEF';
    const harness = createHarness({ search: `?launch=${launch}`, deferredCreate: true });
    assert.deepEqual(harness.historyCalls, [[null, '', '/webtty/']]);
    assert.equal(Object.hasOwn(harness.windowRef, '__ploinkyTakeWebttyLaunch'), false);
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.requests[0].url, '/webtty/sessions');
    assert.equal(harness.requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(harness.requests[0].options.body), {
        launch,
        cols: 80,
        rows: 24,
    });
    assert.equal(harness.sources.length, 0);

    harness.resolveCreate();
    await flushTasks();
    assert.equal(harness.elements.get('target').textContent, '<agent> — repo/agent');
    assert.equal(harness.elements.get('access').textContent, 'Read only folder mapping');
    assert.equal(harness.elements.get('directory').textContent, '/code/<folder>');
    assert.equal(harness.sources.length, 1);
    assert.equal(harness.sources[0].url, '/webtty/sessions/terminal-abcdefghijklmnop/stream');
});

test('pagehide before deferred creation deletes the learned session without attaching SSE', async () => {
    const harness = createHarness({ deferredCreate: true });
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.sources.length, 0);

    harness.windowListeners.get('pagehide')();
    await flushTasks(2);
    assert.equal(harness.requests.filter((entry) => entry.options.method === 'DELETE').length, 0);

    harness.resolveCreate();
    await flushTasks();
    assert.equal(harness.sources.length, 0);
    const deletions = harness.requests.filter((entry) => entry.options.method === 'DELETE');
    assert.equal(deletions.length, 1);
    assert.equal(deletions[0].url, '/webtty/sessions/terminal-abcdefghijklmnop');
    assert.equal(deletions[0].options.keepalive, true);

    harness.windowListeners.get('pagehide')();
    await flushTasks(2);
    assert.equal(harness.requests.filter((entry) => entry.options.method === 'DELETE').length, 1);
});

test('EventSource reconnect never creates a terminal and explicit exit stops input', async () => {
    const harness = createHarness();
    await flushTasks();
    assert.equal(harness.requests.filter((entry) => entry.url === '/webtty/sessions').length, 1);
    harness.sources[0].emit('error');
    await flushTasks(2);
    assert.equal(harness.requests.filter((entry) => entry.url === '/webtty/sessions').length, 1);

    harness.sources[0].emit('output', { data: 'hello' });
    assert.equal(harness.terminal.output, 'hello');
    harness.sources[0].emit('exit', { reason: 'auth_revoked' });
    assert.equal(harness.elements.get('status').textContent, 'Closed');
    assert.equal(harness.sources[0].closed, true);
    const before = harness.requests.length;
    harness.terminal.emitData('ignored');
    await flushTasks(2);
    assert.equal(harness.requests.length, before);
});

test('UTF-8 input chunks and resize requests stay bounded and page close sends keepalive DELETE', async () => {
    const harness = createHarness();
    await flushTasks();
    const input = '💥'.repeat(3_000);
    harness.terminal.emitData(input);
    await flushTasks(12);
    const inputRequests = harness.requests.filter((entry) => entry.url.endsWith('/input'));
    assert.ok(inputRequests.length >= 2);
    assert.equal(inputRequests.map((entry) => JSON.parse(entry.options.body).data).join(''), input);
    assert.ok(inputRequests.every((entry) => (
        Buffer.byteLength(JSON.parse(entry.options.body).data, 'utf8') <= 8 * 1024
    )));

    harness.terminal.cols = 120;
    harness.terminal.rows = 40;
    harness.windowListeners.get('resize')();
    await flushTasks(4);
    const resize = harness.requests.findLast((entry) => entry.url.endsWith('/resize'));
    assert.deepEqual(JSON.parse(resize.options.body), { cols: 120, rows: 40 });

    harness.windowListeners.get('pagehide')();
    await flushTasks(4);
    const deletion = harness.requests.findLast((entry) => entry.options.method === 'DELETE');
    assert.equal(deletion.options.keepalive, true);
    assert.equal(deletion.url, '/webtty/sessions/terminal-abcdefghijklmnop');
});

test('initial and resized terminal dimensions are clamped to protocol bounds', async () => {
    const harness = createHarness({ initialCols: 50_000, initialRows: 50_000 });
    await flushTasks();
    assert.deepEqual(JSON.parse(harness.requests[0].options.body), {
        launch: 'abcdefghijklmnopqrstuvwxyzABCDEF',
        cols: 1024,
        rows: 512,
    });
    harness.terminal.cols = -10;
    harness.terminal.rows = 1;
    harness.windowListeners.get('resize')();
    await flushTasks(4);
    const resize = harness.requests.findLast((entry) => entry.url.endsWith('/resize'));
    assert.deepEqual(JSON.parse(resize.options.body), { cols: 2, rows: 2 });
});

test('missing or malformed fragment is stripped and creates no terminal', async () => {
    for (const hash of [
        '',
        '#launch=short',
        '#launch=' + 'a'.repeat(31),
        '#launch=' + 'a'.repeat(33),
        '#launch=' + 'a'.repeat(32) + '&extra=1',
    ]) {
        const harness = createHarness({ hash });
        await flushTasks();
        assert.equal(harness.requests.length, 0, hash);
        assert.equal(harness.sources.length, 0, hash);
        assert.equal(harness.elements.get('status').textContent, 'Invalid launch', hash);
        assert.match(harness.elements.get('message').textContent, /Return to Explorer/, hash);
        assert.equal(harness.historyCalls.length, 1, hash);
    }
});

test('history stripping failure never sends the fragment bearer', async () => {
    const harness = createHarness({ historyThrows: true });
    await flushTasks();
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.sources.length, 0);
    assert.equal(harness.elements.get('status').textContent, 'Invalid launch');
});

test('page, assets, and CSP admit no external or inline script execution', () => {
    for (const match of pageSource.matchAll(/(?:src|href)="([^"]+)"/g)) {
        assert.match(match[1], /^\/webtty\/assets\//);
    }
    assert.doesNotMatch(pageSource, /https?:\/\/|<script(?:\s[^>]*)?>\s*[^<]/i);
    assert.doesNotMatch(bootstrapSource, /https?:\/\/|\beval\s*\(|new Function\s*\(/);
    assert.doesNotMatch(clientSource, /https?:\/\/|\beval\s*\(|new Function\s*\(/);
    const bootstrapIndex = pageSource.indexOf('/webtty/assets/webtty-bootstrap.js');
    const xtermIndex = pageSource.indexOf('/webtty/assets/xterm.js');
    const addonIndex = pageSource.indexOf('/webtty/assets/addon-fit.js');
    const clientIndex = pageSource.indexOf('/webtty/assets/webtty.js');
    assert.ok(bootstrapIndex >= 0);
    assert.ok(bootstrapIndex < xtermIndex);
    assert.ok(xtermIndex < addonIndex);
    assert.ok(addonIndex < clientIndex);
    const csp = handlerSource.match(/'Content-Security-Policy':\s*"([^"]+)"/)?.[1] || '';
    assert.ok(csp);
    const directives = new Map(csp.split(';').map((entry) => {
        const [name, ...values] = entry.trim().split(/\s+/);
        return [name, values];
    }));
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('style-src'), ["'self'"]);
    assert.deepEqual(directives.get('style-src-elem'), ["'self'", "'unsafe-inline'"]);
    assert.deepEqual(directives.get('style-src-attr'), ["'unsafe-inline'"]);
    assert.doesNotMatch(csp, /unsafe-eval|https?:|\*/);
});
