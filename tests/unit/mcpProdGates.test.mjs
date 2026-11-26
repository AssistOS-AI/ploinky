import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// AC8 and AC8b: the dry capture before mutation, the captured file, the enable
// merge, and the Router decision that reads only the captured PROD.

const cwd = process.cwd();
const savedEnv = { ...process.env };
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-prod-gates-')));
test.after(() => {
    process.chdir(cwd);
    for (const name of Object.keys(process.env)) {
        if (!Object.hasOwn(savedEnv, name)) delete process.env[name];
    }
    Object.assign(process.env, savedEnv);
    fs.rmSync(workspace, { recursive: true, force: true });
});
process.chdir(workspace);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = randomUUID().replaceAll('-', '').padEnd(64, 'd');
fs.writeFileSync('.env', '');

const gates = await import('../../cli/utils/runtime/mcpProdGates.mjs');
const { McpToolPolicy } = await import('../../cli/server/policy/McpToolPolicy.js');
const { PolicyStateRepository } = await import('../../cli/server/policy/PolicyStateRepository.js');
const { InMemoryPolicyStateStore } = await import('../../cli/server/policy/InMemoryPolicyStateStore.js');
const { writeSecretsFile } = await import('../../cli/utils/security/encryptedSecretsFile.js');
const { readProd } = await import('../../cli/utils/prodMode.mjs');
const { getProfileEnvVars } = await import('../../cli/utils/runtime/profileService.js');
const { buildRouterEnv, collectProdGateRoutes, commitProdCapture } = await import('../../cli/commands/workspaceUtil.js');
const agentsSvc = await import('../../cli/utils/agents.js');

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-prod-gates-repos-')));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const codeIs = (code) => (error) => error?.code === code;

