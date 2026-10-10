// The RoboFlow HTTP probes (agent-probes.mjs runRoboflowProbes) against an offline model of the
// handlers served by AchillesCLI roboTeamAgent/server/http-server.mjs at 4943549a. A product that
// answers 2xx to an ordinary user's POST /schedules, or 403 to an ordinary user's GET /schedules, must
// fail exactly that check; no probe may start work even when the product fails open; nothing the
// run created may remain; and every schedule the run writes is disabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROBOFLOW_BASE, ROBOFLOW_ABSENT, ROBOFLOW_GAPS, roboflowProbes, roboflowCheckDefinitions, roboflowCheckId, roboflowAdminCheckId,
    runRoboflowProbes, assertRoboflowAdminRefusal, assertRoboflowReach, roboflowScheduleBody, ROBOFLOW_UNPROBED_READS,
} from './agent-probes.mjs';

const json = (status, body) => ({ status, json: body, headers: {}, text: JSON.stringify(body) });
const REFUSAL = { ok: false, error: 'administrator role is required' };
const ACTORS = ['anonymous', 'selfRegistered', 'userA', 'userB'];

/**
 * Model of handleRoboFlow. `open` names probes whose administrator gate is missing for ordinary users;
 * `everyoneReaches` removes every gate for every actor (a fully fail-open product). `started` counts
 * the only things the probes must never cause.
 */
