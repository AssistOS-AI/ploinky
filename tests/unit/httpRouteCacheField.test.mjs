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
import { resolveRouteCacheClass } from '../../cli/server/policy/routeCacheMarks.js';
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
