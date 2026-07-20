import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PREFIX = '/base-agent-additional-server/alpha/7000/app';
const WRAPPER = process.env.PLOINKY_PLAYWRIGHT_CLI
    || '/Users/danielsava/.codex/skills/playwright/scripts/playwright_cli.sh';

function websocketAccept(key) {
    return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

test('real browser keeps every mounted application request under the conventional base path', { timeout: 45_000 }, async (t) => {
    assert.equal(fs.existsSync(WRAPPER), true, `Playwright CLI wrapper is unavailable: ${WRAPPER}`);
    const fixture = JSON.parse(fs.readFileSync(new URL('../../fixtures/routing-proxy/browser-app.json', import.meta.url), 'utf8'));
    assert.equal(fixture.mountedApplications.length, 1);
    const requests = [];
    const connections = new Set();
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        res.setHeader('access-control-allow-origin', req.headers.origin || '*');
        if (req.url === `${PREFIX}/`) {
            res.setHeader('content-type', 'text/html');
            res.setHeader('set-cookie', `app_session=fixture; Path=${PREFIX}/; SameSite=Lax`);
            res.end(`<!doctype html><html><head><link rel="icon" href="./favicon.ico"><link rel="stylesheet" href="./style.css"></head><body data-ready="no">
                <main id="status">loading</main><script>
                const prefix = ${JSON.stringify(PREFIX)};
                const checks = { asset: false, api: false, redirect: false, sse: false, websocket: false };
                fetch('./style.css').then(r => { checks.asset = r.ok; });
                fetch('./api/data').then(r => r.json()).then(v => { checks.api = v.ok === true; });
                fetch('./redirect').then(r => r.text()).then(v => { checks.redirect = v === 'redirect-ok'; });
                const events = new EventSource('./events');
                events.onmessage = event => { checks.sse = event.data === 'sse-ok'; events.close(); };
                const socket = new WebSocket('ws://' + location.host + prefix + '/socket');
                socket.onmessage = event => { checks.websocket = event.data === 'ws-ok'; socket.close(); };
                const timer = setInterval(() => { if (Object.values(checks).every(Boolean)) {
                    clearInterval(timer); document.body.dataset.ready = 'yes'; document.querySelector('#status').textContent = 'ready';
                } }, 20);
                </script></body></html>`);
            return;
        }
        if (req.url === `${PREFIX}/favicon.ico`) return res.end('icon');
        if (req.url === `${PREFIX}/style.css`) return res.end('body{color:rgb(1,2,3)}');
        if (req.url === `${PREFIX}/api/data`) return res.end(JSON.stringify({ ok: true }));
        if (req.url === `${PREFIX}/redirect`) { res.statusCode = 302; res.setHeader('location', `${PREFIX}/final`); return res.end(); }
        if (req.url === `${PREFIX}/final`) return res.end('redirect-ok');
        if (req.url === `${PREFIX}/events`) {
            res.setHeader('content-type', 'text/event-stream');
            return res.end('data: sse-ok\n\n');
        }
        res.statusCode = 404;
        res.end('missing');
    });
    server.on('upgrade', (req, socket) => {
        requests.push(req.url);
        if (req.url !== `${PREFIX}/socket`) return socket.destroy();
        socket.write([
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Accept: ${websocketAccept(req.headers['sec-websocket-key'])}`,
            '', '',
        ].join('\r\n'));
        socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('ws-ok')]));
        socket.on('data', frame => {
            if ((frame[0] & 0x0f) === 0x08) {
                socket.end(Buffer.from([0x88, 0x00]));
            }
        });
    });
    server.on('connection', socket => {
        connections.add(socket);
        socket.once('close', () => connections.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const session = `ploinky-routing-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const cliCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-playwright-'));
    t.after(() => fs.rmSync(cliCwd, { recursive: true, force: true }));
    const run = args => new Promise(resolve => {
        const child = spawn(WRAPPER, [`-s=${session}`, ...args], { cwd: cliCwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        const errors = [];
        const timer = setTimeout(() => child.kill(), 30_000);
        child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => errors.push(Buffer.from(chunk)));
        child.once('close', status => {
            clearTimeout(timer);
            resolve({ status, stdout: Buffer.concat(chunks).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') });
        });
    });
    let browserOpened = false;
    t.after(async () => {
        if (browserOpened) await run(['close']);
        for (const socket of connections) socket.destroy();
        server.closeAllConnections?.();
        await new Promise(resolve => server.close(resolve));
    });
    const opened = await run(['open', `http://127.0.0.1:${port}${PREFIX}/`]);
    assert.equal(opened.status, 0, opened.stderr || opened.stdout);
    browserOpened = true;
    const evaluated = await run(['eval', "() => new Promise((resolve, reject) => { const end = Date.now() + 8000; const poll = () => { if (document.body.dataset.ready === 'yes') return resolve({ ready: true, path: location.pathname, cookie: document.cookie, text: document.querySelector('#status').textContent }); if (Date.now() > end) return reject(new Error('application checks timed out')); setTimeout(poll, 25); }; poll(); })"]);
    assert.equal(evaluated.status, 0, evaluated.stderr || evaluated.stdout);
    assert.match(evaluated.stdout, /"ready": true/);
    assert.match(evaluated.stdout, new RegExp(PREFIX.replaceAll('/', '\\/')));
    assert.match(evaluated.stdout, /app_session=fixture/);
    const closed = await run(['close']);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    browserOpened = false;
    const expected = fixture.mountedApplications[0].checks;
    assert.deepEqual(expected, ['html', 'relative-asset', 'api', 'redirect', 'cookie', 'cors', 'sse', 'websocket']);
    assert.ok(requests.length >= 7, `expected browser traffic, received ${requests.join(', ')}`);
    assert.equal(requests.every(value => String(value).startsWith(`${PREFIX}/`)), true, requests.join('\n'));
});
