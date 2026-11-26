import { supervisionSystemPrompt } from '../../cli/utils/supervisionRoles.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCodingSessionsCommand } from '../../cli/commands/codingSessionsCommand.js';
import { createSupervisedScreen } from '../../cli/commands/supervisedSessionsScreen.js';
import { ListMenu, parseKeys, renderMenu } from '../../cli/utils/codingSessionsMenu.mjs';
import {
    emptyStore, findSession, MAX_SUPERVISED_SESSIONS, readStore, removeSession, sanitizeStore, storePath,
    updateSession, upsertSession, writeStore,
} from '../../cli/utils/supervisedSessions.mjs';
import { createSupervisionCourier } from '../../cli/utils/supervisionCourier.mjs';
import {
    attachRole, createSupervisedPair, findLiveRow, killRoles, pairItems, pairRoleItems, pairState,
    relativeAge, rolesToKill, runningTerminals, supervisionTabs,
} from '../../cli/utils/supervisionFlow.mjs';
import {
    supervisionRoleText, taskDelivery,
} from '../../cli/utils/supervisionRoles.mjs';
import {
    parseTaskRevision, prepareSupervisedFolder, readTaskRevision, supervisedPaths, SUPERVISED_DIRECTORY,
} from '../../cli/utils/supervisionWorkspace.mjs';
import { createMouseReportFilter, SWITCH_KEY, TerminalRelay } from '../../cli/utils/webttyCliClient.mjs';

