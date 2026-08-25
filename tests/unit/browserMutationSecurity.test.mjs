import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PLOINKY_MASTER_KEY ||= 'a'.repeat(64);

const {
    BROWSER_CSRF_COOKIE_NAME,
    BROWSER_CSRF_HEADER,
    canonicalBrowserMutationOrigin,
    mintBrowserCsrfToken,
    verifyBrowserMutationRequest,
} = await import('../../cli/server/browserMutationSecurity.js');

function publicPlan({ generation = 'edge-generation-a', routeKey = 'example' } = {}) {
    const snapshot = { generation };
    return {
        forwarding: { protocol: 'https', authority: 'app.example.test' },
        hostSelection: { kind: 'agent-root', record: { routeKey } },
        snapshot,
        lease: { id: generation, snapshot, commit: () => true },
    };
}

function request(headers = {}) {
    return {
        headers: { host: 'app.example.test', ...headers },
        socket: { encrypted: false },
    };
}

test('browser mutation proof binds session, exact routed origin, and selected host', () => {
    const routePlan = publicPlan();
    const authContext = { routeKey: 'identity-owner', boundHostRouteKey: 'example' };
    const req = request({ origin: 'https://app.example.test' });
    const token = mintBrowserCsrfToken({
        req,
        routePlan,
        authContext,
        sessionId: 'session-a',
    });

    req.headers[BROWSER_CSRF_HEADER] = token;
    assert.deepEqual(
        verifyBrowserMutationRequest(req, { routePlan, authContext, sessionId: 'session-a' }),
        {
            ok: true,
            origin: 'https://app.example.test',
            generation: 'edge-generation-a',
            hostRouteKey: 'example',
            routeKey: 'identity-owner',
        },
    );

    assert.equal(
        verifyBrowserMutationRequest(req, {
            routePlan: publicPlan({ generation: 'edge-generation-b' }),
            authContext,
            sessionId: 'session-a',
        }).ok,
        true,
    );
    assert.equal(
        verifyBrowserMutationRequest(req, {
            routePlan,
            authContext: { ...authContext, routeKey: 'other-service' },
            sessionId: 'session-a',
        }).ok,
        true,
    );
    assert.equal(
        verifyBrowserMutationRequest(req, {
            routePlan,
            authContext: { ...authContext, boundHostRouteKey: 'other' },
            sessionId: 'session-a',
        }).code,
        'BROWSER_CSRF_INVALID',
    );
    assert.equal(
        verifyBrowserMutationRequest(req, { routePlan, authContext, sessionId: 'session-b' }).code,
        'BROWSER_CSRF_INVALID',
    );
});

test('service mutation proof stays bound to the public host while route authorization remains separate', () => {
    const routePlan = publicPlan({ routeKey: 'explorer' });
    const serviceContext = {
        routeKey: 'explorer',
        boundHostRouteKey: 'explorer',
        serviceRouteKey: 'dpuAgent',
    };
    const req = request({ origin: 'https://app.example.test' });
    const token = mintBrowserCsrfToken({
        req,
        routePlan,
        authContext: serviceContext,
        sessionId: 'session-a',
    });
    req.headers[BROWSER_CSRF_HEADER] = token;

    assert.deepEqual(
        verifyBrowserMutationRequest(req, {
            routePlan,
            authContext: serviceContext,
            sessionId: 'session-a',
        }),
        {
            ok: true,
            origin: 'https://app.example.test',
            generation: 'edge-generation-a',
            hostRouteKey: 'explorer',
            routeKey: 'dpuAgent',
        },
    );
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan,
        authContext: { ...serviceContext, serviceRouteKey: 'onlyOffice' },
        sessionId: 'session-a',
    }).ok, true);
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan: publicPlan({ routeKey: 'other-root' }),
        authContext: {
            ...serviceContext,
            boundHostRouteKey: 'other-root',
        },
        sessionId: 'session-a',
    }).code, 'BROWSER_CSRF_INVALID');
});

test('named router surfaces share the host CSRF proof and retain separate authorization', () => {
    const routePlan = publicPlan({ routeKey: 'explorer' });
    const rootContext = {
        routeKey: 'explorer',
        boundHostRouteKey: 'explorer',
    };
    const userAdminContext = {
        ...rootContext,
        mutationRouteKey: 'user-admin:explorer',
    };
    const req = request({ origin: 'https://app.example.test' });
    req.headers[BROWSER_CSRF_HEADER] = mintBrowserCsrfToken({
        req,
        routePlan,
        authContext: rootContext,
        sessionId: 'session-a',
    });

    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan,
        authContext: userAdminContext,
        sessionId: 'session-a',
    }).ok, true);
});

test('browser mutation proof survives local JWT refresh for the same signed session id', () => {
    const routePlan = publicPlan();
    const authContext = { routeKey: 'identity-owner', boundHostRouteKey: 'example' };
    const req = request({ origin: 'https://app.example.test' });
    req.session = { _jwtPayload: { sid: 'sess-stable' } };
    const token = mintBrowserCsrfToken({
        req,
        routePlan,
        authContext,
        sessionId: 'jwt-before-refresh',
    });

    req.headers[BROWSER_CSRF_HEADER] = token;
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan,
        authContext,
        sessionId: 'jwt-after-refresh',
    }).ok, true);
    req.session._jwtPayload.sid = 'sess-other';
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan,
        authContext,
        sessionId: 'jwt-after-refresh',
    }).code, 'BROWSER_CSRF_INVALID');
});

test('browser mutation proof requires exact Origin and accepts the HttpOnly proof cookie', () => {
    const routePlan = publicPlan();
    const authContext = { boundHostRouteKey: 'example', routeKey: 'identity-owner' };
    const mintReq = request();
    const token = mintBrowserCsrfToken({
        req: mintReq,
        routePlan,
        authContext,
        sessionId: 'session-a',
    });
    const req = request({
        origin: 'https://app.example.test',
        cookie: `${BROWSER_CSRF_COOKIE_NAME}=${token}`,
    });
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan,
        authContext,
        sessionId: 'session-a',
    }).ok, true);

    delete req.headers.origin;
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan,
        authContext,
        sessionId: 'session-a',
    }).code, 'BROWSER_ORIGIN_REQUIRED');
    req.headers.origin = 'https://app.example.test.evil.invalid';
    assert.equal(verifyBrowserMutationRequest(req, {
        routePlan,
        authContext,
        sessionId: 'session-a',
    }).code, 'BROWSER_ORIGIN_REQUIRED');
});

test('control origin rejects forwarding provenance and public origin ignores spoofed forwarding headers', () => {
    const publicReq = request({
        forwarded: 'host=evil.invalid',
        'x-forwarded-host': 'evil.invalid',
        'x-forwarded-proto': 'http',
    });
    assert.equal(canonicalBrowserMutationOrigin(publicReq, publicPlan()), 'https://app.example.test');

    const controlReq = {
        headers: { host: 'localhost:8080', 'x-forwarded-host': 'evil.invalid' },
        socket: { encrypted: false },
    };
    assert.equal(canonicalBrowserMutationOrigin(controlReq, {
        lease: { id: 'generation', snapshot: { generation: 'generation' } },
    }), null);
});
