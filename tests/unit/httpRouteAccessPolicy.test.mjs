import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleSuffix = `?t=${Date.now()}-${Math.random()}`;
const { HttpRouteAccessPolicy } = await import(`../../cli/server/policy/HttpRouteAccessPolicy.js${moduleSuffix}`);
const {
    normalizeManifestHttpRouteAccess,
    collectManifestHttpRouteAccess,
    createManifestRouteProvider,
} = await import(`../../cli/server/policy/HttpRouteProviders.js${moduleSuffix}`);

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

function writeManifest(root, routeKey, manifest) {
    const agentDir = path.join(root, routeKey);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return agentDir;
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

test('manifest route access rejects mode alias and accepts guest', () => {
    assert.equal(
        normalizeManifestHttpRouteAccess({ path: '/x', mode: 'guest' }, { routeKey: 'explorer' }).code,
        'INVALID_FIELD',
    );
    assert.deepEqual(
        normalizeManifestHttpRouteAccess({ path: '/x/*', access: 'guest' }, { routeKey: 'explorer' }),
        { ok: true, path: '/explorer/x/*', access: 'guest', routeKey: 'explorer', source: 'manifest' },
    );
});

test('manifest route access accepts public, guest, and authenticated entries', () => {
    for (const access of ['public', 'guest', 'authenticated']) {
        assert.deepEqual(
            normalizeManifestHttpRouteAccess({ path: `/${access}/*`, access }, { routeKey: 'explorer' }),
            { ok: true, path: `/explorer/${access}/*`, access, routeKey: 'explorer', source: 'manifest' },
        );
    }
    assert.equal(
        normalizeManifestHttpRouteAccess({ path: '/old', access: ['pro', 'tected'].join('') }, { routeKey: 'explorer' }).code,
        'INVALID_ACCESS',
    );
});

test('manifest route access defaults missing access to authenticated', () => {
    assert.deepEqual(
        normalizeManifestHttpRouteAccess({ path: '/implicit/*' }, { routeKey: 'explorer' }),
        { ok: true, path: '/explorer/implicit/*', access: 'authenticated', routeKey: 'explorer', source: 'manifest' },
    );
    assert.equal(
        normalizeManifestHttpRouteAccess({ path: '/empty', access: '' }, { routeKey: 'explorer' }).code,
        'INVALID_ACCESS',
    );
});

test('manifest route access keeps the root-relative and encoded __agent rejections', () => {
    for (const pathValue of ['/', '/*', '']) {
        assert.equal(
            normalizeManifestHttpRouteAccess({ path: pathValue, access: 'public' }, { routeKey: 'explorer' }).code,
            'INVALID_PATH',
            `path '${pathValue}' must not expand to a whole-agent declaration`,
        );
    }
    for (const pathValue of ['/__agent/x', '/%5F%5Fagent/x', '/a/%255F%255Fagent/x']) {
        assert.equal(
            normalizeManifestHttpRouteAccess({ path: pathValue, access: 'public' }, { routeKey: 'explorer' }).code,
            'INTERNAL_ROUTE_NOT_ALLOWED',
            pathValue,
        );
    }
});

test('manifest route access treats agent-relative router-looking paths as agent paths', () => {
    assert.deepEqual(
        normalizeManifestHttpRouteAccess({ path: '/auth/login', access: 'public' }, { routeKey: 'explorer' }),
        { ok: true, path: '/explorer/auth/login', access: 'public', routeKey: 'explorer', source: 'manifest' },
    );
    assert.deepEqual(
        normalizeManifestHttpRouteAccess({ path: '/admin/status', access: 'authenticated' }, { routeKey: 'explorer' }),
        { ok: true, path: '/explorer/admin/status', access: 'authenticated', routeKey: 'explorer', source: 'manifest' },
    );
    assert.deepEqual(
        normalizeManifestHttpRouteAccess({ path: '/metrics', access: 'guest' }, { routeKey: 'explorer' }),
        { ok: true, path: '/explorer/metrics', access: 'guest', routeKey: 'explorer', source: 'manifest' },
    );
});

test('collects manifest route access from routing hostPath entries', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-manifest-routes-'));
    try {
        const explorerDir = writeManifest(tempDir, 'explorer', {
            routerAccess: {
                httpRoutes: [
                    { path: '/public/*', access: 'public' },
                    { path: '/work/*', access: 'guest' },
                    { path: '/account/*', access: 'authenticated' },
                    { path: '/implicit/*' },
                    { path: '/legacy/*', mode: 'guest' },
                    { path: '/old/*', access: ['pro', 'tected'].join('') },
                ],
            },
        });
        const routes = {
            explorer: {
                agent: 'explorer',
                repo: 'AchillesIDE',
                hostPath: explorerDir,
                hostPort: 7011,
            },
        };
        const entries = collectManifestHttpRouteAccess(routes);
        assert.deepEqual(entries.map((entry) => ({ path: entry.path, access: entry.access, source: entry.source })), [
            { path: '/explorer/public/*', access: 'public', source: 'manifest' },
            { path: '/explorer/work/*', access: 'guest', source: 'manifest' },
            { path: '/explorer/account/*', access: 'authenticated', source: 'manifest' },
            { path: '/explorer/implicit/*', access: 'authenticated', source: 'manifest' },
        ]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('collects manifest route access through enabled-agent fallback when hostPath is absent', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-manifest-routes-fallback-'));
    try {
        const ploinkyDir = path.join(tempDir, '.ploinky');
        const agentDir = path.join(ploinkyDir, 'repos', 'fallbackRepo', 'fallbackAgent');
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify({
            routerAccess: {
                httpRoutes: [
                    { path: '/public/*', access: 'public' },
                    { path: '/account/*', access: 'authenticated' },
                ],
            },
        }, null, 2));
        fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
            fallbackAgent: {
                type: 'agent',
                agentName: 'fallbackAgent',
                repoName: 'fallbackRepo',
            },
        }, null, 2));

        const moduleUrl = pathToFileURL(path.resolve('cli/server/policy/HttpRouteProviders.js')).href;
        const script = `
            const workspace = process.argv[1];
            const moduleUrl = process.argv[2];
            process.chdir(workspace);
            const { collectManifestHttpRouteAccess } = await import(moduleUrl + '?fallback=' + Date.now());
            const entries = collectManifestHttpRouteAccess({
                fallbackAgent: {
                    agent: 'fallbackAgent',
                    repo: 'fallbackRepo',
                    hostPort: 7012
                }
            });
            console.log(JSON.stringify(entries.map((entry) => ({ path: entry.path, access: entry.access, routeKey: entry.routeKey }))));
        `;
        const child = spawnSync(process.execPath, [
            '--input-type=module',
            '--eval',
            script,
            tempDir,
            moduleUrl,
        ], {
            encoding: 'utf8',
        });

        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), [
            { path: '/fallbackAgent/public/*', access: 'public', routeKey: 'fallbackAgent' },
            { path: '/fallbackAgent/account/*', access: 'authenticated', routeKey: 'fallbackAgent' },
        ]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('manifest route provider caches by manifest mtime stamp', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-manifest-route-cache-'));
    const fixtureRouteKey = 'explorer';
    const manifestPath = path.join(tempDir, fixtureRouteKey, 'manifest.json');
    try {
        const explorerDir = writeManifest(tempDir, fixtureRouteKey, {
            routerAccess: {
                httpRoutes: [{ path: '/public/*', access: 'public' }],
            },
        });
        const fixtureRoutes = {
            [fixtureRouteKey]: {
                agent: fixtureRouteKey,
                repo: 'AchillesIDE',
                hostPath: explorerDir,
                hostPort: 7011,
            },
        };
        const provider = createManifestRouteProvider(() => fixtureRoutes);
        const first = provider();
        assert.equal(provider(), first);

        fs.writeFileSync(manifestPath, JSON.stringify({
            routerAccess: {
                httpRoutes: [{ path: '/changed/*', access: 'guest' }],
            },
        }, null, 2));
        const nextTime = new Date(Date.now() + 2000);
        fs.utimesSync(manifestPath, nextTime, nextTime);

        const second = provider();
        assert.notEqual(second, first);
        assert.equal(second[0].path, `/${fixtureRouteKey}/changed/*`);
        assert.equal(second[0].access, 'guest');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
