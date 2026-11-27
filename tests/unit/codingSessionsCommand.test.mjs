import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseOuterArguments } from '../../ploinky-box/command/parse.mjs';
import { routeOuterCommand } from '../../ploinky-box/command/route.mjs';
import { codingSessionDeclaration, listCodingSessionProviders } from '../../cli/utils/codingSessionProviders.mjs';
import { fit, ListMenu, moveSelection, parseKeys, renderMenu, TERMINAL_INPUT_RESET } from '../../cli/utils/codingSessionsMenu.mjs';
import {
    attachSessionTerminal,
    listLiveSessions,
    openSessionTerminal,
    parseSessionProfile,
    runCodingSessionsCommand,
    sessionItems,
    workspaceRelativeDirectory,
} from '../../cli/commands/codingSessionsCommand.js';
import { createSseParser, LocalRouterClient, TerminalRelay } from '../../cli/utils/webttyCliClient.mjs';

const API = '/base-agent-additional-server/robots/3001/api/coding-sessions';
const DECLARATION = { version: 1, api: API };
const MANIFEST = { webtty: { homeProfiles: { version: 2, resolve: '/x' }, codingSessions: DECLARATION } };
const PROVIDER = { routeKey: 'robots', agent: 'robots', repo: 'Repo', version: 1, api: API };

function workspace(t, routes, manifests) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-coding-sessions-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    for (const [routeKey, route] of Object.entries(routes)) {
        route.hostPath = path.join(root, 'agents', routeKey);
        fs.mkdirSync(route.hostPath, { recursive: true });
        if (manifests[routeKey]) fs.writeFileSync(path.join(route.hostPath, 'manifest.json'), JSON.stringify(manifests[routeKey]));
    }
    fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080, routes }));
    return root;
}

test('a coding session declaration names one API base on the declaring agent surface', () => {
    assert.deepEqual(codingSessionDeclaration(MANIFEST, 'robots'), DECLARATION);
    for (const declaration of [
        { ...DECLARATION, version: 2 },
        { ...DECLARATION, extra: true },
        { version: 1, names: ['codex'], launch: API },
        { ...DECLARATION, api: '/base-agent-additional-server/other/3001/api' },
        { ...DECLARATION, api: '/api/coding-sessions' },
        { ...DECLARATION, api: `${API}?x=1` },
        { ...DECLARATION, api: `${API}/` },
    ]) {
        assert.equal(codingSessionDeclaration({ webtty: { ...MANIFEST.webtty, codingSessions: declaration } }, 'robots'), null);
    }
    // Launched profiles are home profiles, so the provider must also offer them.
    assert.equal(codingSessionDeclaration({ webtty: { codingSessions: DECLARATION } }, 'robots'), null);
});

test('providers are the enabled routes whose manifests declare coding sessions', (t) => {
    const root = workspace(t, {
        robots: { agent: 'robots', repo: 'Repo' },
        plain: { agent: 'plain', repo: 'Repo' },
        disabled: { agent: 'disabled', repo: 'Repo', disabled: true },
    }, { robots: MANIFEST, plain: { about: 'none' }, disabled: { webtty: { ...MANIFEST.webtty,
        codingSessions: { version: 1, api: '/base-agent-additional-server/disabled/3001/api' } } } });
    assert.deepEqual(listCodingSessionProviders(root).map(provider => [provider.routeKey, provider.repo, provider.api]),
        [['robots', 'Repo', API]]);
    assert.deepEqual(listCodingSessionProviders(path.join(root, 'missing')), []);
    assert.deepEqual(listCodingSessionProviders('relative'), []);
});

