import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-async-'));
const previousCwd = process.cwd();
const previousKey = process.env.PLOINKY_MASTER_KEY;
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
fs.mkdirSync('.ploinky');
const { handleMarketplaceRoutes, enableMarketplaceAgent, __testables } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { createMarketplaceActivationOperations } = await import('../../cli/server/authHandlers/marketplaceActivationOperations.mjs');
const { authService, SSO_AUTH_COOKIE_NAME } = await import('../../cli/server/authHandlers/shared.js');
const { mintBrowserCsrfToken } = await import('../../cli/server/browserMutationSecurity.js');
const { HardwareLimitsError, HARDWARE_UNENFORCEABLE, formatHardwareOutcome } = await import('../../cli/sandbox/hardwareLimits/errors.mjs');
const { MARKETPLACE_ENABLE_RECOVERY_INSTRUCTION } = await import('../../cli/server/marketplaceEnableWorker.js');
const originalConfigured = authService.isConfigured;
const originalValidate = authService.validateSession;
const admin = { sessionId: 'fixture-admin', user: { id: 'admin', roles: ['admin'] } };
let currentUser = admin.user;
authService.isConfigured = () => true;
authService.validateSession = async () => ({ ...admin, user: currentUser });
const snapshot = { generation: 'a', agents: { shell: { type: 'agent', agentName: 'shell', repoName: 'repo', auth: { mode: 'sso' } } }, routing: { static: { agent: 'shell' }, routes: { shell: { agent: 'shell', repo: 'repo' } } }, manifests: {} };
const plan = () => ({ ok: true, kind: 'router-surface', surface: 'marketplace-ui', listener: 'public', hostSelection: { kind: 'agent-root', record: { routeKey: 'shell' } }, forwarding: { protocol: 'https', authority: 'explorer.example.test' }, snapshot, lease: { id: 'a', snapshot, commit: () => true } });
function request({ method = 'POST', query = '', body = { action: 'enable_agent', agentRef: 'repo/worker' }, enableAgentAction, prefer = true, csrf = true, routePlan = plan(), agentListOptions } = {}) {
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.headers = { host: 'explorer.example.test', origin: 'https://explorer.example.test', cookie: `${SSO_AUTH_COOKIE_NAME}=${admin.sessionId}`, ...(prefer ? { prefer: 'respond-async' } : {}) };
    if (csrf) req.headers['x-ploinky-browser-csrf-token'] = mintBrowserCsrfToken({ req, routePlan, authContext: { boundHostRouteKey: 'shell' }, sessionId: admin.sessionId });
    const res = { status: 0, headers: {}, setHeader(key, value) { this.headers[key.toLowerCase()] = value; }, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    const done = handleMarketplaceRoutes(req, res, new URL(`https://explorer.example.test/api/marketplace/agents${query}`), { routePlan, ...(enableAgentAction ? { enableAgentAction } : {}), ...(agentListOptions ? { agentListOptions } : {}), collectContainers: () => assert.fail('receipt request collected inventory') });
    return { res, done };
}
test.after(() => {
    authService.isConfigured = originalConfigured;
    authService.validateSession = originalValidate;
    process.chdir(previousCwd);
    if (previousKey === undefined) delete process.env.PLOINKY_MASTER_KEY; else process.env.PLOINKY_MASTER_KEY = previousKey;
    fs.rmSync(workspace, { recursive: true, force: true });
});

const flush = () => new Promise(resolve => setImmediate(resolve));
async function response(options) {
    const { res, done } = request(options);
    await done;
    return res;
}
const read = (id, options = {}) => response({ method: 'GET', query: `?operation=${id}`, ...options });

test('receipts deduplicate normalized pending work, then expose success without raw worker results', async () => {
    let release;
    let calls = 0;
    const blocked = new Promise(resolve => { release = resolve; });
    const action = () => { calls++; return blocked; };
    const first = await response({ body: { action: 'enable_agent', agentRef: ' /repo//dedup/ ', mode: ' GLOBAL ' }, enableAgentAction: action });
    const duplicate = await response({ body: { action: 'enable_agent', agentRef: 'repo/dedup', mode: 'global' }, enableAgentAction: action });
    assert.equal(first.status, 202);
    assert.deepEqual(first.body.operation, duplicate.body.operation);
    assert.equal(first.headers['cache-control'], 'no-store');
    assert.equal(first.headers['preference-applied'], 'respond-async');
    assert.equal(first.headers['retry-after'], '2');
    assert.equal(calls, 1);
    assert.equal((await read(first.body.operation.id)).body.operation.state, 'pending');
    release({ result: { privatePath: '/SECRET_CANARY' } });
    await flush();
    const finished = await read(first.body.operation.id);
    assert.equal(finished.body.operation.state, 'succeeded');
    assert.doesNotMatch(JSON.stringify(finished), /SECRET_CANARY|privatePath/);
});

test('status authorization precedes lookup and scopes by stable user, origin and application', async () => {
    const accepted = await response({ enableAgentAction: async () => ({}) });
    await flush();
    const id = accepted.body.operation.id;
    try {
        currentUser = { id: 'other', roles: ['admin'] };
        assert.equal((await read(id)).status, 404);
        currentUser = { id: 'ordinary', roles: ['user'] };
        assert.equal((await read('malformed')).status, 403);
        currentUser = admin.user;
        const anotherOrigin = plan();
        anotherOrigin.forwarding.authority = 'other.example.test';
        assert.equal((await read(id, { routePlan: anotherOrigin })).status, 404);
        const anotherApplication = structuredClone(snapshot);
        anotherApplication.agents.other = { ...snapshot.agents.shell, agentName: 'other' };
        anotherApplication.routing.routes.other = { agent: 'other', repo: 'repo' };
        const otherPlan = { ...plan(), snapshot: anotherApplication, hostSelection: { kind: 'agent-root', record: { routeKey: 'other' } } };
        assert.equal((await read(id, { routePlan: otherPlan })).status, 404);
        assert.equal((await read('malformed')).status, 400);
        assert.equal((await read('00000000-0000-4000-8000-000000000000')).status, 404);
        assert.equal((await response({ method: 'GET', query: `?operation=${id}&operation=${id}` })).status, 400);
    } finally { currentUser = admin.user; }
});

test('async admission refuses missing identity, missing proof, malformed input and stale generation before work', async () => {
    let started = 0;
    const enableAgentAction = () => { started++; return {}; };
    try {
        currentUser = { username: 'display-name-only', roles: ['admin'] };
        assert.equal((await response({ enableAgentAction })).status, 403);
        currentUser = admin.user;
        assert.equal((await response({ enableAgentAction, csrf: false })).status, 403);
        assert.equal((await response({ enableAgentAction, body: { action: 'enable_agent', agentRef: 'repo/valid' } })).status, 202);
        assert.equal((await response({ enableAgentAction, body: { action: 'enable_agent', agentRef: 'malformed' } })).status, 400);
        assert.equal((await response({ enableAgentAction, body: { action: 'enable_agent', agentRef: 'repo/test', mode: 'unsafe' } })).status, 400);
        assert.equal((await response({ enableAgentAction, routePlan: { ...plan(), lease: { commit: () => false } } })).status, 503);
        assert.equal(started, 1);
    } finally { currentUser = admin.user; }
});

test('terminal failure exposes only safe bounded lifecycle and dependency information', async () => {
    const error = Object.assign(new Error('/SECRET_CANARY worker stack'), {
        code: 'EDGE_GENERATION_CHANGED', cause: { code: 'PLOINKY_RUNTIME_INPUT_CHANGED' },
        dependencies: [{ ref: 'repo/dependency', phase: 'before', status: 'failed', error: '/SECRET_CANARY' }, { ref: '/SECRET_CANARY', status: 'failed' }],
    });
    const accepted = await response({ enableAgentAction: async () => { throw error; } });
    await flush();
    const failed = await read(accepted.body.operation.id);
    assert.equal(failed.body.operation.state, 'failed');
    assert.equal(failed.body.operation.error.code, 'EDGE_GENERATION_CHANGED');
    assert.deepEqual(failed.body.operation.error.dependencies, [{ ref: 'repo/dependency', phase: 'before', status: 'failed' }]);
    assert.doesNotMatch(JSON.stringify(failed), /SECRET_CANARY|stack/);
    const unknown = await response({ enableAgentAction: () => { throw new Error('/SECRET_CANARY'); } });
    await flush();
    assert.equal((await read(unknown.body.operation.id)).body.operation.error.message, 'Agent activation failed.');
});

const hardwareRefusal = () => ({
    state: 'refused', code: HARDWARE_UNENFORCEABLE, reasonCode: 'controller_unavailable',
    key: 'ploinky_demo_agent', ref: 'demo/agent', alias: null, inputFingerprint: 'a'.repeat(64),
    reason: 'The memory controller is not delegated.', fix: 'Apply the delegation commands, then run ploinky restart.',
    requested: [{ field: 'memory', value: '512m', source: 'manifest' }], blockedBy: null,
    rootCause: { key: 'ploinky_demo_agent', ref: 'demo/agent', field: 'memory', reason: 'The memory controller is not delegated.', fix: 'Apply the delegation commands, then run ploinky restart.' },
    causalPath: ['ploinky_demo_agent'], omittedPathCount: 0, additionalCauseCount: 0,
});

async function failedOperation(error) {
    const accepted = await response({ enableAgentAction: async () => { throw error; } });
    assert.equal(accepted.status, 202);
    await flush();
    const failed = await read(accepted.body.operation.id);
    assert.equal(failed.body.operation.state, 'failed');
    return failed.body.operation.error;
}

test('a hardware refusal keeps its typed outcome and fix text, directly or as a cause', async () => {
    const outcome = hardwareRefusal();
    const direct = await failedOperation(new HardwareLimitsError(outcome));
    assert.equal(direct.code, HARDWARE_UNENFORCEABLE);
    assert.equal(direct.message, formatHardwareOutcome(outcome));
    assert.match(direct.message, /Apply the delegation commands, then run ploinky restart\./);
    assert.equal(direct.hardwareOutcome.reasonCode, outcome.reasonCode);
    const nested = await failedOperation(new Error('/SECRET_CANARY wrapper', { cause: new HardwareLimitsError(outcome) }));
    assert.equal(nested.message, formatHardwareOutcome(outcome));
    assert.doesNotMatch(JSON.stringify(nested), /SECRET_CANARY/);
    // The asynchronous receipt reports what the synchronous response reports.
    const synchronous = await response({ prefer: false, enableAgentAction: async () => { throw new HardwareLimitsError(outcome); } });
    assert.equal(synchronous.status, 422);
    assert.equal(direct.message, synchronous.body.message);
});

test('an invalid hardware outcome stays generic and does not strand the receipt', async () => {
    const failure = await failedOperation(Object.assign(new Error('/SECRET_CANARY'), { hardwareOutcome: { state: 'refused', reason: '/SECRET_CANARY' } }));
    assert.equal(failure.code, 'marketplace_action_failed');
    assert.equal(failure.message, 'Agent activation failed.');
    assert.equal(failure.hardwareOutcome, undefined);
});

test('a recovery-required failure tells the operator how to recover, without the raw worker text', async () => {
    const workerFailed = await failedOperation(Object.assign(new Error('/SECRET_CANARY worker exited (9).'), {
        code: 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED', recoveryRequired: true,
    }));
    assert.equal(workerFailed.code, 'PLOINKY_MARKETPLACE_ENABLE_WORKER_FAILED');
    assert.equal(workerFailed.message, `Agent activation failed. ${MARKETPLACE_ENABLE_RECOVERY_INSTRUCTION}`);
    assert.equal(workerFailed.recoveryRequired, true);
    assert.doesNotMatch(JSON.stringify(workerFailed), /SECRET_CANARY/);
    const timedOut = await failedOperation(Object.assign(new Error('/SECRET_CANARY exceeded'), {
        code: 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT', recoveryRequired: true,
    }));
    assert.equal(timedOut.code, 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT');
    assert.equal(timedOut.message, `Agent activation timed out. ${MARKETPLACE_ENABLE_RECOVERY_INSTRUCTION}`);
    const nested = await failedOperation(new Error('wrapper', { cause: Object.assign(new Error('/SECRET_CANARY'), { recoveryRequired: true }) }));
    assert.equal(nested.recoveryRequired, true);
    assert.equal(nested.code, 'marketplace_action_failed');
    assert.match(nested.message, /Workspace recovery is required/);
    // A value other than true, or an unrelated worker code, claims nothing.
    const claimed = await failedOperation(Object.assign(new Error('/SECRET_CANARY'), { code: 'SOME_OTHER_CODE', recoveryRequired: 'yes' }));
    assert.deepEqual([claimed.code, claimed.message, claimed.recoveryRequired], ['marketplace_action_failed', 'Agent activation failed.', undefined]);
});

test('the synchronous timeout response also carries the recovery instruction', async () => {
    const synchronous = await response({ prefer: false, enableAgentAction: async () => {
        throw Object.assign(new Error('/SECRET_CANARY exceeded'), { code: 'PLOINKY_MARKETPLACE_ENABLE_TIMEOUT', recoveryRequired: true });
    } });
    assert.equal(synchronous.status, 504);
    assert.equal(synchronous.body.message, `Agent activation timed out. ${MARKETPLACE_ENABLE_RECOVERY_INSTRUCTION}`);
    assert.doesNotMatch(JSON.stringify(synchronous.body), /SECRET_CANARY/);
});

test('a retry blocked by a retained lease reports recovery without the raw lease text', async () => {
    const retained = () => Object.assign(new Error('Lease /SECRET_CANARY/lock requires recovery.'), { code: 'PLOINKY_WORKSPACE_MUTATION_RECOVERY_REQUIRED' });
    const receipt = await failedOperation(retained());
    assert.equal(receipt.code, 'PLOINKY_WORKSPACE_MUTATION_RECOVERY_REQUIRED');
    assert.match(receipt.message, /workspace recovery is required\. Stop the exact Box from its host workspace, then start it again\.$/);
    assert.doesNotMatch(JSON.stringify(receipt), /SECRET_CANARY/);
    const synchronous = await response({ prefer: false, enableAgentAction: async () => { throw retained(); } });
    assert.equal(synchronous.status, 503);
    assert.equal(synchronous.body.message, receipt.message);
    assert.doesNotMatch(JSON.stringify(synchronous.body), /SECRET_CANARY/);
});

test('repository recovery keeps its own message without the enable-worker lease claim', () => {
    let sent;
    const res = { setHeader() {}, writeHead(status) { sent = { status }; }, end(body) { sent.body = JSON.parse(body); } };
    const error = Object.assign(new Error('raw'), { code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED', recoveryRequired: true });
    assert.equal(__testables.sendLifecycleError(res, error), true);
    assert.equal(sent.status, 503);
    assert.doesNotMatch(sent.body.message, /mutation lease is retained/);
    assert.equal(sent.body.message.match(/Stop the exact Box/g).length, 1);
});

test('an accepted queued activation fails the original generation fence before starting its worker', async () => {
    let release;
    let started;
    const blocked = new Promise(resolve => { release = resolve; });
    const firstStarted = new Promise(resolve => { started = resolve; });
    const first = enableMarketplaceAgent({ agentRef: 'repo/blocker' }, {
        planDependencies: async () => ({ before: [], after: [], unavailable: [] }),
        runEnableWorker: async () => { started(); await blocked; return {}; },
    });
    await firstStarted;
    let current = true;
    let workers = 0;
    const accepted = await response({ body: { action: 'enable_agent', agentRef: 'repo/queued' }, enableAgentAction: body => enableMarketplaceAgent(body, {
        beforeEnable: () => { if (!current) throw Object.assign(new Error('stale'), { code: 'EDGE_GENERATION_CHANGED' }); },
        planDependencies: async () => ({ before: [], after: [], unavailable: [] }),
        runEnableWorker: async () => { workers++; return {}; },
    }) });
    assert.equal(accepted.status, 202);
    assert.equal((await read(accepted.body.operation.id)).body.operation.state, 'pending');
    current = false;
    release();
    await first;
    await flush();
    assert.equal(workers, 0);
    assert.equal((await read(accepted.body.operation.id)).body.operation.error.code, 'EDGE_GENERATION_CHANGED');
});

test('legacy synchronous activation still waits and returns its inventory', async () => {
    const legacy = await response({ prefer: false, enableAgentAction: async () => ({ result: { status: 'enabled' } }), agentListOptions: { liveContainers: [] } });
    assert.equal(legacy.status, 200);
    assert.ok(Array.isArray(legacy.body.marketplace.agents));
});

test('receipt limits never evict pending work and terminal count and TTL remain bounded', async () => {
    let now = 0;
    const store = createMarketplaceActivationOperations({ now: () => now });
    const releases = [];
    const receipts = [];
    const start = (ref, scope = 'scope') => store.start({ scope, agentRef: ref, mode: '', failure: () => ({ code: 'safe' }), run: () => new Promise(resolve => releases.push(resolve)) });
    for (let i = 0; i < 16; i++) receipts.push(start(`repo/agent${i}`));
    assert.equal(start('repo/overflow'), null);
    assert.equal(start('repo/agent0').id, receipts[0].id);
    now = 1_000_000;
    assert.equal(store.read(receipts[0].id, 'scope').state, 'pending');
    assert.equal(store.read(receipts[0].id, 'other'), null);
    await flush();
    releases.forEach(resolve => resolve());
    await flush();
    const immediate = ref => store.start({ scope: 'scope', agentRef: ref, mode: '', failure: () => ({}), run: async () => ({}) });
    for (let i = 0; i < 65; i++) { immediate(`repo/terminal${i}`); await flush(); }
    assert.equal(store.read(receipts[0].id, 'scope'), null);
    const newest = immediate('repo/newest');
    await flush();
    assert.equal(store.read(newest.id, 'scope').state, 'succeeded');
    now += 600_000;
    assert.equal(store.read(newest.id, 'scope'), null);
});

test('async activation responds before the worker finishes without collecting inventory', async () => {
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const activation = request({ enableAgentAction: () => blocked });
    try {
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(activation.res.status, 202);
        assert.equal(activation.res.body.operation.state, 'pending');
    } finally {
        release({ result: { status: 'enabled' } });
        await activation.done;
    }
});
