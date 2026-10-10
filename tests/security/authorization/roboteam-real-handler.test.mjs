// Drives the RoboFlow and RoboTeam probes against the REAL AchillesCLI RoboTeam server (createRoboTeamServer with a real
// RobotStore, a real RoboFlowService on a temporary SQLite database and the real family gate) instead of the offline model.
// Requests are signed by this checkout's real HTTP-route minter and verified by this checkout's real Agent helper, so
// signature, audience, method, path, query and body binding are all real. Only the runtime manager (nothing may start) and
// Explorer's file tools (real filesystem calls confined to the temporary workspace) are stubs.
//
// Prerequisite: an AchillesCLI checkout whose tree is exactly 3cd94b10 (reviewed D13+D14 merge), clean, at
// AUTHZ_ROBOTEAM_DIR or the default sibling lane. Without it the test is skipped, like the DPU tests without their checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROBOTEAM_TREE = 'f1484642c23d3267c561e054fb0172f7edd54511'; // tree of AchillesCLI 3cd94b10 (identical to its first parent 798c3d86)
const dir = process.env.AUTHZ_ROBOTEAM_DIR || '/Users/danielsava/work/perf-lanes/d13-achillescli';
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
let skip = false;
try {
    if (git('rev-parse', 'HEAD^{tree}') !== ROBOTEAM_TREE) skip = `AchillesCLI checkout ${dir} is not the 3cd94b10 tree`;
    else if (git('status', '--porcelain', '--untracked-files=no')) skip = `AchillesCLI checkout ${dir} has tracked changes`;
} catch { skip = `AchillesCLI checkout not found (tried ${dir})`; }

const PLOINKY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AGENT_ID = 'agent:AchillesCLI/roboTeamAgent';
const PREFIX = '/base-agent-additional-server/roboTeamAgent/3001';