test('the host gives the coding sessions command a terminal and keeps other commands generic', () => {
    const route = argv => routeOuterCommand(parseOuterArguments(argv));
    for (const argv of [['cs'], ['code'], ['coding'], ['coding', 'agents'], ['coding', 'sessions'], ['coding-sessions']]) {
        assert.deepEqual(route(argv), { kind: 'coding-sessions', coreArgv: argv });
        assert.equal(route(['--dry-run', ...argv]).kind, 'dry-run');
    }
    // Coding agents are no longer commands of their own, and --robot is no longer an option.
    assert.equal(route(['codex']).kind, 'generic');
    assert.throws(() => parseOuterArguments(['--robot', 'ana']), /Unknown outer option --robot/);
    assert.equal(route(['cli', 'codex']).kind, 'agent-cli');
    assert.equal(route([]).kind, 'repl');
});

test('the folder is workspace relative and a folder outside the workspace is refused', (t) => {
    const root = workspace(t, {}, {});
    fs.mkdirSync(path.join(root, 'project', 'src'), { recursive: true });
    assert.equal(workspaceRelativeDirectory(root, path.join(root, 'project', 'src')), 'project/src');
    assert.equal(workspaceRelativeDirectory(root, root), '');
    assert.throws(() => workspaceRelativeDirectory(root, os.tmpdir()), { code: 'PLOINKY_CODING_SESSIONS_DIRECTORY' });
});

test('a session profile names the robot, the coding agent and the native conversation when known', () => {
    assert.deepEqual(parseSessionProfile('ana-1.default.codex'), { robotId: 'ana-1', codingAgent: 'codex', nativeSessionId: null });
    assert.deepEqual(parseSessionProfile('ana-1.default.claude.n-abc-1'), { robotId: 'ana-1', codingAgent: 'claude', nativeSessionId: 'abc-1' });
    assert.deepEqual(parseSessionProfile('ana-1.default.opencode.r-ses_1'), { robotId: 'ana-1', codingAgent: 'opencode', nativeSessionId: 'ses_1' });
    assert.deepEqual(parseSessionProfile('ana-1.default.codex.p-launch-1'), { robotId: 'ana-1', codingAgent: 'codex', nativeSessionId: null });
    for (const value of [null, 'ana-1.default', 'ana-1.default.codex.x-1', 'a.b.c.r-1.e']) assert.equal(parseSessionProfile(value), null);
});

function fakeClient(answers) {
    const calls = [];
    return {
        calls,
        async json(method, pathname, body) {
            calls.push([method, pathname, body]);
            const answer = answers[`${method} ${pathname}`];
            if (answer instanceof Error) throw answer;
            return typeof answer === 'function' ? answer(body) : answer;
        },
    };
}

const liveRow = (overrides = {}) => ({ id: 'l'.repeat(32), source: 'webtty', status: 'detached', profileProvider: 'robots',
    profileId: 'ana-1.default.claude.n-abc-1', cwd: 'project', viewerCount: 0, lastActivityAt: 1000, ...overrides });

test('live sessions are the running terminals of the provider for the robot agent in the folder', async () => {
    const rows = [liveRow(), liveRow({ id: 'a'.repeat(32), status: 'exited' }), liveRow({ id: 'b'.repeat(32), profileProvider: 'other' }),
        liveRow({ id: 'c'.repeat(32), profileId: 'ana-1.default.codex' }), liveRow({ id: 'd'.repeat(32), cwd: 'elsewhere' }),
        liveRow({ id: 'e'.repeat(32), profileId: 'bob-1.default.claude' }), { id: 'f'.repeat(32), source: 'agent' }];
    const client = fakeClient({ 'GET /webtty/live-sessions': { ok: true, sessions: rows } });
    const live = await listLiveSessions(client, PROVIDER, { robotId: 'ana-1', codingAgent: 'claude', directory: 'project' });
    assert.deepEqual(live.map(row => [row.id, row.nativeSessionId]), [['l'.repeat(32), 'abc-1']]);
});

