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
    role = 'owner',
    sessionOverride = {},
    requestHandler = null,
    confirm = true,
    embedded = false,
} = {}) {
    const requests = [];
    const sources = [];
    const windowListeners = new Map();
    const historyCalls = [];
    const elements = new Map();
    const timers = new Map();
    let timerId = 0;
    let clock = 1000;
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
            disabled: true,
            listeners: new Map(),
            addEventListener(type, callback) { this.listeners.set(type, callback); },
            click() { this.listeners.get('click')?.(); },
        };
        Object.defineProperty(value, 'innerHTML', {
            set() { assert.fail(`client must not write requested data through innerHTML (${id})`); },
        });
        elements.set(id, value);
        return value;
    }
    for (const id of ['directory', 'target', 'access', 'status', 'status-dot', 'dimensions', 'message', 'terminal', 'role', 'kill']) element(id);

    class FakeTerminal {
        constructor(options) {
            this.options = options;
            this.cols = initialCols;
            this.rows = initialRows;
            FakeTerminal.instance = this;
        }
        loadAddon(addon) { this.addon = addon; }
        open(target) { this.target = target; }
        focus() { this.focused = true; }
        onData(listener) { this.dataListener = listener; }
        write(data) { this.output = `${this.output || ''}${data}`; }
        reset() { this.resets = (this.resets || 0) + 1; this.output = ''; }
        emitData(data) { this.dataListener(data); }
    }
    class FakeFitAddon { fit() {} }
    class FakeEventSource {
        static CLOSED = 2;
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.listeners = new Map();
            sources.push(this);
        }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        close() { this.closed = true; this.readyState = 2; }
        emit(type, value = {}) {
            if (type === 'open') this.readyState = 1;
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
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, delay });
            if (delay <= 100) queueMicrotask(() => { if (timers.delete(id)) callback(); });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        confirm() { return confirm; },
        addEventListener(type, listener) { windowListeners.set(type, listener); },
    };
    windowRef.top = embedded ? {} : windowRef;
    const bodyClasses = new Set();
    const documentRef = {
        body: { classList: { add(value) { bodyClasses.add(value); } } },
        cookie: 'ploinky_browser_csrf=proof-cookie',
        getElementById: (id) => elements.get(id),
    };
    async function fetch(url, options = {}) {
        requests.push({ url, options });
        const intercepted = await requestHandler?.(url, options, requests);
        if (intercepted !== undefined) return intercepted;
        if (url === '/webtty/sessions' || url === '/webtty/attachments') {
            if (createPromise) return createPromise;
            return {
                ok: true,
                status: 201,
                async json() {
                    return {
                        session: {
                            id: 'terminal-abcdefghijklmnop',
                            role,
                            target: {
                                kind: 'agent', label: '<agent>', detail: 'repo/agent', access: 'ro', cwdDisplay: '/code/<folder>',
                            },
                            ...sessionOverride,
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
        Date: { now: () => clock },
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
        timers,
        bodyClasses,
        runRecoveryTimer() {
            const entry = [...timers.entries()].find(([, value]) => value.delay > 100);
            assert.ok(entry, 'a recovery timer must be scheduled');
            timers.delete(entry[0]);
            clock += entry[1].delay;
            entry[1].callback();
            return entry[1].delay;
        },
        advanceClock(ms) { clock += ms; },
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
                            role,
                            target: {
                                kind: 'agent', label: '<agent>', detail: 'repo/agent', access: 'ro', cwdDisplay: '/code/<folder>',
                            },
                            ...sessionOverride,
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
    assert.equal(Object.hasOwn(harness.windowRef, '__ploinkyTakeWebttyHandoff'), false);
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

test('pagehide before deferred creation never deletes or attaches the learned session', async () => {
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
    assert.equal(deletions.length, 0);

    harness.windowListeners.get('pagehide')();
    await flushTasks(2);
    assert.equal(harness.requests.filter((entry) => entry.options.method === 'DELETE').length, 0);
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

test('UTF-8 input chunks and resize requests stay bounded and page close only detaches', async () => {
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
    assert.equal(harness.requests.filter((entry) => entry.options.method === 'DELETE').length, 0);
    assert.equal(harness.sources[0].closed, true);
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
        '#launch=' + 'a'.repeat(32) + '&attach=' + 'b'.repeat(32),
        '#attach=' + 'a'.repeat(31),
        '#attach=' + 'a'.repeat(33),
    ]) {
        const harness = createHarness({ hash });
        await flushTasks();
        assert.equal(harness.requests.length, 0, hash);
        assert.equal(harness.sources.length, 0, hash);
        assert.equal(harness.elements.get('status').textContent, 'Reopen terminal', hash);
        assert.match(harness.elements.get('message').textContent, /Reopen this terminal from Live Sessions/, hash);
        assert.equal(harness.historyCalls.length, 1, hash);
    }
});

test('history stripping failure never sends the fragment bearer', async () => {
    const harness = createHarness({ historyThrows: true });
    await flushTasks();
    assert.equal(harness.requests.length, 0);
    assert.equal(harness.sources.length, 0);
    assert.equal(harness.elements.get('status').textContent, 'Reopen terminal');
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

function response(status, body) {
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}
function deletions(harness) {
    return harness.requests.filter((entry) => entry.options.method === 'DELETE');
}

test('attach handoff is stripped, consumed once, sent in JSON only, and starts a watcher without input or resize', async () => {
    const token = 'a'.repeat(32);
    const harness = createHarness({ hash: `#attach=${token}`, role: 'watcher', embedded: true });
    await flushTasks();
    assert.equal(harness.requests[0].url, '/webtty/attachments');
    assert.deepEqual(JSON.parse(harness.requests[0].options.body), { attach: token, cols: 80, rows: 24 });
    assert.equal(Object.hasOwn(harness.windowRef, '__ploinkyTakeWebttyHandoff'), false);
    assert.equal(harness.windowRef.location.hash, '');
    assert.ok(harness.requests.every(({ url }) => !url.includes(token)));
    assert.ok(harness.bodyClasses.has('embedded'));
    assert.equal(harness.elements.get('role').textContent, 'Watching (read-only)');
    assert.equal(harness.terminal.options.disableStdin, true);
    harness.terminal.emitData('ignored');
    harness.windowListeners.get('resize')();
    await flushTasks();
    assert.equal(harness.requests.length, 1);
    assert.equal(harness.sources.length, 1);
});

test('reset, detached and pagehide dispose locally without DELETE or later input/resize', async () => {
    for (const trigger of ['reset', 'detached', 'pagehide']) {
        const harness = createHarness();
        await flushTasks();
        if (trigger === 'pagehide') harness.windowListeners.get(trigger)();
        else harness.sources[0].emit(trigger);
        harness.terminal.emitData('ignored');
        harness.windowListeners.get('resize')();
        await flushTasks();
        assert.equal(deletions(harness).length, 0, trigger);
        assert.equal(harness.sources[0].closed, true, trigger);
        assert.equal(harness.requests.length, 1, trigger);
    }
});

test('confirmed Kill sends exactly one DELETE and cancelled Kill sends none', async () => {
    for (const confirm of [false, true]) {
        const harness = createHarness({ confirm });
        await flushTasks();
        harness.elements.get('kill').click();
        harness.elements.get('kill').click();
        await flushTasks();
        assert.equal(deletions(harness).length, confirm ? 1 : 0);
        if (confirm) assert.equal(deletions(harness)[0].url, '/webtty/sessions/terminal-abcdefghijklmnop');
    }
});

test('invalid created session rolls back exactly once; malformed attach never deletes', async () => {
    for (const kind of ['launch', 'attach']) {
        const harness = createHarness({ hash: `#${kind}=${'a'.repeat(32)}`, sessionOverride: { target: null } });
        await flushTasks();
        assert.equal(deletions(harness).length, kind === 'launch' ? 1 : 0);
        assert.equal(harness.sources.length, 0);
        harness.windowListeners.get('pagehide')();
        await flushTasks();
        assert.equal(deletions(harness).length, kind === 'launch' ? 1 : 0);
    }
});

test('attach startup network failure and malformed id never issue DELETE', async () => {
    for (const requestHandler of [
        () => { throw new Error('network unavailable'); },
        () => response(200, { session: { id: 'bad' } }),
    ]) {
        const harness = createHarness({ hash: `#attach=${'a'.repeat(32)}`, requestHandler });
        await flushTasks();
        assert.equal(deletions(harness).length, 0);
        assert.equal(harness.elements.get('status').textContent, 'Unavailable');
        assert.equal(harness.sources.length, 0);
    }
});

test('input overflow stops local input and preserves the stream without DELETE', async () => {
    const harness = createHarness();
    await flushTasks();
    harness.terminal.emitData('x'.repeat(65537));
    harness.terminal.emitData('later');
    await flushTasks();
    assert.equal(harness.requests.length, 1);
    assert.equal(deletions(harness).length, 0);
    assert.equal(harness.terminal.options.disableStdin, true);
    harness.sources[0].emit('output', { data: 'still running' });
    assert.equal(harness.terminal.output, 'still running');
});

test('input failures drop pending chunks and never DELETE; owner refusal switches to watch', async () => {
    for (const failure of ['edge_generation_changed', 'owner_required', 'network']) {
        const harness = createHarness({
            requestHandler(url) {
                if (!url.endsWith('/input')) return;
                if (failure === 'network') throw new Error('network unavailable');
                return response(failure === 'owner_required' ? 403 : 503, { error: failure });
            },
        });
        await flushTasks();
        harness.terminal.emitData('x'.repeat(12000));
        await flushTasks();
        harness.terminal.emitData('must not replay');
        harness.windowListeners.get('resize')();
        await flushTasks();
        assert.equal(harness.requests.filter(({ url }) => url.endsWith('/input')).length, 1, failure);
        assert.equal(deletions(harness).length, 0, failure);
        assert.equal(harness.sources[0].closed, undefined, failure);
        assert.equal(harness.terminal.options.disableStdin, true, failure);
        if (failure === 'owner_required') assert.equal(harness.elements.get('role').textContent, 'Watching (read-only)');
    }
});

test('CSRF refusal refreshes proof once and retries exactly once without looping', async () => {
    for (const succeeds of [true, false]) {
        let count = 0;
        const harness = createHarness({
            requestHandler(url) {
                if (!url.endsWith('/input')) return;
                count += 1;
                return succeeds && count === 2 ? response(200, { ok: true }) : response(403, { error: 'browser_csrf_invalid' });
            },
        });
        await flushTasks();
        harness.terminal.emitData('hello');
        await flushTasks();
        assert.equal(count, 2);
        assert.equal(harness.requests.filter(({ url }) => url === '/webtty/live-sessions').length, 1);
        assert.equal(deletions(harness).length, 0);
        assert.equal(harness.terminal.options.disableStdin, !succeeds);
    }
});

test('CLOSED stream recreates after a refused reconnect, resets once and replays text once', async () => {
    const harness = createHarness();
    await flushTasks();
    const first = harness.sources[0];
    first.emit('open');
    first.emit('output', { data: 'replay' });
    first.readyState = 2;
    first.emit('error');
    assert.equal(harness.terminal.resets, 1);
    assert.equal(harness.runRecoveryTimer(), 1000);
    const refused = harness.sources[1];
    // EventSource reports a JSON HTTP 503 as CLOSED, without an open/output event.
    refused.readyState = 2;
    refused.emit('error');
    assert.equal(harness.runRecoveryTimer(), 2000);
    const recovered = harness.sources[2];
    recovered.emit('open');
    recovered.emit('output', { data: 'replay' });
    first.emit('output', { data: 'stale' });
    assert.equal(harness.terminal.output, 'replay');
    assert.equal(harness.terminal.resets, 1);
    assert.equal(harness.sources.length, 3);
    assert.ok(harness.sources.every(({ url }) => !url.includes('?')));
    assert.equal(deletions(harness).length, 0);
});

test('recovery backoff is bounded and ends after ten minutes, while pagehide cancels it', async () => {
    const harness = createHarness();
    await flushTasks();
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
        const source = harness.sources.at(-1);
        source.readyState = 2;
        source.emit('error');
        assert.equal(harness.runRecoveryTimer(), delay);
    }
    harness.advanceClock(600000);
    const source = harness.sources.at(-1);
    source.readyState = 2;
    source.emit('error');
    assert.equal(harness.timers.size, 0);
    assert.match(harness.elements.get('message').textContent, /Disconnected.*reopen from Live Sessions/);
    assert.equal(deletions(harness).length, 0);
    const cancelled = createHarness();
    await flushTasks();
    cancelled.sources[0].readyState = 2;
    cancelled.sources[0].emit('error');
    cancelled.windowListeners.get('pagehide')();
    assert.equal(cancelled.timers.size, 0);
    assert.equal(deletions(cancelled).length, 0);
});

test('resync resets before delta output, replay truncation is visible and neither event deletes', async () => {
    const harness = createHarness();
    await flushTasks();
    harness.sources[0].emit('output', { data: 'old' });
    harness.sources[0].emit('resync');
    harness.sources[0].emit('replay-truncated');
    harness.sources[0].emit('output', { data: 'new' });
    assert.equal(harness.terminal.output, 'new');
    assert.match(harness.elements.get('message').textContent, /recent terminal output/);
    assert.equal(deletions(harness).length, 0);
});
