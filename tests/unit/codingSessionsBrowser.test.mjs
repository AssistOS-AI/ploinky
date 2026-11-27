import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserCodingSessions, validateCodingSessionRequest, codingSessionReadiness } from '../../cli/server/webtty/codingSessions.mjs';
import { readStore, storePath } from '../../cli/utils/supervisedSessions.mjs';

function fixture(t) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-browser-'));
    fs.mkdirSync(path.join(workspaceRoot, '.ploinky'));
    fs.mkdirSync(path.join(workspaceRoot, 'project'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    const calls = [], sessions = new Map();
    const base = '/base-agent-additional-server/provider/3001';
    const snapshot = { routing: { routes: { provider: { agent: 'provider', repo: 'repo', container: 'container' } } },
        agents: { container: { type: 'agent', agentName: 'provider', repoName: 'repo' } },
        manifests: { provider: { webtty: { homeProfiles: { version: 1, resolve: `${base}/profiles/resolve` },
            codingSessions: { version: 1, api: `${base}/coding-sessions` } } } } };
    const routePlan = { snapshot, lease: { isCurrent: () => true, commit: () => true } };
    const manager = { workspaceRoot, sessions, validatedLease: async () => ({}),
        homeProfiles: { callCodingSession: async ({ operation, body }) => {
            calls.push([operation, body]);
            if (operation === 'robots') return { ok: true, robots: [{ id: 'default', name: 'Default' }] };
            if (operation === 'agents') return { ok: true, codingAgents: ['vibe', 'claude'] };
            if (operation === 'index') return { ok: true, sessions: [], refreshing: false, errors: [] };
            if (operation === 'history') return { ok: true, sessions: [], sessionBindingSupported: true };
            if (operation === 'control-create') return { ok: true, id: '11111111-1111-4111-8111-111111111111' };
            if (operation === 'launch') return { ok: true, profile: `${body.robot}.default.${body.codingAgent}`, nativeSessionId: body.resume };
            return { ok: true };
        } },
        listLiveSessions: async () => ({ sessions: [...sessions.values()] }),
        discoverTargets: async options => { calls.push(['discover', options]); return { id: 'discovery', targets: [
            { kind: 'agent', access: 'rw', detail: 'repo/provider', launch: 'l'.repeat(32) },
        ] }; },
        create: async () => { const id = String(sessions.size + 1).padStart(32, 's');
            const session = { id, status: 'detached', cwd: 'project', view: { id: 'v'.repeat(32) } }; sessions.set(id, session); return session; },
        retainDetachedForSupervision: session => { session.backgroundAdmitted = true; },
        createAttachToken: async ({ id }) => { assert.ok(sessions.has(id)); return { attach: (id.endsWith('2') ? 'b' : 'a').repeat(32), expiresAt: Date.now() + 10000 }; },
        closeAuthorized: async (_req, _route, id) => { sessions.delete(id); return true; },
        supervisedPairs: { register: async (_req, _route, record) => { calls.push(['register', record]); return { ok: true }; } },
    };
    const call = (action, fields = {}) => browserCodingSessions(manager, {}, routePlan, { action, dir: 'project', ...fields });
    return { manager, call, calls, sessions, routePlan, workspaceRoot };
}

test('browser coding requests reject paths, extra authority and malformed plans', () => {
    assert.equal(validateCodingSessionRequest({ action: 'robots', dir: '' }), true);
    for (const body of [{ action: 'robots', dir: '../escape' }, { action: 'robots', dir: '/absolute' },
        { action: 'launch', dir: '', robot: 'default', codingAgent: 'vibe', resume: null, systemPrompt: 'injected' },
        { action: 'create-pair', dir: '', supervisor: {}, worker: {} },
        { action: 'open-role', dir: '', id: 'pair', role: 'both' }]) assert.equal(validateCodingSessionRequest(body), false);
});

test('normal coding launch uses writable provider terminal and returns Live Sessions handoff', async t => {
    const f = fixture(t);
    assert.equal((await f.call('robots')).robots[0].id, 'default');
    const result = await f.call('launch', { robot: 'default', codingAgent: 'vibe', resume: 'original' });
    assert.equal(result.attach, 'a'.repeat(32));
    assert.equal(f.calls.find(([operation]) => operation === 'launch')[1].resume, 'original');
    assert.equal([...f.sessions.values()][0].backgroundAdmitted, true);
    assert.equal(f.calls.find(([operation]) => operation === 'discover')[1].directory, 'project');
});

test('browser pair starts both roles, persists CLI-compatible history and opens supervisor first', async t => {
    const f = fixture(t);
    const config = { supervisor: { robotId: 'default', codingAgent: 'vibe' }, worker: { robotId: 'default', codingAgent: 'vibe' } };
    const result = await f.call('create-pair', config);
    const store = readStore(storePath(f.workspaceRoot));
    assert.equal(f.sessions.size, 2);
    const pair = store.sessions[0];
    assert.equal(result.terminalId, pair.supervisor.terminalId);
    assert.equal(result.worker.terminalId, pair.worker.terminalId);
    assert.ok(result.worker.attach);
    assert.notEqual(result.worker.attach, result.attach);
    assert.notEqual(pair.supervisor.sessionBinding, pair.worker.sessionBinding);
    assert.ok([...f.sessions.values()].every(session => session.backgroundAdmitted));
    assert.equal(f.calls.filter(([operation]) => operation === 'register').length, 1);
    const beforeList = f.calls.length;
    const listed = await f.call('pairs');
    assert.deepEqual(f.calls.slice(beforeList).map(([op]) => op), ['robots']);
    assert.deepEqual(listed.pairs[0].roles.map(role => role.running), [true, true]);
    assert.equal(JSON.stringify(listed).includes('controlId'), false);
    const attached = await f.call('open-role', { id: pair.id, role: 'worker' });
    assert.equal(attached.terminalId, pair.worker.terminalId);
    await assert.rejects(f.call('create-pair', config), /already running/u);
    assert.equal(f.sessions.size, 2);
});

test('pair registration failure cleans up both processes and writes no history', async t => {
    const f = fixture(t);
    f.manager.supervisedPairs.register = async () => { throw new Error('registration failed'); };
    await assert.rejects(f.call('create-pair', { supervisor: { robotId: 'a', codingAgent: 'vibe' },
        worker: { robotId: 'b', codingAgent: 'vibe' } }), /registration failed/u);
    assert.equal(f.sessions.size, 0);
    assert.equal(readStore(storePath(f.workspaceRoot)).sessions.length, 0);
    assert.ok(f.calls.some(([operation]) => operation === 'control-close'));
});

test('generation changes and state symlinks cannot launch a pair', async t => {
    const f = fixture(t);
    fs.symlinkSync(path.join(f.workspaceRoot, 'project'), storePath(f.workspaceRoot));
    await assert.rejects(f.call('pairs'), /Invalid coding session store/u);
    f.routePlan.lease.isCurrent = () => false;
    await assert.rejects(f.call('robots'), /Routing changed/u);
    assert.equal(f.sessions.size, 0);
});

test('resuming an already mapped running native conversation reuses the process', async t => {
    const f = fixture(t);
    const id = 's'.repeat(32);
    f.sessions.set(id, { id, status: 'detached', cwd: 'project', profileProvider: 'provider', profileId: 'default.default.vibe.r-original' });
    const result = await f.call('launch', { robot: 'default', codingAgent: 'vibe', resume: 'original' });
    assert.equal(result.terminalId, id);
    assert.equal(f.calls.some(([operation]) => operation === 'launch'), false);
    assert.equal(f.sessions.size, 1);
});

test('folder overview reads the persistent index and live terminals without scanning catalogs', async t => {
    const f = fixture(t);
    f.manager.homeProfiles.callCodingSession = async ({ operation }) => {
        if (operation === 'robots') return { robots: [{ id: 'a', name: 'Alpha renamed' }] };
        assert.equal(operation, 'index');
        return { sessions: [{ id: 'saved', title: 'My conversation', robotId: 'a', robotName: 'Alpha', codingAgent: 'vibe' },
            { id: 'old', robotId: 'a', robotName: 'Alpha', codingAgent: 'vibe' }] };
    };
    f.sessions.set('live', { id: 'live', cwd: 'project', status: 'detached', profileProvider: 'provider', profileId: 'a.default.vibe.r-saved' });
    f.sessions.set('other', { id: 'other', cwd: 'elsewhere', status: 'detached', profileProvider: 'provider', profileId: 'b.default.vibe.r-saved' });
    const result = await f.call('overview');
    assert.deepEqual(result.running.map(row => [row.id, row.robotName, row.codingAgent]), [['live', 'Alpha renamed', 'vibe']]);
    assert.deepEqual(result.sessions.map(row => row.id), ['old']);
    assert.equal(result.running[0].title, 'My conversation');
    assert.equal(result.refreshing, false);
});

test('slow catalog reads do not hold the launch mutation queue', async t => {
    const f = fixture(t);
    let release;
    const original = f.manager.homeProfiles.callCodingSession;
    f.manager.homeProfiles.callCodingSession = args => args.operation === 'history'
        ? new Promise(resolve => { release = () => resolve({ sessions: [] }); }) : original(args);
    const history = f.call('sessions', { robot: 'default', codingAgent: 'vibe' });
    await new Promise(resolve => setImmediate(resolve));
    try {
        const launch = await f.call('launch', { robot: 'default', codingAgent: 'claude', resume: null });
        assert.ok(launch.attach);
    } finally { release(); await history; }
});

test('Kill captures native history, stops only the selected process and retains resumable rows', async t => {
    const f = fixture(t), id = 'k'.repeat(32);
    const indexed = [];
    f.sessions.set(id, { id, cwd: 'project', status: 'detached', profileProvider: 'provider', profileId: 'default.default.omp' });
    const operations = [];
    f.manager.homeProfiles.callCodingSession = async ({ operation, body }) => {
        operations.push(operation);
        if (operation === 'sync-history') {
            assert.deepEqual(body, { robot: 'default', codingAgent: 'omp', directory: 'project' });
            if (!indexed.length) indexed.push({ id: 'native-original', title: 'Work', robotId: 'default', codingAgent: 'omp' });
            return { ok: true };
        }
        if (operation === 'robots') return { robots: [{ id: 'a', name: 'Alpha renamed' }] };
        assert.equal(operation, 'index'); return { ok: true, sessions: indexed };
    };
    const close = f.manager.closeAuthorized;
    f.manager.closeAuthorized = async (...args) => { operations.push('kill'); return close(...args); };
    assert.equal((await f.call('kill', { id })).historySaved, true);
    assert.deepEqual(operations, ['sync-history', 'kill', 'sync-history']);
    const result = await f.call('overview');
    assert.equal(result.running.length, 0);
    assert.equal(result.sessions[0].id, 'native-original');
});

test('catalog failure does not prevent Kill and cannot target another folder', async t => {
    const f = fixture(t), id = 'k'.repeat(32);
    f.sessions.set(id, { id, cwd: 'other', status: 'detached', profileProvider: 'provider', profileId: 'default.default.omp' });
    await assert.rejects(f.call('kill', { id }), /no longer running/);
    f.sessions.get(id).cwd = 'project';
    f.manager.homeProfiles.callCodingSession = async () => { throw new Error('catalog unavailable'); };
    assert.equal((await f.call('kill', { id })).historySaved, false);
    assert.equal(f.sessions.has(id), false);
});


test('readiness waits for terminal and provider services without reading histories', async t => {
    const f = fixture(t);
    f.manager.availability = () => ({ ok: false });
    assert.equal((await codingSessionReadiness(f.manager, {}, f.routePlan)).ready, false);
    assert.equal(f.calls.length, 0);
    f.manager.availability = () => ({ ok: true });
    assert.equal((await codingSessionReadiness(f.manager, {}, f.routePlan)).ready, true);
    assert.deepEqual(f.calls.map(([operation]) => operation), ['robots']);
    f.manager.homeProfiles.callCodingSession = async () => { throw new Error('Starting'); };
    assert.equal((await codingSessionReadiness(f.manager, {}, f.routePlan)).ready, false);
    f.manager.validatedLease = async () => { throw new Error('Unauthorized'); };
    await assert.rejects(codingSessionReadiness(f.manager, {}, f.routePlan), /Unauthorized/);
});

test('an unsaved role starts fresh in the same pair and subsequently resumes its associated conversation', async t => {
    const f = fixture(t);
    await f.call('create-pair', { supervisor: { robotId: 'a', codingAgent: 'vibe' }, worker: { robotId: 'a', codingAgent: 'vibe' } });
    const pair = readStore(storePath(f.workspaceRoot)).sessions[0];
    f.sessions.clear();
    const before = f.calls.filter(([op]) => op === 'launch').length;
    await f.call('open-role', { id: pair.id, role: 'supervisor' });
    const launches = f.calls.filter(([op]) => op === 'launch');
    assert.equal(launches.length, before + 1);
    assert.equal(launches.at(-1)[1].resume, null);
    let stored = readStore(storePath(f.workspaceRoot));
    assert.equal(stored.sessions.length, 1);
    assert.equal(stored.sessions[0].id, pair.id);
    assert.equal(stored.sessions[0].supervisor.sessionBinding, pair.supervisor.sessionBinding);
    assert.deepEqual(stored.sessions[0].worker, pair.worker);
    f.sessions.clear();
    const original = f.manager.homeProfiles.callCodingSession;
    f.manager.homeProfiles.callCodingSession = async input => input.operation === 'history'
        ? { sessions: [{ id: 'saved-supervisor', sessionBinding: pair.supervisor.sessionBinding }] }
        : original(input);
    await f.call('open-role', { id: pair.id, role: 'supervisor' });
    assert.equal(f.calls.filter(([op]) => op === 'launch').at(-1)[1].resume, 'saved-supervisor');
    stored = readStore(storePath(f.workspaceRoot));
    assert.equal(stored.sessions[0].supervisor.nativeSessionId, 'saved-supervisor');
});

test('supervised lists resolve current robot names instead of saved IDs', async t => {
    const f = fixture(t);
    await f.call('create-pair', { supervisor: { robotId: 'default', codingAgent: 'vibe' }, worker: { robotId: 'default', codingAgent: 'vibe' } });
    const result = await f.call('pairs');
    assert.deepEqual(result.pairs[0].roles.map(role => role.robotName), ['Default', 'Default']);
});