test('the session list offers a new session, then running terminals, then conversations no terminal holds', () => {
    const items = sessionItems({
        live: [{ ...liveRow(), nativeSessionId: 'abc-1', viewerCount: 1, status: 'attached' }, { ...liveRow({ id: 'x'.repeat(32) }), nativeSessionId: null }],
        history: [{ id: 'abc-1', title: 'Running chat', updatedAt: 500 }, { id: 'old', title: 'Old chat', updatedAt: 0 }],
        now: 61_000,
    });
    assert.deepEqual(items.map(item => [item.kind, item.label]), [
        ['new', '+ New session'], ['live', '● Running chat'], ['live', '● new session'], ['history', '  Old chat']]);
    assert.equal(items[1].detail, 'attached · 1 view · 1m ago');
});

test('opening a launched profile creates a terminal that outlives its view', async () => {
    const row = { launch: 'l'.repeat(32), kind: 'agent', detail: 'Repo/robots', access: 'rw' };
    const client = fakeClient({
        'POST /webtty/target-discoveries': { ok: true, discovery: { id: 'd'.repeat(32), targets: [
            { launch: 'x'.repeat(32), kind: 'agent', detail: 'Repo/other', access: 'rw' }, row] } },
        'POST /webtty/sessions': { ok: true, session: { id: 's'.repeat(32) }, view: { id: 'v'.repeat(32) } },
    });
    const terminal = await openSessionTerminal(client, PROVIDER, { profile: 'ana-1.default.codex' }, { directory: 'project', output: { columns: 120, rows: 40 } });
    assert.deepEqual(terminal, { sessionId: 's'.repeat(32), viewId: 'v'.repeat(32) });
    assert.deepEqual(client.calls, [
        ['POST', '/webtty/target-discoveries', { dir: 'project', profile: { provider: 'robots', id: 'ana-1.default.codex' } }],
        ['POST', '/webtty/sessions', { launch: row.launch, cols: 120, rows: 40, closePolicy: 'keep' }],
    ]);
});

test('an unavailable provider row cancels its discovery and says why', async () => {
    for (const [targets, message] of [
        [[], /cannot reach project/],
        [[{ kind: 'agent', detail: 'Repo/robots', access: 'rw', unavailable: 'quarantined' }], /Repo\/robots is quarantined .*ploinky restart/],
        [[{ kind: 'agent', detail: 'Repo/robots', access: 'rw', unavailable: 'home-unreachable' }], /cannot see the robot home/],
    ]) {
        const client = fakeClient({
            'POST /webtty/target-discoveries': { ok: true, discovery: { id: 'd'.repeat(32), targets } },
            [`DELETE /webtty/target-discoveries/${'d'.repeat(32)}`]: { ok: true },
        });
        await assert.rejects(openSessionTerminal(client, PROVIDER, { profile: 'p.default.codex' }, { directory: 'project', output: {} }), message);
        assert.equal(client.calls.at(-1)[0], 'DELETE');
    }
    await assert.rejects(openSessionTerminal(fakeClient({}), PROVIDER, {}, { directory: 'project', output: {} }), /did not return a terminal profile/);
});

test('attaching a running terminal mints a token and creates a view at this terminal size', async () => {
    const client = fakeClient({
        [`POST /webtty/live-sessions/${'l'.repeat(32)}/attach-tokens`]: { ok: true, attach: 't'.repeat(32) },
        'POST /webtty/attachments': { ok: true, session: { id: 's'.repeat(32) }, view: { id: 'v'.repeat(32) } },
    });
    assert.deepEqual(await attachSessionTerminal(client, liveRow(), { output: { columns: 90, rows: 20 } }), { sessionId: 's'.repeat(32), viewId: 'v'.repeat(32) });
    assert.deepEqual(client.calls[1], ['POST', '/webtty/attachments', { attach: 't'.repeat(32), cols: 90, rows: 20 }]);
});

