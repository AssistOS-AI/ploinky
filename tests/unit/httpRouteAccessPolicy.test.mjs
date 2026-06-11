import test from 'node:test';
import assert from 'node:assert/strict';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { HttpRouteAccessPolicy } = await import(`../../cli/server/policy/HttpRouteAccessPolicy.js${moduleSuffix}`);

function repo(entries) {
    return {
        listHttpRoutes() {
            return { corrupt: false, entries: entries.map((entry) => ({ ...entry })) };
        },
    };
}

function policy(entries, options = {}) {
    return new HttpRouteAccessPolicy({
        repository: repo(entries),
        manifestRouteProvider: () => options.manifestRoutes || [],
        httpServiceProvider: () => options.httpServices || [],
        routeDefaultProvider: options.routeDefaultProvider || (() => ({ access: 'authenticated', routeKey: '', source: 'routeDefault' })),
    });
}

test('evaluates persisted public, guest, and authenticated entries', () => {
    const subject = policy([
        { path: '/explorer/public/*', access: 'public', enabled: true },
        { path: '/explorer/work/*', access: 'guest', enabled: true },
        { path: '/explorer/account/*', access: 'authenticated', enabled: true },
    ]);

    assert.equal(subject.evaluate({ pathname: '/explorer/public/readme', method: 'GET' }).access, 'public');
    assert.equal(subject.evaluate({ pathname: '/explorer/work/save', method: 'POST' }).access, 'guest');
    assert.equal(subject.evaluate({ pathname: '/explorer/account/settings', method: 'POST' }).access, 'authenticated');
});

test('public match denies writes instead of falling through', () => {
    const subject = policy([{ path: '/explorer/public/*', access: 'public', enabled: true }]);
    assert.deepEqual(subject.evaluate({ pathname: '/explorer/public/save', method: 'POST' }), {
        access: 'deny',
        status: 403,
        code: 'PUBLIC_ROUTE_WRITE_DENIED',
        routeKey: 'explorer',
        source: 'policy',
    });
});

test('more restrictive overlapping route access wins', () => {
    const subject = policy([
        { path: '/explorer/*', access: 'public', enabled: true },
        { path: '/explorer/work/*', access: 'guest', enabled: true },
        { path: '/explorer/work/admin/*', access: 'authenticated', enabled: true },
    ]);

    assert.equal(subject.evaluate({ pathname: '/explorer/readme', method: 'GET' }).access, 'public');
    assert.equal(subject.evaluate({ pathname: '/explorer/work/doc', method: 'GET' }).access, 'guest');
    assert.equal(subject.evaluate({ pathname: '/explorer/work/admin/doc', method: 'GET' }).access, 'authenticated');
});

test('manifest, service, and route default decisions flow through one evaluator', () => {
    const subject = policy([], {
        manifestRoutes: [{ path: '/explorer/share/*', access: 'guest', routeKey: 'explorer', source: 'manifest' }],
        httpServices: [{ externalPrefix: '/services/editor/', access: 'authenticated', routeKey: 'editor', source: 'httpService' }],
        routeDefaultProvider: ({ routeKey }) => routeKey === 'publicAgent'
            ? { access: 'public', routeKey, source: 'routeDefault' }
            : { access: 'none' },
    });

    assert.equal(subject.evaluate({ pathname: '/explorer/share/doc', method: 'POST' }).source, 'manifest');
    assert.equal(subject.evaluate({ pathname: '/services/editor/open', method: 'POST' }).source, 'httpService');
    assert.equal(subject.evaluate({ pathname: '/publicAgent/readme', method: 'GET' }).source, 'routeDefault');
});

test('unroutable request paths produce deny, never none and never the route default', () => {
    const subject = policy([{ path: '/explorer/*', access: 'public', enabled: true }]);
    for (const pathname of ['/explorer/a//b', '/explorer/%2Fb', '/explorer/file*.txt', '/explorer/a\\b', '/explorer/%5F%5Fagent/x']) {
        const decision = subject.evaluate({ pathname, method: 'GET' });
        assert.equal(decision.access, 'deny', pathname);
        assert.equal(decision.code, 'UNROUTABLE_PATH', pathname);
        assert.equal(decision.status, 404, pathname);
    }
});

test('evaluate fails closed when providers were never bound', () => {
    const subject = new HttpRouteAccessPolicy({ repository: repo([]) });
    const decision = subject.evaluate({ pathname: '/explorer/readme', method: 'GET' });
    assert.equal(decision.access, 'deny');
    assert.equal(decision.code, 'POLICY_PROVIDERS_UNBOUND');
    assert.equal(decision.status, 503);
});

test('http-service decisions carry the service guestScope for the guest executor', () => {
    const subject = policy([], {
        httpServices: [{
            externalPrefix: '/public-services/meeting-room/',
            access: 'guest',
            routeKey: 'guestAgent',
            source: 'httpService',
            guestScope: 'meeting-room-public-service',
        }],
    });
    const decision = subject.evaluate({ pathname: '/public-services/meeting-room/join', method: 'POST' });
    assert.equal(decision.access, 'guest');
    assert.equal(decision.guestScope, 'meeting-room-public-service');
});