function scratch(t, prefix = 'ploinky-supervised-') {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

const record = (overrides = {}) => ({
    id: 'sup-aaaaaaaaaaaaaaaaaaaaaaaa',
    folder: '/work/project',
    label: 'project',
    createdAt: 1_000,
    updatedAt: 1_000,
    deliveredRev: null,
    phase: 'running',
    supervisor: { robotId: 'ana-1', robotName: 'Ana', codingAgent: 'claude', nativeSessionId: 'native-1', terminalId: 's'.repeat(32) },
    worker: { robotId: 'bob-1', robotName: 'Bob', codingAgent: 'codex', nativeSessionId: 'native-2', terminalId: 'w'.repeat(32) },
    ...overrides,
});

test('the role instructions ship with the command and name the two files', () => {
    const supervisor = supervisionRoleText('supervisor');
    const worker = supervisionRoleText('worker');
    assert.match(supervisor, /tasks\.md/u);
    assert.match(supervisor, /results\.md/u);
    assert.match(worker, /rev:/u);
    assert.match(worker, /Never write to `tasks\.md`/u);
    assert.throws(() => supervisionRoleText('reviewer'), /Unknown supervision role/u);
    assert.match(taskDelivery(3), /rev 3: read \.\/tasks\.md/u);
});

test('a session folder gets managed role skills and preserves its task files', (t) => {
    const folder = scratch(t);
    const paths = supervisedPaths(folder);
    assert.equal(paths.directory, path.join(folder, SUPERVISED_DIRECTORY));
    prepareSupervisedFolder(folder);
    assert.deepEqual(fs.readdirSync(paths.directory).sort(), ['supervised-session-supervisor', 'supervised-session-worker']);
    // A second start refreshes the generated text and keeps the task files.
    fs.writeFileSync(paths.tasks, 'rev: 1\ngoal: x\n');
    prepareSupervisedFolder(folder);
    assert.deepEqual(fs.readdirSync(paths.directory).sort(), ['supervised-session-supervisor', 'supervised-session-worker']);
    assert.ok(fs.lstatSync(path.dirname(paths.supervisor)).isSymbolicLink());
    assert.ok(fs.realpathSync(paths.supervisor).startsWith(folder + path.sep));
    assert.equal(fs.readFileSync(paths.tasks, 'utf8'), 'rev: 1\ngoal: x\n');
    assert.equal(fs.existsSync(path.join(folder, '.supervised')), false);
    assert.equal(fs.statSync(paths.supervisor).mode & 0o777, 0o644);
});

test('the worker task revision is read from the file the supervisor writes', (t) => {
    const folder = scratch(t);
    const paths = supervisedPaths(folder);
    assert.deepEqual(readTaskRevision(folder), { rev: null, text: '', missing: true });
    fs.mkdirSync(paths.directory, { recursive: true });
    fs.writeFileSync(paths.tasks, 'goal: no revision yet\n');
    assert.deepEqual(readTaskRevision(folder).rev, null);
    fs.writeFileSync(paths.tasks, 'rev: 7\ngoal: ship it\n');
    assert.equal(readTaskRevision(folder).rev, 7);
    assert.equal(parseTaskRevision('  rev: 7'), null);
    assert.equal(parseTaskRevision('rev: 1234567890'), null);
    assert.equal(parseTaskRevision('rev : 2'), null);
    assert.equal(parseTaskRevision('rev:3'), 3);
});

test('the pair store tolerates a missing or corrupt file and never keeps a malformed record', (t) => {
    const root = scratch(t);
    const file = storePath(root);
    assert.deepEqual(readStore(file), emptyStore());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.deepEqual(readStore(file), emptyStore());
    assert.deepEqual(sanitizeStore({ version: 9, sessions: [record(), { id: 'x' }, null, record({ supervisor: { codingAgent: 'claude' } })] }).sessions.length, 1);
    assert.deepEqual(sanitizeStore(null), emptyStore());
    // The written file is a complete JSON document, and no staging file survives.
    writeStore(file, { version: 1, sessions: [record()] });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).sessions.length, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.tmp')), []);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the newest pair comes first, the list is capped, and an update moves the pair up', () => {
    let store = emptyStore();
    for (let index = 0; index < MAX_SUPERVISED_SESSIONS + 3; index += 1) {
        store = upsertSession(store, record({ id: `sup-${index}`.padEnd(12, 'z'), createdAt: index, updatedAt: index }));
    }
    assert.equal(store.sessions.length, MAX_SUPERVISED_SESSIONS);
    assert.equal(store.sessions[0].createdAt, MAX_SUPERVISED_SESSIONS + 2);
    const updated = updateSession(store, store.sessions[1].id, () => ({ deliveredRev: 4 }), () => 99_000);
    assert.equal(findSession(updated, store.sessions[1].id).deliveredRev, 4);
    assert.equal(updated.sessions[0].id, store.sessions[1].id);
    assert.equal(updated.sessions[0].updatedAt, 99_000);
    assert.equal(removeSession(updated, updated.sessions[0].id).sessions.length, MAX_SUPERVISED_SESSIONS - 1);
    assert.throws(() => upsertSession(emptyStore(), { id: 'x' }), /Invalid supervised session record/u);
});

test('the pair list and its two sessions describe running and ended roles', () => {
    const live = [
        { id: 's'.repeat(32), source: 'webtty', status: 'attached', lastActivityAt: 61_000, viewerCount: 1 },
        { id: 'x'.repeat(32), source: 'webtty', status: 'exited' },
    ];
    const items = pairItems({ sessions: [record(), record({ id: 'sup-bbbbbbbbbbbbbbbbbbbbbbbb', phase: 'ended',
        supervisor: { ...record().supervisor, terminalId: null }, worker: { ...record().worker, terminalId: null } })], live, now: 121_000 });
    assert.deepEqual(items.map(item => item.label), ['+ New supervised session', '● project', '  project']);
    assert.match(items[1].detail, /^running · claude → codex · 2m ago$/u);
    assert.match(items[2].detail, /^ended · /u);
    const state = pairState(record(), live);
    assert.deepEqual([state.running, state.worker], [true, null]);
    const roles = pairRoleItems(record(), live, 121_000);
    assert.deepEqual(roles.map(item => [item.role, item.label, item.detail]),
        [['supervisor', '● Supervisor · claude', 'attached · 1 view · 1m ago'], ['worker', '  Worker · codex', 'ended']]);
    const detached = [{ ...live[0], status: 'detached', viewerCount: 0 }];
    assert.equal(pairRoleItems(record(), detached)[0].label, '● Supervisor · claude');
    assert.equal(pairItems({ sessions: [record()], live: detached })[1].label, '● project');
    assert.equal(relativeAge(0, 86_400_000), '1d ago');
    assert.equal(supervisionTabs('supervised').activeTab, 1);
    assert.equal(supervisionTabs('coding').activeTab, 0);
    assert.deepEqual(rolesToKill('both'), ['supervisor', 'worker']);
    assert.deepEqual(rolesToKill('worker'), ['worker']);
    assert.equal(findLiveRow(live, 'exited'), null);
});

test('only running WebTTY terminals of the workspace are candidates', async () => {
    const client = { json: async () => ({ ok: true, sessions: [{ id: 'a', source: 'webtty', status: 'detached' },
        { id: 'b', source: 'webtty', status: 'exited' }, { id: 'c', source: 'agent', status: 'running' }, null] }) };
    assert.deepEqual((await runningTerminals(client)).map(row => row.id), ['a']);
    assert.deepEqual(await runningTerminals({ json: async () => ({ ok: true }) }), []);
});

function fakeApi(calls = [], answers = {}) {
    return async (route, body) => {
        calls.push([route, body]);
        return answers[route] || { ok: true, profile: `${body.robot}.default.${body.codingAgent}`, nativeSessionId: `native-${route}-${calls.length}` };
    };
}

test('both terminals start in the folder, no prompt is submitted, and a failure closes what it opened', async (t) => {
    const folder = scratch(t);
    const calls = [];
    const inputs = [];
    const client = { json: async (method, pathname, body) => { inputs.push([method, pathname, body]); return { ok: true }; } };
    const opened = [];
    const api = fakeApi(calls);
    const pair = await createSupervisedPair({
        api, client, directory: 'project', folder,
        openTerminal: async (launched) => { opened.push(launched.profile); return { sessionId: `terminal-${opened.length}`.padEnd(32, 'p'), viewId: 'v'.repeat(32) }; },
        supervisor: { robotId: 'ana-1', robotName: 'Ana', codingAgent: 'claude' },
        worker: { robotId: 'bob-1', robotName: 'Bob', codingAgent: 'codex' },
        now: () => 5_000,
    });
    assert.deepEqual(opened, ['ana-1.default.claude', 'bob-1.default.codex']);
    assert.deepEqual(calls.map(call => call[1].resume), [null, null]);
    // Each launch names its role; instructions are workspace skills.
    assert.deepEqual(calls.map(call => call[1].systemPrompt), ['supervisor', 'worker'].map(supervisionSystemPrompt));
    assert.ok(calls.every(([, body]) => !('skill' in body)), 'skills are installed in cwd, never in robot homes');
    assert.equal(pair.supervisor.codingAgent, 'claude');
    assert.equal(pair.worker.nativeSessionId, 'native-launch-2');
    assert.deepEqual(fs.readdirSync(path.join(folder, SUPERVISED_DIRECTORY)).sort(), ['supervised-session-supervisor', 'supervised-session-worker']);
    assert.deepEqual(inputs, [], 'opening the pair does not submit a model request');

    const deleted = [];
    await assert.rejects(createSupervisedPair({
        api: async (route, body) => (route === 'launch' && body.codingAgent === 'codex'
            ? Promise.reject(new Error('no worker robot')) : fakeApi([], {})(route, body)),
        client: { json: async (method, pathname) => { deleted.push([method, pathname]); return { ok: true }; } },
        openTerminal: async () => ({ sessionId: 'o'.repeat(32), viewId: 'v'.repeat(32) }),
        directory: 'project', folder: scratch(t),
        supervisor: { robotId: 'ana-1', codingAgent: 'claude' }, worker: { robotId: 'bob-1', codingAgent: 'codex' },
    }), /no worker robot/u);
    assert.deepEqual(deleted, [['DELETE', `/webtty/sessions/${'o'.repeat(32)}`]]);
});

test('attaching a role resumes its native conversation when its terminal is gone', async (t) => {
    const folder = scratch(t);
    const calls = [];
    const api = fakeApi(calls, { launch: { ok: true, profile: 'bob-1.default.codex.r-native-2', nativeSessionId: 'native-2' } });
    const resumed = await attachRole({
        client: { json: async () => ({ ok: true }) }, api,
        attachTerminal: async () => { throw new Error('attaching to an ended terminal'); },
        openTerminal: async launched => ({ sessionId: 'new'.padEnd(32, 'n'), viewId: 'v'.repeat(32), profile: launched.profile }),
        session: record({ folder }), role: 'worker', directory: 'project', output: {}, live: [],
    });
    assert.deepEqual(calls[0], ['launch', { robot: 'bob-1', codingAgent: 'codex', directory: 'project', resume: 'native-2', systemPrompt: supervisionSystemPrompt('worker') }]);
    assert.equal(resumed.record.terminalId, 'new'.padEnd(32, 'n'));
    assert.equal(resumed.record.nativeSessionId, 'native-2');

    const attached = await attachRole({
        client: { json: async () => ({ ok: true }) }, api,
        attachTerminal: async (client, row) => ({ sessionId: row.id, viewId: 'v'.repeat(32) }),
        openTerminal: async () => { throw new Error('a running terminal is attached, not opened'); },
        session: record({ folder }), role: 'supervisor', directory: 'project', output: {},
        live: [{ id: 's'.repeat(32), source: 'webtty', status: 'detached' }],
    });
    assert.equal(attached.terminal.sessionId, 's'.repeat(32));

    const inputRequests = [];
    await attachRole({
        client: { json: async (...args) => inputRequests.push(args) }, api,
        openTerminal: async () => ({ sessionId: 'fresh-terminal', viewId: 'view' }),
        session: record({ folder, worker: { ...record().worker, nativeSessionId: null } }),
        role: 'worker', directory: 'project', output: {}, live: [],
    });
    assert.deepEqual(inputRequests, [], 'a fresh replacement without native history also receives no prompt');
});

test('killing a role ends its terminal and tolerates one that is already gone', async () => {
    const calls = [];
    const client = { json: async (method, pathname) => {
        calls.push([method, pathname]);
        if (pathname.endsWith('w'.repeat(32))) throw Object.assign(new Error('gone'), { status: 404 });
        return { ok: true };
    } };
    assert.deepEqual(await killRoles(client, record(), 'both'), ['supervisor', 'worker']);
    assert.deepEqual(calls, [['DELETE', `/webtty/sessions/${'s'.repeat(32)}`], ['DELETE', `/webtty/sessions/${'w'.repeat(32)}`]]);
    assert.deepEqual(await killRoles(client, record({ worker: { ...record().worker, terminalId: null } }), 'worker'), []);
});

test('the courier delivers each revision once and nudges a silent worker once', async () => {
    let clock = 0;
    const delivered = [];
    const statuses = [];
    const revisions = [{ rev: 1 }, { rev: 1 }, { rev: 2 }, { rev: 2 }];
    let activityAt = 0;
    const courier = createSupervisionCourier({
        folder: '/work/project',
        workerTerminalId: 'w'.repeat(32),
        readRevision: async () => revisions.shift() || { rev: 2 },
        deliver: async text => { delivered.push(text); },
        activity: async () => ({ lastActivityAt: activityAt }),
        onStatus: value => statuses.push(value),
        now: () => clock,
        intervalMs: 1_000, activityMs: 0, stallMs: 60_000,
        setTimer: () => null, clearTimer: () => {},
    });
    await courier.once();
    assert.equal(delivered.length, 1);
    assert.match(delivered[0], /rev 1: read/u);
    await courier.once();
    assert.equal(delivered.length, 1);
    clock = 10_000;
    await courier.once();
    assert.equal(delivered.length, 2);
    assert.match(delivered[1], /rev 2: read/u);
    // A revision open for longer than the stall threshold gets exactly one nudge.
    activityAt = 0;
    clock = 120_000;
    await courier.once();
    await courier.once();
    assert.equal(delivered.length, 3);
    assert.match(delivered[2], /worker terminal silent for 2 minutes/u);
    assert.ok(statuses.some(status => /worker silent for 2m/u.test(status)));
    assert.equal(courier.deliveredRev(), 2);
    courier.stop();
    await courier.once();
    assert.equal(delivered.length, 3);
});

test('the courier never delivers without a revision and reports why', async () => {
    const statuses = [];
    const delivered = [];
    const courier = createSupervisionCourier({
        folder: '/work', readRevision: async () => ({ rev: null, missing: true }), deliver: async text => delivered.push(text),
        onStatus: value => statuses.push(value), setTimer: () => null, clearTimer: () => {},
    });
    await courier.once();
    assert.deepEqual(delivered, []);
    assert.match(statuses[0], /tasks\.md does not exist yet/u);
    // A revision already delivered by a previous run is not delivered again.
    const restarted = createSupervisionCourier({
        folder: '/work', startRev: 4, readRevision: async () => ({ rev: 4 }), deliver: async text => delivered.push(text),
        setTimer: () => null, clearTimer: () => {},
    });
    await restarted.once();
    assert.deepEqual(delivered, []);
    // A delivery failure is reported instead of thrown.
    const failing = createSupervisionCourier({
        folder: '/work', readRevision: async () => ({ rev: 5 }), deliver: async () => { throw new Error('terminal is gone'); },
        onStatus: value => statuses.push(value), setTimer: () => null, clearTimer: () => {},
    });
    await failing.once();
    assert.match(statuses.at(-1), /delivery failed: terminal is gone/u);
});

test('Shift+Tab is the tab key, the tab line names both menus, and a live screen refreshes', () => {
    assert.deepEqual(parseKeys('\x1b[Z'), ['tab']);
    const plain = renderMenu({ title: ['T'], items: [{ label: 'a' }], columns: 40, rows: 8 });
    const tabbed = renderMenu({ title: ['T'], items: [{ label: 'a' }], columns: 40, rows: 8,
        tabs: ['Coding sessions', 'Supervised sessions'], activeTab: 1 });
    assert.equal(tabbed.length, plain.length);
    assert.match(tabbed[1], /\x1b\[7m *Supervised sessions/u);
    assert.match(tabbed[1], /Coding sessions/u);
    assert.equal(plain[1].includes('Coding sessions'), false);
});

// The command drives both menus: the coding tab it starts on, and the
// supervised tab the pair lives in.
const API = '/base-agent-additional-server/robots/3001/api/coding-sessions';
const MANIFEST = { webtty: { homeProfiles: { version: 2, resolve: '/x' }, codingSessions: { version: 1, api: API } } };

function agentWorkspace(t) {
    const root = scratch(t, 'ploinky-supervised-cs-');
    fs.mkdirSync(path.join(root, '.ploinky'));
    const hostPath = path.join(root, 'agents', 'robots');
    fs.mkdirSync(hostPath, { recursive: true });
    fs.writeFileSync(path.join(hostPath, 'manifest.json'), JSON.stringify(MANIFEST));
    fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify({ port: 8080,
        routes: { robots: { agent: 'robots', repo: 'Repo', hostPath } } }));
    fs.mkdirSync(path.join(root, 'project'));
    return root;
}

function scriptedMenu(choices, confirms = []) {
    const views = [];
    return {
        views,
        factory: () => ({
            busy: async (view, operation) => { views.push(['busy', view]); return operation(); },
            select: async (view) => { views.push(['select', view]); return choices.shift() || { action: 'quit', index: 0 }; },
            confirm: async () => confirms.shift() ?? false,
            close: () => views.push(['close']),
        }),
    };
}

test('a supervised session is created, switched with Ctrl+\\, killed and left with Shift+Tab', async (t) => {
    const root = agentWorkspace(t);
    const supervisor = 'S'.repeat(32);
    const worker = 'W'.repeat(32);
    const calls = [];
    let created = 0;
    const live = () => ({ ok: true, sessions: [
        { id: supervisor, source: 'webtty', status: 'attached', lastActivityAt: 5_000, viewerCount: 0 },
        { id: worker, source: 'webtty', status: 'attached', lastActivityAt: 5_000, viewerCount: 0 },
    ] });
    const client = {
        async json(method, pathname, body) {
            calls.push([method, pathname, body]);
            if (pathname === `/webtty/sessions/${supervisor}/input` || pathname === `/webtty/sessions/${worker}/input`) return { ok: true };
            if (pathname === '/webtty/live-sessions' && method === 'GET') return live();
            if (pathname === `${API}/robots`) return { ok: true, robots: [{ id: 'ana-1', name: 'Ana', default: true }, { id: 'bob-1', name: 'Bob' }] };
            if (pathname === `${API}/agents`) return { ok: true, active: 'claude', codingAgents: ['claude', 'codex'] };
            if (pathname === `${API}/launch`) return { ok: true, profile: 'p.default.x', nativeSessionId: `native-${body.codingAgent}` };
            if (pathname === '/webtty/target-discoveries') {
                return { ok: true, discovery: { id: 'd'.repeat(32), targets: [{ launch: 'l'.repeat(32), kind: 'agent', detail: 'Repo/robots', access: 'rw' }] } };
            }
            if (pathname === '/webtty/sessions' && method === 'POST') {
                created += 1;
                return { ok: true, session: { id: created === 1 ? supervisor : worker }, view: { id: 'v'.repeat(32) } };
            }
            if (pathname.startsWith('/webtty/live-sessions/') && pathname.endsWith('/attach-tokens')) {
                // The attach token names the terminal it belongs to.
                return { ok: true, attach: pathname.split('/')[3] };
            }
            if (pathname === '/webtty/attachments') return { ok: true, session: { id: body.attach }, view: { id: 'v'.repeat(32) } };
            return { ok: true };
        },
    };
    const menu = scriptedMenu([
        { action: 'tab' },                  // coding robots → supervised pairs
        { action: 'new' },                  // new supervised session
        { action: 'enter', index: 0 },      // supervisor robot
        { action: 'enter', index: 0 },      // supervisor agent
        { action: 'enter', index: 0 },      // worker robot
        { action: 'enter', index: 0 },      // worker agent → both terminals start
        { action: 'kill', index: 1 },       // kill the selected worker directly
        { action: 'tab' },                  // pair screen → coding robots
        { action: 'quit', index: 0 },
    ], [true]);
    const relays = [];
    const relayReasons = ['switch', 'detached'];
    const couriers = [];
    const errors = [];
    const tty = { isTTY: true, columns: 100, rows: 30, write() {} };
    const code = await runCodingSessionsCommand({
        env: { PLOINKY_WORKSPACE_ROOT: root, PLOINKY_SKILL_SCOPE: path.join(root, 'project') },
        input: tty, output: tty, errorOutput: { write: text => errors.push(text) },
        routerPort: 8080, mintSessionToken: () => 'jwt', now: () => 10_000,
        createClient: () => client, createMenu: menu.factory,
        createCourier: options => { const entry = { options, started: false, stopped: false,
            start() { this.started = true; }, stop() { this.stopped = true; }, status: () => '' }; couriers.push(entry); return entry; },
        createRelay: options => ({ run: async () => { relays.push(options); return { reason: relayReasons.shift() || 'detached' }; } }),
    });
    assert.equal(code, 0);
    // Both roles were launched in the chosen folder with a fresh conversation.
    const launches = calls.filter(call => call[1] === `${API}/launch`).map(call => call[2]);
    assert.deepEqual(launches.map(call => [call.codingAgent, call.resume, call.directory]),
        [['claude', null, 'project'], ['claude', null, 'project']]);
    // The role instructions landed in the folder before the terminals started.
    const folder = path.join(root, 'project', SUPERVISED_DIRECTORY);
    assert.deepEqual(fs.readdirSync(folder).sort(), ['supervised-session-supervisor', 'supervised-session-worker']);
    const briefings = calls.filter(call => call[1].endsWith('/input'));
    assert.deepEqual(briefings, []);
    // The pair was recorded, and one courier supervises the worker terminal.
    const stored = readStore(storePath(root));
    assert.equal(stored.sessions.length, 1);
    assert.deepEqual([stored.sessions[0].supervisor.terminalId, stored.sessions[0].worker.terminalId], [supervisor, worker]);
    assert.equal(couriers.length, 1);
    assert.equal(couriers[0].started, true);
    assert.equal(couriers[0].options.workerTerminalId, worker);
    assert.equal(couriers[0].options.folder, path.join(root, 'project'));
    // Ctrl+\ switched to the other role and Ctrl+] came back to the pair screen.
    assert.deepEqual(relays.map(relay => relay.sessionId), [supervisor, worker]);
    assert.deepEqual(relays.map(relay => relay.keys.switch), [SWITCH_KEY, SWITCH_KEY]);
    // Only this tab asks the view to silence the report modes the agents switch on.
    assert.deepEqual(relays.map(relay => relay.stripReports), [true, true]);
    const selects = menu.views.filter(view => view[0] === 'select');
    assert.deepEqual(selects[1][1].tabs, ['Coding sessions', 'Supervised sessions']);
    assert.equal(selects[1][1].activeTab, 1);
    assert.match(selects[6][1].status, /Detached: the session keeps running/u);
    assert.deepEqual(selects[6][1].items.map(item => item.label), ['● Supervisor · claude', '● Worker · claude']);
    // Killing the worker closed that terminal, and Shift+Tab returned to the coding tab.
    assert.deepEqual(calls.filter(call => call[0] === 'DELETE').map(call => call[1]), [`/webtty/sessions/${worker}`]);
    assert.match(selects[7][1].status, /Killed Worker/u);
    assert.equal(selects[7][1].activeTab, 1);
    assert.equal(selects[8][1].activeTab, 0);
    assert.match(errors.join(''), /Ctrl\+\\ switch/u);
    assert.equal(couriers[0].stopped, true);
    assert.equal(menu.views.at(-1)[0], 'close');
});

test('Shift+Tab and the horizontal arrows both move between the two menus', async () => {
    for (const key of ['\x1b[Z', '\x1b[C', '\x1b[D', '\x1bOC', '\x1bOD']) {
        const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
        const menu = new ListMenu({ input, output: { write() {} } });
        menu.draw = () => {};
        const choice = menu.select({ title: [], items: [{ label: 'a' }], tabs: ['one', 'two'], activeTab: 0 });
        input.emit('data', Buffer.from(key));
        assert.deepEqual(await choice, { action: 'tab', index: 0 }, key);
    }
    // A screen without tabs ignores them: the arrows stay ordinary keys.
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {}, pause() {} });
    const menu = new ListMenu({ input, output: { write() {} } });
    menu.draw = () => {};
    const choice = menu.select({ title: [], items: [{ label: 'a' }] });
    input.emit('data', Buffer.from('\x1b[C\x1b[Dq'));
    assert.deepEqual(await choice, { action: 'quit', index: 0 });
});