test('menu keys, selection movement and rendering', () => {
    assert.deepEqual(parseKeys('\x1b[A\x1b[Bq\r\x7f\x1b[3~k\x1b'), ['up', 'down', 'q', 'enter', 'back', 'delete', 'k', 'escape']);
    assert.equal(moveSelection(0, 'up', 3), 0);
    assert.equal(moveSelection(0, 'down', 3), 1);
    assert.equal(moveSelection(1, 'end', 3), 2);
    assert.equal(moveSelection(2, 'pageDown', 3), 2);
    assert.equal(fit('abcdef', 4), 'abc…');
    assert.equal(fit('a\u001bb', 10), 'a b');
    const lines = renderMenu({ title: ['Title'], items: [{ label: 'one' }, { label: 'two', detail: 'x' }], selected: 1, status: 'note', help: 'keys', columns: 40, rows: 10 });
    assert.equal(lines.length, 10);
    assert.match(lines[0], /Title/);
    assert.match(lines[3], /\x1b\[7m▸ two/);
    assert.match(lines.at(-2), /note/);
    assert.match(lines.at(-1), /keys/);
});

test('mouse, focus and keyboard-protocol reports a detached agent left on never read as menu keys', async () => {
    // A legacy X10 mouse report at column 78 carries the raw byte "n", which once started a new session.
    const x10 = `\x1b[M${String.fromCharCode(32 + 35, 32 + 78, 32 + 10)}`;
    assert.deepEqual(parseKeys(`${x10}\x1b[<35;78;10M\x1b[<0;5;5m\x1b[I\x1b[O\x1b[13u\x1b[200~`), Array(7).fill('unknown'));
    assert.deepEqual(parseKeys(`${x10}n\x1bOB\r`), ['unknown', 'n', 'down', 'enter']);
    // Opening and closing the menu switch those reports off.
    const written = [];
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
    const menu = new ListMenu({ input, output: { write: text => written.push(text) } });
    menu.open();
    menu.close();
    assert.ok(written[0].startsWith(TERMINAL_INPUT_RESET) && written[1].startsWith(TERMINAL_INPUT_RESET));
    for (const mode of ['1000', '1002', '1003', '1006', '1004', '2031', '2004']) assert.ok(TERMINAL_INPUT_RESET.includes(`\x1b[?${mode}l`), mode);
    // A mouse moving over the menu changes nothing: the selection waits for a real key.
    menu.draw = () => {};
    const choice = menu.select({ title: [], items: [{ label: 'a' }, { label: 'b' }] });
    input.emit('data', Buffer.from(x10));
    input.emit('data', Buffer.from('\x1b[B\r'));
    assert.deepEqual(await choice, { action: 'enter', index: 1 });
});

// A scripted menu: each select answers the next choice; every view is recorded.
function scriptedMenu(choices, confirms = []) {
    const views = [];
    return {
        views,
        factory: () => ({
            busy: async (view, operation) => { views.push(['busy', view]); return operation(); },
            select: async (view, options) => { views.push(['select', view, options]); return choices.shift() || { action: 'quit', index: 0 }; },
            confirm: async () => confirms.shift() ?? false,
            close: () => views.push(['close']),
        }),
    };
}

test('the command lists folder sessions first, resumes directly and selects robot and agent only for New', async (t) => {
    const root = workspace(t, { robots: { agent: 'robots', repo: 'Repo' } }, { robots: MANIFEST });
    fs.mkdirSync(path.join(root, 'project'));
    const client = fakeClient({
        [`POST ${API}/robots`]: { ok: true, robots: [{ id: 'bob-1', name: 'Bob', default: false }, { id: 'def-1', name: 'default', default: true }] },
        [`POST ${API}/agents`]: { ok: true, robot: { id: 'def-1', name: 'default' }, active: 'claude', codingAgents: ['codex', 'claude'] },
        [`POST ${API}/history`]: { ok: true, sessions: [{ id: 'old', title: 'Old chat', updatedAt: 0 }] },
        'POST /webtty/coding-sessions': { ok: true, running: [], sessions: [{ id: 'old', title: 'Old chat', updatedAt: 0, robotId: 'def-1', robotName: 'default', codingAgent: 'claude' }] },
        [`POST ${API}/launch`]: body => ({ ok: true, profile: `def-1.default.claude${body.resume ? `.r-${body.resume}` : ''}`, nativeSessionId: body.resume }),
        'GET /webtty/live-sessions': { ok: true, sessions: [] },
        'POST /webtty/target-discoveries': { ok: true, discovery: { id: 'd'.repeat(32), targets: [{ launch: 'l'.repeat(32), kind: 'agent', detail: 'Repo/robots', access: 'rw' }] } },
        'POST /webtty/sessions': { ok: true, session: { id: 's'.repeat(32) }, view: { id: 'v'.repeat(32) } },
    });
    const menu = scriptedMenu([
        { action: 'enter', index: 1 }, // resume directly from the folder list
        { action: 'new', index: 0 },
        { action: 'enter', index: 1 }, // default robot
        { action: 'back', index: 0 }, // agent -> robots
        { action: 'back', index: 0 }, // robots -> sessions
        { action: 'new', index: 0 },
        { action: 'enter', index: 1 },
        { action: 'enter', index: 1 }, // launch new immediately after agent selection
        { action: 'quit', index: 0 },
    ]);
    const relays = [];
    const tty = { isTTY: true, columns: 100, rows: 30, write() {} };
    const errors = [];
    const code = await runCodingSessionsCommand({
        env: { PLOINKY_WORKSPACE_ROOT: root, PLOINKY_SKILL_SCOPE: path.join(root, 'project') },
        input: tty, output: tty, errorOutput: { write: text => errors.push(text) }, routerPort: 8080, mintSessionToken: () => 'jwt',
        createClient: () => client, createMenu: menu.factory,
        createRelay: options => ({ run: async () => { relays.push(options); return { reason: 'detached' }; } }),
    });
    assert.equal(code, 0);
    const selects = menu.views.filter(entry => entry[0] === 'select');
    assert.deepEqual(selects[0][1].items.map(item => item.label), ['+ New session', '  Old chat']);
    assert.equal(selects[2][2].selected, 1, 'the default robot is preselected');
    assert.equal(selects[3][2].selected, 1, 'the active coding agent is preselected');
    assert.equal(selects[5][1].title[1], 'Choose a session');
    assert.equal(client.calls.some(call => call[1] === `${API}/history`), false);
    assert.deepEqual(client.calls.filter(call => call[1] === `${API}/launch`).map(call => call[2]), [
        { robot: 'def-1', codingAgent: 'claude', directory: 'project', resume: 'old' },
        { robot: 'def-1', codingAgent: 'claude', directory: 'project', resume: null },
    ]);
    assert.equal(relays.length, 2);
    assert.match(selects[1][1].status, /Detached: the session keeps running/);
    assert.match(errors.join(''), /Ctrl\+\] detach;/);
    assert.equal(menu.views.at(-1)[0], 'close');
});

