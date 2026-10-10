// The RoboFlow HTTP probes (agent-probes.mjs runRoboflowProbes) against an offline model of the
// handlers served by AchillesCLI roboTeamAgent/server/http-server.mjs at 4943549a. A product that
// answers 2xx to an ordinary user's POST /schedules, or 403 to an ordinary user's GET /schedules, must
// fail exactly that check; no probe may start work even when the product fails open; nothing the
// run created may remain; and every schedule the run writes is disabled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ROBOFLOW_BASE, ROBOFLOW_ABSENT, ROBOFLOW_GAPS, roboflowProbes, roboflowCheckDefinitions, roboflowCheckId, roboflowAdminCheckId,
    runRoboflowProbes, assertRoboflowAdminRefusal, assertRoboflowEntitlementRefusal, assertRoboflowReach, roboflowScheduleBody, ROBOFLOW_UNPROBED_READS, ROBOFLOW_ENTITLEMENT_REFUSAL,
} from './agent-probes.mjs';
import { runOwnedCleanup } from './run-cleanup.mjs';

const json = (status, body) => ({ status, json: body, headers: {}, text: JSON.stringify(body) });
const REFUSAL = { ok: false, error: 'administrator role is required' };
// Decision D13 wording, taken from the production constant so a wording change needs one edit.
const ENTITLEMENT = { ok: false, error: ROBOFLOW_ENTITLEMENT_REFUSAL.error };
const ACTORS = ['anonymous', 'selfRegistered', 'userA', 'userB'];

/**
 * Model of handleRoboFlow. `open` names probes whose administrator gate is missing for ordinary users;
 * `everyoneReaches` removes every gate for every actor (a fully fail-open product). `started` counts
 * the only things the probes must never cause.
 */
