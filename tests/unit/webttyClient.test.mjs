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
    storage = undefined,
    viewOverride = undefined,
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
            value: '',
            listeners: new Map(),
            addEventListener(type, callback) { this.listeners.set(type, callback); },
            click() { this.listeners.get('click')?.(); },
            change(value) { this.value = value; this.listeners.get('change')?.(); },
        };
        Object.defineProperty(value, 'innerHTML', {
            set() { assert.fail(`client must not write requested data through innerHTML (${id})`); },
        });
        elements.set(id, value);
        return value;
    }
    for (const id of ['directory', 'target', 'access', 'status', 'status-dot', 'dimensions', 'message', 'terminal', 'role', 'profile', 'kill']) element(id);

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
    windowRef.location.origin = 'https://app.example.test';
    const posted = [];
    windowRef.parent = embedded ? { postMessage(message, targetOrigin) { posted.push({ message, targetOrigin }); } } : windowRef;
    windowRef.top = embedded ? {} : windowRef;
    // A Map-backed sessionStorage; `storage: 'throws'` makes every access fail.
    const stored = new Map(Object.entries(storage && storage !== 'throws' ? storage : {}));
    Object.defineProperty(windowRef, 'sessionStorage', {
        get() {
            if (storage === 'throws') throw new Error('storage disabled');
            return {
                getItem: (key) => (stored.has(key) ? stored.get(key) : null),
                setItem: (key, value) => { stored.set(key, String(value)); },
                removeItem: (key) => { stored.delete(key); },
            };
        },
    });
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
                            closePolicy: JSON.parse(options.body || '{}').closePolicy || 'keep',
                            pendingStopUntil: null,
                            profileLabel: null,
                            ...sessionOverride,
                        },
                        view: viewOverride === undefined ? { id: `view-${'v'.repeat(26)}${requests.length}` } : viewOverride,
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
        posted,
        stored,
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
                            closePolicy: 'keep',
                            pendingStopUntil: null,
                            profileLabel: null,
                            ...sessionOverride,
                        },
                        view: { id: 'v'.repeat(32) },
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
        closePolicy: 'keep',
    });
    assert.equal(harness.sources.length, 0);

    harness.resolveCreate();
    await flushTasks();
    assert.equal(harness.elements.get('target').textContent, '<agent> — repo/agent');
    assert.equal(harness.elements.get('access').textContent, 'Read only folder mapping');
    assert.equal(harness.elements.get('directory').textContent, '/code/<folder>');
    assert.equal(harness.sources.length, 1);
    assert.equal(harness.sources[0].url, `/webtty/sessions/terminal-abcdefghijklmnop/stream?view=${'v'.repeat(32)}`);
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
        closePolicy: 'keep',
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
        // Only a top-level owner pagehide adds its one close signal (plan r3 3.5).
        const intents = harness.requests.filter(({ url }) => url.endsWith('/close-intents'));
        assert.equal(intents.length, trigger === 'pagehide' ? 1 : 0, trigger);
        assert.equal(harness.requests.length - intents.length, 1, trigger);
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

function refreshes(harness) {
    return harness.requests.filter(({ url }) => url === '/webtty/live-sessions');
}

test('confirmed Kill refreshes proof once, sends one DELETE, and disposes only after it succeeds', async () => {
    let releaseDelete;
    const harness = createHarness({
        requestHandler(url, options) {
            if (options.method !== 'DELETE') return;
            return new Promise((resolve) => { releaseDelete = () => resolve(response(200, { ok: true })); });
        },
    });
    await flushTasks();
    const kill = harness.elements.get('kill');
    kill.disabled = false;
    kill.click();
    kill.click();
    await flushTasks();
    assert.equal(kill.disabled, true);
    assert.ok(!harness.sources[0].closed, 'view must stay until the DELETE succeeds');
    assert.equal(refreshes(harness).length, 1);
    assert.equal(deletions(harness).length, 1);
    const order = harness.requests.map(({ url, options }) => `${options.method || 'GET'} ${url}`);
    assert.deepEqual(order.slice(-2), ['GET /webtty/live-sessions', 'DELETE /webtty/sessions/terminal-abcdefghijklmnop']);
    releaseDelete();
    await flushTasks();
    assert.equal(harness.sources[0].closed, true);
    assert.equal(harness.elements.get('message').textContent, 'Terminal killed.');
    assert.equal(refreshes(harness).length, 1);
    assert.equal(deletions(harness).length, 1);
});