test('the command kills a running session after confirmation and exits when the terminal goes away', async (t) => {
    const root = workspace(t, { robots: { agent: 'robots', repo: 'Repo' } }, { robots: MANIFEST });
    fs.mkdirSync(path.join(root, 'project'));
    const client = fakeClient({
        [`POST ${API}/robots`]: { ok: true, robots: [{ id: 'ana-1', name: 'default', default: true }] },
        [`POST ${API}/agents`]: { ok: true, active: 'claude', codingAgents: ['claude'] },
        [`POST ${API}/history`]: { ok: true, sessions: [] },
        'GET /webtty/live-sessions': { ok: true, sessions: [liveRow()] },
        'POST /webtty/coding-sessions': { ok: true, running: [{ ...liveRow(), robotId: 'ana-1', robotName: 'default', codingAgent: 'claude' }], sessions: [] },
        [`DELETE /webtty/sessions/${'l'.repeat(32)}`]: { ok: true },
        [`POST /webtty/live-sessions/${'l'.repeat(32)}/attach-tokens`]: { ok: true, attach: 't'.repeat(32) },
        'POST /webtty/attachments': { ok: true, session: { id: 'l'.repeat(32) }, view: { id: 'v'.repeat(32) } },
    });
    const menu = scriptedMenu([
        { action: 'kill', index: 0 },    // the new-session row cannot be killed
        { action: 'kill', index: 1 },    // declined
        { action: 'kill', index: 1 },    // confirmed
        { action: 'enter', index: 1 },   // attach; the local terminal then goes away
    ], [false, true]);
    const tty = { isTTY: true, columns: 100, rows: 30, write() {} };
    const code = await runCodingSessionsCommand({
        env: { PLOINKY_WORKSPACE_ROOT: root, PLOINKY_SKILL_SCOPE: path.join(root, 'project') },
        input: tty, output: tty, errorOutput: { write() {} }, routerPort: 8080, mintSessionToken: () => 'jwt',
        createClient: () => client, createMenu: menu.factory,
        createRelay: () => ({ run: async () => ({ reason: 'signal' }) }),
    });
    assert.equal(code, 0);
    const selects = menu.views.filter(entry => entry[0] === 'select');
    assert.match(selects[1][1].status, /Only a running session can be killed/);
    assert.equal(client.calls.filter(call => call[0] === 'DELETE').length, 1);
    assert.match(selects[3][1].status, /Session killed/);
});

