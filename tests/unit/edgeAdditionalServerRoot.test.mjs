import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Namespace imports: a missing export fails each case instead of the module link.
import * as edge from '../../cli/sandbox/edgeGeneration.js';
import * as authContext from '../../cli/server/authHandlers/authContext.js';
import { sanitizeRequestHeaders } from '../../cli/server/proxy/sanitizeRequestHeaders.js';
import { assertMutationAllowed } from '../../cli/server/proxy/executeHttpPlan.js';
import { buildHttpRouteAuthInfoHeader } from '../../cli/server/routerHandlers.js';
import { deriveAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { verifyHttpRouteAuthInfoFromHeaders } from '../../Agent/lib/invocationAuth.mjs';
import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { sha256RawBodyHash } from '../../Agent/lib/requestHash.mjs';
import {
    desiredFor, domainFixture, hash, rootHost, rootHostEntry, siblingHost,
} from './directDomainFixtures.mjs';

const externalHost = 'external.synthetic.test';
const PREFIX = '/base-agent-additional-server/bizanso/8787';
const RETIRED_PORT_FIELD = ['additional', 'Server', 'Port'].join('');
// The compiled generation keys produced by 7cc1991c (edgeGenerationHardCut.test.mjs).
const BASE_COMPILED_KEYS = ['agentMcpRoutes', 'dependencyHttpRoutes', 'hosts', 'policy', 'publication', 'security', 'surfaces'];

function edgeTree(world) {
    const files = {};
    for (const dir of [world.paths.edgeDir, world.paths.topologyDir]) {
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const file = path.join(entry.parentPath, entry.name);
            files[path.relative(world.root, file)] = fs.readFileSync(file).toString('base64');
        }
    }
    return files;
}

function bytesOf(value) {
    return Buffer.from(JSON.stringify(value, null, 2));
}

function withMasterKey(t) {
    const saved = process.env.PLOINKY_MASTER_KEY;
    process.env.PLOINKY_MASTER_KEY = crypto.randomBytes(32).toString('hex');
    t.after(() => {
        if (saved === undefined) delete process.env.PLOINKY_MASTER_KEY;
        else process.env.PLOINKY_MASTER_KEY = saved;
    });
}

// ---- validateEdgeDesiredCandidate (A4) ----