test('workspace role skills are used regardless of provider home-skill support', async (t) => {
    const folder = scratch(t);
    const calls = [];
    const inputs = [];
    const client = { json: async (method, pathname, body) => { inputs.push([method, pathname, body]); return { ok: true }; } };
    const pair = await createSupervisedPair({
        api: async (route, body) => {
            calls.push([route, body]);
            // The provider installed the skill for both roles.
            return { ok: true, profile: 'p.default.agent', nativeSessionId: null, skill: true };
        },
        client, directory: 'project', folder,
        openTerminal: async () => ({ sessionId: 's'.repeat(32), viewId: 'v'.repeat(32) }),
        supervisor: { robotId: 'ana-1', codingAgent: 'claude' },
        worker: { robotId: 'bob-1', codingAgent: 'claude' },
    });
    assert.equal(pair.supervisor.terminalId, 's'.repeat(32));
    // Both workspace skills are installed regardless of provider capabilities.
    assert.deepEqual(fs.readdirSync(path.join(folder, SUPERVISED_DIRECTORY)).sort(), ['supervised-session-supervisor', 'supervised-session-worker']);
    assert.deepEqual(inputs, []);
    // A provider without home-skill support receives the same workspace skill paths.
    const mixedFolder = scratch(t);
    const mixed = [];
    await createSupervisedPair({
        api: async (route, body) => { mixed.push([route, body]); return { ok: true, profile: 'p', nativeSessionId: null,
            skill: body.role === 'supervisor' }; },
        client: { json: async () => ({ ok: true }) }, directory: 'project', folder: mixedFolder,
        openTerminal: async () => ({ sessionId: 'x'.repeat(32), viewId: 'v'.repeat(32) }),
        supervisor: { robotId: 'ana-1', codingAgent: 'claude' },
        worker: { robotId: 'bob-1', codingAgent: 'codex' },
    });
    assert.deepEqual(fs.readdirSync(path.join(mixedFolder, SUPERVISED_DIRECTORY)), ['supervised-session-supervisor', 'supervised-session-worker']);
});