function git(directory, ...args) {
    return execFileSync('git', ['-C', directory, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim();
}

const TAGGED = {
    tools: [
        { name: 'git_pull', tags: ['prod-disabled'] },
        { name: 'git_status', tags: [] },
        { name: 'git_push', tags: ['Prod-Disabled', 'admin'] },
        { name: 'git_log' },
    ],
};

// A tracked agent directory in its own repository.
let counter = 0;
function agentRepo(config = TAGGED, { commit = true } = {}) {
    counter += 1;
    const directory = path.join(scratch, `repo${counter}`, 'gitAgent');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'mcp-config.json');
    fs.writeFileSync(file, JSON.stringify(config, null, 2));
    git(path.dirname(directory), 'init', '-q');
    if (commit) {
        git(path.dirname(directory), 'add', '-A');
        git(path.dirname(directory), 'commit', '-q', '-m', 'base');
    }
    return { directory, file, repo: path.dirname(directory) };
}

const captureFile = path.join(workspace, '.ploinky', 'data', 'mcp-prod-gates.json');
function reset() {
    fs.rmSync(path.join(workspace, '.ploinky'), { recursive: true, force: true });
}

test('the dry capture lists exactly the prod-disabled tools per route, without writing', () => {
    reset();
    const a = agentRepo();
    const plain = agentRepo({ tools: [{ name: 'noop', tags: ['admin'] }] });
    const capture = gates.dryCaptureProdGates({
        prod: false,
        routes: [
            { routeKey: 'gitAgent', agentDir: a.directory },
            { routeKey: 'plain', agentDir: plain.directory },
            { routeKey: 'ghost', agentDir: path.join(scratch, 'does-not-exist') },
            { routeKey: '', agentDir: a.directory },
        ],
    });
    assert.equal(capture.schema, 1);
    assert.equal(capture.prod, false);
    assert.deepEqual(capture.routes.gitAgent.tools, ['git_pull', 'git_push']);
    assert.match(capture.routes.gitAgent.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(capture.routes.plain.tools, []);
    // An unknown route is captured empty and gates nothing; a nameless one is dropped.
    assert.deepEqual(capture.routes.ghost, { tools: [], sha256: null });
    assert.equal(Object.hasOwn(capture.routes, ''), false);
    assert.equal(fs.existsSync(captureFile), false);
    // Same input, same bytes.
    const again = gates.dryCaptureProdGates({ prod: false, routes: [{ routeKey: 'gitAgent', agentDir: a.directory }, { routeKey: 'plain', agentDir: plain.directory }, { routeKey: 'ghost', agentDir: path.join(scratch, 'does-not-exist') }] });
    assert.equal(JSON.stringify(again), JSON.stringify(capture));
});

test('with PROD false a dirty, untracked or non-git mcp-config is captured without refusal', () => {
    reset();
    const dirty = agentRepo();
    fs.appendFileSync(dirty.file, '\n');
    const untracked = agentRepo(TAGGED, { commit: false });
    const nonGit = path.join(scratch, 'not-a-repo');
    fs.mkdirSync(nonGit, { recursive: true });
    fs.writeFileSync(path.join(nonGit, 'mcp-config.json'), JSON.stringify(TAGGED));
    assert.doesNotThrow(() => gates.dryCaptureProdGates({
        prod: false,
        routes: [
            { routeKey: 'dirty', agentDir: dirty.directory },
            { routeKey: 'untracked', agentDir: untracked.directory },
            { routeKey: 'nongit', agentDir: nonGit },
        ],
    }));
});

test('under PROD a clean tracked mcp-config passes', () => {
    reset();
    const clean = agentRepo();
    const capture = gates.dryCaptureProdGates({ prod: true, routes: [{ routeKey: 'gitAgent', agentDir: clean.directory }] });
    assert.equal(capture.prod, true);
    assert.deepEqual(capture.routes.gitAgent.tools, ['git_pull', 'git_push']);
});

test('under PROD a dirty, staged, untracked, non-git or symlinked mcp-config refuses before anything is written', () => {
    reset();
    const cases = {};
    cases.dirty = agentRepo();
    fs.writeFileSync(cases.dirty.file, JSON.stringify({ tools: [{ name: 'git_pull' }] }));
    cases.deleted = agentRepo();
    fs.unlinkSync(cases.deleted.file);
    cases.staged = agentRepo();
    fs.writeFileSync(cases.staged.file, JSON.stringify({ tools: [] }));
    git(cases.staged.repo, 'add', '-A');
    cases.untracked = agentRepo(TAGGED, { commit: false });
    git(cases.untracked.repo, 'commit', '-q', '--allow-empty', '-m', 'empty');
    cases.nongit = { directory: path.join(scratch, 'nongit-agent') };
    fs.mkdirSync(cases.nongit.directory, { recursive: true });
    fs.writeFileSync(path.join(cases.nongit.directory, 'mcp-config.json'), JSON.stringify(TAGGED));
    cases.symlink = agentRepo();
    const target = path.join(cases.symlink.repo, 'real.json');
    fs.renameSync(cases.symlink.file, target);
    fs.symlinkSync(target, cases.symlink.file);
    // An untagged mcp-config is checked too: the dirty check is not limited to tagged files.
    cases.untaggedDirty = agentRepo({ tools: [{ name: 'x' }] });
    fs.appendFileSync(cases.untaggedDirty.file, ' ');

    for (const [name, entry] of Object.entries(cases)) {
        const before = fs.existsSync(captureFile);
        assert.throws(
            () => gates.dryCaptureProdGates({ prod: true, routes: [{ routeKey: name, agentDir: entry.directory }] }),
            (error) => {
                assert.equal(error.code, 'PLOINKY_PROD_GATES_DIRTY', name);
                assert.equal(error.files.length, 1);
                assert.equal(error.files[0].routeKey, name);
                assert.match(error.message, new RegExp(name));
                return true;
            },
            name,
        );
        assert.equal(fs.existsSync(captureFile), before);
    }
    // One bad route among clean ones still refuses, and names only the bad one.
    const clean = agentRepo();
    assert.throws(
        () => gates.dryCaptureProdGates({ prod: true, routes: [
            { routeKey: 'clean', agentDir: clean.directory },
            { routeKey: 'dirty', agentDir: cases.dirty.directory },
        ] }),
        (error) => error.code === 'PLOINKY_PROD_GATES_DIRTY' && error.files.map((entry) => entry.routeKey).join() === 'dirty',
    );
});

test('a repository selection in the environment cannot redirect the dirty check', () => {
    reset();
    const dirty = agentRepo();
    fs.appendFileSync(dirty.file, '\n');
    const clean = agentRepo();
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(clean.repo, '.git');
    process.env.GIT_WORK_TREE = clean.repo;
    try {
        assert.throws(
            () => gates.dryCaptureProdGates({ prod: true, routes: [{ routeKey: 'dirty', agentDir: dirty.directory }] }),
            codeIs('PLOINKY_PROD_GATES_DIRTY'),
        );
    } finally {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
});

test('writeProdGates is atomic, controller-private and leaves an identical file untouched', () => {
    reset();
    const capture = { schema: 1, prod: true, routes: { gitAgent: { tools: ['git_pull'], sha256: 'a'.repeat(64) } } };
    assert.deepEqual(gates.writeProdGates(capture), { written: true });
    const first = fs.statSync(captureFile);
    assert.equal(first.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), capture);
    assert.deepEqual(gates.writeProdGates(capture), { written: false });
    assert.equal(fs.statSync(captureFile).ino, first.ino);
    assert.deepEqual(gates.writeProdGates({ ...capture, prod: false }), { written: true });
    assert.notEqual(fs.statSync(captureFile).ino, first.ino);
    // No temporary file is left behind.
    assert.deepEqual(fs.readdirSync(path.dirname(captureFile)).filter((name) => name.endsWith('.tmp')), []);
    // The agent-visible tree never holds it: it lives under the masked data directory.
    assert.ok(captureFile.includes(`${path.sep}.ploinky${path.sep}data${path.sep}`));
});

function policyWith(readProdGates, entries = []) {
    const repository = new PolicyStateRepository({ store: new InMemoryPolicyStateStore() });
    const policy = new McpToolPolicy({ repository, readProdGates });
    if (entries.length) policy.bootstrapDefaults(entries);
    return policy;
}
const USER = { kind: 'user', isAdmin: false };
const ADMIN = { kind: 'user', isAdmin: true };
const DEFAULTS = [
    { agent: 'gitAgent', tool: 'git_pull', access: 'authenticated' },
    { agent: 'gitAgent', tool: 'git_status', access: 'authenticated' },
    { agent: 'gitAgent', tool: 'git_push', access: 'admin' },
];

test('AC8: under captured prod:true a prod-disabled tool is 403 PROD_DISABLED and omitted from tools/list', () => {
    const captured = { prod: true, routes: { gitAgent: { tools: ['git_pull', 'git_push'], sha256: null } } };
    const policy = policyWith(() => captured, DEFAULTS);
    // A persisted `authenticated` entry never re-enables the gated tool.
    assert.deepEqual(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }), { allow: false, code: 'PROD_DISABLED', status: 403 });
    // The gate precedes the admin check too.
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_push', caller: ADMIN }).code, 'PROD_DISABLED');
    // An ungated tool of the same route behaves as without PROD.
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_status', caller: USER }).allow, true);
    // A tool of another route with the same name is not gated.
    const other = policyWith(() => captured, [{ agent: 'other', tool: 'git_pull', access: 'authenticated' }]);
    assert.equal(other.evaluate({ agent: 'other', tool: 'git_pull', caller: USER }).allow, true);
    // Agent callers are gated too.
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: { kind: 'agent' } }).code, 'PROD_DISABLED');
    // tools/list omits the gated tools only.
    const listed = policy.filterTools('gitAgent', [{ name: 'git_pull' }, { name: 'git_status' }, { name: 'git_push' }], ADMIN);
    assert.deepEqual(listed.map((tool) => tool.name), ['git_status']);
});