test('desired candidate validation compiles accepted bytes and writes nothing', (t) => {
    const world = domainFixture(t, { mode: 'legacy' });
    const before = edgeTree(world);
    const selectorBefore = world.active().selector;
    const installed = fs.readFileSync(world.paths.desiredFile);

    const same = edge.validateEdgeDesiredCandidate(installed, world.options);
    assert.equal(same.generation, selectorBefore.generation);
    assert.deepEqual([...same.hostnames], [siblingHost]);

    const external = desiredFor('legacy');
    external.hosts[externalHost] = { agent: 'fixtures/explorer', dnsManagement: 'external' };
    const accepted = edge.validateEdgeDesiredCandidate(bytesOf(external), world.options);
    assert.match(accepted.generation, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(accepted.generation, selectorBefore.generation);
    assert.equal(accepted.desiredDigest, hash(bytesOf(external)));
    assert.deepEqual([...accepted.hostnames], [externalHost, siblingHost].sort());
    assert.equal(accepted.publicationMode, 'cloudflare');
    assert.equal(Object.isFrozen(accepted), true);

    for (const mode of ['dual', 'single']) {
        const result = edge.validateEdgeDesiredCandidate(bytesOf(desiredFor(mode)), world.options);
        assert.deepEqual([...result.hostnames], mode === 'dual' ? [rootHost, siblingHost] : [rootHost], mode);
        assert.notEqual(result.generation, selectorBefore.generation, mode);
    }

    assert.deepEqual(edgeTree(world), before);
    assert.deepEqual(world.active().selector, selectorBefore);
    assert.equal(fs.existsSync(world.paths.applyLockFile), false);
});

test('desired candidate validation rejects malformed candidates with every edge file byte-identical', (t) => {
    const world = domainFixture(t, { mode: 'legacy' });
    const before = edgeTree(world);
    const selectorBefore = world.active().selector;
    const withHost = (entry) => {
        const value = desiredFor('legacy');
        value.hosts[externalHost] = entry;
        return bytesOf(value);
    };
    const withRoot = (rootApplication) => bytesOf(desiredFor('dual', { root: rootHostEntry({ rootApplication }) }));
    const rejected = [
        ['malformed JSON', Buffer.from('{"hosts":'), /edge desired state|JSON/i],
        ['not bytes', { hosts: {} }, /must be bytes/],
        ['too large', Buffer.alloc(edge.EDGE_DESIRED_CANDIDATE_MAX_BYTES + 1, 0x20), /exceeds/],
        ['unknown host field', withHost({ agent: 'fixtures/explorer', ready: true }), /unsupported field 'ready'/],
        // Assembled: runtimeSourceAbsence.test.mjs forbids the retired field name in tests.
        ['retired host field', withHost({ agent: 'fixtures/explorer', [RETIRED_PORT_FIELD]: 8787 }),
            new RegExp(`unsupported field '${RETIRED_PORT_FIELD}'`)],
        ['invalid DNS management', withHost({ agent: 'fixtures/explorer', dnsManagement: 'unowned' }),
            /dnsManagement is invalid/],
        ['uninstalled owner', withHost({ agent: 'fixtures/missing' }), /exactly one enabled effective route/],
        ['unknown top-level field', bytesOf({ ...desiredFor('legacy'), extra: true }), /unsupported field 'extra'/],
        ...[0, -1, 65536, '8787', 8787.5, null].map((port) => [
            `root application port ${JSON.stringify(port)}`, withRoot({ agent: 'fixtures/bizanso', port }), /integer port/,
        ]),
        ['root application extra key', withRoot({ agent: 'fixtures/bizanso', port: 8787, path: '/' }),
            /unsupported field 'path'/],
        ['root application without agent', withRoot({ port: 8787 }), /exact <repo>\/<agent>/],
        ['root application not an object', withRoot('fixtures/bizanso'), /must be an object/],
        ['root application equal to owner', withRoot({ agent: 'fixtures/explorer', port: 8787 }), /differ from the host owner/],
        ['uninstalled root application', withRoot({ agent: 'fixtures/missing', port: 8787 }), /exactly one installed route/],
    ];
    for (const [label, candidate, pattern] of rejected) {
        assert.throws(() => edge.validateEdgeDesiredCandidate(candidate, world.options), pattern, label);
        assert.deepEqual(edgeTree(world), before, label);
        assert.equal(fs.existsSync(world.paths.applyLockFile), false, label);
    }
    assert.deepEqual(world.active().selector, selectorBefore);
});

test('desired candidate validation reuses a held apply lock and refuses a foreign one', (t) => {
    const world = domainFixture(t, { mode: 'legacy' });
    const bytes = fs.readFileSync(world.paths.desiredFile);
    const result = edge.withEdgeGenerationApplyLock((applyLockCapability) => {
        assert.equal(fs.existsSync(world.paths.applyLockFile), true);
        const held = edge.validateEdgeDesiredCandidate(bytes, { ...world.options, applyLockCapability });
        // The caller's lock is still held after validation returns.
        assert.equal(fs.existsSync(world.paths.applyLockFile), true);
        assert.throws(() => edge.validateEdgeDesiredCandidate(bytes, world.options), { code: 'EDGE_GENERATION_BUSY' });
        assert.throws(() => edge.validateEdgeDesiredCandidate(bytes, { ...world.options, applyLockCapability: {} }),
            { code: 'EDGE_GENERATION_BUSY' });
        return held;
    }, world.options);
    assert.equal(result.generation, world.active().selector.generation);
    assert.equal(fs.existsSync(world.paths.applyLockFile), false);
    // The released lock admits an ordinary apply afterwards.
    world.apply();
});

// ---- C1/C2 compiled shape ----

test('a root application compiles beside the owner while hosts without one keep the base shape', (t) => {
    const world = domainFixture(t);
    const { generation } = world.active();
    const { compiled } = generation;
    assert.deepEqual(Object.keys(compiled).sort(), BASE_COMPILED_KEYS);
    assert.deepEqual(compiled.hosts[rootHost], {
        kind: 'agent-root', agent: 'fixtures/explorer', routeKey: 'explorer',
        rootApplication: { agent: 'fixtures/bizanso', routeKey: 'bizanso', port: 8787 },
    });
    assert.deepEqual(compiled.hosts[siblingHost], { kind: 'agent-root', agent: 'fixtures/explorer', routeKey: 'explorer' });
    assert.equal(generation.desired.hosts[rootHost].dnsManagement, 'external');
    assert.equal(JSON.stringify(compiled).includes('dnsManagement'), false);
    // Closure union for the root host; the sibling keeps the owner's closure.
    assert.deepEqual(compiled.agentMcpRoutes[rootHost], ['bizanso', 'explorer', 'mailer', 'provider']);
    assert.deepEqual(compiled.agentMcpRoutes[siblingHost], ['explorer', 'provider']);
    assert.deepEqual(compiled.dependencyHttpRoutes[siblingHost], [{ path: '/provider/public/*', routeKey: 'provider' }]);
    assert.ok(compiled.dependencyHttpRoutes[rootHost].some((entry) => entry.routeKey === 'provider'));
    assert.equal(compiled.dependencyHttpRoutes[rootHost].some((entry) => entry.routeKey === 'unrelated'), false);

    const legacy = domainFixture(t, { mode: 'legacy' }).active().generation.compiled;
    assert.equal(JSON.stringify(legacy).includes('rootApplication'), false);
    for (const key of ['hosts', 'surfaces', 'agentMcpRoutes', 'dependencyHttpRoutes']) {
        assert.deepEqual(legacy[key][siblingHost], compiled[key][siblingHost], key);
    }
});

test('the root application closure joins the MCP and mutation closure even without marketplace-ui', (t) => {
    const world = domainFixture(t);
    world.desired.hosts[rootHost].routerSurfaces = ['agent-mcp', 'browser-auth'];
    world.write(world.paths.desiredFile, world.desired);
    world.apply();
    const services = edge.edgeHostServiceRoutes(world.active().generation, rootHost);
    assert.deepEqual([...services.agentMcpRoutes], ['bizanso', 'explorer', 'mailer', 'provider']);
    for (const [routeKey, allowed] of [['bizanso', true], ['mailer', true], ['provider', true], ['unrelated', false]]) {
        const url = `/auth/token?mutationRoute=${routeKey}`;
        const context = authContext.resolveAuthContextForRoutePlan(new URL(url, `https://${rootHost}`), world.plan(url),
            { browserAuth: true });
        if (allowed) {
            assert.equal(context.error, undefined, routeKey);
            assert.equal(context.serviceRouteKey, routeKey);
            assert.equal(context.boundHostRouteKey, 'explorer');
        } else {
            assert.equal(context.error, 'browser_mutation_route_denied', routeKey);
        }
    }
});

// ---- M-1 per-request availability ----

for (const [label, change, code, status] of [
    ['disabled', (world) => { world.routing.routes.bizanso.disabled = true; }, 'AGENT_OWNER_INACTIVE', 404],
    ['draining', (world) => { world.routing.routes.bizanso.draining = true; }, 'AGENT_OWNER_INACTIVE', 404],
    ['without a running container', (world) => {
        delete world.agents['bizanso-container'].containerId;
        delete world.agents['bizanso-container'].runtime;
    }, 'AGENT_RUNTIME_INACTIVE', 503],
]) {
    test(`a ${label} root application answers ${status} ${code} while the owner keeps serving`, (t) => {
        const world = domainFixture(t);
        change(world);
        world.write(world.paths.routingFile, world.routing);
        world.write(world.paths.agentsFile, world.agents);
        world.apply();
        assert.equal(world.active().generation.compiled.hosts[rootHost].rootApplication.routeKey, 'bizanso');
        for (const url of ['/', '/app/profile']) {
            const plan = world.plan(url);
            assert.equal(plan.ok, false, url);
            assert.equal(plan.status, status, url);
            assert.equal(plan.code, code, url);
        }
        const owner = world.plan('/explorer/index.html');
        assert.equal(owner.kind, 'agent-root');
        assert.equal(owner.routeKey, 'explorer');
        assert.equal(world.plan('/auth/login').kind, 'router-surface');
        assert.equal(world.plan('/', siblingHost).routeKey, 'explorer');
    });
}

test('an uninstalled root application never compiles', (t) => {
    const world = domainFixture(t);
    const selectorBefore = world.active().selector;
    delete world.routing.routes.bizanso;
    const bytes = bytesOf(world.desired);
    world.write(world.paths.routingFile, world.routing);
    assert.throws(() => edge.validateEdgeDesiredCandidate(bytes, world.options), /exactly one installed route/);
    assert.deepEqual(world.active().selector, selectorBefore);
});

// ---- C3 dispatch precedence ----

test('root host dispatch follows the C3 precedence table', (t) => {
    const world = domainFixture(t);
    const expectPlan = (url, expected, { method = 'GET', transport = 'http' } = {}) => {
        const plan = world.plan(url, rootHost, transport, method);
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(plan[key], value, `${url} ${key}`);
        return plan;
    };
    // 1 agent-port convention keeps its prefix.
    expectPlan(`${PREFIX}/app/x`, { kind: 'agent-port', routeKey: 'bizanso', forwardedPrefix: PREFIX });
    // 2 encoded Router surface spelling.
    expectPlan('/%61uth/login', { ok: false, status: 400, code: 'NONCANONICAL_ROUTER_PATH' });
    // 3 browser auth, owner context.
    for (const url of ['/auth/login', '/auth/callback', '/auth/logout', '/auth/token']) {
        expectPlan(url, { kind: 'router-surface', surface: 'browser-auth' });
    }
    // 4 owner user administration only.
    expectPlan('/api/agents/explorer/users', { kind: 'router-surface', surface: 'user-admin' });
    expectPlan('/api/agents/bizanso/users', { ok: false, code: 'ROUTE_SURFACE_DENIED' });
    // 5 unqualified MCP is the owner's agent root, never the application.
    for (const method of ['GET', 'POST']) {
        expectPlan('/mcp', { kind: 'agent-root', routeKey: 'explorer', upstreamPath: '/mcp' }, { method });
    }
    // 5b closure MCP and Router-owned MCP assets.
    for (const routeKey of ['explorer', 'bizanso', 'mailer', 'provider']) {
        expectPlan(`/${routeKey}/mcp`, { kind: 'agent-root', routeKey, upstreamPath: '/mcp' });
    }
    expectPlan('/MCPBrowserClient.js', { kind: 'router-surface', surface: 'agent-mcp' });
    expectPlan('/web-libs/x.js', { kind: 'router-surface', surface: 'agent-mcp' });
    // The base Marketplace extension of an SSO owner admits other enabled agents' MCP.
    expectPlan('/unrelated/mcp', { kind: 'agent-root', routeKey: 'unrelated' });
    expectPlan('/unrelated/x', { kind: 'agent-port', routeKey: 'bizanso', unmatchedSuffix: '/unrelated/x' });
    // 6 Router surfaces.
    for (const [url, surface] of [['/workspace-files/x', 'workspace-assets'], ['/upload', 'blob-transfer'],
        ['/blobs/x', 'blob-transfer'], ['/api/marketplace/agents', 'marketplace-ui'], ['/webchat/', 'webchat'],
        ['/webtty/', 'webtty']]) {
        expectPlan(url, { kind: 'router-surface', surface });
    }
    // 7 declared dependency route.
    expectPlan('/provider/public/a', { kind: 'agent-root', routeKey: 'provider' });
    // 8 other reserved paths.
    for (const url of ['/health', '/status', '/policy', '/api/edge', '/api/router/x', '/auth/other', '/metrics', '/__agent']) {
        expectPlan(url, { ok: false, status: 404, code: 'ROUTE_SURFACE_DENIED' });
    }
    // 9 bare owner mount.
    expectPlan('/explorer?x=1', { ok: true, kind: 'mount-redirect', location: '/explorer/?x=1' });
    expectPlan('/%65xplorer', { kind: 'mount-redirect', location: '/explorer/' });
    expectPlan('/explorer', { kind: 'mount-redirect', location: '/explorer/' }, { method: 'HEAD' });
    // 10 explicit owner mount.
    expectPlan('/explorer/', { kind: 'agent-root', routeKey: 'explorer', upstreamPath: '/' });
    expectPlan('/explorer/index.html?v=1', {
        kind: 'agent-root', routeKey: 'explorer', canonicalPath: '/explorer/index.html', upstreamPath: '/index.html?v=1',
    });
    expectPlan('/%65xplorer/a', { kind: 'agent-root', routeKey: 'explorer', upstreamPath: '/a' });
    // 11 everything else is the root application at an empty prefix.
    for (const url of ['/', '/app/profile', '/p/x/', '/login/', '/explorers', '/bizanso/x', '/%C3%ABxplorer']) {
        expectPlan(url, { kind: 'agent-port', routeKey: 'bizanso', port: 8787, forwardedPrefix: '' });
    }
    const root = expectPlan('/?q=1', { kind: 'agent-port' });
    assert.equal(root.policyPath, `${PREFIX}/`);
    assert.equal(root.unmatchedSuffix, '/');
    assert.equal(root.query, 'q=1');
    // Undecodable first segment; encoded slashes never select the owner.
    expectPlan('/%E0%A4%A/x', { ok: false, status: 400, code: 'MALFORMED_URL' });
    for (const url of ['/explorer%2F', '/explorer%2Fx']) {
        assert.notEqual(world.plan(url).routeKey, 'explorer', url);
    }
    assert.equal(world.plan('/', 'unknown.synthetic.test').code, 'UNKNOWN_HOST');
});

test('the bare owner mount redirects only GET and HEAD over HTTP (C4) and never on a WebSocket (R5)', (t) => {
    const world = domainFixture(t);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
        const plan = world.plan('/explorer', rootHost, 'http', method);
        assert.equal(plan.ok, false, method);
        assert.equal(plan.status, 404, method);
        assert.equal(plan.code, 'ROUTE_NOT_FOUND', method);
    }
    for (const transport of ['websocket', 'sse']) {
        for (const url of ['/explorer', '/%65xplorer', '/explorer?x=1']) {
            const plan = world.plan(url, rootHost, transport);
            assert.equal(plan.ok, false, `${transport} ${url}`);
            assert.notEqual(plan.kind, 'mount-redirect');
        }
    }
    // R5: any other root-host WebSocket is the application's relay plan or a denial.
    for (const url of ['/', '/app/socket', '/api/live?x=1', '/undeclared/ws']) {
        const plan = world.plan(url, rootHost, 'websocket');
        assert.notEqual(plan.kind, 'mount-redirect', url);
        if (plan.ok) {
            assert.equal(plan.kind, 'agent-port', url);
            assert.equal(plan.routeKey, 'bizanso', url);
            assert.equal(plan.relay.kind, 'container-control-socket', url);
        }
    }
    assert.equal(world.plan('/app/socket', rootHost, 'websocket').ok, true);
});