test('only a supervised view silences mouse and focus reports; other views are unchanged', () => {
    const written = [];
    const view = stripReports => new TerminalRelay({
        client: {}, sessionId: 's'.repeat(32), viewId: 'v'.repeat(32),
        input: { isTTY: false }, output: { write: text => written.push(text) }, stripReports,
    });
    const output = (relay, data) => relay.handleEvent({ id: '1', event: 'output', data: JSON.stringify({ data }) }, () => {});
    // A plain coding session keeps exactly what its agent wrote, as before.
    const plain = view(false);
    output(plain, '\x1b[?1000;1002;1006h\x1b[?1004hpaint');
    assert.equal(written.join(''), '\x1b[?1000;1002;1006h\x1b[?1004hpaint');
    written.length = 0;
    // A supervised view never lets the terminal enter those modes.
    const supervised = view(true);
    output(supervised, '\x1b[?1000;1002;1006h\x1b[?1004hpaint');
    output(supervised, '\x1b[?100');
    output(supervised, '3hscroll\x1b[?1000l');
    assert.equal(written.join(''), 'paintscroll\x1b[?1000l');
    // Modes this view does not silence, queries and disables reach the terminal.
    const filter = createMouseReportFilter();
    assert.equal(filter('\x1b[?1049;1006h'), '\x1b[?1049h');
    assert.equal(filter('\x1b[?2004h'), '\x1b[?2004h');
    assert.equal(filter('\x1b[?1000$p'), '\x1b[?1000$p');
    assert.equal(filter('\x1b[?1004l'), '\x1b[?1004l');
});

