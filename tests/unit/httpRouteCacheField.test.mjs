import '../helpers/isolatedWorkspaceRoot.mjs';
import '../helpers/agentlibTestContract.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
    loadEdgeRoutingGenerationForEvidence,
    validateEdgeDesiredCandidate,
} from '../../cli/sandbox/edgeGeneration.js';
import {
    cacheOverlay, isRouteCacheClass, isRouteCacheMark, matchOverlayEntry, resolveRouteCacheClass,
} from '../../cli/server/policy/routeCacheMarks.js';
import { domainFixture, ROOT_APPLICATION } from './directDomainFixtures.mjs';

const routeKey = ROOT_APPLICATION.agent.split('/')[1];
const portPath = `/base-agent-additional-server/${routeKey}/${ROOT_APPLICATION.port}`;

function manifest(httpRoutes) {
    return { routerAccess: { agentPorts: true, httpRoutes } };
}

function fixture(t, routes) {
    return domainFixture(t, { mode: 'single', manifests: { [routeKey]: manifest(routes) } });
}

function writeRoutes(world, routes) {
    world.write(path.join(world.routing.routes[routeKey].hostPath, 'manifest.json'), manifest(routes));
}

function declarations(form, routes) {
    if (form === 'array') return routes;
    return Object.fromEntries(routes.map(({ path, ...entry }) => [path, entry]));
}

function assertPlan(world, url, access, cacheClass) {
    const plan = world.plan(url);
    assert.equal(plan.ok, true, plan.code);
    assert.equal(plan.kind, 'agent-port', url);
    assert.equal(plan.routeKey, routeKey, url);
    assert.equal(plan.access.access, access, url);
    assert.equal(plan.responsePolicy.cacheClass, cacheClass, url);
    return plan;
}

for (const form of ['array', 'object']) {
    test(`public page and immutable cache classes reach root application plans from ${form} declarations`, (t) => {
        const routes = [
            { path: `${portPath}/`, access: 'public', cache: 'page' },
            { path: `${portPath}/assets/*`, access: 'public', cache: 'immutable' },
        ];
        const world = fixture(t, declarations(form, routes));
        const root = assertPlan(world, '/', 'public', 'page');
        assert.equal(root.policyPath, `${portPath}/`);
        assertPlan(world, '/assets/main.js', 'public', 'immutable');
        assertPlan(world, `${portPath}/assets/main.js`, 'public', 'immutable');
    });
}

for (const reversed of [false, true]) {
    test(`nested and exact declarations determine the cache class with broad wildcard ${reversed ? 'last' : 'first'}`, (t) => {
        const routes = [
            { path: `${portPath}/static/*`, access: 'public' },
            { path: `${portPath}/static/releases/*`, access: 'public', cache: 'immutable' },
            { path: `${portPath}/static/releases/live`, access: 'public' },
            { path: `${portPath}/static/releases/index`, access: 'public', cache: 'page' },
            { path: `${portPath}/static/releases/a.css`, access: 'public', enabled: false, cache: 'page' },
        ];
        const world = fixture(t, reversed ? routes.reverse() : routes);
        assertPlan(world, '/static/icons/a.svg', 'public', null);
        assertPlan(world, '/static/releases/a.css', 'public', 'immutable');
        assertPlan(world, '/static/releases/live', 'public', null);
        assertPlan(world, '/static/releases/index', 'public', 'page');
    });
}

test('a marked public wildcard never gives a cache class to a more restrictive winning route', (t) => {
    const routes = [
        { path: `${portPath}/x/*`, access: 'public', cache: 'page' },
        { path: `${portPath}/x/a`, access: 'authenticated' },
        { path: `${portPath}/x/guest`, access: 'guest' },
    ];
    const world = fixture(t, routes);
    assertPlan(world, '/x/b', 'public', 'page');
    for (const [suffix, access] of [['a', 'authenticated'], ['guest', 'guest']]) {
        assertPlan(world, `/x/${suffix}`, access, null);
        assert.equal(resolveRouteCacheClass({
            manifest: manifest(routes), routeKey, requestPath: `${portPath}/x/${suffix}`, access,
        }), null);
    }
});

