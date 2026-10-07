import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const previousCwd = process.cwd();
const previousEnv = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_MASTER_KEY'].map((key) => [key, process.env[key]]));
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repository-worker-routes-')));
const invocation = path.join(workspace, 'invocation');
fs.mkdirSync(invocation);
fs.mkdirSync(path.join(workspace, '.ploinky/repos'), { recursive: true });
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_MASTER_KEY = '5'.repeat(64);
process.chdir(invocation);
const { handleMarketplaceRoutes } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
const { mintSessionJwt, getSession } = await import('../../cli/server/auth/localService.js');
const { mintAdminCsrfToken } = await import('../../cli/server/adminControlSecurity.js');
const { listAgentRepositoryNames, runWithRepositoryResolutionScope } = await import('../../cli/utils/agentRepositorySource.mjs');
const adminId = mintSessionJwt({ id: 'local:admin', roles: ['admin'] }, 1, { channel: 'cli' });

test.after(() => {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});
function response() {
    return Object.assign(new EventEmitter(), {
        writes: 0, setHeader() {}, writeHead(status) { this.status = status; this.writes += 1; },
        end(value) { this.body = JSON.parse(value); this.writableEnded = true; this.emit('close'); },
    });
}
async function request({ body = { action: 'install_repo', url: '../source.git', name: 'fixture', branch: 'topic' },
    proof = true, authenticated = true, bearer, res = response(), ...options } = {}) {
    const raw = Buffer.from(JSON.stringify(body));
    const req = Readable.from([raw]);
    req.method = 'POST';
    req.headers = { host: 'localhost', origin: 'http://localhost', ...(authenticated ? { cookie: `ploinky_jwt=${adminId}` } : {}) };
    if (authenticated) req.session = getSession(adminId);
    if (proof) req.headers['x-ploinky-csrf-token'] = mintAdminCsrfToken({ req, sessionId: adminId });
    if (bearer) req.headers.authorization = `Bearer ${bearer}`;
    await handleMarketplaceRoutes(req, res, new URL('http://localhost/api/marketplace/repos'), options);
    return { res, raw };
}

test('authentication, proof, action and normalization rejection happen before eligibility or offload', async () => {
    let selections = 0;
    let launches = 0;
    const options = { repositoryWorkerEligibility: () => { selections += 1; return true; },
        repositoryWorker: async () => { launches += 1; throw new Error('unexpected worker'); } };
    for (const [input, status] of [
        [{ authenticated: false }, 401], [{ proof: false }, 403],
        [{ body: { action: 'unknown' } }, 400],
        [{ body: { action: 'install_repo', url: 'bad\nurl' } }, 400],
        [{ body: { action: 'uninstall_repo', target: 'fixture' }, bearer: 'untrusted-assertion' }, 403],
        [{ routePlan: { lease: { commit: () => false } } }, 503],
    ]) assert.equal((await request({ ...options, ...input })).res.status, status);
    assert.equal(selections, 0);
    assert.equal(launches, 0);
});

test('eligible route preserves normalized relative input, exact byte charge, original cwd and workspace', async () => {
    let received;
    const body = { action: 'install_repo', url: ' ../source.git ', name: ' fixture ', branch: ' topic ' };
    const { res, raw } = await request({ body, repositoryWorkerEligibility: () => true,
        repositoryWorker: async (options) => { received = options; assert.equal(options.authorize(), true); return { status: 'cloned' }; } });
    assert.equal(res.status, 200);
    assert.deepEqual(received.operation, { action: 'install_repo', url: '../source.git', name: 'fixture', branch: 'topic' });
    assert.equal(received.rawBodyBytes, raw.byteLength);
    assert.equal(received.cwd, invocation);
    assert.equal(received.workspaceRoot, workspace);
    assert.notEqual(received.cwd, received.workspaceRoot);
    assert.equal(received.response, res);
    assert.equal(received.diagnosticContext.caller, 'browser-control');
    assert.equal(received.diagnosticContext.routeLease, false);
    assert.equal(received.diagnosticContext.graphReadiness, 'unavailable');
    assert.ok(received.diagnosticContext.receivedAt <= Date.now());
    assert.ok(received.diagnosticContext.routerElapsedMs >= 0);
    assert.doesNotMatch(JSON.stringify(received.diagnosticContext), /source\.git|topic|fixture/);
});

