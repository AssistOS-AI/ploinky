import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client, TARGET, WORKSPACE, assertLoopbackPage, assertPrincipal, browserRequestDecision, command, isLoopbackTargetOrigin, privateJson, writePrivate } from './core.mjs';

export const DASHBOARD = '/base-agent-additional-server/userPersistoAgent/7000/service/dashboard';

export async function armPrincipalCleanup(ctx, email) {
    assert.ok(email.startsWith(`${ctx.prefix}-`) && email.endsWith('@example.test'), 'Cleanup requires an exact disposable registration address');
    async function lookup() {
        const response = await ctx.request('admin', { path: `/api/agents/explorer/users?search=${encodeURIComponent(email)}&pageSize=100` });
        assert.equal(response.status, 200);
        assert.ok(Array.isArray(response.json?.users), 'Authoritative account lookup is required for cleanup');
        const matches = response.json.users.filter(user => user.email?.toLowerCase() === email);
        assert.ok(matches.length <= 1, 'Ambiguous disposable account ownership');
        return matches[0];
    }
    assert.equal(await lookup(), undefined, 'Disposable email must not belong to a preexisting account');
    let expectedId;
    // Arm before browser registration: the account can exist even if the
    // redirect or Router token verification fails after email verification.
    ctx.cleanup(async () => {
        const user = await lookup();
        if (!user && !expectedId) return;
        assert.ok(user?.id, 'Registered disposable account disappeared before cleanup');
        if (expectedId) assert.equal(user.id, expectedId, 'Disposable account identity changed');
        const result = await ctx.request('admin', { method: 'DELETE', path: `/api/agents/explorer/users/${encodeURIComponent(user.id)}` });
        assert.equal(result.status, 200, 'Disposable account must be blocked through supported delete API');
        assert.equal(result.json?.deleted, true);
    });
    return id => { assert.ok(id); expectedId = id; };
}

