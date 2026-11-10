import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { buildLogoutConfirmationUrl } from '../../cli/server/webchat/domSetup.js';
import { renderLogoutConfirmationHtml } from '../../cli/server/authHandlers/authPages.js';

const current = 'http://localhost:8080/webchat/?agent=sample-agent&workspace-dir=My%20project&robot=default#conversation';

test('WebChat sign-out keeps the exact conversation as Cancel destination and the route selector', () => {
    const url = new URL(buildLogoutConfirmationUrl(current, '/webchat/logout?agent=sample-agent', { authRouteKey: 'sample-agent' }), current);
    assert.equal(url.pathname, '/auth/logout');
    assert.equal(url.searchParams.get('agent'), 'sample-agent');
    assert.equal(url.searchParams.get('returnTo'), '/auth/logged-out');
    assert.equal(url.searchParams.get('cancelTo'), '/webchat/?agent=sample-agent&workspace-dir=My%20project&robot=default#conversation');
    const html = renderLogoutConfirmationHtml({ agentName: 'sample-agent', returnTo: url.searchParams.get('returnTo'), cancelTo: url.searchParams.get('cancelTo') });
    assert.match(html, /href="\/webchat\/\?agent=sample-agent&amp;workspace-dir=My%20project&amp;robot=default#conversation">Cancel/);
    const action = new URL(html.match(/<form method="post" action="([^"]+)"/)[1].replaceAll('&amp;', '&'), current);
    assert.equal(action.searchParams.get('agent'), 'sample-agent');
    assert.equal(action.searchParams.get('returnTo'), '/auth/logged-out');
});

test('host-bound WebChat logout does not invent an agent selector', () => {
    const url = new URL(buildLogoutConfirmationUrl('https://chat.example/webchat/?workspace-dir=a', '/webchat/logout'), 'https://chat.example');
    assert.equal(url.searchParams.has('agent'), false);
    assert.equal(url.searchParams.get('cancelTo'), '/webchat/?workspace-dir=a');
});

test('host-bound WebChat keeps the target agent only in the Cancel destination', () => {
    const conversation = 'https://explorer.example/webchat?agent=research-agent&workspace-dir=caf%C3%A9%2Fnotes#conversation';
    const url = new URL(buildLogoutConfirmationUrl(conversation, '/webchat/logout?agent=research-agent', { authRouteKey: '' }), conversation);
    assert.equal(url.searchParams.has('agent'), false);
    assert.equal(url.searchParams.get('cancelTo'), new URL(conversation).pathname + new URL(conversation).search + '#conversation');
});

test('control WebChat uses the verified authentication owner rather than its conversation target', () => {
    const url = new URL(buildLogoutConfirmationUrl(current, '/webchat/logout?agent=target-agent', { authRouteKey: 'application-owner' }), current);
    assert.equal(url.searchParams.get('agent'), 'application-owner');
});

test('clicking Logout only navigates to confirmation, without posting logout or stopping the chat', async () => {
    const source = await fs.readFile(new URL('../../cli/server/webchat/index.js', import.meta.url), 'utf8');
    const handler = source.slice(source.indexOf('function handleLogout() {'), source.indexOf('\nif (logoutBtn) {', source.indexOf('function handleLogout() {')));
    const location = { href: current };
    vm.runInNewContext(`${handler}\nhandleLogout();`, {
        logoutBtn: {}, authRouteKey: 'application-owner', window: { location }, buildLogoutConfirmationUrl,
        toEndpoint: (name) => `/webchat/${name}?agent=sample-agent`,
        fetch: () => assert.fail('Logout must not be posted before confirmation'),
        network: { stop: () => assert.fail('Opening confirmation must not stop the chat') },
    });
    assert.equal(new URL(location.href, current).pathname, '/auth/logout');
    assert.equal(new URL(location.href, current).searchParams.get('agent'), 'application-owner');
});