function roboflowWorld({ open = new Set(), selfRegisteredReaches = false, everyoneReaches = false, usersCannotListSchedules = false, adminCreateFails = false, routerRefusesUsers = false } = {}) {
    const schedules = [], workflows = [], requests = [];
    const started = { flows: 0, generations: 0, folders: 0 };
    let sequence = 0;
    const gate = (actor, name) => actor === 'admin' || everyoneReaches || open.has(name) ? null
        : json(403, routerRefusesUsers ? { ok: false, error: 'csrf token invalid' } : REFUSAL);
    const listed = (schedule) => ({ ...schedule });
    function handle(actor, { method, path: full, body }) {
        requests.push({ actor, method, path: full, body: body === undefined ? undefined : structuredClone(body) });
        assert.ok(full.startsWith(ROBOFLOW_BASE), `unexpected path ${full}`);
        const route = full.slice(ROBOFLOW_BASE.length).split('?')[0];
        if (actor === 'anonymous' && !everyoneReaches) return json(401, { ok: false, error: 'authentication required' });
        if (actor === 'selfRegistered' && !selfRegisteredReaches && !everyoneReaches) return json(403, { ok: false, error: 'forbidden: workspace access required' });
        const refuse = (name) => gate(actor, name);
        let match;
        if (method === 'GET' && route === '/schedule-folders') return refuse('schedule-folders.list') || json(200, { ok: true, folder: '/workspace', folders: [], defaultPath: 'cron-jobs-results' });
        if (method === 'POST' && route === '/schedule-folders') {
            const refused = refuse('schedule-folders.create'); if (refused) return refused;
            if (typeof body?.name !== 'string' || body.name.includes('/')) return json(400, { ok: false, error: 'Enter one folder name without slashes' });
            started.folders++; return json(201, { ok: true });
        }
        if (method === 'POST' && route === '/validate') return refuse('workflows.validate') || json(200, { ok: true, graph: { ...body }, coverage: {}, diagnostics: [] });
        if (method === 'POST' && (route === '/generate' || route === '/generations')) {
            const refused = refuse(route === '/generate' ? 'generate' : 'generations.start'); if (refused) return refused;
            if (!String(body?.description || '').trim()) return json(400, { ok: false, error: 'description requires 1 to 32768 characters' });
            started.generations++; return json(202, { ok: true });
        }
        if (method === 'DELETE' && /^\/generations\/[0-9a-f-]{36}$/.test(route)) return refuse('generations.cancel') || json(404, { ok: false, error: 'generation not found' });
        if (method === 'GET' && route === '/workflows') return json(200, { ok: true, workflows: workflows.map((item) => ({ ...item })) });
        if (method === 'POST' && route === '/workflows') {
            const refused = refuse('workflows.create'); if (refused) return refused;
            if (workflows.some((item) => item.id === body.id)) return json(409, { ok: false, error: 'workflow id already exists' });
            const workflow = { id: body.id, name: body.name, revision: 1 }; workflows.push(workflow); return json(201, { ok: true, workflow: { ...workflow } });
        }
        if ((match = route.match(/^\/workflows\/([a-z0-9][a-z0-9-]{2,63})$/)) && method === 'PUT') {
            const refused = refuse('workflows.update'); if (refused) return refused;
            const workflow = workflows.find((item) => item.id === match[1]);
            if (!workflow) return json(404, { ok: false, error: 'workflow not found' });
            if (body.revision !== workflow.revision) return json(409, { ok: false, error: 'workflow changed; reload before saving' });
            workflow.name = body.name; workflow.revision++; return json(200, { ok: true, workflow: { ...workflow } });
        }
        if (match && method === 'DELETE') {
            const refused = refuse('workflows.delete'); if (refused) return refused;
            const index = workflows.findIndex((item) => item.id === match[1]);
            if (index >= 0) workflows.splice(index, 1);
            return json(200, { ok: true, deleted: index >= 0 });
        }
        if (method === 'GET' && route === '/schedules') {
            if (usersCannotListSchedules && (actor === 'userA' || actor === 'userB')) return json(403, { ok: false, error: 'forbidden' });
            return json(200, { ok: true, schedules: schedules.map(listed) });
        }
        if (method === 'POST' && route === '/schedules') {
            const refused = refuse('schedules.create'); if (refused) return refused;
            if (adminCreateFails && actor === 'admin') return json(500, { ok: false, error: 'request failed' });
            // The store's default is enabled:true with a computed next run, so a body that omits enabled would arm the schedule.
            const enabled = body.enabled ?? true;
            const schedule = { id: `cron_${String(++sequence).padStart(24, '0')}`, revision: 1, name: body.name, enabled, workflowTypeId: body.workflowTypeId, nextRunAt: enabled ? 'soon' : null };
            schedules.push(schedule); return json(201, { ok: true, schedule: listed(schedule) });
        }
        if ((match = route.match(/^\/schedules\/(cron_[0-9a-f]{24})$/)) && (method === 'PUT' || method === 'DELETE')) {
            const refused = refuse(method === 'PUT' ? 'schedules.update' : 'schedules.delete'); if (refused) return refused;
            const schedule = schedules.find((item) => item.id === match[1]);
            if (method === 'DELETE') {
                if (!schedule) return json(404, { ok: false, error: 'Cron job not found' });
                schedules.splice(schedules.indexOf(schedule), 1); return json(200, { ok: true, deleted: true });
            }
            if (!schedule) return json(404, { ok: false, error: 'Cron job not found' });
            if (body.revision !== schedule.revision) return json(409, { ok: false, error: 'Cron job changed; reload before saving' });
            Object.assign(schedule, { name: body.name ?? schedule.name, enabled: body.enabled ?? schedule.enabled }); schedule.revision++; schedule.nextRunAt = schedule.enabled ? 'soon' : null;
            return json(200, { ok: true, schedule: listed(schedule) });
        }
        if ((match = route.match(/^\/schedules\/(cron_[0-9a-f]{24})\/run-now$/)) && method === 'POST') {
            const refused = refuse('schedules.run-now'); if (refused) return refused;
            if (!schedules.some((item) => item.id === match[1])) return json(404, { ok: false, error: 'Cron job not found' });
            started.flows++; return json(200, { ok: true });
        }
        if (method === 'POST' && route === '/flows') {
            if (!['default', ...workflows.map((item) => item.id)].includes(body?.workflowTypeId)) return json(404, { ok: false, error: 'workflow not found' });
            started.flows++; return json(201, { ok: true });
        }
        if (method === 'POST' && /^\/flows\/flow_[0-9a-f]{24}(\/(human-input\/answer|pause|terminate|resume|instances\/inv_[0-9a-f]{24}\/(pause|message|resume)))$/.test(route)) {
            return json(404, { ok: false, error: 'workflow run not found' });
        }
        return json(404, { ok: false, error: 'not found' });
    }
    return { handle, schedules, workflows, requests, started };
}

