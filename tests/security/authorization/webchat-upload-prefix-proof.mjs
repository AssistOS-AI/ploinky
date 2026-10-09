// Focused pre-fix proof: runs only router:webchat-upload-deny:anonymous:webAssist
// against the selected local fixture, under the same ownership guard, mutation
// lock and artifact rules as run.mjs. It needs no principal credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client, TARGET, collectSecrets, digest, ownershipGuard, responseSummary, runVerdict, safeError, validateArtifactRoots, validateTarget, writePrivate } from './core.mjs';
import { runWebchatUploadDenialProof } from './stream-probes.mjs';
import { createMutationLockManager } from '../../../ploinky-box/locks.mjs';

const required = name => { assert.ok(process.env[name], `Set ${name}`); return process.env[name]; };
const config = {
    evidence: required('AUTHZ_DEPLOYMENT_EVIDENCE'),
    output: required('AUTHZ_OUTPUT_DIR'),
    privateRoot: required('AUTHZ_PRIVATE_DIR'),
};
validateTarget(process.env.AUTHZ_TARGET || TARGET);
const sourceRoot = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..'));
[config.output, config.privateRoot] = await validateArtifactRoots(sourceRoot, config.output, config.privateRoot);
await fs.writeFile(path.join(config.output, 'run.lock'), '', { flag: 'wx', mode: 0o600 });
const cleanups = [];
let mutationLock;
const ctx = {
    prefix: `authz-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    clients: {}, secrets: new Set(), hash: digest,
    report: { startedAt: new Date().toISOString(), target: TARGET, focused: 'router:webchat-upload-deny:anonymous:webAssist', checks: [], requests: [], gaps: [], cleanup: [] },
    async guard() {
        const identity = await ownershipGuard(config.evidence);
        mutationLock?.assertHeld(identity.instance);
        return identity;
    },
    cleanup: callback => cleanups.push(callback),
    recordGap: (id, reason) => ctx.report.gaps.push({ id, reason: safeError(reason, ctx.secrets) }),
    async request(actor, options) {
        assert.ok(ctx.clients[actor], `Unknown principal ${actor}`);
        const response = await ctx.clients[actor].request(options);
        collectSecrets(response.json, ctx.secrets);
        ctx.report.requests.push({ actor, method: options.method || 'GET', path: options.path, ...responseSummary(response) });
        await writePrivate(path.join(config.privateRoot, `response-${ctx.report.requests.length}.json`), { actor, method: options.method || 'GET', path: options.path, ...response });
        return response;
    },
    async check(id, fn) {
        const start = ctx.report.requests.length;
        try {
            await fn();
            ctx.report.checks.push({ id, status: 'PASS', requests: [start + 1, ctx.report.requests.length] });
        } catch (error) {
            const status = error?.code === 'ERR_ASSERTION' ? 'FAIL' : 'ERROR';
            ctx.report.checks.push({ id, status, error: safeError(error, ctx.secrets), requests: [start + 1, ctx.report.requests.length] });
            console.log(`${status}: ${id}: ${safeError(error, ctx.secrets)}`);
        }
    },
};
try {
    ctx.report.deployment = await ctx.guard();
    mutationLock = await createMutationLockManager({ timeoutMs: 1000 }).acquire(ctx.report.deployment.instance);
    await ctx.guard();
    ctx.report.workspaceMutationLock = 'HELD';
    ctx.clients.anonymous = new Client([], { onSecret: value => ctx.secrets.add(value), beforeMutation: ctx.guard });
    await runWebchatUploadDenialProof(ctx);
} catch (error) {
    ctx.report.setupError = safeError(error, ctx.secrets);
    console.log(`ERROR: ${ctx.report.setupError}`);
} finally {
    // Only the directory and file this run created are removed.
    for (let index = cleanups.length - 1; index >= 0; index--) {
        try { await ctx.guard(); await cleanups[index](); ctx.report.cleanup.push({ index, status: 'PASS' }); }
        catch (error) { ctx.report.cleanup.push({ index, status: 'FAIL', error: safeError(error, ctx.secrets) }); }
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
    console.log(JSON.stringify({ verdict: ctx.report.verdict, ...ctx.report.counts, focusedProof: ctx.report.focusedProof, cleanup: ctx.report.cleanup.map(item => item.status) }));
    process.exitCode = ctx.report.verdict === 'PASS' ? 0 : 1;
}