test('refused Kill DELETE keeps the view, re-enables Kill, and never retries automatically', async () => {
    const harness = createHarness({
        requestHandler(url, options) {
            if (options.method === 'DELETE') return response(403, { error: 'browser_csrf_invalid' });
        },
    });
    await flushTasks();
    const kill = harness.elements.get('kill');
    kill.disabled = false;
    kill.click();
    await flushTasks();
    assert.equal(deletions(harness).length, 1);
    assert.equal(refreshes(harness).length, 1);
    assert.ok(!harness.sources[0].closed);
    assert.equal(kill.disabled, false);
    assert.match(harness.elements.get('message').textContent, /^Kill failed: .*the terminal is still running\.$/i);
    harness.sources[0].emit('output', { data: 'still live' });
    assert.match(harness.terminal.output, /still live$/);
    await flushTasks();
    assert.equal(deletions(harness).length, 1, 'no automatic retry');
});

test('exit during a pending Kill DELETE answered 404 does not claim the terminal is still running', async () => {
    let releaseDelete;
    const harness = createHarness({
        requestHandler(url, options) {
            if (options.method !== 'DELETE') return;
            return new Promise((resolve) => { releaseDelete = () => resolve(response(404, { error: 'not_found' })); });
        },
    });
    await flushTasks();
    const kill = harness.elements.get('kill');
    kill.disabled = false;
    kill.click();
    await flushTasks();
    harness.sources[0].emit('exit', { reason: 'exited' });
    releaseDelete();
    await flushTasks();
    assert.equal(deletions(harness).length, 1);
    assert.equal(kill.disabled, true);
    const text = harness.elements.get('message').textContent;
    assert.doesNotMatch(text, /still running/i);
    assert.equal(text, 'The terminal had already ended.');
    assert.equal(harness.elements.get('status').textContent, 'Closed');
});

test('detached during a pending Kill DELETE that then fails claims neither ended nor still running', async () => {
    let releaseDelete;
    const harness = createHarness({
        requestHandler(url, options) {
            if (options.method !== 'DELETE') return;
            return new Promise((resolve) => { releaseDelete = () => resolve(response(503, {})); });
        },
    });
    await flushTasks();
    const kill = harness.elements.get('kill');
    kill.disabled = false;
    kill.click();
    await flushTasks();
    harness.sources[0].emit('detached');
    releaseDelete();
    await flushTasks();
    assert.equal(deletions(harness).length, 1);
    assert.equal(kill.disabled, true);
    const text = harness.elements.get('message').textContent;
    assert.doesNotMatch(text, /already ended|Kill failed|terminal is still running/i);
    assert.match(text, /^Kill could not be confirmed\. Reopen this terminal from Live Sessions/);
});

test('failed proof refresh sends no DELETE and keeps the view', async () => {
    const harness = createHarness({
        requestHandler(url) {
            if (url === '/webtty/live-sessions') return response(503, {});
        },
    });
    await flushTasks();
    const kill = harness.elements.get('kill');
    kill.disabled = false;
    kill.click();
    await flushTasks();
    assert.equal(refreshes(harness).length, 1);
    assert.equal(deletions(harness).length, 0);
    assert.ok(!harness.sources[0].closed);
    assert.equal(kill.disabled, false);
    assert.match(harness.elements.get('message').textContent, /^Kill failed: .*the terminal is still running\.$/i);
});

