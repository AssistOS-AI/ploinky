import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { TARGET, collectSecrets, digest, ownershipGuard, responseSummary, runVerdict, safeError, validateArtifactRoots, validateTarget, writePrivate } from './core.mjs';
import { setupPrincipals } from './principals.mjs';
import { runAccountProbes, runSessionProbes } from './account-probes.mjs';
import { runStreamProbes } from './stream-probes.mjs';
import { writeCoverage } from './coverage.mjs';
import { createMutationLockManager } from '../../../ploinky-box/locks.mjs';

const required = name => { assert.ok(process.env[name], `Set ${name}`); return process.env[name]; };
const config = {
    evidence: required('AUTHZ_DEPLOYMENT_EVIDENCE'),
    credentials: required('AUTHZ_CREDENTIAL_DIR'),
    output: required('AUTHZ_OUTPUT_DIR'),
    privateRoot: required('AUTHZ_PRIVATE_DIR'),
    playwrightModule: required('AUTHZ_PLAYWRIGHT_MODULE'),
};
validateTarget(process.env.AUTHZ_TARGET || TARGET);
const sourceRoot = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
[config.output, config.privateRoot] = await validateArtifactRoots(sourceRoot, config.output, config.privateRoot);
await fs.writeFile(path.join(config.output, 'run.lock'), '', { flag: 'wx', mode: 0o600 });
const cleanups = [];
let mutationLock;
const ctx = {
    prefix: `authz-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    clients: {}, principals: {}, secrets: new Set(), hash: digest, finalizers: [],
    report: { startedAt: new Date().toISOString(), target: TARGET, checks: [], requests: [], gaps: [], cleanup: [] },
    progress: message => console.log(message),
    async guard() {
        const identity = await ownershipGuard(config.evidence);
        mutationLock?.assertHeld(identity.instance);
        return identity;
    },
    cleanup: callback => cleanups.push(callback),
    recordGap: (id, reason) => ctx.report.gaps.push({ id, reason: safeError(reason, ctx.secrets) }),
    async request(actor, options) {
        if (ctx.report.interrupted && !ctx.cleaning) throw new Error('Run interrupted; proceeding to owned cleanup');
        assert.ok(ctx.clients[actor], `Unknown principal ${actor}`);
        const response = await ctx.clients[actor].request(options);
        collectSecrets(response.json, ctx.secrets);
        ctx.report.requests.push({ actor, method: options.method || 'GET', path: options.path, rpcMethod: options.body?.method, tool: options.body?.method === 'tools/call' ? options.body?.params?.name : undefined, operation: options.body?.command || options.body?.action, ...responseSummary(response) });
        // Private raw responses support inspection of failures; never copy them to source or public evidence.
        await writePrivate(path.join(config.privateRoot, `response-${ctx.report.requests.length}.json`), { actor, method: options.method || 'GET', path: options.path, ...response });
        return response;
    },
    async check(id, fn) {
        if (ctx.report.interrupted && !ctx.cleaning) throw new Error('Run interrupted; proceeding to owned cleanup');
        const start = ctx.report.requests.length;
        try {
            await fn();
            ctx.report.checks.push({ id, status: 'PASS', requests: [start + 1, ctx.report.requests.length] });
        } catch (error) {
            const status = error?.code === 'ERR_ASSERTION' ? 'FAIL' : 'ERROR';
            ctx.report.checks.push({ id, status, error: safeError(error, ctx.secrets), requests: [start + 1, ctx.report.requests.length] });
            console.log(`${status}: ${id}: ${safeError(error, ctx.secrets)}`);
        }
        if (ctx.report.checks.length % 25 === 0) console.log(`Progress: ${ctx.report.checks.length} assertions recorded; ${ctx.report.gaps.length} explicit gaps`);
    },
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { ctx.report.interrupted = signal; console.log('Interruption requested; finishing current bounded request and cleaning owned fixtures.'); });
try {
    ctx.report.deployment = await ctx.guard();
    mutationLock = await createMutationLockManager({ timeoutMs: 1000 }).acquire(ctx.report.deployment.instance);
    await ctx.guard();
    ctx.report.workspaceMutationLock = 'HELD';
    console.log('PASS: exact loopback target, Box identity/confinement and all source pins');
    await setupPrincipals(ctx, config);
    ctx.cleanup(() => runSessionProbes(ctx));
    const runtime = await ctx.request('admin', { path: '/status/data' });
    assert.equal(runtime.status, 200);
    assert.equal(runtime.json.runtimes.length, 19);
    assert.ok(runtime.json.runtimes.every(r => r.enabled && r.state?.running));
    ctx.report.runtimes = runtime.json.runtimes.map(r => ({ repo: r.repoName, agent: r.agentName, enabled: r.enabled, running: r.state.running }));
    const { runRouterProbes } = await import('./router-probes.mjs');
    await runRouterProbes(ctx);
    await runAccountProbes(ctx);
    await runStreamProbes(ctx);
    const { runAgentProbes } = await import('./agent-probes.mjs');
    await runAgentProbes(ctx);
    const { runResourceProbes } = await import('./resource-probes.mjs');
    await runResourceProbes(ctx);
} catch (error) {
    ctx.report.setupError = safeError(error, ctx.secrets);
    console.log(`ERROR: ${ctx.report.setupError}`);
} finally {
    ctx.cleaning = true;
    for (let index = cleanups.length - 1; index >= 0; index--) {
        try { await ctx.guard(); await cleanups[index](); ctx.report.cleanup.push({ index, status: 'PASS' }); }
        catch (error) { ctx.report.cleanup.push({ index, status: 'FAIL', error: safeError(error, ctx.secrets) }); }
    }
    for (const finalize of ctx.finalizers) {
        try { await finalize(); } catch (error) { ctx.report.cleanup.push({ status: 'FAIL', error: safeError(error, ctx.secrets) }); }
    }
    try { await ctx.guard(); ctx.report.finalOwnership = 'PASS'; }
    catch (error) { ctx.report.finalOwnership = safeError(error, ctx.secrets); }
    if (mutationLock) {
        try { mutationLock.release(); ctx.report.workspaceMutationLock = 'RELEASED'; }
        catch (error) { ctx.report.cleanup.push({ status: 'FAIL', error: safeError(error, ctx.secrets) }); }
    }
    ctx.report.finishedAt = new Date().toISOString();
    ctx.report.counts = Object.fromEntries(['PASS', 'FAIL', 'ERROR'].map(status => [status, ctx.report.checks.filter(check => check.status === status).length]));
    ctx.report.verdict = runVerdict(ctx.report);
    let serialized = JSON.stringify(ctx.report, null, 2);
    for (const secret of ctx.secrets) if (typeof secret === 'string' && secret.length >= 6) serialized = serialized.split(secret).join('[private]');
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\./.test(serialized), 'Refusing to write token-bearing evidence');
    await fs.writeFile(path.join(config.output, 'report.json'), serialized + '\n', { mode: 0o600 });
    await writeCoverage(config.output, JSON.parse(serialized));
    console.log(JSON.stringify({ verdict: ctx.report.verdict, ...ctx.report.counts, gaps: ctx.report.gaps.length, cleanup: ctx.report.cleanup.map(item => item.status) }));
    process.exitCode = ctx.report.verdict === 'PASS' ? 0 : ctx.report.verdict === 'NO_FAILURES_WITH_GAPS' ? 2 : 1;
}