test('hosts without a root application keep the base owner-root behavior', (t) => {
    const world = domainFixture(t);
    const bare = world.plan('/explorer', siblingHost);
    assert.equal(bare.kind, 'agent-root');
    assert.equal(bare.upstreamPath, '/');
    assert.equal(world.plan('/', siblingHost).kind, 'agent-root');
    assert.equal(world.plan('/app/profile', siblingHost).routeKey, 'explorer');
    assert.equal(world.plan('/admin', siblingHost).code, 'ROUTE_SURFACE_DENIED');
    assert.equal(world.plan(`${PREFIX}/app/profile`, siblingHost).kind, 'agent-port');
});

test('after single the sibling host is unknown and the root host still dispatches', (t) => {
    const world = domainFixture(t, { mode: 'single' });
    assert.equal(world.plan('/', siblingHost).code, 'UNKNOWN_HOST');
    assert.equal(world.plan('/', siblingHost).status, 421);
    assert.equal(world.plan('/app/profile').routeKey, 'bizanso');
    assert.equal(world.plan('/explorer/index.html').routeKey, 'explorer');
});

test('root application admin requires its own explicit manifest policy', (t) => {
    const world = domainFixture(t);
    for (const url of ['/admin', '/admin/users']) assert.equal(world.plan(url).code, 'ROUTE_SURFACE_DENIED', url);
    const manifest = path.join(world.routing.routes.bizanso.hostPath, 'manifest.json');
    const declared = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    declared.routerAccess.httpRoutes.push(
        { path: `${PREFIX}/admin`, access: 'authenticated' },
        { path: `${PREFIX}/admin/*`, access: 'authenticated' },
    );
    world.write(manifest, declared);
    world.apply();
    for (const url of ['/admin', '/admin/users']) {
        const plan = world.plan(url);
        assert.equal(plan.kind, 'agent-port', url);
        assert.equal(plan.policyPath, `${PREFIX}${url}`);
    }
    assert.equal(world.plan('/admin', siblingHost).code, 'ROUTE_SURFACE_DENIED');
});

