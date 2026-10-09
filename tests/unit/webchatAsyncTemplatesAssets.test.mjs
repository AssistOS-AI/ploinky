import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installWebchatBindingFixture } from '../helpers/webchatBindingFixture.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e5-async-')));
const staticRoot = path.join(root, 'override');
const fallback = path.join(sourceRoot, 'cli/server/webchat');
fs.mkdirSync(path.join(root, '.ploinky/running'), { recursive: true });
fs.mkdirSync(path.join(staticRoot, 'web/webchat/assets'), { recursive: true });
fs.mkdirSync(path.join(root, 'project'));
fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
const routingPath = path.join(root, '.ploinky/routing.json');
const manifestPath = path.join(staticRoot, 'manifest.json');
function writeRouting() {
    fs.writeFileSync(routingPath, JSON.stringify({ static: { agent: 'fixture', hostPath: staticRoot },
        routes: { fixture: { hostPath: staticRoot, repo: 'fixture-repo', agent: 'fixture' } } }));
}
writeRouting();
fs.writeFileSync(manifestPath, JSON.stringify({ cli: 'run fixture', webchat: { forwardEnvelope: true } }));
fs.writeFileSync(path.join(root, '.ploinky/servers.json'), JSON.stringify({ webchat: { port: 12345, agent: 'fixture' } }));
fs.writeFileSync(path.join(root, '.ploinky/running/webchat.pid'), String(process.pid));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = root;
const staticSrv = await import('../../cli/server/static/index.js');
const commands = await import('../../cli/server/webchat/commandResolver.js');
const launch = await import('../../cli/server/handlers/webchat/launchOptions.js');
const { handleWebChat } = await import('../../cli/server/handlers/webchat/index.js');
const { handleStatus } = await import('../../cli/server/handlers/status.js');
const { handleWebtty } = await import('../../cli/server/handlers/webtty.js');
const { workspaceMetricsMonitor } = await import('../../cli/server/workspaceMetrics.js');
const servers = await import('../../cli/server/serverManager.js');
const ttyFactories = await import('../../cli/server/utils/ttyFactories.js');
const { resolveAgentRepositoryName } = await import('../../cli/utils/agentRepositorySource.mjs');
test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
});

// Page and runtime requests carry the binding Router auth attaches for the
// fixture route; writeRouting() owns the exact route provenance it binds.
const binding = installWebchatBindingFixture(root, {
    routeKey: 'fixture', hostPath: staticRoot, repo: 'fixture-repo', agent: 'fixture', container: '',
});
writeRouting();
function request(url) {
    return binding.bind({ url, method: 'GET', headers: { host: '127.0.0.1' }, socket: {},
        user: { id: 'local:admin', roles: ['admin', 'user'] }, destroyed: false });
}
function response() {
    const res = new PassThrough();
    res.statusCode = 0;
    res.headers = {};
    res.body = '';
    res.setHeader = (key, value) => { res.headers[key] = value; };
    res.getHeader = key => res.headers[key];
    res.writeHead = (status, headers = {}) => {
        res.statusCode = status; Object.assign(res.headers, headers); res.headersSent = true;
    };
    res.on('data', chunk => { res.body += chunk.toString(); });
    res.ended = new Promise(resolve => res.on('end', resolve));
    return res;
}
const appConfig = { agentName: 'fixture', getFactoryForCommands: () => ({ agentName: 'fixture', ttyFactory: {} }) };
const state = () => ({ sessions: new Map(), runtimes: new Map() });
async function get(url) {
    const res = response();
    await handleWebChat(request(url), res, appConfig, state());
    await res.ended;
    return res;
}
async function withoutSyncFs(fn) {
    const originals = new Map();
    const calls = [];
    for (const name of Object.keys(fs).filter(name => name.endsWith('Sync') && typeof fs[name] === 'function')) {
        const original = fs[name]; originals.set(name, original);
        fs[name] = (...args) => { calls.push(name); return original(...args); };
    }
    try { await fn(); } finally { for (const [name, original] of originals) fs[name] = original; }
    assert.deepEqual(calls, [], 'converted request path must use no synchronous fs');
}

test('async asset resolution matches sync priority and confinement for every bundled file and override', async () => {
    const names = fs.readdirSync(fallback, { recursive: true })
        .filter(name => fs.statSync(path.join(fallback, name)).isFile());
    fs.writeFileSync(path.join(staticRoot, 'web/webchat/assets/e5-priority.txt'), 'first');
    fs.mkdirSync(path.join(staticRoot, 'apps/webchat'), { recursive: true });
    fs.writeFileSync(path.join(staticRoot, 'apps/webchat/e5-priority.txt'), 'second');
    fs.writeFileSync(path.join(root, 'external.txt'), 'outside allowed roots');
    fs.symlinkSync(path.join(root, 'external.txt'), path.join(staticRoot, 'web/webchat/outside'));
    for (const name of [...names, 'e5-priority.txt', 'outside', '../outside', 'missing']) {
        assert.equal(await staticSrv.resolveAssetPathAsync('webchat', fallback, name),
            staticSrv.resolveAssetPath('webchat', fallback, name), name);
    }
    assert.equal(await staticSrv.resolveAssetPathAsync('webchat', fallback, 'e5-priority.txt'),
        path.join(staticRoot, 'web/webchat/assets/e5-priority.txt'));
});