test('AC8: captured prod:false changes nothing, and an unknown route or tool is ignored', () => {
    const off = policyWith(() => ({ prod: false, routes: { gitAgent: { tools: ['git_pull'], sha256: null } } }), DEFAULTS);
    assert.equal(off.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).allow, true);
    assert.equal(off.filterTools('gitAgent', [{ name: 'git_pull' }], USER).length, 1);
    const unknown = policyWith(() => ({ prod: true, routes: { ghost: { tools: ['git_pull'], sha256: null } } }), DEFAULTS);
    assert.equal(unknown.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).allow, true);
    // Without a reader the policy is exactly the access policy.
    assert.equal(policyWith(null, DEFAULTS).evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).allow, true);
});

test('AC8: an unavailable capture is 503 PROD_POLICY_UNAVAILABLE for every tool and hides tools/list', () => {
    const policy = policyWith(() => ({ unavailable: true, reason: 'absent' }), DEFAULTS);
    assert.deepEqual(policy.evaluate({ agent: 'gitAgent', tool: 'git_status', caller: USER }), { allow: false, code: 'PROD_POLICY_UNAVAILABLE', status: 503 });
    assert.deepEqual(policy.filterTools('gitAgent', [{ name: 'git_status' }], USER), []);
    // A tool without any policy entry is refused the same way: the gate precedes the entry lookup.
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'never-seen', caller: USER }).code, 'PROD_POLICY_UNAVAILABLE');
});