test('invalid cache declarations fail candidate validation and preserve the active generation', (t) => {
    const world = fixture(t, [{ path: `${portPath}/`, access: 'public', cache: 'page' }]);
    const selector = world.active().selector;
    const desired = fs.readFileSync(world.paths.desiredFile);
    const invalid = [
        [{ path: '/x', access: 'guest', cache: 'page' }],
        [{ path: '/x', access: 'authenticated', cache: 'immutable' }],
        [{ path: '/x', access: 'guest', enabled: false, cache: 'page' }],
        [{ path: '/x', access: 'authenticated', enabled: false, cache: 'immutable' }],
        { '/x': { access: 'public', cache: 'unknown' } },
        { '/x': { access: 'public', cache: null } },
        [
            { path: 'x', access: 'public', cache: 'page' },
            { path: '/x', access: 'public', cache: 'immutable' },
        ],
        [
            { path: '/x', access: 'public' },
            { path: '/x', access: 'public', cache: 'page' },
        ],
    ];
    for (const routes of invalid) {
        writeRoutes(world, routes);
        assert.throws(() => validateEdgeDesiredCandidate(desired, world.options), /cache/i);
        assert.deepEqual(world.active().selector, selector);
        assertPlan(world, '/', 'public', 'page');
    }
});

test('a mark applies only to the selected agent when two agents declare the same relative path', (t) => {
    const route = { path: '/shared', access: 'public' };
    const world = domainFixture(t, { mode: 'single', manifests: {
        explorer: { ...manifest([{ ...route, cache: 'page' }]), enable: ['fixtures/provider'] },
        provider: manifest([route]),
    } });
    for (const [agent, expectedMark] of [['explorer', 'page'], ['provider', null]]) {
        const plan = world.plan(`/${agent}/shared`);
        assert.equal(plan.ok, true, plan.code);
        assert.equal(plan.kind, 'agent-root');
        assert.equal(plan.routeKey, agent);
        assert.equal(plan.decision.access, 'public');
        assert.equal(plan.responsePolicy.cacheClass, expectedMark);
    }
});

test('authenticated policy-state access suppresses a public manifest mark on the same path', (t) => {
    const routePath = `${portPath}/shared`;
    const world = fixture(t, [{ path: routePath, access: 'public', cache: 'page' }]);
    assertPlan(world, '/shared', 'public', 'page');
    world.write(world.paths.policyFile, {
        schema: 'router-policy',
        httpRoutes: [{ path: routePath, routeKey, access: 'authenticated' }],
        mcpTools: [],
    });
    world.apply();
    const plan = assertPlan(world, '/shared', 'authenticated', null);
    assert.equal(plan.access.source, 'policy');
});

function storedGeneration(world) {
    const id = world.active().selector.generation;
    const file = path.join(world.paths.generationsDir, `${id.slice('sha256:'.length)}.json`);
    const { compiled, compiledDigest } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { id, compiledBytes: JSON.stringify(compiled), compiledDigest };
}

for (const form of ['array', 'object']) {
    test(`adding a mark to ${form} declarations preserves compiled bytes and digest`, (t) => {
        const route = { path: `${portPath}/`, access: 'public' };
        const world = fixture(t, declarations(form, [route]));
        assertPlan(world, '/', 'public', null);
        const before = storedGeneration(world);
        writeRoutes(world, declarations(form, [{ ...route, cache: 'page' }]));
        world.apply();
        const after = storedGeneration(world);
        assert.notEqual(after.id, before.id);
        assert.equal(after.compiledBytes, before.compiledBytes);
        assert.match(before.compiledDigest, /^sha256:[0-9a-f]{64}$/);
        assert.equal(after.compiledDigest, before.compiledDigest);
        for (const candidate of [before, after]) {
            const loaded = loadEdgeRoutingGenerationForEvidence(candidate.id, world.options);
            assert.equal(loaded.generation, candidate.id);
            assert.deepEqual(loaded.compiled, JSON.parse(candidate.compiledBytes));
        }
        assertPlan(world, '/', 'public', 'page');
    });
}

