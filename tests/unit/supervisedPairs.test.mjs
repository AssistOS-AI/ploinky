import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebttySessionManager } from '../../cli/server/webtty/sessionManager.mjs';
import { SupervisedPairs, readPairResults } from '../../cli/server/webtty/supervisedPairs.mjs';

function fixture(t) {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'server-supervision-'));
    const stat = fs.statSync(folder);
    let now = 1000;
    let current = true;
    const input = [];
    const commands = [];
    const answers = [];
    const request = { user: { id: 'admin', roles: ['admin'] }, authMode: 'local', authChannel: 'cli', headers: { authorization: 'never-retain' } };
    const snapshot = { routing: { routes: { provider: { agent: 'provider', repo: 'repo', container: 'container' } } },
        agents: { container: { type: 'agent', agentName: 'provider', repoName: 'repo', containerId: 'container-id', instanceId: 'instance', enableGeneration: 'enabled' } },
        manifests: { provider: { webtty: { homeProfiles: { version: 1, resolve: '/base-agent-additional-server/provider/3001/api/resolve' } } } } };
    const routePlan = { snapshot, lease: { snapshot, isCurrent: () => current, commit: () => current } };
    const terminal = id => ({ id: id.repeat(32), owner: { principal: 'owner' }, routerEpoch: 'epoch', profile: { provider: 'provider', id: `${id}-profile` },
        cwdRelative: 'project', target: { directory: { absolutePath: folder, identity: { dev: stat.dev, ino: stat.ino } } }, lastOutputAt: null });
    const supervisor = terminal('s'); const worker = terminal('w');
    const manager = { retainDetachedForSupervision: WebttySessionManager.prototype.retainDetachedForSupervision, sessions: new Map([[supervisor.id, supervisor], [worker.id, worker]]), routerEpoch: 'epoch', now: () => now,
        auth: { createLease: () => ({ principal: 'owner' }), validateLease: async () => ({ ok: true }) },
        authorize: async (_req, _plan, id) => manager.sessions.get(id),
        input: async (session, text) => { input.push([session.id, text]); },
        homeProfiles: { async callControl(options) {
            assert.equal(options.req.headers, undefined);
            assert.equal(options.req.sessionId, undefined);
            assert.equal(options.body.profile, supervisor.profile.id);
            if (options.body.validateOnly) return { ok: true, requests: [] };
            answers.push(...options.body.results);
            return { ok: true, requests: commands.splice(0) };
        } } };
    const service = new SupervisedPairs(manager);
    t.after(() => { service.close(); fs.rmSync(folder, { recursive: true, force: true }); });
    const body = { id: 'pair-1', supervisor: supervisor.id, worker: worker.id, controlId: '11111111-1111-4111-8111-111111111111', interruptInput: '\u001b' };
    return { service, manager, request, routePlan, body, supervisor, worker, folder, input, commands, answers,
        advance: value => { now += value; }, stale: () => { current = false; } };
}

test('server relays worker commands and monitors ten-minute silence with no connected CLI or viewer', async t => {
    const f = fixture(t);
    await f.service.register(f.request, f.routePlan, f.body);
    const pair = f.service.pairs.get(f.body.id);
    await pair.relay.once();
    // Nothing from the registration request is needed again: the CLI has gone away.
    f.request.headers = null;
    f.request.user = null;
    f.commands.push({ requestId: 'send', deadline: 1000000, operation: 'worker_send', arguments: { message: 'Read tasks.md' } });
    await pair.relay.once(); await pair.relay.once();
    assert.equal(f.input.length, 1);
    assert.equal(f.input[0][0], f.worker.id);
    assert.match(f.input[0][1], /Read tasks.md/u);
    assert.equal(f.answers.find(a => a.requestId === 'send').result.delivered, true);
    f.advance(600001);
    await pair.monitor.once();
    assert.equal(f.input[1][0], f.supervisor.id);
    assert.match(f.input[1][1], /No worker terminal output for 10 minutes/u);
    await pair.monitor.once();
    assert.equal(f.input.length, 2, 'no duplicate alarm');
    fs.writeFileSync(path.join(f.folder, 'results.md'), '## Parser fix\nChecks passed.\n');
    await pair.monitor.once();
    assert.match(f.input[2][1], /worker results/u);
    f.commands.push({ requestId: 'status', deadline: 1000000, operation: 'worker_status', arguments: {} });
    f.manager.sessions.delete(f.worker.id);
    await pair.relay.once(); await pair.relay.once();
    assert.equal(f.answers.find(a => a.requestId === 'status').result.running, false);
});