test('the prod-disabled tag is a modifier: it never changes the access class and unknown tags still deny', () => {
    const policy = policyWith(null);
    assert.deepEqual(policy.accessFromTags(['prod-disabled']), { access: 'authenticated' });
    assert.deepEqual(policy.accessFromTags(['prod-disabled', 'admin']), { access: 'admin' });
    assert.deepEqual(policy.accessFromTags(['Prod-Disabled', 'internal']), { access: 'internal' });
    assert.equal(policy.accessFromTags(['prod-disabld']).invalid, true);
    assert.equal(policy.accessFromTags(['prod-disabled', 'internal', 'admin']).invalid, true);
    // The route's mcp-config still yields a default entry for a tagged tool.
    const agent = agentRepo();
    const defaults = policyWith(null).collectDefaults({ gitAgent: { hostPath: agent.directory, repo: 'r', agent: 'gitAgent' } });
    assert.deepEqual(
        defaults.map((entry) => `${entry.tool}:${entry.access}`).sort(),
        ['git_log:authenticated', 'git_pull:authenticated', 'git_push:admin', 'git_status:authenticated'],
    );
});

test('AC8: the Router reads only the captured file: deleting the tag on disk changes nothing, the stored var changes nothing', () => {
    reset();
    const agent = agentRepo();
    const capture = gates.dryCaptureProdGates({ prod: true, routes: [{ routeKey: 'gitAgent', agentDir: agent.directory }] });
    gates.writeProdGates(capture);
    const policy = policyWith(() => gates.readCapturedProdGates(), DEFAULTS);
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).code, 'PROD_DISABLED');
    // Remove the tag on disk, commit it even: the capture is not recomputed.
    fs.writeFileSync(agent.file, JSON.stringify({ tools: [{ name: 'git_pull', tags: [] }] }));
    git(agent.repo, 'commit', '-q', '-am', 'drop the tag');
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).code, 'PROD_DISABLED');
    // The stored var going false does not reach the Router either.
    writeSecretsFile({ PROD: 'false' });
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).code, 'PROD_DISABLED');
    // Deleting the capture is PROD true with an unavailable policy.
    fs.rmSync(captureFile);
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).code, 'PROD_POLICY_UNAVAILABLE');
});

test('AC8b: a stored PROD change without a whole restart leaves the Router, the policy and the agents unchanged', () => {
    reset();
    const agent = agentRepo();
    const routes = [{ routeKey: 'gitAgent', agentDir: agent.directory }];
    writeSecretsFile({ PROD: 'false' });
    gates.writeProdGates(gates.dryCaptureProdGates({ prod: readProd(), routes }));
    const policy = policyWith(() => gates.readCapturedProdGates(), DEFAULTS);
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).allow, true);
    assert.equal(buildRouterEnv().PROD, 'false');
    assert.equal(getProfileEnvVars('gitAgent', 'r', 'prod').PROD, 'false');

    // `var PROD true` with no whole restart.
    writeSecretsFile({ PROD: 'true' });
    assert.equal(readProd(), true);
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).allow, true);
    assert.equal(buildRouterEnv().PROD, 'false');
    assert.equal(getProfileEnvVars('gitAgent', 'r', 'prod').PROD, 'false');

    // A clean whole restart captures it: all three flip.
    gates.writeProdGates(gates.dryCaptureProdGates({ prod: readProd(), routes }));
    assert.equal(policy.evaluate({ agent: 'gitAgent', tool: 'git_pull', caller: USER }).code, 'PROD_DISABLED');
    assert.equal(buildRouterEnv().PROD, 'true');
    assert.equal(getProfileEnvVars('gitAgent', 'r', 'prod').PROD, 'true');
});

