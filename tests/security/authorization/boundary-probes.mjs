/**
 * Live controls for the changed U3 (protected/public template revalidation)
 * and U7 (marketplace POST admission) boundaries.
 *
 * Every deny check is linked to a positive control in the same run. A failed
 * positive control records a positive-unavailable gap, which the scoped
 * acceptance gate never accepts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TARGET, WORKSPACE, assertDenied } from './core.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export const templateProbe = Object.freeze({
    protectedPath: '/explorer/web-components/modals/settings-modal/settings-modal.html',
    protectedSource: '.ploinky/repos/AchillesIDE/explorer/web-components/modals/settings-modal/settings-modal.html',
    publicPath: '/explorer/web-components/components/file-exp-preview/file-exp-preview.html',
    publicSource: '.ploinky/repos/AchillesIDE/explorer/web-components/components/file-exp-preview/file-exp-preview.html',
    positiveActors: Object.freeze(['admin', 'userA']),
    deniedActors: Object.freeze(['anonymous', 'selfRegistered']),
    conditionals: Object.freeze(['etag', 'star', 'ims']),
});

/** Check definitions for the mandatory-check enumerator. */
export function templateCheckDefinitions() {
    const positives = templateProbe.positiveActors.map(actor => `u3:protected-template:${actor}`);
    return [
        ...positives.map(id => ({ id, kind: 'live', boundary: 'U3', source: 'tests/security/authorization/boundary-probes.mjs runTemplateProbes', positiveControlAnyOf: null })),
        ...templateProbe.deniedActors.flatMap(actor => templateProbe.conditionals.map(mode => ({
            id: `u3:protected-template-deny:${actor}:${mode}`, kind: 'live', boundary: 'U3', source: 'tests/security/authorization/boundary-probes.mjs runTemplateProbes', positiveControlAnyOf: positives,
        }))),
        { id: 'u3:public-template:anonymous', kind: 'live', boundary: 'U3', source: 'tests/security/authorization/boundary-probes.mjs runTemplateProbes', positiveControlAnyOf: null },
        { id: 'u3:navigation:userA', kind: 'live', boundary: 'U3', source: 'tests/security/authorization/boundary-probes.mjs runTemplateProbes', positiveControlAnyOf: null },
    ];
}

