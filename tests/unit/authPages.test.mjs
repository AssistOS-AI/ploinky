import test from 'node:test';
import assert from 'node:assert/strict';
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