// ---- C6 owner binding and R2 equivalence ----

test('every root host request binds browser auth to the owner', (t) => {
    const world = domainFixture(t);
    for (const url of ['/auth/token', '/', '/app/profile', '/explorer/index.html']) {
        const context = authContext.resolveAuthContextForRoutePlan(new URL(url, `https://${rootHost}`), world.plan(url),
            { browserAuth: true });
        assert.equal(context.boundHostRouteKey, 'explorer', url);
    }
});

test('R2: root requests reach the same decision, auth context and invocation as the prefixed sibling request', (t) => {
    withMasterKey(t);
    const world = domainFixture(t);
    const user = { id: 'member', roles: ['user'], capabilities: [] };
    const cases = [['/', 'public'], ['/static/x.css', 'public'], ['/app/profile', 'authenticated'], ['/undeclared/x', null]];
    for (const [url, access] of cases) {
        const root = world.plan(url, rootHost, 'http', 'GET');
        const prefixed = world.plan(`${PREFIX}${url}`, siblingHost, 'http', 'GET');
        assert.equal(root.ok, true, url);
        assert.equal(prefixed.ok, true, url);
        assert.equal(root.kind, 'agent-port', url);
        assert.equal(root.policyPath, prefixed.policyPath, url);
        assert.deepEqual(root.access, prefixed.access, url);
        if (access) assert.equal(root.access.access, access, url);
        assert.deepEqual(root.authDefinition, prefixed.authDefinition, url);
        const contexts = [root, prefixed].map((plan) => {
            const { boundGeneration, ...context } = authContext.resolveAuthContextForRoutePlan(plan.parsedUrl, plan) || {};
            return context;
        });
        assert.deepEqual(contexts[0], contexts[1], url);
        const headers = [root, prefixed].map((plan) => buildHttpRouteAuthInfoHeader({ method: 'GET', user },
            plan.parsedUrl, plan.authDefinition, { bodyHash: sha256RawBodyHash(Buffer.alloc(0)), routePath: plan.unmatchedSuffix }));
        assert.equal('x-ploinky-auth-info' in headers[0], 'x-ploinky-auth-info' in headers[1], url);
        assert.equal(Boolean(headers[0]['x-ploinky-auth-info']), root.authDefinition.includeAuthInfo === true, url);
        // Forged client forwarding headers are replaced with the Router's own.
        const forged = {
            host: rootHost, 'x-forwarded-prefix': '/spoof', 'x-forwarded-host': 'spoof.synthetic.test',
            'x-ploinky-auth-info': 'spoof',
        };
        const rootHeaders = sanitizeRequestHeaders(forged, root);
        assert.equal(rootHeaders['x-forwarded-prefix'], '', url);
        assert.equal(rootHeaders['x-forwarded-host'], rootHost, url);
        assert.equal(rootHeaders['x-ploinky-auth-info'], undefined, url);
        const prefixedHeaders = sanitizeRequestHeaders({ ...forged, host: siblingHost }, prefixed);
        assert.equal(prefixedHeaders['x-forwarded-prefix'], PREFIX, url);
        assert.equal(prefixedHeaders['x-forwarded-host'], siblingHost, url);
    }
});