const fetchHeaders = (extra = {}) => ({ accept: '*/*', 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', ...extra });

export async function runTemplateProbes(ctx, { readSource = rel => fs.readFile(path.join(WORKSPACE, rel)) } = {}) {
    const protectedBytes = await readSource(templateProbe.protectedSource);
    const publicBytes = await readSource(templateProbe.publicSource);
    const expectedProtected = sha256(protectedBytes);
    const expectedPublic = sha256(publicBytes);
    let etag = '';
    let lastModified = '';
    let positive = false;
    for (const actor of templateProbe.positiveActors) {
        await ctx.check(`u3:protected-template:${actor}`, async () => {
            const first = await ctx.request(actor, { path: templateProbe.protectedPath, headers: fetchHeaders() });
            assert.equal(first.status, 200, 'Authorized template fetch must succeed');
            assert.equal(sha256(Buffer.from(first.text || '', 'utf8')), expectedProtected, 'Template bytes must equal the pinned source');
            assert.equal(String(first.headers['cache-control']), 'private, no-cache', 'Authenticated template fetch must be private and revalidated');
            assert.ok(first.headers.etag, 'Template fetch must advertise a validator');
            const again = await ctx.request(actor, { path: templateProbe.protectedPath, headers: fetchHeaders({ 'if-none-match': first.headers.etag }) });
            assert.equal(again.status, 304, 'Authorized revalidation must return 304');
            assert.equal(again.text || '', '', '304 carries no body');
            etag = first.headers.etag;
            lastModified = first.headers['last-modified'] || new Date().toUTCString();
            positive = true;
        });
    }
    if (!positive) {
        for (const actor of templateProbe.deniedActors) for (const mode of templateProbe.conditionals) {
            ctx.recordGap(`u3:protected-template-deny:${actor}:${mode}`, 'Authorized template fetch failed; denial cannot be credited.', { kind: 'positive-unavailable', actor });
        }
    } else {
        for (const actor of templateProbe.deniedActors) for (const mode of templateProbe.conditionals) {
            await ctx.check(`u3:protected-template-deny:${actor}:${mode}`, async () => {
                const conditional = mode === 'etag' ? { 'if-none-match': etag } : mode === 'star' ? { 'if-none-match': '*' } : { 'if-modified-since': lastModified };
                const response = await ctx.request(actor, { path: templateProbe.protectedPath, headers: { ...fetchHeaders(conditional), accept: 'application/json' } });
                assert.notEqual(response.status, 304, 'A conditional request must never revalidate a protected template for a denied principal');
                assertDenied(response);
                assert.ok(!String(response.text || '').includes(protectedBytes.toString('utf8').slice(0, 64)), 'Denial must carry no template bytes');
            });
        }
    }
    await ctx.check('u3:public-template:anonymous', async () => {
        const first = await ctx.request('anonymous', { path: templateProbe.publicPath, headers: fetchHeaders() });
        assert.equal(first.status, 200, 'Public template must be served');
        assert.equal(sha256(Buffer.from(first.text || '', 'utf8')), expectedPublic, 'Public template bytes must equal the pinned source');
        const again = await ctx.request('anonymous', { path: templateProbe.publicPath, headers: fetchHeaders(first.headers.etag ? { 'if-none-match': first.headers.etag } : {}) });
        assert.ok(again.status === 304 ? (again.text || '') === '' : again.status === 200 && sha256(Buffer.from(again.text || '', 'utf8')) === expectedPublic, 'Public revalidation must be 304 without a body or 200 with exact bytes');
    });
    await ctx.check('u3:navigation:userA', async () => {
        const response = await ctx.request('userA', { path: templateProbe.protectedPath, headers: { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', ...(etag ? { 'if-none-match': etag } : {}) } });
        assert.equal(response.status, 200, 'Navigation ignores validators and answers 200');
        assert.equal(String(response.headers['cache-control']), 'no-store', 'Navigation to HTML is never stored');
        assert.equal(sha256(Buffer.from(response.text || '', 'utf8')), expectedProtected);
    });
}

export const marketplaceAdmission = Object.freeze({
    resources: Object.freeze(['repos', 'agents']),
    deniedActors: Object.freeze(['userA', 'selfRegistered', 'anonymous']),
    action: 'authz-unknown',
});

export function marketplaceCheckDefinitions() {
    const source = 'tests/security/authorization/boundary-probes.mjs runMarketplaceAdmissionProbes';
    const defs = [{ id: 'u7:marketplace-listing-baseline:admin', kind: 'live', boundary: 'U7', source, positiveControlAnyOf: null }];
    for (const resource of marketplaceAdmission.resources) {
        const positive = `u7:marketplace-unknown-action:admin:${resource}`;
        defs.push({ id: positive, kind: 'live', boundary: 'U7', source, positiveControlAnyOf: null });
        for (const actor of [...marketplaceAdmission.deniedActors, 'admin-no-csrf']) defs.push({ id: `u7:marketplace-unknown-action-deny:${actor}:${resource}`, kind: 'live', boundary: 'U7', source, positiveControlAnyOf: [positive] });
    }
    defs.push({ id: 'u7:marketplace-no-effect:admin', kind: 'live', boundary: 'U7', source, positiveControlAnyOf: marketplaceAdmission.resources.map(r => `u7:marketplace-unknown-action:admin:${r}`) });
    return defs;
}

/**
 * Normalized listing projection: repository identity plus installed/enabled,
 * agent identity plus active. Lifecycle, pid and status fields are excluded so
 * runtime churn cannot cause a false failure.
 */
export function marketplaceProjection(repos, agents) {
    const repositories = (repos?.marketplace?.repositories || []).map(r => ({ name: String(r?.name || ''), installed: r?.installed === true, enabled: r?.enabled === true }));
    const agentList = (agents?.marketplace?.agents || []).map(a => ({ ref: String(a?.ref || ''), repo: String(a?.repo || ''), name: String(a?.name || ''), active: a?.active === true }));
    assert.ok(repositories.length > 0 && agentList.length > 0, 'Marketplace listings must be non-empty');
    const sorted = list => [...list].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    return sha256(JSON.stringify({ repositories: sorted(repositories), agents: sorted(agentList) }));
}

async function listingDigest(ctx) {
    const repos = await ctx.request('admin', { path: '/api/marketplace/repos' });
    const agents = await ctx.request('admin', { path: '/api/marketplace/agents' });
    assert.equal(repos.status, 200);
    assert.equal(agents.status, 200);
    return marketplaceProjection(repos.json, agents.json);
}

export async function runMarketplaceAdmissionProbes(ctx) {
    let before = '';
    await ctx.check('u7:marketplace-listing-baseline:admin', async () => { before = await listingDigest(ctx); });
    const positives = new Set();
    for (const actor of ['admin', 'userA', 'selfRegistered']) await ctx.request(actor, { path: '/auth/token?agent=explorer' });
    for (const resource of marketplaceAdmission.resources) {
        const route = `/api/marketplace/${resource}`;
        await ctx.check(`u7:marketplace-unknown-action:admin:${resource}`, async () => {
            assert.ok(before, 'Listing baseline is required before the admission probe');
            const response = await ctx.request('admin', { method: 'POST', path: route, body: { action: marketplaceAdmission.action } });
            assert.equal(response.status, 400, 'Administrator with valid Origin and CSRF must reach the action check');
            assert.equal(response.json?.error, 'unknown_action');
            assert.equal(response.json?.ok, false);
            positives.add(resource);
        });
        if (!positives.has(resource)) {
            for (const actor of [...marketplaceAdmission.deniedActors, 'admin-no-csrf']) ctx.recordGap(`u7:marketplace-unknown-action-deny:${actor}:${resource}`, 'Administrator unknown-action control failed; denial cannot be credited.', { kind: 'positive-unavailable', actor: actor === 'admin-no-csrf' ? 'admin' : actor });
            continue;
        }
        for (const actor of marketplaceAdmission.deniedActors) await ctx.check(`u7:marketplace-unknown-action-deny:${actor}:${resource}`, async () => {
            const response = await ctx.request(actor, { method: 'POST', path: route, body: { action: marketplaceAdmission.action } });
            assert.notEqual(response.status, 400, 'A non-administrator must be denied before the action check');
            assertDenied(response);
        });
        await ctx.check(`u7:marketplace-unknown-action-deny:admin-no-csrf:${resource}`, async () => {
            const response = await ctx.request('admin', { method: 'POST', path: route, body: { action: marketplaceAdmission.action }, proof: false, headers: { origin: TARGET } });
            assert.equal(response.status, 403, 'Administrator without CSRF proof must receive 403');
            assertDenied(response);
        });
    }
    await ctx.check('u7:marketplace-no-effect:admin', async () => {
        assert.equal(positives.size, marketplaceAdmission.resources.length, 'Both positive controls are required');
        assert.equal(await listingDigest(ctx), before, 'Unknown-action probes changed the marketplace listings');
    });
}