test('AC8: a whole restart with a dirty mcp-config refuses at the dry capture and leaves the capture file as it was', () => {
    reset();
    const agent = agentRepo();
    const routes = [{ routeKey: 'gitAgent', agentDir: agent.directory }];
    gates.writeProdGates(gates.dryCaptureProdGates({ prod: true, routes }));
    const before = fs.readFileSync(captureFile, 'utf8');
    fs.writeFileSync(agent.file, JSON.stringify({ tools: [] }));
    assert.throws(() => gates.dryCaptureProdGates({ prod: true, routes }), codeIs('PLOINKY_PROD_GATES_DIRTY'));
    assert.equal(fs.readFileSync(captureFile, 'utf8'), before);
    // Clean again: it recaptures.
    git(agent.repo, 'commit', '-q', '-am', 'reviewed change');
    const next = gates.dryCaptureProdGates({ prod: true, routes });
    gates.writeProdGates(next);
    assert.deepEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')).routes.gitAgent.tools, []);
});

test('AC8: start and whole restart run the dry capture before their first mutation; restart router captures nothing', () => {
    const dir = fileURLToPath(new URL('../../cli/commands/', import.meta.url));
    const cli = fs.readFileSync(path.join(dir, 'cli.js'), 'utf8');
    const startCase = cli.slice(cli.indexOf("case 'start': {"), cli.indexOf("case 'sso':"));
    const startAt = startCase.indexOf('dryCaptureProdGates(');
    assert.ok(startAt > 0);
    assert.ok(startAt < startCase.indexOf('setActiveProfile('));
    assert.ok(startAt < startCase.indexOf('await startWorkspace('));
    assert.ok(startCase.includes('prodCapture,'));
    const whole = cli.slice(cli.indexOf("restart: start is not configured. Run: start <staticAgent> <port>'"));
    const wholeAt = whole.indexOf('dryCaptureProdGates(');
    assert.ok(wholeAt > 0);
    for (const mutation of ['resolvePersistedRouterPort();', 'settleWorkspaceBeforeRestart()', 'inactivateEdgeRoutingGeneration(', 'killRouterIfRunning();', 'stopConfiguredAgents()']) {
        assert.ok(wholeAt < whole.indexOf(mutation), mutation);
    }
    // `restart router` passes no capture.
    const routerRestart = cli.slice(cli.indexOf("target.toLowerCase() === 'router'"), cli.indexOf('if (target) {', cli.indexOf("target.toLowerCase() === 'router'")));
    assert.ok(routerRestart.includes('startWorkspace('));
    assert.equal(routerRestart.includes('prodCapture'), false);
    assert.equal(routerRestart.includes('dryCaptureProdGates'), false);
    // A Router-only restart preserves the capture already in force.
    const existing = { schema: 1, prod: true, routes: {} };
    gates.writeProdGates(existing);
    commitProdCapture(undefined, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), existing);
});

