// Loopback login-origin and disposable-registration selection (A7 setup fix).
// UserPersisto restarts login on its canonical loopback origin; the suite treats
// http://127.0.0.1:8080 and http://localhost:8080 as the one selected target and
// blocks every other origin. Registration uses the deployment's advertised
// password sign-up or email-code path and fails closed otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET, assertLoopbackPage, browserRequestDecision, isLoopbackTargetOrigin, validateTarget } from './core.mjs';
import { preferHostCookies, selectRegistrationMethod } from './principals.mjs';

test('both loopback names of the selected Router are the same browser target', () => {
    for (const url of ['http://127.0.0.1:8080/auth/login?agent=explorer', 'http://localhost:8080/base-agent-additional-server/userPersistoAgent/7000/service/auth/', 'http://localhost:8080/explorer/index.html']) {
        assert.equal(browserRequestDecision(url), 'continue', url);
    }
    assert.ok(isLoopbackTargetOrigin(TARGET) && isLoopbackTargetOrigin('http://localhost:8080'));
});

test('negative control: every non-loopback or other-port origin is still aborted', () => {
    for (const url of ['https://accounts.google.com/o/oauth2/v2/auth', 'http://localhost:8081/', 'http://127.0.0.1:8081/', 'http://127.0.0.2:8080/', 'http://[::1]:8080/', 'https://localhost:8080/', 'http://localhost:8080.evil.test/', 'http://evil.test/?u=http://localhost:8080', 'data:text/html,x', 'not a url']) {
        assert.equal(browserRequestDecision(url), 'abort', url);
    }
});

test('negative control: a login redirect that lands on a non-loopback host fails setup', () => {
    assert.doesNotThrow(() => assertLoopbackPage('http://localhost:8080/auth/login?agent=explorer', 'Login navigation'));
    for (const landed of ['https://accounts.google.com/signin', 'http://localhost:9000/auth/login', 'about:blank']) {
        assert.throws(() => assertLoopbackPage(landed, 'Login navigation'), /left the loopback target/, landed);
    }
});

test('the suite target itself stays exact: localhost is a browser alias, not a selectable target', () => {
    assert.equal(validateTarget(TARGET).origin, TARGET);
    assert.throws(() => validateTarget('http://localhost:8080'));
});

const setup = (overrides = {}) => ({ ok: true, setupComplete: true, signup: { email: true, verification: 'none', google: true },
    methods: { password: true, emailCode: false, passkey: true, totp: true, google: true }, passwordPolicy: { minLength: 12, maxLength: 128 }, ...overrides });

test('registration uses password sign-up when open sign-up needs no verification, email code when delivery exists', () => {
    assert.deepEqual(selectRegistrationMethod(setup()), { mode: 'password', length: 32 });
    assert.deepEqual(selectRegistrationMethod(setup({ signup: { email: true, verification: 'required' }, methods: { password: true, emailCode: true } })), { mode: 'email-code' });
});

test('negative control: registration fails closed when neither path is available or bootstrap is open', () => {
    const cases = [
        [null, /REGISTRATION_SETUP_UNAVAILABLE/],
        [{ ok: false }, /REGISTRATION_SETUP_UNAVAILABLE/],
        [setup({ setupComplete: false }), /REGISTRATION_BOOTSTRAP_OPEN/],
        [setup({ signup: { email: false, verification: 'none' } }), /REGISTRATION_UNAVAILABLE/],
        [setup({ methods: { password: false, emailCode: false } }), /REGISTRATION_UNAVAILABLE/],
        [setup({ signup: { email: true, verification: 'required' }, methods: { password: true, emailCode: false } }), /REGISTRATION_UNAVAILABLE/],
        [setup({ passwordPolicy: { minLength: 200, maxLength: 256 } }), /REGISTRATION_PASSWORD_POLICY/],
    ];
    for (const [value, pattern] of cases) assert.throws(() => selectRegistrationMethod(value), pattern, JSON.stringify(value));
});

test('duplicate cookies across loopback names resolve to the host where sign-in completed', () => {
    const cookies = [
        { name: 'ploinky_sid', value: 'stale', domain: '127.0.0.1', path: '/' },
        { name: 'ploinky_sid', value: 'fresh', domain: 'localhost', path: '/' },
        { name: 'other', value: 'x', domain: '127.0.0.1', path: '/' },
    ];
    const chosen = preferHostCookies(cookies, 'localhost');
    assert.deepEqual(chosen.map(c => `${c.name}=${c.value}`).sort(), ['other=x', 'ploinky_sid=fresh']);
    assert.deepEqual(preferHostCookies(cookies, '127.0.0.1').map(c => `${c.name}=${c.value}`).sort(), ['other=x', 'ploinky_sid=stale']);
});