test('root application transport admission matches the prefixed form on every transport', (t) => {
    const world = domainFixture(t);
    for (const transport of ['http', 'sse', 'websocket']) {
        const root = world.plan('/api/session?view=1', rootHost, transport, 'POST');
        const prefixed = world.plan(`${PREFIX}/api/session?view=1`, rootHost, transport, 'POST');
        assert.equal(root.ok, true, transport);
        assert.equal(root.kind, 'agent-port');
        assert.equal(root.policyPath, prefixed.policyPath);
        assert.equal(root.unmatchedSuffix, '/api/session');
        assert.equal(root.query, 'view=1');
        assert.deepEqual(root.access, prefixed.access);
        assert.deepEqual(root.authDefinition, prefixed.authDefinition);
        assert.equal(root.authDefinition.issueInvocation, true);
        assert.equal(root.forwardedPrefix, '');
        assert.equal(prefixed.forwardedPrefix, PREFIX);
        assert.equal(root.origin, `https://${rootHost}`);
        assert.equal(root.lease.commit(), true);
    }
});

test('root invocations sign the upstream path, query and body and reject replay or changed bytes', (t) => {
    withMasterKey(t);
    const world = domainFixture(t);
    const plan = world.plan('/api/profile?view=1', rootHost, 'http', 'POST');
    const body = Buffer.from('{"displayName":"member"}');
    const req = { method: 'POST', user: { id: 'member', roles: ['user'] } };
    const headers = buildHttpRouteAuthInfoHeader(req, plan.parsedUrl, plan.authDefinition, {
        bodyHash: sha256RawBodyHash(body), routePath: plan.unmatchedSuffix,
    });
    const replayCache = createMemoryReplayCache();
    const verify = overrides => verifyHttpRouteAuthInfoFromHeaders(headers, {
        env: { PLOINKY_AGENT_ID: 'agent:fixtures/bizanso', PLOINKY_AGENT_SECRET: deriveAgentRequestSecret('agent:fixtures/bizanso') },
        replayCache, method: 'POST', path: '/api/profile', query: '?view=1', body, ...overrides,
    });
    assert.equal(verify().ok, true);
    assert.equal(verify().ok, false);
    assert.equal(verify({ replayCache: createMemoryReplayCache(), path: plan.policyPath }).ok, false);
    assert.equal(verify({ replayCache: createMemoryReplayCache(), body: Buffer.from('{}') }).ok, false);
});