test('the command needs a provider and an interactive terminal', async () => {
    const tty = { isTTY: true };
    await assert.rejects(runCodingSessionsCommand({ env: {}, input: tty, output: tty, listProviders: () => [] }), { code: 'PLOINKY_CODING_SESSIONS_PROVIDER_MISSING' });
    await assert.rejects(runCodingSessionsCommand({ env: {}, input: tty, output: tty, listProviders: () => [PROVIDER, { ...PROVIDER, agent: 'b' }] }),
        { code: 'PLOINKY_CODING_SESSIONS_PROVIDER_AMBIGUOUS' });
    await assert.rejects(runCodingSessionsCommand({ env: {}, input: { isTTY: false }, output: tty, listProviders: () => [PROVIDER] }), { code: 'PLOINKY_CODING_SESSIONS_TTY' });
});

test('the SSE parser yields events across chunk boundaries and skips comments', () => {
    const events = [];
    const parse = createSseParser(event => events.push(event));
    parse(': connected\n\nid: 1\nevent: output\ndata: {"data":"a');
    parse('b"}\n\nevent: exit\r\ndata: {"reason":"terminal_exit"}\r\n\r\n');
    assert.deepEqual(events, [
        { id: '1', event: 'output', data: '{"data":"ab"}' },
        { id: null, event: 'exit', data: '{"reason":"terminal_exit"}' },
    ]);
});

test('the router client sends one stable login, fetches browser proof once and retries a stale proof', async () => {
    const seen = [];
    let proofs = 0;
    const request = (options, onResponse) => {
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.end = (body) => {
            seen.push({ method: options.method, path: options.path, headers: options.headers, body: body?.toString() });
            const res = new EventEmitter();
            const stale = options.method === 'POST' && options.headers['x-ploinky-browser-csrf-token'] === 'proof-1';
            res.statusCode = stale ? 403 : 200;
            res.headers = options.path === '/webtty/live-sessions'
                ? { 'set-cookie': [`ploinky_browser_csrf=proof-${proofs += 1}; Path=/; SameSite=Strict`] } : {};
            onResponse(res);
            res.emit('data', Buffer.from(JSON.stringify(stale ? { ok: false, error: 'browser_csrf_invalid' } : { ok: true })));
            res.emit('end');
        };
        return req;
    };
    const sids = new Set();
    const client = new LocalRouterClient({ port: 8080, request, mintSessionToken: (sid) => { sids.add(sid); return `jwt-${sids.size}`; } });
    assert.deepEqual(await client.json('POST', '/webtty/sessions', { a: 1 }), { ok: true });
    assert.deepEqual(seen.map(entry => `${entry.method} ${entry.path}`), [
        'GET /webtty/live-sessions', 'POST /webtty/sessions', 'GET /webtty/live-sessions', 'POST /webtty/sessions']);
    assert.equal(sids.size, 1);
    const last = seen.at(-1);
    assert.equal(last.headers.origin, 'http://127.0.0.1:8080');
    assert.equal(last.headers['x-ploinky-browser-csrf-token'], 'proof-2');
    assert.match(last.headers.cookie, /ploinky_jwt=jwt-1/);
    assert.equal(last.body, '{"a":1}');
});