test('AC8: an enable merges only its own route, never changes prod, and refuses a dirty route under the captured PROD', () => {
    reset();
    const a = agentRepo();
    const b = agentRepo({ tools: [{ name: 'b_tool', tags: ['prod-disabled'] }] });
    gates.writeProdGates(gates.dryCaptureProdGates({ prod: true, routes: [{ routeKey: 'gitAgent', agentDir: a.directory }] }));
    const before = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.deepEqual(gates.mergeEnabledRouteGates('second', { agentDir: b.directory }), { merged: true });
    const merged = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.equal(merged.prod, true);
    assert.deepEqual(merged.routes.gitAgent, before.routes.gitAgent);
    assert.deepEqual(merged.routes.second.tools, ['b_tool']);
    assert.deepEqual(Object.keys(merged.routes).sort(), ['gitAgent', 'second']);

    // A dirty route refuses and leaves the file as it was.
    const dirty = agentRepo();
    fs.appendFileSync(dirty.file, '\n');
    const snapshot = fs.readFileSync(captureFile, 'utf8');
    assert.throws(() => gates.mergeEnabledRouteGates('dirty', { agentDir: dirty.directory }), codeIs('PLOINKY_PROD_GATES_DIRTY'));
    assert.equal(fs.readFileSync(captureFile, 'utf8'), snapshot);

    // Under a captured prod:false the same dirty route merges, and prod stays false.
    gates.writeProdGates({ ...merged, prod: false });
    assert.deepEqual(gates.mergeEnabledRouteGates('dirty', { agentDir: dirty.directory }), { merged: true });
    const off = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.equal(off.prod, false);
    assert.ok(off.routes.dirty);
    // The stored var never matters to an enable merge.
    writeSecretsFile({ PROD: 'true' });
    assert.deepEqual(gates.mergeEnabledRouteGates('dirty', { agentDir: dirty.directory }), { merged: true });
    assert.equal(JSON.parse(fs.readFileSync(captureFile, 'utf8')).prod, false);
});

test('an enable with no capture yet merges nothing; an unreadable capture refuses it', () => {
    reset();
    const a = agentRepo();
    assert.deepEqual(gates.mergeEnabledRouteGates('gitAgent', { agentDir: a.directory }), { merged: false });
    assert.equal(fs.existsSync(captureFile), false);
    fs.mkdirSync(path.dirname(captureFile), { recursive: true });
    fs.writeFileSync(captureFile, '{broken');
    assert.throws(() => gates.mergeEnabledRouteGates('gitAgent', { agentDir: a.directory }), codeIs('PLOINKY_PROD_POLICY_UNAVAILABLE'));
    assert.equal(fs.readFileSync(captureFile, 'utf8'), '{broken');
    // The enable entry point calls the merge before preparing anything.
    const calls = [];
    agentsSvc.mergeEnableRouteGates({ agentName: 'nonexistent/agent' }, { merge: (...args) => calls.push(args) });
    assert.deepEqual(calls, []);
});

test('collectProdGateRoutes covers the enabled registry (by alias) and the graph; publication reads the final admitted sources', () => {
    reset();
    const repos = path.join(workspace, '.ploinky', 'repos', 'r');
    const make = (name, config) => {
        fs.mkdirSync(path.join(repos, name), { recursive: true });
        fs.writeFileSync(path.join(repos, name, 'manifest.json'), JSON.stringify({
            container: 'node:20-alpine', profiles: { default: {}, dev: {}, qa: {}, prod: {} },
        }));
        if (config) fs.writeFileSync(path.join(repos, name, 'mcp-config.json'), JSON.stringify(config));
    };
    make('enabled', TAGGED);
    make('aliased', { tools: [{ name: 'a_tool', tags: ['prod-disabled'] }] });
    make('later', { tools: [{ name: 'l_tool', tags: ['prod-disabled'] }] });
    const registry = {
        ploinky_r_enabled: { type: 'agent', repoName: 'r', agentName: 'enabled' },
        ploinky_r_aliased: { type: 'agent', repoName: 'r', agentName: 'aliased', alias: 'shortcut' },
        ploinky_gone_x: { type: 'agent', repoName: 'gone', agentName: 'x' },
    };
    const routes = collectProdGateRoutes({ registry, staticAgentArg: undefined });
    assert.deepEqual(routes.map((route) => route.routeKey).sort(), ['enabled', 'shortcut']);
    const capture = gates.dryCaptureProdGates({ prod: false, routes });
    assert.deepEqual(capture.routes.shortcut.tools, ['a_tool']);
    // Repository preparation can replace even a source already seen by the dry
    // run. The admitted graph controls the routes and bytes finally published.
    fs.writeFileSync(path.join(repos, 'enabled', 'mcp-config.json'), JSON.stringify({
        tools: [{ name: 'new_tool', tags: ['prod-disabled'] }],
    }));
    const graph = { nodes: new Map([['later', { shortAgentName: 'later', agentPath: path.join(repos, 'later') }]]) };
    const finalGraph = { registry, graph };
    commitProdCapture(capture, finalGraph);
    const admitted = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
    assert.deepEqual(admitted.routes.later.tools, ['l_tool']);
    assert.deepEqual(admitted.routes.enabled.tools, ['new_tool']);
    assert.deepEqual(admitted.routes.shortcut, capture.routes.shortcut);
    // Production also verifies the final admitted sources. A refusal keeps
    // the earlier successful capture intact.
    assert.throws(() => commitProdCapture({ ...capture, prod: true }, finalGraph), /not found/);
    const cleanRegistry = { ...registry };
    delete cleanRegistry.ploinky_gone_x;
    assert.throws(() => commitProdCapture({ ...capture, prod: true }, { ...finalGraph, registry: cleanRegistry }),
        codeIs('PLOINKY_PROD_GATES_DIRTY'));
    assert.deepEqual(JSON.parse(fs.readFileSync(captureFile, 'utf8')), admitted);
});

