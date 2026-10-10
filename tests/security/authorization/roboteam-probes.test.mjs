// The RoboTeam family probes (agent-probes.mjs runRoboteamProbes, decision D14) against an offline model of the
// 3001 family at 4943549a plus the entitlement gate. selfRegistered must receive exactly the RoboTeam refusal on every
// gated route; a Router 401, CSRF or origin refusal does not count; a fail-open gate fails every selfRegistered check and
// starts nothing; a fixture collision aborts the block before any probe request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROBOTEAM_BASE, ROBOTEAM_GAPS, ROBOTEAM_ENTITLEMENT_REFUSAL, ROBOTEAM_UNPROBED, roboteamProbes, roboteamCheckDefinitions, roboteamCheckId,
    runRoboteamProbes, assertRoboteamEntitlementRefusal, assertRoboteamReach, roboteamAbsentName,
} from './agent-probes.mjs';

const PREFIX = 'authz-mk1-0a1b2c3d';
const ABSENT = `${PREFIX}-absent`;
const RT = { ok: false, error: ROBOTEAM_ENTITLEMENT_REFUSAL.error };
const ADMIN_REFUSAL = { ok: false, error: 'administrator role is required' };
const NOT_AUTH = { ok: false, error: 'authenticated Ploinky user is required' };
const reply = (status, body, type = 'application/json; charset=utf-8') => ({
    status, headers: { 'content-type': type },
    json: type.startsWith('application/json') ? body : undefined,
    text: typeof body === 'string' ? body : JSON.stringify(body),
});
const ACTORS = ['anonymous', 'selfRegistered', 'userA', 'userB'];

