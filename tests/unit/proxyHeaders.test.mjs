import test from 'node:test';
import assert from 'node:assert/strict';

import { stripRouterIdentityHeaders } from '../../cli/server/routerHandlers.js';
import { isRouterCookie, sanitizeRequestHeaders } from '../../cli/server/proxy/sanitizeRequestHeaders.js';
import { sanitizeResponseHeaders } from '../../cli/server/proxy/sanitizeResponseHeaders.js';

const plan = {
    port: 7000,
    scheme: 'http',
    authority: 'router.example',
    forwardedPrefix: '/base-agent-additional-server/alpha/7000',
    credentialPolicy: {
        allowApplicationAuthorization: true,
        allowApplicationCookies: true,
    },
    responsePolicy: {
        allowApplicationCookies: true,
        corsOrigin: 'https://app.example',
    },
};

test('request headers preserve permitted app credentials but remove Router provenance', () => {
    const headers = sanitizeRequestHeaders({
        host: 'attacker.example',
        authorization: 'Bearer app-token',
        cookie: 'theme=dark; ploinky_sso=router; ploinky_csrf=secret; ploinky_guest_ncGyyzpdIxmPjORN_wQfqv=guest; ploinky_guest=legacy; app=ok',
        forwarded: 'for=attacker',
        'x-forwarded-host': 'attacker.example',
        'x-ploinky-machine-assertion': 'spoof',
        'x-ploinky-agent-startup-probe': '1',
        connection: 'keep-alive, x-remove-me',
        'x-remove-me': 'yes',
    }, plan, { authInfo: 'trusted-router-auth' });
    assert.equal(headers.authorization, 'Bearer app-token');
    assert.equal(headers.cookie, 'theme=dark; app=ok');
    assert.equal(headers.host, '127.0.0.1:7000');
    assert.equal(headers['x-forwarded-host'], 'router.example');
    assert.equal(headers['x-forwarded-prefix'], plan.forwardedPrefix);
    assert.equal(headers['x-ploinky-auth-info'], 'trusted-router-auth');
    assert.equal(headers['x-ploinky-machine-assertion'], undefined);
    assert.equal(headers['x-ploinky-agent-startup-probe'], undefined);
    assert.equal(headers['x-remove-me'], undefined);
});

test('request and response sanitizing removes every guest session cookie name', () => {
    const headers = sanitizeRequestHeaders({
        cookie: 'theme=dark; ploinky_guest_ncGyyzpdIxmPjORN_wQfqv=a; ploinky_guest=b; __Host-ploinky_guest_x=c; app=ok',
    }, plan, {});
    assert.equal(headers.cookie, 'theme=dark; app=ok');
    const guestOnly = sanitizeRequestHeaders({
        cookie: 'ploinky_guest_iw2P_FBNZBzQ_b5bTDMOLe=a; ploinky_guest=b',
    }, plan, {});
    assert.equal(guestOnly.cookie, undefined);
    const response = sanitizeResponseHeaders({
        'set-cookie': [
            'app=ok; Path=/',
            'ploinky_guest_iw2P_FBNZBzQ_b5bTDMOLe=x; Path=/',
            'ploinky_guest=y; Path=/',
            '__Host-ploinky_guest_ncGyyzpdIxmPjORN_wQfqv=z; Path=/; Secure',
        ],
    }, plan);
    assert.deepEqual(response['set-cookie'], ['app=ok; Path=/']);
    for (const name of ['ploinky_guest', 'ploinky_guest_ncGyyzpdIxmPjORN_wQfqv', '__Host-ploinky_guest_ab', 'ploinky_guestanything']) {
        assert.equal(isRouterCookie(name), true, name);
    }
    for (const name of ['app', 'ploinky', 'xploinky_guest', 'guest']) {
        assert.equal(isRouterCookie(name), false, name);
    }
});

test('ordinary agent-root forwarding strips the reserved startup probe header', () => {
    const headers = stripRouterIdentityHeaders({
        accept: 'text/html',
        cookie: 'app=ok',
        authorization: 'Bearer application-token',
        'x-ploinky-agent-startup-probe': '1',
        'X-Ploinky-Agent-Startup-Probe': '1',
    });
    assert.equal(headers.accept, 'text/html');
    assert.equal(headers.cookie, 'app=ok');
    assert.equal(headers.authorization, 'Bearer application-token');
    assert.equal(headers['x-ploinky-agent-startup-probe'], undefined);
    assert.equal(headers['X-Ploinky-Agent-Startup-Probe'], undefined);
});

test('response headers suppress private topology, Router cookies, unsolicited CORS, and caching', () => {
    const headers = sanitizeResponseHeaders({
        location: 'http://127.0.0.1:7000/private',
        'set-cookie': ['app=ok; Path=/', 'ploinky_jwt=bad; Path=/', 'ploinky_guest_iw2P_FBNZBzQ_b5bTDMOLe=x; Path=/', 'ploinky_guest=y; Path=/'],
        'access-control-allow-origin': '*',
        'x-ploinky-machine-assertion': 'must-not-escape',
        connection: 'keep-alive',
        server: 'application',
    }, plan);
    assert.equal(headers.location, undefined);
    assert.deepEqual(headers['set-cookie'], ['app=ok; Path=/']);
    assert.equal(headers['access-control-allow-origin'], 'https://app.example');
    assert.equal(headers.connection, undefined);
    assert.equal(headers['x-ploinky-machine-assertion'], undefined);
    assert.equal(headers['cache-control'], 'no-store');
});

test('response redirects cannot disclose container, link-local, loopback, or private IPv6 origins', () => {
    for (const location of [
        'http://ploinky-alpha:7000/private',
        'http://127.9.8.7:7000/private',
        'http://169.254.2.1/private',
        'http://[::1]:7000/private',
        'http://[fd00::1]:7000/private',
        'http://agent.local/private',
    ]) {
        assert.equal(sanitizeResponseHeaders({ location }, plan).location, undefined, location);
    }
});