async function runWorld(options = {}) {
    const world = roboflowWorld(options);
    const passed = [], failed = new Map(), gaps = [], cleanups = [], order = [];
    const ctx = {
        prefix: 'authz-mk1-0a1b2c3d', report: {}, async guard() {},
        recordGap: (id, reason, evidence) => gaps.push({ id, reason, evidence }),
        cleanup: (fn) => cleanups.push({ fn, atRequest: world.requests.length }),
        request: async (actor, request) => world.handle(actor, request),
        async check(id, fn) { order.push(id); try { await fn(); passed.push(id); } catch (error) { failed.set(id, String(error?.message || error)); } },
    };
    await runRoboflowProbes(ctx);
    return { world, passed, failed, gaps, cleanups, order, ctx };
}
const cleanAll = async (run) => { for (const { fn } of [...run.cleanups].reverse()) await fn(); };
const byName = (name) => roboflowProbes.find((entry) => entry.name === name);

test('the probe table lists the seven schedule method/path combinations and every other mutation served under /api/roboflow', () => {
    const key = (entry) => `${entry.method} ${entry.path}`;
    const keys = roboflowProbes.map(key);
    assert.equal(new Set(keys).size, keys.length, 'method/path combinations are unique');
    assert.equal(new Set(roboflowProbes.map((entry) => entry.name)).size, roboflowProbes.length);
    assert.deepEqual(keys.filter((value) => /\/schedule/.test(value)).sort(), [
        'DELETE /schedules/:schedule', 'GET /schedule-folders', 'GET /schedules', 'POST /schedule-folders', 'POST /schedules', 'POST /schedules/:schedule/run-now', 'PUT /schedules/:schedule',
    ]);
    assert.deepEqual(keys.filter((value) => !/\/schedule/.test(value)).sort(), [
        'DELETE /generations/:generation', 'DELETE /workflows/:workflow', 'POST /flows', 'POST /flows/:flow/human-input/answer', 'POST /flows/:flow/instances/:instance/message',
        'POST /flows/:flow/instances/:instance/pause', 'POST /flows/:flow/instances/:instance/resume', 'POST /flows/:flow/pause', 'POST /flows/:flow/resume', 'POST /flows/:flow/terminate',
        'POST /generate', 'POST /generations', 'POST /validate', 'POST /workflows', 'PUT /workflows/:workflow',
    ]);
    for (const entry of roboflowProbes) {
        assert.match(entry.source, /^AchillesCLI\/roboTeamAgent\/server\/http-server\.mjs:\d+-\d+$/);
        assert.ok(['admin', 'workspace'].includes(entry.policy));
        assert.ok(['positive', 'reach'].includes(entry.control));
        assert.equal(Boolean(entry.reach), entry.control === 'reach', `${entry.name}: a reach control carries its exact documented answer`);
        assert.equal(Boolean(entry.gap), entry.control === 'reach', `${entry.name}: every control that cannot be a real positive is a declared gap`);
    }
    // GET schedules follows D4a: workspace-readable as coded; every other schedule route is administrator-only.
    assert.equal(byName('schedules.list').policy, 'workspace');
    assert.ok(roboflowProbes.filter((entry) => /^schedule/.test(entry.name) && entry.name !== 'schedules.list').every((entry) => entry.policy === 'admin'));
    assert.ok(ROBOFLOW_UNPROBED_READS.length >= 5 && ROBOFLOW_UNPROBED_READS.every((line) => /^(GET) /.test(line)), 'read routes are listed and none is a mutation');
});

test('check definitions: unique ids, a positive control that exists, and one administrator control per probe', () => {
    const definitions = roboflowCheckDefinitions();
    const ids = definitions.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, roboflowProbes.length * 5);
    for (const entry of definitions) for (const control of entry.positiveControlAnyOf || []) assert.ok(ids.includes(control), `${entry.id} -> ${control}`);
    for (const entry of roboflowProbes) {
        assert.ok(ids.includes(roboflowAdminCheckId(entry)));
        for (const actor of ACTORS) assert.deepEqual(definitions.find((item) => item.id === roboflowCheckId(entry, actor)).positiveControlAnyOf, [roboflowAdminCheckId(entry)]);
    }
});

