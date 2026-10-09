import assert from 'node:assert/strict';
import { Client, assertDenied, assertPrincipal } from './core.mjs';
import { DASHBOARD } from './principals.mjs';

/**
 * A replayed cookie whose session no longer exists is answered by the token route
 * with 401 {"ok":false,"error":"session_expired"} and a Set-Cookie that clears the
 * cookie (cli/server/authHandlers/authRoutes.js, GET|POST /auth/token: the
 * `invalidCookie` branch). That is the explicit session-invalidation denial for
 * this route, so it is asserted exactly here instead of widening assertDenied,
 * whose content rule serves hundreds of authorization denials.
 */
export function assertSessionExpired(response) {
    assert.equal(response.status, 401, 'A replayed logged-out cookie must be refused with 401');
    assert.deepEqual(response.json, { ok: false, error: 'session_expired' });
    const cleared = [].concat(response.headers?.['set-cookie'] || []).some(line => /^ploinky_sso=;/.test(line) && /(^|;\s*)Max-Age=0(;|$)/i.test(line));
    assert.ok(cleared, 'The refusal must clear the stale session cookie');
}

export async function runAccountProbes(ctx) {
    const target = ctx.principals.userB;
    const endpoint = `/api/agents/explorer/users/${encodeURIComponent(target.id)}`;
    async function persisted() {
        const response = await ctx.request('admin', { path: `/api/agents/explorer/users?search=${encodeURIComponent(ctx.prefix)}` });
        assert.equal(response.status, 200);
        const user = response.json?.users?.find(user => user.id === target.id);
        assert.ok(user, 'Existing disposable target is required');
        return user;
    }
    await ctx.check('users.admin-positive-update', async () => {
        const response = await ctx.request('admin', { method: 'PATCH', path: endpoint, body: { displayName: `${ctx.prefix}-positive` } });
        assert.equal(response.status, 200);
        assert.equal(response.json?.ok, true);
        const user = await persisted();
        assert.equal(user.displayName || user.name, `${ctx.prefix}-positive`);
    });
    for (const actor of ['anonymous', 'selfRegistered', 'userA', 'userB']) {
        await ctx.check(`users.roles-escalation.${actor}`, async () => {
            const before = await persisted();
            const response = await ctx.request(actor, { method: 'PATCH', path: endpoint, body: { roles: ['admin'] } });
            const after = await persisted();
            assert.deepEqual(after.roles, before.roles, 'Forbidden role change had a side effect');
            assertDenied(response);
        });
    }
    for (const [name, headers, proof] of [
        ['missing-origin', { origin: '' }, true],
        ['foreign-origin', { origin: 'https://attacker.invalid' }, true],
        ['invalid-csrf', { 'x-ploinky-csrf-token': 'invalid' }, true],
        ['missing-csrf', {}, false],
    ]) await ctx.check(`users.csrf.${name}`, async () => {
        const before = await persisted();
        const response = await ctx.request('admin', { method: 'PATCH', path: endpoint, body: { displayName: `${ctx.prefix}-forbidden` }, headers, proof });
        const after = await persisted();
        assert.equal(after.displayName || after.name, before.displayName || before.name);
        assertDenied(response);
    });
    await ctx.check('profile.actor-and-role-argument-binding', async () => {
        const before = await persisted();
        const response = await ctx.request('userA', { method: 'POST', path: `${DASHBOARD}/api/profile`, body: { userId: target.id, actorUserId: ctx.principals.admin.id, roles: ['admin'], displayName: `${ctx.prefix}-own-profile` } });
        assert.equal(response.status, 200, 'Own profile update is the positive control');
        const own = await ctx.request('userA', { path: `${DASHBOARD}/api/profile` });
        assert.equal(own.json?.profile?.user?.displayName, `${ctx.prefix}-own-profile`);
        const after = await persisted();
        assert.equal(after.displayName || after.name, before.displayName || before.name, 'Foreign user was modified');
        assertPrincipal((await ctx.request('userA', { path: '/auth/token?agent=explorer' })).json, 'user', ctx.principals.userA.id);
    });
    for (const actor of ['selfRegistered', 'userA']) await ctx.check(`dashboard.admin-role-escalation.${actor}`, async () => {
        const before = await persisted();
        const response = await ctx.request(actor, { method: 'POST', path: `${DASHBOARD}/api/admin/users/roles`, body: { userId: target.id, roles: ['admin'] } });
        assert.deepEqual((await persisted()).roles, before.roles);
        assertDenied(response);
    });
}

export async function runSessionProbes(ctx) {
    await ctx.check('sessions.role-demotion-current-session', async () => {
        const before = await ctx.request('userB', { path: '/explorer/index.html' });
        assert.equal(before.status, 200, 'User must have Explorer access before revocation');
        assert.match(before.text, /<html/i);
        const response = await ctx.request('admin', { method: 'PATCH', path: `/api/agents/explorer/users/${encodeURIComponent(ctx.principals.userB.id)}`, body: { roles: ['selfRegistered'] } });
        assert.equal(response.status, 200);
        const after = await ctx.request('userB', { path: '/explorer/index.html' });
        assertDenied(after);
    });
    await ctx.check('sessions.logout-cookie-replay', async () => {
        const token = await ctx.request('userA', { path: '/auth/token?agent=explorer' });
        assert.equal(token.status, 200);
        const clone = new Client(ctx.clients.userA.cookies, { onSecret: value => ctx.secrets.add(value) });
        // Positive control: before logout the copied cookie is a live session for this principal.
        const live = await clone.request({ path: '/auth/token?agent=explorer' });
        assert.equal(live.status, 200, 'The copied session cookie must work before logout');
        assert.equal(live.json?.ok, true);
        assert.equal(live.json?.user?.id, ctx.principals.userA.id);
        const response = await ctx.request('userA', { method: 'POST', path: '/auth/logout?agent=explorer', body: { csrfToken: token.json.browserMutation.csrfToken, returnTo: '/' } });
        assert.ok([200, 302, 303].includes(response.status), 'Logout positive control must succeed');
        assertSessionExpired(await clone.request({ path: '/auth/token?agent=explorer' }));
    });
}
