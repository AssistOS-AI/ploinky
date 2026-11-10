import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderLoggedOutHtml, renderLogoutConfirmationHtml } from '../../cli/server/authHandlers/authPages.js';

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


test('repeated logout keeps the application return path for sign-in without relying on a POST body', () => {
    for (const includeAgentSelector of [true, false]) {
        for (const target of ['/', '/base-agent-additional-server/sample-app/8787/']) {
            const html = renderLogoutConfirmationHtml({ agentName: 'application-owner', returnTo: target, includeAgentSelector });
            const action = html.match(/<form method="post" action="([^"]+)"/)[1].replaceAll('&amp;', '&');
            const request = new URL(action, 'https://app.example');
            assert.equal(request.pathname, '/auth/logout');
            assert.equal(request.searchParams.get('returnTo'), target);
            assert.equal(request.searchParams.get('agent'), includeAgentSelector ? 'application-owner' : null);
            // The no-session branch uses only the query, as on a duplicate submission.
            const signedOut = renderLoggedOutHtml(request.searchParams.get('returnTo'));
            const href = signedOut.match(/href="([^"]+)">Sign in/)[1].replaceAll('&amp;', '&');
            assert.equal(new URL(href, request).searchParams.get('returnTo'), target);
        }
    }
});

test('logout action normalizes external return destinations', () => {
    const html = renderLogoutConfirmationHtml({ returnTo: '//external.example/path' });
    const action = html.match(/<form method="post" action="([^"]+)"/)[1].replaceAll('&amp;', '&');
    assert.equal(new URL(action, 'https://app.example').searchParams.get('returnTo'), '/');
});