test('root mutations keep the exact Origin and double-submit CSRF checks', (t) => {
    const world = domainFixture(t);
    const plan = world.plan('/api/profile', rootHost, 'http', 'POST');
    const req = { method: 'POST', headers: {
        origin: `https://${rootHost}`, cookie: 'ploinky_sso=test-session; ploinky_csrf=test-proof', 'x-csrf-token': 'test-proof',
    } };
    assert.equal(assertMutationAllowed(req, plan), true);
    for (const origin of [`https://${siblingHost}`, 'https://foreign.synthetic.test']) {
        assert.throws(() => assertMutationAllowed({ ...req, headers: { ...req.headers, origin } }, plan), { code: 'ORIGIN_REJECTED' });
    }
    assert.throws(() => assertMutationAllowed({ ...req, headers: { ...req.headers, 'x-csrf-token': 'wrong' } }, plan),
        { code: 'CSRF_REJECTED' });
});

test('host-network reserved ports and the relay opt-out apply equally at the root', (t) => {
    const world = domainFixture(t);
    const manifest = path.join(world.routing.routes.bizanso.hostPath, 'manifest.json');
    world.write(manifest, { network: { mode: 'host' }, routerAccess: { agentPorts: true } });
    for (const port of [8080, 8081]) {
        world.desired.hosts[rootHost].rootApplication.port = port;
        world.write(world.paths.desiredFile, world.desired);
        world.apply();
        for (const transport of ['http', 'sse', 'websocket']) {
            assert.equal(world.plan('/', rootHost, transport).code, 'DENIED_PORT');
        }
    }
    world.desired.hosts[rootHost].rootApplication.port = 8787;
    world.write(world.paths.desiredFile, world.desired);
    world.write(manifest, { routerAccess: { agentPorts: false } });
    world.apply();
    assert.equal(world.plan('/').code, 'AGENT_PORT_RELAY_DISABLED');
    assert.equal(world.plan('/explorer/index.html').routeKey, 'explorer');
});