test('invalid created session rolls back exactly once; malformed attach never deletes', async () => {
    for (const kind of ['launch', 'attach']) {
        const harness = createHarness({ hash: `#${kind}=${'a'.repeat(32)}`, sessionOverride: { target: null } });
        await flushTasks();
        assert.equal(deletions(harness).length, kind === 'launch' ? 1 : 0);
        assert.equal(refreshes(harness).length, 0, 'rollback never refreshes proof');
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
    // In-tab reconnects reuse the same server view.
    assert.ok(harness.sources.every(({ url }) => url === harness.sources[0].url));
    assert.match(harness.sources[0].url, /^\/webtty\/sessions\/terminal-abcdefghijklmnop\/stream\?view=[A-Za-z0-9_-]{32}$/);
    assert.equal(deletions(harness).length, 0);
});

// A retired shell answers a reconnect of its eligible view with one exit
// event and a finished response; the recovered stream must then stay closed.
test('a recovered stream that receives exit shows Closed and stops recovery, input and mutations', async () => {
    for (const reconnect of ['recovered source', 'native reconnect']) {
        const harness = createHarness();
        await flushTasks();
        const first = harness.sources[0];
        first.emit('open');
        first.emit('output', { data: 'before' });
        let source = first;
        if (reconnect === 'recovered source') {
            first.readyState = 2;
            first.emit('error');
            assert.equal(harness.runRecoveryTimer(), 1000, reconnect);
            source = harness.sources[1];
            assert.notEqual(source, first, reconnect);
        } else {
            // `retry: 1000` then end: the browser reconnects the same source.
            first.readyState = 0;
            first.emit('error');
            assert.equal(harness.elements.get('status').textContent, 'Reconnecting…', reconnect);
        }
        assert.equal(harness.stored.has('ploinky.webtty.session'), true, `${reconnect}: remembered while live`);
        const before = harness.requests.length;
        source.emit('exit', { reason: 'target_identity_changed' });
        await flushTasks();
        assert.equal(harness.elements.get('status').textContent, 'Closed', reconnect);
        assert.equal(harness.elements.get('message').textContent, 'Terminal closed: target_identity_changed.', reconnect);
        assert.equal(harness.terminal.options.disableStdin, true, reconnect);
        assert.equal(harness.elements.get('kill').disabled, true, reconnect);
        assert.equal(source.closed, true, reconnect);
        assert.equal(source.readyState, 2, reconnect);
        assert.equal(harness.timers.size, 0, `${reconnect}: no recovery or resize timer`);
        assert.equal(harness.stored.has('ploinky.webtty.session'), false, `${reconnect}: the ended session is forgotten`);
        const sources = harness.sources.length;
        harness.terminal.emitData('after exit');
        harness.windowListeners.get('resize')();
        harness.elements.get('kill').click();
        source.emit('error');
        harness.advanceClock(60_000);
        await flushTasks();
        assert.equal(harness.timers.size, 0, reconnect);
        assert.equal(harness.sources.length, sources, `${reconnect}: no new EventSource`);
        assert.deepEqual(harness.requests.slice(before), [], `${reconnect}: no input, resize, create, attach or DELETE`);
        assert.equal(harness.requests.filter(({ url }) => url === '/webtty/sessions').length, 1, reconnect);
        assert.equal(deletions(harness).length, 0, reconnect);
    }
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

// ---- Close signal, views, reload and back/forward restore (plan r3 3.5, A9) ----

const SESSION_ID = 'S'.repeat(32);
const ATTACH_TOKEN = 'T'.repeat(32);

function closeIntents(harness) {
    return harness.requests.filter(({ url }) => url === `/webtty/sessions/${SESSION_ID}/close-intents`);
}

function mintHandler({ mintStatus = 201, onAttach = null } = {}) {
    return (url) => {
        if (url === `/webtty/live-sessions/${SESSION_ID}/attach-tokens`) {
            return response(mintStatus, mintStatus === 201
                ? { ok: true, attach: ATTACH_TOKEN, expiresAt: 5000 } : { ok: false, error: 'not_found' });
        }
        if (url === '/webtty/attachments' && onAttach) return onAttach();
        return undefined;
    };
}

test('A9: a top-level owner pagehide sends exactly one keepalive keep intent with the page mutation proof, even from a legacy stop fragment', async () => {
    const harness = createHarness({ hash: `#launch=${'a'.repeat(32)}&close=stop`, sessionOverride: { id: SESSION_ID } });
    await flushTasks();
    // The legacy `close=stop` hint is accepted but every shell is created with Keep running.
    assert.deepEqual(JSON.parse(harness.requests[0].options.body), {
        launch: 'a'.repeat(32), cols: 80, rows: 24, closePolicy: 'keep',
    });
    const view = harness.sources[0].url.split('?view=')[1];
    assert.match(view, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(harness.sources[0].url, `/webtty/sessions/${SESSION_ID}/stream?view=${view}`);
    harness.windowListeners.get('pagehide')();
    harness.windowListeners.get('pagehide')();
    await flushTasks();
    const intents = closeIntents(harness);
    assert.equal(intents.length, 1);
    assert.equal(intents[0].options.method, 'POST');
    assert.equal(intents[0].options.keepalive, true);
    assert.equal(intents[0].options.credentials, 'same-origin');
    // The existing proof: the HttpOnly CSRF cookie with exact Origin, no readable token header.
    assert.deepEqual(JSON.parse(JSON.stringify(intents[0].options.headers)), { 'Content-Type': 'application/json' });
    assert.deepEqual(JSON.parse(intents[0].options.body), { view, policy: 'keep' });
    assert.deepEqual(Object.keys(JSON.parse(intents[0].options.body)), ['view', 'policy']);
    assert.equal(deletions(harness).length, 0);
    assert.equal(harness.requests.filter(({ url }) => url.endsWith('/close-policy')).length, 0);
    assert.deepEqual(harness.posted, []);
});

test('A9: a keep page signals keep; embedded pages and watchers never signal', async () => {
    const keep = createHarness({ sessionOverride: { id: SESSION_ID } });
    await flushTasks();
    keep.windowListeners.get('pagehide')();
    await flushTasks();
    assert.equal(JSON.parse(closeIntents(keep)[0].options.body).policy, 'keep');
    for (const options of [{ embedded: true }, { role: 'watcher' }, { role: 'watcher', embedded: true }]) {
        const harness = createHarness({ ...options, sessionOverride: { id: SESSION_ID } });
        await flushTasks();
        harness.windowListeners.get('pagehide')();
        await flushTasks();
        assert.equal(closeIntents(harness).length, 0, JSON.stringify(options));
        assert.equal(harness.requests.length, 1, JSON.stringify(options));
    }
});

test('A9: an embedded page announces its view only to its parent origin after attach', async () => {
    const harness = createHarness({ embedded: true, sessionOverride: { id: SESSION_ID, profileLabel: 'Robot <A>' } });
    await flushTasks();
    const view = harness.sources[0].url.split('?view=')[1];
    // The page runs in its own realm; compare plain JSON shapes.
    assert.deepEqual(JSON.parse(JSON.stringify(harness.posted)), [{
        message: { type: 'ploinky-webtty:view', sessionId: SESSION_ID, viewId: view, role: 'owner', policy: 'keep' },
        targetOrigin: 'https://app.example.test',
    }]);
    assert.equal(harness.stored.size, 0, 'embedded pages remember nothing');
    assert.equal(harness.elements.get('profile').textContent, 'Profile: Robot <A>');
    assert.equal(harness.elements.get('profile').hidden, false);
    // The page has no policy control, so nothing re-announces or changes the policy.
    harness.windowListeners.get('pagehide')();
    await flushTasks();
    assert.equal(harness.posted.length, 1);
    assert.equal(harness.requests.filter(({ url }) => url.endsWith('/close-policy') || url.endsWith('/close-intents')).length, 0);
});

test('A9: the terminal page has no close-policy selector and never changes the policy', () => {
    assert.doesNotMatch(pageSource, /<select|close-policy|When this tab closes/);
    assert.doesNotMatch(clientSource, /close-policy|getElementById\('close-policy'\)/);
    assert.doesNotMatch(fs.readFileSync(path.join(webttyDirectory, 'webtty.css'), 'utf8'), /close-policy/);
    assert.match(pageSource, /<button id="kill" type="button" disabled>Kill<\/button>/, 'the existing Kill stays');
});

test('A9: an attached legacy Stop-it session still sends only a keep intent on top-level pagehide', async () => {
    for (const role of ['owner', 'watcher']) {
        const harness = createHarness({ hash: `#attach=${'b'.repeat(32)}`, role, sessionOverride: { id: SESSION_ID, closePolicy: 'stop' } });
        await flushTasks();
        assert.equal(harness.sources.length, 1, role);
        const view = harness.sources[0].url.split('?view=')[1];
        harness.windowListeners.get('pagehide')();
        harness.windowListeners.get('pagehide')();
        await flushTasks();
        const intents = closeIntents(harness);
        assert.deepEqual(intents.map(({ options }) => JSON.parse(options.body)), role === 'owner' ? [{ view, policy: 'keep' }] : [], role);
        assert.equal(deletions(harness).length, 0, role);
        assert.equal(harness.requests.filter(({ url }) => url.endsWith('/close-policy')).length, 0, role);
        assert.match(String(harness.stored.get('ploinky.webtty.session')), new RegExp(view), `${role}: recovery storage is retained`);
    }
});

// Addendum A1 r2: the page remembers exactly {sessionId, viewId} as JSON.
const STORED_VIEW = 'w'.repeat(32);
const remembered = (viewId = STORED_VIEW, sessionId = SESSION_ID) => JSON.stringify({ sessionId, viewId });

test('A9: a top-level reload re-attaches the remembered id with a fresh token and never stores tokens', async () => {
    const first = createHarness({ sessionOverride: { id: SESSION_ID } });
    await flushTasks();
    const firstView = first.sources[0].url.split('?view=')[1];
    assert.deepEqual([...first.stored], [['ploinky.webtty.session', remembered(firstView)]]);
    const reload = createHarness({
        hash: '', storage: { 'ploinky.webtty.session': remembered() },
        sessionOverride: { id: SESSION_ID }, requestHandler: mintHandler(),
    });
    await flushTasks();
    assert.deepEqual(reload.requests.map(({ url, options }) => `${options.method} ${url}`), [
        `POST /webtty/live-sessions/${SESSION_ID}/attach-tokens`,
        'POST /webtty/attachments',
    ]);
    // The reload supersedes the view it remembers.
    assert.deepEqual(JSON.parse(reload.requests[0].options.body), { supersedes: STORED_VIEW });
    assert.deepEqual(JSON.parse(reload.requests[1].options.body), { attach: ATTACH_TOKEN, cols: 80, rows: 24 });
    assert.equal(reload.sources.length, 1);
    assert.match(reload.sources[0].url, new RegExp(`^/webtty/sessions/${SESSION_ID}/stream\\?view=`));
    const reloadView = reload.sources[0].url.split('?view=')[1];
    assert.notEqual(reloadView, STORED_VIEW);
    assert.deepEqual([...reload.stored], [['ploinky.webtty.session', remembered(reloadView)]], 'rewritten with the new view');
    assert.ok([...reload.stored.values()].every((value) => !value.includes(ATTACH_TOKEN)));
    assert.equal(reload.elements.get('kill').disabled, false);
});

test('A9: an ended terminal clears the key; storage failures, stale ids and transient errors offer Reopen', async () => {
    for (const where of ['mint', 'attach']) {
        const ended = createHarness({
            hash: '', storage: { 'ploinky.webtty.session': remembered() },
            requestHandler: where === 'mint' ? mintHandler({ mintStatus: 404 })
                : mintHandler({ onAttach: () => response(404, { ok: false, error: 'not_found' }) }),
        });
        await flushTasks();
        assert.equal(ended.elements.get('message').textContent, 'This terminal has ended.', where);
        assert.equal(ended.stored.size, 0, where);
        assert.equal(ended.sources.length, 0, where);
    }
    for (const [name, options, keyKept] of [
        ['storage throws', { storage: 'throws' }, null],
        ['nothing stored', { storage: {} }, null],
        ['stale id', { storage: { 'ploinky.webtty.session': remembered(STORED_VIEW, 'not-a-terminal') } }, false],
        ['legacy bare id', { storage: { 'ploinky.webtty.session': SESSION_ID } }, false],
        ['missing view id', { storage: { 'ploinky.webtty.session': JSON.stringify({ sessionId: SESSION_ID }) } }, false],
        ['malformed view id', { storage: { 'ploinky.webtty.session': remembered('short') } }, false],
        ['extra key', { storage: { 'ploinky.webtty.session': JSON.stringify({ sessionId: SESSION_ID, viewId: STORED_VIEW, attach: ATTACH_TOKEN }) } }, false],
        ['not JSON', { storage: { 'ploinky.webtty.session': '{"sessionId":' } }, false],
        ['transient failure', { storage: { 'ploinky.webtty.session': remembered() }, requestHandler: () => response(503, {}) }, true],
        ['embedded page', { storage: { 'ploinky.webtty.session': remembered() }, embedded: true }, true],
    ]) {
        const harness = createHarness({ hash: '', ...options });
        await flushTasks();
        assert.equal(harness.elements.get('status').textContent, 'Reopen terminal', name);
        assert.match(harness.elements.get('message').textContent, /Reopen this terminal from Live Sessions/, name);
        assert.equal(harness.sources.length, 0, name);
        if (keyKept !== null) assert.equal(harness.stored.has('ploinky.webtty.session'), keyKept, name);
        if (name === 'embedded page' || keyKept === false) assert.equal(harness.requests.length, 0, `${name}: no request without known ids`);
    }
});

test('A9: a back/forward restore re-enables the page, re-attaches as a new view and re-announces when embedded', async () => {
    for (const embedded of [false, true]) {
        const harness = createHarness({ embedded, sessionOverride: { id: SESSION_ID }, requestHandler: mintHandler() });
        await flushTasks();
        const firstView = harness.sources[0].url.split('?view=')[1];
        harness.windowListeners.get('pagehide')();
        await flushTasks();
        assert.equal(harness.terminal.options.disableStdin, true);
        assert.equal(harness.elements.get('kill').disabled, true);
        harness.windowListeners.get('pageshow')({ persisted: false });
        await flushTasks();
        assert.equal(harness.sources.length, 1, 'a fresh (non-cached) show does nothing');
        harness.windowListeners.get('pageshow')({ persisted: true });
        await flushTasks();
        const order = harness.requests.map(({ url }) => url).filter((url) => !url.endsWith('/close-intents'));
        assert.deepEqual(order.slice(-2), [`/webtty/live-sessions/${SESSION_ID}/attach-tokens`, '/webtty/attachments']);
        // The restored page supersedes its own previous view (addendum A1 r2).
        const mint = harness.requests.findLast(({ url }) => url.endsWith('/attach-tokens'));
        assert.deepEqual(JSON.parse(mint.options.body), { supersedes: firstView });
        assert.equal(harness.sources.length, 2);
        const secondView = harness.sources[1].url.split('?view=')[1];
        assert.notEqual(secondView, firstView);
        assert.equal(harness.terminal.options.disableStdin, false);
        assert.equal(harness.elements.get('kill').disabled, false);
        harness.terminal.cols = 100;
        harness.windowListeners.get('resize')();
        harness.terminal.emitData('typed');
        await flushTasks();
        assert.ok(harness.requests.some(({ url }) => url.endsWith('/resize')), 'resize works again');
        assert.ok(harness.requests.some(({ url }) => url.endsWith('/input')), 'input works again');
        if (embedded) {
            assert.deepEqual(harness.posted.map(({ message }) => message.viewId), [firstView, secondView]);
            assert.equal(harness.stored.size, 0, 'an embedded page remembers nothing');
        } else {
            assert.deepEqual([...harness.stored], [['ploinky.webtty.session', remembered(secondView)]],
                'rewritten after the back/forward re-attach');
            // The restored page signals again for its new view on its next close.
            harness.windowListeners.get('pagehide')();
            await flushTasks();
            assert.deepEqual(closeIntents(harness).map(({ options }) => JSON.parse(options.body).view), [firstView, secondView]);
        }
    }
});

test('A9: only #launch=<id> or #launch=<id>&close=stop launch, both with keep; any other extra key is rejected', async () => {
    for (const hash of [
        `#launch=${'a'.repeat(32)}&close=keep`,
        `#launch=${'a'.repeat(32)}&close=STOP`,
        `#launch=${'a'.repeat(32)}&close=stop&close=stop`,
        `#launch=${'a'.repeat(32)}&close=stop&extra=1`,
        `#close=stop&launch=${'a'.repeat(32)}`,
        `#attach=${'a'.repeat(32)}&close=stop`,
    ]) {
        const harness = createHarness({ hash });
        await flushTasks();
        assert.equal(harness.requests.length, 0, hash);
        assert.equal(harness.elements.get('status').textContent, 'Reopen terminal', hash);
    }
    const stop = createHarness({ hash: `#launch=${'a'.repeat(32)}&close=stop` });
    await flushTasks();
    assert.equal(JSON.parse(stop.requests[0].options.body).closePolicy, 'keep');
    const keep = createHarness({ hash: `#launch=${'a'.repeat(32)}` });
    await flushTasks();
    assert.equal(JSON.parse(keep.requests[0].options.body).closePolicy, 'keep');
});

test('A9: a create response without a server view is invalid and rolls back', async () => {
    const harness = createHarness({ viewOverride: null });
    await flushTasks();
    assert.equal(deletions(harness).length, 1);
    assert.equal(harness.sources.length, 0);
    assert.equal(harness.elements.get('status').textContent, 'Unavailable');
});

test('A9-S: the remembered value is exactly {sessionId, viewId} after an attach handoff, never a token', async () => {
    const token = 'a'.repeat(32);
    const harness = createHarness({ hash: `#attach=${token}`, sessionOverride: { id: SESSION_ID } });
    await flushTasks();
    const view = harness.sources[0].url.split('?view=')[1];
    const [[key, value]] = [...harness.stored];
    assert.equal(key, 'ploinky.webtty.session');
    assert.deepEqual(Object.keys(JSON.parse(value)).sort(), ['sessionId', 'viewId']);
    assert.equal(value, remembered(view));
    assert.doesNotMatch(value, new RegExp(token));
    // A plain attach handoff (Live Sessions attach or pop-out) never claims anything.
    assert.deepEqual(Object.keys(JSON.parse(harness.requests[0].options.body)).sort(), ['attach', 'cols', 'rows']);
});