test('verified agent prepare carries only authorized caller and hashed generation context', async () => {
    const { signAgentHttpAssertion } = await import('../../Agent/lib/agentAssertion.mjs');
    const { deriveAgentRequestSecret } = await import('../../cli/utils/security/masterKey.js');
    const { MARKETPLACE_AGENT_TARGET } = await import('../../cli/server/authHandlers/marketplaceRoutes.js');
    const caller = 'agent:repo/caller';
    const body = { action: 'install_repo', url: '../SECRET_CANARY.git', name: 'fixture' };
    const bearer = signAgentHttpAssertion({ method: 'POST', path: '/api/marketplace/repos', body: Buffer.from(JSON.stringify(body)),
        targetAgent: MARKETPLACE_AGENT_TARGET, tool: 'repositories.prepare',
        env: { PLOINKY_AGENT_ID: caller, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(caller) } });
    let context;
    const { res } = await request({ body, bearer, authenticated: false, proof: false,
        routePlan: { lease: { id: 'generation-a', commit: () => true } },
        repositoryWorkerEligibility: () => true, repositoryWorker: async ({ diagnosticContext }) => {
            context = diagnosticContext; return { status: 'cloned' };
        } });
    assert.equal(res.status, 200);
    assert.equal(context.caller, 'agent-assertion');
    assert.equal(context.routeLease, true);
    assert.match(context.generation, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(context), /SECRET_CANARY|generation-a|agent:repo/);
});

test('native fallback remains direct and invalid canonical marker never falls back', async () => {
    let direct = 0;
    const options = { body: { action: 'uninstall_repo', target: 'fixture' },
        uninstallRepositoryAction: async () => { direct += 1; return { status: 'removed' }; },
        repositoryWorker: async () => { throw new Error('unexpected worker'); } };
    assert.equal((await request({ ...options, repositoryWorkerEligibility: () => false })).res.status, 200);
    assert.equal(direct, 1);
    const { res } = await request({ ...options, repositoryWorkerEligibility: () => {
        throw Object.assign(new Error('invalid marker'), { code: 'PLOINKY_BOX_MARKER_INVALID' });
    } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'PLOINKY_BOX_MARKER_INVALID');
    assert.equal(direct, 1);
});

test('worker queue overflow maps to the exact 429 envelope and admitted response closure suppresses all delivery', async () => {
    const busy = await request({ repositoryWorkerEligibility: () => true, repositoryWorker: async () => {
        throw Object.assign(new Error('not transported'), { code: 'marketplace_repository_busy' });
    } });
    assert.equal(busy.res.status, 429);
    assert.deepEqual(busy.res.body, { ok: false, error: 'marketplace_repository_busy', message: 'Repository operation queue is full. Retry later.' });
    const res = response();
    await request({ res, repositoryWorkerEligibility: () => true, repositoryWorker: async ({ authorize }) => {
        assert.equal(authorize(), true);
        res.destroyed = true; res.emit('close');
        return { status: 'cloned' };
    } });
    assert.equal(res.writes, 0);
    assert.equal(res.body, undefined);
});

test('post-acquisition authorization invokes the original hardware revision lease with unchanged generation', async () => {
    let revision = 1;
    let commits = 0;
    const originalLease = { generation: 'fixed-generation', activation: 'fixed-activation',
        commit: () => { commits += 1; return revision === 1; } };
    const { res } = await request({ routePlan: { lease: originalLease }, repositoryWorkerEligibility: () => true,
        repositoryWorker: async ({ authorize }) => {
            revision = 2;
            assert.equal(authorize(), false);
            throw Object.assign(new Error('changed'), { code: 'EDGE_GENERATION_CHANGED' });
        } });
    assert.equal(res.status, 503);
    assert.equal(commits, 3);
    assert.equal(originalLease.generation, 'fixed-generation');
    assert.equal(originalLease.activation, 'fixed-activation');
});

test('worker publication returns a fresh awaited catalog inside an existing scope and uninstall does not recheck its old lease', async () => {
    const repo = path.join(workspace, '.ploinky/repos/published');
    let generationCurrent = true;
    let commits = 0;
    const lease = { commit: () => { commits += 1; return generationCurrent; } };
    await runWithRepositoryResolutionScope(async () => {
        assert.equal(listAgentRepositoryNames().includes('published'), false);
        const installed = await request({ repositoryWorkerEligibility: () => true, repositoryWorker: async () => {
            fs.mkdirSync(path.join(repo, 'worker'), { recursive: true });
            fs.writeFileSync(path.join(repo, 'worker/manifest.json'), '{}');
            return { status: 'cloned' };
        } });
        assert.equal(installed.res.status, 200);
        assert.equal(installed.res.body.marketplace.repositories.find((entry) => entry.name === 'published')?.installed, true);
    });
    await runWithRepositoryResolutionScope(async () => {
        assert.equal(listAgentRepositoryNames().includes('published'), true);
        const removed = await request({ body: { action: 'uninstall_repo', target: 'published' }, routePlan: { lease },
            repositoryWorkerEligibility: () => true, repositoryWorker: async ({ authorize }) => {
                assert.equal(authorize(), true);
                fs.rmSync(repo, { recursive: true });
                generationCurrent = false;
                return { status: 'removed' };
            } });
        assert.equal(removed.res.status, 200, JSON.stringify(removed.res.body));
        assert.notEqual(removed.res.body.marketplace.repositories.find((entry) => entry.name === 'published')?.installed, true);
        assert.equal(commits, 3, 'entry, body and admission checks only; no stale check after publication');
    });
});
