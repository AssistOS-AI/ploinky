import crypto from 'node:crypto';
import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';

import { WEBTTY_PROTOCOL_LIMITS } from '../../core-services/webtty/worker-protocol.mjs';

// A command-line view of a WebTTY terminal. The Router owns the terminal; this
// client only streams its output (SSE), sends keystrokes and resizes. Leaving
// detaches: the terminal keeps running and can be attached again. Only the
// terminal's own exit, or a kill from a list of sessions, ends it.

const LOCAL_AUTH_COOKIE = 'ploinky_jwt';
const CSRF_COOKIE = 'ploinky_browser_csrf';
const CSRF_HEADER = 'x-ploinky-browser-csrf-token';
const REQUEST_TIMEOUT_MS = 60_000;
// The Router closes a terminal whose input exceeds 512 KiB in 10 s; stay below.
const INPUT_WINDOW_MS = 10_000;
const INPUT_WINDOW_BYTES = 384 * 1024;
const RESIZE_DELAY_MS = 80;
const SIZE_CLAIM_INTERVAL_MS = 500;
// Ctrl+] detaches this view; it never reaches the terminal.
export const DETACH_KEY = '\x1d';
export const RELAY_KEY_LABELS = Object.freeze({ detach: 'Ctrl+]' });
const RECONNECT_LIMIT_MS = 60_000;

export class RouterRequestError extends Error {
    constructor(status, body) {
        const detail = typeof body?.error === 'string' ? body.error : '';
        super(detail || `Router request failed with HTTP ${status}`);
        this.status = status;
        this.body = body;
    }
}

function cookieFrom(setCookie, name) {
    for (const entry of Array.isArray(setCookie) ? setCookie : [setCookie || '']) {
        const [pair] = String(entry).split(';');
        const separator = pair.indexOf('=');
        if (separator > 0 && pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
    }
    return '';
}

// Talks to the in-Box Router as the signed local CLI operator. Every request
// carries a fresh token for one stable session id, so the Router sees one
// login for the life of the command and its browser proof stays valid.
export class LocalRouterClient {
    constructor({ port, host = '127.0.0.1', mintSessionToken, request = http.request }) {
        this.host = host;
        this.port = port;
        this.origin = `http://${host}:${port}`;
        this.sid = `sess_${crypto.randomBytes(16).toString('base64url')}`;
        this.mintSessionToken = mintSessionToken;
        this.request = request;
        this.csrf = '';
    }

    headers(extra = {}) {
        const cookies = [`${LOCAL_AUTH_COOKIE}=${this.mintSessionToken(this.sid)}`];
        if (this.csrf) cookies.push(`${CSRF_COOKIE}=${this.csrf}`);
        return { cookie: cookies.join('; '), ...extra };
    }

    remember(response) {
        const token = cookieFrom(response.headers?.['set-cookie'], CSRF_COOKIE);
        if (token) this.csrf = token;
    }

    send(method, pathname, body = undefined, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
        const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const headers = this.headers({
            accept: 'application/json',
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
            ...(method === 'GET' ? {} : { origin: this.origin, ...(this.csrf ? { [CSRF_HEADER]: this.csrf } : {}) }),
        });
        return new Promise((resolve, reject) => {
            const req = this.request({ host: this.host, port: this.port, method, path: pathname, headers }, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('error', reject);
                res.on('end', () => {
                    this.remember(res);
                    let parsed = null;
                    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch (_) { }
                    resolve({ status: res.statusCode, body: parsed });
                });
            });
            req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('Router request timed out'), {
                code: 'ROUTER_TIMEOUT',
            })));
            req.on('error', reject);
            req.end(payload || undefined);
        });
    }

    // A browser-proof refusal is refreshed once through a read, as WebTTY's own page does.
    async json(method, pathname, body) {
        if (method !== 'GET' && !this.csrf) await this.send('GET', '/webtty/live-sessions');
        let response = await this.send(method, pathname, body);
        if (response.status === 403 && response.body?.error === 'browser_csrf_invalid') {
            await this.send('GET', '/webtty/live-sessions');
            response = await this.send(method, pathname, body);
        }
        if (response.status < 200 || response.status >= 300 || response.body?.ok === false) {
            throw new RouterRequestError(response.status, response.body);
        }
        return response.body;
    }

    openStream(pathname, lastEventId) {
        return this.request({
            host: this.host,
            port: this.port,
            method: 'GET',
            path: pathname,
            headers: this.headers({
                accept: 'text/event-stream',
                ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}),
            }),
        });
    }
}

// Incremental Server-Sent Events parser: feed text, receive {id, event, data}.
export function createSseParser(onEvent) {
    let buffer = '';
    return (text) => {
        buffer += text.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const message = { id: null, event: 'message', data: '' };
            const data = [];
            for (const line of block.split('\n')) {
                if (!line || line.startsWith(':')) continue;
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                if (field === 'id') message.id = value;
                else if (field === 'event') message.event = value;
                else if (field === 'data') data.push(value);
            }
            if (!data.length && message.id === null && message.event === 'message') continue;
            message.data = data.join('\n');
            onEvent(message);
        }
    };
}