function roboteamWorld({ selfRegisteredReaches = false, selfRegisteredRefusal = RT, collision = false, listingFails = false, anonymousStatus = 'router', anonymousStatusReply = null, robots = [] } = {}) {
    const requests = [];
    const started = { runs: 0, tasks: 0, created: 0, deleted: 0 };
    const existing = new Set([...robots, ...(collision ? [ABSENT] : [])]);
    function handle(actor, { method, path: full, body }) {
        requests.push({ actor, method, path: full, body: body === undefined ? undefined : structuredClone(body) });
        assert.ok(full.startsWith(ROBOTEAM_BASE), `unexpected path ${full}`);
        const [route] = full.slice(ROBOTEAM_BASE.length).split('?');
        if (route === '/status' && actor === 'anonymous') return anonymousStatusReply || (anonymousStatus === 'allow' ? reply(200, { ok: true, service: 'RoboTeamAgent' }) : reply(401, NOT_AUTH));
        if (actor === 'anonymous') return reply(401, NOT_AUTH);
        if (route === '/status') return reply(200, { ok: true, service: 'RoboTeamAgent', modes: ['browser', 'desktop'] });
        if (method === 'GET' && route === '/api/robots') {
            if (listingFails) return reply(500, { ok: false, error: 'request failed' });
            return actor === 'admin' ? reply(200, { ok: true, canAdmin: true, robots: [...existing].map((id) => ({ id, name: id })) }) : reply(200, { ok: true, canAdmin: false, robots: [] });
        }
        // The family gate: a signed user without the Explorer entitlement is refused before any route or role logic.
        if (actor === 'selfRegistered' && !selfRegisteredReaches) return reply(403, selfRegisteredRefusal);
        const admin = actor === 'admin';
        if (method === 'GET' && route === '/') return reply(200, '<html><head>\n  <base href="./">\n</head></html>', 'text/html; charset=utf-8');
        if (method === 'GET' && route === '/flows') return reply(200, '<html></html>', 'text/html; charset=utf-8');
        if (method === 'GET' && route === '/config.js') return reply(200, 'globalThis.ROBOTEAM_CONFIG={};\n', 'text/javascript; charset=utf-8');
        if (method === 'GET' && route === '/styles.css') return reply(200, 'body{}', 'text/css; charset=utf-8');
        let match;
        if ((match = route.match(/^\/api\/robots\/([a-z0-9][a-z0-9-]{2,63})\/(run|logs|session\/?.*)$/))) {
            const id = match[1];
            if (!existing.has(id)) return reply(404, { ok: false, error: 'robot not found' });
            if (method === 'POST') started.runs++;
            return reply(200, { ok: true });
        }
        if (method === 'POST' && route === '/api/control') {
            if (!existing.has(body?.robotName)) return reply(404, { ok: false, error: 'robot not found' });
            started.tasks++; return reply(202, { ok: true });
        }
        if (method === 'POST' && route === '/api/robots') {
            if (!admin) return reply(403, ADMIN_REFUSAL);
            started.created++; return reply(201, { ok: true });
        }
        if (method === 'GET' && route === '/api/summary') return reply(404, { ok: false, error: 'Summary source not found' });
        if (method === 'GET' && /^\/api\/webchat\/logs\//.test(route)) return reply(404, 'log not found', 'text/plain; charset=utf-8');
        return reply(404, { ok: false, error: 'not found' });
    }
    return { handle, requests, started, existing };
}

async function runWorld(options = {}) {
    const world = roboteamWorld(options);
    const passed = [], failed = new Map(), gaps = [], order = [];
    const ctx = {
        prefix: PREFIX, report: {}, secrets: new Set(), async guard() {},
        recordGap: (id, reason, evidence) => gaps.push({ id, reason, evidence }),
        request: async (actor, request) => world.handle(actor, request),
        async check(id, fn) { order.push(id); try { await fn(); passed.push(id); } catch (error) { failed.set(id, String(error?.message || error)); } },
    };
    await runRoboteamProbes(ctx);
    return { world, passed, failed, gaps, order, ctx };
}
const defs = () => roboteamCheckDefinitions().map((entry) => entry.id);
const selfIds = (without = []) => roboteamProbes.filter((entry) => !without.includes(entry.name)).map((entry) => roboteamCheckId(entry, 'selfRegistered')).sort();

test('the table lists the 17 SPEC probes with a reach answer, a source and an unprobed list', () => {
    assert.deepEqual(roboteamProbes.map((entry) => entry.name), [
        'page.root', 'config', 'asset.styles', 'page.flows', 'run.get', 'run.start', 'run.stop', 'logs', 'session.http', 'control.start-simple-task',
        'control.open-desktop', 'control.message-task', 'control.robot-delete', 'robots.create', 'summary.session', 'webchat.logs', 'status.exempt',
    ]);
    for (const entry of roboteamProbes) {
        assert.match(entry.source, /^AchillesCLI\/roboTeamAgent\/server\/http-server\.mjs:\d+(-\d+)?$/);
        assert.ok(entry.reach && entry.reach.status, entry.name);
    }
    assert.ok(ROBOTEAM_UNPROBED.length >= 5);
    assert.deepEqual(Object.values(ROBOTEAM_GAPS), ['agent.roboteam.session.websocket.live']);
    assert.deepEqual(ROBOTEAM_ENTITLEMENT_REFUSAL, { status: 403, error: 'Explorer access permission is required to use RoboTeam' });
    assert.match(roboteamAbsentName('Authz-AB_c.1-0f'), /^[a-z0-9][a-z0-9-]{2,63}$/);
    assert.equal(roboteamAbsentName('x'.repeat(100)).length, 64);
});

test('check definitions: 84 unique ids, controls exist, robots.create uses the robot listing control', () => {
    const list = roboteamCheckDefinitions();
    const ids = list.map((entry) => entry.id);
    assert.equal(ids.length, 84);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(!ids.includes('agent.roboteam.robots.create.admin'));
    for (const entry of list) for (const control of entry.positiveControlAnyOf || []) assert.ok(ids.includes(control) || control === 'agent.robot.list.admin', `${entry.id} -> ${control}`);
    assert.deepEqual(list.find((entry) => entry.id === 'agent.roboteam.robots.create.selfRegistered').positiveControlAnyOf, ['agent.robot.list.admin']);
    assert.equal(list.find((entry) => entry.id === 'agent.roboteam.status.exempt.anonymous').positiveControlAnyOf, null);
});

test('a faithful gated family passes every check once, records the websocket limitation and starts nothing', async () => {
    const run = await runWorld();
    assert.deepEqual([...run.failed], []);
    assert.deepEqual([...run.order].sort(), defs().sort());
    assert.equal(new Set(run.order).size, run.order.length);
    assert.deepEqual(run.gaps.map((gap) => gap.id), ['agent.roboteam.session.websocket.live']);
    assert.equal(run.gaps[0].evidence.kind, 'declared-limitation');
    assert.deepEqual(run.world.started, { runs: 0, tasks: 0, created: 0, deleted: 0 });
    // The only request before the probes is the administrator listing, and every robot reference is the run-owned absent name.
    assert.equal(run.world.requests[0].path, `${ROBOTEAM_BASE}/api/robots`);
    const text = (request) => `${request.path} ${JSON.stringify(request.body || {})}`;
    for (const request of run.world.requests.slice(1)) {
        if (/\/api\/(robots\/|control)/.test(request.path) && request.body !== undefined || /\/api\/robots\/[^/]+\//.test(request.path)) assert.ok(text(request).includes(ABSENT), text(request));
    }
    assert.equal(run.world.requests.some((request) => request.actor === 'admin' && request.method === 'POST' && request.path.endsWith('/api/robots')), false, 'the administrator never creates a robot');
});

test('NEGATIVE: a fail-open gate fails every selfRegistered check, starts nothing and creates nothing', async () => {
    const run = await runWorld({ selfRegisteredReaches: true });
    assert.deepEqual([...run.failed.keys()].sort(), selfIds(['status.exempt']));
    assert.ok(run.failed.get('agent.roboteam.robots.create.selfRegistered'), 'the administrator refusal is not the family refusal');
    assert.ok(run.passed.includes('agent.roboteam.status.exempt.selfRegistered'), '/status is exempt and stays reachable');
    assert.deepEqual(run.world.started, { runs: 0, tasks: 0, created: 0, deleted: 0 });
});

test('NEGATIVE: a Router 401, CSRF, origin or administrator 403 for selfRegistered is not the family refusal', async () => {
    for (const error of ['authenticated Ploinky user is required', 'csrf token invalid', 'browser origin rejected', 'administrator role is required', 'Explorer access permission is required to use RoboFlow', 'Explorer access permission is required to use RoboTeam.', 'Explorer access is required to list robots']) {
        const run = await runWorld({ selfRegisteredRefusal: { ok: false, error } });
        assert.deepEqual([...run.failed.keys()].sort(), selfIds(['status.exempt']), error);
        assert.ok(run.passed.includes('agent.roboteam.run.get.anonymous') && run.passed.includes('agent.roboteam.run.get.userA'), 'the other actors are unaffected');
    }
    const status = await runWorld({ selfRegisteredRefusal: RT, selfRegisteredReaches: false });
    assert.ok(status.passed.includes('agent.roboteam.status.exempt.selfRegistered'));
    for (const bad of [{ status: 401, json: RT }, { status: 403, json: { ...RT, ok: true } }, { status: 403, json: { message: RT.error } }, { status: 200, json: RT }]) {
        assert.throws(() => assertRoboteamEntitlementRefusal(bad), JSON.stringify(bad));
    }
    assert.doesNotThrow(() => assertRoboteamEntitlementRefusal({ status: 403, json: RT }));
});

test('NEGATIVE: a fixture collision (or an unprovable listing) aborts the block, fails every check and sends no probe request', async () => {
    for (const options of [{ collision: true }, { listingFails: true }]) {
        const run = await runWorld(options);
        assert.deepEqual([...run.failed.keys()].sort(), defs().sort(), JSON.stringify(options));
        assert.match(run.failed.get('agent.roboteam.run.get.userA'), options.collision ? /fixture collision/ : /unavailable/);
        assert.equal(run.world.requests.length, 1, 'only the administrator listing was sent');
        assert.deepEqual(run.world.started, { runs: 0, tasks: 0, created: 0, deleted: 0 });
        assert.deepEqual(run.gaps.map((gap) => gap.id), ['agent.roboteam.session.websocket.live'], 'the declared limitation is still recorded, not converted');
    }
});

test('anonymous /status is informational: either the agent answer or a Router denial passes, anything else fails, and the observation is recorded', async () => {
    const denied = await runWorld();
    assert.ok(denied.passed.includes('agent.roboteam.status.exempt.anonymous'));
    assert.deepEqual(denied.ctx.report.roboteamAnonymousStatus, { status: 401, answer: 'other' });
    const allowed = await runWorld({ anonymousStatus: 'allow' });
    assert.ok(allowed.passed.includes('agent.roboteam.status.exempt.anonymous'));
    assert.deepEqual(allowed.ctx.report.roboteamAnonymousStatus, { status: 200, answer: 'agent-status-ok' });
    for (const bad of [reply(500, { ok: false, error: 'request failed' }), reply(200, { ok: true, service: 'Other' }), reply(404, { ok: false, error: 'not found' })]) {
        const run = await runWorld({ anonymousStatusReply: bad });
        assert.ok(run.failed.has('agent.roboteam.status.exempt.anonymous'), JSON.stringify(bad.json));
    }
});

test('the /status exemption is proven: a gate that also refuses /status fails the selfRegistered exemption check', async () => {
    const world = roboteamWorld();
    const original = world.handle;
    const run = await (async () => {
        const passed = [], failed = new Map();
        const ctx = { prefix: PREFIX, report: {}, async guard() {}, recordGap() {}, request: async (actor, request) => (actor === 'selfRegistered' && request.path.endsWith('/status')) ? reply(403, RT) : original(actor, request),
            async check(id, fn) { try { await fn(); passed.push(id); } catch (error) { failed.set(id, String(error?.message || error)); } } };
        await runRoboteamProbes(ctx);
        return { passed, failed };
    })();
    assert.deepEqual([...run.failed.keys()], ['agent.roboteam.status.exempt.selfRegistered']);
});

test('reach answers reject near misses', () => {
    const page = roboteamProbes.find((entry) => entry.name === 'page.root');
    assert.doesNotThrow(() => assertRoboteamReach(page, reply(200, '<head><base href="./"></head>', 'text/html; charset=utf-8')));
    for (const bad of [reply(200, '<head></head>', 'text/html'), reply(200, '<base href="./">', 'application/json'), reply(404, { ok: false, error: 'not found' })]) assert.throws(() => assertRoboteamReach(page, bad));
    const run = roboteamProbes.find((entry) => entry.name === 'run.get');
    assert.doesNotThrow(() => assertRoboteamReach(run, reply(404, { ok: false, error: 'robot not found' })));
    for (const bad of [reply(404, { ok: false, error: 'not found' }), reply(403, RT), reply(404, { ok: true, error: 'robot not found' }), reply(200, { ok: true })]) assert.throws(() => assertRoboteamReach(run, bad));
    const logs = roboteamProbes.find((entry) => entry.name === 'webchat.logs');
    assert.doesNotThrow(() => assertRoboteamReach(logs, reply(404, 'log not found', 'text/plain; charset=utf-8')));
    assert.throws(() => assertRoboteamReach(logs, reply(404, 'log not found', 'application/json')));
});