test('never is a manifest mark but never a cache class, and only a public entry can carry it', (t) => {
    assert.equal(isRouteCacheMark('never'), true);
    assert.equal(isRouteCacheClass('never'), false);
    assert.equal(isRouteCacheMark('private'), false);
    for (const form of ['array', 'object']) {
        const routes = [
            { path: `${portPath}/login/`, access: 'public', cache: 'never' },
            { path: `${portPath}/docs/*`, access: 'public', cache: 'never' },
            { path: `${portPath}/docs/own`, access: 'public', cache: 'page' },
            { path: `${portPath}/p/`, access: 'public', cache: 'page' },
        ];
        const world = fixture(t, declarations(form, routes));
        // The Router plan records the manifest class only: never and anything under it is not a class.
        assertPlan(world, '/login/', 'public', null);
        assertPlan(world, '/docs/own', 'public', null);
        assertPlan(world, '/docs/x', 'public', null);
        assertPlan(world, '/p/', 'public', 'page');
    }
    const world = fixture(t, [{ path: `${portPath}/`, access: 'public', cache: 'page' }]);
    const selector = world.active().selector;
    const desired = fs.readFileSync(world.paths.desiredFile);
    for (const routes of [
        [{ path: '/x', access: 'guest', cache: 'never' }],
        [{ path: '/x', access: 'authenticated', cache: 'never' }],
        [{ path: '/x', access: 'authenticated', enabled: false, cache: 'never' }],
        { '/x': { access: 'authenticated', cache: 'never' } },
        [{ path: '/x', access: 'public' }, { path: '/x', access: 'public', cache: 'never' }],
        [{ path: '/x', access: 'public', cache: 'page' }, { path: '/x', access: 'public', cache: 'never' }],
    ]) {
        writeRoutes(world, routes);
        assert.throws(() => validateEdgeDesiredCandidate(desired, world.options), /cache/i);
        assert.deepEqual(world.active().selector, selector);
    }
    writeRoutes(world, [{ path: '/x', access: 'public', cache: 'never' }]);
    validateEdgeDesiredCandidate(desired, world.options);
});

// Overlay rows. Every path below is the normalized policy path of agent 'site'.
const site = 'site';
const protocolPath = `/base-agent-additional-server/${site}/8787/svc/*`;
function overlayFor(routes, records = {}) {
    return cacheOverlay({ parts: [{ routeKey: site, manifest: manifest(routes) }], records });
}
function row(overlay, path) {
    const found = overlay.entries.find(entry => entry.path === path);
    assert.ok(found, path);
    return found;
}
const choice = (setting, mark) => ({ setting, at: '2026-11-27T10:00:00.000Z', by: 'admin', entry: { access: 'public', manifest: mark } });
const ownerRoutes = [
    { path: '/login/', access: 'public', cache: 'never' },
    { path: '/docs/*', access: 'public', cache: 'never' },
    { path: '/docs/deep/*', access: 'public', cache: 'immutable' },
    { path: '/docs/own', access: 'public', cache: 'page' },
    { path: '/m1', access: 'public', cache: 'page' },
    { path: '/m2', access: 'public', cache: 'immutable' },
    { path: '/plain', access: 'public' },
    { path: '/static/*', access: 'public' },
    { path: '/static/exact', access: 'public' },
    { path: protocolPath, access: 'public', publicProtocol: { methods: ['POST'] } },
    { path: '/private', access: 'authenticated' },
];

test('overlay rules 1 to 5 give each entry one class and one source', () => {
    const records = {
        '/site/m1': choice('off', 'page'),
        '/site/m2': choice('off', 'immutable'),
        '/site/plain': choice('page', null),
        '/site/static/*': choice('page', null),
        '/site/login/': choice('page', null),
        '/site/docs/own': choice('off', 'page'),
        [protocolPath]: choice('page', null),
    };
    const overlay = overlayFor(ownerRoutes, records);
    const expected = {
        '/site/login/': [null, 'never'],
        '/site/docs/*': [null, 'never'],
        '/site/docs/deep/*': [null, 'never'],
        '/site/docs/own': [null, 'never'],
        '/site/m1': [null, 'off'],
        '/site/m2': [null, 'off'],
        '/site/plain': ['page', 'administrator'],
        '/site/static/*': ['page', 'administrator'],
        '/site/static/exact': [null, null],
        [protocolPath]: [null, null],
    };
    for (const [path, [effective, source]] of Object.entries(expected)) {
        const entry = row(overlay, path);
        assert.deepEqual([entry.effective, entry.source], [effective, source], path);
    }
    assert.equal(overlay.entries.some(entry => entry.path === '/site/private'), false, 'only public entries are listed');
    assert.equal(overlay.hasNever, true);
    assert.deepEqual(overlay.stale.map(entry => entry.path).sort(), ['/site/docs/own', '/site/login/', protocolPath].sort());
    // Without any setting the manifest marks apply, except where a never covers them.
    const plain = overlayFor(ownerRoutes);
    assert.deepEqual(['/site/m1', '/site/m2', '/site/docs/own', '/site/docs/deep/*'].map(path => row(plain, path).effective),
        ['page', 'immutable', null, null]);
    assert.equal(row(plain, '/site/docs/own').neverBy, '/site/docs/*');
    assert.equal(row(plain, '/site/docs/*').neverBy, null);
});