test('async multi-template lookup reads routing once and observes the very next routing edit', async () => {
    const original = fs.promises.readFile;
    let reads = 0;
    fs.promises.readFile = async (...args) => {
        if (args[0] === routingPath) reads += 1;
        return original(...args);
    };
    try {
        assert.equal(await staticSrv.resolveFirstAvailableAsync('webchat', fallback, ['absent.html', 'chat.html']),
            path.join(fallback, 'chat.html'));
        assert.equal(reads, 1);
    } finally { fs.promises.readFile = original; }
    fs.writeFileSync(path.join(staticRoot, 'web/webchat/chat.html'), '<html>fresh override</html>');
    assert.equal(await staticSrv.resolveFirstAvailableAsync('webchat', fallback, ['chat.html']),
        path.join(staticRoot, 'web/webchat/chat.html'));
    fs.writeFileSync(routingPath, '{}');
    assert.equal(await staticSrv.resolveFirstAvailableAsync('webchat', fallback, ['chat.html']), path.join(fallback, 'chat.html'));
    writeRouting();
    fs.unlinkSync(path.join(staticRoot, 'web/webchat/chat.html'));
});

test('async commands match sync output, preserve all manifest errors and observe immediate edits', async () => {
    for (const cliArgs of [[], ['--dir=space path', '--robot=a']]) {
        assert.deepEqual(await commands.resolveWebchatCommandsForAgentAsync('fixture', { cliArgs }),
            commands.resolveWebchatCommandsForAgent('fixture', { cliArgs }));
        assert.deepEqual(await commands.resolveWebchatCommandsAsync({ cliArgs }), commands.resolveWebchatCommands({ cliArgs }));
    }
    assert.equal(await commands.resolveWebchatCommandsForAgentAsync('unknown'), null);
    for (const content of ['bad json', JSON.stringify({ cli: 'changed command' })]) {
        fs.writeFileSync(manifestPath, content);
        assert.deepEqual(await commands.resolveWebchatCommandsForAgentAsync('fixture'), commands.resolveWebchatCommandsForAgent('fixture'));
        assert.deepEqual(await commands.resolveWebchatCommandsAsync(), commands.resolveWebchatCommands());
    }
    const original = fs.promises.readFile;
    fs.promises.readFile = async (...args) => {
        if (args[0] === manifestPath) throw Object.assign(new Error('fixture EIO'), { code: 'EIO' });
        return original(...args);
    };
    try {
        assert.equal((await commands.resolveWebchatCommandsForAgentAsync('fixture')).container, '');
        assert.equal((await commands.resolveWebchatCommandsAsync()).source, 'unset');
    } finally { fs.promises.readFile = original; }
});

test('async launch options match sync aliases and confine workspace skill roots', async () => {
    for (const query of ['workspace-dir=project&robot=a', 'dir=project', 'workspaceDir=project',
        'workspace-skill-root=project', 'workspaceSkillRoot=escape', 'workspace-skill-root=../outside']) {
        const url = new URL(`http://localhost/webchat/?${query}`);
        assert.deepEqual(await launch.resolveWebchatLaunchOptionsAsync(url), launch.resolveWebchatLaunchOptions(url));
    }
    await assert.rejects(launch.resolveWebchatLaunchOptionsAsync(new URL('http://localhost/webchat/?workspace-dir=../outside')),
        /Invalid WebChat workspace directory/);
    assert.equal((await get('/webchat/?workspace-dir=../outside')).statusCode, 400);
});

test('WebChat page, task view and directories return complete awaited handler bodies', async () => {
    for (const url of ['/webchat/', '/webchat/tasks/task_0123456789abcdef01234567/view']) {
        const res = await get(url);
        assert.equal(res.statusCode, 200, url);
        assert.match(res.body, /<!doctype html|<html/i, url);
        assert.ok(res.body.length > 100);
    }
    const listing = await get('/webchat/directories');
    assert.equal(listing.statusCode, 200);
    assert.ok(JSON.parse(listing.body).entries.some(entry => entry.name === 'project'));
    // Router auth rejects an unknown selector (404) before the handler; a page
    // request without a target binding is refused rather than launched.
    assert.equal((await get('/webchat/?agent=unknown')).statusCode, 503);
});