async function eventually(read, predicate, label) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
        const value = await read();
        if (predicate(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

/**
 * Browser cookies can exist for both loopback names. The raw Client sends by
 * path only, so keep one cookie per name/path, preferring the host on which the
 * sign-in actually completed.
 */
export function preferHostCookies(cookies, hostname) {
    const chosen = new Map();
    for (const cookie of cookies) {
        const key = `${cookie.name}\0${cookie.path || '/'}`;
        const domain = String(cookie.domain || '').replace(/^\./, '');
        const current = chosen.get(key);
        if (!current || (domain === hostname && String(current.domain || '').replace(/^\./, '') !== hostname)) chosen.set(key, cookie);
    }
    return [...chosen.values()];
}

export const AUTH_SETUP = '/base-agent-additional-server/userPersistoAgent/7000/service/auth/setup';

export function assertListingCapability(profile, name) {
    assert.ok(Array.isArray(profile?.capabilities), 'Authoritative profile must expose capabilities');
    assert.equal(profile.capabilities.includes('explorer.access'), name !== 'selfRegistered', `${name} explorer.access capability does not match the listing expectations`);
}

/**
 * Choose the disposable-principal registration path from UserPersisto's public
 * wizard configuration (userPersistoAgent/lib/auth/wizardConfig.mjs). Password
 * sign-up is used when open email sign-up needs no verification; the emailed
 * development code path is used when code delivery is available. Anything else
 * fails closed: the suite never invents an account another way.
 */
export function selectRegistrationMethod(setup) {
    assert.ok(setup && setup.ok === true, 'REGISTRATION_SETUP_UNAVAILABLE: public auth setup did not answer');
    assert.equal(setup.setupComplete, true, 'REGISTRATION_BOOTSTRAP_OPEN: bootstrap must already be claimed');
    if (setup.signup?.email === true && setup.methods?.password === true && setup.signup.verification === 'none') {
        const min = Number(setup.passwordPolicy?.minLength) || 12;
        const max = Number(setup.passwordPolicy?.maxLength) || 128;
        assert.ok(min <= 64 && max >= Math.max(min, 32), 'REGISTRATION_PASSWORD_POLICY: unsupported password policy');
        return { mode: 'password', length: Math.max(min, 32) };
    }
    if (setup.signup?.email === true && setup.methods?.emailCode === true) return { mode: 'email-code' };
    assert.fail('REGISTRATION_UNAVAILABLE: neither password sign-up without verification nor email-code delivery is available');
}

export async function setupPrincipals(ctx, config) {
    const { chromium } = await import(pathToFileURL(config.playwrightModule).href);
    const pin = await ctx.guard();
    // The exact container name comes from the pinned capture (agents.json record), not a hardcoded fixture.
    const agentName = pin.userPersistoContainer;
    assert.match(String(agentName || ''), /^ploinky_AchillesIDE_userPersistoAgent_[A-Za-z0-9_.-]+$/, 'Captured UserPersisto container name is required');
    const inner = JSON.parse(command('podman', ['exec', pin.boxId, 'podman', 'inspect', agentName]))[0];
    assert.equal(inner.Name.replace(/^\//, ''), agentName);
    assert.equal(inner.State.Running, true);
    assert.ok(inner.Config.Labels['io.assistos.ploinky.enable-generation']);
    const logPath = path.join(config.privateRoot, 'userpersisto.log');
    const log = await fs.open(logPath, 'wx', 0o600);
    const capture = spawn('podman', ['exec', pin.boxId, 'podman', 'logs', '--since', '1s', '--follow', inner.Id], { stdio: ['ignore', log.fd, log.fd] });
    ctx.finalizers.push(async () => { capture.kill('SIGTERM'); await log.close(); });
    const browser = await chromium.launch({ headless: true });
    const contexts = [];
    ctx.finalizers.push(async () => { await browser.close(); });
    const newClient = cookies => new Client(cookies, { onSecret: value => ctx.secrets.add(value), beforeMutation: ctx.guard });
    ctx.clients.anonymous = newClient([]);

    async function browserContext(storageState) {
        const context = await browser.newContext({ baseURL: TARGET, ...(storageState ? { storageState } : {}) });
        // The browser is permitted to contact only the selected loopback deployment.
        await context.route('**/*', async route => {
            if (browserRequestDecision(route.request().url()) !== 'continue') {
                (ctx.report.blockedBrowserOrigins ||= []).push(String(new URL(route.request().url()).origin).slice(0, 120));
                return route.abort('blockedbyclient');
            }
            if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) await ctx.guard();
            return route.continue();
        });
        contexts.push(context);
        return context;
    }
    const setup = await ctx.request('anonymous', { path: AUTH_SETUP });
    const registration = selectRegistrationMethod(setup.status === 200 ? setup.json : null);
    ctx.report.registrationMethod = registration.mode;
    const passwords = new Map();
    const passwordFor = email => {
        if (!passwords.has(email)) {
            const value = `Az9-${randomBytes(48).toString('base64url')}`.slice(0, registration.length);
            ctx.secrets.add(value);
            passwords.set(email, value);
        }
        return passwords.get(email);
    };
    async function finishLogin(page, context) {
        await page.waitForURL(url => isLoopbackTargetOrigin(url.origin) && (url.pathname.startsWith('/explorer/') || url.pathname === `${DASHBOARD}/` || url.pathname === '/'));
        assertLoopbackPage(page.url(), 'Sign-in result');
        const client = newClient(preferHostCookies(await context.cookies(), new URL(page.url()).hostname));
        const token = await client.request({ path: '/auth/token?agent=explorer' });
        assert.equal(token.status, 200, 'Fresh browser sign-in must yield Router session');
        await page.close();
        return { client, token };
    }
    async function passwordLogin(page, context, root, { email, fresh }) {
        const signUp = root.getByRole('button', { name: 'Sign up', exact: true });
        const passwordScreen = root.getByRole('heading', { name: 'Enter your password', exact: true });
        await signUp.or(passwordScreen).first().waitFor();
        if (fresh) assert.equal(await signUp.isVisible(), true, 'Fresh principal must use real public registration');
        if (await signUp.isVisible()) {
            assert.equal(fresh, true, 'An existing principal must not be re-registered');
            await signUp.click();
            await root.locator('input[name="password"]').fill(passwordFor(email));
            await root.locator('input[name="passwordConfirmation"]').fill(passwordFor(email));
            await root.getByRole('button', { name: 'Create account', exact: true }).click();
        } else {
            await root.locator('input[name="password"]').fill(passwordFor(email));
            await root.getByRole('button', { name: 'Log in', exact: true }).click();
        }
        return finishLogin(page, context);
    }
    async function login(context, { email, fresh = false } = {}) {
        await ctx.guard();
        const page = await context.newPage();
        page.setDefaultTimeout(45000);
        await page.goto(`${TARGET}/auth/login?agent=explorer&returnTo=%2Fexplorer%2Findex.html`);
        // The Router may restart login on the canonical loopback name; any other origin fails here.
        assertLoopbackPage(page.url(), 'Login navigation');
        const root = page.locator('#auth_content');
        await root.locator('input[name="email"]').waitFor();
        assert.equal(await root.getByText('The first completed sign-in becomes its administrator', { exact: false }).count(), 0, 'Bootstrap must remain claimed');
        if (registration.mode === 'password') {
            await root.locator('input[name="email"]').fill(email);
            await root.getByRole('button', { name: 'Next', exact: true }).click();
            return passwordLogin(page, context, root, { email, fresh });
        }
        const offset = (await fs.stat(logPath)).size;
        await root.locator('input[name="email"]').fill(email);
        await root.getByRole('button', { name: 'Next', exact: true }).click();
        const create = root.getByRole('button', { name: 'Create account', exact: true });
        const choose = root.getByRole('button', { name: 'Email me a code', exact: true });
        const input = root.locator('input[name="code"]');
        await create.or(choose).or(input).first().waitFor();
        if (fresh) assert.equal(await create.isVisible(), true, 'Fresh principal must use real public registration');
        if (await create.isVisible()) await create.click();
        await choose.or(input).first().waitFor();
        if (await choose.isVisible()) await choose.click();
        await input.waitFor();
        const code = await eventually(async () => {
            const content = await fs.readFile(logPath, 'utf8');
            const marker = `[userPersisto] DEVELOPMENT email code for ${email}: `;
            return content.slice(offset).split('\n').reverse().map(line => {
                const index = line.indexOf(marker);
                return index < 0 ? '' : line.slice(index + marker.length).match(/^(\d{6})(?:\s|$)/)?.[1] || '';
            }).find(Boolean);
        }, Boolean, 'development email delivery for exact disposable account');
        ctx.secrets.add(code);
        await input.fill(code);
        await root.getByRole('button', { name: 'Verify', exact: true }).click();
        return finishLogin(page, context);
    }

    const initial = await privateJson(path.join(config.credentials, 'admin-storage-state.json'));
    const admin = newClient(initial.cookies);
    const adminToken = await admin.request({ path: '/auth/token?agent=explorer' });
    ctx.clients.admin = admin;
    assert.equal(adminToken.status, 200,
        'Administrator session is unavailable or expired. Reuse the already-claimed task-owned administrator: refresh its private 0600 admin-storage-state.json through a normal sign-in (never a new first-run claim) before running the suite.');
    ctx.principals.admin = assertPrincipal(adminToken.json, 'admin');
    const adminProfile = await ctx.request('admin', { path: `${DASHBOARD}/api/profile` });
    assert.equal(adminProfile.status, 200);
    assert.equal(adminProfile.json?.profile?.user?.id, ctx.principals.admin.id);
    assert.deepEqual(adminProfile.json?.profile?.roles, ['admin'], 'Administrator persisted profile must agree with current Router role');
    ctx.progress('Administrator session and exact persisted/current role verified. Creating three disposable public accounts.');

    for (const name of ['selfRegistered', 'userA', 'userB']) {
        const email = `${ctx.prefix}-${name.toLowerCase()}@example.test`;
        const rememberId = await armPrincipalCleanup(ctx, email);
        const context = await browserContext();
        const signed = await login(context, { email, fresh: true });
        const registered = assertPrincipal(signed.token.json, 'selfRegistered');
        assert.equal(registered.email.toLowerCase(), email);
        rememberId(registered.id);
        ctx.clients[name] = signed.client;
        ctx.principals[name] = registered;
        if (name !== 'selfRegistered') {
            const listing = await ctx.request('admin', { path: '/api/agents/explorer/users' });
            assert.equal(listing.status, 200);
            const update = await ctx.request('admin', { method: 'PATCH', path: `/api/agents/explorer/users/${encodeURIComponent(registered.id)}`, body: { roles: ['user'] } });
            assert.equal(update.status, 200, 'Administrator role assignment must succeed');
            assert.equal(update.json?.ok, true);
            const freshContext = await browserContext();
            const refreshed = await login(freshContext, { email });
            ctx.clients[name] = refreshed.client;
            ctx.principals[name] = assertPrincipal(refreshed.token.json, 'user', registered.id);
        }
        await writePrivate(path.join(config.privateRoot, `${name}-cookies.json`), ctx.clients[name].cookies);
    }
    assert.equal(new Set(Object.values(ctx.principals).map(p => p.id)).size, 4, 'Four authenticated principals must be distinct');
    const listing = await ctx.request('admin', { path: `/api/agents/explorer/users?search=${encodeURIComponent(ctx.prefix)}&pageSize=100` });
    assert.equal(listing.status, 200);
    for (const name of ['selfRegistered', 'userA', 'userB']) {
        const p = ctx.principals[name];
        const persisted = listing.json.users.find(user => user.id === p.id);
        assert.ok(persisted, 'Principal must exist in UserPersisto authoritative listing');
        assert.deepEqual(persisted.roles, p.roles);
        const profile = await ctx.request(name, { path: `${DASHBOARD}/api/profile` });
        assert.equal(profile.status, 200);
        assert.ok(profile.json?.ok && profile.json?.profile, 'Signed profile must be readable');
        assert.equal(profile.json.profile.user?.id, p.id, 'UserPersisto profile must match the Router principal');
        assert.deepEqual(profile.json.profile.roles.map(role => typeof role === 'string' ? role : role.name).sort(), [...p.roles].sort(), 'Profile and Router roles must agree');
        assertListingCapability(profile.json.profile, name);
    }
    ctx.report.principals = Object.entries(ctx.principals).map(([name, p]) => ({ name, idHash: ctx.hash(p.id), roles: p.roles, source: name === 'admin' ? 'configured administrator session' : registration.mode === 'password' ? 'fresh public password registration' : 'fresh verified public development email registration', authoritativeRoleVerified: true }));
    await writePrivate(path.join(config.privateRoot, 'principals.json'), ctx.principals);
    ctx.progress('All four authenticated principals are distinct and verified: administrator, selfRegistered, and two ordinary users.');
}