class FakeInput extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.raw = []; }
    setRawMode(value) { this.raw.push(value); }
    resume() {}
    pause() {}
}

function streamingClient(events) {
    const posts = [];
    return {
        posts,
        async json(method, pathname, body) { posts.push([method, pathname, body]); return { ok: true }; },
        openStream(pathname, lastEventId) {
            const req = new EventEmitter();
            req.destroy = () => {};
            req.end = () => setImmediate(() => {
                const res = new EventEmitter();
                res.statusCode = 200;
                req.emit('response', res);
                const next = events.shift() || [];
                for (const chunk of next) res.emit('data', Buffer.from(chunk));
                res.emit('end');
            });
            posts.push(['STREAM', pathname, lastEventId]);
            return req;
        },
    };
}

function relayFixture({ events = [], columns = 100, rows = 30 } = {}) {
    const input = new FakeInput();
    const written = [];
    const output = Object.assign(new EventEmitter(), { columns, rows, write: text => written.push(text) });
    const client = streamingClient(events);
    const relay = new TerminalRelay({ client, sessionId: 's'.repeat(32), viewId: 'v'.repeat(32), input, output,
        signals: new EventEmitter() });
    return { input, output, written, client, relay, base: `/webtty/sessions/${'s'.repeat(32)}` };
}

test('the relay writes output, forwards keystrokes, takes the size with a redraw and ends on exit', async () => {
    const { input, written, client, relay, base } = relayFixture({ events: [
        ['id: 1\nevent: output\ndata: {"data":"hello"}\n\n'],
        ['id: 2\nevent: output\ndata: {"data":" world"}\n\nevent: exit\ndata: {"reason":"terminal_exit"}\n\n'],
    ] });
    const running = relay.run();
    input.emit('data', Buffer.from('ls\r'));
    const result = await running;
    assert.deepEqual(result, { reason: 'exited', detail: 'terminal_exit' });
    assert.deepEqual(written.slice(0, 2), ['hello', ' world']);
    assert.ok(written.at(-1).startsWith(TERMINAL_INPUT_RESET));
    assert.deepEqual(input.raw, [true, false]);
    assert.deepEqual(client.posts.filter(entry => entry[0] === 'STREAM').map(entry => entry[2]), ['', '1']);
    assert.ok(client.posts.some(entry => entry[0] === 'POST' && entry[1] === `${base}/input` && entry[2].data === 'ls\r'));
    // The first connection claims the size and makes the program repaint; a reconnect only re-asserts it.
    assert.deepEqual(client.posts.filter(entry => entry[1] === `${base}/resize`).map(entry => entry[2]),
        [{ cols: 100, rows: 29, claim: true, view: 'v'.repeat(32) }, { cols: 100, rows: 30, claim: true, view: 'v'.repeat(32) },
            { cols: 100, rows: 30, view: 'v'.repeat(32) }]);
    assert.equal(client.posts.some(entry => entry[1].endsWith('/close-intents') || entry[0] === 'DELETE'), false);
});