test('a faithful product passes every check exactly once, records the declared gaps, starts nothing and leaves nothing', async () => {
    const run = await runWorld();
    assert.deepEqual([...run.failed], []);
    assert.deepEqual([...run.order].sort(), roboflowCheckDefinitions().map((entry) => entry.id).sort());
    assert.equal(new Set(run.order).size, run.order.length, 'no check is recorded twice');
    assert.deepEqual(run.gaps.map((gap) => gap.id).sort(), [...new Set(Object.values(ROBOFLOW_GAPS))].sort());
    assert.ok(run.gaps.every((gap) => gap.evidence.kind === 'declared-limitation'));
    assert.deepEqual(run.world.started, { flows: 0, generations: 0, folders: 0 });
    // Positive control: every schedule body the run writes is disabled, and the cleanup exists before the first create.
    const writes = run.world.requests.filter((entry) => /\/schedules(\/cron_[0-9a-f]{24})?$/.test(entry.path) && ['POST', 'PUT'].includes(entry.method));
    assert.ok(writes.length >= 6, 'creates and updates by every actor were exercised');
    for (const entry of writes) assert.strictEqual(entry.body.enabled, false, `${entry.actor} ${entry.method} ${entry.path} must carry enabled:false`);
    const firstCreate = run.world.requests.findIndex((entry) => entry.method === 'POST' && /\/(schedules|workflows)$/.test(entry.path));
    assert.ok(run.cleanups.length >= 1 && run.cleanups.every((entry) => entry.atRequest <= firstCreate), 'cleanup is armed before the first creation');
    assert.equal(run.world.requests.filter((entry) => entry.path.endsWith('/run-now')).every((entry) => entry.path.includes(ROBOFLOW_ABSENT.schedule)), true, 'run-now only ever targets an absent schedule');
    // The fixture is deleted by its own positive control; the sweep finds nothing and still proves absence.
    await cleanAll(run);
    assert.deepEqual(run.world.schedules, []);
    assert.deepEqual(run.world.workflows, []);
});

test('NEGATIVE: an ordinary user whose POST /schedules succeeds fails that check, and the leaked schedule is still removed', async () => {
    const run = await runWorld({ open: new Set(['schedules.create']) });
    assert.deepEqual([...run.failed.keys()].sort(), ['agent.roboflow.schedules.create.userA', 'agent.roboflow.schedules.create.userB']);
    assert.ok(run.passed.includes('agent.roboflow.schedules.create.admin'), 'the administrator positive still passes');
    assert.ok(run.world.schedules.some((item) => item.name.startsWith('authz-mk1-0a1b2c3d-deny')), 'the model leaked a schedule');
    assert.ok(run.world.schedules.every((item) => item.enabled === false), 'even a leaked schedule is disabled');
    await cleanAll(run);
    assert.deepEqual(run.world.schedules, []);
});

test('NEGATIVE: an ordinary user who is refused GET /schedules fails that check (D4a: workspace-readable)', async () => {
    const run = await runWorld({ usersCannotListSchedules: true });
    assert.deepEqual([...run.failed.keys()].sort(), ['agent.roboflow.schedules.list.userA', 'agent.roboflow.schedules.list.userB']);
    assert.ok(run.passed.includes('agent.roboflow.schedules.list.anonymous') && run.passed.includes('agent.roboflow.schedules.list.selfRegistered'));
});

test('a Router refusal cannot stand in for the handler administrator refusal of an ordinary user', async () => {
    const run = await runWorld({ routerRefusesUsers: true });
    const expected = roboflowProbes.filter((entry) => entry.policy === 'admin').flatMap((entry) => ['userA', 'userB'].map((actor) => roboflowCheckId(entry, actor)));
    assert.deepEqual([...run.failed.keys()].filter((id) => expected.includes(id)).sort(), [...expected].sort());
    assert.ok(run.passed.includes('agent.roboflow.schedules.create.anonymous'), 'anonymous still only needs an authorization denial');
});

