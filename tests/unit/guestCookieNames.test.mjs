import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';

import {
    GUEST_AUTH_COOKIE_PREFIX,
    LEGACY_GUEST_AUTH_COOKIE_NAME,
    guestCookieNameForAuthContext,
    guestCookieNameForRouteKey,
    isGuestCookieName,
} from '../../cli/server/auth/guestCookieNames.js';
import { assertMutationAllowed } from '../../cli/server/proxy/executeHttpPlan.js';

const NAME_FORMAT = /^ploinky_guest_[A-Za-z0-9_-]{22}$/;

// Literal expectations, computed independently of the helper.
const EXPECTED = {
    webAssist: 'ploinky_guest_ncGyyzpdIxmPjORN_wQfqv',
    webmeetAgent: 'ploinky_guest_iw2P_FBNZBzQ_b5bTDMOLe',
    guestAgent: 'ploinky_guest_9uDQkcoSXlH7uEQX0PsqsP',
};

test('guest cookie names are the pinned per-route names', () => {
    for (const [routeKey, name] of Object.entries(EXPECTED)) {
        assert.equal(guestCookieNameForRouteKey(routeKey), name, routeKey);
        assert.equal(guestCookieNameForRouteKey(` ${routeKey}\t`), name, `${routeKey} trimmed`);
        assert.equal(guestCookieNameForRouteKey(routeKey), guestCookieNameForRouteKey(routeKey), `${routeKey} deterministic`);
    }
    assert.equal(LEGACY_GUEST_AUTH_COOKIE_NAME, 'ploinky_guest'); // legacy-guest-cookie-case
    assert.equal(GUEST_AUTH_COOKIE_PREFIX, 'ploinky_guest_');
});

test('the name is a domain-separated sha256 base64url prefix of the route key', () => {
    for (const routeKey of ['webAssist', 'a', 'x.y-z']) {
        const independent = `ploinky_guest_${createHash('sha256')
            .update(`ploinky-guest-cookie\0v1\0${routeKey}`)
            .digest('base64url')
            .slice(0, 22)}`;
        assert.equal(guestCookieNameForRouteKey(routeKey), independent, routeKey);
        const undomained = `ploinky_guest_${createHash('sha256').update(routeKey).digest('base64url').slice(0, 22)}`;
        assert.notEqual(guestCookieNameForRouteKey(routeKey), undomained, routeKey);
    }
});

test('every name is 36 cookie-token characters, including long, Unicode and path-like keys', () => {
    for (const routeKey of [
        'webAssist',
        'r'.repeat(1000),
        'k'.repeat(10_000),
        'ルート/../x',
        'route.with-dots_and-dashes',
        'a;b=c, d',
    ]) {
        const name = guestCookieNameForRouteKey(routeKey);
        assert.equal(name.length, 36, routeKey.slice(0, 20));
        assert.match(name, NAME_FORMAT, routeKey.slice(0, 20));
    }
});

test('an empty route key throws GUEST_COOKIE_ROUTE_REQUIRED', () => {
    for (const routeKey of ['', ' ', '\t\n', null, undefined]) {
        assert.throws(
            () => guestCookieNameForRouteKey(routeKey),
            (error) => error?.code === 'GUEST_COOKIE_ROUTE_REQUIRED',
            String(routeKey),
        );
    }
    for (const context of [null, undefined, {}, { policy: {} }, { routeKey: '' }, { policy: { routeKey: ' ' }, routeKey: null }]) {
        assert.throws(
            () => guestCookieNameForAuthContext(context),
            (error) => error?.code === 'GUEST_COOKIE_ROUTE_REQUIRED',
            JSON.stringify(context),
        );
    }
});