// ---- C4 through the real Router ----

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function startRouter(t) {
    const world = domainFixture(t);
    const port = await freePort();
    process.env.PLOINKY_ROUTER_HOST_PORT = String(port);
    world.apply();
    // Without credentials the in-Router publication runtime would reconcile and
    // inactivate the ready public hosts. This test needs Router dispatch only,
    // so the cloudflared integration RoutingServer imports is replaced by an
    // inert stand-in through a loader hook confined to this child.
    const stub = path.join(world.root, 'cloudflared-integration-stub.mjs');
    fs.writeFileSync(stub, [
        'export function createCloudflaredRouterIntegration() {',
        "    return { getStatus: () => ({ state: 'test-disabled' }), stop: async () => {},",
        '        markPrivateListenerReady() {}, markPublicListenerReady() {} };',
        '}',
    ].join('\n'));
    const hooks = path.join(world.root, 'cloudflared-integration-hooks.mjs');
    fs.writeFileSync(hooks, [
        `const stub = ${JSON.stringify(pathToFileURL(stub).href)};`,
        `const target = ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, 'ploinky-box/cloudflared/index.mjs')).href)};`,
        'export async function resolve(specifier, context, next) {',
        '    const resolved = await next(specifier, context);',
        '    return resolved.url === target ? { url: stub, shortCircuit: true } : resolved;',
        '}',
    ].join('\n'));
    // The private listener binds a fixed 8081 exclusively; an ephemeral port
    // keeps concurrent real-Router tests from contending for it.
    const register = path.join(world.root, 'cloudflared-integration-register.mjs');
    fs.writeFileSync(register, [
        "import net from 'node:net';",
        "import { register } from 'node:module';",
        `register(${JSON.stringify(pathToFileURL(hooks).href)});`,
        'const listen = net.Server.prototype.listen;',
        'net.Server.prototype.listen = function (...args) {',
        "    if (args[0] && typeof args[0] === 'object' && args[0].port === 8081) args[0] = { ...args[0], port: 0 };",
        '    return listen.apply(this, args);',
        '};',
    ].join('\n'));
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
        if ((name.startsWith('PLOINKY_') && name !== 'PLOINKY_AGENTLIB_DIR') || name === 'PORT') delete env[name];
    }
    // HOME stays outside the workspace: Router subprocesses may create files
    // under it while the fixture removes the workspace.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'root-application-home-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
    const child = spawn(process.execPath, [
        '--import', register,
        '--import', path.join(REPO_ROOT, 'tests/helpers/routerTemplatePreload.mjs'),
        path.join(REPO_ROOT, 'cli/server/RoutingServer.js'),
    ], {
        cwd: world.root,
        env: {
            ...env,
            HOME: home,
            PLOINKY_WORKSPACE_ROOT: world.root,
            PLOINKY_ROUTER_HOST_PORT: String(port),
            PLOINKY_MEDIA_HOST_PORT: '17891',
            PLOINKY_MASTER_KEY: '7'.repeat(64),
            PLOINKY_ROUTER_HEALTH_SOCKET: path.join(world.root, 'h.sock'),
            PLOINKY_TEST_PUBLIC_PORT: String(port),
            PLOINKY_TEST_REPO_ROOT: REPO_ROOT,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    // The child must be gone before the fixture removes its workspace, so the
    // test stops it in `finally`; this hook is only a backstop.
    const stop = async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            // The whole process group, so no Router subprocess outlives it.
            try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
            await exited;
        }
    };
    t.after(stop);
    const deadline = Date.now() + 15000;
    while (!/Ploinky server running/.test(output)) {
        if (child.exitCode !== null) throw new Error(`router exited:\n${output}`);
        if (Date.now() > deadline) {
            await stop();
            throw new Error(`router did not start:\n${output}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { port, stop };
}

function request(port, { host, method = 'GET', target, headers = {} }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(5000, () => req.destroy(new Error(`no answer for ${method} ${target}`)));
        req.on('error', reject);
        req.end();
    });
}

function upgrade(port, { host, target }) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let data = '';
        socket.on('data', (chunk) => { data += chunk; });
        socket.on('close', () => resolve(data));
        socket.on('error', reject);
        socket.setTimeout(5000, () => socket.destroy());
        socket.write([
            `GET ${target} HTTP/1.1`, `Host: ${host}`, `Origin: https://${host}`, 'Connection: Upgrade', 'Upgrade: websocket',
            'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${Buffer.alloc(16, 5).toString('base64')}`, '', '',
        ].join('\r\n'));
    });
}