test('new pair conflicts and launch failures never restart the robot selection wizard', async t => {
    const folder = scratch(t);
    const file = path.join(folder, 'pairs.json');
    const existing = record({ folder });
    writeStore(file, upsertSession(emptyStore(), existing));
    let live = [{ id: existing.supervisor.terminalId, source: 'webtty', status: 'detached' }];
    let action = 'new';
    let failLaunch = false;
    const requests = [];
    const views = [];
    const draft = { supervisor: { robotId: 'robot-a', robotName: 'A', codingAgent: 'claude' },
        worker: { robotId: 'robot-b', robotName: 'B', codingAgent: 'claude' } };
    const state = { level: 'pairs', status: '', draft, remembered: { pairs: 0, roles: 0 } };
    const screen = createSupervisedScreen({
        folderPath: folder, folder, directory: '', storeFile: () => file, now: () => 1000,
        labels: { supervisor: 'Supervisor', worker: 'Worker' },
        menu: { busy: async (_, op) => op(), select: async view => { views.push(view); return { action, index: 0 }; } },
        client: { json: async () => ({ sessions: live }) },
        api: async route => {
            requests.push(route);
            if (route === 'launch' && failLaunch) throw new Error('Provider is not ready');
            return { codingAgents: ['claude'], active: 'claude' };
        },
        createCourier: () => ({ start() {}, stop() {} }),
    });
    t.after(() => screen.stop());
    await screen.screen(state);
    assert.equal(state.level, 'pair');
    assert.equal(state.supervised, existing.id);
    assert.match(state.status, /still running/);
    assert.deepEqual(requests, [], 'a detached existing process is detected before robot selection');

    state.level = 'worker-agent';
    action = 'enter';
    await screen.screen(state);
    assert.equal(state.level, 'pair', 'a pair started during selection also opens the existing pair');
    assert.equal(requests.includes('launch'), false);

    live = [];
    state.level = 'worker-agent';
    state.status = '';
    failLaunch = true;
    await screen.screen(state);
    assert.equal(state.level, 'worker-agent');
    assert.equal(state.draft, draft, 'the selected robots and agents survive a launch failure');
    assert.match(state.status, /Provider is not ready/);
    action = 'quit';
    await screen.screen(state);
    assert.ok(views.at(-1).title.some(line => line.includes('Provider is not ready')));

    state.level = 'pairs';
    action = 'refresh';
    await screen.screen(state);
    assert.equal(state.level, 'pairs', 'refresh on New must not open the wizard');
});

