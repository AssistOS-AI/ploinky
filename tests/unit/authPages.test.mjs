import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderLogoutConfirmationHtml, renderSsoLoginHtml } from '../../cli/server/authHandlers/authPages.js';

test('logout confirmation keeps Cancel separate from the post-logout destination', () => {
    const html = renderLogoutConfirmationHtml({
        agentName: 'explorer',
        returnTo: '/auth/logged-out?next=%2Fexplorer%2Findex.html',
        cancelTo: '/explorer/index.html',
        csrfToken: 'csrf-token',
    });

    assert.match(html, /name="returnTo" value="\/auth\/logged-out\?next=%2Fexplorer%2Findex\.html"/);
    assert.match(html, /<a class="auth-btn secondary" href="\/explorer\/index\.html">Cancel<\/a>/);
});

test('router login sends users to the provider without a password form', () => {
    const html = renderSsoLoginHtml({ agentName: 'app', redirectUrl: '/identity/login', returnTo: '/files' });
    assert.match(html, /href="\/identity\/login"/);
    assert.doesNotMatch(html, /type="password"|action="\/auth\/login"/);
});

test('shared SSO copy is application-neutral even when the authentication context names another app', () => {
    const options = {
        returnTo: '/base-agent-additional-server/bizanso/8787/app/projects',
        redirectUrl: '/identity/login?requestId=fixture&state=fixture-state',
    };
    const neutral = renderSsoLoginHtml(options);
    for (const agentName of ['explorer', 'bizanso', 'another-app', '<b>untrusted-name</b>']) {
        const html = renderSsoLoginHtml({ ...options, agentName });
        assert.equal(html, neutral);
        assert.match(html, /<h1>Continue with Single Sign-On<\/h1>/);
        assert.match(html, /<p>Redirecting you to the identity provider to sign in\.<\/p>/);
        assert.doesNotMatch(html, /You are signing in to|untrusted-name/);
    }
});

test('neutral SSO page preserves the provider redirect and normalized return navigation', () => {
    const returnTo = '/base-agent-additional-server/sample-app/8787/app/projects?view=saved&sort=new';
    const redirectUrl = '/identity/login?requestId=fixture&state=fixture-state';
    const html = renderSsoLoginHtml({ agentName: 'different-auth-context', returnTo, redirectUrl });
    const links = [...html.matchAll(/<a class="auth-btn[^\"]*" href="([^\"]+)">([^<]+)<\/a>/g)]
        .map(([, href, label]) => [label, href.replaceAll('&amp;', '&')]);
    assert.deepEqual(links, [['Continue', redirectUrl], ['Back', returnTo]]);
    const timers = [];
    const redirects = [];
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
        window: { setTimeout: (callback, delay) => timers.push({ callback, delay }),
            location: { replace: url => redirects.push(url) } },
    });
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 120);
    timers[0].callback();
    assert.deepEqual(redirects, [redirectUrl]);
    assert.match(renderSsoLoginHtml({ returnTo: '//outside.example/path' }), /href="\/">Back/);
});

test('sign-in error pages render fixed escaped text and only normalized retry links', async () => {
    const { renderAuthErrorHtml } = await import('../../cli/server/authHandlers/authPages.js');
    const html = renderAuthErrorHtml({
        title: 'Sign-in <b>unavailable</b>',
        detail: 'Detail & "quotes"',
        origin: 'http://pgx:3000"><script>',
        retryReturnTo: '//evil.example/path',
    });
    assert.match(html, /<title>Sign-in &lt;b&gt;unavailable&lt;\/b&gt;<\/title>/);
    assert.match(html, /<h1 id="auth-error-title">Sign-in &lt;b&gt;unavailable&lt;\/b&gt;<\/h1>/);
    assert.match(html, /<div class="auth-error" role="alert">Detail &amp; &quot;quotes&quot;<\/div>/);
    assert.match(html, /Address: http:\/\/pgx:3000&quot;&gt;&lt;script&gt;/);
    assert.match(html, /href="\/auth\/login\?returnTo=%2F">Try again/);
    assert.doesNotMatch(html, /<script>|evil\.example/);
    assert.doesNotMatch(renderAuthErrorHtml({}), /Address:|Try again|<script/);
});

test('sign-in retry encodes the selected agent and prompt as separate query values', async () => {
    const { renderAuthErrorHtml } = await import('../../cli/server/authHandlers/authPages.js');
    const retryAgent = 'secondary&state=injected';
    const retryPrompt = 'login"><script>alert(1)</script>&agent=other';
    const html = renderAuthErrorHtml({
        retryReturnTo: '//evil.example/path',
        retryAgent,
        retryPrompt,
    });
    const href = html.match(/href="([^"]+)">Try again/)[1].replaceAll('&amp;', '&');
    const retry = new URL(href, 'http://localhost');
    assert.equal(retry.origin, 'http://localhost');
    assert.equal(retry.pathname, '/auth/login');
    assert.deepEqual(Object.fromEntries(retry.searchParams), {
        returnTo: '/',
        agent: retryAgent,
        prompt: retryPrompt,
    });
    assert.doesNotMatch(html, /<script>|evil\.example/);
    assert.doesNotMatch(renderAuthErrorHtml({ retryAgent, retryPrompt }), /Try again/);
});