test('a selfRegistered user who reaches the handler fails the workspace-route denials and is reported, not relaxed', async () => {
    const run = await runWorld({ selfRegisteredReaches: true });
    const workspace = roboflowProbes.filter((entry) => entry.policy === 'workspace').map((entry) => roboflowCheckId(entry, 'selfRegistered'));
    assert.deepEqual([...run.failed.keys()].sort(), [...workspace].sort());
    // The administrator routes are still refused by the handler itself, which is an authorization denial.
    assert.ok(run.passed.includes('agent.roboflow.schedules.create.selfRegistered'));
});

test('a fully fail-open product fails every denial, yet no probe starts work and the run leaves nothing', async () => {
    const run = await runWorld({ everyoneReaches: true });
    for (const entry of roboflowProbes) {
        if (entry.policy === 'admin') for (const actor of ACTORS) assert.ok(run.failed.has(roboflowCheckId(entry, actor)), `${entry.name} ${actor} must fail`);
        else for (const actor of ['anonymous', 'selfRegistered']) assert.ok(run.failed.has(roboflowCheckId(entry, actor)), `${entry.name} ${actor} must fail`);
    }
    assert.deepEqual(run.world.started, { flows: 0, generations: 0, folders: 0 }, 'nothing was launched');
    assert.ok(run.world.schedules.every((item) => item.enabled === false));
    await cleanAll(run);
    assert.deepEqual(run.world.schedules, []);
    assert.deepEqual(run.world.workflows, []);
});

test('an unavailable administrator fixture fails its dependents; it never turns into a pass or a gap', async () => {
    const run = await runWorld({ adminCreateFails: true });
    assert.ok(run.failed.has('agent.roboflow.schedules.create.admin'));
    for (const id of ['agent.roboflow.schedules.list.admin', 'agent.roboflow.schedules.update.admin', 'agent.roboflow.schedules.delete.admin', 'agent.roboflow.schedules.list.userA']) {
        assert.match(run.failed.get(id), /was not reached/, id);
    }
    assert.deepEqual(run.gaps.map((gap) => gap.id).sort(), [...new Set(Object.values(ROBOFLOW_GAPS))].sort());
    assert.deepEqual([...run.order].sort(), roboflowCheckDefinitions().map((entry) => entry.id).sort(), 'every definition is still recorded exactly once');
});

test('exact answers: the administrator refusal and the reach answer reject near misses', () => {
    assert.doesNotThrow(() => assertRoboflowAdminRefusal(json(403, REFUSAL)));
    for (const bad of [json(401, REFUSAL), json(403, { ...REFUSAL, ok: true }), json(403, { ok: false, error: 'csrf token invalid' }), json(403, { ok: false, error: 'Administrator role is required' }), json(200, REFUSAL), json(403, { ok: false, message: REFUSAL.error })]) {
        assert.throws(() => assertRoboflowAdminRefusal(bad), JSON.stringify(bad.json));
    }
    const entry = byName('schedules.run-now');
    assert.doesNotThrow(() => assertRoboflowReach(entry, json(404, { ok: false, error: 'Cron job not found' })));
    for (const bad of [json(200, { ok: true }), json(403, REFUSAL), json(404, { ok: false, error: 'not found' }), json(404, { ok: true, error: 'Cron job not found' }), json(503, { ok: false, error: 'Cron job scheduler is not running' })]) {
        assert.throws(() => assertRoboflowReach(entry, bad), JSON.stringify(bad.json));
    }
});

test('schedule payloads are always disabled, whatever the caller asks for', () => {
    assert.strictEqual(roboflowScheduleBody('n', '/w').enabled, false);
    assert.strictEqual(roboflowScheduleBody('n', '/w', { enabled: true }).enabled, false);
    assert.equal(roboflowScheduleBody('n', '/w').workflowTypeId, 'default');
});