test('supervision skills use managed exports and preserve unrelated or conflicting local skills', t => {
    const folder = scratch(t);
    const skills = path.join(folder, '.agents', 'skills');
    const local = path.join(skills, 'my-local-skill');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'SKILL.md'), '# Local instructions\n');
    const paths = prepareSupervisedFolder(folder);
    const ledger = JSON.parse(fs.readFileSync(path.join(folder, '.agents', '.ploinky-skill-exports.json'), 'utf8'));
    for (const role of ['supervisor', 'worker']) {
        const name = `supervised-session-${role}`;
        assert.equal(ledger.entries[name].owner, 'builtin:supervised-sessions');
        assert.ok(fs.lstatSync(path.dirname(paths[role])).isSymbolicLink());
        assert.match(fs.readFileSync(paths[role], 'utf8'), new RegExp(`^---\\nname: ${name}\\ndescription: `));
    }
    assert.equal(fs.readFileSync(path.join(local, 'SKILL.md'), 'utf8'), '# Local instructions\n');
    assert.equal(fs.realpathSync(path.join(folder, '.claude', 'skills')), fs.realpathSync(skills));
    assert.equal(fs.existsSync(paths.tasks), false);
    assert.equal(fs.existsSync(paths.results), false);

    const conflicting = scratch(t);
    const custom = path.join(conflicting, '.agents', 'skills', 'supervised-session-supervisor');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '# My supervisor\n');
    assert.throws(() => prepareSupervisedFolder(conflicting), /unrecorded-output-preserved/);
    assert.equal(fs.readFileSync(path.join(custom, 'SKILL.md'), 'utf8'), '# My supervisor\n');
});