test('matching stays exact entry first, then the longest wildcard; an exact unmarked entry shadows a wildcard mark', () => {
    const overlay = overlayFor(ownerRoutes, { '/site/static/*': choice('page', null) });
    const at = path => matchOverlayEntry(overlay, path)?.effective ?? null;
    assert.equal(at('/site/static/file.css'), 'page');
    assert.equal(at('/site/static/exact'), null, 'the exact unmarked entry shadows the administrator wildcard');
    assert.equal(at('/site/docs'), null, 'a never wildcard also covers its own prefix');
    assert.equal(at('/site/docs/deep/a.js'), null, 'a never wildcard covers a longer immutable wildcard');
    assert.equal(at('/site/m1'), 'page');
    assert.equal(at('/site/unknown'), null);
    assert.equal(resolveRouteCacheClass({ manifest: manifest(ownerRoutes), routeKey: site, requestPath: '/site/docs/own', access: 'public' }), null);
    assert.equal(resolveRouteCacheClass({ manifest: manifest(ownerRoutes), routeKey: site, requestPath: '/site/m2', access: 'public' }), 'immutable');
    assert.equal(resolveRouteCacheClass({ manifest: manifest(ownerRoutes), routeKey: site, requestPath: '/site/m2', access: 'guest' }), null);
});

test('a setting binds only while its entry still equals the recorded one; an administrator page needs a never mark', () => {
    const base = [{ path: '/a', access: 'public' }, { path: '/b', access: 'public', cache: 'page' }];
    const withNever = [...base, { path: '/z', access: 'public', cache: 'never' }];
    const page = choice('page', null);
    const off = choice('off', 'page');
    const classOf = (routes, records, path) => {
        const entry = row(overlayFor(routes, records), path);
        return [entry.effective, entry.bound];
    };
    // No never mark: a page choice never applies, an off choice does.
    assert.deepEqual(classOf(base, { '/site/a': page }, '/site/a'), [null, false]);
    assert.deepEqual(classOf(base, { '/site/b': off }, '/site/b'), [null, true]);
    assert.deepEqual(classOf(withNever, { '/site/a': page }, '/site/a'), ['page', true]);
    // The manifest mark changed after the choice was recorded: stale.
    assert.deepEqual(classOf(withNever, { '/site/b': choice('off', 'immutable') }, '/site/b'), ['page', false]);
    assert.deepEqual(classOf([{ path: '/a', access: 'public', cache: 'page' }, ...withNever.slice(1)],
        { '/site/a': page }, '/site/a'), ['page', false]);
    // Access changed after the choice was recorded: the entry is no longer public and the choice is stale.
    const changed = overlayFor([{ path: '/a', access: 'authenticated' }, ...withNever.slice(1)], { '/site/a': page });
    assert.deepEqual(changed.stale.map(entry => entry.path), ['/site/a']);
    // An entry that does not exist is stale; invalid record fields never bind.
    assert.deepEqual(overlayFor(withNever, { '/site/gone': page }).stale.map(entry => entry.path), ['/site/gone']);
    assert.equal(row(overlayFor(withNever, { '/site/a': { ...page, setting: 'immutable' } }), '/site/a').bound, false);
    assert.equal(row(overlayFor(withNever, { '/site/a': { ...page, entry: { access: 'guest', manifest: null } } }), '/site/a').bound, false);
    // Remove the never mark and the choice is stale; restore it and it applies again.
    const states = [withNever, base, withNever].map(routes => classOf(routes, { '/site/a': page }, '/site/a'));
    assert.deepEqual(states, [['page', true], [null, false], ['page', true]]);
    // A never entry ignores any choice, a hand-written one included.
    assert.deepEqual(classOf(withNever, { '/site/z': page }, '/site/z'), [null, false]);
    assert.deepEqual(classOf(withNever, { '/site/z': choice('off', 'never') }, '/site/z'), [null, false]);
});