test('assets, templates, commands and status handler use zero synchronous fs calls', async () => {
    await withoutSyncFs(async () => {
        assert.equal((await get('/webchat/assets/markdown.js')).statusCode, 200);
        assert.equal((await get('/webchat/?agent=fixture')).statusCode, 200);
        const res = response();
        await handleStatus(request('/status/data'), res);
        await res.ended;
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.servers.webchat.running, true);
        assert.equal(body.servers.webchat.pid, process.pid);
        assert.equal(body.static.repo, 'fixture-repo');
    });
    assert.deepEqual(await servers.getAllServerStatusesAsync(), servers.getAllServerStatuses());
});

test('web-libs uses async confinement and preserves public file bytes', async () => {
    const libs = path.join(sourceRoot, 'webLibs');
    const name = fs.readdirSync(libs, { recursive: true }).find(entry => fs.statSync(path.join(libs, entry)).isFile());
    assert.ok(name, 'existing library positive control');
    const expected = fs.readFileSync(path.join(libs, name));
    await withoutSyncFs(async () => {
        const res = response();
        const url = `/web-libs/${name.split(path.sep).map(encodeURIComponent).join('/')}`;
        assert.equal(await staticSrv.serveWebLibRequest(request(url), res), true);
        await res.ended;
        assert.equal(res.statusCode, 200);
        assert.equal(Buffer.from(res.body).toString(), expected.toString());
    });
});

test('empty boot commands resolve once asynchronously per request and remain fresh', async () => {
    fs.writeFileSync(routingPath, '{}');
    const { getWebchatFactory } = await ttyFactories.initializeTTYFactories();
    const config = ttyFactories.createServiceConfig(getWebchatFactory);
    writeRouting();
    const original = fs.promises.readFile;
    let manifestReads = 0;
    fs.promises.readFile = async (...args) => {
        if (args[0] === manifestPath) manifestReads += 1;
        return original(...args);
    };
    try {
        for (const forwardEnvelope of [false, true]) {
            fs.writeFileSync(manifestPath, JSON.stringify({ cli: 'fixture', webchat: { forwardEnvelope } }));
            await withoutSyncFs(async () => {
                const req = request('/webchat/');
                const res = response();
                let result;
                await handleWebChat(req, res, async options => {
                    result = await config.resolveWebchatForRequest(options);
                    return result;
                }, state());
                await res.ended;
                assert.equal(res.statusCode, 200);
                assert.ok(res.body.length > 100);
                assert.equal(result.agentName, 'fixture');
                assert.equal(result.forwardEnvelope, forwardEnvelope);
                assert.ok(result.ttyFactory, 'factory available without spawning a tty');
            });
        }
        // Per request: one default resolution plus one bound-target check, no cache.
        assert.equal(manifestReads, 4, 'one default and one bound-target resolution per request, no cache');
    } finally { fs.promises.readFile = original; }
});

test('nonempty boot commands keep startup selection without request reads', async () => {
    const { getWebchatFactory } = await ttyFactories.initializeTTYFactories();
    const config = ttyFactories.createServiceConfig(getWebchatFactory);
    fs.writeFileSync(routingPath, '{}');
    const original = fs.promises.readFile;
    let reads = 0;
    fs.promises.readFile = async (...args) => { reads += 1; return original(...args); };
    try {
        const result = await config.resolveWebchatForRequest({
            req: request('/webchat/'), res: response(), workspaceBase: { root, base: root },
        });
        assert.equal(result.agentName, 'fixture');
        assert.equal(reads, 0);
    } finally { fs.promises.readFile = original; writeRouting(); }
});

test('default command resolution stops before factory allocation when destroyed', async () => {
    let resume;
    const pending = new Promise(resolve => { resume = resolve; });
    let allocations = 0;
    const factory = () => { allocations += 1; return { factory: {} }; };
    factory.resolveCommandsForRequest = () => pending;
    const config = ttyFactories.createServiceConfig(factory);
    const req = request('/webchat/');
    const res = response();
    const running = config.resolveWebchatForRequest({ req, res, workspaceBase: { root, base: root } });
    req.destroyed = true;
    resume({ host: 'fixture' });
    assert.equal(await running, null);
    assert.equal(allocations, 0);
});

test('status retains repository-name fallback identity when a legacy route omits repo', async () => {
    const routing = JSON.parse(fs.readFileSync(routingPath, 'utf8'));
    delete routing.routes.fixture.repo;
    const expected = resolveAgentRepositoryName(staticRoot);
    fs.writeFileSync(routingPath, JSON.stringify(routing));
    try {
        const res = response();
        await handleStatus(request('/status/data'), res);
        await res.ended;
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).static.repo, expected);
    } finally { writeRouting(); }
});

