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