export function terminalDimensions(output) {
    const clamp = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isSafeInteger(value) ? value : fallback));
    return {
        cols: clamp(output?.columns, WEBTTY_PROTOCOL_LIMITS.minColumns, WEBTTY_PROTOCOL_LIMITS.maxColumns, 80),
        rows: clamp(output?.rows, WEBTTY_PROTOCOL_LIMITS.minRows, WEBTTY_PROTOCOL_LIMITS.maxRows, 24),
    };
}

function takeUtf8Chunk(value, maxBytes) {
    if (Buffer.byteLength(value) <= maxBytes) return [value, ''];
    let bytes = 0;
    let offset = 0;
    for (const character of value) {
        const size = Buffer.byteLength(character);
        if (bytes + size > maxBytes) break;
        bytes += size;
        offset += character.length;
    }
    return [value.slice(0, offset), value.slice(offset)];
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Relays one WebTTY view to this process's terminal until the terminal exits,
// the view ends, the person detaches, or the local terminal goes away.
// Resolves {reason}: 'detached' comes from the key, and any reason other than
// an exit leaves the terminal running.
export class TerminalRelay {
    constructor({ client, sessionId, viewId, input = process.stdin, output = process.stdout, signals = process,
        now = () => Date.now(), keys = { detach: DETACH_KEY } }) {
        Object.assign(this, { client, sessionId, viewId, input, output, signals, now, keys });
        this.sizeClaimed = false;
        // Whether this view set the terminal's size last; another window may take it.
        this.holdsSize = true;
        this.lastClaimAt = 0;
        this.base = `/webtty/sessions/${encodeURIComponent(sessionId)}`;
        this.decoder = new StringDecoder('utf8');
        this.pending = '';
        this.flushing = null;
        this.inputWindow = { startedAt: 0, bytes: 0 };
        this.lastEventId = '';
        this.stream = null;
        this.finished = false;
        this.resizeTimer = null;
    }

    run() {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.onData = chunk => this.queueInput(this.decoder.write(chunk));
            this.onEnd = () => this.finish({ reason: 'input_closed' });
            // Resizing this terminal is an explicit act: it claims the shared
            // terminal's size for this window, like the browser's button does.
            this.onResize = () => {
                clearTimeout(this.resizeTimer);
                this.resizeTimer = setTimeout(() => { void this.sendResize({ claim: true }); }, RESIZE_DELAY_MS);
            };
            this.onSignal = () => this.finish({ reason: 'signal' });
            if (this.input.isTTY && typeof this.input.setRawMode === 'function') this.input.setRawMode(true);
            this.input.on('data', this.onData);
            this.input.once('end', this.onEnd);
            this.input.once('error', this.onEnd);
            this.input.resume();
            this.output.on?.('resize', this.onResize);
            for (const signal of ['SIGHUP', 'SIGTERM']) this.signals.on?.(signal, this.onSignal);
            void this.connect();
        });
    }

    async connect() {
        let failingSince = null;
        let backoff = 250;
        while (!this.finished) {
            const outcome = await this.readStream();
            if (this.finished) return;
            if (outcome.final) { this.finish(outcome.final); return; }
            if (outcome.connected) {
                // A stream the Router ended (a new route generation, an expired login) resumes from the last event.
                failingSince = null;
                backoff = 250;
                await delay(100);
                continue;
            }
            failingSince ??= this.now();
            if (this.now() - failingSince > RECONNECT_LIMIT_MS) {
                this.finish({ reason: 'disconnected', error: 'The terminal connection could not be restored.' });
                return;
            }
            await delay(backoff);
            backoff = Math.min(backoff * 2, 5_000);
        }
    }

    readStream() {
        return new Promise((resolve) => {
            let connected = false;
            let settled = false;
            const settle = (value) => { if (!settled) { settled = true; this.stream = null; resolve(value); } };
            const req = this.client.openStream(`${this.base}/stream?view=${encodeURIComponent(this.viewId)}`, this.lastEventId);
            this.stream = req;
            req.on('response', (res) => {
                if (res.statusCode === 404) {
                    res.resume();
                    settle({ final: { reason: 'ended' } });
                    return;
                }
                if (res.statusCode !== 200) { res.resume(); settle({ connected: false }); return; }
                connected = true;
                // Attaching takes the terminal's size, and the first attach makes
                // the program redraw at it; a reconnect only re-asserts it.
                if (!this.finished) {
                    void (this.sizeClaimed ? this.sendResize() : this.sendResize({ claim: true, redraw: true }));
                    this.sizeClaimed = true;
                }
                const decoder = new StringDecoder('utf8');
                const parse = createSseParser(event => this.handleEvent(event, settle));
                res.on('data', chunk => parse(decoder.write(chunk)));
                res.on('end', () => settle({ connected }));
                res.on('error', () => settle({ connected }));
            });
            req.on('error', () => settle({ connected }));
            req.end();
        });
    }

    handleEvent(event, settle) {
        let data = {};
        try { data = event.data ? JSON.parse(event.data) : {}; } catch (_) { }
        if (event.event === 'output') {
            if (event.id) this.lastEventId = event.id;
            if (typeof data.data === 'string') this.output.write(data.data);
        } else if (event.event === 'size') {
            this.holdsSize = !data.view || data.view === this.viewId;
        } else if (event.event === 'resync') {
            this.output.write('\x1bc');
        } else if (event.event === 'exit') {
            settle({ final: { reason: 'exited', detail: String(data.reason || '') } });
        } else if (event.event === 'reset') {
            settle({ final: { reason: 'reset', error: 'Terminal output could not be replayed; reopen it from Live Sessions.' } });
        } else if (event.event === 'detached' && data.reason === 'view_ended') {
            settle({ final: { reason: 'view_ended' } });
        }
        // Any other detach (an expired login, a slow reader) reconnects.
    }

    queueInput(text) {
        if (!text || this.finished) return;
        // Typing here takes the size back from a window that took it meanwhile.
        if (!this.holdsSize && this.now() - this.lastClaimAt >= SIZE_CLAIM_INTERVAL_MS) {
            this.lastClaimAt = this.now();
            this.holdsSize = true;
            void this.sendResize({ claim: true });
        }
        const detach = this.keys?.detach ? text.indexOf(this.keys.detach) : -1;
        if (detach >= 0) {
            // Keystrokes typed before the key still reach the terminal.
            this.pending += text.slice(0, detach);
            this.input.pause();
            this.startFlush();
            void Promise.resolve(this.flushing).catch(() => {}).then(() => this.finish({ reason: 'detached' }));
            return;
        }
        this.pending += text;
        this.startFlush();
    }

    // One ordered sender: keystrokes arriving during a request follow it.
    startFlush() {
        if (this.flushing || !this.pending || this.finished) return;
        this.flushing = this.flushInput().catch((error) => {
            this.finish({ reason: 'input_failed', error: error?.message || 'Input could not be sent.' });
        }).finally(() => {
            this.flushing = null;
            this.startFlush();
        });
    }

    async waitForInputBudget(bytes) {
        const now = this.now();
        if (now - this.inputWindow.startedAt >= INPUT_WINDOW_MS) this.inputWindow = { startedAt: now, bytes: 0 };
        if (this.inputWindow.bytes + bytes <= INPUT_WINDOW_BYTES) {
            this.inputWindow.bytes += bytes;
            return;
        }
        await delay(Math.max(1, this.inputWindow.startedAt + INPUT_WINDOW_MS - now));
        this.inputWindow = { startedAt: this.now(), bytes };
    }

    async flushInput() {
        while (this.pending && !this.finished) {
            const [data, rest] = takeUtf8Chunk(this.pending, WEBTTY_PROTOCOL_LIMITS.maxInputBytes);
            this.pending = rest;
            await this.waitForInputBudget(Buffer.byteLength(data));
            for (let attempt = 0; ; attempt += 1) {
                try {
                    await this.client.json('POST', `${this.base}/input`, { data });
                    break;
                } catch (error) {
                    if (error?.status === 404) { this.finish({ reason: 'ended' }); return; }
                    if (error?.status !== 429 || attempt >= 5) throw error;
                    await delay(1_000);
                }
            }
        }
    }

    // A redraw first sets one row less: a program redraws only when its size
    // changes, and an attach at the size it already has must repaint it too.
    async sendResize({ claim = false, redraw = false } = {}) {
        if (this.finished) return;
        const dimensions = terminalDimensions(this.output);
        try {
            const view = this.viewId ? { view: this.viewId } : {};
            if (redraw && dimensions.rows > WEBTTY_PROTOCOL_LIMITS.minRows) {
                await this.client.json('POST', `${this.base}/resize`,
                    { cols: dimensions.cols, rows: dimensions.rows - 1, ...(claim ? { claim: true } : {}), ...view });
            }
            await this.client.json('POST', `${this.base}/resize`,
                { ...dimensions, ...(claim ? { claim: true } : {}), ...view });
        } catch (_) { /* A missed resize is corrected by the next one. */ }
    }

    finish(result) {
        if (this.finished) return;
        this.finished = true;
        clearTimeout(this.resizeTimer);
        this.input.off('data', this.onData);
        this.input.off('end', this.onEnd);
        this.input.off('error', this.onEnd);
        if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
            try { this.input.setRawMode(false); } catch (_) { }
        }
        this.input.pause();
        this.output.off?.('resize', this.onResize);
        for (const signal of ['SIGHUP', 'SIGTERM']) this.signals.off?.(signal, this.onSignal);
        try { this.stream?.destroy(); } catch (_) { }
        const leave = ['exited', 'ended', 'view_ended'].includes(result.reason)
            ? Promise.resolve()
            // Any other way out detaches: this view ends and the terminal keeps running.
            : this.client.json('POST', `${this.base}/close-intents`, { view: this.viewId, policy: 'keep' }).catch(() => {});
        void leave.then(() => this.resolve(result));
    }
}
