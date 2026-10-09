import '../helpers/isolatedWorkspaceRoot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { authService } from '../../cli/server/authHandlers/shared.js';
import { createBrowserSessionLease, validateBrowserSessionLease } from '../../cli/server/webtty/authLease.mjs';

function fixture() {
    const session = { user: { id: 'fixture-admin', roles: ['admin'] }, expiresAt: Date.now() + 60_000 };
    const lease = createBrowserSessionLease({ authMode: 'sso', sessionId: 'fixture-login', user: session.user });
    return { lease, session };
}

test('an SSO terminal lease cannot fall back to cached identity without provider validation', async (t) => {
    const { lease, session } = fixture();
    const validation = authService.validateSession;
    authService.validateSession = undefined;
    t.after(() => { authService.validateSession = validation; });
    t.mock.method(authService, 'getSession', () => session);
    assert.deepEqual(await validateBrowserSessionLease(lease), { ok: false, reason: 'validation_unavailable' });
    assert.equal(authService.getSession.mock.callCount(), 0);
});

test('an SSO terminal lease uses the current provider identity for continued administrator authority', async (t) => {
    const { lease, session } = fixture();
    let current = session;
    t.mock.method(authService, 'validateSession', async () => current);
    assert.equal((await validateBrowserSessionLease(lease)).ok, true);
    current = { ...session, user: { ...session.user, roles: ['user'] } };
    assert.deepEqual(await validateBrowserSessionLease(lease), { ok: false, reason: 'administrator_revoked' });
    current = null;
    assert.deepEqual(await validateBrowserSessionLease(lease), { ok: false, reason: 'missing_or_expired' });
    assert.equal(authService.validateSession.mock.callCount(), 3);
});
