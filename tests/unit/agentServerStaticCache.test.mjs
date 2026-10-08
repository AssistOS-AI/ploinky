import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const AGENT_SERVER = path.join(REPO_ROOT, 'Agent/server/AgentServer.mjs');

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function startServer(t) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-static-'));
    const code = path.join(tmp, 'code');
    await fs.mkdir(code);
    await fs.writeFile(path.join(code, 'app.js'), 'console.log(1);\n');
    await fs.writeFile(path.join(code, 'index.html'), '<html></html>\n');
    await fs.writeFile(path.join(code, 'font.woff2'), 'x');
    await fs.writeFile(path.join(code, 'logo.png'), 'x');
    const configPath = path.join(tmp, 'mcp-config.json');
    await fs.writeFile(configPath, JSON.stringify({ tools: [] }));
    const port = await freePort();
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if (name.startsWith('PLOINKY_AGENT_') || name.startsWith('PLOINKY_ROUTER_')) delete env[name];
    }
    const child = spawn(process.execPath, [AGENT_SERVER], {
        cwd: tmp,
        env: {
            ...env, HOME: tmp, PORT: String(port), PLOINKY_AGENT_BIND_HOST: '127.0.0.1',
            PLOINKY_AGENT_CONFIG: configPath, PLOINKY_CODE_DIR: code,
            PLOINKY_AGENT_SECRET: 'ab'.repeat(32), PLOINKY_AGENT_ID: 'agent:static-test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => { output += c.toString('utf8'); });
    child.stderr.on('data', (c) => { output += c.toString('utf8'); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill('SIGKILL');
            await exited;
        }
        await fs.rm(tmp, { recursive: true, force: true });
    });
    const deadline = Date.now() + 5000;
    for (;;) {
        try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* retry */ }
        if (Date.now() > deadline) throw new Error(`AgentServer did not start:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { base: `http://127.0.0.1:${port}`, code };
}

test('agent static: 200 carries validators and private scope, 304 on matching validators, HTML is no-store', async (t) => {
    const { base } = await startServer(t);

    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('cache-control'), 'private, max-age=300');
    const etag = js.headers.get('etag');
    const lastModified = js.headers.get('last-modified');
    assert.match(etag, /^W\/"\d+-\d+-\d+"$/);
    assert.ok(Number.isFinite(Date.parse(lastModified)));
    assert.equal(await js.text(), 'console.log(1);\n');

    const byTag = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } });
    assert.equal(byTag.status, 304);
    assert.equal(byTag.headers.get('etag'), etag);
    assert.equal(byTag.headers.get('cache-control'), 'private, max-age=300');
    assert.equal(await byTag.text(), '');

    const byList = await fetch(`${base}/app.js`, { headers: { 'if-none-match': `"other", ${etag}` } });
    assert.equal(byList.status, 304);

    const mismatch = await fetch(`${base}/app.js`, { headers: { 'if-none-match': 'W/"1-1-1"' } });
    assert.equal(mismatch.status, 200);
    await mismatch.arrayBuffer();

    const byDate = await fetch(`${base}/app.js`, { headers: { 'if-modified-since': lastModified } });
    assert.equal(byDate.status, 304);

    const stale = await fetch(`${base}/app.js`, { headers: { 'if-modified-since': new Date(0).toUTCString() } });
    assert.equal(stale.status, 200);
    await stale.arrayBuffer();

    // If-None-Match takes precedence over If-Modified-Since.
    const precedence = await fetch(`${base}/app.js`, {
        headers: { 'if-none-match': 'W/"1-1-1"', 'if-modified-since': lastModified },
    });
    assert.equal(precedence.status, 200);
    await precedence.arrayBuffer();

    const html = await fetch(`${base}/index.html`, { headers: { 'if-none-match': '*' } });
    assert.equal(html.headers.get('cache-control'), 'no-store');
    await html.arrayBuffer();
    const root = await fetch(`${base}/`);
    assert.equal(root.headers.get('cache-control'), 'no-store');
    await root.arrayBuffer();

    const font = await fetch(`${base}/font.woff2`);
    assert.equal(font.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    await font.arrayBuffer();
    const png = await fetch(`${base}/logo.png`);
    assert.equal(png.headers.get('cache-control'), 'private, max-age=86400');
    await png.arrayBuffer();

    const head = await fetch(`${base}/app.js`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('etag'), etag);
});