test('WebTTY async reads preserve bytes, headers and asset 503 versus page rejection', async () => {
    const manager = { availability: () => ({ ok: true }) };
    const url = '/webtty/assets/webtty-bootstrap.js';
    const expected = fs.readFileSync(path.join(sourceRoot, 'cli/server/webtty/webtty-bootstrap.js'), 'utf8');
    await withoutSyncFs(async () => {
        const res = response();
        assert.equal(await handleWebtty(request(url), res, new URL(url, 'http://localhost'), { manager }), true);
        await res.ended;
        assert.equal(res.body, expected);
        assert.equal(res.headers['Content-Length'], Buffer.byteLength(expected));
        assert.equal(res.headers['Content-Type'], 'application/javascript; charset=utf-8');
        assert.equal(res.headers['Cache-Control'], 'no-store');
        assert.match(res.headers['Content-Security-Policy'], /default-src 'none'/);
    });
    const original = fs.promises.readFile;
    fs.promises.readFile = async () => { throw new Error('fixture read failure'); };
    try {
        const res = response();
        await handleWebtty(request(url), res, new URL(url, 'http://localhost'), { manager });
        assert.equal(res.statusCode, 503);
        assert.equal(JSON.parse(res.body).error, 'webtty_asset_unavailable');
        await assert.rejects(handleWebtty(request('/webtty'), response(), new URL('http://localhost/webtty'), { manager }),
            /fixture read failure/);
    } finally { fs.promises.readFile = original; }
});

async function pauseIo(method, predicate, invoke, abort, inspect) {
    const original = fs.promises[method];
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    let resume;
    const pending = new Promise(resolve => { resume = resolve; });
    let paused = false;
    fs.promises[method] = async (...args) => {
        if (!paused && predicate(args[0])) { paused = true; enter(); await pending; }
        return original(...args);
    };
    try {
        const running = invoke();
        await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(new Error('I/O not reached')), 2000).unref())]);
        abort(); resume(); await running; inspect();
    } finally { resume(); fs.promises[method] = original; }
}

test('aborted WebChat preamble allocates no tty, runtime, subscriber, interval or close cleanup', async () => {
    for (const [method, predicate, query] of [
        ['realpath', target => target === root, ''],
        ['realpath', target => target === path.join(root, 'project'), '&workspace-skill-root=project'],
        ['readFile', target => target === routingPath, '&agent=fixture'],
    ]) {
        for (const abortedSide of ['req', 'res']) {
            const req = request(`/webchat/stream?tabId=test${query}`);
            const res = response();
            const appState = state();
            let ttys = 0;
            let intervals = 0;
            const timers = [];
            const original = globalThis.setInterval;
            globalThis.setInterval = (...args) => {
                intervals += 1;
                const timer = original(...args); timers.push(timer); return timer;
            };
            const ttyFactory = { create() {
                ttys += 1;
                return { onOutput() {}, onClose() {}, isAlive: () => true, write: () => true };
            } };
            const config = { ...appConfig, ttyFactory,
                getFactoryForCommands: () => ({ agentName: 'fixture', ttyFactory }) };
            try {
                await pauseIo(method, predicate,
                    () => handleWebChat(req, res, config, appState),
                    () => { if (abortedSide === 'req') req.destroyed = true; else res.destroy(); },
                    () => {
                        assert.equal(ttys, 0); assert.equal(appState.runtimes.size, 0);
                        assert.equal([...appState.runtimes.values()].reduce((n, runtime) => n + runtime.subscribers.size, 0), 0);
                        assert.equal(appState.sessions.size, 0); assert.equal(intervals, 0);
                        assert.equal(res.listenerCount('close'), 0);
                    });
            } finally {
                globalThis.setInterval = original;
                for (const timer of timers) clearInterval(timer);
                res.destroy();
            }
        }
    }
});

test('aborted status preparation adds no metrics subscriber or response-close cleanup', async () => {
    const original = workspaceMetricsMonitor.subscribe;
    let subscribers = 0;
    workspaceMetricsMonitor.subscribe = () => { subscribers += 1; return () => {}; };
    try {
        for (const file of ['servers.json', 'routing.json']) {
            for (const side of ['req', 'res']) {
                const req = request('/status/data?follow=1');
                const res = response();
                await pauseIo('readFile', target => target === path.join(root, '.ploinky', file),
                    () => handleStatus(req, res), () => { if (side === 'req') req.destroyed = true; else res.destroy(); }, () => {
                        assert.equal(subscribers, 0); assert.equal(res.listenerCount('close'), 0);
                        assert.equal(res.statusCode, 0);
                    });
            }
        }
    } finally { workspaceMetricsMonitor.subscribe = original; }
});