test('the RoboFlow and RoboTeam probes pass against the real 3cd94b10 server and start nothing', { skip }, async (t) => {
    process.env.PLOINKY_MASTER_KEY ||= '5'.repeat(64);
    process.env.PLOINKY_AGENTLIB_DIR ||= path.join(PLOINKY, 'node_modules', 'achillesAgentLib');
    const { buildHttpRouteAuthInfoHeader } = await import(pathToFileURL(path.join(PLOINKY, 'cli/server/routerHandlers.js')).href);
    const { deriveAgentRequestSecret } = await import(pathToFileURL(path.join(PLOINKY, 'cli/utils/security/masterKey.js')).href);
    const { sha256RawBodyHash } = await import(pathToFileURL(path.join(PLOINKY, 'Agent/lib/requestHash.mjs')).href);
    process.env.PLOINKY_AGENT_RUNTIME_ROOT = path.join(PLOINKY, 'Agent');
    process.env.PLOINKY_AGENT_ID = AGENT_ID;
    process.env.PLOINKY_AGENT_SECRET = deriveAgentRequestSecret(AGENT_ID);

    // The server imports ALA's transcript reader at load time. A minimal stand-in package keeps the test independent of any ALA checkout;
    // none of the probes reaches transcripts.
    const alaRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'authz-ala-stub-'));
    await fs.mkdir(path.join(alaRoot, 'bin')); await fs.mkdir(path.join(alaRoot, 'src'));
    await fs.writeFile(path.join(alaRoot, 'package.json'), JSON.stringify({ name: 'advanced-language-agent', type: 'module' }));
    await fs.writeFile(path.join(alaRoot, 'bin/ala.mjs'), '');
    await fs.writeFile(path.join(alaRoot, 'src/transcript.mjs'), 'export const readSessionSync = () => null, readTurnSync = () => null, readSessionSummarySync = () => null, listSessionsSync = () => [];\n');
    process.env.ACHILLES_ALA_COMMAND = path.join(alaRoot, 'bin/ala.mjs');
    t.after(() => fs.rm(alaRoot, { recursive: true, force: true }));
    const { createRoboTeamServer } = await import(pathToFileURL(path.join(dir, 'roboTeamAgent/server/http-server.mjs')).href);
    const { RoboFlowService } = await import(pathToFileURL(path.join(dir, 'roboTeamAgent/server/roboflow/roboflow-service.mjs')).href);
    const probes = await import('./agent-probes.mjs');

    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'authz-real-handler-')));
    // The real RobotStore reads /proc (Linux-only), so a minimal in-memory store with the same interface stands in; everything
    // above it (the HTTP handler, the family gate, signature verification and the RoboFlow service) is real.
    const now = new Date().toISOString();
    const robots = [{ id: 'default', name: 'default', codingAgents: ['codex'], skillsets: [], skillRepositories: [], repositories: [], createdAt: now, updatedAt: now }];
    const robotStore = {
        dataDir: path.join(root, 'data'),
        async initialize() {}, async list() { return robots.map((robot) => ({ ...robot })); },
        async get(id) { return robots.find((robot) => robot.id === id) || null; },
        async getByName(name) { return robots.find((robot) => robot.name === name) || null; },
        async create() { throw new Error('robot creation must not be reached'); }, async delete() { throw new Error('robot deletion must not be reached'); },
    };
    const started = [];
    const runtimeManager = { workspaceRoot: root, status: () => ({ state: 'stopped' }), resolveCwd: async (value) => value,
        startTask(robot, type, request) { started.push({ robot, type, request }); return { taskId: request.runtimeTaskId, state: 'queued' }; },
        stopTask() {}, sendTaskMessage() { started.push('message'); return { delivery: 'sent' }; },
        resumeTask() { started.push('resume'); return { taskId: 'x', state: 'queued' }; }, activePort: () => null,
        start() { started.push('start'); throw new Error('start must not be reached'); }, stop() { started.push('stop'); throw new Error('stop must not be reached'); } };
    const roboflow = new RoboFlowService({ robotStore, runtimeManager, skillsets: { repositoriesClient: { listRepositories: async () => [{ name: 'DocumentationSkills', source: root, origin: 'local' }] }, start: async (robot, input, enqueue) => enqueue(robot) },
        databaseFile: path.join(root, 'roboflow.sqlite'), workflowsDirectory: path.join(root, 'old'), discoverSkillsets: async () => ({ skillsets: [], diagnostics: [] }) });
    await roboflow.initialize();
    roboflow.scheduler.start();
    const server = createRoboTeamServer({ robotStore, runtimeManager, roboflow, internalToken: 'test-token', publicBasePath: './' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise((resolve) => server.close(resolve)); await roboflow.close(); await fs.rm(root, { recursive: true, force: true }); });
    const base = `http://127.0.0.1:${server.address().port}`;

    // Principals as the Router would sign them: an administrator is entitled by role, userA and userB by the explorer.access
    // capability, selfRegistered holds neither. Anonymous sends no signed header.
    const principals = {
        admin: { id: 'p-admin', username: 'admin-fixture', email: '', roles: ['admin'], capabilities: [] },
        userA: { id: 'p-usera', username: 'usera', email: '', roles: ['user'], capabilities: ['explorer.access'] },
        userB: { id: 'p-userb', username: 'userb', email: '', roles: ['user'], capabilities: ['explorer.access'] },
        selfRegistered: { id: 'p-self', username: 'selfregistered', email: '', roles: ['selfRegistered'], capabilities: [] },
    };
    const request = async (actor, { method = 'GET', path: external, body }) => {
        assert.ok(external.startsWith(PREFIX), external);
        const inner = external.slice(PREFIX.length) || '/';
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const headers = { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
        if (actor !== 'anonymous') {
            const parsed = new URL(`http://127.0.0.1:8080${external}`);
            Object.assign(headers, buildHttpRouteAuthInfoHeader({ method, url: external, headers: {}, user: principals[actor] }, parsed,
                { includeAuthInfo: true, issueInvocation: true, routeKey: 'roboTeamAgent', route: { repo: 'AchillesCLI', agent: 'roboTeamAgent' } },
                { bodyHash: sha256RawBodyHash(Buffer.from(bodyString)), routePath: new URL(`http://127.0.0.1:8080${inner}`).pathname }));
        }
        const response = await fetch(base + inner, { method, headers, ...(body === undefined ? {} : { body: bodyString }) });
        const text = await response.text();
        let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
        return { status: response.status, headers: Object.fromEntries(response.headers), text, json };
    };

    // Explorer's file tools, confined to the temporary workspace, shaped like createResourceMcp results.
    const ok = (rawText) => ({ failed: false, value: { rawText }, response: { status: 200 } });
    const mcp = async (principal, agent, tool, args = {}) => {
        assert.equal(agent, 'explorer');
        const inside = (p) => { assert.ok(p === root || p.startsWith(`${root}/`), `outside the workspace: ${p}`); return p; };
        try {
            if (tool === 'list_allowed_directories') return ok(`Allowed directories:\n${root}`);
            if (tool === 'list_directory') return ok((await fs.readdir(inside(args.path), { withFileTypes: true })).map((e) => `[${e.isDirectory() ? 'DIR' : 'FILE'}] ${e.name}`).join('\n'));
            if (tool === 'get_file_info') { const s = await fs.stat(inside(args.path)); return { failed: false, value: { path: args.path, isFile: s.isFile(), isDirectory: s.isDirectory() }, response: { status: 200 } }; }
            if (tool === 'delete_directory') { await fs.rm(inside(args.path), { recursive: true, force: true }); return ok('deleted'); }
        } catch (error) { return { failed: true, value: undefined, response: { status: 500 }, error: String(error?.message || error) }; }
        throw new Error(`unexpected Explorer tool ${tool}`);
    };

    const passed = [], failed = new Map(), gaps = [], cleanups = [];
    const ctx = {
        prefix: 'authz-real-0a1b2c3d', report: { cleanup: [] }, secrets: new Set(), async guard() {},
        recordGap: (id, reason, evidence) => gaps.push({ id, evidence }), cleanup: (fn) => cleanups.push(fn), request,
        async check(id, fn) { try { await fn(); passed.push(id); } catch (error) { failed.set(id, String(error?.message || error)); } },
    };
    // The server logs every refused request; the probes cause hundreds on purpose.
    const warn = console.warn; console.warn = () => {};
    try {
        await probes.runRoboflowProbes(ctx, { mcp });
        await probes.runRoboteamProbes(ctx);
        for (const fn of [...cleanups].reverse()) await fn();
    } finally { console.warn = warn; }

    const want = [...probes.roboflowCheckDefinitions(), ...probes.roboteamCheckDefinitions()].map((entry) => entry.id).filter((id) => id !== 'agent.robot.list.admin');
    assert.deepEqual([...failed], [], 'every probe check passes against the real server');
    assert.deepEqual([...passed].sort(), want.sort(), 'every defined check ran exactly once');
    assert.deepEqual(gaps.map((gap) => gap.id).sort(), [...Object.values(probes.ROBOFLOW_GAPS), ...Object.values(probes.ROBOTEAM_GAPS)].sort());
    assert.deepEqual(started, [], 'no probe reached a runtime start, stop, message or task');
    assert.equal(roboflow.schedules.listSync().length, 0, 'no schedule remains');
    assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith('authz-')), [], 'no run-owned folder remains');
    assert.equal((await roboflow.listWorkflows()).some((item) => item.id.startsWith('authz-')), false, 'no run-owned workflow remains');
    assert.equal((await robotStore.list()).length, 1, 'only the default robot exists');
});