test('the auth-context name follows the policy route key first, then the context route key', () => {
    assert.equal(guestCookieNameForAuthContext({ routeKey: 'webAssist', policy: { mode: 'guest' } }), EXPECTED.webAssist);
    assert.equal(
        guestCookieNameForAuthContext({ routeKey: 'webAssist', policy: { mode: 'guest', routeKey: 'webAssist' } }),
        EXPECTED.webAssist,
    );
    assert.equal(
        guestCookieNameForAuthContext({ routeKey: 'explorer', policy: { mode: 'guest', routeKey: 'guestAgent' } }),
        EXPECTED.guestAgent,
    );
});

test('different route keys give different names', () => {
    const names = new Set(['webAssist', 'webassist', 'webmeetAgent', 'guestAgent', 'ghost', 'a', 'b'].map(guestCookieNameForRouteKey));
    assert.equal(names.size, 7);
});

test('guest cookie recognition covers the legacy and every derived name only', () => {
    for (const name of ['ploinky_guest', ...Object.values(EXPECTED), 'ploinky_guest_x', 'ploinky_guestx']) { // legacy-guest-cookie-case
        assert.equal(isGuestCookieName(name), true, name);
    }
    for (const name of ['', null, undefined, 'ploinky_sso', 'ploinky_jwt', 'guest', 'xploinky_guest', 'ploinky_gues']) { // legacy-guest-cookie-case
        assert.equal(isGuestCookieName(name), false, String(name));
    }
});

test('header budget: six room-scoped guest cookies plus Router cookies stay under Node maxHeaderSize', () => {
    // A minted room-scoped guest JWT with a 128-character roomId measured 813
    // bytes; 1,024 bytes leaves headroom for claim growth.
    const syntheticJwt = (seed) => `eyJ${seed.repeat(1024)}`.slice(0, 1024);
    const routeKeys = ['webAssist', 'webmeetAgent', 'guestAgent', 'userPersistoAgent', 'umamiAgent', 'soul-gateway'];
    const parts = routeKeys.map((routeKey, index) => `${guestCookieNameForRouteKey(routeKey)}=${syntheticJwt(String(index))}`);
    parts.push(`ploinky_sso=${'s'.repeat(512)}`);
    parts.push(`ploinky_browser_csrf=${'c'.repeat(256)}`);
    parts.push(`webchat_sid=${'w'.repeat(64)}`);
    const headerLine = `Cookie: ${parts.join('; ')}\r\n`;
    assert.equal(http.maxHeaderSize, 16_384);
    assert.ok(Buffer.byteLength(headerLine) < 16_384, `cookie header ${Buffer.byteLength(headerLine)} bytes`);
    assert.ok(Buffer.byteLength(headerLine) < 16_384 - 4096, 'leaves room for the remaining request headers');
});

test('the dormant mutation matcher treats a guest-only jar as carrying Router cookies', () => {
    const plan = { method: 'POST', origin: 'https://app.example' };
    for (const cookie of [
        `${EXPECTED.webAssist}=token`,
        'ploinky_guest=token', // legacy-guest-cookie-case
        `theme=dark; ${EXPECTED.webmeetAgent}=token`,
    ]) {
        assert.throws(
            () => assertMutationAllowed({ method: 'POST', headers: { cookie, origin: 'https://evil.example' } }, plan),
            (error) => error?.code === 'ORIGIN_REJECTED',
            cookie,
        );
    }
    assert.equal(assertMutationAllowed({ method: 'POST', headers: { cookie: 'theme=dark' } }, plan), true);
});

test('the authorization harness pins the Router guest cookie names of its reviewed guest routes', async () => {
    const { GUEST_COOKIE_NAMES } = await import('../security/authorization/guest-agent-policy.mjs');
    assert.deepEqual(Object.keys(GUEST_COOKIE_NAMES).sort(), ['webAssist', 'webmeetAgent']);
    for (const [routeKey, name] of Object.entries(GUEST_COOKIE_NAMES)) {
        assert.equal(name, guestCookieNameForRouteKey(routeKey), routeKey);
        assert.equal(name, EXPECTED[routeKey], routeKey);
    }
});
