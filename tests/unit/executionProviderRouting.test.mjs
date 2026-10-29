import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { handleAgentRootUpgrade } from '../../cli/server/wsAgentRootProxy.js';
import {
    COORDINATOR_ROUTE_UNAVAILABLE,
    PROVIDER_DECLARATION_INVALID,
    PROVIDER_PORT_DENIED,
    PROVIDER_ROOT_UNRESOLVED,
    TASK_REFERENCE_UNAVAILABLE,
    providerAgentPortDenial,
    providerAgentRootDenial,
} from '../../cli/server/executionProvider/routing.mjs';
import { planProviderEndpoint } from '../../cli/server/executionProvider/providerEndpointPlan.mjs';
import { desiredFor, domainFixture, rootHost, rootHostEntry } from './directDomainFixtures.mjs';

// Two fictional providers with different private ports and endpoint paths.
const AP = '/base-agent-additional-server';
const EXPLORER_PORT = 7300;
const BIZANSO_PORT = 7400;
const provider = (name, port, extra = {}) => ({
    version: 1,
    port,
    taskReferences: { path: `/${name}/task-refs` },
    terminals: { path: `/${name}/terminal-control` },
    ...extra,
});
const coordinator = (name, port = 7000, suffix = '/api/coord/*') => ({
    path: `${AP}/${name}/${port}${suffix}`,
    callers: ['agent:fixtures/unrelated'],
});