function roboflowWorld({ open = new Set(), selfRegisteredReaches = false, selfRegisteredRefusal = ENTITLEMENT, everyoneReaches = false, usersCannotListSchedules = false, adminCreateFails = false, routerRefusesUsers = false,
    explorerRoot = '/workspace', explorerListFails = false, deleteFails = false, createReturnsFolder = null, preexisting = null } = {}) {
    const schedules = [], workflows = [], requests = [], folders = new Set(), files = new Set(), symlinks = new Map(), explorerCalls = [], events = [];
    // A pre-existing entry named like the run-owned child: a directory, a file or a symlink (to the named sibling).
    if (preexisting?.type === 'dir') folders.add(preexisting.name);
    if (preexisting?.type === 'file') files.add(preexisting.name);
    if (preexisting?.type === 'symlink') { folders.add(preexisting.target); symlinks.set(preexisting.name, preexisting.target); }
    const started = { flows: 0, generations: 0 };
    let sequence = 0;
    const gate = (actor, name) => actor === 'admin' || everyoneReaches || open.has(name) ? null
        : json(403, routerRefusesUsers ? { ok: false, error: 'csrf token invalid' } : REFUSAL);
    const listed = (schedule) => ({ ...schedule });
    function handle(actor, { method, path: full, body }) {
        requests.push({ actor, method, path: full, body: body === undefined ? undefined : structuredClone(body) });
        assert.ok(full.startsWith(ROBOFLOW_BASE), `unexpected path ${full}`);
        const [route, query = ''] = full.slice(ROBOFLOW_BASE.length).split('?');
        if (actor === 'anonymous' && !everyoneReaches) return json(401, { ok: false, error: 'authentication required' });
        if (actor === 'selfRegistered' && !selfRegisteredReaches && !everyoneReaches) return json(403, selfRegisteredRefusal);
        const refuse = (name) => gate(actor, name);
        let match;
        if (method === 'GET' && route === '/schedule-folders' && query.startsWith('path=')) {
            // ScheduleFolders.directory: lstat each segment; absent 404, symlink or non-directory 400, ordinary directory 200.
            const refused = refuse('schedule-folders.list'); if (refused) return refused;
            events.push('roboteam:path-read');
            const name = decodeURIComponent(query.slice(5));
            if (symlinks.has(name) || files.has(name)) return json(400, { ok: false, error: 'Choose an ordinary workspace folder' });
            if (!folders.has(name)) return json(404, { ok: false, error: 'Folder not found' });
            return json(200, { ok: true, path: name, folder: `/workspace/${name}`, folders: [] });
        }
        if (method === 'GET' && route === '/schedule-folders') return refuse('schedule-folders.list') || json(200, { ok: true, folder: '/workspace', folders: [...folders].map((name) => ({ name, path: name })), defaultPath: 'cron-jobs-results' });
        if (method === 'POST' && route === '/schedule-folders') {
            const refused = refuse('schedule-folders.create'); if (refused) return refused;
            if (typeof body?.name !== 'string' || body.name.includes('/')) return json(400, { ok: false, error: 'Enter one folder name without slashes' });
            if (folders.has(body.name) || files.has(body.name) || symlinks.has(body.name)) return json(409, { ok: false, error: 'A folder or file with that name already exists' });
            folders.add(body.name);
            return json(201, { ok: true, path: body.name, folder: createReturnsFolder || `/workspace/${body.name}`, folders: [...folders].map((name) => ({ name, path: name })) });
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
    // Explorer file tools (read-only listing, and delete_directory for the run-owned folder), shaped like createResourceMcp results.
    const explorerOk = (rawText) => ({ failed: false, value: { rawText }, response: { status: 200 } });
    async function mcp(principal, agent, tool, args = {}) {
        explorerCalls.push({ principal, agent, tool, args: structuredClone(args) });
        events.push(`explorer:${tool}`);
        if (tool === 'list_allowed_directories') return explorerListFails ? { failed: true, value: undefined, response: { status: 503 }, error: 'unavailable' } : explorerOk(`Allowed directories:\n${explorerRoot}`);
        if (tool === 'list_directory') return explorerOk(args.path === explorerRoot ? [...[...folders].map((name) => `[DIR] ${name}`), ...[...files].map((name) => `[FILE] ${name}`), ...[...symlinks.keys()].map((name) => `[LINK] ${name}`)].join('\n') : '');
        if (tool === 'get_file_info') {
            // Explorer stats after realpath, so a symlink to a directory reports a directory.
            const name = args.path.startsWith('/workspace/') ? args.path.slice('/workspace/'.length) : '';
            const real = symlinks.get(name) ?? name;
            if (folders.has(real)) return { failed: false, value: { path: args.path, isFile: false, isDirectory: true }, response: { status: 200 } };
            if (files.has(real)) return { failed: false, value: { path: args.path, isFile: true, isDirectory: false }, response: { status: 200 } };
            return { failed: true, value: undefined, response: { status: 500 }, error: 'ENOENT' };
        }
        if (tool === 'delete_directory') {
            if (deleteFails) return { failed: true, value: undefined, response: { status: 500 }, error: 'delete refused' };
            if (args.path.startsWith('/workspace/')) {
                // fs.rm after realpath: a symlink deletes its target, a regular entry deletes itself.
                const name = args.path.slice('/workspace/'.length);
                const real = symlinks.get(name) ?? name;
                folders.delete(real); files.delete(real); symlinks.delete(name);
            }
            return explorerOk(`Successfully deleted directory ${args.path}`);
        }
        throw new Error(`unexpected Explorer tool ${tool}`);
    }
    // The run-owned child is replaced by a symlink to a sibling directory between the create and the cleanup.
    function swapForSymlink(name, sibling) { folders.delete(name); folders.add(sibling); symlinks.set(name, sibling); }
    return { handle, mcp, schedules, workflows, requests, started, folders, files, symlinks, explorerCalls, events, swapForSymlink };
}

async function runWorld(options = {}) {
    const world = roboflowWorld(options);
    const passed = [], failed = new Map(), gaps = [], cleanups = [], order = [];
    const armed = { atFolderCreate: null };
    const ctx = {
        prefix: 'authz-mk1-0a1b2c3d', report: { cleanup: [] }, secrets: new Set(), async guard() {},
        recordGap: (id, reason, evidence) => gaps.push({ id, reason, evidence }),
        cleanup: (fn) => cleanups.push({ fn, atRequest: world.requests.length }),
        request: async (actor, request) => {
            if (request.method === 'POST' && request.path.endsWith('/schedule-folders') && request.body?.name === 'authz-mk1-0a1b2c3d-folder') armed.atFolderCreate = cleanups.length;
            return world.handle(actor, request);
        },
        async check(id, fn) { order.push(id); try { await fn(); passed.push(id); } catch (error) { failed.set(id, String(error?.message || error)); } },
    };
    await runRoboflowProbes(ctx, { mcp: world.mcp });
    return { world, passed, failed, gaps, cleanups, order, ctx, armed };
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
    assert.deepEqual(run.world.started, { flows: 0, generations: 0 });
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
    assert.equal(run.world.folders.size, 0, 'the run-owned folder is gone');
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

const selfRegisteredIds = roboflowProbes.map((entry) => roboflowCheckId(entry, 'selfRegistered')).sort();

test('a selfRegistered user who reaches the handler fails every selfRegistered check and is reported, not relaxed', async () => {
    const run = await runWorld({ selfRegisteredReaches: true });
    assert.deepEqual([...run.failed.keys()].sort(), selfRegisteredIds);
    // The handler's own administrator refusal is not the entitlement refusal (D13), so it is no substitute on administrator routes.
    assert.match(run.failed.get('agent.roboflow.schedules.create.selfRegistered'), /entitlement refusal/);
});

test('NEGATIVE: selfRegistered must receive the exact entitlement refusal; a CSRF, origin or login 403 is not accepted', async () => {
    const good = await runWorld();
    for (const id of selfRegisteredIds) assert.ok(good.passed.includes(id), id);
    for (const error of ['csrf token invalid', 'browser origin rejected', 'forbidden: workspace access required', 'administrator role is required', 'Explorer access permission is required to use RoboFlow.', 'explorer access permission is required to use roboflow']) {
        const run = await runWorld({ selfRegisteredRefusal: { ok: false, error } });
        assert.deepEqual([...run.failed.keys()].sort(), selfRegisteredIds, error);
        assert.ok(run.passed.includes('agent.roboflow.schedules.create.anonymous'), 'anonymous keeps assertDenied');
    }
    for (const bad of [json(401, ENTITLEMENT), json(403, { ...ENTITLEMENT, ok: true }), json(403, { ok: false, message: ENTITLEMENT.error }), json(200, ENTITLEMENT)]) {
        assert.throws(() => assertRoboflowEntitlementRefusal(bad), JSON.stringify(bad.json));
    }
    assert.doesNotThrow(() => assertRoboflowEntitlementRefusal(json(403, ENTITLEMENT)));
});

test('a fully fail-open product fails every denial, yet no probe starts work and the run leaves nothing', async () => {
    const run = await runWorld({ everyoneReaches: true });
    for (const entry of roboflowProbes) {
        if (entry.policy === 'admin') for (const actor of ACTORS) assert.ok(run.failed.has(roboflowCheckId(entry, actor)), `${entry.name} ${actor} must fail`);
        else for (const actor of ['anonymous', 'selfRegistered']) assert.ok(run.failed.has(roboflowCheckId(entry, actor)), `${entry.name} ${actor} must fail`);
    }
    assert.deepEqual(run.world.started, { flows: 0, generations: 0 }, 'nothing was launched');
    assert.ok(run.world.schedules.every((item) => item.enabled === false));
    await cleanAll(run);
    assert.deepEqual(run.world.schedules, []);
    assert.deepEqual(run.world.workflows, []);
    assert.equal(run.world.folders.size, 0, 'the run-owned folder is gone');
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

const FOLDER_CHECK = 'agent.roboflow.schedule-folders.create.admin';
const CHILD = 'authz-mk1-0a1b2c3d-folder';

test('folder create positive: matching roots create one run-owned child, cleanup is armed first, guarded, and leaves nothing', async () => {
    const run = await runWorld();
    assert.ok(run.passed.includes(FOLDER_CHECK));
    assert.ok(run.armed.atFolderCreate >= 2, 'the folder cleanup (and the sweep) are registered before the create request');
    assert.ok(run.world.folders.has(CHILD));
    const created = run.world.requests.filter((entry) => entry.path.endsWith('/schedule-folders') && entry.body?.name === CHILD);
    assert.equal(created.length, 1);
    assert.equal(created[0].actor, 'admin');
    await cleanAll(run);
    assert.equal(run.world.folders.size, 0);
    const deletes = run.world.explorerCalls.filter((call) => call.tool === 'delete_directory');
    assert.deepEqual(deletes.map((call) => call.args.path), [`/workspace/${CHILD}`], 'only the exact run-owned child is deleted, directly under the root');
    assert.ok(run.world.explorerCalls.every((call) => call.principal === 'admin' && call.agent === 'explorer'));
});

test('NEGATIVE: a root mismatch fails the folder create check early, creates nothing and arms no folder cleanup', async () => {
    for (const options of [{ explorerRoot: '/other/workspace' }, { explorerListFails: true }]) {
        const run = await runWorld(options);
        assert.deepEqual([...run.failed.keys()], [FOLDER_CHECK], JSON.stringify(options));
        assert.match(run.failed.get(FOLDER_CHECK), options.explorerListFails ? /unavailable/ : /ROOT_INCOMPATIBLE/);
        assert.equal(run.world.folders.size, 0);
        assert.equal(run.world.requests.some((entry) => entry.path.endsWith('/schedule-folders') && entry.body?.name === CHILD), false, 'no create request was sent');
        assert.equal(run.world.explorerCalls.some((call) => call.tool === 'delete_directory'), false);
        assert.equal(run.cleanups.length, 1, 'only the schedule and workflow sweep is armed');
        assert.deepEqual(run.gaps.map((gap) => gap.id).sort(), [...new Set(Object.values(ROBOFLOW_GAPS))].sort(), 'a mismatch is never converted into a gap');
    }
});

test('NEGATIVE: a failed Explorer delete is a recorded cleanup FAILURE and the folder is still reported', async () => {
    const run = await runWorld({ deleteFails: true });
    assert.deepEqual([...run.failed], [], 'the run itself passes');
    await runOwnedCleanup(run.ctx, run.cleanups.map((entry) => entry.fn), { closeStreams() {} });
    const statuses = run.ctx.report.cleanup.map((entry) => entry.status);
    assert.deepEqual(statuses.slice().sort(), ['FAIL', 'PASS'], 'exactly the folder cleanup failed');
    assert.match(run.ctx.report.cleanup.find((entry) => entry.status === 'FAIL').error, /run-owned schedule folder cleanup/);
    assert.ok(run.world.folders.has(CHILD), 'the undeleted folder is left in place for the operator');
});

test('NEGATIVE: a create that answers a different path fails the check, and cleanup refuses to delete what it cannot prove it created', async () => {
    const run = await runWorld({ createReturnsFolder: '/elsewhere/authz-mk1-0a1b2c3d-folder' });
    assert.deepEqual([...run.failed.keys()], [FOLDER_CHECK]);
    assert.match(run.failed.get(FOLDER_CHECK), /root plus the child name/);
    await runOwnedCleanup(run.ctx, run.cleanups.map((entry) => entry.fn), { closeStreams() {} });
    assert.deepEqual(run.ctx.report.cleanup.map((entry) => entry.status).sort(), ['FAIL', 'PASS']);
    assert.match(run.ctx.report.cleanup.find((entry) => entry.status === 'FAIL').error, /not run-owned/);
    assert.equal(run.world.explorerCalls.some((call) => call.tool === 'delete_directory'), false, 'nothing is deleted without a 201 for the exact path');
});

test('NEGATIVE: a run-owned child swapped for a symlink to a sibling is not deleted, and the cleanup failure is recorded', async () => {
    const run = await runWorld();
    assert.ok(run.passed.includes(FOLDER_CHECK));
    run.world.swapForSymlink(CHILD, 'precious-sibling');
    await runOwnedCleanup(run.ctx, run.cleanups.map((entry) => entry.fn), { closeStreams() {} });
    assert.deepEqual(run.ctx.report.cleanup.map((entry) => entry.status).sort(), ['FAIL', 'PASS']);
    assert.match(run.ctx.report.cleanup.find((entry) => entry.status === 'FAIL').error, /no longer an ordinary directory/);
    assert.equal(run.world.explorerCalls.some((call) => call.tool === 'delete_directory'), false, 'delete_directory is never called on a swapped path');
    assert.ok(run.world.folders.has('precious-sibling'), 'the sibling the symlink points at survives');
});

test('NEGATIVE: a pre-existing entry with the run-owned name (directory, file or symlink) fails the check, is never created over or deleted, and cleanup reports it as not run-owned', async () => {
    for (const type of ['dir', 'file', 'symlink']) {
        const run = await runWorld({ preexisting: { name: CHILD, type, target: 'precious-sibling' } });
        assert.deepEqual([...run.failed.keys()], [FOLDER_CHECK], type);
        assert.match(run.failed.get(FOLDER_CHECK), /already exists/, type);
        assert.equal(run.world.requests.some((entry) => entry.path.endsWith('/schedule-folders') && entry.body?.name === CHILD), false, `${type}: no create request`);
        await runOwnedCleanup(run.ctx, run.cleanups.map((entry) => entry.fn), { closeStreams() {} });
        assert.deepEqual(run.ctx.report.cleanup.map((entry) => entry.status).sort(), ['FAIL', 'PASS'], type);
        assert.match(run.ctx.report.cleanup.find((entry) => entry.status === 'FAIL').error, /not run-owned/, type);
        assert.equal(run.world.explorerCalls.some((call) => call.tool === 'delete_directory'), false, `${type}: nothing deleted`);
        const stillThere = type === 'dir' ? run.world.folders.has(CHILD) : type === 'file' ? run.world.files.has(CHILD) : run.world.symlinks.has(CHILD);
        assert.ok(stillThere, `${type}: the pre-existing entry is untouched`);
    }
});

test('the normal cleanup inspects before it deletes and checks absence afterwards under any entry type', async () => {
    const run = await runWorld();
    await cleanAll(run);
    const tools = run.world.explorerCalls.map((call) => call.tool);
    assert.ok(tools.indexOf('get_file_info') > -1 && tools.indexOf('get_file_info') < tools.indexOf('delete_directory'), 'Explorer inspects the path before deleting it');
    assert.ok(tools.lastIndexOf('list_directory') > tools.indexOf('delete_directory'), 'Explorer is listed again after the delete');
});

test('the lstat-rejecting RoboTeam read is the last step before delete_directory', async () => {
    const run = await runWorld();
    run.world.events.length = 0;
    await cleanAll(run);
    const events = run.world.events;
    const del = events.indexOf('explorer:delete_directory');
    assert.ok(del > 1);
    assert.equal(events[del - 1], 'roboteam:path-read', events.join(' > '));
    assert.ok(events.indexOf('explorer:get_file_info') < events.indexOf('roboteam:path-read', events.indexOf('explorer:get_file_info')), 'Explorer inspection comes first');
});
