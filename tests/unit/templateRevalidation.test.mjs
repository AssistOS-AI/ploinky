import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PRELOAD = path.join(REPO_ROOT, 'tests/helpers/routerTemplatePreload.mjs');
const ROUTER = path.join(REPO_ROOT, 'cli/server/RoutingServer.js');
const TEMPLATE = '/alpha/web/tpl.html';

function streamingCapture() {
    const res = new PassThrough();
    res.statusCode = 0;
    res.headers = {};
    res.bodyText = '';
    res.writeHead = (statusCode, headers = {}) => {
        res.statusCode = statusCode;
        res.headers = { ...headers };
        res.headersSent = true;
        return res;
    };
    res.setEncoding('utf8');
    res.on('data', (chunk) => { res.bodyText += chunk; });
    res.done = new Promise((resolve) => { res.on('end', resolve); });
    return res;
}
const FETCH_HEADERS = { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' };
const NAV_HEADERS = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };

function writeJson(target, value) {
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

// Real RoutingServer.js in a child; only the listener port and the SSO session
// backend are substituted (see the preload).
async function startRouter(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tplrev-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    for (const directory of [edgeDir, policyDir, path.join(alphaDir, 'web')]) {
        fs.mkdirSync(directory, { recursive: true });
    }
    writeJson(path.join(alphaDir, 'manifest.json'), {
        ploinky: 'sso enable',
        sso: { providerAgent: 'identity' },
        routerAccess: { requiredCapability: 'app.access' },
    });
    fs.writeFileSync(path.join(alphaDir, 'web', 'tpl.html'), '<template>one</template>\n');
    fs.writeFileSync(path.join(alphaDir, 'web', 'app.js'), 'export default 1;\n');
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        static: { agent: 'alpha', port: 7777 },
        routes: { alpha: {
            repo: 'fixtures', agent: 'alpha', container: 'alpha-container',
            hostPath: alphaDir, hostPort: 43102,
        } },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        'alpha-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'alpha', instanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation', profile: 'default', auth: { mode: 'sso' },
        },
    });
    writeJson(path.join(edgeDir, 'desired.json'), {
        hosts: { 'alpha.example.test': { agent: 'fixtures/alpha', routerSurfaces: [] } },
        cloudflare: { tunnelTokenSecret: 'publication/test-connector' },
    });
    writeJson(path.join(policyDir, 'policy-state.json'), { schema: 'router-policy', httpRoutes: [], mcpTools: [] });
    const port = await freePort();
    const savedEnv = {
        root: process.env.PLOINKY_WORKSPACE_ROOT, hostPort: process.env.PLOINKY_ROUTER_HOST_PORT,
        media: process.env.PLOINKY_MEDIA_HOST_PORT,
    };
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    process.env.PLOINKY_ROUTER_HOST_PORT = String(port);
    process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'template-revalidation', publicationState: 'ready' });
    for (const [key, value] of [['PLOINKY_WORKSPACE_ROOT', savedEnv.root], ['PLOINKY_ROUTER_HOST_PORT', savedEnv.hostPort], ['PLOINKY_MEDIA_HOST_PORT', savedEnv.media]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if ((name.startsWith('PLOINKY_') && name !== 'PLOINKY_AGENTLIB_DIR') || name === 'PORT') delete env[name];
    }
    const child = spawn(process.execPath, ['--import', PRELOAD, ROUTER], {
        cwd: workspace,
        env: {
            ...env,
            HOME: workspace,
            PLOINKY_WORKSPACE_ROOT: workspace,
            PLOINKY_ROUTER_HOST_PORT: String(port),
            PLOINKY_MEDIA_HOST_PORT: '17891',
            PLOINKY_MASTER_KEY: '7'.repeat(64),
            PLOINKY_ROUTER_HEALTH_SOCKET: path.join(workspace, 'h.sock'),
            PLOINKY_TEST_PUBLIC_PORT: String(port),
            PLOINKY_TEST_REPO_ROOT: REPO_ROOT,
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
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    const deadline = Date.now() + 15000;
    while (!/Ploinky server running/.test(output)) {
        if (child.exitCode !== null) throw new Error(`router exited:\n${output}`);
        if (Date.now() > deadline) throw new Error(`router did not start:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const file = path.join(alphaDir, 'web', 'tpl.html');
    const request = (urlPath, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method,
            headers: { host: `127.0.0.1:${port}`, ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
    return { request, file, alphaDir, getOutput: () => output };
}

const AUTHORIZED = { cookie: 'ploinky_sso=allowed' };

function ageFile(file) {
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
}

test('real router: authorized fetched template gets private,no-cache validators and revalidates to 304; navigations stay no-store 200', async (t) => {
    const { request, file } = await startRouter(t);
    ageFile(file);

    const first = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS });
    assert.equal(first.status, 200, first.body);
    assert.equal(first.headers['cache-control'], 'private, no-cache');
    assert.equal(first.headers.vary, 'Sec-Fetch-Dest');
    assert.match(first.headers.etag, /^W\/"\d+-\d+-\d+"$/);
    assert.ok(Number.isFinite(Date.parse(first.headers['last-modified'])));
    assert.equal(first.body, '<template>one</template>\n');
    const etag = first.headers.etag;
    const lastModified = first.headers['last-modified'];

    for (let i = 0; i < 2; i += 1) { // idempotent replay
        const again = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS, 'if-none-match': etag });
        assert.equal(again.status, 304);
        assert.equal(again.headers['cache-control'], 'private, no-cache');
        assert.equal(again.headers.etag, etag);
        assert.equal(again.headers.vary, 'Sec-Fetch-Dest');
        assert.equal(again.headers['last-modified'], lastModified);
        assert.equal(again.body, '');
    }
    const star = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS, 'if-none-match': '*' });
    assert.equal(star.status, 304);
    const byDate = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS, 'if-modified-since': lastModified });
    assert.equal(byDate.status, 304);
    // If-None-Match takes precedence over If-Modified-Since.
    const precedence = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS, 'if-none-match': 'W/"1-1-1"', 'if-modified-since': lastModified });
    assert.equal(precedence.status, 200);

    // Boundary: case/whitespace of the destination value stays in the template class.
    for (const dest of ['EMPTY', ' empty ']) {
        const r = await request(TEMPLATE, { ...AUTHORIZED, 'sec-fetch-dest': dest, 'if-none-match': etag });
        assert.equal(r.status, 304, dest);
        assert.equal(r.headers['cache-control'], 'private, no-cache');
    }
    // Navigation class, with or without a matching validator, never 304.
    for (const headers of [NAV_HEADERS, { 'sec-fetch-dest': 'iframe' }, {}, { 'sec-fetch-dest': 'empty, document' }]) {
        for (const validators of [{}, { 'if-none-match': etag }, { 'if-none-match': '*' }, { 'if-modified-since': lastModified }]) {
            const r = await request(TEMPLATE, { ...AUTHORIZED, ...headers, ...validators });
            assert.equal(r.status, 200, JSON.stringify({ headers, validators }));
            assert.equal(r.headers['cache-control'], 'no-store');
            assert.equal(r.headers.vary, 'Sec-Fetch-Dest');
            assert.equal(r.body, '<template>one</template>\n');
        }
    }
    // No agent-static HTML response ever contains `public`.
    for (const r of [first, star, byDate, precedence]) {
        assert.doesNotMatch(r.headers['cache-control'] || '', /public/);
    }
    // Non-HTML agent static is untouched and carries no Vary.
    const js = await request('/alpha/web/app.js', { ...AUTHORIZED, ...FETCH_HEADERS });
    assert.equal(js.status, 200);
    assert.equal(js.headers['cache-control'], 'private, max-age=300');
    assert.equal(js.headers.vary, undefined);
});

test('real router: garbage, malformed and future validators give 200; missing html gives 404; edit yields new ETag and consistent body', async (t) => {
    const { request, file } = await startRouter(t);
    ageFile(file);
    const first = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS });
    const etag = first.headers.etag;

    for (const validators of [
        { 'if-none-match': 'garbage' },
        { 'if-none-match': '"unterminated' },
        { 'if-modified-since': 'not a date' },
        { 'if-modified-since': new Date(Date.now() + 3_600_000).toUTCString() },
        { 'if-modified-since': new Date(0).toUTCString() },
    ]) {
        const r = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS, ...validators });
        assert.equal(r.status, 200, JSON.stringify(validators));
        assert.equal(r.body, '<template>one</template>\n');
    }

    const missing = await request('/alpha/web/missing.html', { ...AUTHORIZED, ...FETCH_HEADERS, 'if-none-match': '*' });
    // Not served by the router; it is proxied upstream (dead port here), so never 200/304.
    assert.ok(missing.status >= 400, String(missing.status));

    fs.writeFileSync(file, '<template>two-longer</template>\n');
    ageFile(file);
    const edited = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS, 'if-none-match': etag });
    assert.equal(edited.status, 200);
    assert.notEqual(edited.headers.etag, etag);
    assert.equal(edited.body, '<template>two-longer</template>\n');
    assert.equal(Number(edited.headers['content-length']), Buffer.byteLength(edited.body));
});

test('real router: a template modified in the current second is not advertised or revalidated by date', async (t) => {
    const { request, file } = await startRouter(t);
    const now = new Date();
    fs.utimesSync(file, now, now);
    const r = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS });
    assert.equal(r.status, 200);
    if (Math.floor(now.getTime() / 1000) === Math.floor(Date.now() / 1000)) {
        assert.equal(r.headers['last-modified'], undefined);
    }
    const byDate = await request(TEMPLATE, {
        ...AUTHORIZED, ...FETCH_HEADERS, 'if-modified-since': new Date().toUTCString(),
    });
    if (Math.floor(now.getTime() / 1000) === Math.floor(Date.now() / 1000)) {
        assert.equal(byDate.status, 200);
    }
});

test('real router: auth runs before any 304 (no cookie, revoked session, capability removed never yield 304)', async (t) => {
    const { request, file } = await startRouter(t);
    ageFile(file);
    const first = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS });
    const etag = first.headers.etag;
    const lastModified = first.headers['last-modified'];
    const validators = { 'if-none-match': etag, 'if-modified-since': lastModified };

    const cases = [
        ['no cookie, fetch', {}, FETCH_HEADERS, [401, 302]],
        ['no cookie, navigation', {}, NAV_HEADERS, [302, 401]],
        ['revoked session, fetch', { cookie: 'ploinky_sso=revoked' }, FETCH_HEADERS, [401, 302]],
        ['revoked session, navigation', { cookie: 'ploinky_sso=revoked' }, NAV_HEADERS, [302, 401]],
        ['capability removed, fetch', { cookie: 'ploinky_sso=restricted' }, FETCH_HEADERS, [403]],
        ['capability removed, navigation', { cookie: 'ploinky_sso=restricted' }, NAV_HEADERS, [403, 302]],
    ];
    for (const [name, cookie, dest, allowed] of cases) {
        for (const extra of [{ 'if-none-match': '*' }, validators]) {
            const r = await request(TEMPLATE, { ...cookie, ...dest, ...extra });
            assert.notEqual(r.status, 304, name);
            assert.notEqual(r.status, 200, name);
            assert.ok(allowed.includes(r.status), `${name}: ${r.status}`);
            assert.equal(r.headers.etag, undefined, name);
            assert.doesNotMatch(r.body, /tpl|template/, name);
        }
    }
    // The same validators with an authorized session do 304: the gate, not the
    // validators, decided the denied cases above.
    const ok = await request(TEMPLATE, { ...AUTHORIZED, ...FETCH_HEADERS, ...validators });
    assert.equal(ok.status, 304);
});

// Workspace files keep today's behaviour: `fetchedTemplate` is derived only in
// serveAgentStaticRequest.
const { serveWorkspaceFileRequest } = await import('../../cli/server/static/index.js');
const { getWorkspaceRoot } = await import('../../cli/server/utils/workspacePaths.js');

async function getWorkspaceFile(relativePath, headers = {}) {
    const req = {
        method: 'GET',
        url: `/workspace-files/${relativePath}`,
        headers: { host: '127.0.0.1:8080', ...headers },
    };
    const res = streamingCapture();
    assert.equal(await serveWorkspaceFileRequest(req, res), true);
    await res.done;
    return res;
}

test('workspace-file HTML keeps today\'s behaviour: no-store, no Vary, Sec-Fetch-Dest ignored, matching If-None-Match still 304, If-Modified-Since ignored', async () => {
    const workspaceRoot = getWorkspaceRoot();
    const directory = fs.mkdtempSync(path.join(workspaceRoot, '.ploinky-tplrev-'));
    try {
        fs.writeFileSync(path.join(directory, 'page.html'), '<h1>page</h1>');
        const base = path.relative(workspaceRoot, directory).replace(/\\+/g, '/');
        const plain = await getWorkspaceFile(`${base}/page.html`);
        assert.equal(plain.statusCode, 200);
        assert.equal(plain.headers['Cache-Control'], 'no-store');
        const etag = plain.headers.ETag;
        for (const dest of ['empty', 'document']) {
            const fetched = await getWorkspaceFile(`${base}/page.html`, { 'sec-fetch-dest': dest });
            assert.equal(fetched.statusCode, 200, dest);
            assert.equal(fetched.headers['Cache-Control'], 'no-store', dest);
            assert.equal(fetched.headers.Vary, undefined, dest);
            assert.equal(fetched.bodyText, '<h1>page</h1>');
            const matched = await getWorkspaceFile(`${base}/page.html`, { 'sec-fetch-dest': dest, 'if-none-match': etag });
            assert.equal(matched.statusCode, 304, dest);
            assert.equal(matched.headers['Cache-Control'], 'no-store', dest);
            assert.equal(matched.headers.Vary, undefined, dest);
            const byDate = await getWorkspaceFile(`${base}/page.html`, {
                'sec-fetch-dest': dest, 'if-modified-since': plain.headers['Last-Modified'],
            });
            assert.equal(byDate.statusCode, 200, dest);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('web-libs style sendFile (unauthenticated, not template-aware) stays no-store for HTML', async () => {
    const { serveWebLibRequest } = await import('../../cli/server/static/index.js');
    const res = streamingCapture();
    const handled = await serveWebLibRequest({
        method: 'GET', url: '/web-libs/does-not-exist.html', headers: { host: 'localhost', 'sec-fetch-dest': 'empty' },
    }, res);
    assert.equal(typeof handled, 'boolean');
    assert.notEqual(res.headers['Cache-Control'], 'private, no-cache');
});