test('a manifest secrets entry named PROD reads as missing in every source, so the stored value never reaches an agent', async () => {
    reset();
    const injector = await import('../../cli/utils/security/secretInjector.js');
    writeSecretsFile({ PROD: 'true', OTHER_SECRET: 'visible' });
    process.env.PROD = 'true';
    fs.writeFileSync('.env', 'PROD=true\n');
    try {
        assert.equal(injector.getSecret('PROD'), undefined);
        assert.equal(injector.getSecret('OTHER_SECRET'), 'visible');
        assert.deepEqual(injector.getSecrets(['PROD', 'OTHER_SECRET']), { OTHER_SECRET: 'visible' });
        const validation = injector.validateSecrets(['PROD', 'OTHER_SECRET']);
        assert.equal(validation.valid, false);
        assert.deepEqual(validation.missing, ['PROD']);
    } finally {
        delete process.env.PROD;
        fs.writeFileSync('.env', '');
    }
});

test('P7: ploinky expose is refused under the stored or the captured PROD, and never touches the manifest', async () => {
    reset();
    const { handleExposeCommand } = await import('../../cli/commands/envVarCommands.js');
    const repo = path.join(workspace, '.ploinky', 'repos', 'r', 'exposed');
    fs.mkdirSync(repo, { recursive: true });
    const manifestFile = path.join(repo, 'manifest.json');
    const manifestText = JSON.stringify({ container: 'node:20-alpine', expose: {} });
    fs.writeFileSync(manifestFile, manifestText);
    const attempt = () => handleExposeCommand(['SOME_NAME', 'some-value', 'r/exposed']);
    const message = (fn) => { try { fn(); return ''; } catch (error) { return `${error.code || ''}|${error.message}`; } };

    // Stored PROD true.
    writeSecretsFile({ PROD: 'true' });
    assert.match(message(attempt), /^PLOINKY_PROD_EXPOSE_REFUSED\|/);
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), manifestText);
    // Captured PROD true with the stored value false.
    writeSecretsFile({ PROD: 'false' });
    gates.writeProdGates({ schema: 1, prod: true, routes: {} });
    assert.match(message(attempt), /^PLOINKY_PROD_EXPOSE_REFUSED\|/);
    // A corrupt capture and an invalid stored value both refuse (fail closed).
    fs.writeFileSync(captureFile, '{broken');
    assert.match(message(attempt), /^PLOINKY_PROD_EXPOSE_REFUSED\|/);
    fs.rmSync(captureFile);
    writeSecretsFile({ PROD: 'yes' });
    assert.match(message(attempt), /^PLOINKY_PROD_INVALID\|/);
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), manifestText);
    // Neither stored nor captured: not refused by PROD (the command runs its own course).
    writeSecretsFile({ PROD: 'false' });
    gates.writeProdGates({ schema: 1, prod: false, routes: {} });
    assert.doesNotMatch(message(attempt), /PLOINKY_PROD/);
    // No capture yet and no stored value: not production.
    reset();
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(manifestFile, manifestText);
    assert.doesNotMatch(message(attempt), /PLOINKY_PROD/);
});