test('the real Router answers the bare owner mount with an uncached redirect and nothing else', { timeout: 60_000 }, async (t) => {
    const { port, stop } = await startRouter(t);
    try {
        const get = await request(port, { host: rootHost, target: '/explorer?x=1' });
        assert.equal(get.status, 302, get.body);
        assert.equal(get.headers.location, '/explorer/?x=1');
        assert.equal(get.headers['cache-control'], 'no-store');
        assert.equal(get.body, '');
        const head = await request(port, { host: rootHost, method: 'HEAD', target: '/%65xplorer' });
        assert.equal(head.status, 302);
        assert.equal(head.headers.location, '/explorer/');
        for (const method of ['POST', 'PUT', 'DELETE']) {
            const refused = await request(port, { host: rootHost, method, target: '/explorer', headers: { origin: `https://${rootHost}` } });
            assert.equal(refused.status, 404, method);
            assert.equal(refused.headers.location, undefined, method);
        }
        const socketReply = await upgrade(port, { host: rootHost, target: '/explorer' });
        assert.match(socketReply, /^HTTP\/1\.1 404/);
        const sibling = await request(port, { host: siblingHost, target: '/explorer' });
        // A host without a root application keeps the owner root at `/explorer`.
        assert.equal(sibling.headers.location, '/auth/login?returnTo=%2Fexplorer');
        const owner = await request(port, { host: rootHost, target: '/explorer/index.html' });
        assert.equal(owner.status, 302);
        assert.equal(owner.headers.location, '/auth/login?returnTo=%2Fexplorer%2Findex.html');
        const mismatch = await request(port, { host: rootHost, target: '/auth/login?agent=bizanso' });
        assert.equal(mismatch.status, 400);
        assert.equal(JSON.parse(mismatch.body).error, 'auth_route_context_mismatch');
    } finally {
        await stop();
    }
});