function idleStream(client) {
    client.openStream = () => Object.assign(new EventEmitter(), { end() {}, destroy() {} });
}

test('the detach key ends only this view: the terminal keeps running', async () => {
    const { input, client, relay, base } = relayFixture();
    idleStream(client);
    const running = relay.run();
    input.emit('data', Buffer.from('ab\x1dcd'));
    assert.deepEqual(await running, { reason: 'detached' });
    const posts = client.posts.filter(entry => entry[0] !== 'STREAM');
    assert.deepEqual(posts.find(entry => entry[1] === `${base}/input`)[2], { data: 'ab' }, 'keys before Ctrl+] still reach the terminal');
    assert.equal(posts.some(entry => entry[1] === `${base}/input` && entry[2].data.includes('cd')), false);
    assert.deepEqual(posts.at(-1), ['POST', `${base}/close-intents`, { view: 'v'.repeat(32), policy: 'keep' }]);
});

test('Ctrl+Q is an ordinary key that reaches the terminal', async () => {
    const { input, client, relay, base } = relayFixture();
    idleStream(client);
    const running = relay.run();
    input.emit('data', Buffer.from('\x11'));
    await new Promise(resolve => setTimeout(resolve, 20));
    relay.finish({ reason: 'signal' });
    await running;
    assert.ok(client.posts.some(entry => entry[1] === `${base}/input` && entry[2].data === '\x11'));
    assert.equal(client.posts.some(entry => entry[0] === 'DELETE'), false);
});

test('losing the local terminal detaches instead of stopping', async () => {
    const { input, client, relay, base } = relayFixture();
    idleStream(client);
    const running = relay.run();
    input.emit('end');
    assert.deepEqual(await running, { reason: 'input_closed' });
    assert.deepEqual(client.posts.at(-1), ['POST', `${base}/close-intents`, { view: 'v'.repeat(32), policy: 'keep' }]);
});

test('resizing the local terminal claims the shared terminal size', async () => {
    const { output, client, relay } = relayFixture();
    idleStream(client);
    const running = relay.run();
    await new Promise(resolve => setImmediate(resolve));
    output.columns = 200;
    output.rows = 50;
    output.emit('resize');
    await new Promise(resolve => setTimeout(resolve, 160));
    relay.finish({ reason: 'signal' });
    assert.deepEqual(await running, { reason: 'signal' });
    const claim = client.posts.find(entry => entry[1].endsWith('/resize') && entry[2]?.claim === true);
    assert.deepEqual(claim?.[2], { cols: 200, rows: 50, claim: true, view: 'v'.repeat(32) });
});

test('typing takes the size back after another window took it', async () => {
    const { input, client, relay, base } = relayFixture({ events: [
        ['event: size\ndata: {"cols":188,"rows":38,"view":"' + 'b'.repeat(32) + '"}\n\n'],
    ] });
    idleStream(client);
    client.openStream = (pathname) => {
        const req = new EventEmitter();
        req.destroy = () => {};
        req.end = () => setImmediate(() => {
            const res = new EventEmitter();
            res.statusCode = 200;
            req.emit('response', res);
            res.emit('data', Buffer.from(`event: size\ndata: {"cols":188,"rows":38,"view":"${'b'.repeat(32)}"}\n\n`));
        });
        return req;
    };
    const running = relay.run();
    await new Promise(resolve => setTimeout(resolve, 30));
    const claims = () => client.posts.filter(entry => entry[1] === `${base}/resize` && entry[2]?.claim === true);
    const before = claims().length;
    input.emit('data', Buffer.from('a'));
    input.emit('data', Buffer.from('b'));
    await new Promise(resolve => setTimeout(resolve, 20));
    relay.finish({ reason: 'signal' });
    await running;
    assert.equal(claims().length, before + 1, 'one claim for a burst of keys');
    assert.deepEqual(claims().at(-1)[2], { cols: 100, rows: 30, claim: true, view: 'v'.repeat(32) });
});
