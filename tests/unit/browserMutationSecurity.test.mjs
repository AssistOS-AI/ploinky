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

test('browser mutation proof binds session, exact routed origin, route selector, and generation', () => {
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
            routeKey: 'example',
        },
    );

    assert.equal(
        verifyBrowserMutationRequest(req, {
            routePlan: publicPlan({ generation: 'edge-generation-b' }),
            authContext,
            sessionId: 'session-a',
        }).code,
        'BROWSER_CSRF_INVALID',
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