function declareProviders(world, { explorer, bizanso } = {}) {
    for (const [name, declaration] of [['explorer', explorer], ['bizanso', bizanso]]) {
        const file = path.join(world.root, 'fixtures', name, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (declaration === undefined) delete manifest.executionProvider;
        else manifest.executionProvider = declaration;
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    }
}

function fixture(t, { desired } = {}) {
    const world = domainFixture(t, { mode: 'dual' });
    // The registry records carry the actual port mappings the routed roots use.
    for (const [name, hostPort] of [['explorer', 43101], ['bizanso', 43102]]) {
        world.agents[`${name}-container`].config = { ports: [{ containerPort: 7000, hostPort, hostIp: '127.0.0.1', protocol: 'tcp' }] };
    }
    world.write(world.paths.agentsFile, world.agents);
    if (desired) world.write(world.paths.desiredFile, desired(world));
    world.apply();
    return world;
}

function plan(url, { listener = 'public', host, transport = 'http', method = 'GET' } = {}) {
    const defaults = { public: '127.0.0.1:8080', private: '127.0.0.1:8081', managed: 'host.containers.internal:8080' };
    const req = { url, method, headers: { host: host || defaults[listener] }, ploinkyListenerClass: listener === 'private' ? 'private' : 'public' };
    return resolveEdgeRoutePlan({ req, listener, transport });
}

const LISTENERS = ['public', 'private', 'managed'];
const TRANSPORTS = ['http', 'websocket'];

test('a baseline external provider-port route is usable until the declaration denies the whole port; unrelated routes stay usable', (t) => {
    const world = fixture(t);
    const url = `${AP}/explorer/${EXPLORER_PORT}/explorer/task-refs/x`;
    const baseline = plan(url);
    assert.equal(baseline.ok, true, 'before the declaration the port is relayed like any other');
    assert.equal(baseline.kind, 'agent-port');

    declareProviders(world, { explorer: provider('explorer', EXPLORER_PORT), bizanso: provider('bizanso', BIZANSO_PORT) });
    world.apply();
    for (const listener of LISTENERS) {
        for (const transport of TRANSPORTS) {
            for (const suffix of ['/x', '', '/', '/explorer/task-refs/x', '/explorer/terminal-control', '/anything/else?q=1']) {
                const denied = plan(`${AP}/explorer/${EXPLORER_PORT}${suffix}`, { listener, transport });
                const label = `${listener} ${transport} ${suffix}`;
                assert.equal(denied.ok, false, label);
                assert.equal(denied.matched, true, label);
                assert.equal(denied.status, 403, label);
                assert.equal(denied.code, PROVIDER_PORT_DENIED, label);
            }
            // The other provider is denied on its own port only.
            assert.equal(plan(`${AP}/bizanso/${BIZANSO_PORT}/x`, { listener, transport }).code, PROVIDER_PORT_DENIED);
            assert.equal(plan(`${AP}/explorer/${BIZANSO_PORT}/x`, { listener, transport }).code === PROVIDER_PORT_DENIED, false);
            assert.equal(plan(`${AP}/bizanso/${EXPLORER_PORT}/x`, { listener, transport }).code === PROVIDER_PORT_DENIED, false);
        }
    }
    // Ordinary ports of the providers and routes of other agents are unaffected.
    assert.equal(plan(`${AP}/explorer/7000/health`).ok, true);
    assert.equal(plan(`${AP}/bizanso/8787/static/app.js`).ok, true);
    assert.equal(plan(`${AP}/unrelated/${EXPLORER_PORT}/public/x`).code === PROVIDER_PORT_DENIED, false);
    assert.equal(plan(`${AP}/unrelated/${BIZANSO_PORT}/public/x`).code === PROVIDER_PORT_DENIED, false);
    // The refusal precedes caller policy: no access decision was evaluated.
    assert.equal(plan(`${AP}/explorer/${EXPLORER_PORT}/x`).decision, undefined);
});

test('the provider port is denied through every root alias: owner host, root application and agent-root paths', (t) => {
    const world = fixture(t);
    declareProviders(world, { explorer: provider('explorer', EXPLORER_PORT), bizanso: provider('bizanso', BIZANSO_PORT) });
    world.apply();
    for (const transport of TRANSPORTS) {
        for (const url of [`${AP}/explorer/${EXPLORER_PORT}/x`, `${AP}/bizanso/${BIZANSO_PORT}/x`]) {
            assert.equal(world.plan(url, rootHost, transport).code, PROVIDER_PORT_DENIED, `${transport} ${url}`);
        }
    }
    // The root application's own port and the owner's mount keep working.
    for (const [url, kind] of [['/', 'agent-port'], ['/static/app.js', 'agent-port'], ['/explorer/health', 'agent-root']]) {
        const ok = world.plan(url, rootHost, 'http');
        assert.equal(ok.ok, true, url);
        assert.equal(ok.kind, kind, url);
    }
    // A root application cannot be mapped to the provider port: refused when compiled.
    world.write(world.paths.desiredFile, desiredFor('dual', {
        root: rootHostEntry({ rootApplication: { agent: 'fixtures/bizanso', port: BIZANSO_PORT } }),
    }));
    assert.throws(() => world.apply(), /rootApplication maps the provider port 7400/);
});

test('coordinator paths are unavailable on every planner, listener and transport except the exact private HTTP hop, including encoded spellings', (t) => {
    const world = fixture(t, {
        // The root application is served on its routed root port, so the
        // synthesized selector reaches the coordinator scope.
        desired: () => desiredFor('dual', { root: rootHostEntry({ rootApplication: { agent: 'fixtures/bizanso', port: 7000 } }) }),
    });
    declareProviders(world, {
        explorer: provider('explorer', EXPLORER_PORT, { coordinatorRoutes: [coordinator('explorer'), coordinator('explorer', 7000, '/exact')] }),
        bizanso: provider('bizanso', BIZANSO_PORT, { coordinatorRoutes: [coordinator('bizanso')] }),
    });
    world.apply();
    for (const listener of LISTENERS) {
        for (const transport of TRANSPORTS) {
            for (const suffix of ['/api/coord/x', '/api/coord', '/api/coord/x?a=1', '/exact', '/exact/']) {
                const planned = plan(`${AP}/explorer/7000${suffix}`, { listener, transport });
                const label = `${listener} ${transport} ${suffix}`;
                // S3a: the signed coordinator hop. Only an exact declared scope
                // over HTTP on the private listener plans; the private
                // authorization step then restricts callers and signs the
                // forward (coordinatorHop.test.mjs). Every other listener,
                // transport and spelling keeps the denial.
                if (listener === 'private' && transport === 'http' && suffix !== '/exact/') {
                    assert.equal(planned.ok, true, label);
                    assert.equal(planned.kind, 'agent-port', label);
                    continue;
                }
                assert.equal(planned.ok, false, label);
                assert.equal(planned.code, COORDINATOR_ROUTE_UNAVAILABLE, label);
                assert.equal(planned.status, 503, label);
            }
            // The selector parser already refuses non-canonical spellings of the agent-port surface.
            for (const suffix of ['/api/%63oord/x', '/api/%2563oord/x', '/api//coord/x']) {
                const denied = plan(`${AP}/explorer/7000${suffix}`, { listener, transport });
                assert.equal(denied.ok, false, `${listener} ${transport} ${suffix}`);
            }
            assert.equal(plan(`${AP}/explorer/7000/api/other`, { listener, transport }).code === COORDINATOR_ROUTE_UNAVAILABLE, false);
            assert.equal(plan(`${AP}/explorer/7000/exact/deeper`, { listener, transport }).code === COORDINATOR_ROUTE_UNAVAILABLE, false);
        }
    }
    // agent-root: the path is matched after rewriting, on the control host and a public host.
    for (const [host, prefix] of [['127.0.0.1:8080', '/explorer'], [rootHost, '/explorer']]) {
        for (const transport of TRANSPORTS) {
            for (const suffix of ['/api/coord/x', '/api/%63oord/x', '/exact']) {
                const denied = plan(`${prefix}${suffix}`, { host, transport });
                assert.equal(denied.code, COORDINATOR_ROUTE_UNAVAILABLE, `${host} ${transport} ${suffix}`);
            }
            assert.equal(plan(`${prefix}/api/other`, { host, transport }).code === COORDINATOR_ROUTE_UNAVAILABLE, false);
        }
    }
    // The managed listener resolves the agent-root path too.
    assert.equal(plan('/explorer/api/coord/x', { listener: 'managed' }).code, COORDINATOR_ROUTE_UNAVAILABLE);
    // Root-application synthesized selector: `/api/coord/x` on the root host is the application's coordinator scope.
    for (const transport of TRANSPORTS) {
        assert.equal(world.plan('/api/coord/x', rootHost, transport).code, COORDINATOR_ROUTE_UNAVAILABLE, transport);
        assert.equal(world.plan('/api/other', rootHost, transport).code === COORDINATOR_ROUTE_UNAVAILABLE, false, transport);
    }
});

test('the WebSocket root proxy closes a coordinator or task-reference upgrade without dialing', async (t) => {
    const world = fixture(t);
    declareProviders(world, {
        explorer: provider('explorer', EXPLORER_PORT, { coordinatorRoutes: [coordinator('explorer')] }),
        bizanso: provider('bizanso', BIZANSO_PORT),
    });
    world.apply();
    for (const url of ['/explorer/api/coord/x', '/task-refs/abc', '/task%2Drefs/abc']) {
        const written = [];
        const socket = Object.assign(new EventEmitter(), {
            write: (chunk) => { written.push(String(chunk)); return true; },
            destroy() { this.destroyed = true; },
        });
        const req = { url, method: 'GET', headers: { host: '127.0.0.1:8080', upgrade: 'websocket' } };
        const handled = await handleAgentRootUpgrade({ req, socket, head: Buffer.alloc(0), parsedUrl: new URL(url, 'http://127.0.0.1:8080') });
        assert.equal(handled, true, url);
        assert.match(written.join(''), /^HTTP\/1\.1 503 /, url);
        assert.match(written.join(''), /X-Ploinky-Refusal: v=1; stage=route; cause=route-denied/, url);
        assert.equal(socket.destroyed, true, url);
    }
});

test('the reserved task-reference mount precedes every dispatch on every listener, host and transport', (t) => {
    const world = fixture(t);
    declareProviders(world, { explorer: provider('explorer', EXPLORER_PORT), bizanso: provider('bizanso', BIZANSO_PORT) });
    world.apply();
    // S3a: only exact canonical operations plan (taskReferenceRoutes.test.mjs);
    // every other spelling of the mount stays reserved and unavailable.
    const reserved = ['/task-refs', '/task-refs/', '/task-refs/abc', '/task-refs/provider/abc/events/more', '/%74ask-refs',
        '/task%2Drefs/x', '/task-refs%2Fabc', '/%2574ask-refs', '//task-refs/x', `/task-refs/explorer/${'A'.repeat(22)}/`,
        `/task-refs/explorer/%41${'A'.repeat(21)}`, '/task-refs/explorer/./lookup'];
    for (const listener of LISTENERS) {
        for (const transport of TRANSPORTS) {
            for (const url of reserved) {
                const denied = plan(url, { listener, transport });
                assert.equal(denied.ok, false, `${listener} ${transport} ${url}`);
                assert.equal(denied.status, 503, `${listener} ${transport} ${url}`);
                assert.equal(denied.code, TASK_REFERENCE_UNAVAILABLE, `${listener} ${transport} ${url}`);
            }
        }
    }
    // A well-formed operation with a malformed id or events query is a caller
    // error over HTTP, and is still never forwarded; upgrades stay unavailable.
    for (const url of ['/task-refs/provider/abc/events?after=0&limit=5', `/task-refs/explorer/${'A'.repeat(22)}/events?limit=5&after=0`]) {
        for (const listener of LISTENERS) {
            assert.equal(plan(url, { listener }).status, 400, `${listener} ${url}`);
            assert.equal(plan(url, { listener, transport: 'websocket' }).code, TASK_REFERENCE_UNAVAILABLE, `${listener} ${url}`);
        }
        // The root-application host gives the same answers (N5).
        assert.equal(world.plan(url, rootHost, 'http').status, 400, `root host ${url}`);
        assert.equal(world.plan(url, rootHost, 'websocket').code, TASK_REFERENCE_UNAVAILABLE, `root host ${url}`);
    }
    // A root-application host does not forward it to the application or the owner.
    for (const url of reserved) {
        for (const method of ['GET', 'POST']) {
            assert.equal(world.plan(url, rootHost, 'http', method).code, TASK_REFERENCE_UNAVAILABLE, `${method} ${url}`);
        }
        assert.equal(world.plan(url, rootHost, 'websocket').code, TASK_REFERENCE_UNAVAILABLE, url);
    }
    // Unrelated spellings are not reserved: `/task-refs-extra` is an ordinary unknown path.
    for (const url of ['/task-refs-extra', '/task-refs-extra/x', '/task-refs%2Dextra', '/x/task-refs', '/task-ref',
        `${AP}/unrelated/7000/task-refs/x`]) {
        for (const listener of LISTENERS) {
            assert.notEqual(plan(url, { listener }).code, TASK_REFERENCE_UNAVAILABLE, `${listener} ${url}`);
        }
        assert.notEqual(world.plan(url, rootHost).code, TASK_REFERENCE_UNAVAILABLE, url);
    }
});

test('publication is refused when an edge generation is compiled, and unrelated agents are not blamed', (t) => {
    const world = fixture(t);
    const refuse = (declarations, pattern, label) => {
        declareProviders(world, declarations);
        assert.throws(() => world.apply(), pattern, label);
    };
    refuse({ explorer: { version: 1, port: EXPLORER_PORT } }, /manifest\(explorer\)\.executionProvider is refused: at least one/, 'no endpoint');
    refuse({ explorer: null }, /plain object/, 'null is presence');
    refuse({ explorer: provider('explorer', EXPLORER_PORT, { coordinatorRoutes: [coordinator('explorer', 7001)] }) }, /routed root port 7000/, 'coordinator on another port');
    // Unrelated agents still compile once the declarations are valid.
    declareProviders(world, { explorer: provider('explorer', EXPLORER_PORT), bizanso: provider('bizanso', BIZANSO_PORT) });
    assert.doesNotThrow(() => world.apply());
});

test('compile refuses a provider port that appears in the registry mapping or in a route declaration', (t) => {
    const world = fixture(t);
    declareProviders(world, { explorer: provider('explorer', EXPLORER_PORT) });
    world.agents['explorer-container'].config.ports.push({ containerPort: EXPLORER_PORT, hostPort: 43999, protocol: 'tcp' });
    world.write(world.paths.agentsFile, world.agents);
    assert.throws(() => world.apply(), /published port mapping/);
    world.agents['explorer-container'].config.ports.pop();
    world.agents['explorer-container'].config.ports[0].containerPort = EXPLORER_PORT;
    world.write(world.paths.agentsFile, world.agents);
    assert.throws(() => world.apply(), /port mapping|routed root target is the provider port/);
    world.agents['explorer-container'].config.ports[0].containerPort = 7000;
    world.write(world.paths.agentsFile, world.agents);
    // A disabled route declaration still selects the port.
    const file = path.join(world.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.routerAccess = { httpRoutes: [{ path: `${AP}/explorer/${EXPLORER_PORT}/*`, access: 'public', enabled: false }] };
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => world.apply(), /selects the provider port 7300/);
    delete manifest.routerAccess;
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.doesNotThrow(() => world.apply());
});

test('the task-refs route key is reserved when an edge generation is compiled', (t) => {
    const world = fixture(t);
    world.routing.routes['task-refs'] = { ...world.routing.routes.unrelated };
    world.write(world.paths.routingFile, world.routing);
    assert.throws(() => world.apply(), /route key 'task-refs' is reserved/);
});

// ---- request-derived planners fail closed on an unusable declaration ----

test('a malformed active declaration denies the route in the agent-port and agent-root planners', () => {
    const snapshot = (executionProvider, extra = {}) => ({ manifests: { alpha: { executionProvider } }, agents: {}, ...extra });
    for (const bad of [null, [], {}, { version: 2, port: 7300, terminals: { path: '/t' } }, { version: 1, port: 7300 }]) {
        assert.deepEqual(
            providerAgentPortDenial({ snapshot: snapshot(bad), routeKey: 'alpha', selector: { port: 7000, suffix: '/x' } }),
            { status: 503, code: PROVIDER_DECLARATION_INVALID },
            JSON.stringify(bad),
        );
        assert.deepEqual(
            providerAgentRootDenial({ snapshot: snapshot(bad), routeKey: 'alpha', route: { hostPort: 43101 }, upstreamPath: '/x' }),
            { status: 503, code: PROVIDER_DECLARATION_INVALID },
            JSON.stringify(bad),
        );
    }
    // No declaration, no effect.
    assert.equal(providerAgentPortDenial({ snapshot: { manifests: { alpha: {} } }, routeKey: 'alpha', selector: { port: 7300, suffix: '/' } }), null);
    assert.equal(providerAgentRootDenial({ snapshot: { manifests: { alpha: {} } }, routeKey: 'alpha', route: { hostPort: 1 }, upstreamPath: '/' }), null);
});

test('agent-root denies a routed root that is the provider port or cannot be resolved', () => {
    const good = { version: 1, port: 7300, terminals: { path: '/t' } };
    const snapshot = (ports, manifest = {}) => ({
        manifests: { alpha: { executionProvider: good, ...manifest } },
        agents: { 'alpha-container': { profile: 'default', config: { ports } } },
    });
    const route = { container: 'alpha-container', hostPort: 43101 };
    const call = (snap, r = route) => providerAgentRootDenial({ snapshot: snap, routeKey: 'alpha', route: r, upstreamPath: '/x' });
    assert.equal(call(snapshot([{ containerPort: 7000, hostPort: 43101 }])), null);
    assert.deepEqual(call(snapshot([{ containerPort: 7300, hostPort: 43101 }])), { status: 403, code: PROVIDER_PORT_DENIED });
    // Host network: the route target itself is the root.
    assert.deepEqual(call(snapshot([], { network: { mode: 'host' } }), { ...route, hostPort: 7300 }), { status: 403, code: PROVIDER_PORT_DENIED });
    assert.equal(call(snapshot([], { network: { mode: 'host' } }), { ...route, hostPort: 7000 }), null);
    // A target whose primary identity cannot be resolved is invalid; a route without a target has nothing to reach.
    assert.deepEqual(call(snapshot([])), { status: 503, code: PROVIDER_ROOT_UNRESOLVED });
    assert.deepEqual(call(snapshot([{ containerPort: 7000, hostPort: 1 }])), { status: 503, code: PROVIDER_ROOT_UNRESOLVED });
    assert.deepEqual(call(snapshot([{ containerPort: 7000, hostPort: 43101, protocol: 'udp' }])), { status: 503, code: PROVIDER_ROOT_UNRESOLVED });
    assert.equal(call(snapshot([]), { ...route, hostPort: 0 }), null);
    // Coordinator scopes fail closed when the root is unknown.
    const coord = { executionProvider: { ...good, coordinatorRoutes: [{ path: `${AP}/alpha/7000/api/*`, callers: ['agent:fixtures/x'] }] } };
    assert.deepEqual(
        providerAgentRootDenial({ snapshot: snapshot([], coord), routeKey: 'alpha', route: { ...route, hostPort: 0 }, upstreamPath: '/api/x' }),
        { status: 503, code: COORDINATOR_ROUTE_UNAVAILABLE },
    );
});

// ---- review fixes: host-network aliases, undecodable task-refs spellings, effective profile ----

function hostWorld(t) {
    const world = fixture(t);
    for (const name of ['bizanso', 'unrelated']) {
        const file = path.join(world.root, 'fixtures', name, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.network = { mode: 'host' };
        if (name === 'bizanso') manifest.executionProvider = provider('bizanso', BIZANSO_PORT);
        fs.writeFileSync(file, JSON.stringify(manifest));
        world.agents[`${name}-container`].config = { ports: [] };
    }
    world.write(world.paths.agentsFile, world.agents);
    world.apply();
    return world;
}

test('host network: another host-network agent cannot reach a host-network provider port, directly or as a root application', (t) => {
    const world = hostWorld(t);
    for (const listener of LISTENERS) {
        for (const transport of TRANSPORTS) {
            for (const name of ['unrelated', 'bizanso']) {
                const denied = plan(`${AP}/${name}/${BIZANSO_PORT}/t`, { listener, transport });
                assert.equal(denied.ok, false, `${listener} ${transport} ${name}`);
                assert.equal(denied.code, PROVIDER_PORT_DENIED, `${listener} ${transport} ${name}`);
            }
            // Other ports of the host-network sibling stay usable; a bridge-mode sibling is not affected.
            assert.equal(plan(`${AP}/unrelated/7999/public/x`, { listener, transport }).code === PROVIDER_PORT_DENIED, false);
            assert.equal(plan(`${AP}/explorer/${BIZANSO_PORT}/x`, { listener, transport }).code === PROVIDER_PORT_DENIED, false);
        }
    }
    // A root application on a host-network route cannot name the provider's port: refused at compile.
    world.write(world.paths.desiredFile, desiredFor('dual', {
        root: rootHostEntry({ rootApplication: { agent: 'fixtures/unrelated', port: BIZANSO_PORT } }),
    }));
    assert.throws(() => world.apply(), /rootApplication on a host-network route maps the provider port 7400/);
    world.write(world.paths.desiredFile, desiredFor('dual', {
        root: rootHostEntry({ rootApplication: { agent: 'fixtures/unrelated', port: 7999 } }),
    }));
    assert.doesNotThrow(() => world.apply());
});

test('undecodable spellings cannot hide the reserved task-reference mount (HTTP and WebSocket)', async (t) => {
    const world = fixture(t);
    const spellings = ['/task-refs/%zz', '/%74ask-refs/%zz', '/task-refs/x%E0%A4%A', '/task%2Drefs/%', '/task-refs/%E0%A4%A/y'];
    for (const url of spellings) {
        for (const listener of LISTENERS) {
            for (const transport of TRANSPORTS) {
                assert.equal(plan(url, { listener, transport }).code, TASK_REFERENCE_UNAVAILABLE, `${listener} ${transport} ${url}`);
            }
        }
        assert.equal(world.plan(url, rootHost, 'http').code, TASK_REFERENCE_UNAVAILABLE, url);
        assert.equal(world.plan(url, rootHost, 'websocket').code, TASK_REFERENCE_UNAVAILABLE, url);
        const written = [];
        const socket = Object.assign(new EventEmitter(), {
            write: (chunk) => { written.push(String(chunk)); return true; },
            destroy() { this.destroyed = true; },
        });
        const req = { url, method: 'GET', headers: { host: '127.0.0.1:8080', upgrade: 'websocket' } };
        await handleAgentRootUpgrade({ req, socket, head: Buffer.alloc(0), parsedUrl: new URL('http://127.0.0.1:8080/') });
        assert.match(written.join(''), /^HTTP\/1\.1 503 /, url);
    }
    for (const url of ['/task-refs-extra/%zz', '/x/task-refs/%zz', '/task-refs%zz']) {
        assert.notEqual(plan(url).code, TASK_REFERENCE_UNAVAILABLE, url);
    }
});

test('coordinator matching ignores case and ;parameters; the generic relay opt-out does not touch the provider contract', (t) => {
    const world = fixture(t);
    declareProviders(world, { explorer: provider('explorer', EXPLORER_PORT, { coordinatorRoutes: [coordinator('explorer')] }), bizanso: provider('bizanso', BIZANSO_PORT) });
    world.apply();
    for (const suffix of ['/API/coord/x', '/api/Coord/x', '/api/coord;x', '/api/coord;x=1/y', '/api;p/coord']) {
        assert.equal(plan(`${AP}/explorer/7000${suffix}`).code, COORDINATOR_ROUTE_UNAVAILABLE, suffix);
        assert.equal(plan(`/explorer${suffix}`).code, COORDINATOR_ROUTE_UNAVAILABLE, `root ${suffix}`);
    }
    // routerAccess.agentPorts: false closes the generic relay but not the declared provider.
    const file = path.join(world.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.routerAccess = { agentPorts: false };
    fs.writeFileSync(file, JSON.stringify(manifest));
    world.apply();
    assert.equal(plan(`${AP}/explorer/7000/x`).code, 'AGENT_PORT_RELAY_DISABLED');
    const internal = planProviderEndpoint({ routeKey: 'explorer', endpoint: 'terminals', method: 'GET', transport: 'websocket' });
    assert.equal(internal.ok, true, 'the internal planner still resolves under agentPorts:false');
    assert.equal(internal.port, EXPLORER_PORT);
    assert.equal(plan(`${AP}/explorer/${EXPLORER_PORT}/x`).code, PROVIDER_PORT_DENIED);
});

test('compile uses the effective (merged) profile: a non-default profile inheriting PORT is accepted', (t) => {
    const world = fixture(t);
    // Route key 'explorer', launched with profile 'qa' that inherits env.PORT from 'default'.
    world.agents['explorer-container'].profile = 'qa';
    world.agents['explorer-container'].config = { ports: [{ containerPort: 7100, hostPort: 43101, hostIp: '127.0.0.1', protocol: 'tcp' }] };
    world.write(world.paths.agentsFile, world.agents);
    const file = path.join(world.root, 'fixtures', 'explorer', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.profiles = { default: { env: { PORT: '7100' } }, qa: {} };
    manifest.executionProvider = provider('explorer', EXPLORER_PORT, { coordinatorRoutes: [coordinator('explorer', 7100)] });
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.doesNotThrow(() => world.apply());
    // A provider on the inherited server port is still refused.
    manifest.executionProvider = provider('explorer', 7100);
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => world.apply(), /provider port 7100/);
});