test('registration is idempotent and rejects cross-owner, cross-folder and cross-provider pairing', async t => {
    const f = fixture(t);
    await f.service.register(f.request, f.routePlan, f.body);
    const first = f.service.pairs.get(f.body.id);
    await f.service.register(f.request, f.routePlan, f.body);
    assert.equal(f.service.pairs.get(f.body.id), first);
    for (const mutate of [() => { f.worker.owner.principal = 'other'; }, () => { f.worker.cwdRelative = 'other'; }, () => { f.worker.profile.provider = 'other'; }]) {
        mutate();
        await assert.rejects(f.service.register(f.request, f.routePlan, f.body));
        f.worker.owner.principal = 'owner'; f.worker.cwdRelative = 'project'; f.worker.profile.provider = 'provider';
    }
    await assert.rejects(f.service.register(f.request, f.routePlan, { ...f.body, id: 'another-pair' }));
});

test('revocation or stale routing prevents subsequent terminal input', async t => {
    const f = fixture(t);
    await f.service.register(f.request, f.routePlan, f.body);
    const pair = f.service.pairs.get(f.body.id);
    await pair.relay.once();
    f.commands.push({ requestId: 'interrupt', deadline: 1000000, operation: 'worker_interrupt', arguments: {} });
    f.stale();
    await pair.relay.once();
    assert.equal(f.input.length, 0);
    f.supervisor.closed = true;
    await pair.relay.once();
    assert.equal(f.service.pairs.size, 0);
});

test('results reader refuses symlinks, replaced directories and oversized files', t => {
    const f = fixture(t);
    const identity = f.supervisor.target.directory.identity;
    fs.symlinkSync('/etc/passwd', path.join(f.folder, 'results.md'));
    assert.throws(() => readPairResults(f.folder, identity));
    fs.unlinkSync(path.join(f.folder, 'results.md'));
    fs.writeFileSync(path.join(f.folder, 'results.md'), 'a'.repeat(1024 * 1024 + 1));
    assert.throws(() => readPairResults(f.folder, identity));
    assert.throws(() => readPairResults(f.folder, { dev: -1, ino: -1 }));
});


test('only validated pairs retain both running terminals without attaching a viewer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t);
    f.manager.limits = { streamDetachGraceMs: 15000 };
    const closed = [];
    f.manager.closeSession = async session => { closed.push(session.id); session.closed = true; };
    for (const session of [f.supervisor, f.worker]) {
        WebttySessionManager.prototype.scheduleDetachedClose.call(f.manager, session, 'stream_never_attached');
    }
    await f.service.register(f.request, f.routePlan, f.body);
    for (const session of [f.supervisor, f.worker]) {
        assert.equal(session.backgroundAdmitted, true);
        assert.ok(!session.everAttached);
        assert.equal(session.detachTimer, null);
    }
    t.mock.timers.tick(16000);
    assert.deepEqual(closed, []);
    assert.equal(f.service.live(f.worker), true);
    f.service.stop(f.body.id);
    // Admitted terminals retain their ordinary lifetime even if monitoring is subsequently removed.
    WebttySessionManager.prototype.scheduleDetachedClose.call(f.manager, f.worker, 'stream_never_attached');
    t.mock.timers.tick(16000);
    assert.deepEqual(closed, []);
});

test('a failed control claim leaves unattached terminals subject to orphan cleanup', async t => {
    const f = fixture(t);
    f.manager.homeProfiles.callControl = async () => { throw new Error('invalid claim'); };
    await assert.rejects(f.service.register(f.request, f.routePlan, f.body), /invalid claim/u);
    assert.equal(f.supervisor.backgroundAdmitted, undefined);
    assert.equal(f.worker.backgroundAdmitted, undefined);
});
